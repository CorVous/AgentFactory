import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { COMPONENT_NAMES } from "./component-spec.ts";

const AssemblyExpectation = z.object({
  kind: z.literal("assembly"),
  pattern: z.string().min(1),
  extra_tools: z.array(z.string()).optional(),
  extra_components: z.array(z.string()).optional(),
});

const ComponentNameEnum = z.enum(COMPONENT_NAMES);

const COMPOSITION_TOPOLOGIES = [
  "single-spawn",
  "sequential-phases-with-brief",
  "rpc-delegator-over-concurrent-drafters",
] as const;

const CompositionExpectation = z.object({
  kind: z.literal("composition"),
  components: z.array(ComponentNameEnum).min(1),
  composition: z.enum(COMPOSITION_TOPOLOGIES).optional(),
  extra_tools: z.array(z.string()).optional(),
});

const GapExpectation = z.object({
  kind: z.literal("gap"),
  closest_match: z.string().optional(),
});

const Probe = z.object({
  args: z.string().default(""),
  evidence_anchor: z.string().optional(),
});

export const TestSpecSchema = z.object({
  skill: z
    .enum(["pi-agent-assembler", "pi-agent-composer", "pi-agent-builder"])
    .default("pi-agent-assembler"),
  expectation: z.discriminatedUnion("kind", [
    AssemblyExpectation,
    CompositionExpectation,
    GapExpectation,
  ]),
  prompt: z.string().min(1),
  probe: Probe.optional(),
});

export type TestSpec = z.infer<typeof TestSpecSchema>;
export type AssemblyExpectation = z.infer<typeof AssemblyExpectation>;
export type CompositionExpectation = z.infer<typeof CompositionExpectation>;
export type GapExpectation = z.infer<typeof GapExpectation>;
export type CompositionTopology = (typeof COMPOSITION_TOPOLOGIES)[number];

export function loadTestSpec(taskDir: string): TestSpec {
  const specPath = path.join(taskDir, "test.yaml");
  if (!fs.existsSync(specPath)) {
    throw new Error(`Test spec not found at ${specPath}`);
  }
  const raw = fs.readFileSync(specPath, "utf8");
  const parsed = YAML.parse(raw);
  const result = TestSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid test.yaml at ${specPath}:\n${issues}`);
  }
  return result.data;
}

/**
 * Composition-inference cascade. The `review` branch must precede the
 * `emit-summary && stage-write` branch — otherwise a
 * [cwd-guard, stage-write, review] set (single-drafter LLM-gated, no
 * fan-out) gets mis-inferred as sequential-phases-with-brief.
 */
export function inferComposition(
  components: ReadonlyArray<string>,
): CompositionTopology {
  const set = new Set(components);
  if (set.has("run-deferred-writer")) {
    return "rpc-delegator-over-concurrent-drafters";
  }
  if (set.has("review")) {
    return "rpc-delegator-over-concurrent-drafters";
  }
  if (set.has("emit-summary") && set.has("stage-write")) {
    return "sequential-phases-with-brief";
  }
  return "single-spawn";
}
