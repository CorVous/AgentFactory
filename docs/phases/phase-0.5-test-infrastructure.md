# Phase 0.5 — Test infrastructure

**Goal.** Add a unit test runner (vitest) so subsequent phases (1, 2, 3, …) can practice TDD on the small pure library modules they introduce — `_lib/bus-envelope.ts` first (Phase 1), then `_lib/habitat.ts` (Phase 2), then envelope-kind handlers (Phases 3–4), etc.

**Behaviour after this phase: identical to before.** No tests of actual code; just a working harness that future phases use. The tmux integration pattern documented in `AGENTS.md` is unchanged and remains the way to exercise rails end-to-end.

This file should be deleted in the PR that ships Phase 0.5.

---

## Required reading

1. **`AGENTS.md` and `docs/agents.md`** — project conventions; especially the existing tmux-based testing pattern for rails. You're complementing it, not replacing it.
2. **`docs/adr/0001-mesh-subsumes-delegation.md`** — describes the migration phases; this is the prerequisite the rest of them lean on.
3. **`package.json`** — current state. `"type": "module"`, no test script, no tsconfig.

---

## Why vitest, not jest / node:test / something else

- **ESM-native.** This project is `"type": "module"`; vitest runs ESM directly without a transform step. Jest needs `--experimental-vm-modules` or a CJS transform.
- **Zero-config for TS.** No `tsconfig.json` exists in this repo (jiti handles TS at runtime for pi extensions). Vitest's bundled esbuild compiles `.test.ts` files without needing one. Jest requires `ts-jest` or a Babel preset.
- **Small dep.** One devDependency, ~10 MB installed.
- **Fast startup.** Matters because future phases will run tests frequently in TDD red-green loops.
- **Watch mode out of the box.** `vitest` (no args) re-runs on file changes — useful in red-green-refactor iteration.

`node:test` is the only credible alternative (zero deps), but it requires `--import` flags for TS and lacks watch mode. The dep cost of vitest is small enough not to matter here.

---

## Branch strategy

Branch from the same base Phase 1 will use — `claude/review-codebase-architecture-5YMYu` with `claude/agent-mesh-deployment-zDKBE` merged in. Suggested name: **`claude/phase-0.5-test-infrastructure`**.

```sh
git fetch origin
git checkout claude/review-codebase-architecture-5YMYu
git pull
# If mesh hasn't been merged yet, do it now:
git merge origin/claude/agent-mesh-deployment-zDKBE
# Resolve any conflicts (likely small — the doc commits don't touch source).
git push origin claude/review-codebase-architecture-5YMYu

git checkout -b claude/phase-0.5-test-infrastructure
```

---

## Scope — what's in

1. **Add devDependency:** `npm install -D vitest`. If TypeScript types are missing for any Node APIs your sanity test touches, also `npm install -D @types/node`.
2. **Add `package.json` scripts:**
   ```json
   "scripts": {
     "test": "vitest run --passWithNoTests",
     "test:watch": "vitest"
   }
   ```
   `--passWithNoTests` keeps `npm test` exit-0 when no test files exist (which is the case immediately after Phase 0.5 ships — Phase 1 brings the first real tests). Drop the flag in a later phase if you want strict-empty-fails.
3. **Verify the harness works** with the negative-control protocol described under "Verification" below. This is *not* a permanent test — it's a one-time confirmation that you delete before committing.
4. **Update `AGENTS.md`** with a short note covering both the test command and the hermetic contract that future test authors need to know:

   > Unit tests live alongside source files as `*.test.ts` and run via `npm test` (vitest). They are **hermetic by contract**: no model API calls, no network, no env vars from `models.env`, no real filesystem outside the test's tmpdir. Tests that need a live model belong in the tmux integration pattern (see "Verifying the multi-agent rails under tmux" below), not in `npm test`.

   Place it near the existing "Debugging the rails" / "Verifying the multi-agent rails under tmux" sections so the integration story stays adjacent.

---

## Scope — what's NOT in

- **No tests of real code.** That's Phase 1's job (and 2, 3, …).
- **No CI configuration.** Separate concern; `npm test` working locally is enough for now.
- **No coverage tooling** (`@vitest/coverage-v8`, etc.). Add later when you actually want coverage gates.
- **No e2e / integration test harness.** The tmux pattern in `AGENTS.md` covers that.
- **No `tsconfig.json`.** Vitest's bundled esbuild handles TS without one; adding `tsconfig.json` is its own decision and would conflict with the jiti-at-runtime pattern pi extensions use.
- **No test directory restructuring.** Future phases place `*.test.ts` files next to the source they test (e.g. `_lib/bus-envelope.test.ts` next to `_lib/bus-envelope.ts`). Don't pre-create a `tests/` tree.
- **No ESLint, Prettier, or any other tooling additions.** Out of scope.

---

## Step-by-step checklist

```
[ ] 1. Read this plan, AGENTS.md, and ADR-0001.
[ ] 2. Branch from review-architecture+mesh as described above.
[ ] 3. npm install -D vitest    (latest stable; should be ≥1.0).
[ ] 4. Add "test" and "test:watch" scripts to package.json.
[ ] 5. Run the verification protocol (below). Confirm both negative
       and positive controls behave as expected. Delete the temp file.
[ ] 6. Update AGENTS.md with a note about `npm test`.
[ ] 7. Commit (clear message), push.
[ ] 8. Delete this file in the same commit/PR.
```

---

## Verification (one-time, not a permanent test)

Confirm the harness works in both directions before considering Phase 0.5 done.

**Positive control** — write a passing test, run, confirm exit-0:

Create `pi-sandbox/.pi/extensions/_lib/_smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("arithmetic", () => {
    expect(1 + 1).toBe(2);
  });
  it("async", async () => {
    const v = await Promise.resolve(42);
    expect(v).toBe(42);
  });
});
```

Run `npm test`. Expect: 2 passed, exit code 0.

**Negative control** — confirm a failing test correctly fails. Edit the smoke file, change `toBe(2)` → `toBe(3)`, run `npm test`. Expect: 1 failed 1 passed, exit code non-zero.

**Module resolution check** — confirm tests can import npm packages and project-relative TS:
```ts
import { parse } from "yaml";
it("npm import works", () => {
  expect(parse("foo: bar")).toEqual({ foo: "bar" });
});
```

If all three pass, the harness is healthy. **Delete `_smoke.test.ts` before committing.** It served its purpose.

---

## Acceptance criteria

- `vitest` is in `package.json` `devDependencies`.
- `package.json` has `"test"` and `"test:watch"` scripts.
- `npm test` exits 0 with "no test files found" message (because of `--passWithNoTests`).
- The verification protocol passed (you ran it; the temp smoke file is gone).
- `AGENTS.md` has a short note covering `npm test` *and* the hermetic-tests contract (no model calls, no env vars, no network in `npm test`).
- No `tsconfig.json`, no test directory tree, no other tooling added.
- This file (`docs/phases/phase-0.5-test-infrastructure.md`) deleted in the same commit/PR.

---

## Hand-back

When the checklist is complete, push to `origin/claude/phase-0.5-test-infrastructure` and report:

- Commit SHA.
- vitest version installed.
- Output of `npm test` (should show "no test files found, 0 passed (0)" or similar; exit 0).
- Whether mesh-branch merge produced any conflicts and what they were.
