#!/usr/bin/env node
// launch-mesh.mjs — start a Ralph-Loop Kanban mesh or a topology-YAML mesh.
//
// Runtime mode (Ralph-Loop):
//   npm run mesh -- --project <path> --feature <slug>
//   node scripts/launch-mesh.mjs --project <path> --feature <slug>
//
// Topology mode (legacy):
//   set -a; source models.env; set +a
//   node scripts/launch-mesh.mjs <mesh.yaml>
//   npm run mesh -- <mesh.yaml>
//
// Topology YAML schema:
//   bus_root: /tmp/pi-mesh-demo   # optional; auto-derived from filename
//   nodes:
//     - name: authority           # instance name (--agent-name)
//       recipe: deferred/mesh-authority    # recipe in pi-sandbox/agents/
//       sandbox: /tmp/mesh/auth   # optional; auto-created
//       task: "..."               # optional; if set, passes -p (non-interactive)
//     - name: human
//       type: relay               # spawns human-relay.mjs instead of a pi agent
//     - name: analyst
//       recipe: deferred/mesh-node
//       task: "wait for requests"

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
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

function die(msg) {
  process.stderr.write(`launch-mesh: ${msg}\n`);
  process.exit(1);
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

// ── Runtime mode detection ────────────────────────────────────────────────────
// If the first arg is "--project" or "--feature", we're in Ralph-Loop runtime mode.
// Otherwise we expect a topology YAML file as the first arg.

const firstArg = process.argv[2];
const isRuntimeMode = firstArg === "--project" || firstArg === "--feature";

// ── Ralph-Loop runtime mode ───────────────────────────────────────────────────

if (isRuntimeMode) {
  // Parse runtime-mode args
  const args = process.argv.slice(2);
  let project = null;
  let feature = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) project = path.resolve(args[++i]);
    else if (args[i] === "--feature" && args[i + 1]) feature = args[++i];
  }

  if (!project) die("runtime mode requires --project <path>");
  if (!feature) die("runtime mode requires --feature <slug>");

  const meshBranch = `feature/${feature}`;

  // ── Guard 1: must be inside a worktree of <project> ──────────────────────
  //
  // We identify "inside a worktree" by checking whether process.cwd() is under
  // the project path AND is NOT the project root itself (worktrees are separate
  // directories). We use `git worktree list --porcelain` to enumerate all worktrees.
  const cwd = process.cwd();
  let worktrees;
  try {
    const listing = git(["worktree", "list", "--porcelain"], project);
    worktrees = listing.split(/\n\n+/).filter(Boolean).map((block) => {
      const m = /^worktree (.+)$/m.exec(block);
      return m ? path.resolve(m[1]) : null;
    }).filter(Boolean);
  } catch (e) {
    die(`failed to read worktree list from project at ${project}: ${e.message}`);
  }

  // The first entry is always the main checkout. We must be in a non-main worktree.
  const mainWorktree = worktrees[0];
  const nonMainWorktrees = worktrees.slice(1);

  const cwdResolved = path.resolve(cwd);
  // Check that cwd is or is under one of the non-main worktrees.
  const isInNonMainWorktree = nonMainWorktrees.some(
    (wt) => cwdResolved === wt || cwdResolved.startsWith(wt + path.sep),
  );

  if (!isInNonMainWorktree) {
    die(
      `launch-mesh runtime mode must be invoked from inside a worktree of ${project}.\n` +
      `  Current directory: ${cwd}\n` +
      `  Project main checkout: ${mainWorktree}\n` +
      `  Non-main worktrees: ${nonMainWorktrees.join(", ") || "(none)"}\n` +
      `  Create a worktree first with:\n` +
      `    git worktree add <project>/.mesh-features/${feature}/kanban ${meshBranch}`,
    );
  }

  // ── Guard 2: feature branch must exist ────────────────────────────────────
  let featureBranchExists = false;
  try {
    git(["rev-parse", "--verify", `refs/heads/${meshBranch}`], project);
    featureBranchExists = true;
  } catch {
    // branch doesn't exist
  }

  if (!featureBranchExists) {
    die(
      `feature branch '${meshBranch}' does not exist on project at ${project}.\n` +
      `  Create it first with: git checkout -b ${meshBranch} main`,
    );
  }

  // ── Guard 3: .scratch/<slug>/issues/ must exist and be non-empty ─────────
  // We check on the current worktree (which should be on meshBranch).
  const issuesDir = path.join(cwd, ".scratch", feature, "issues");
  let issueFiles;
  try {
    issueFiles = readdirSync(issuesDir).filter((f) => f.endsWith(".md"));
  } catch {
    issueFiles = [];
  }

  if (issueFiles.length === 0) {
    die(
      `no issue files found at ${issuesDir}.\n` +
      `  Ensure .scratch/${feature}/issues/*.md files exist on ${meshBranch} before starting the Kanban.\n` +
      `  Run the orchestrator first: npm run agent -- ralph/orchestrator-thin --feature ${feature}`,
    );
  }

  // ── Ensure / fast-forward kanban worktree ─────────────────────────────────
  const kanbanWorktreePath = path.join(project, ".mesh-features", feature, "kanban");
  const kanbanExists = existsSync(kanbanWorktreePath);

  if (!kanbanExists) {
    mkdirSync(path.dirname(kanbanWorktreePath), { recursive: true });
    try {
      git(["worktree", "add", kanbanWorktreePath, meshBranch], project);
      process.stderr.write(`launch-mesh: created kanban worktree at ${kanbanWorktreePath}\n`);
    } catch (e) {
      die(`failed to create kanban worktree at ${kanbanWorktreePath}: ${e.message}`);
    }
  } else {
    // Worktree exists — ensure it's on the mesh branch and up to date.
    try {
      const listing = git(["worktree", "list", "--porcelain"], project);
      const blocks = listing.split(/\n\n+/);
      for (const block of blocks) {
        const worktreeMatch = /^worktree (.+)$/m.exec(block);
        const branchMatch = /^branch refs\/heads\/(.+)$/m.exec(block);
        if (
          worktreeMatch &&
          path.resolve(worktreeMatch[1]) === path.resolve(kanbanWorktreePath)
        ) {
          if (branchMatch && branchMatch[1] !== meshBranch) {
            die(
              `kanban worktree at ${kanbanWorktreePath} is on branch '${branchMatch[1]}', ` +
              `expected '${meshBranch}'.`,
            );
          }
        }
      }
    } catch (e) {
      die(`failed to verify kanban worktree state: ${e.message}`);
    }
    process.stderr.write(`launch-mesh: using existing kanban worktree at ${kanbanWorktreePath}\n`);
  }

  // ── Spawn the Kanban from the kanban worktree ─────────────────────────────
  const busRoot = process.env.PI_AGENT_BUS_ROOT
    ? path.resolve(process.env.PI_AGENT_BUS_ROOT)
    : path.join(os.homedir(), ".pi-agent-bus", `kanban-${feature}`);

  process.stderr.write(`\nlaunch-mesh: starting Ralph-Loop Kanban\n`);
  process.stderr.write(`  feature:          ${feature}\n`);
  process.stderr.write(`  project:          ${project}\n`);
  process.stderr.write(`  meshBranch:       ${meshBranch}\n`);
  process.stderr.write(`  kanbanWorktree:   ${kanbanWorktreePath}\n`);
  process.stderr.write(`  busRoot:          ${busRoot}\n`);
  process.stderr.write(`  issues found:     ${issueFiles.length}\n\n`);

  const kanbanChild = spawn(
    process.execPath,
    [
      KANBAN,
      "--feature", feature,
      "--project", project,
      "--mesh-branch", meshBranch,
      "--bus-root", busRoot,
    ],
    {
      cwd: kanbanWorktreePath,
      stdio: "inherit",
      env: {
        ...process.env,
        PI_AGENT_BUS_ROOT: busRoot,
      },
    },
  );

  kanbanChild.on("exit", (code, signal) => {
    process.stderr.write(`launch-mesh: kanban exited (code=${code} signal=${signal})\n`);
    process.exit(code ?? 0);
  });

  process.once("SIGINT", () => {
    process.stderr.write("\nlaunch-mesh: SIGINT — stopping kanban\n");
    try { kanbanChild.kill("SIGTERM"); } catch { /* noop */ }
  });
  process.once("SIGTERM", () => {
    try { kanbanChild.kill("SIGTERM"); } catch { /* noop */ }
  });

  // The kanban process owns the lifetime — we don't fall through to topology mode.
  // (The process stays alive via the kanbanChild exit listener above.)
  process.exitCode = 0;
} else {

// ── Topology mode (existing behaviour, unchanged) ────────────────────────────

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

} // end topology mode else-block
