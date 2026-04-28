# Phase 0.6 — CI

**Goal.** Add a GitHub Actions workflow that runs `npm test` on every push and pull request, so the unit tests Phases 1–6 introduce don't bit-rot when nobody remembers to run them locally.

**Behaviour after this phase: identical to before.** No code changes, no test changes, no runtime changes — only a `.github/workflows/test.yml` file that the GitHub-hosted runner uses to execute existing `npm test` on each push.

This file should be deleted in the PR that ships Phase 0.6.

---

## Prerequisite

**Phase 0.5 must have shipped.** The workflow runs `npm test`; if vitest isn't configured, the workflow has nothing to run. Confirm `npm test` exists in `package.json` `scripts` before starting.

---

## Required reading

1. **`docs/phases/phase-0.5-test-infrastructure.md`** (if still present) and the resulting `package.json` — confirms what `npm test` does.
2. **`docs/adr/0001-mesh-subsumes-delegation.md`** — Phases 1–6 are the consumers of this CI; the ADR explains why the unit tests they add matter.
3. **`AGENTS.md`** — project conventions; especially that integration testing is tmux-based and intentionally local-only.
4. **`package.json`** — current state.

---

## Why GitHub Actions specifically

The repository is hosted on GitHub (`corvous/agentfactory`). GitHub Actions has zero setup cost for a project already on GitHub: workflow file in `.github/workflows/`, no external service to enable. Free minutes are generous for private repos and unlimited for public.

No alternative was considered for v1 — the repo's current host determines this decision.

---

## Branch strategy

Branch from the post-Phase-0.5 state of `claude/review-codebase-architecture-5YMYu`. Suggested name: **`claude/phase-0.6-ci`**.

```sh
git fetch origin claude/review-codebase-architecture-5YMYu
git checkout -b claude/phase-0.6-ci origin/claude/review-codebase-architecture-5YMYu
# Confirm Phase 0.5 has shipped:
npm test
```

---

## Scope — what's in

1. **Create `.github/workflows/test.yml`** — single workflow, single job:

   ```yaml
   name: Test

   on:
     push:
     pull_request:

   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: '22'
         - run: npm ci
         - run: npm test
   ```

2. **Add a header comment** to the workflow file explaining what is *deliberately not* run in CI:

   ```yaml
   # CI runs unit tests only.
   #
   # The tmux-based integration tests documented in AGENTS.md are
   # intentionally NOT run here — they spawn real pi sessions that hit
   # the OpenRouter API and cost real money per run. Run them locally
   # before merging anything that touches the rails (see AGENTS.md for
   # the recipe).
   #
   # Unit tests must be hermetic: no network calls, no model API calls,
   # no real filesystem outside the test's tmpdir. If a test needs the
   # model, it doesn't belong in npm test — gate it behind a separate
   # script (e.g. npm run test:integration).
   ```

3. **Update `AGENTS.md`** with one line under the existing testing section: "Unit tests run automatically in CI on every push and PR; tmux integration tests stay local."

---

## Scope — what's NOT in

- **No tmux / model-API tests.** Real-money cost; not safe in CI. Document the boundary in the workflow comment.
- **No coverage tooling** (`@vitest/coverage-v8`, codecov, etc.). Add later if you want gates; for now, "tests pass" is enough signal.
- **No type-check step.** The project deliberately has no `tsconfig.json` (pi extensions are jiti-runtime). Adding `tsc --noEmit` here forces a tsconfig decision that belongs in its own phase if at all.
- **No lint step.** No linter configured; out of scope.
- **No `npm install` cache** via `actions/setup-node`'s `cache: 'npm'`. Premature optimisation for a small project; add when CI minutes start to matter.
- **No matrix builds** across multiple Node versions. The project's runtime contract is Node 22+; pin that single version.
- **No branch protection / required-status-checks configuration.** That's a GitHub UI / repository settings concern, not a workflow file. The user can enable "require Test to pass" in the branch protection settings independently after the workflow ships and runs successfully once.
- **No secrets / no `OPENROUTER_API_KEY` in CI.** Unit tests are hermetic by contract. If a future test tries to read this, the test is wrong, not the CI.

---

## Step-by-step checklist

```
[ ] 1. Read this plan, AGENTS.md, package.json.
[ ] 2. Confirm Phase 0.5 has shipped: `npm test` runs cleanly.
[ ] 3. Branch from review-codebase-architecture-5YMYu.
[ ] 4. Create .github/workflows/test.yml as specified above.
[ ] 5. Add the header comment about what is/isn't tested in CI.
[ ] 6. Update AGENTS.md with the one-line note.
[ ] 7. Commit (clear message), push.
[ ] 8. Verify on GitHub: the workflow appears under Actions; the push
       triggers a run; the run is green.
[ ] 9. Delete this file in the same commit/PR.
```

---

## Verification

After pushing the branch, confirm in both directions before considering the phase done.

**Positive control.** The push of the workflow file itself triggers the workflow. Open the repo's Actions tab on GitHub. Expect: a "Test" run appears, completes, exits green.

**Negative control.** Push a commit that breaks `npm test` (e.g. add a temporary `expect(1).toBe(2)` test). Expect: the workflow runs, fails, marks the commit red. Revert the breaking commit before merging.

**Pull-request control.** Open a draft PR from this branch (or any test branch). Expect: the workflow triggers on the PR event in addition to the push event.

If any of these don't behave as expected, the most likely cause is the workflow file's YAML syntax. Validate with `yq` or `jq -r` locally if needed.

---

## Acceptance criteria

- `.github/workflows/test.yml` exists with a `Test` job that runs `npm ci && npm test` on Node 22.
- Workflow triggers on both `push` and `pull_request` events.
- Header comment in the workflow explicitly documents what is and isn't run in CI (no tmux, no model calls, no secrets).
- `AGENTS.md` has a one-line update mentioning CI.
- Verification protocol has been observed: a green run on the workflow's own commit, a red run on a deliberately-broken commit (then reverted).
- No coverage tooling, no typecheck step, no lint, no matrix, no caching.
- This file (`docs/phases/phase-0.6-ci.md`) deleted in the same commit/PR.

---

## Hand-back

When the checklist is complete, push to `origin/claude/phase-0.6-ci` and report:

- Commit SHA(s) (the workflow file commit, plus the temporary break + revert commits if you used the negative-control protocol).
- Link to the green workflow run on GitHub.
- Link to the red workflow run on GitHub (negative control), if exercised.
- Whether the AGENTS.md update produced any conflicts.

Do not configure branch protection rules — that's a repo-settings change the user makes through the GitHub UI after this lands.
