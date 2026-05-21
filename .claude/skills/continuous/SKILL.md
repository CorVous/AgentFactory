---
name: continuous
description: Maintain a live HTML handoff doc on the html-previews branch, updated every turn as work progresses, so a fresh session can resume the work. Use when the user runs /continuous to start tracking a task, or /continuous <token> to resume one.
argument-hint: "[token to resume, or blank to start]"
---

# Continuous handoff

A living handoff doc, published as one HTML file and kept fresh every turn, so a
fresh session can pick up exactly where this one left off.

Terms: a **continuity token** (e.g. `0x4F9A`) identifies a **continuity doc**;
`/continuous <token>` resumes it.

## Two modes

- `/continuous` (no token) — **start**. Mint a token, create the doc from the
  current conversation, arm the per-turn hook, give the user the token + URL.
- `/continuous <token>` — **resume**. Fetch the doc, rehydrate context, re-arm
  the hook, continue working. If the token's file does not exist, list what is
  in `continuous/` and ask the user which token they meant.

## Starting (`/continuous`)

1. Mint a token: `0x` + 4 random uppercase hex chars (e.g. `0x4F9A`). If that
   file already exists in step 2's worktree, mint another.

2. Set up the publish worktree on the `html-previews` branch (a dedicated branch
   for browser-viewable artifacts — never merge it in or out of your working
   branch):

   ```sh
   git fetch origin html-previews 2>/dev/null
   if [ ! -d ../html-previews-wt ]; then
     if git ls-remote --exit-code --heads origin html-previews >/dev/null 2>&1; then
       git worktree add ../html-previews-wt html-previews
     else
       git worktree add --detach ../html-previews-wt
       git -C ../html-previews-wt checkout --orphan html-previews
       git -C ../html-previews-wt rm -rf . >/dev/null 2>&1 || true
     fi
   fi
   mkdir -p ../html-previews-wt/continuous
   ```

3. Write the doc to `../html-previews-wt/continuous/<token>.html` (structure
   below), seeded from the current conversation.

4. Arm the marker so the per-turn hook activates:

   ```sh
   echo "<token>" > "$(git rev-parse --git-dir)/continuous-active"
   ```

5. Commit and push:

   ```sh
   git -C ../html-previews-wt add continuous/<token>.html
   git -C ../html-previews-wt commit -m "continuous(<token>): start"
   git -C ../html-previews-wt push -u origin html-previews
   ```

6. Give the user the token and the htmlpreview URL. Derive `<owner>/<repo>` from
   `git remote get-url origin`:

   `http://htmlpreview.github.io/?http://raw.githubusercontent.com/<owner>/<repo>/html-previews/continuous/<token>.html`

   Tell them they can resume in any new session with `/continuous <token>`.

## The doc

One self-contained HTML file, inline CSS, no build step. Semantic HTML —
headings, lists, a simple timeline — so a resuming agent reads the raw file
directly. Three parts:

- **Snapshot** — rewritten on every update, kept tight: the task title, Goal,
  Status, Open questions, Next steps.
- **Decisions & nuance** — append-only; never rewrite or delete entries. A
  timeline of decisions made, information discovered, plan changes/dead ends,
  and nuance the user gave. One terse entry per item, each tagged with a turn
  number or short timestamp.
- **How to resume** — static footer: "Run `/continuous <token>` in a new
  session."

## Staying current (every turn)

A `UserPromptSubmit` hook re-injects a reminder each turn while the marker
exists — you do not have to remember on your own, but you MUST act on it.

Whenever a turn produces new task progress, a decision, discovered information,
a plan change/dead end, or user-provided nuance: update the local doc (rewrite
the snapshot, append to the log), then commit and push:

```sh
git -C ../html-previews-wt add continuous/<token>.html
git -C ../html-previews-wt commit -m "continuous(<token>): update"
git -C ../html-previews-wt push origin html-previews
```

Pushing every turn is expected. If a push is rejected, run
`git -C ../html-previews-wt pull --rebase origin html-previews` and retry. If
unsure of the doc's current content, read the file first.

## Resuming (`/continuous <token>`)

1. Set up the worktree (step 2 above), then read
   `../html-previews-wt/continuous/<token>.html`. Missing → list `continuous/`
   and ask which token.
2. Append a log entry: `— resumed in a new session —`.
3. Re-arm the marker (step 4 above).
4. Continue the conversation naturally — no state-dump summary. A one-line
   "resumed, caught up" acknowledgement is fine if the user gave no instruction.

## Notes

- Redaction is minimal: scrub only live credentials / API keys. Everything else
  — decisions, file paths, specifics — is captured. The doc lives in committed
  git history, so if the user pastes something obviously secret, flag it.
- Continuity lapses on its own when the session ends; the marker is per-checkout
  and there is no stop command.
- Private repo: the user must be signed into GitHub in the same browser for
  htmlpreview to render the doc.
