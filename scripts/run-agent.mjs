#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_ROOT = path.join(REPO_ROOT, "pi-sandbox");
const AGENTS_DIR = path.join(SANDBOX_ROOT, "agents");
const EXTENSIONS_DIR = path.join(SANDBOX_ROOT, ".pi", "extensions");
const SKILLS_DIR = path.join(SANDBOX_ROOT, "skills");
const PI_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "pi");

const BASELINE_EXTENSIONS = [
  "sandbox",
  "no-startup-help",
  "agent-header",
  "agent-footer",
  "hide-extensions-list",
  "deferred-confirm",
];
const TIER_VARS = new Set(["RABBIT_SAGE_MODEL", "LEAD_HARE_MODEL", "TASK_RABBIT_MODEL"]);

function die(msg) {
  process.stderr.write(`run-agent: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { name: null, sandbox: null, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sandbox") {
      out.sandbox = argv[++i] ?? die("--sandbox requires a directory");
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (out.name === null) {
      out.name = a;
    } else {
      out.passthrough.push(a);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    `Usage: npm run agent -- <name> [--sandbox <dir>] [pi flags...]\n\n` +
      `Loads pi-sandbox/agents/<name>.yaml and launches pi with the recipe's\n` +
      `system prompt, tool allowlist, extensions, and skills. The sandbox\n` +
      `extension restricts all fs activity to <dir> (default: cwd where you\n` +
      `invoked npm run agent) and disables bash entirely.\n\n` +
      `Run without a name to list available agents.\n`,
  );
}

function listAgents() {
  let entries;
  try {
    entries = readdirSync(AGENTS_DIR);
  } catch (e) {
    die(`failed to read ${AGENTS_DIR}: ${e.message}`);
  }
  const names = entries
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -".yaml".length))
    .sort();
  const rel = path.relative(REPO_ROOT, AGENTS_DIR) || AGENTS_DIR;
  if (names.length === 0) {
    process.stdout.write(`No agents found in ${rel}\n`);
    return;
  }
  process.stdout.write(`Available agents (${rel}):\n`);
  for (const n of names) process.stdout.write(`  ${n}\n`);
  process.stdout.write(`\nRun: npm run agent -- <name>\n`);
}

function loadRecipe(name) {
  const file = path.join(AGENTS_DIR, `${name}.yaml`);
  if (!existsSync(file)) die(`recipe not found: ${file}`);
  let recipe;
  try {
    recipe = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    die(`failed to parse ${file}: ${e.message}`);
  }
  if (!recipe || typeof recipe !== "object") die(`recipe ${file} is empty or not an object`);
  if (typeof recipe.prompt !== "string" || !recipe.prompt.trim()) die(`recipe ${file} missing 'prompt'`);
  if (!Array.isArray(recipe.tools)) die(`recipe ${file} missing 'tools' (list)`);
  return recipe;
}

function resolveModel(tierOrId) {
  const requested = tierOrId || "TASK_RABBIT_MODEL";
  if (TIER_VARS.has(requested)) {
    const v = process.env[requested];
    if (!v) die(`tier ${requested} is not set; source models.env first`);
    return v;
  }
  return requested;
}

function resolveExtensionPaths(names) {
  const seen = new Set();
  const merged = [...BASELINE_EXTENSIONS, ...names];
  return merged
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .map((n) => {
      const p = path.join(EXTENSIONS_DIR, `${n}.ts`);
      if (!existsSync(p)) die(`extension not found: ${p}`);
      return p;
    });
}

function resolveSkillPaths(names) {
  return names.map((n) => {
    const direct = path.isAbsolute(n) ? n : path.join(SKILLS_DIR, n);
    if (!existsSync(direct)) die(`skill not found: ${direct}`);
    return direct;
  });
}

const args = parseArgs(process.argv.slice(2));
if (!args.name) {
  listAgents();
  process.exit(0);
}
const recipe = loadRecipe(args.name);

const sandboxRoot = path.resolve(args.sandbox || process.env.INIT_CWD || process.cwd());
if (!existsSync(sandboxRoot)) die(`sandbox dir does not exist: ${sandboxRoot}`);

const recipeModel = recipe.model || "TASK_RABBIT_MODEL";
const model = resolveModel(recipeModel);
const extensionPaths = resolveExtensionPaths(Array.isArray(recipe.extensions) ? recipe.extensions : []);
const skillPaths = resolveSkillPaths(Array.isArray(recipe.skills) ? recipe.skills : []);

const piArgs = [
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
  "--provider",
  recipe.provider || "openrouter",
  "--model",
  model,
  "--tools",
  recipe.tools.join(","),
  "--system-prompt",
  recipe.prompt,
];
for (const p of extensionPaths) piArgs.push("-e", p);
for (const p of skillPaths) piArgs.push("--skill", p);
piArgs.push("--sandbox-root", sandboxRoot);
piArgs.push("--agent-name", args.name);
if (typeof recipe.description === "string" && recipe.description.trim()) {
  piArgs.push("--agent-description", recipe.description.trim());
}
if (TIER_VARS.has(recipeModel)) {
  piArgs.push("--agent-tier", recipeModel);
}
if (Array.isArray(recipe.noEditAdd) && recipe.noEditAdd.length > 0) {
  piArgs.push("--no-edit-add", recipe.noEditAdd.join(","));
}
if (Array.isArray(recipe.noEditSkip) && recipe.noEditSkip.length > 0) {
  piArgs.push("--no-edit-skip", recipe.noEditSkip.join(","));
}
piArgs.push(...args.passthrough);

if (!existsSync(PI_BIN)) die(`pi binary missing: ${PI_BIN} (run npm install)`);

const child = spawn(PI_BIN, piArgs, {
  cwd: sandboxRoot,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
