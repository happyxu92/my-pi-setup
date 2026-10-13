---
description: Commit all changes in the current Git working tree
argument-hint: "[additional context]"
---

Commit all changes in the current Git working tree. Execute the commit; do not only suggest a message.

Follow this process:

1. Inspect `git status`, all staged and unstaged diffs, and every untracked file so the complete commit contents are understood.
2. Check for accidentally generated artifacts, credentials, secrets, or other files that clearly should not be committed. If any are found, stop without committing and explain the issue.
3. Run the relevant checks for the full set of changes before committing. If any test fails, including a test run by a commit hook, stop without committing and report the failing command, tests, and relevant error output; do not automatically fix test failures or change code or tests to make them pass. For non-test failures such as formatting, lint, type checks, or other commit-hook checks, diagnose and fix the issues, then rerun the failed checks and any affected checks, including tests not yet run, until they pass. Do not stop merely because a non-test check failed. Make the minimal fixes needed while preserving the intent of all existing changes, and include the fixes in the commit. Never bypass checks or weaken tests to force a pass. For non-test failures, stop if a safe fix requires user input or cannot be made, and explain the blocker.
4. Stage all tracked and untracked changes with `git add -A`, then verify the staged diff matches the intended complete working-tree state, including check-related fixes. Do not discard changes or alter them beyond the fixes required by step 3. If a commit hook fails, apply the failure policy in step 3: stop and report test failures; for safely fixable non-test failures, rerun the relevant checks, restage the fixes, verify the staged diff, and retry the commit.
5. Write the commit message in exactly this structure; do not infer its format from Git history:

   ```text
   <type>(<scope>): <imperative summary>

   <short explanatory paragraph wrapped at about 80 columns>

   - <imperative summary of the first material change>.
   - <imperative summary of the next material change>.

   Co-Authored-By: <current model name> (<reasoning level> reasoning)
   ```

   Use an appropriate Conventional Commit type and scope. Keep the subject concise, include a short body paragraph, list the material changes as `-` bullets, and populate the trailer from the current model and reasoning level.

6. Do not amend an existing commit unless explicitly requested. After committing, verify the committed diff and report the commit hash, subject, checks run, and any remaining changes.

Additional context: ${ARGUMENTS:-none}
