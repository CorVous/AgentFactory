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

For each branch that was merged, close its issue file (path passed as `{{TASK_ID}}`) by:

1. Setting the `Status:` line at the top of the file to `Status: closed`.
2. Appending a closing note under the `## Comments` heading at the bottom of the file:

   ```
   ## Comments

   - Completed by Sandcastle
   ```

   (Create the heading if it does not yet exist.)

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
