#!/usr/bin/env tsx
// yaml-agent-info.ts — extract shell-evaluable fields from a YAML agent
// spec for run-agent.sh's interactive mode.
//
// Prints one `KEY=<shell-quoted>` assignment per line on stdout, e.g.:
//   SLASH='agent-composer'
//   COMPOSITION='single-spawn'
//   SKILL='skills/pi-agent-composer'
//   TOOLS='read,ls,grep,emit_agent_spec'
//   COMPONENTS='emit-agent-spec'
//
// Caller does `eval "$(tsx scripts/yaml-agent-info.ts <spec>)"` to load
// them. Reads `phases[0]` only (interactive mode is single-spawn-only;
// run-agent.sh refuses sequential-phases-with-brief in -i because the
// brief assembly + second spawn cannot be replicated as one pi REPL).
//
// This deliberately knows nothing about each component's tool list —
// the YAML's per-phase `tools:` is treated as authoritative when set,
// and absent it the script falls back to pi's default surface. Keep the
// helper focused on YAML field extraction; per-component plumbing
// (env vars, default tools) lives in the TS components themselves.

import * as fs from "node:fs";
import { parse as yamlParse } from "yaml";

function shq(s: string): string {
  // POSIX-safe single-quote escaping. Empty string → '' (well-formed).
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const specPath = process.argv[2];
if (!specPath) {
  console.error("Usage: yaml-agent-info.ts <spec.yml>");
  process.exit(2);
}

let raw: string;
try {
  raw = fs.readFileSync(specPath, "utf8");
} catch (e) {
  console.error(`Cannot read ${specPath}: ${(e as Error).message}`);
  process.exit(2);
}

let spec: {
  slash?: string;
  composition?: string;
  skill?: string;
  phases?: Array<{ components?: string[]; tools?: string[] }>;
};
try {
  spec = yamlParse(raw) as typeof spec;
} catch (e) {
  console.error(`Invalid YAML in ${specPath}: ${(e as Error).message}`);
  process.exit(2);
}

const phase0 = spec.phases?.[0] ?? {};
const tools = phase0.tools ?? [];
const components = phase0.components ?? [];

console.log(`SLASH=${shq(spec.slash ?? "")}`);
console.log(`COMPOSITION=${shq(spec.composition ?? "")}`);
console.log(`SKILL=${shq(spec.skill ?? "")}`);
console.log(`TOOLS=${shq(tools.join(","))}`);
console.log(`COMPONENTS=${shq(components.join(","))}`);
