#!/usr/bin/env node
// launch-mesh.mjs — start all nodes of a mesh topology in parallel.
//
// Usage:
//   set -a; source models.env; set +a
//   node scripts/launch-mesh.mjs <mesh.yaml>
//   npm run mesh -- <mesh.yaml>
//
// Topology YAML schema:
//   entry: authority              # required; peer the launcher TUI focuses on first
//   bus_root: /tmp/pi-mesh-demo   # optional; auto-derived from filename
//   nodes:
//     - name: authority           # instance name (--agent-name)
//       recipe: mesh-authority    # recipe in pi-sandbox/agents/
//       sandbox: /tmp/mesh/auth   # optional; auto-created
//       task: "..."               # optional; if set, passes -p (non-interactive)
//     - name: analyst
//       recipe: mesh-node
//       supervisor: authority     # all non-root nodes must declare a supervisor
//       task: "wait for requests"
// NOTE: type:relay nodes are no longer supported (see ADR-0004); the validator
//       will reject any topology that still declares them.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseTopology, resolveNode } from "../pi-sandbox/.pi/extensions/_lib/topology.mjs";
import { validateTopology } from "../pi-sandbox/.pi/extensions/_lib/topology-validator.mjs";
import { resolveEntry } from "../pi-sandbox/.pi/extensions/_lib/entry-resolver.mjs";
import { generateInstanceName, probeBusRoot } from "./agent-naming.mjs";
import { createPtyPool } from "./_lib/pty-pool.mjs";
import { createMultiplexer } from "./_lib/multiplexer.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "run-agent.mjs");

function die(msg) {
  process.stderr.write(`launch-mesh: ${msg}\n`);
  process.exit(1);
}

// ── Parse CLI ────────────────────────────────────────────────────────────────

const meshFile = process.argv[2];
if (!meshFile || meshFile.startsWith("-")) die("Usage: launch-mesh.mjs <mesh.yaml>");
const meshPath = path.resolve(meshFile);
if (!existsSync(meshPath)) die(`mesh file not found: ${meshPath}`);

// ── Load topology ─────────────────────────────────────────────────────────────

let topology;
try {
  topology = parseTopology(readFileSync(meshPath, "utf8"));
} catch (e) {
  die(`failed to parse ${meshPath}: ${e.message}`);
}
if (topology.nodes.length < 2) {
  die("topology must have at least 2 nodes");
}

// ── Validate topology (entry:, relay deprecation, top supervisor, peer refs) ──

/** @param {string} recipeName */
function loadRecipeModel(recipeName) {
  const recipeFile = path.join(REPO_ROOT, "pi-sandbox", "agents", `${recipeName}.yaml`);
  try {
    const recipe = parseYaml(readFileSync(recipeFile, "utf8"));
    if (typeof recipe?.model === "string") return recipe.model;
  } catch { /* recipe not found or unreadable — no tier warning */ }
  return undefined;
}

const { errors: topoErrors, warnings: topoWarnings } = validateTopology(topology, loadRecipeModel);

for (const warning of topoWarnings) {
  process.stderr.write(`launch-mesh: ${warning}\n`);
}

if (topoErrors.length > 0) {
  for (const error of topoErrors) {
    process.stderr.write(`launch-mesh: validation error: ${error}\n`);
  }
  process.exit(1);
}

// Resolve entry peer (for launcher TUI focus — informational for now).
const { entryPeer } = resolveEntry(topology);
if (entryPeer) {
  process.stderr.write(`launch-mesh: entry peer: ${entryPeer}\n`);
}

// Resolve bus root
const busRoot = topology.bus_root
  ? path.resolve(topology.bus_root)
  : path.join(os.homedir(), ".pi-agent-bus", `mesh-${path.basename(meshPath, ".yaml")}`);

mkdirSync(busRoot, { recursive: true });

// Assign names: explicit `name:` wins; missing name auto-generates <breed>-<shortName>
const taken = await probeBusRoot(busRoot);
for (const node of topology.nodes) {
  if (node.name) {
    taken.add(node.name);
    continue;
  }
  if (node.type === "relay") die("relay node must have an explicit name");
  if (!node.recipe) die(`unnamed node is missing 'recipe'`);
  const recipeFile = path.join(REPO_ROOT, "pi-sandbox", "agents", `${node.recipe}.yaml`);
  let shortName = node.recipe;
  let tier;
  try {
    const recipe = parseYaml(readFileSync(recipeFile, "utf8"));
    if (typeof recipe.shortName === "string" && recipe.shortName) shortName = recipe.shortName;
    if (typeof recipe.model === "string") tier = recipe.model;
  } catch { /* fall back to recipe filename */ }
  node.name = generateInstanceName({ tier, shortName, taken });
  taken.add(node.name);
}

// Validate unique names after assignment
const names = topology.nodes.map((n) => n.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length > 0) die(`duplicate node names: ${dupes.join(", ")}`);

// Pre-compute per-node overlays (validates @group refs and peer references early).
const nodeOverlays = new Map();
for (const node of topology.nodes) {
  try {
    nodeOverlays.set(node.name, resolveNode(topology, node.name));
  } catch (e) {
    die(`topology overlay error for node '${node.name}': ${e.message}`);
  }
}

// ── ANSI colors per node ──────────────────────────────────────────────────────

const COLORS = ["\x1b[36m", "\x1b[33m", "\x1b[35m", "\x1b[32m", "\x1b[34m", "\x1b[31m"];
const RESET = "\x1b[0m";

function makePrefix(name, idx) {
  return `${COLORS[idx % COLORS.length]}[${name}]${RESET} `;
}


// ── PTY pool + multiplexer (slice 2: single-peer focused rendering) ──────────
//
// Every pi-agent node is spawned via node-pty into a VirtualBuffer.
// The entry peer's buffer is rendered live to the launcher's terminal.
// Off-screen peers accumulate output in their buffers (slice 3 adds focus
// switching to bring them into view).
//
// TODO(manual-tmux-check): verify full TUI fidelity and clean teardown with:
//   set -a; source models.env; set +a
//   tmux new-session -d -s mesh-test -x 220 -y 50 \
//     'npm run mesh -- pi-sandbox/meshes/authority-mesh.yaml'
//   sleep 5
//   tmux capture-pane -t mesh-test -p
//   # expect: entry peer's agent-header / agent-footer rendered in launcher pane
//   tmux send-keys -t mesh-test 'C-c'
//   sleep 2
//   # expect: all peers cleaned up, no orphan pi processes

const isTTY = Boolean(process.stdout.isTTY);
const cols = isTTY ? (process.stdout.columns || 220) : 220;
const rows = isTTY ? (process.stdout.rows || 50) : 50;

const pool = createPtyPool();
const mux = isTTY ? createMultiplexer({ out: process.stdout }) : null;

if (mux) {
  mux.attachPool(pool);
  mux.attachResizeHandler(pool);
}

// ── Spawn all nodes ───────────────────────────────────────────────────────────

const nodeNames = [];

for (let i = 0; i < topology.nodes.length; i++) {
  const node = topology.nodes[i];
  const { name, type, recipe, task } = node;

  const prefix = makePrefix(name, i);

  if (type === "relay") {
    // Human relay — deprecated; validator should have rejected this, but handle gracefully.
    process.stderr.write(`${prefix}relay nodes are deprecated (see ADR-0004); skipping\n`);
    continue;
  }

  // Pi agent node
  if (!recipe) die(`node "${name}" missing recipe`);

  const sandbox = node.sandbox
    ? path.resolve(node.sandbox)
    : path.join(os.tmpdir(), `pi-mesh-${path.basename(meshPath, ".yaml")}-${name}`);
  mkdirSync(sandbox, { recursive: true });

  const overlay = nodeOverlays.get(name);

  // Non-entry peers run in --mode rpc so the entry peer's PTY gets full terminal.
  // The entry peer runs interactively (no --mode rpc) so pi's TUI renders.
  const isEntry = name === entryPeer;
  const peerArgs = [
    RUNNER,
    recipe,
    "--sandbox", sandbox,
    "--agent-bus", busRoot,
    "--",
    "--agent-name", name,
    "--topology-overlay", JSON.stringify(overlay),
  ];

  if (!isEntry) {
    // Non-entry peers run headless (RPC mode); their output goes into a virtual
    // buffer for slice-3 focus switching but isn't painted to the launcher's terminal.
    peerArgs.push("--mode", "rpc");
  }

  const peerEnv = {
    ...process.env,
    PI_AGENT_NAME: name,
    PI_AGENT_BUS_ROOT: busRoot,
  };

  pool.spawn({
    name,
    cmd: process.execPath,
    args: peerArgs,
    cols,
    rows,
    cwd: REPO_ROOT,
    env: peerEnv,
  });

  // For non-entry RPC peers: send the initial task as the first RPC prompt.
  if (!isEntry && task) {
    // Use pool.write() to inject the JSON prompt into the PTY stdin.
    pool.write(name, JSON.stringify({ type: "prompt", message: task }) + "\n");
  }

  pool.on("exit", (exitedName, code, signal) => {
    if (exitedName === name) {
      process.stderr.write(`${prefix}exited (code=${code} signal=${signal})\n`);
    }
  });

  nodeNames.push(name);
}

// Focus the entry peer (renders its buffer to the launcher's terminal).
if (mux && entryPeer && nodeNames.includes(entryPeer)) {
  mux.setFocus(entryPeer);

  // Forward stdin to the focused peer's PTY so the user can type.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (!mux.getFocus()) return;
    // Ctrl-C in raw mode: initiate teardown.
    if (chunk === "\x03") {
      shutdown("SIGINT");
      return;
    }
    pool.write(mux.getFocus(), chunk);
  });
}

// ── Coordinated teardown ──────────────────────────────────────────────────────

function shutdown(signal) {
  process.stderr.write(`\nlaunch-mesh: ${signal} — stopping all nodes\n`);
  if (mux) mux.detach();
  pool.killAll().then(() => {
    // Restore terminal state.
    if (isTTY) process.stdout.write("\x1b[?25h\x1b[0m");
    process.exit(0);
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// Exit when all nodes have exited naturally.
let exited = 0;
pool.on("exit", () => {
  exited++;
  if (exited >= nodeNames.length) {
    process.stderr.write("launch-mesh: all nodes exited\n");
    if (mux) mux.detach();
    if (isTTY) process.stdout.write("\x1b[?25h\x1b[0m");
    process.exit(0);
  }
});

process.stderr.write(
  `launch-mesh: started ${nodeNames.length} node(s) — bus_root=${busRoot}\n` +
  `             Entry peer: ${entryPeer ?? "(none)"} — Press Ctrl+C to stop all.\n`,
);
