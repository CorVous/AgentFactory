---
name: html
description: Build a single static HTML page and give the user a temporary URL to view it in their browser. Use whenever the user asks to "show", "preview", "mock up", "demo", or "build" a webpage, landing page, or one-file HTML design.
---

# HTML Preview (single, temporary)

Previews live on a dedicated `html-previews` branch that holds **only** preview
`.html` files — never any other repo content. Each preview is its own
uniquely-named file. Never merge this branch into or out of your working branch.

When invoked:

1. Pick a unique filename: `preview-<random>.html`, where `<random>` is a short
   random string (e.g. `preview-7f3a9c2e.html`). Build the page as that single
   file — inline all CSS and JS, no build step.

2. Publish it to `html-previews` without disturbing your current branch or
   working tree, using a separate worktree:

   ```sh
   git fetch origin html-previews 2>/dev/null
   if [ ! -d ../html-previews-wt ]; then
     if git ls-remote --exit-code --heads origin html-previews >/dev/null 2>&1; then
       git worktree add ../html-previews-wt html-previews
     else
       # First time: orphan branch with no history and no other repo files
       git worktree add --detach ../html-previews-wt
       git -C ../html-previews-wt checkout --orphan html-previews
       git -C ../html-previews-wt rm -rf . >/dev/null 2>&1 || true
     fi
   fi
   ```

3. Write the HTML into `../html-previews-wt/preview-<random>.html`, then commit
   and push:

   ```sh
   git -C ../html-previews-wt add preview-<random>.html
   git -C ../html-previews-wt commit -m "Add preview-<random>.html"
   git -C ../html-previews-wt push -u origin html-previews
   ```

4. Give the user this URL (substitute owner, repo, filename):

   `http://htmlpreview.github.io/?http://raw.githubusercontent.com/<owner>/<repo>/html-previews/preview-<random>.html`

5. For revisions: edit that same file in `../html-previews-wt/`, commit, and push
   again. The URL stays the same; they just refresh. For a brand-new preview,
   generate a fresh filename and repeat steps 1–4.

Notes:
- For private repos, the user needs to be signed into GitHub in the same browser
  for htmlpreview to fetch it.
- Don't try to spin up a local server — the cloud sandbox isn't reachable from
  the user's browser.
- The `html-previews` branch is throwaway and only ever contains preview `.html`
  files. To clean up, delete individual files or the whole branch.
