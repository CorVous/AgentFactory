/**
 * Shared helper for running whitelisted git/npm commands inside a per-issue
 * worktree. Uses `execFile` (argument array — never shell string) so there
 * is no shell injection surface.
 *
 * Non-zero exit codes are returned as results, not thrown, so callers can
 * surface the full stdout/stderr to the model.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `cmd` with `args` in `cwd`. Returns stdout, stderr, and exitCode.
 * Never throws on non-zero exit — callers decide how to interpret failures.
 *
 * @param cmd   The executable to run (e.g. "git", "npm").
 * @param args  Argument array — never a shell string.
 * @param cwd   Absolute path to the working directory (per-issue worktree).
 */
export async function execInWorktree(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      encoding: "utf8",
      // Give long-running commands (npm test) a generous timeout (5 min)
      timeout: 5 * 60 * 1000,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 };
  } catch (err: unknown) {
    // execFile rejects with an error that carries stdout, stderr, and code
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}
