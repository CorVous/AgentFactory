#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { generateInstanceName, probeBusRoot } from "./agent-naming.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_ROOT = path.join(REPO_ROOT, "pi-sandbox");
const AGENTS_DIR = path.join(SANDBOX_ROOT, "agents");
const EXTENSIONS_DIR = path.join(SANDBOX_ROOT, ".pi", "extensions");
const SKILLS_DIR = path.join(SANDBOX_ROOT, "skills");
const PI_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "pi");

const BASELINE_EXTENSIONS = [
  // Must be first — materialises the Habitat before any rail reads it.
  "habitat",
  "deferred/sandbox",
  "no-startup-help",
  "agent-header",
  "agent-footer",
  "hide-extensions-list",
  "deferred/deferred-confirm",
  // Bus binding is a baseline now: atomic-delegate, supervisor rail,
  // and the deferred-* submission flow all need a bound bus socket.
  // The agent_send / agent_inbox / agent_list / agent_call tools stay
  // gated by the recipe's `tools:` allowlist, so loading the extension
  // by default does not change the tool surface seen by the model.
  "agent-bus",
];
const TIER_VARS = new Set(["RABBIT_SAGE_MODEL", "LEAD_HARE_MODEL", "TASK_RABBIT_MODEL"]);

function die(msg) {
  process.stderr.write(`run-agent: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { name: null, sandbox: null, agentBus: null, passthrough: [] };
  let passthroughOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (passthroughOnly) {
      out.passthrough.push(a);
      continue;
    }
    if (a === "--") {
      passthroughOnly = true;
    } else if (a === "--sandbox") {
      out.sandbox = argv[++i] ?? die("--sandbox requires a directory");
    } else if (a === "--agent-bus") {
      out.agentBus = argv[++i] ?? die("--agent-bus requires a directory");
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (out.name === null) {
      out.name = a;
    } else {
      out.passthrough.push(a);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    `Usage: npm run agent -- <name> [--sandbox <dir>] [pi flags...]\n\n` +
      `Loads pi-sandbox/agents/<name>.yaml and launches pi with the recipe's\n` +
      `system prompt, tool allowlist, extensions, and skills. The sandbox\n` +
      `extension restricts all fs activity to <dir> (default: cwd where you\n` +
      `invoked npm run agent) and disables bash entirely.\n\n` +
      `Run without a name to list available agents.\n`,
  );
}

function collectAgentNames(dir, prefix) {
  const names = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      names.push(...collectAgentNames(path.join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name));
    } else if (e.name.endsWith(".yaml")) {
      const stem = e.name.slice(0, -".yaml".length);
      names.push(prefix ? `${prefix}/${stem}` : stem);
    }
  }
  return names;
}

function listAgents() {
  const names = collectAgentNames(AGENTS_DIR, "").sort();
  const rel = path.relative(REPO_ROOT, AGENTS_DIR) || AGENTS_DIR;
  if (names.length === 0) {
    process.stdout.write(`No agents found in ${rel}\n`);
    return;
  }
  process.stdout.write(`Available agents (${rel}):\n`);
  for (const n of names) process.stdout.write(`  ${n}\n`);
  process.stdout.write(`\nRun: npm run agent -- <name>\n`);
}

function loadRecipe(name) {
  const file = path.join(AGENTS_DIR, `${name}.yaml`);
  if (!existsSync(file)) die(`recipe not found: ${file}`);
  let recipe;
  try {
    recipe = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    die(`failed to parse ${file}: ${e.message}`);
  }
  if (!recipe || typeof recipe !== "object") die(`recipe ${file} is empty or not an object`);
  if (typeof recipe.prompt !== "string" || !recipe.prompt.trim()) die(`recipe ${file} missing 'prompt'`);
  if (!Array.isArray(recipe.tools)) die(`recipe ${file} missing 'tools' (list)`);
  if (recipe.shortName !== undefined) {
    if (typeof recipe.shortName !== "string" || !/^[a-z][a-z0-9-]*$/.test(recipe.shortName)) {
      die(`recipe ${file} 'shortName' must be a lowercase slug ([a-z][a-z0-9-]*)`);
    }
  }
  return recipe;
}

// Implicit-wire the atomic-delegate extension and its tool when a recipe
// declares `agents: [...]`.
//
// Inverse rejection: if a recipe loads atomic-delegate or its tool without
// declaring `agents:`, that's a misconfiguration — fail loudly so the
// allowlist is never accidentally empty.
function applyAgentsField(recipe, name) {
  const declared = Array.isArray(recipe.agents) ? recipe.agents.filter((a) => typeof a === "string") : [];
  const explicitExts = Array.isArray(recipe.extensions) ? recipe.extensions.slice() : [];
  const explicitTools = Array.isArray(recipe.tools) ? recipe.tools.slice() : [];
  const DELEGATE_TOOLS = ["delegate"];

  if (declared.length === 0) {
    if (explicitExts.includes("deferred/atomic-delegate")) {
      die(
        `recipe ${name} loads extension 'deferred/atomic-delegate' but has no 'agents:' list — ` +
          `declare which child recipes are allowed (or drop the extension)`,
      );
    }
    for (const t of DELEGATE_TOOLS) {
      if (explicitTools.includes(t)) {
        die(
          `recipe ${name} declares tool '${t}' but has no 'agents:' list — ` +
            `declare which child recipes are allowed (or drop the tool)`,
        );
      }
    }
    return { allowed: [], extensions: explicitExts, tools: explicitTools };
  }

  for (const a of declared) {
    if (!existsSync(path.join(AGENTS_DIR, `${a}.yaml`))) {
      die(`recipe ${name} agents: lists '${a}', but pi-sandbox/agents/${a}.yaml does not exist`);
    }
  }

  const extensions = explicitExts.includes("deferred/atomic-delegate")
    ? explicitExts
    : [...explicitExts, "deferred/atomic-delegate"];
  const tools = explicitTools.slice();
  for (const t of DELEGATE_TOOLS) if (!tools.includes(t)) tools.push(t);
  return { allowed: declared, extensions, tools };
}

// Implicit-wire the supervisor extension and respond_to_request tool when a
// recipe sets any of the supervisor-related peer fields (acceptedFrom,
// supervisor, submitTo).
//
// Inverse rejection: if a recipe explicitly lists 'supervisor' in extensions
// or 'respond_to_request' in tools without setting any supervisory field,
// that's a misconfiguration — fail loudly.
function applySupervisorField(recipe, name, extensions, tools) {
  const supervisoryFields =
    (Array.isArray(recipe.acceptedFrom) && recipe.acceptedFrom.length > 0) ||
    (typeof recipe.supervisor === "string" && recipe.supervisor) ||
    (typeof recipe.submitTo === "string" && recipe.submitTo);

  const explicitExt = extensions.includes("supervisor");
  const explicitTool = tools.includes("respond_to_request");

  if (!supervisoryFields) {
    if (explicitExt) {
      die(
        `recipe ${name} loads extension 'supervisor' but has no 'acceptedFrom', 'supervisor', or 'submitTo' — ` +
          `set at least one supervisory field (or drop the extension)`,
      );
    }
    if (explicitTool) {
      die(
        `recipe ${name} declares tool 'respond_to_request' but has no supervisory fields — ` +
          `set 'acceptedFrom', 'supervisor', or 'submitTo' (or drop the tool)`,
      );
    }
    return { extensions, tools };
  }

  const newExtensions = explicitExt ? extensions : [...extensions, "supervisor"];
  const newTools = explicitTool ? tools : [...tools, "respond_to_request"];
  return { extensions: newExtensions, tools: newTools };
}

function resolveModel(tierOrId) {
  const requested = tierOrId || "TASK_RABBIT_MODEL";
  if (TIER_VARS.has(requested)) {
    const v = process.env[requested];
    if (!v) die(`tier ${requested} is not set; source models.env first`);
    return v;
  }
  return requested;
}

function resolveExtensionPaths(names) {
  const seen = new Set();
  const merged = [...BASELINE_EXTENSIONS, ...names];
  return merged
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .map((n) => {
      const p = path.join(EXTENSIONS_DIR, `${n}.ts`);
      if (!existsSync(p)) die(`extension not found: ${p}`);
      return p;
    });
}

function resolveSkillPaths(names) {
  return names.map((n) => {
    const direct = path.isAbsolute(n) ? n : path.join(SKILLS_DIR, n);
    if (!existsSync(direct)) die(`skill not found: ${direct}`);
    return direct;
  });
}

// Each loaded extension may ship a sibling `<name>.prompt.md` in
// EXTENSIONS_DIR that documents its tools. The runner concatenates those
// fragments ahead of the recipe's own `prompt:` so each YAML only needs
// to describe the agent's role, not the standard tool rules.
//
// Conditional rule: `deferred-confirm` is a baseline extension and
// always loaded, but its fragment (apply order, atomic batch semantics)
// is only relevant when at least one `deferred-*` tool extension is
// loaded.
function loadPromptFragments(extensionNames) {
  // A "deferred tool" is any deferred-* extension except deferred-confirm itself.
  // Names may now be subdirectory-qualified (e.g. "deferred/deferred-write").
  const hasDeferredTool = extensionNames.some((n) => {
    const base = n.includes("/") ? n.split("/").pop() : n;
    return base.startsWith("deferred-") && base !== "deferred-confirm";
  });
  const fragments = [];
  for (const name of extensionNames) {
    const base = name.includes("/") ? name.split("/").pop() : name;
    if (base === "deferred-confirm" && !hasDeferredTool) continue;
    const p = path.join(EXTENSIONS_DIR, `${name}.prompt.md`);
    if (existsSync(p)) fragments.push(readFileSync(p, "utf8").trim());
  }
  return fragments;
}

const args = parseArgs(process.argv.slice(2));
if (!args.name) {
  listAgents();
  process.exit(0);
}
const recipe = loadRecipe(args.name);

const sandboxRoot = path.resolve(args.sandbox || process.env.INIT_CWD || process.cwd());
if (!existsSync(sandboxRoot)) die(`sandbox dir does not exist: ${sandboxRoot}`);

const recipeModel = recipe.model || "TASK_RABBIT_MODEL";
const model = resolveModel(recipeModel);
const wiredAgents = applyAgentsField(recipe, args.name);
const wiredSupervisor = applySupervisorField(recipe, args.name, wiredAgents.extensions, wiredAgents.tools);
const wired = { ...wiredAgents, extensions: wiredSupervisor.extensions, tools: wiredSupervisor.tools };
const extensionPaths = resolveExtensionPaths(wired.extensions);
const skillPaths = resolveSkillPaths(Array.isArray(recipe.skills) ? recipe.skills : []);

// Build the effective system prompt: tool/extension fragments first
// (in load order), then the recipe's own role-specific prompt.
const mergedExtensions = [
  ...BASELINE_EXTENSIONS,
  ...wired.extensions.filter((n) => !BASELINE_EXTENSIONS.includes(n)),
];
const promptFragments = loadPromptFragments(mergedExtensions);
const systemPrompt = [...promptFragments, recipe.prompt.trim()].join("\n\n");

const piArgs = [
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
  "--provider",
  recipe.provider || "openrouter",
  "--model",
  model,
  "--tools",
  wired.tools.join(","),
  "--system-prompt",
  systemPrompt,
];
for (const p of extensionPaths) piArgs.push("-e", p);
for (const p of skillPaths) piArgs.push("--skill", p);

// --agent-name passthrough is parsed only to capture the value into the
// Habitat spec; pi receives it solely via --habitat-spec.
// --topology-overlay is set by launch-mesh and atomic-delegate; it carries
// the resolved peer fields and is merged into habitatSpec below.
let agentName = null;                                     // null → generate
let topologyOverlayJson = "";
const passthrough = [];
for (let i = 0; i < args.passthrough.length; i++) {
  if (args.passthrough[i] === "--agent-name" && i + 1 < args.passthrough.length) {
    agentName = args.passthrough[++i];                    // manual override wins
  } else if (args.passthrough[i] === "--topology-overlay" && i + 1 < args.passthrough.length) {
    topologyOverlayJson = args.passthrough[++i];
    // do not push --topology-overlay into passthrough; pi doesn't know this flag
  } else {
    passthrough.push(args.passthrough[i]);
  }
}
args.passthrough = passthrough;

const busRoot =
  args.agentBus ||
  process.env.PI_AGENT_BUS_ROOT ||
  path.join(os.homedir(), ".pi-agent-bus", path.basename(sandboxRoot));

// If no manual --agent-name was provided in passthrough, generate one
// of the form `<breed>-<shortName>`. The bus-root scan catches live
// peers from other terminals so two `peer-chatter` runs never collide
// on the bus socket. atomic-delegate does its own pre-generation for
// delegated workers (it knows the full sibling set), so this branch
// usually only runs for user-launched roots.
if (agentName === null) {
  const shortName =
    (typeof recipe.shortName === "string" && recipe.shortName) || args.name;
  const tier = TIER_VARS.has(recipeModel) ? recipeModel : undefined;
  const taken = await probeBusRoot(busRoot);
  agentName = generateInstanceName({ tier, shortName, taken });
}

const recipeSkills = Array.isArray(recipe.skills) ? recipe.skills.filter((s) => typeof s === "string") : [];

// Phase 3b: peer relationship fields — validate types and extract values.
if (recipe.supervisor !== undefined && typeof recipe.supervisor !== "string") {
  die(`recipe ${args.name} 'supervisor' must be a string`);
}
if (recipe.submitTo !== undefined && typeof recipe.submitTo !== "string") {
  die(`recipe ${args.name} 'submitTo' must be a string`);
}
if (recipe.acceptedFrom !== undefined && !Array.isArray(recipe.acceptedFrom)) {
  die(`recipe ${args.name} 'acceptedFrom' must be an array of strings`);
}
if (recipe.peers !== undefined && !Array.isArray(recipe.peers)) {
  die(`recipe ${args.name} 'peers' must be an array of strings`);
}
const recipeAcceptedFrom = Array.isArray(recipe.acceptedFrom)
  ? recipe.acceptedFrom.filter((s) => typeof s === "string")
  : [];
const recipePeers = Array.isArray(recipe.peers)
  ? recipe.peers.filter((s) => typeof s === "string")
  : [];

// Serialise the resolved Habitat into one --habitat-spec flag instead of
// many individual flags + env-var mirrors. The habitat.ts baseline
// extension materialises this at session_start; all other rails read
// their axis from getHabitat() rather than re-parsing flags/env.
const habitatSpec = {
  agentName,
  scratchRoot: sandboxRoot,
  busRoot,
  skills: recipeSkills,
  agents: wired.allowed,
  noEditAdd: Array.isArray(recipe.noEditAdd) ? recipe.noEditAdd.filter((s) => typeof s === "string") : [],
  noEditSkip: Array.isArray(recipe.noEditSkip) ? recipe.noEditSkip.filter((s) => typeof s === "string") : [],
  ...(typeof recipe.description === "string" && recipe.description.trim()
    ? { description: recipe.description.trim() }
    : {}),
  ...(TIER_VARS.has(recipeModel) ? { tier: recipeModel } : {}),
  type: args.name,
  ...(typeof recipe.supervisor === "string" && recipe.supervisor ? { supervisor: recipe.supervisor } : {}),
  ...(typeof recipe.submitTo === "string" && recipe.submitTo ? { submitTo: recipe.submitTo } : {}),
  ...(recipeAcceptedFrom.length > 0 ? { acceptedFrom: recipeAcceptedFrom } : {}),
  ...(recipePeers.length > 0 ? { peers: recipePeers } : {}),
};
// Apply topology overlay — fields from the topology YAML or atomic-delegate
// take precedence over recipe-derived values. Fields absent in the overlay
// leave the recipe value intact (so existing topologies without peer
// fields continue to launch unchanged).
//
// `agents` is also overridable so atomic-delegate can lock a spawned
// worker to agents:[] regardless of what the recipe declares.
if (topologyOverlayJson) {
  let overlay;
  try { overlay = JSON.parse(topologyOverlayJson); } catch (e) {
    die(`--topology-overlay: invalid JSON: ${e.message}`);
  }
  if (typeof overlay.supervisor === "string") habitatSpec.supervisor = overlay.supervisor;
  if (typeof overlay.submitTo === "string") habitatSpec.submitTo = overlay.submitTo;
  if (Array.isArray(overlay.acceptedFrom) && overlay.acceptedFrom.length > 0) {
    habitatSpec.acceptedFrom = overlay.acceptedFrom;
  }
  if (Array.isArray(overlay.peers) && overlay.peers.length > 0) {
    habitatSpec.peers = overlay.peers;
  }
  if (Array.isArray(overlay.agents)) {
    habitatSpec.agents = overlay.agents.filter((s) => typeof s === "string");
  }
}

piArgs.push("--habitat-spec", JSON.stringify(habitatSpec));
piArgs.push(...args.passthrough);

if (!existsSync(PI_BIN)) die(`pi binary missing: ${PI_BIN} (run npm install)`);

const child = spawn(PI_BIN, piArgs, {
  cwd: sandboxRoot,
  stdio: "inherit",
  env: { ...process.env },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
