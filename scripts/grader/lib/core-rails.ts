import fs from "node:fs";
import type { ArtifactSet, DelegateUsage, SpawnInvocation } from "./artifact.ts";
import type { Rubric } from "./rubric.ts";

/**
 * Universal rails from pi-agent-builder/references/defaults.md. Every
 * pi extension that spawns a sub-agent must honor them — the assembler
 * pattern-specific checks stack on top.
 */

export function gradeRegistration(rubric: Rubric, art: ArtifactSet, cmdName: string | null): void {
  if (art.extensions.some((_f) => /pi\.registerCommand\s*\(\s*["']/.test(_read(_f)))) {
    rubric.p0("registerCommand in extension", "pass");
  } else {
    rubric.p0("registerCommand in extension", "fail");
  }
  if (cmdName) {
    rubric.say(`- registered slash command: \`/${cmdName}\``);
  } else {
    rubric.say(`- [warn] could not extract registered slash command name`);
  }
}

export function gradeRegisterToolShape(rubric: Rubric, art: ArtifactSet): void {
  const hasRegisterTool = art.all.some((f) => /registerTool\s*\(/.test(_read(f)));
  if (!hasRegisterTool) return; // profile has no tools — skip.
  const hasDetails = art.all.some((f) => /details/.test(_read(f)));
  rubric.p0("registerTool returns {content, details}", hasDetails ? "pass" : "fail");
}

export function gradeSubprocessRails(
  rubric: Rubric,
  art: ArtifactSet,
  spawns: SpawnInvocation[],
  delegateUsage?: DelegateUsage,
): void {
  rubric.say("## Subprocess rails");

  // Thin agents (single delegate() call, no inline spawn) delegate every
  // subprocess rail below to `pi-sandbox/.pi/lib/delegate.ts`. Report
  // them as pass-by-delegate instead of failing on missing string
  // literals that now live in the library file.
  const thinAgent =
    spawns.length === 0 && !!delegateUsage && delegateUsage.usesDelegate;
  if (thinAgent) {
    rubric.p0(
      "subprocess rails handled by delegate() runtime",
      "pass",
      "no inline spawn; rails enforced in ../lib/delegate.ts",
    );
    return;
  }

  const anySpawn = spawns.length > 0;
  const allNoExt = anySpawn && spawns.every((s) => s.noExtensions);
  rubric.p0("--no-extensions on every spawn", allNoExt ? "pass" : "fail", anySpawn ? undefined : "no spawn found");

  const anyMode = spawns.some((s) => s.mode);
  rubric.p0(
    "--mode json or rpc on spawn",
    anyMode ? "pass" : "fail",
    anyMode ? undefined : "no --mode flag detected",
  );

  const blob = art.extBlob;
  const hasOpenrouter = /openrouter/.test(blob);
  const hasEnvModel = /process\.env\./.test(blob);
  rubric.p0(
    "--provider openrouter + --model from env",
    hasOpenrouter && hasEnvModel ? "pass" : "fail",
  );

  const hasStdio = /stdio:\s*\[\s*"ignore"/.test(blob);
  rubric.p0('stdio: ["ignore", "pipe", "pipe"]', hasStdio ? "pass" : "fail");

  const hasSandboxRoot = /path\.resolve\(process\.cwd\(\)\)/.test(blob);
  const hasCwdPin = /cwd:\s*[a-zA-Z_]/.test(blob);
  rubric.p0(
    "sandboxRoot captured + cwd pinned on spawn",
    hasSandboxRoot && hasCwdPin ? "pass" : "fail",
  );

  const hasTimeout = /setTimeout\(/.test(blob);
  const hasSigkill = /SIGKILL|\.kill\(/.test(blob);
  rubric.p0(
    "hard timeout + SIGKILL on child",
    hasTimeout && hasSigkill ? "pass" : "fail",
  );
}

export function gradeNdjsonParsing(
  rubric: Rubric,
  art: ArtifactSet,
  delegateUsage?: DelegateUsage,
): void {
  // delegate() owns the NDJSON split/parse loop; a thin agent body
  // never references the event-type strings or JSON.parse.
  if (delegateUsage?.usesDelegate) {
    const hasDelegateEvents =
      /tool_execution_start|message_end|message_update/.test(art.extBlob);
    const hasDelegateParse = /JSON\.parse\(/.test(art.extBlob);
    if (!hasDelegateEvents && !hasDelegateParse) {
      rubric.p0(
        "NDJSON parsing handled by delegate() runtime",
        "pass",
      );
      return;
    }
  }
  const hasEvents = /tool_execution_start|message_end|message_update/.test(art.extBlob);
  const hasParse = /JSON\.parse\(/.test(art.extBlob);
  rubric.p0(
    "NDJSON parsed line-by-line from child stdout",
    hasEvents && hasParse ? "pass" : "fail",
  );
}

export function gradePathValidation(
  rubric: Rubric,
  art: ArtifactSet,
  delegateUsage?: DelegateUsage,
): void {
  // Path validation + sandbox-root escape check are both inside
  // stage-write.parentSide.finalize + delegate's promote helper.
  if (
    delegateUsage?.usesDelegate &&
    delegateUsage.delegateHandles.has("stage-write")
  ) {
    rubric.p0(
      "path validation handled by delegate() + stage-write finalize",
      "pass",
    );
    rubric.p0(
      "sandbox-root escape check handled by delegate() + stage-write finalize",
      "pass",
    );
    return;
  }
  const blob = art.extBlob;
  const hasIsAbsolute = /path\.isAbsolute|isAbsolute\(/.test(blob);
  const hasExists = /fs\.existsSync/.test(blob);
  const hasDotDot = /"\.\."|'\.\.'/.test(blob);
  rubric.p0(
    "path validation (absolute / .. / exists)",
    hasIsAbsolute && hasExists && hasDotDot ? "pass" : "fail",
  );
  const hasStartsWith = /startsWith\(sandboxRoot|startsWith\([a-zA-Z_]+ \+ path\.sep\)/.test(blob);
  rubric.p0("sandbox-root escape check (startsWith)", hasStartsWith ? "pass" : "fail");
}

export function gradeNegativeAnchors(rubric: Rubric, art: ArtifactSet): void {
  rubric.say("## Negative anchors");
  if (/console\.log/.test(art.allBlob)) {
    rubric.say("- [!] console.log present (anti-pattern)");
    rubric.addNote("warn: console.log present (TUI anti-pattern)");
  }
}

function _read(p: string): string {
  return fs.readFileSync(p, "utf8");
}
