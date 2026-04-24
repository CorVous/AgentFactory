import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enumerateCurations,
  isPatternOrGap,
  type Curation,
} from "./curation.ts";
import { generatePrompt } from "./curate-to-prompt.ts";
import { materialize, type MaterializedTask } from "./materialize.ts";

interface CliArgs {
  pattern?: string;
  only?: string;
  dryRun: boolean;
  nVariants: number;
  maxSeedsPerPattern?: number;
  runAfter: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: false, nVariants: 3, runAfter: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--pattern":
        out.pattern = argv[++i];
        break;
      case "--only":
        out.only = argv[++i];
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--run":
        out.runAfter = true;
        break;
      case "--n-variants":
        out.nVariants = Number(argv[++i]);
        if (!Number.isFinite(out.nVariants) || out.nVariants < 1) {
          throw new Error(`--n-variants expects a positive integer`);
        }
        break;
      case "--max-seeds":
        out.maxSeedsPerPattern = Number(argv[++i]);
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  const lines = [
    "Usage: npm run reverse-pipeline -- [options]",
    "",
    "Options:",
    "  --pattern <name>       Restrict to one pattern (or 'gap'). Default: all.",
    "  --only <tag>           Process only the curation with this tag.",
    "  --dry-run              Enumerate + generate prompts only; do not write YAML or run.",
    "  --run                  After materializing, invoke run-task.sh for each generated task.",
    "  --n-variants <k>       Prompt variants per curation; best by heuristic wins. Default 3.",
    "  --max-seeds <k>        Cap phrasing seeds per pattern. Default: all.",
    "  -h, --help             Show this help.",
    "",
    "Env vars read from models.env:",
    "  LEAD_MODEL             Used to drive the pi prompt-generator.",
    "  AGENT_BUILDER_TARGETS  Inherited by run-task.sh when --run is passed.",
  ];
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = resolveRepoRoot();
  const model = process.env.LEAD_MODEL;
  if (!model && !args.dryRun) {
    throw new Error(
      "LEAD_MODEL is not set. Source models.env (the npm script does this) or pass --dry-run.",
    );
  }

  if (args.pattern && !isPatternOrGap(args.pattern)) {
    throw new Error(
      `--pattern must be one of: recon, drafter-with-approval, confined-drafter, scout-then-draft, orchestrator, gap`,
    );
  }

  const allCurations = enumerateCurations(repoRoot, {
    pattern: args.pattern as ReturnType<typeof String> as never,
    maxSeedsPerPattern: args.maxSeedsPerPattern,
  });
  const curations = args.only ? allCurations.filter((c) => c.tag === args.only) : allCurations;
  if (args.only && curations.length === 0) {
    throw new Error(
      `No curation matched tag '${args.only}'. Run with --dry-run (no --only) to list tags.`,
    );
  }

  console.log(`# Reverse pipeline — ${curations.length} curation(s)\n`);
  const materialized: Array<{ curation: Curation; out: MaterializedTask }> = [];

  for (const curation of curations) {
    console.log(`## ${curation.tag}`);
    console.log(`- kind: ${curation.kind}`);
    console.log(`- pattern: ${curation.pattern}`);
    console.log(`- seed: ${curation.phrasingSeed}`);
    if (curation.components.length > 0) {
      console.log(`- components: ${curation.components.join(", ")}`);
    }

    let prompt = "";
    let temperature = 0;
    let variantIndex = 0;
    let variantCount = args.nVariants;

    if (args.dryRun && !model) {
      prompt = `[dry-run placeholder — seed: ${curation.phrasingSeed}]`;
    } else {
      try {
        const res = generatePrompt(curation, {
          repoRoot,
          model: model as string,
          nVariants: args.nVariants,
        });
        prompt = res.prompt;
        temperature = res.temperature;
        variantIndex = res.chosenIndex + 1;
        variantCount = res.variants.length;
        console.log(`- chose variant ${variantIndex}/${variantCount} (temp=${temperature})`);
      } catch (err) {
        console.error(`  ! generation failed: ${(err as Error).message}`);
        continue;
      }
    }

    console.log(`- prompt:`);
    for (const line of prompt.split("\n")) console.log(`    ${line}`);

    if (args.dryRun) {
      console.log("");
      continue;
    }

    const out = materialize(repoRoot, curation, prompt, {
      generatorModel: model ?? "(dry-run)",
      temperature,
      variantIndex,
      variantCount,
    });
    console.log(`- wrote: ${path.relative(repoRoot, out.yamlPath)}\n`);
    materialized.push({ curation, out });
  }

  if (args.runAfter && materialized.length > 0) {
    console.log(`# Running run-task.sh for ${materialized.length} generated task(s)\n`);
    for (const { out } of materialized) {
      const runner = path.join(repoRoot, "scripts/approach-b-framework/run-task.sh");
      const res = spawnSync("bash", [runner, out.relTaskName], {
        stdio: "inherit",
        env: process.env,
      });
      if (res.status !== 0) {
        console.error(`  ! run-task.sh failed for ${out.relTaskName}: exit ${res.status}`);
      }
    }
  }
}

function resolveRepoRoot(): string {
  // This file lives at <repo>/scripts/reverse-pipeline/index.ts.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
