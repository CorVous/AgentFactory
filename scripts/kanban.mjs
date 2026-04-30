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

/**
 * Parse metadata from an issue file (Status:, Claimed-by:, Depends-on: lines).
 */
function parseIssueFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const statusMatch = /^Status:\s*(.+)$/m.exec(content);
  const claimedMatch = /^Claimed-by:\s*(.+)$/m.exec(content);
  const dependsOnMatches = [...content.matchAll(/^Depends-on:\s*(.+)$/mg)];
  return {
    path: filePath,
    status: statusMatch ? statusMatch[1].trim() : "",
    claimedBy: claimedMatch ? claimedMatch[1].trim() : undefined,
    dependsOn: dependsOnMatches.map((m) => m[1].trim()),
  };
}

/**
 * Scan the issue directory for open (non-closed) issue files.
 * Returns parsed metadata for each valid issue file.
 */
function scanIssueTree(feature, project) {
  const issuesDir = path.join(project, ".scratch", feature, "issues");
  let entries;
  try {
    entries = fs.readdirSync(issuesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const issues = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const filePath = path.join(issuesDir, e.name);
    const meta = parseIssueFile(filePath);
    if (meta) issues.push(meta);
  }
  return issues;
}

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
 * Spawn a Foreman process for the given issue.
 * Returns the child process and the issue path it is handling.
 */
function spawnForeman(issuePath, meshBranch, project, busRoot) {
  // Compute the relative path for --issue flag: strip the project prefix.
  // The issue path is absolute; --issue expects <feature-slug>/<NN>-<slug>
  // relative to .scratch/.
  const scratchBase = path.join(project, ".scratch") + path.sep;
  let relPath = issuePath;
  if (issuePath.startsWith(scratchBase)) {
    relPath = issuePath.slice(scratchBase.length);
  }

  const args = [
    RUNNER,
    "ralph/foreman",
    "--sandbox", project,
    "--agent-bus", busRoot,
    "--",
    "--issue", relPath,
    "--mesh-branch", meshBranch,
  ];

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
// Main loop
// ---------------------------------------------------------------------------

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
  const issueTree = scanIssueTree(feature, project);

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
