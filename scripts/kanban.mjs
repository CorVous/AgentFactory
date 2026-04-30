#!/usr/bin/env node
// kanban.mjs — Non-LLM Kanban control-plane for the Ralph-Loop mesh.
//
// Binds a bus socket as a named peer, polls the issue tree, and dispatches
// Foremen for each ready issue. Max-concurrency is V1 hardcoded (flag wired in #06).
//
// Usage:
//   node scripts/kanban.mjs \
//     --feature <slug> \
//     --project <path> \
//     --mesh-branch feature/<slug> \
//     [--max-concurrent-foremen N]   # defaults to 2; #06 wires the flag
//
// Architecture: ADR-0001, ADR-0005
// References: PRD §"Kanban (control plane)", issue #03

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanIssueTree } from "./kanban-scan.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "run-agent.mjs");

const V1_MAX_CONCURRENT = 2; // hardcoded for V1; #06 wires the --max-concurrent-foremen flag
const POLL_INTERVAL_MS = 5_000; // V1 polling tick; #05 replaces with issue-watcher

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let feature = null;
  let project = null;
  let meshBranch = null;
  let maxConcurrent = V1_MAX_CONCURRENT;
  let busRoot = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--feature" && args[i + 1]) feature = args[++i];
    else if (a === "--project" && args[i + 1]) project = path.resolve(args[++i]);
    else if (a === "--mesh-branch" && args[i + 1]) meshBranch = args[++i];
    else if (a === "--max-concurrent-foremen" && args[i + 1]) maxConcurrent = parseInt(args[++i], 10);
    else if (a === "--bus-root" && args[i + 1]) busRoot = path.resolve(args[++i]);
  }

  if (!feature) die("--feature <slug> is required");
  if (!project) die("--project <path> is required");
  if (!meshBranch) meshBranch = `feature/${feature}`;

  if (!busRoot) {
    busRoot = process.env.PI_AGENT_BUS_ROOT
      ? path.resolve(process.env.PI_AGENT_BUS_ROOT)
      : path.join(os.homedir(), ".pi-agent-bus", `kanban-${feature}`);
  }

  return { feature, project, meshBranch, maxConcurrent, busRoot };
}

function die(msg) {
  process.stderr.write(`kanban: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Issue-file parsing
// ---------------------------------------------------------------------------
// scanIssueTree is imported from ./kanban-scan.mjs.  It reads from
// <scanRoot>/.scratch/<feature>/issues/ where scanRoot = process.cwd().
// The launcher spawns the Kanban with cwd: kanbanWorktreePath (the git
// worktree checked out on feature/<slug>), so the issues are visible there.

// ---------------------------------------------------------------------------
// Spawn decision (delegates to _lib/kanban-spawn-decision)
// ---------------------------------------------------------------------------

// Import the spawn-decision pure function via a dynamic require-like approach.
// Since this is ESM we use a file:// URL import.
let decideSpawns;
try {
  // The _lib module is TypeScript — we use tsx or jiti to run it.
  // For production use, the compiled JS would be preferred. For now, we
  // implement the decision inline to avoid a build step dependency.
  // #TODO: When a build step is added, import from the compiled output.
  decideSpawns = inlineDecideSpawns;
} catch {
  decideSpawns = inlineDecideSpawns;
}

/**
 * Inline spawn-decision implementation (mirrors _lib/kanban-spawn-decision.ts).
 * This avoids a TypeScript build step at runtime. The TypeScript source is the
 * canonical implementation and is tested; this inline copy is kept in sync manually.
 */
function inlineDecideSpawns(issueTreeState, currentForemen, maxConcurrent) {
  const WORKABLE = new Set(["ready-for-agent", "ready-for-human"]);
  const runningPaths = new Set(currentForemen.map((f) => f.issuePath));
  const decisions = [];
  const remaining = maxConcurrent - currentForemen.length;

  for (const issue of issueTreeState) {
    if (decisions.length >= remaining) break;
    if (!WORKABLE.has(issue.status)) continue;
    if (issue.claimedBy !== undefined && issue.claimedBy !== "") continue;
    if (runningPaths.has(issue.path)) continue;

    decisions.push({
      issuePath: issue.path,
      mode: issue.status === "ready-for-human" ? "branch-emit" : "auto-merge",
    });
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Bus socket (minimal server — Kanban listens but primarily polls)
// ---------------------------------------------------------------------------

function probeSocketLive(p, timeoutMs = 200) {
  return new Promise((resolve) => {
    const sock = net.connect(p);
    const done = (live) => { sock.removeAllListeners(); sock.destroy(); resolve(live); };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => { clearTimeout(t); done(true); });
    sock.once("error", () => { clearTimeout(t); done(false); });
  });
}

async function bindBusSocket(sockPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });

    const server = net.createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            const env = JSON.parse(line);
            if (env.v !== 2) continue;
            if (env.payload?.kind === "message") {
              process.stderr.write(`kanban: [from ${env.from}] ${env.payload.text}\n`);
            }
          } catch { /* ignore malformed */ }
        }
      });
      conn.on("error", () => conn.destroy());
    });

    const tryListen = () => new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(sockPath, () => { server.removeAllListeners("error"); res(); });
    });

    tryListen()
      .catch(async (e) => {
        if (e.code !== "EADDRINUSE") throw e;
        const live = await probeSocketLive(sockPath);
        if (live) throw new Error(`kanban bus socket already held by a live peer at ${sockPath}`);
        fs.unlinkSync(sockPath);
        return tryListen();
      })
      .then(() => resolve(server))
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Foreman spawning
// ---------------------------------------------------------------------------

/**
 * Build the argv array for spawning a Foreman via run-agent.mjs.
 *
 * Extracted as a pure function so it can be unit-tested without spawning a
 * real process.  The Foreman is always run in pi print mode (-p) with a seed
 * task: without a -p flag pi exits silently in <1 s when there is no TTY,
 * causing the Kanban to re-dispatch the same issue every 5 s indefinitely.
 *
 * @param {string} relPath   - issue path relative to .scratch/ (e.g. "v1-fixture/01-add-function.md")
 * @param {string} meshBranch - e.g. "feature/v1-fixture"
 * @param {string} project    - absolute path to the project root (used as sandbox)
 * @param {string} busRoot    - absolute path to the bus socket directory
 * @param {string} kanbanWorktree - absolute cwd of the kanban worktree (process.cwd())
 * @returns {string[]} argv suitable for spawn(process.execPath, argv, {...})
 */
export function buildForemanArgv(relPath, meshBranch, project, busRoot, kanbanWorktree) {
  // The initial user message that kicks off the Foreman workflow in print mode.
  // The recipe's prompt already contains the full AFK Ralph Loop instructions;
  // this message provides the concrete issue context so the model starts working.
  const initialPrompt =
    `Run the AFK Ralph Loop on the issue at ${relPath}. ` +
    `Use pi.getFlag('issue') and pi.getFlag('mesh-branch') from the foreman-flags extension for context.`;

  return [
    RUNNER,
    "ralph/foreman",
    "--sandbox", project,
    "--agent-bus", busRoot,
    "--",
    "--issue", relPath,
    "--mesh-branch", meshBranch,
    "-p", initialPrompt,
  ];
}

/**
 * Spawn a Foreman process for the given issue.
 * Returns the child process and the issue path it is handling.
 */
function spawnForeman(issuePath, meshBranch, project, busRoot) {
  // Compute the relative path for --issue flag: strip the .scratch/ prefix.
  // The issue path is absolute (from the kanban worktree checkout); --issue
  // expects <feature-slug>/<NN>-<slug> relative to .scratch/.
  // Try the kanban worktree's .scratch/ first (correct path after the fix),
  // then fall back to the project root's .scratch/ (belt-and-suspenders).
  const kanbanScratchBase = path.join(process.cwd(), ".scratch") + path.sep;
  const projectScratchBase = path.join(project, ".scratch") + path.sep;
  let relPath = issuePath;
  if (issuePath.startsWith(kanbanScratchBase)) {
    relPath = issuePath.slice(kanbanScratchBase.length);
  } else if (issuePath.startsWith(projectScratchBase)) {
    relPath = issuePath.slice(projectScratchBase.length);
  }

  const args = buildForemanArgv(relPath, meshBranch, project, busRoot, process.cwd());

  process.stderr.write(`kanban: dispatching Foreman for ${relPath} (branch: ${meshBranch})\n`);

  const child = spawn(process.execPath, args, {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_AGENT_BUS_ROOT: busRoot,
    },
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) process.stderr.write(`kanban [foreman ${relPath}]: ${line}\n`);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) process.stderr.write(`kanban [foreman ${relPath} err]: ${line}\n`);
    }
  });

  return child;
}

// ---------------------------------------------------------------------------
// Main loop — only executes when the file is run directly (not imported)
// ---------------------------------------------------------------------------
// Guard: when kanban.mjs is imported by tests (to access buildForemanArgv)
// the top-level code below must not run — it binds sockets and calls
// process.exit on failure.  `isMain` is true only when node executes this
// file as the entry point (process.argv[1] resolves to this file).
// ---------------------------------------------------------------------------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const { feature, project, meshBranch, maxConcurrent, busRoot } = parseArgs();
  const sockPath = path.join(busRoot, "kanban.sock");

  let server;
  try {
    server = await bindBusSocket(sockPath);
  } catch (e) {
    die(e.message);
  }

  process.stderr.write(`kanban: joined bus as "kanban" at ${sockPath}\n`);
  process.stderr.write(`kanban: feature=${feature} project=${project} meshBranch=${meshBranch} maxConcurrent=${maxConcurrent}\n`);
  process.stderr.write(`kanban: polling every ${POLL_INTERVAL_MS}ms (V1 polling; #05 wires issue-watcher)\n`);

  /** Map from issuePath → child process */
  const runningForemen = new Map();

  function pruneExited() {
    for (const [issuePath, child] of runningForemen) {
      if (child.exitCode !== null || child.killed) {
        const code = child.exitCode;
        process.stderr.write(`kanban: Foreman for ${issuePath} exited (code=${code})\n`);
        runningForemen.delete(issuePath);
      }
    }
  }

  function tick() {
    pruneExited();

    const currentForemen = [...runningForemen.keys()].map((p) => ({ issuePath: p }));
    // Scan from process.cwd() — the launcher spawns the Kanban with
    // cwd: kanbanWorktreePath, where the feature branch is checked out.
    const issueTree = scanIssueTree(feature, process.cwd());

    if (issueTree.length === 0) {
      // Issues directory missing or empty — idle silently
      return;
    }

    const decisions = decideSpawns(issueTree, currentForemen, maxConcurrent);

    for (const { issuePath } of decisions) {
      const child = spawnForeman(issuePath, meshBranch, project, busRoot);
      runningForemen.set(issuePath, child);

      child.once("exit", (code, signal) => {
        process.stderr.write(
          `kanban: Foreman for ${path.basename(issuePath)} exited (code=${code ?? "null"} signal=${signal ?? "null"})\n`,
        );
        runningForemen.delete(issuePath);
      });
    }

    if (decisions.length === 0 && currentForemen.length === 0) {
      process.stderr.write(`kanban: no ready issues — idling\n`);
    }
  }

  // Initial tick immediately, then on timer
  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  function cleanup() {
    clearInterval(timer);
    try { server?.close(); } catch { /* noop */ }
    try { fs.unlinkSync(sockPath); } catch { /* noop */ }
    for (const [issuePath, child] of runningForemen) {
      if (child.exitCode === null && !child.killed) {
        process.stderr.write(`kanban: sending SIGTERM to Foreman for ${issuePath}\n`);
        try { child.kill("SIGTERM"); } catch { /* noop */ }
      }
    }
  }

  process.once("SIGINT", () => { process.stderr.write("\nkanban: SIGINT received — shutting down\n"); cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
  process.once("exit", cleanup);
}
