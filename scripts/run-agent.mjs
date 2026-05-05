#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { generateInstanceName, probeBusRoot } from "./agent-naming.mjs";
import { createPtyPool } from "./_lib/pty-pool.mjs";
import { createMultiplexer } from "./_lib/multiplexer.mjs";
import { rejectDeprecatedPeerFields, mergeBaselineTools } from "./_lib/recipe-validation.mjs";
import { resolveRecipe } from "./_lib/recipe-resolver.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_ROOT = path.join(REPO_ROOT, "pi-sandbox");
const AGENTS_DIR = path.join(SANDBOX_ROOT, "agents");
const TEMPLATES_DIR = path.join(SANDBOX_ROOT, "templates");
const EXTENSIONS_DIR = path.join(SANDBOX_ROOT, ".pi", "extensions");
const SKILLS_DIR = path.join(SANDBOX_ROOT, "skills");
const PI_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "pi");

const BASELINE_EXTENSIONS = [
  // Must be first — materialises the Habitat before any rail reads it.
  "habitat",
  "sandbox",
  "no-startup-help",
  "agent-header",
  "agent-footer",
  "hide-extensions-list",
  "deferred-confirm",
  // Bus binding is a baseline now: atomic-delegate, supervisor rail,
  // and the deferred-* submission flow all need a bound bus socket.
  // The agent_send / agent_inbox / agent_list / agent_call tools stay
  // gated by the recipe's `tools:` allowlist, so loading the extension
  // by default does not change the tool surface seen by the model.
  "agent-bus",
  // supervisor must appear before intercept so intercept can wrap
  // supervisor's globalThis dispatch hook at session_start. Both
  // self-gate via getHabitat().acceptedFrom when the topology does not
  // assign any inbound peers to this instance.
  "supervisor",
  "intercept",
];

// When launched under the mesh launcher (PI_MESH_PEER=1), load the launcher
// bridge, focus-state, and slash-commands extensions as additional baselines.
// These are silent no-ops when the launcher socket is absent (standalone mode).
//
// mesh-rail renders the mesh-status widget above the editor; only meaningful
// under the launcher. Like the others, it degrades silently if hasUI is false
// (print mode / no TUI).
const MESH_PEER_EXTENSIONS = [
  "launcher-bridge",
  "slash-commands",
  "bus-tail-emitter",
  "mesh-rail",
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
  if (recipe.shortName !== undefined) {
    if (typeof recipe.shortName !== "string" || !/^[a-z][a-z0-9-]*$/.test(recipe.shortName)) {
      die(`recipe ${file} 'shortName' must be a lowercase slug ([a-z][a-z0-9-]*)`);
    }
  }
  rejectDeprecatedPeerFields(recipe, name, die);
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
    if (explicitExts.includes("atomic-delegate")) {
      die(
        `recipe ${name} loads extension 'atomic-delegate' but has no 'agents:' list — ` +
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

  const extensions = explicitExts.includes("atomic-delegate")
    ? explicitExts
    : [...explicitExts, "atomic-delegate"];
  const tools = explicitTools.slice();
  for (const t of DELEGATE_TOOLS) if (!tools.includes(t)) tools.push(t);
  return { allowed: declared, extensions, tools };
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

function resolveExtensionPaths(names, isMeshPeer = false) {
  const seen = new Set();
  const baseline = isMeshPeer
    ? [...BASELINE_EXTENSIONS, ...MESH_PEER_EXTENSIONS]
    : BASELINE_EXTENSIONS;
  const merged = [...baseline, ...names];
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
// Conditional rules:
//   - `deferred-confirm` is a baseline extension and always loaded, but
//     its fragment (apply order, atomic batch semantics) is only relevant
//     when at least one `deferred-*` tool extension is loaded.
//   - `supervisor` and `intercept` are baseline extensions and always
//     loaded, but their fragments (inbound rail docs) are only relevant
//     when the resolved Habitat has supervisory peer fields set — i.e.
//     acceptedFrom is non-empty, or supervisor/submitTo is set. This is
//     computed AFTER the topology overlay is merged (hasSupervisoryHabitat).
function loadPromptFragments(extensionNames, hasSupervisoryHabitat = false) {
  const hasDeferredTool = extensionNames.some(
    (n) => n.startsWith("deferred-") && n !== "deferred-confirm",
  );
  const fragments = [];
  for (const name of extensionNames) {
    if (name === "deferred-confirm" && !hasDeferredTool) continue;
    if ((name === "supervisor" || name === "intercept") && !hasSupervisoryHabitat) continue;
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
const wired = wiredAgents;
// Merge baseline tools (respond_to_request) into the recipe's allowlist
// so the supervisor rail is always accessible, even on recipes that don't
// declare any supervisory peer fields.
wired.tools = mergeBaselineTools(wired.tools);

// PI_MESH_PEER=1 is set by launch-mesh.mjs for all peers. It signals
// run-agent.mjs to load the launcher-bridge + slash-commands baseline extensions
// so peers can receive focus-changed signals and send /focus requests.
// When run standalone via `npm run agent`, PI_MESH_PEER is unset,
// so the launcher extensions degrade gracefully (socket not found = no-op).
const isMeshPeer = process.env.PI_MESH_PEER === "1";

const extensionPaths = resolveExtensionPaths(wired.extensions, isMeshPeer);
const skillPaths = resolveSkillPaths(Array.isArray(recipe.skills) ? recipe.skills : []);

// --agent-name passthrough is parsed only to capture the value into the
// Habitat spec; pi receives it solely via --habitat-spec.
// --topology-overlay is set by launch-mesh and atomic-delegate; it carries
// the resolved peer fields and is merged into habitatSpec below.
// Parse passthrough early so topologyOverlayJson is available when gating
// supervisor/intercept prompt fragments (Step 6).
let agentName = null;                                     // null → generate
let topologyOverlayJson = "";
let taskText = "";                                        // appended to system prompt
const passthrough = [];
for (let i = 0; i < args.passthrough.length; i++) {
  if (args.passthrough[i] === "--agent-name" && i + 1 < args.passthrough.length) {
    agentName = args.passthrough[++i];                    // manual override wins
  } else if (args.passthrough[i] === "--topology-overlay" && i + 1 < args.passthrough.length) {
    topologyOverlayJson = args.passthrough[++i];
    // do not push --topology-overlay into passthrough; pi doesn't know this flag
  } else if (args.passthrough[i] === "--task" && i + 1 < args.passthrough.length) {
    taskText = args.passthrough[++i];
    // do not push --task into passthrough; it's consumed here as system-prompt context
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

// Serialise the resolved Habitat into one --habitat-spec flag instead of
// many individual flags + env-var mirrors. The habitat.ts baseline
// extension materialises this at session_start; all other rails read
// their axis from getHabitat() rather than re-parsing flags/env.
// Peer relationship fields (supervisor, submitTo, acceptedFrom, peers)
// are topology-only since #112; they reach the Habitat exclusively via
// the --topology-overlay block below.
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

// Build the effective system prompt: tool/extension fragments first (in load
// order), then the recipe's own role-specific prompt.
//
// supervisor.prompt.md and intercept.prompt.md are gated on whether the
// resolved Habitat (after overlay merge) has any supervisory peer fields set.
// When a standalone agent is launched without a topology overlay those
// fragments are skipped to avoid misleading tool documentation in the prompt.
const hasSupervisoryHabitat =
  (Array.isArray(habitatSpec.acceptedFrom) && habitatSpec.acceptedFrom.length > 0) ||
  Boolean(habitatSpec.supervisor) ||
  Boolean(habitatSpec.submitTo);

const effectiveBaseline = isMeshPeer
  ? [...BASELINE_EXTENSIONS, ...MESH_PEER_EXTENSIONS]
  : BASELINE_EXTENSIONS;
const mergedExtensions = [
  ...effectiveBaseline,
  ...wired.extensions.filter((n) => !effectiveBaseline.includes(n)),
];

// ── Slice 2 shadow-mode comparator ───────────────────────────────────────────
// Call resolveRecipe and compare its effective extension list with the one the
// JS runner just computed. On mismatch, panic loudly so divergence is caught
// immediately. On match, silent — runtime behaviour is unchanged.
//
// Slice 2 shadow-mode shim: today's recipes are bare (no `extends:`), so the
// resolver returns only recipe-level extensions. We prepend effectiveBaseline
// here for a like-for-like comparison. Once recipes start carrying
// `extends: peer`, the JS baseline prefix will collapse to a no-op (all
// baseline entries will already be present from the template chain).
{
  let resolverResult;
  try {
    resolverResult = resolveRecipe(args.name, {
      agentsDir: AGENTS_DIR,
      templatesDir: TEMPLATES_DIR,
      extensionsDir: EXTENSIONS_DIR,
    });
  } catch (e) {
    die(`recipe-resolver shadow failed for '${args.name}': ${e.message}`);
  }

  // Deduplicate baseline + resolver extension list (first-occurrence).
  const seenShadow = new Set();
  const shadowEffective = [];
  for (const n of [...effectiveBaseline, ...resolverResult.extensionList]) {
    if (!seenShadow.has(n)) {
      seenShadow.add(n);
      shadowEffective.push(n);
    }
  }

  const mismatch =
    mergedExtensions.length !== shadowEffective.length ||
    mergedExtensions.some((n, i) => n !== shadowEffective[i]);

  if (mismatch) {
    process.stderr.write(
      `run-agent: recipe-resolver shadow mismatch for '${args.name}':\n` +
        `  js-baseline:   ${JSON.stringify(mergedExtensions)}\n` +
        `  resolver+shim: ${JSON.stringify(shadowEffective)}\n` +
        `  in js but not resolver: ${JSON.stringify(mergedExtensions.filter((n) => !shadowEffective.includes(n)))}\n` +
        `  in resolver but not js: ${JSON.stringify(shadowEffective.filter((n) => !mergedExtensions.includes(n)))}\n`,
    );
    process.exit(1);
  }
}
// ── End shadow comparator ─────────────────────────────────────────────────────

const promptFragments = loadPromptFragments(mergedExtensions, hasSupervisoryHabitat);
const promptParts = [...promptFragments, recipe.prompt.trim()];
if (taskText.trim()) promptParts.push(taskText.trim());
const systemPrompt = promptParts.join("\n\n");

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

piArgs.push("--habitat-spec", JSON.stringify(habitatSpec));
piArgs.push(...args.passthrough);

if (!existsSync(PI_BIN)) die(`pi binary missing: ${PI_BIN} (run npm install)`);

// ── PTY pool + multiplexer (slice 2: single-peer launcher TUI) ───────────────
//
// Spawn pi in a PTY so the full interactive TUI renders (agent-header,
// agent-footer, deferred-confirm dialogs) and pipe its output through a
// VirtualBuffer before painting to the launcher's terminal.
//
// In interactive mode (stdio is a TTY) we use PTY-based rendering.
// In non-interactive mode (piped stdout, CI, -p passthrough) we fall back to
// the plain child_process.spawn path with inherited stdio so scripts that
// capture stdout keep working.
//
// TODO(manual-tmux-check): verify full TUI fidelity with:
//   set -a; source models.env; set +a
//   tmux new-session -d -s run-agent-test -x 220 -y 50 \
//     'npm run agent -- deferred-writer'
//   sleep 5
//   tmux capture-pane -t run-agent-test -p
//   # expect: agent-header strip, agent-footer four-line block visible
//   tmux send-keys -t run-agent-test '/quit' Enter
//   sleep 2
//   # expect: clean exit, no orphan pi processes
//   tmux kill-session -t run-agent-test

const isTTY = Boolean(process.stdout.isTTY);
const isPrintMode = args.passthrough.includes("-p") || args.passthrough.includes("--print");

// PTY-in-PTY fix (slice 3): when run-agent.mjs is launched as a PI_MESH_PEER=1
// child of launch-mesh.mjs, its stdout is already inside the launcher's managed
// PTY. Creating another PTY here would cause PTY-in-PTY nesting and break
// terminal rendering. In that case, fall through to the inherited-stdio path so
// pi writes directly to the launcher's PTY buffer.
const isInsideManagedPty = isMeshPeer && isTTY;

if (isTTY && !isPrintMode && !isInsideManagedPty) {
  // Interactive launcher path: PTY + virtual buffer + multiplexer.
  const cols = process.stdout.columns || 220;
  const rows = process.stdout.rows || 50;

  const pool = createPtyPool();
  const mux = createMultiplexer({ out: process.stdout });

  pool.spawn({
    name: agentName,
    cmd: PI_BIN,
    args: piArgs,
    cols,
    rows,
    cwd: sandboxRoot,
    env: { ...process.env },
  });

  mux.attachPool(pool);
  mux.setFocus(agentName);
  mux.attachResizeHandler(pool);

  // Forward stdin to the focused peer's PTY so the user can type.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    // Ctrl-C in raw mode sends \x03; translate to SIGINT for the peer.
    if (chunk === "\x03") {
      pool.kill(agentName).then(() => process.exit(0));
      return;
    }
    pool.write(agentName, chunk);
  });

  // Coordinated teardown.
  function shutdownAgent(signal) {
    mux.detach();
    pool.kill(agentName).then(() => process.exit(0));
    void signal;
  }

  process.once("SIGINT", () => shutdownAgent("SIGINT"));
  process.once("SIGTERM", () => shutdownAgent("SIGTERM"));

  pool.on("exit", (name, code, signal) => {
    if (name !== agentName) return;
    mux.detach();
    // Restore terminal state before exit.
    process.stdout.write("\x1b[?25h\x1b[0m"); // show cursor + reset attrs
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  // Non-interactive path: plain spawn with inherited stdio (original behaviour).
  const { spawn } = await import("node:child_process");
  const child = spawn(PI_BIN, piArgs, {
    cwd: sandboxRoot,
    stdio: "inherit",
    env: { ...process.env },
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}
