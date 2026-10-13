---
description: Commit only changes made in the current session
argument-hint: "[additional context]"
---

Commit the changes made during this session. Execute the commit; do not only suggest a message.

Follow this process:

1. Inspect `git status`, all staged and unstaged diffs, untracked files, and the current session history. Treat the session history as the source of truth for which changes belong to this session.
2. Run the relevant checks for the session's changes before committing. If any test fails, including a test run by a commit hook, stop without committing and report the failing command, tests, and relevant error output; do not automatically fix test failures or change code or tests to make them pass. For non-test failures such as formatting, lint, type checks, or other commit-hook checks, diagnose and fix the issues, then rerun the failed checks and any affected checks, including tests not yet run, until they pass. Do not stop merely because a non-test check failed. Keep fixes within the session's commit scope and preserve unrelated work and its staging state; use targeted fixes rather than repository-wide autofixes. Include these fixes in the commit, and restage them if a commit hook required further changes before retrying the commit. Never bypass checks or weaken tests to force a pass. For non-test failures, stop if a safe fix requires user input or cannot be made within this scope, and explain the blocker.
3. Stage and commit only files or hunks changed during this session. Never include pre-existing staged, unstaged, or untracked work. Preserve unrelated work and its staging state. Do not use broad staging commands such as `git add .` or `git add -A`. If session changes cannot be separated safely, stop without committing and explain why.
4. Write the commit message in exactly this structure; do not infer its format from Git history:

   ```text
   <type>(<scope>): <imperative summary>

   <short explanatory paragraph wrapped at about 80 columns>

   - <imperative summary of the first material change>.
   - <imperative summary of the next material change>.

   Co-Authored-By: <current model name> (<reasoning level> reasoning)
   ```

   Use an appropriate Conventional Commit type and scope. Keep the subject concise, include a short body paragraph, list the material changes as `-` bullets, and populate the trailer from the current model and reasoning level.

5. Do not amend an existing commit unless explicitly requested. After committing, verify the committed diff and report the commit hash, subject, checks run, and any remaining changes.

Additional context: ${ARGUMENTS:-none}
