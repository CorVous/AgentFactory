/**
 * child-spawn.d.mts — TypeScript declarations for child-spawn.mjs
 */

/**
 * Resolve the absolute path to the `pi` binary for spawning children.
 * @param repoRoot - Absolute path to the repository root.
 * @returns Absolute path to node_modules/.bin/pi.
 */
export function resolvePiBin(repoRoot: string): string;

/**
 * Resolve the repo root relative to this module's location.
 * engine lib lives at packages/engine/agent/lib/ → 4 levels up = repo root.
 * @returns Absolute path to the repo root.
 */
export function resolveRepoRoot(): string;

/**
 * Build the argv array for spawning a `pi --recipe` child process.
 */
export function buildRecipeChildArgv(opts: {
  piBin: string;
  recipe: string;
  sandbox: string;
  busRoot: string;
  instanceName?: string;
  agentName?: string;
  provider?: string;
  topologyOverlay?: string;
  task?: string;
  inheritPty?: boolean;
  debug?: boolean;
  printPrompt?: string;
}): string[];
