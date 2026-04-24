import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const AssemblyExpectation = z.object({
  kind: z.literal("assembly"),
  pattern: z.string().min(1),
  extra_tools: z.array(z.string()).optional(),
  extra_components: z.array(z.string()).optional(),
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
  skill: z.enum(["pi-agent-assembler", "pi-agent-builder"]).default("pi-agent-assembler"),
  expectation: z.discriminatedUnion("kind", [AssemblyExpectation, GapExpectation]),
  prompt: z.string().min(1),
  probe: Probe.optional(),
});

export type TestSpec = z.infer<typeof TestSpecSchema>;
export type AssemblyExpectation = z.infer<typeof AssemblyExpectation>;
export type GapExpectation = z.infer<typeof GapExpectation>;

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
