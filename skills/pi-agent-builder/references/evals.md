# Evals for Pi extensions

Write evals when the extension has an objectively verifiable contract. Skip them for subjective behavior (tone, creativity). This guide is pragmatic — you're testing a TypeScript module that runs inside a TUI agent, not a pure function.

## What to test

For a typical extension, you care about four questions:

1. **Does the tool behave correctly when called with valid input?** Unit-like.
2. **Does the tool fail gracefully on invalid input or external errors?** Unit-like.
3. **Does the LLM call the tool when it should, and not when it shouldn't?** Integration — LLM-in-the-loop.
4. **Does the extension still work after `/reload`?** Lifecycle.

The first two are cheap and deterministic. The third is expensive and stochastic — run it enough times to smooth out variance (3–5 runs per case).

## Level 1: unit-like tests on `execute`

Extract the tool's logic into a pure-ish function and test it in Node directly.

```ts
// my-extension/core.ts — the logic
export async function runGreet(params: { name: string }, deps: Deps) {
  if (!params.name) throw new Error("name required");
  return `Hello, ${params.name}!`;
}

// my-extension/core.test.ts — standard tape/vitest/node:test
import { test } from "node:test";
import assert from "node:assert/strict";
import { runGreet } from "./core.js";

test("greets with name", async () => {
  assert.equal(await runGreet({ name: "Ada" }, mockDeps), "Hello, Ada!");
});
```

This is the 80% case. Everything you can factor out of the pi-specific shell should be testable this way.

## Level 2: loading tests

Verify the extension loads into pi without errors:

```bash
# Should exit cleanly with the extension loaded and print the registered tool
pi -e ./my-extension.ts --print '/help'
```

Check that your tool/command appears in the output. Any stack trace means a syntax or type error at load time.

## Level 3: LLM-in-the-loop triggering tests

Does the LLM actually call your tool when it should? This requires real model calls and real variance. Structure:

```
tests/
├── trigger-cases.json         # prompts + expected tool call
├── run-triggers.ts            # harness
└── results/
    └── run-2026-04-22/
        ├── case-01.json       # prompt, actual output, pass/fail
        └── ...
```

A trigger case:

```json
{
  "id": "greet-on-ask",
  "prompt": "Say hi to Mara for me.",
  "should_call": "greet",
  "should_not_call": ["bash", "write"],
  "param_check": { "name": "Mara" }
}
```

Harness (simplified):

```ts
for (const c of cases) {
  const result = spawnSync("pi", ["-p", c.prompt, "--json"], { encoding: "utf8" });
  const events = parseJsonl(result.stdout);
  const toolCalls = events.filter((e) => e.type === "tool_call");

  const pass =
    toolCalls.some((tc) => tc.name === c.should_call) &&
    !toolCalls.some((tc) => c.should_not_call?.includes(tc.name));
  // Optionally verify parameters shape
}
```

Run each case 3 times; report the rate. A tool with 2/3 trigger rate is likely fine; 0/3 or 1/3 means the description needs work.

### Improving trigger rate

If the LLM doesn't call your tool when it should:

- Make the description more concrete. Add example trigger phrases.
- Add a "when to use" section in the description.
- Move the most distinctive parameter earlier.

If the LLM calls your tool when it shouldn't:

- Add an "**do not use this tool when**" clause.
- Make the tool name more specific (`deploy_to_staging` not `deploy`).
- Narrow the description.

Iterate: change description → re-run triggers → measure. Don't change two things at once.

## Level 4: integration with real side effects

For extensions with external effects (API calls, file writes, subprocess), use a dedicated test workspace:

```bash
TEST_DIR=$(mktemp -d)
cd "$TEST_DIR"
echo "test content" > sample.txt
# Run pi with your extension, prompt it to do a task, assert the state
pi -e ~/.pi/agent/extensions/my-ext.ts -p "Process sample.txt"
# Assert the expected output file exists, has expected content, etc.
```

Cleanup on exit. Use a real tempdir, not a shared fixture — pi writes session files and you don't want leaks between runs.

## Level 5: regression — does `/reload` still work?

Hot-reload is the fastest dev loop and the most common source of subtle bugs. Script it:

1. Load pi with the extension.
2. Call the tool once via `/command` or a prompt. Verify it works.
3. Modify the extension (add a no-op).
4. Issue `/reload`.
5. Call the tool again. Verify it still works and you're running the new version.
6. Check no subprocesses / connections / watchers leaked from the old instance.

If step 6 fails, you're not cleaning up in `session_shutdown`. Fix that before shipping.

## Judge-based evals (for ambiguous output)

If your tool returns prose (a summary, an analysis), scoring exact output is brittle. Use a judge model:

```ts
const judgePrompt = `
A tool was asked: "${task}"
It returned: """${actual}"""
Does this response satisfy the request? Answer "yes" or "no" then explain.
`;
```

Run each eval case through a judge, log reasoning. Manually review disagreements.

## Recording and comparing across iterations

Save every run with a timestamp and the git sha of the extension. When you change the description or logic, diff:

- Trigger rate: went from 2/3 → 3/3. Good.
- Incorrect-trigger rate: went from 0/3 → 1/3. Bad — description is now too broad.
- Latency, token usage: stable? Regressions?

Spreadsheets or a simple `results.jsonl` works; don't over-engineer the tooling.

## Top failure modes

1. **Flaky triggering treated as success.** "It worked once, ship it" isn't good enough. Run cases ≥3 times; look at rates.
2. **Real-world vs test-world divergence.** Mocking out the LLM makes tests fast but meaningless for triggering. Run at least some cases against a real model.
3. **No negative cases.** Only testing "does it trigger when it should" misses "does it stay quiet when it shouldn't." Include decoy prompts.
4. **Model drift.** When providers update their models, your trigger rates shift. Pin model IDs in the test harness and re-eval periodically.
