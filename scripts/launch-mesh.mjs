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
import { resolveEntry, crashAutoShiftTarget } from "../pi-sandbox/.pi/extensions/_lib/entry-resolver.mjs";
import { generateInstanceName, probeBusRoot } from "./agent-naming.mjs";
import { createPtyPool } from "./_lib/pty-pool.mjs";
import { createMultiplexer } from "./_lib/multiplexer.mjs";
import { createLauncherSocket } from "./_lib/launcher-socket.mjs";
import { makeFocusChangedEnvelope, makeTailToggleEnvelope, makePinnedResolvedEnvelope } from "./_lib/launcher-envelope.mjs";
import { createDecisionsQueue } from "./_lib/decisions-queue.mjs";
import { createFocusController } from "./_lib/focus-controller.mjs";
import { renderChrome } from "./_lib/chrome.mjs";
import { createBusTailBuffer, renderBusTailOverlay } from "./_lib/bus-tail.mjs";

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

// ── Right-rail chrome state ──────────────────────────────────────────────────
//
// peerEntries tracks the full PeerEntry for each node so the chrome can render
// accurate state icons and crash info. Updated on pool.on("exit") /
// pool.on("crash") and re-rendered whenever focus changes or a peer exits/crashes.
//
// Chrome is written to stderr (separate from the peer pane on stdout) and
// redrawn on every focus or state change.

/** @type {Map<string, import('./_lib/chrome.mjs').PeerEntry>} */
const peerEntries = new Map();

// Bus-tail overlay state — buffer of observed envelopes and toggle state.
const busTailBuffer = createBusTailBuffer();
const busTailState = { on: false, filter: undefined };

// Decisions queue — tracks pinned decisions from peers (sticky lifecycle).
const decisionsQueue = createDecisionsQueue();

/**
 * Render and emit the right-rail chrome to stderr.
 * Called on every focus change and peer state transition.
 */
function repaintChrome() {
  const peers = [...peerEntries.values()];
  const chrome = renderChrome({
    peers,
    focused: focusController.getFocus(),
    busRoot,
    meshName: path.basename(meshPath, ".yaml"),
    autoShiftNotice: focusController.getAutoShiftNotice(),
    decisionsQueue: decisionsQueue.list(),
  });
  const tailEntries = busTailBuffer.getEntries(busTailState.filter);
  const tailOutput = renderBusTailOverlay({
    entries: tailEntries,
    active: busTailState.on,
    filter: busTailState.filter,
  });
  process.stderr.write(tailOutput + chrome);
}


// ── PTY pool + multiplexer + launcher socket (slice 3: multi-peer focus) ──────
//
// Every pi-agent node is spawned via node-pty into a VirtualBuffer.
// The focused peer's buffer is rendered live to the launcher's terminal.
// Focus can be switched by a peer sending a focus-request to the launcher socket.
//
// PTY-in-PTY fix (slice 3): run-agent.mjs checks PI_MESH_PEER=1 and uses
// inherited stdio when its own stdout is already inside a managed PTY,
// preventing the PTY-in-PTY nesting that slice 2 had for non-entry peers.
//
// TODO(manual-tmux-check): verify multi-peer focus switching with:
//   set -a; source models.env; set +a
//   tmux new-session -d -s mesh-test -x 220 -y 50 \
//     'npm run mesh -- pi-sandbox/meshes/authority-mesh.yaml'
//   sleep 5
//   tmux capture-pane -t mesh-test -p
//   # expect: entry peer's agent-header / agent-footer rendered in launcher pane
//   # type /focus <other-peer-name> in the TUI to switch focus
//   # expect: the other peer's buffer is now painted
//   tmux send-keys -t mesh-test 'C-c'
//   sleep 2
//   # expect: all peers cleaned up, no orphan pi processes

const isTTY = Boolean(process.stdout.isTTY);
const cols = isTTY ? (process.stdout.columns || 220) : 220;
const rows = isTTY ? (process.stdout.rows || 50) : 50;

const pool = createPtyPool();
const mux = isTTY ? createMultiplexer({ out: process.stdout }) : null;
const focusController = createFocusController();

if (mux) {
  mux.attachPool(pool);
  mux.attachResizeHandler(pool);
}

// ── Launcher socket ──────────────────────────────────────────────────────────
//
// Binds ${BUS_ROOT}/__launcher__.sock. Peers that load launcher-bridge connect
// here to send focus-request envelopes and receive focus-changed broadcasts.

const launcherSock = createLauncherSocket();
await launcherSock.bind(busRoot);

// When the focus controller changes focus, broadcast focus-changed to all
// connected peers, repaint the multiplexer, and redraw the chrome.
focusController.on("focus-changed", ({ focused }) => {
  const env = makeFocusChangedEnvelope({ focused });
  launcherSock.broadcast(env);
  if (mux && focused) {
    mux.setFocus(focused);
  } else if (mux && !focused) {
    mux.setFocus(null);
  }
  repaintChrome();
});

// ── Crash auto-shift (slice 4) ───────────────────────────────────────────────
//
// When a peer's PTY exits abnormally (non-zero code or signal), the pool emits
// a typed "crash" event. We:
//   1. Mark the peer as "crashed" in peerEntries (with exit code / signal).
//   2. Call focusController.handleCrash() to auto-shift focus to the top
//      supervisor if the crashed peer was the focused one.
//   3. Repaint the chrome so the crashed indicator and auto-shift notice show.
//
// The top supervisor is resolved once from the topology. If it can't be resolved
// uniquely (zero or multiple candidates), crashTarget is null and handleCrash
// will clear focus rather than shift it.
//
// Ordering: pool emits "exit" then "crash" synchronously in the same onExit
// callback. The exit handler defers unregisterPeer for crashed peers so that
// handleCrash (in the crash handler) can see the focused state before it's
// cleared by unregisterPeer. The crash handler calls handleCrash then
// unregisterPeer.

const crashTarget = crashAutoShiftTarget(topology);

pool.on("crash", (/** @type {import('./_lib/pty-pool.mjs').CrashEvent} */ ev) => {
  const { peer, exitCode, signal } = ev;
  // Override state to "crashed" (exit handler set "exited" first).
  peerEntries.set(peer, { name: peer, state: "crashed", exitCode, exitSignal: signal });
  process.stderr.write(
    `launch-mesh: peer "${peer}" crashed (code=${exitCode} signal=${signal})\n`,
  );
  // Auto-shift focus if needed (before unregistering so handleCrash sees focused state).
  focusController.handleCrash(peer, crashTarget);
  // Unregister after handleCrash: focus already shifted away so unregisterPeer
  // won't trigger the fallback "clear focus" path for the now-shifted focus.
  focusController.unregisterPeer(peer);
  repaintChrome();
});

// crash-notice event: emitted by handleCrash — log it for debugging.
focusController.on("crash-notice", (/** @type {any} */ notice) => {
  if (notice.wasTopSupervisor) {
    process.stderr.write(
      `launch-mesh: top supervisor "${notice.peerName}" crashed — no auto-shift possible\n`,
    );
  } else if (notice.shiftedTo) {
    process.stderr.write(
      `launch-mesh: auto-shifted focus from "${notice.peerName}" to "${notice.shiftedTo}"\n`,
    );
  }
});

// Dispatch inbound envelopes from peers.
launcherSock.on("envelope", (env) => {
  if (env.kind === "focus-request") {
    const target = env.target;
    if (typeof target === "string") {
      const result = focusController.setFocus(target);
      if (!result.ok) {
        process.stderr.write(`launch-mesh: focus-request rejected: ${result.reason}\n`);
      }
    }
  } else if (env.kind === "tail-toggle") {
    // A peer sent a tail-toggle; update the launcher's tail state and
    // re-broadcast to ALL peers so each peer's emitter can self-gate on focus.
    busTailState.on = Boolean(env.on);
    busTailState.filter = typeof env.filter === "string" ? env.filter : undefined;
    if (!busTailState.on) busTailBuffer.clear();
    // Re-broadcast so all peers (not just the sender) receive the toggle.
    const broadcast = makeTailToggleEnvelope({
      on: busTailState.on,
      ...(busTailState.filter !== undefined ? { filter: busTailState.filter } : {}),
    });
    launcherSock.broadcast(broadcast);
    repaintChrome();
  } else if (env.kind === "tail-event") {
    // A focused peer forwarded a bus envelope observation.
    if (busTailState.on) {
      busTailBuffer.push({
        ts: typeof env.ts === "number" ? env.ts : Date.now(),
        sender: typeof env.sender === "string" ? env.sender : "?",
        recipient: typeof env.recipient === "string" ? env.recipient : "?",
        envKind: typeof env.envKind === "string" ? env.envKind : "?",
        body: typeof env.body === "string" ? env.body : "",
        direction: "in",
      });
      repaintChrome();
    }
  } else if (env.kind === "decision-pending") {
    // Top Supervisor opened (on:true) or resolved (on:false) a local escalation dialog.
    // Update the peer's decisionPending flag and repaint so the badge appears/disappears.
    const peerName = typeof env.peer === "string" ? env.peer : null;
    const on = Boolean(env.on);
    if (peerName && peerEntries.has(peerName)) {
      const entry = peerEntries.get(peerName);
      peerEntries.set(peerName, { ...entry, decisionPending: on });
      process.stderr.write(
        `launch-mesh: decision-pending from "${peerName}": ${on ? "opened" : "resolved"}\n`,
      );
      repaintChrome();
    }
  } else if (env.kind === "pin-request") {
    // A peer sent /pin — promote the currently-open dialog into the decisions queue
    // with sticky (pinned) lifecycle. The item survives focus changes.
    const msg_id = typeof env.msg_id === "string" ? env.msg_id : null;
    const peer = typeof env.peer === "string" ? env.peer : null;
    const kind = typeof env.kind_of_decision === "string" ? env.kind_of_decision : "unknown";
    const summary = typeof env.summary === "string" ? env.summary : "";
    if (msg_id && peer) {
      decisionsQueue.enqueue({ msg_id, peer, kind, summary });
      decisionsQueue.pin(msg_id);
      process.stderr.write(
        `launch-mesh: pin-request from "${peer}": pinned msg_id=${msg_id.slice(0, 8)}\n`,
      );
      repaintChrome();
    }
  } else if (env.kind === "decisions-jump") {
    // A peer sent /decisions — log it; full TUI panel focus is deferred (requires
    // deeper TUI integration in a future slice). For now, notify via stderr.
    const from = typeof env.from === "string" ? env.from : "?";
    process.stderr.write(
      `launch-mesh: decisions-jump from "${from}": ${decisionsQueue.count()} item(s) in queue (TUI panel focus deferred)\n`,
    );
    // Repaint so the queue count badge is visible.
    repaintChrome();
  }
});

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
    // PI_MESH_PEER=1 signals run-agent.mjs to:
    //   1. Load the launcher-bridge + slash-commands baseline extensions.
    //   2. Use inherited stdio (not a nested PTY) when spawning pi — this
    //      fixes the PTY-in-PTY nesting issue from slice 2 where each peer
    //      spawned its own PTY even though its stdout was already inside the
    //      launcher's managed PTY.
    PI_MESH_PEER: "1",
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

  // Track this peer as spawning; updated to crashed/exited on exit.
  peerEntries.set(name, { name, state: "spawning" });

  // Register the peer with the focus controller so setFocus can validate names.
  focusController.registerPeer(name);

  // Unregister when the peer exits so focus falls back gracefully.
  // For crashed peers (non-zero code or signal), we defer unregistration to the
  // crash handler so that handleCrash can inspect focused state before it's
  // cleared by unregisterPeer. Clean exits unregister immediately.
  pool.on("exit", (exitedName, code, signal) => {
    if (exitedName === name) {
      const isCrash = (code !== null && code !== 0) || (signal !== null && signal !== "");
      peerEntries.set(name, { name, state: "exited", exitCode: code, exitSignal: signal });
      process.stderr.write(`${prefix}exited (code=${code} signal=${signal})\n`);
      if (!isCrash) {
        // Clean exit: unregister immediately so focus falls back.
        focusController.unregisterPeer(name);
        repaintChrome();
      }
      // For crash exits: the "crash" handler fires next (synchronously) and will
      // handle unregistration and auto-shift, then repaint.
    }
  });

  // For non-entry RPC peers: send the initial task as the first RPC prompt.
  if (!isEntry && task) {
    // Use pool.write() to inject the JSON prompt into the PTY stdin.
    pool.write(name, JSON.stringify({ type: "prompt", message: task }) + "\n");
  }

  nodeNames.push(name);
}

// Focus the entry peer (renders its buffer to the launcher's terminal).
// Use the FocusController so focus-changed events broadcast to all peers.
if (entryPeer && nodeNames.includes(entryPeer)) {
  focusController.setFocus(entryPeer);
  if (mux) mux.setFocus(entryPeer);

  // Forward stdin to the focused peer's PTY so the user can type.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const focused = focusController.getFocus() ?? mux?.getFocus();
    // Clear auto-shift notice on first user input after a crash auto-shift.
    if (focusController.getAutoShiftNotice()) {
      focusController.clearAutoShiftNotice();
      repaintChrome();
    }
    if (!focused) return;
    // Ctrl-C in raw mode: initiate teardown.
    if (chunk === "\x03") {
      shutdown("SIGINT");
      return;
    }
    pool.write(focused, chunk);
  });
}

// ── Coordinated teardown ──────────────────────────────────────────────────────

function shutdown(signal) {
  process.stderr.write(`\nlaunch-mesh: ${signal} — stopping all nodes\n`);
  if (mux) mux.detach();
  launcherSock.close().catch(() => {});
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
    launcherSock.close().catch(() => {});
    if (isTTY) process.stdout.write("\x1b[?25h\x1b[0m");
    process.exit(0);
  }
});

// Paint the initial right-rail chrome to stderr (and re-paint on every focus /
// state change via repaintChrome() — wired above in the focus-changed handler
// and pool.on("exit") handlers).
repaintChrome();

process.stderr.write(
  `launch-mesh: started ${nodeNames.length} node(s) — bus_root=${busRoot}\n` +
  `             Entry peer: ${entryPeer ?? "(none)"} — Press Ctrl+C to stop all.\n` +
  `             Launcher socket: ${launcherSock.getSockPath()}\n` +
  `             Use /focus <peer-name> in the TUI to switch the focused peer.\n`,
);
