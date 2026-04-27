#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_ROOT = path.join(REPO_ROOT, "pi-sandbox");
const AGENTS_DIR = path.join(SANDBOX_ROOT, "agents");
const EXTENSIONS_DIR = path.join(SANDBOX_ROOT, ".pi", "extensions");
const SKILLS_DIR = path.join(SANDBOX_ROOT, "skills");
const PI_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "pi");

const BASELINE_EXTENSIONS = [
  "sandbox",
  "no-startup-help",
  "agent-header",
  "agent-footer",
  "hide-extensions-list",
  "deferred-confirm",
  // Reports {context %, cost, state} over --rpc-sock when run as a
  // delegated child. Self-gates on the flag, so it no-ops for
  // top-level runs.
  "agent-status-reporter",
];
const TIER_VARS = new Set(["RABBIT_SAGE_MODEL", "HARE_LEAD_MODEL", "RABBIT_TASK_MODEL"]);

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

function listAgents() {
  let entries;
  try {
    entries = readdirSync(AGENTS_DIR);
  } catch (e) {
    die(`failed to read ${AGENTS_DIR}: ${e.message}`);
  }
  const names = entries
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -".yaml".length))
    .sort();
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
  return recipe;
}

// Implicit-wire the agent-spawn extension and its tools when a recipe
// declares `agents: [...]`. Mirrors the conditional `usesBus` push for
// --agent-bus-root: only push --allowed-agents when agent-spawn actually
// runs, otherwise pi rejects the flag as unknown.
//
// Inverse rejection: if a recipe loads agent-spawn or its tools without
// declaring `agents:`, that's a misconfiguration — fail loudly so the
// allowlist is never accidentally empty.
function applyAgentsField(recipe, name) {
  const declared = Array.isArray(recipe.agents) ? recipe.agents.filter((a) => typeof a === "string") : [];
  const explicitExts = Array.isArray(recipe.extensions) ? recipe.extensions.slice() : [];
  const explicitTools = Array.isArray(recipe.tools) ? recipe.tools.slice() : [];
  const SPAWN_TOOLS = ["delegate", "approve_delegation"];

  if (declared.length === 0) {
    if (explicitExts.includes("agent-spawn")) {
      die(
        `recipe ${name} loads extension 'agent-spawn' but has no 'agents:' list — ` +
          `declare which child recipes are allowed (or drop the extension)`,
      );
    }
    for (const t of SPAWN_TOOLS) {
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

  let extensions = explicitExts.includes("agent-spawn") ? explicitExts : [...explicitExts, "agent-spawn"];
  // Pair the spawn extension with the per-delegation widget so the parent's
  // TUI shows live status boxes above the input. delegation-boxes reads
  // agent-spawn's globalThis registry; loading one without the other would
  // leave the boxes wired but empty (or the registry rendered nowhere).
  if (!extensions.includes("delegation-boxes")) extensions = [...extensions, "delegation-boxes"];
  const tools = explicitTools.slice();
  for (const t of SPAWN_TOOLS) if (!tools.includes(t)) tools.push(t);
  return { allowed: declared, extensions, tools };
}

function resolveModel(tierOrId) {
  const requested = tierOrId || "RABBIT_TASK_MODEL";
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
// Two conditional rules avoid showing fragments that would mislead the
// model:
//   - `deferred-confirm` is a baseline extension and always loaded, but
//     its fragment (apply order, atomic batch semantics) is only
//     relevant when at least one `deferred-*` tool extension is loaded.
//   - `agent-spawn` ships two fragments. The base one explains the
//     `delegate` / `approve_delegation` mechanics. The companion
//     `agent-spawn.approval.prompt.md` describes the draft-approval
//     workflow and is only included when at least one allowed child
//     recipe loads a `deferred-*` extension (i.e. can actually produce
//     drafts that need approving). A delegator whose children never
//     queue drafts does not need approval-flow guidance.
function loadPromptFragments(extensionNames, allowedAgents) {
  const hasDeferredTool = extensionNames.some(
    (n) => n.startsWith("deferred-") && n !== "deferred-confirm",
  );
  const fragments = [];
  for (const name of extensionNames) {
    if (name === "deferred-confirm" && !hasDeferredTool) continue;
    const p = path.join(EXTENSIONS_DIR, `${name}.prompt.md`);
    if (existsSync(p)) fragments.push(readFileSync(p, "utf8").trim());
  }
  if (extensionNames.includes("agent-spawn") && allowedAgents.length > 0) {
    const anyApprovable = allowedAgents.some((child) => {
      const f = path.join(AGENTS_DIR, `${child}.yaml`);
      if (!existsSync(f)) return false;
      try {
        const r = parseYaml(readFileSync(f, "utf8"));
        const exts = Array.isArray(r?.extensions) ? r.extensions : [];
        return exts.some((e) => typeof e === "string" && e.startsWith("deferred-") && e !== "deferred-confirm");
      } catch {
        return false;
      }
    });
    if (anyApprovable) {
      const p = path.join(EXTENSIONS_DIR, "agent-spawn.approval.prompt.md");
      if (existsSync(p)) fragments.push(readFileSync(p, "utf8").trim());
    }
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

const recipeModel = recipe.model || "RABBIT_TASK_MODEL";
const model = resolveModel(recipeModel);
const wired = applyAgentsField(recipe, args.name);
const extensionPaths = resolveExtensionPaths(wired.extensions);
const skillPaths = resolveSkillPaths(Array.isArray(recipe.skills) ? recipe.skills : []);

// Build the effective system prompt: tool/extension fragments first
// (in load order), then the recipe's own role-specific prompt.
const mergedExtensions = [
  ...BASELINE_EXTENSIONS,
  ...wired.extensions.filter((n) => !BASELINE_EXTENSIONS.includes(n)),
];
const promptFragments = loadPromptFragments(mergedExtensions, wired.allowed);
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
piArgs.push("--sandbox-root", sandboxRoot);

// Pull --agent-name and --rpc-sock out of passthrough so we can mirror
// them to env vars. pi.getFlag is scoped to the extension that
// registered the flag, so cross-extension reads need to bounce through
// the env (already the case for --agent-name read by agent-bus, and
// now --rpc-sock read by agent-status-reporter while deferred-confirm
// owns the flag registration).
let agentName = args.name;
let rpcSock = "";
const passthrough = [];
for (let i = 0; i < args.passthrough.length; i++) {
  if (args.passthrough[i] === "--agent-name" && i + 1 < args.passthrough.length) {
    agentName = args.passthrough[++i];
  } else if (args.passthrough[i] === "--rpc-sock" && i + 1 < args.passthrough.length) {
    rpcSock = args.passthrough[++i];
    // Keep --rpc-sock in passthrough too so deferred-confirm still sees it.
    passthrough.push("--rpc-sock", rpcSock);
  } else {
    passthrough.push(args.passthrough[i]);
  }
}
args.passthrough = passthrough;
piArgs.push("--agent-name", agentName);

const busRoot =
  args.agentBus ||
  process.env.PI_AGENT_BUS_ROOT ||
  path.join(os.homedir(), ".pi-agent-bus", path.basename(sandboxRoot));
// Only push extension-owned flags when their owning extension is
// actually loaded; otherwise pi rejects the flag as unknown.
const usesBus = wired.extensions.includes("agent-bus");
if (usesBus) piArgs.push("--agent-bus-root", busRoot);
if (wired.allowed.length > 0) piArgs.push("--allowed-agents", wired.allowed.join(","));
if (typeof recipe.description === "string" && recipe.description.trim()) {
  piArgs.push("--agent-description", recipe.description.trim());
}
if (TIER_VARS.has(recipeModel)) {
  piArgs.push("--agent-tier", recipeModel);
}
if (Array.isArray(recipe.noEditAdd) && recipe.noEditAdd.length > 0) {
  piArgs.push("--no-edit-add", recipe.noEditAdd.join(","));
}
if (Array.isArray(recipe.noEditSkip) && recipe.noEditSkip.length > 0) {
  piArgs.push("--no-edit-skip", recipe.noEditSkip.join(","));
}
piArgs.push(...args.passthrough);

if (!existsSync(PI_BIN)) die(`pi binary missing: ${PI_BIN} (run npm install)`);

const recipeSkills = Array.isArray(recipe.skills) ? recipe.skills.filter((s) => typeof s === "string") : [];

const child = spawn(PI_BIN, piArgs, {
  cwd: sandboxRoot,
  stdio: "inherit",
  // Mirror the agent name + bus root + rpc sock into env vars so
  // extensions that can't read the CLI flags via pi.getFlag (which is
  // scoped per extension) still see them. Skills and allowed-agents
  // are mirrored too so agent-footer can render them on its third
  // line without duplicating flag registrations.
  env: {
    ...process.env,
    PI_AGENT_NAME: agentName,
    PI_AGENT_BUS_ROOT: busRoot,
    PI_AGENT_SKILLS: recipeSkills.join(","),
    PI_AGENT_AGENTS: wired.allowed.join(","),
    ...(rpcSock ? { PI_RPC_SOCK: rpcSock } : {}),
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
