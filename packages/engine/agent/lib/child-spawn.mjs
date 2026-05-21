/**
 * child-spawn.mjs — pure argv builder for spawning pi --recipe children.
 *
 * Used by scripts/launch-mesh.mjs (mesh node spawn) and
 * pi-sandbox/.pi/extensions/atomic-delegate.ts (worker spawn).
 *
 * No I/O. Pure: given the spawn parameters, returns the argv array to pass
 * to `node <piBin> ...` (where piBin is resolved by resolvePiBin).
 *
 * Argv shape produced:
 *   --recipe <recipe>
 *   --sandbox <sandbox>
 *   --peer-bus <busRoot>
 *   --peer-name <instanceName>      (always)
 *   [--topology-overlay <json>]     (when topologyOverlay is set)
 *   [--task <text>]                 (when task is set and non-empty)
 *   [--inherit-pty]                 (when inheritPty is true)
 *   [--debug]                       (when debug is true)
 *   [-p <prompt>]                   (when printPrompt is set and non-empty)
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute path to the `pi` binary for spawning children.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @returns {string} Absolute path to node_modules/.bin/pi.
 */
export function resolvePiBin(repoRoot) {
  return path.join(repoRoot, "node_modules", ".bin", "pi");
}

/**
 * Resolve the repo root relative to this module's location.
 * engine lib lives at packages/engine/agent/lib/ → 4 levels up = repo root.
 *
 * @returns {string} Absolute path to the repo root.
 */
export function resolveRepoRoot() {
  return path.resolve(__dirname, "..", "..", "..", "..");
}

/**
 * Build the argv array for spawning a `pi --recipe` child process.
 *
 * @param {object} opts
 * @param {string} opts.piBin         - Absolute path to the pi binary.
 * @param {string} opts.recipe        - Recipe name (bare name, no .yaml suffix).
 * @param {string} opts.sandbox       - Absolute path to the sandbox/cwd for the child.
 * @param {string} opts.busRoot       - Absolute path to the peer bus root directory.
 * @param {string} opts.instanceName  - The child's instance name (passed as --peer-name).
 * @param {string|undefined} [opts.topologyOverlay] - JSON string for --topology-overlay.
 * @param {string|undefined} [opts.task]            - Task text for --task (appended to system prompt).
 * @param {boolean|undefined} [opts.inheritPty]     - Pass --inherit-pty bare flag.
 * @param {boolean|undefined} [opts.debug]          - Pass --debug bare flag.
 * @param {string|undefined} [opts.printPrompt]     - Pass -p <prompt> (print/non-interactive mode).
 * @returns {string[]} argv to pass after `node <piBin>`.
 */
export function buildRecipeChildArgv(opts) {
  const {
    piBin,
    recipe,
    sandbox,
    busRoot,
    instanceName,
    // back-compat: accept agentName as alias for instanceName
    agentName,
    topologyOverlay,
    task,
    inheritPty,
    debug,
    printPrompt,
  } = opts;

  const resolvedInstanceName = instanceName ?? agentName;

  const argv = [
    piBin,
    "--recipe", recipe,
    "--sandbox", sandbox,
    "--peer-bus", busRoot,
    "--peer-name", resolvedInstanceName,
  ];

  if (topologyOverlay) {
    argv.push("--topology-overlay", topologyOverlay);
  }

  if (task && task.trim()) {
    argv.push("--task", task);
  }

  if (inheritPty) {
    argv.push("--inherit-pty");
  }

  if (debug) {
    argv.push("--debug");
  }

  if (printPrompt && printPrompt.trim()) {
    argv.push("-p", printPrompt);
  }

  return argv;
}
