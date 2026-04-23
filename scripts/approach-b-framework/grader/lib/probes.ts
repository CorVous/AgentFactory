import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactSet } from "./artifact.ts";
import type { Rubric } from "./rubric.ts";

export interface ProbeContext {
  repoRoot: string;
  logDir: string;
  cmdName: string | null;
  taskModel: string;
  probeArgs: string;
  evidenceAnchor?: string;
}

/**
 * Universal load probe: spawn pi with the extension and run /<cmd> with
 * no args under --no-tools. A registered command short-circuits to the
 * handler; an unregistered one goes to the LLM. Count events to tell.
 */
export function runLoadProbe(rubric: Rubric, ctx: ProbeContext, art: ArtifactSet): void {
  rubric.say("## Load smoke");
  if (process.env.SKIP_LOAD === "1") {
    rubric.loadStatus = "skip";
    rubric.loadNote = "SKIP_LOAD=1";
    rubric.say("- [-] skipped (SKIP_LOAD=1)");
    return;
  }
  if (art.extensions.length === 0) {
    rubric.loadStatus = "skip";
    rubric.say("- [ ] skipped (no extension file)");
    return;
  }
  if (!ctx.cmdName) {
    rubric.loadStatus = "fail";
    rubric.loadNote = "could not extract registered command name from extension";
    rubric.say("- [ ] skipped (no CMD_NAME found in extension)");
    return;
  }

  const extFile = art.extensions[0];
  const piBin = path.join(ctx.repoRoot, "node_modules/.bin/pi");
  const ndjsonPath = path.join(ctx.logDir, "load.ndjson");
  const stderrPath = path.join(ctx.logDir, "load.stderr");

  const result = spawnSync(
    piBin,
    [
      "--no-context-files",
      "--no-session",
      "--no-skills",
      "--no-extensions",
      "-e",
      extFile,
      "--mode",
      "json",
      "--no-tools",
      "--provider",
      "openrouter",
      "--model",
      ctx.taskModel,
      "-p",
      `/${ctx.cmdName}`,
    ],
    {
      env: {
        ...process.env,
        PI_SKIP_UPDATE_CHECK: "1",
        TASK_MODEL: ctx.taskModel,
        PATH: `${path.join(ctx.repoRoot, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
      },
      timeout: 30_000,
      encoding: "utf8",
    },
  );

  fs.writeFileSync(ndjsonPath, result.stdout ?? "");
  fs.writeFileSync(stderrPath, result.stderr ?? "");

  const eventLines = (result.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  const eventCount = eventLines.length;
  const sawAgentStart = eventLines.filter((l) => l.includes('"type":"agent_start"')).length;
  const exit = result.status ?? -1;

  if (exit === 0 && sawAgentStart === 0 && eventCount >= 1 && eventCount <= 3) {
    rubric.loadStatus = "pass";
    rubric.say(`- [x] command /${ctx.cmdName} registered (no LLM call)`);
  } else if (exit !== 0 && sawAgentStart === 0 && eventCount >= 1 && eventCount <= 3) {
    rubric.loadStatus = "partial";
    rubric.loadNote = `command registered but handler didn't short-circuit on empty args (exit ${exit})`;
    rubric.say(
      `- [~] command /${ctx.cmdName} registered, but handler ran heavy work on empty args (exit ${exit})`,
    );
  } else if (eventCount === 0) {
    rubric.loadStatus = "fail";
    const tail = (result.stderr ?? "").replace(/\n/g, " ").slice(-200);
    rubric.loadNote = `extension failed to load: ${tail}`;
    rubric.say(`- [ ] extension failed to load — 0 events emitted`);
    if (tail) rubric.say(`      stderr: ${tail}`);
  } else if (exit === 0 && sawAgentStart >= 1) {
    rubric.loadStatus = "fail";
    rubric.loadNote = `extension loaded but /${ctx.cmdName} was not registered (went to LLM)`;
    rubric.say(`- [ ] command /${ctx.cmdName} not registered — went to LLM`);
  } else {
    rubric.loadStatus = "partial";
    rubric.loadNote = `ambiguous — events=${eventCount} agent_start=${sawAgentStart} exit=${exit}`;
    rubric.say(`- [~] ambiguous (events=${eventCount} agent_start=${sawAgentStart} exit=${exit})`);
  }
}

/**
 * Behavioral probe: run /<cmd> <args> in the run's cwd (where
 * .pi/extensions/<cmd>.ts was already placed). Recon variants check for
 * an evidence file under .pi/scratch/; writer variants just verify the
 * handler exits cleanly (cancel path in print mode).
 */
export type BehavioralMode = "writer" | "recon";

export function runBehavioralProbe(
  rubric: Rubric,
  ctx: ProbeContext,
  mode: BehavioralMode,
): void {
  rubric.say("## Behavioral smoke");
  if (process.env.SKIP_BEH === "1") {
    rubric.behavioralStatus = "skip";
    rubric.behavioralNote = "SKIP_BEH=1";
    rubric.say("- [-] skipped (SKIP_BEH=1)");
    return;
  }
  if (rubric.loadStatus !== "pass" && rubric.loadStatus !== "partial") {
    rubric.say("- [ ] skipped (load failed)");
    return;
  }
  if (!ctx.cmdName) {
    rubric.say("- [ ] skipped (no CMD_NAME)");
    return;
  }

  const piBin = path.join(ctx.repoRoot, "node_modules/.bin/pi");
  const startMarker = path.join(ctx.logDir, ".beh-start");
  fs.writeFileSync(startMarker, "");

  const ndjsonPath = path.join(ctx.logDir, "behavior.ndjson");
  const stderrPath = path.join(ctx.logDir, "behavior.stderr");

  const result = spawnSync(
    piBin,
    [
      "--no-context-files",
      "--no-session",
      "--no-skills",
      "--provider",
      "openrouter",
      "--model",
      ctx.taskModel,
      "--mode",
      "json",
      "-p",
      `/${ctx.cmdName}${ctx.probeArgs}`,
    ],
    {
      cwd: ctx.logDir,
      env: {
        ...process.env,
        PI_SKIP_UPDATE_CHECK: "1",
        PATH: `${path.join(ctx.repoRoot, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
      },
      timeout: 180_000,
      encoding: "utf8",
    },
  );

  fs.writeFileSync(ndjsonPath, result.stdout ?? "");
  fs.writeFileSync(stderrPath, result.stderr ?? "");

  const exit = result.status ?? -1;
  const eventLines = (result.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  const sawAgentStart = eventLines.filter((l) => l.includes('"type":"agent_start"')).length;
  const timedOut = result.signal === "SIGTERM" || exit === 124;

  // Clean up any stray file the handler may have dropped in the cwd if it
  // didn't honor the cancel path. Defensive; expected not to exist.
  try {
    fs.rmSync(path.join(ctx.logDir, "hello-probe.md"), { force: true });
  } catch {
    // ignore
  }

  if (mode === "recon") {
    applyReconBehavioral(rubric, ctx, startMarker, exit, sawAgentStart, timedOut, result.stderr ?? "");
  } else {
    applyWriterBehavioral(rubric, exit, sawAgentStart, eventLines.length, timedOut, result.stderr ?? "");
  }
}

function applyWriterBehavioral(
  rubric: Rubric,
  exit: number,
  sawAgentStart: number,
  eventCount: number,
  timedOut: boolean,
  stderr: string,
): void {
  if (timedOut) {
    rubric.behavioralStatus = "fail";
    rubric.behavioralNote = "timed out after 180s (hang)";
    rubric.say("- [ ] timed out — hang");
    return;
  }
  if (exit === 0 && sawAgentStart === 0 && eventCount <= 3) {
    rubric.behavioralStatus = "pass";
    rubric.say("- [x] exit 0; handler ran, dispatched + cancelled cleanly");
  } else if (exit === 0 && sawAgentStart >= 1) {
    rubric.behavioralStatus = "fail";
    rubric.behavioralNote = "command not registered — /cmd went to LLM instead of handler";
    rubric.say("- [ ] command not registered (went to LLM)");
  } else if (exit !== 0) {
    rubric.behavioralStatus = "fail";
    const tail = stderr.replace(/\n/g, " ").slice(-200);
    rubric.behavioralNote = `exit ${exit}: ${tail}`;
    rubric.say(`- [ ] exit ${exit} (see behavior.stderr)`);
    if (tail) rubric.say(`      stderr: ${tail}`);
  } else {
    rubric.behavioralStatus = "partial";
    rubric.behavioralNote = `ambiguous — events=${eventCount} agent_start=${sawAgentStart}`;
    rubric.say(`- [~] ambiguous (events=${eventCount} agent_start=${sawAgentStart})`);
  }
}

function applyReconBehavioral(
  rubric: Rubric,
  ctx: ProbeContext,
  startMarker: string,
  exit: number,
  sawAgentStart: number,
  timedOut: boolean,
  stderr: string,
): void {
  const anchor = ctx.evidenceAnchor ?? "SKILL.md";
  const scratchHit = findAnchorFile(path.join(ctx.logDir, ".pi/scratch"), startMarker, anchor);
  const strayHit = findAnchorFile(
    ctx.logDir,
    startMarker,
    anchor,
    [path.join(ctx.logDir, ".pi/scratch"), path.join(ctx.logDir, ".pi/extensions"), path.join(ctx.logDir, ".pi/child-tools"), path.join(ctx.logDir, "artifacts")],
  );

  if (timedOut) {
    rubric.behavioralStatus = "fail";
    rubric.behavioralNote = "timed out after 180s (hang)";
    rubric.say("- [ ] timed out — hang");
  } else if (exit !== 0) {
    rubric.behavioralStatus = "fail";
    const tail = stderr.replace(/\n/g, " ").slice(-200);
    rubric.behavioralNote = `exit ${exit}: ${tail}`;
    rubric.say(`- [ ] exit ${exit} (see behavior.stderr)`);
    if (tail) rubric.say(`      stderr: ${tail}`);
  } else if (sawAgentStart >= 1) {
    rubric.behavioralStatus = "fail";
    rubric.behavioralNote = "command not registered — /cmd went to LLM instead of handler";
    rubric.say("- [ ] command not registered (went to LLM)");
  } else if (strayHit && !scratchHit) {
    rubric.behavioralStatus = "fail";
    rubric.behavioralNote = `summary landed outside .pi/scratch/: ${path.relative(ctx.logDir, strayHit)}`;
    rubric.say(`- [ ] summary written outside scratch dir: ${path.relative(ctx.logDir, strayHit)}`);
  } else if (scratchHit) {
    rubric.behavioralStatus = "pass";
    rubric.say(
      `- [x] exit 0; summary with '${anchor}' landed under .pi/scratch/: ${path.relative(ctx.logDir, scratchHit)}`,
    );
  } else {
    rubric.behavioralStatus = "partial";
    rubric.behavioralNote = `exit 0 but no scratch file containing '${anchor}' — may have notified only (invisible in print mode)`;
    rubric.say(`- [~] exit 0; no scratch evidence of summary (notify is no-op in print mode)`);
  }
}

function findAnchorFile(
  root: string,
  newerThan: string,
  anchor: string,
  excludePaths: string[] = [],
): string | null {
  if (!fs.existsSync(root)) return null;
  const markerMtime = safeMtime(newerThan);
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (excludePaths.some((p) => full === p || full.startsWith(p + path.sep))) continue;
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      const st = safeMtime(full);
      if (st <= markerMtime) continue;
      try {
        const content = fs.readFileSync(full, "utf8");
        if (content.includes(anchor)) return full;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function safeMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
