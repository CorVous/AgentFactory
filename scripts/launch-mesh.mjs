#!/usr/bin/env node
// launch-mesh.mjs — start all nodes of a mesh topology in parallel.
//
// Usage:
//   set -a; source models.env; set +a
//   node scripts/launch-mesh.mjs <mesh.yaml>
//   npm run mesh -- <mesh.yaml>
//
// Topology YAML schema:
//   bus_root: /tmp/pi-mesh-demo   # optional; auto-derived from filename
//   nodes:
//     - name: authority           # instance name (--agent-name)
//       recipe: mesh-authority    # recipe in pi-sandbox/agents/
//       sandbox: /tmp/mesh/auth   # optional; auto-created
//       task: "..."               # optional; if set, passes -p (non-interactive)
//     - name: human
//       type: relay               # spawns human-relay.mjs instead of a pi agent
//     - name: analyst
//       recipe: mesh-node
//       task: "wait for requests"

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseTopology, resolveNode } from "../pi-sandbox/.pi/extensions/_lib/topology.mjs";
import { generateInstanceName, probeBusRoot } from "./agent-naming.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "run-agent.mjs");
const RELAY = path.join(REPO_ROOT, "scripts", "human-relay.mjs");
const KANBAN = path.join(REPO_ROOT, "scripts", "kanban.mjs");
const AGENTS_DIR = path.join(REPO_ROOT, "pi-sandbox", "agents");
const AGENT_SUBDIRS = ["deferred"];

// Resolve a recipe name to an absolute file path (supports sub-path notation).
function resolveRecipePath(name) {
  const direct = path.join(AGENTS_DIR, `${name}.yaml`);
  if (existsSync(direct)) return direct;
  if (!name.includes("/")) {
    for (const sub of AGENT_SUBDIRS) {
      const p = path.join(AGENTS_DIR, sub, `${name}.yaml`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function die(msg) {
  process.stderr.write(`launch-mesh: ${msg}\n`);
  process.exit(1);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// ── Parse CLI ────────────────────────────────────────────────────────────────
//
// Two modes:
//   (a) Runtime mode: --project <path> --feature <slug>
//       Materialises the kanban worktree (idempotent) and spawns the Kanban.
//   (b) Topology mode: <mesh.yaml>  (existing behaviour, unchanged)

const argv = process.argv.slice(2);

// Detect runtime mode: first arg is --project or --feature
const isRuntimeMode = argv.some((a) => a === "--project" || a === "--feature");

if (isRuntimeMode) {
  // ── Runtime mode ────────────────────────────────────────────────────────────
  let projectArg = null;
  let featureSlug = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) projectArg = argv[++i];
    else if (argv[i] === "--feature" && argv[i + 1]) featureSlug = argv[++i];
  }
  if (!projectArg) die("runtime mode requires --project <path>");
  if (!featureSlug) die("runtime mode requires --feature <slug>");

  const projectPath = path.resolve(projectArg);
  if (!existsSync(projectPath)) die(`project path not found: ${projectPath}`);

  const meshBranch = `feature/${featureSlug}`;
  const kanbanWorktreePath = path.join(projectPath, ".mesh-features", featureSlug, "kanban");

  // git worktree add — idempotent: skip if the worktree directory already exists
  if (!existsSync(kanbanWorktreePath)) {
    process.stderr.write(`launch-mesh: adding kanban worktree at ${kanbanWorktreePath}\n`);
    mkdirSync(path.dirname(kanbanWorktreePath), { recursive: true });
    try {
      git(projectPath, "worktree", "add", kanbanWorktreePath, meshBranch);
    } catch (e) {
      die(`git worktree add failed: ${e.message}\n  (Is feature/${featureSlug} a branch in ${projectPath}?)`);
    }
  } else {
    process.stderr.write(`launch-mesh: kanban worktree already present at ${kanbanWorktreePath}\n`);
  }

  // Bus root: scoped to (project, feature)
  const busRoot = process.env.PI_AGENT_BUS_ROOT
    ? path.resolve(process.env.PI_AGENT_BUS_ROOT)
    : path.join(os.homedir(), ".pi-agent-bus", `${path.basename(projectPath)}-${featureSlug}`);
  mkdirSync(busRoot, { recursive: true });

  process.stderr.write(`launch-mesh: starting Kanban (runtime mode)\n`);
  process.stderr.write(`  project=${projectPath}\n`);
  process.stderr.write(`  feature=${featureSlug}\n`);
  process.stderr.write(`  kanbanWorktree=${kanbanWorktreePath}\n`);
  process.stderr.write(`  busRoot=${busRoot}\n`);

  const kanbanArgs = [
    KANBAN,
    "--name", "kanban",
    "--bus-root", busRoot,
    "--project", projectPath,
    "--feature", featureSlug,
    "--kanban-worktree", kanbanWorktreePath,
  ];

  const child = spawn(process.execPath, kanbanArgs, {
    cwd: kanbanWorktreePath,
    stdio: "inherit",
    env: { ...process.env, PI_AGENT_BUS_ROOT: busRoot },
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  process.once("SIGINT", () => {
    try { child.kill("SIGTERM"); } catch { /* noop */ }
  });
  process.once("SIGTERM", () => {
    try { child.kill("SIGTERM"); } catch { /* noop */ }
  });

  // Exit immediately — the kanban process takes over stdio
  // (process will stay alive as long as the child is alive via the exit handler)
} else {
  // ── Topology mode (existing behaviour) ──────────────────────────────────────
  const meshFile = argv[0];
  if (!meshFile || meshFile.startsWith("-")) die("Usage: launch-mesh.mjs <mesh.yaml>  OR  launch-mesh.mjs --project <path> --feature <slug>");
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
  const recipeFile = resolveRecipePath(node.recipe);
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

// Extract a short human-readable summary from a pi RPC JSON event line.
// Returns a string to display, or null to suppress the line.
function formatRpcLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  if (!ev || typeof ev !== "object") return null;
  switch (ev.type) {
    case "turn_start":    return "(thinking…)";
    case "turn_end":      return null;
    case "agent_start":   return null;
    case "agent_end":     return null;
    case "message_end": {
      const msg = ev.message;
      if (!msg || msg.role !== "assistant") return null;
      const parts = [];
      for (const c of (msg.content ?? [])) {
        if (c.type === "text" && c.text) parts.push(c.text.trim());
      }
      return parts.length > 0 ? parts.join(" ") : null;
    }
    case "extension_error":
      return `[extension error] ${ev.event}: ${ev.error}`;
    default:
      return null;
  }
}

function attachPrefixedOutput(child, prefix) {
  let stdoutBuf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      const formatted = formatRpcLine(line);
      if (formatted !== null) process.stdout.write(prefix + formatted + "\n");
    }
  });

  let stderrBuf = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderrBuf += chunk;
    let nl;
    while ((nl = stderrBuf.indexOf("\n")) !== -1) {
      process.stderr.write(prefix + stderrBuf.slice(0, nl) + "\n");
      stderrBuf = stderrBuf.slice(nl + 1);
    }
  });
}

// ── Spawn all nodes ───────────────────────────────────────────────────────────

const children = [];

for (let i = 0; i < topology.nodes.length; i++) {
  const node = topology.nodes[i];
  const { name, type, recipe, task } = node;

  const prefix = makePrefix(name, i);

  if (type === "relay") {
    // Human relay — thin REPL on the bus, no LLM
    if (!existsSync(RELAY)) die(`human-relay.mjs not found at ${RELAY}`);
    const child = spawn(process.execPath, [RELAY, "--name", name, "--bus-root", busRoot], {
      cwd: REPO_ROOT,
      stdio: ["inherit", "inherit", "inherit"], // relay gets full terminal access
    });
    child.on("exit", (code, signal) => {
      process.stderr.write(`${prefix}relay exited (code=${code} signal=${signal})\n`);
    });
    children.push({ name, child });
    continue;
  }

  // Pi agent node
  if (!recipe) die(`node "${name}" missing recipe`);

  const sandbox = node.sandbox
    ? path.resolve(node.sandbox)
    : path.join(os.tmpdir(), `pi-mesh-${path.basename(meshPath, ".yaml")}-${name}`);
  mkdirSync(sandbox, { recursive: true });

  const overlay = nodeOverlays.get(name);
  const args = [
    RUNNER,
    recipe,
    "--sandbox", sandbox,
    "--agent-bus", busRoot,
    "--",
    "--agent-name", name,
    "--mode", "rpc",
    "--topology-overlay", JSON.stringify(overlay),
  ];

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_AGENT_NAME: name,
      PI_AGENT_BUS_ROOT: busRoot,
    },
  });

  // Send the initial task as the first RPC prompt command.
  if (task) {
    child.stdin.write(JSON.stringify({ type: "prompt", message: task }) + "\n");
  }

  attachPrefixedOutput(child, prefix);
  child.on("exit", (code, signal) => {
    process.stderr.write(`${prefix}exited (code=${code} signal=${signal})\n`);
  });
  children.push({ name, child });
}

// ── Coordinated teardown ──────────────────────────────────────────────────────

function shutdown(signal) {
  process.stderr.write(`\nlaunch-mesh: ${signal} — stopping all nodes\n`);
  for (const { name, child } of children) {
    if (child.exitCode === null && !child.killed) {
      process.stderr.write(`launch-mesh: sending SIGTERM to ${name}\n`);
      try { child.kill("SIGTERM"); } catch { /* noop */ }
    }
  }
  setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode === null && !child.killed) {
        try { child.kill("SIGKILL"); } catch { /* noop */ }
      }
    }
    process.exit(0);
  }, 3000);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// Exit when all children are done
let exited = 0;
for (const { child } of children) {
  child.once("exit", () => {
    exited++;
    if (exited === children.length) {
      process.stderr.write("launch-mesh: all nodes exited\n");
      process.exit(0);
    }
  });
}

process.stderr.write(
  `launch-mesh: started ${children.length} node(s) — bus_root=${busRoot}\n` +
  `             Press Ctrl+C to stop all.\n`,
);
} // end topology mode else block
