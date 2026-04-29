#!/usr/bin/env node
// kanban.mjs — non-LLM long-lived Kanban control plane peer.
//
// Binds a bus socket using the same protocol as human-relay.mjs (Unix-socket
// newline-delimited JSON envelopes, v2 wire format).
//
// On each polling tick (default: 2s), scans .scratch/<feature-slug>/issues/*.md
// for ready-for-agent issues and spawns Foremen via scripts/run-agent.mjs.
//
// V1 simplifications (deferred):
//   - maxConcurrent is hardcoded to 1 (#06 wires the flag).
//   - issue-watcher events replace polling (#05).
//   - Blocked issues (Depends-on:) are not filtered (#07).
//
// Usage (spawned by launch-mesh.mjs runtime mode):
//   node scripts/kanban.mjs \
//     --name kanban \
//     --bus-root <dir> \
//     --project <project-path> \
//     --feature <feature-slug> \
//     --kanban-worktree <kanban-worktree-path>
//
// References: ADR-0005, issue #03 (happy path).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(REPO_ROOT, "scripts", "run-agent.mjs");
const FOREMAN_RECIPE = "ralph/foreman";

const MAX_CONCURRENT = 1; // V1 hardcoded; #06 wires the flag.
const POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);
  let name = "kanban";
  let busRoot = null;
  let projectPath = null;
  let featureSlug = null;
  let kanbanWorktree = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name" && argv[i + 1]) name = argv[++i];
    else if (a === "--bus-root" && argv[i + 1]) busRoot = path.resolve(argv[++i]);
    else if (a === "--project" && argv[i + 1]) projectPath = path.resolve(argv[++i]);
    else if (a === "--feature" && argv[i + 1]) featureSlug = argv[++i];
    else if (a === "--kanban-worktree" && argv[i + 1]) kanbanWorktree = path.resolve(argv[++i]);
  }

  if (!busRoot) {
    busRoot = process.env.PI_AGENT_BUS_ROOT
      ? path.resolve(process.env.PI_AGENT_BUS_ROOT)
      : path.join(os.homedir(), ".pi-agent-bus", "default");
  }

  return { name, busRoot, projectPath, featureSlug, kanbanWorktree };
}

const { name, busRoot, projectPath, featureSlug, kanbanWorktree } = parseArgs();

if (!projectPath) {
  process.stderr.write("kanban: --project <path> is required\n");
  process.exit(1);
}
if (!featureSlug) {
  process.stderr.write("kanban: --feature <slug> is required\n");
  process.exit(1);
}
if (!kanbanWorktree) {
  process.stderr.write("kanban: --kanban-worktree <path> is required\n");
  process.exit(1);
}

const sockPath = path.join(busRoot, `${name}.sock`);
const issuesDir = path.join(kanbanWorktree, ".scratch", featureSlug, "issues");

// ---------------------------------------------------------------------------
// Bus server (incoming messages — idles; Kanban is send-only in V1)
// ---------------------------------------------------------------------------

fs.mkdirSync(busRoot, { recursive: true });

function probeSocketLive(p, timeoutMs = 200) {
  return new Promise((resolve) => {
    const sock = net.connect(p);
    const done = (live) => { sock.removeAllListeners(); sock.destroy(); resolve(live); };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => { clearTimeout(t); done(true); });
    sock.once("error", () => { clearTimeout(t); done(false); });
  });
}

async function bindServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      // V1: Kanban only receives (does not act on) bus messages; wake-up
      // envelopes from issue-watcher will trigger rescan (#05).
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
            if (env.v === 2 && env.payload?.kind === "message") {
              log(`bus message from ${env.from}: ${env.payload.text}`);
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
        if (live) throw new Error(`name "${name}" already held by a live peer`);
        fs.unlinkSync(sockPath);
        return tryListen();
      })
      .then(() => resolve(server))
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`[kanban] ${new Date().toISOString()} ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Issue scanning — pure wrapper around the spawn-decision pure function.
// We import directly from the compiled output via the TypeScript source
// (run-agent supports .ts via jiti; kanban.mjs runs under Node and
// cannot import .ts natively, so we replicate the minimal parsing here).
//
// Design note: the pure-function core (spawnDecisions) lives in
// _lib/spawn-decision.ts; kanban.mjs replicates only the I/O wrapper
// (scanIssueDir + parsePreamble) so tests can cover the pure function
// independently. The Kanban shell is kept thin per the PRD test plan.
// ---------------------------------------------------------------------------

/**
 * Parse the preamble block of an issue file.
 * Duplicates _lib/spawn-decision.ts::parsePreamble (TS → mjs boundary).
 */
function parsePreamble(content) {
  let status = "";
  let claimedBy;
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) break;
    const sm = line.match(/^Status:\s*(.+)$/);
    if (sm) { status = sm[1].trim(); continue; }
    const cm = line.match(/^Claimed-by:\s*(.+)$/);
    if (cm) { claimedBy = cm[1].trim(); continue; }
  }
  return { status, claimedBy };
}

/**
 * Scan .scratch/<slug>/issues/*.md and return IssueSummary objects.
 * Does NOT descend into issues/closed/.
 */
function scanIssueDir() {
  const issues = [];
  let entries;
  try {
    entries = fs.readdirSync(issuesDir);
  } catch {
    return issues; // issuesDir not present yet — idle
  }
  for (const f of entries) {
    if (!f.endsWith(".md")) continue;
    const filePath = path.join(issuesDir, f);
    let content;
    try { content = fs.readFileSync(filePath, "utf8"); } catch { continue; }
    const { status, claimedBy } = parsePreamble(content);
    issues.push({ filePath, status, claimedBy });
  }
  return issues;
}

/**
 * Pure spawn-decision logic (mirrors _lib/spawn-decision.ts::spawnDecisions).
 * Returns array of { issuePath } for each issue that needs a Foreman.
 */
function computeSpawnDecisions(issues, runningForemen, maxConcurrent) {
  const decisions = [];
  for (const issue of issues) {
    if (runningForemen.size + decisions.length >= maxConcurrent) break;
    if (issue.status !== "ready-for-agent") continue;
    if (issue.claimedBy !== undefined) continue;
    if (runningForemen.has(issue.filePath)) continue;
    decisions.push({ issuePath: issue.filePath });
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Foreman spawning
// ---------------------------------------------------------------------------

/** Maps issue filePath → child process */
const runningForemen = new Map();

function spawnForeman(issuePath) {
  // Derive the shorthand: <feature-slug>/<NN>-<slug>
  // issuePath is absolute: <kanbanWorktree>/.scratch/<slug>/issues/<NN>-<slug>.md
  const basename = path.basename(issuePath, ".md");
  const issueFlag = `${featureSlug}/${basename}`;
  const meshBranch = `feature/${featureSlug}`;

  log(`dispatching Foreman for ${issueFlag}`);

  const args = [
    RUNNER,
    FOREMAN_RECIPE,
    "--agent-bus", busRoot,
    "--issue", issueFlag,
    "--mesh-branch", meshBranch,
    "--project-path", projectPath,
    "--kanban-worktree", kanbanWorktree,
  ];

  const child = spawn(process.execPath, args, {
    cwd: kanbanWorktree,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_AGENT_BUS_ROOT: busRoot },
  });

  runningForemen.set(issuePath, child);

  let stdoutBuf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.trim()) process.stdout.write(`[foreman:${basename}] ${line}\n`);
    }
  });

  let stderrBuf = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderrBuf += chunk;
    let nl;
    while ((nl = stderrBuf.indexOf("\n")) !== -1) {
      process.stderr.write(`[foreman:${basename}] ${stderrBuf.slice(0, nl)}\n`);
      stderrBuf = stderrBuf.slice(nl + 1);
    }
  });

  child.on("exit", (code, signal) => {
    log(`Foreman for ${issueFlag} exited (code=${code} signal=${signal})`);
    runningForemen.delete(issuePath);
  });
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

function poll() {
  const issues = scanIssueDir();
  const running = new Set(runningForemen.keys());
  const decisions = computeSpawnDecisions(issues, running, MAX_CONCURRENT);
  for (const { issuePath } of decisions) {
    spawnForeman(issuePath);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let server;
try {
  server = await bindServer();
} catch (e) {
  process.stderr.write(`kanban: failed to bind bus socket: ${e.message}\n`);
  process.exit(1);
}

log(`started on bus as "${name}" (${sockPath})`);
log(`project=${projectPath} feature=${featureSlug}`);
log(`issuesDir=${issuesDir}`);
log(`maxConcurrent=${MAX_CONCURRENT} pollInterval=${POLL_INTERVAL_MS}ms`);

// Initial poll then start the polling interval
poll();
const pollInterval = setInterval(poll, POLL_INTERVAL_MS);

function cleanup() {
  clearInterval(pollInterval);
  try { server?.close(); } catch { /* noop */ }
  try { fs.unlinkSync(sockPath); } catch { /* noop */ }
}

process.once("SIGINT", () => { cleanup(); process.exit(0); });
process.once("SIGTERM", () => { cleanup(); process.exit(0); });
process.once("exit", cleanup);
