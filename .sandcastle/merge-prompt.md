# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, run `npm run typecheck` and `npm run test` to verify everything works
4. If tests fail, fix the issues before proceeding to the next branch

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

For each branch that was merged, close its issue per the convention in `docs/agents/issue-tracker.md`:

1. Move the issue file from `issues/` to `issues/closed/` (preserving git history):

   ```
   git mv .scratch/<feature-slug>/issues/<NN>-<slug>.md .scratch/<feature-slug>/issues/closed/<NN>-<slug>.md
   ```

   The path of the issue file is passed as `{{TASK_ID}}`.

2. In the moved file, change the `Status:` line at the top to `Status: closed`.

3. Append a closing note under the `## Comments` heading at the bottom of the file:

   ```
   ## Comments

   - Completed by Sandcastle
   ```

   (Create the heading if it does not yet exist.)

4. Stage and commit the move + edits as part of the merge commit (or a follow-up commit on the workflow branch).

Sandcastle is the AFK path: branches that came from `Status: ready-for-agent` issues auto-merge here. Issues that were `Status: ready-for-human` should not have reached this prompt — they pause for a PR review instead, and are closed when the human merges that PR.

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
