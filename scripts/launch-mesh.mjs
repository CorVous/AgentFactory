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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { generateInstanceName, probeBusRoot } from "./agent-naming.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "run-agent.mjs");
const RELAY = path.join(REPO_ROOT, "scripts", "human-relay.mjs");

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
  topology = parseYaml(readFileSync(meshPath, "utf8"));
} catch (e) {
  die(`failed to parse ${meshPath}: ${e.message}`);
}
if (!topology || !Array.isArray(topology.nodes) || topology.nodes.length < 2) {
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

// ── ANSI colors per node ──────────────────────────────────────────────────────

const COLORS = ["\x1b[36m", "\x1b[33m", "\x1b[35m", "\x1b[32m", "\x1b[34m", "\x1b[31m"];
const RESET = "\x1b[0m";

function makePrefix(name, idx) {
  return `${COLORS[idx % COLORS.length]}[${name}]${RESET} `;
}

function attachPrefixedOutput(child, prefix) {
  let stdoutBuf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      process.stdout.write(prefix + stdoutBuf.slice(0, nl) + "\n");
      stdoutBuf = stdoutBuf.slice(nl + 1);
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

  const args = [
    RUNNER,
    recipe,
    "--sandbox", sandbox,
    "--agent-bus", busRoot,
    "--",
    "--agent-name", name,
    "--mode", "rpc",
  ];

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_AGENT_NAME: name,
      PI_AGENT_BUS_ROOT: busRoot,
      ...(task ? { PI_MESH_INITIAL_TASK: task } : {}),
    },
  });

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
