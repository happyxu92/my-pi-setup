# Adversarial Loop

[GitHub](https://github.com/happyxu92/my-pi-setup) · Feedback, suggestions, and improvements are welcome! Feel free to [open an issue](https://github.com/happyxu92/my-pi-setup/issues) or submit a pull request.

`adversarial_loop` is an evaluator-generator delivery workflow. It uses independent, temporary pi agents to repeatedly produce, review, and improve deliverables in the workspace until they satisfy the acceptance criteria.

It is intended for tasks that meet either of the following descriptions:

- They have strict completion requirements and need independent, criterion-by-criterion validation.
- They demand a high degree of completeness, accuracy, coherence, usability, or polish and therefore benefit from multiple rounds of production and review.

Deliverables may include code, documentation, specifications, reports, proposals, analyses, configuration, or any other artifact that can be written to the workspace and inspected. Simple questions and minor edits generally do not justify starting a loop.

## Workflow

1. The first **evaluator** inspects the current workspace, derives concrete and observable acceptance criteria from the task, and returns them in the JSON `criteria` field. In addition to correctness and hard constraints, the criteria may cover completeness, audience fit, usability, evidence, and production quality as appropriate for the task. After parsing the criteria, the controller writes them to `task-spec.md` as a process record. If the evaluator's final structured output cannot be parsed, the controller sends a corrective prompt in the same RPC session. By default, it retries up to twice, allowing at most three outputs in total: the initial output plus two retries.
2. If the task does not pass, a new **generator** directly creates or improves the deliverables according to the current acceptance criteria and evaluator feedback, then runs any applicable checks or reviews.
3. The next iteration starts a fresh evaluator. It receives the previous generator's response as untrusted context about changes and checks, but independently determines completion using only the original task, the current acceptance criteria, the current deliverables, and its own verification results. Later evaluators normally do not return `criteria`. They return a complete replacement set in `updated_criteria` only when inspection or verification reveals a genuine need to correct, clarify, deduplicate, or add an omitted requirement already implied by the original task. Updates must not weaken requirements merely to let the current deliverables pass, nor may they introduce unrelated scope.
4. The loop succeeds only when the evaluator explicitly returns `completed: true` and every normalized criterion check is `pass` with non-empty evidence. Missing checks, invalid statuses, and passes without evidence become `unknown`. If acceptance is never reached, the loop reports `exhausted` at the safety limit rather than claiming completion.

Each child agent starts in RPC mode with a fresh, independent session. The controller passes both `--session-dir` and a unique `--session` file in the corresponding iteration's `evaluator/` or `generator/` directory, so child agents do not inherit conversation context from the parent agent or a previous child agent. The controller waits for `agent_settled`, including pi's automatic retries and continuations, before validating the output. The RPC subprocess remains alive for corrective prompts in the same session if the evaluator produces invalid structured output. After validation succeeds or retries are exhausted, the controller closes stdin and waits for exit, escalating to termination if shutdown stalls. To support headless execution and prevent project extensions from blocking, RPC dialog requests for `select`, `confirm`, `input`, and `editor` are automatically canceled. Child agents inherit the current model and thinking level from the parent session:

- Evaluator base tools: `read,bash,edit,write,grep,find,ls`
- Generator base tools: `read,bash,edit,write,grep,find,ls`
- If the parent session trusts the project, both types of child agent resolve the project's enabled extensions using only `<workspace>/.pi/settings.json` and the auto-discovered entries under `<workspace>/.pi/extensions/`. This includes already-installed npm, git, and local packages configured in the project's `packages` list, project-level `extensions` paths, package filters, and ordinary project-local extensions.
- User/global extension configuration is ignored.

The subprocess still uses `--no-extensions` to disable automatic extension discovery, then explicitly loads only the trusted project's resolved extension paths plus an internal extension that restores the base toolset. Tools registered by project extensions are available by default, except for `adversarial_loop`, `adversarial_loop_wait`, and `adversarial_loop_manage`, which are excluded to prevent child agents from recursively scheduling or managing loops. The workflow does not install missing plugins from the network; project packages must already be installed, as they normally are during trusted project startup. Project extensions run with the current user's permissions, just like ordinary pi extensions, so only reviewed code should be trusted and loaded.

The evaluator's `edit` and `write` tools are intended only for saving its own intermediate evaluation materials; it should not modify workspace deliverables. The acceptance criteria established in the first iteration serve as a stable baseline for subsequent evaluations, but later evaluators may submit a complete replacement set through `updated_criteria` when genuinely necessary. When no update is needed, they may omit both `criteria` and `updated_criteria`. The controller writes the latest criteria to `task-spec.md`. Whenever the criteria change, it archives both the old and new sets in `criteria-revisions.jsonl`. These control files exist only as process records; their names and paths are not included in child prompts. Children receive their own artifact directory, but the archive is not hidden or filesystem-isolated. The generator directly receives the task, current acceptance criteria, and evaluator feedback. Later evaluators receive the previous generator response as untrusted context, but must verify its claims themselves and independently evaluate the task against the criteria and current workspace.

## Loop Archive

Each loop creates a unique `<UTC timestamp>-<random>` directory under `workspace/.adversarial-loop/` when execution starts. This directory name is **not** the background task's UUID; use the reported `loopDirectory` or `Loop archive` path to locate it. Control files and non-deliverable intermediate results are retained after child agents exit:

```text
.adversarial-loop/<UTC timestamp>-<random>/
├── original-task.md
├── loop-result.json         # Background task terminal result and usage
├── task-spec.md
├── criteria-revisions.jsonl  # Created only after a criteria update
├── evaluator-results.jsonl
├── generator-results.jsonl
└── iterations/
    ├── 001/
    │   ├── evaluator/
    │   │   ├── session-<UTC timestamp>-<random>.jsonl  # pi session
    │   │   ├── events.jsonl
    │   │   ├── final-response.txt
    │   │   ├── result.json
    │   │   ├── stderr.log       # Present only when diagnostics exist
    │   │   └── stderr-full.log  # Present only when the subprocess writes to stderr
    │   └── generator/
    │       └── ...
    └── 002/
        └── ...
```

- `loop-result.json`: Background task ID, terminal status, available evaluation details, latest generator report (on a normal return), error (if any), and cumulative child usage. Written before completion is announced; Goal audits do not create this background-task file. Delivery metadata is a snapshot at completion; the current delivery state is kept in the session ledger. Early cancellation or archive-creation failure may leave no archive; failure to save a completed or exhausted result changes the task status to `error`.
- `criteria-revisions.jsonl`: Created only when a later evaluator first returns a valid `updated_criteria`. Each subsequent update appends one line recording the iteration, the old criteria, and the complete new criteria, ensuring that older versions are not lost when `task-spec.md` is updated. The file is not created if the criteria never change.
- `evaluator-results.jsonl`: Each line records the normalized structured result of one evaluator iteration. It also records errors when structured output still cannot be parsed after the default two in-session corrections, when the subprocess fails, or when another parsing error occurs. The `result.json` in each agent directory records the actual number of structured-output retries in `outputRetries`.
- `generator-results.jsonl`: Each line records a generator work summary, stop reason, or error.
- Every iteration pre-creates separate `evaluator/` and `generator/` directories. Child-agent sessions use filenames in the form `session-<UTC timestamp>-<random>.jsonl` (for example, `session-20260826T032957Z-ALBXrg.jsonl`). These files contain user prompts, conversation messages, tool-call arguments, and results, making them complete session records. `events.jsonl` stores only a compact execution timeline, including agent and turn lifecycle events, tool names and success states, compaction events, and retry diagnostics. It does not duplicate message bodies, streaming deltas, tool arguments, or tool results. Final responses, diagnostics, and task-related intermediate materials explicitly saved by an agent are also retained in the corresponding directory. Role-specific instructions are appended to the child's system prompt via `--append-system-prompt`.
- Successful generator reports are truncated to a 12 KiB content budget before being passed to the next evaluator or saved in `final-response.txt`, `result.json`, and the loop-level summaries. The complete response remains in the child session JSONL. Evaluator responses are not subject to this report cap, but their parsed fields are normalized and bounded.
- `stderr-full.log` contains the subprocess's raw, untruncated stderr byte stream. `stderr.log` contains the same diagnostic summary written to `result.json`, with an 8 KiB content budget plus a truncation marker when needed, and may additionally include controller diagnostics for RPC protocol, stdin, spawn, or archival errors. Neither file is created when its corresponding content is empty.

`.adversarial-loop/` is a workflow archive, not part of the task deliverables. Its `task-spec.md` is the controller-generated record of acceptance criteria. Child agents should ignore archive contents and must not treat them as deliverables or modify other agents' directories.

## Code Structure

- `index.ts`: Three tool registrations, commands, session lifecycle, and pi context adaptation.
- `loop-manager.ts`: Session-wide capacity, background task lifecycle, independent cancellation, result persistence, and the exclusive Goal audit slot.
- `loop-notifier.ts`: Completion inbox delivery, deduplication, main-agent yielding/wakeup, and bounded result formatting.
- `config.ts`: Defaults and CLI validation for the parallel-loop and Goal-continuation limits.
- `core.ts`: Single-loop execution and result formatting; the blocking batch helper remains available internally but is not used by the public tool.
- `artifacts.ts`: Loop and iteration directories, task specifications, criteria revisions, and evaluator/generator result archives.
- `child-agent.ts`: Temporary pi subprocess startup, cancellation, extension selection, event handling, and usage aggregation.
- `child-tools.ts`: Enables the child agent's base tools while preserving tools registered by project extensions.
- `evaluator.ts`: Evaluator prompts and acceptance-output parsing and normalization.
- `generator.ts`: Generator prompt construction.
- `goal.ts`: Persistent `/goal` state machine, prompt injection, auditing, and continuation control.
- `types.ts`: Shared domain types.
- `utils.ts`: Stateless utilities for usage data, string cleanup, truncation, and related operations.

## Usage

Invoke the tool with the `loops` parameter. It supports one or more loops:

```json
{
  "loops": [
    {
      "task": "Create ... under docs/; it must cover ...; write it for ...; verify it using ...",
      "maxIterations": 6
    }
  ]
}
```

Multiple independent loops can run concurrently, including across separate tool calls. The default **session-wide concurrent maximum** is `6` loops:

```json
{
  "loops": [
    {
      "task": "Implement ... in packages/a; run ... to verify it",
      "maxIterations": 4
    },
    {
      "task": "Implement ... in packages/b; run ... to verify it",
      "maxIterations": 6
    }
  ]
}
```

Parameters:

- `loops`: Required list containing `1-6` loops by default.
- `loops[].task`: A complete, self-contained task description. Child agents cannot see the parent conversation history.
- `loops[].maxIterations`: Maximum number of generator runs. Defaults to `6`; allowed range: `1-20`. A final evaluator still runs after the last generator iteration, for at most `maxIterations + 1` evaluations. Acceptance can end the loop early, including before any generator runs.

The tool returns immediately with an explicit mapping from each zero-based `loops[index]` in the current call to its task ID, status, and task summary, plus the remaining capacity; this acknowledges submission, **not acceptance**. The mapping is included in the LLM-visible text, not only tool metadata. Call `adversarial_loop` **as the only tool call in the assistant message**, putting all new tasks in its `loops` array. Mixed tool batches, including multiple start calls in one message, are rejected before starting those loops.

After a successful submission, if **more than one loop is active across the session**, the tool automatically yields the main agent with `terminate: true`, skipping the ordinary post-tool LLM request. Completed results are buffered until **at most one active loop remains**, then delivered together to wake the main agent. The count includes starting, running, and cancelling loops; cancellation reduces it only after cleanup. It is not the submitted array length or the iteration count. Pending messages prevent automatic yielding, and new user input resumes the agent early. With at most one active loop at submission, the main agent simply continues without an extra wakeup request.

Outside manual or automatic waiting, completed results arrive automatically as custom messages: if the main agent is working, results are steered into its next safe model turn; if idle, a result triggers a new turn. Nearby completions are coalesced, while ordinary child progress never triggers an LLM request. Result notifications, ready wait responses, and result rereads identify each task by ID, status, and task summary, and include a session-wide active-task snapshot (including starting and cancelling tasks) before the result reports. Wait acknowledgments also include this active-task snapshot. Task summaries and large rosters are truncated; a missing result notification alone does not imply that a task is still active. After the agent wakes, starting additional loops automatically yields again if the session-wide active count exceeds one.

Concurrent loops share the current workspace and may run generators at the same time. Assign each loop a non-overlapping set of directories or files. **The main agent must also avoid modifying files owned by active loops.** Tasks with dependencies or tasks that modify the same files should run serially. This is a coordination rule, not enforced filesystem isolation.

All calls reserve capacity atomically. Starting, running, and cancelling loops count against the same limit; cancellation releases a slot only after the child exits and final cleanup finishes. Insufficient capacity rejects the entire submission: no partial acceptance and no hidden queue. A failed loop does not cancel its siblings. The model, thinking level, cwd, and project trust are captured at submission.

To change the session-wide concurrent limit (and the maximum `loops` array length), start pi with the extension flag below. The value must be a positive safe integer; invalid values produce a warning and fall back to `6`:

```bash
pi --adversarial-loop-max-loops 10
```

### Yielding and managing tasks

Three LLM tools are registered:

| Tool | Purpose |
| --- | --- |
| `adversarial_loop` | Start background loops; return IDs immediately and automatically yield if more than one is active. Call alone. |
| `adversarial_loop_wait` | Yield until loops drain to at most one; if only one remains, wait for its exit. User input can resume work earlier. |
| `adversarial_loop_manage` | Query status, reread results, or cancel tasks. |

Manual and automatic waiting share the same wakeup policy: buffer results until a loop exits and **at most one active loop remains**. Their entry conditions differ: startup automatically yields only above one active loop, while manual waiting can also wait for the last loop to exit (`1 → 0`). Existing counts or ordinary progress never immediately wake a newly entered wait.

When no useful independent work remains, call `adversarial_loop_wait` with `{}` **as the only tool call in the assistant message**. Do not poll status or emit repeated waiting commentary; results arrive automatically. If it waits, it immediately returns `terminate: true`, suppressing the ordinary post-tool LLM request without holding a tool execution open. Already-ready results are returned immediately only when at most one loop is active; above that threshold they remain buffered. If no tasks remain or another message is already pending, it does not yield. User input can also resume either kind of wait early. Mixed tool batches and multiple waits in one message are rejected.

Typical sequence:

```text
adversarial_loop (3 tasks) → automatically wait
3 → 2 active             → buffer the first result; keep waiting
2 → 1 active             → wake with buffered results
integrate → start another loop → 2 active → automatically wait again

adversarial_loop (1 active total) → continue independent work
no independent work remains     → adversarial_loop_wait alone
next result                     → wake and integrate
```

Management examples:

```json
{ "action": "status" }
{ "action": "result", "ids": ["<loop-id>"] }
{ "action": "cancel", "ids": ["<loop-id>"] }
{ "action": "cancel" }
```

`result` requires IDs. `status` and `cancel` accept optional IDs, defaulting to all tasks. Results remain readable after notification and repeated reads do not duplicate usage. Only `completed` means independent acceptance; `exhausted`, `error`, `cancelled`, and `interrupted` do not.

User commands remain available while the main agent is idle:

```text
/loops status
/loops stop <loop-id>
/loops stop all
```

Cancelled task results are suppressed. However, an individual cancellation that reduces the active count to at most one ends either kind of wait, even if there are no pending results to deliver. A manual wait entered with just one loop waits for that loop's cleanup to finish (`1 → 0`). Outside waiting, cancellation alone does not wake the main agent. `/loops stop all` disables automatic wakeups and aborts an active main run. A main-agent abort or terminal error pauses automatic notifications until a new user instruction; it does not itself cancel the background workers. Use `/loops stop all` to stop those workers too.

### Persistence and execution modes

Background work is scoped to a **persistent TUI or RPC session**, not an external daemon. Print/JSON single-shot mode explicitly rejects start/wait calls because the process could exit before the work completes. Normal main-agent settlement does not stop workers. Exit, reload, session replacement, and tree navigation cancel and clean up old workers; stale callbacks cannot notify the replacement session/branch. Unfinished restored records become `interrupted` and are never automatically restarted. Restored results remain queryable but do not unexpectedly trigger model requests.

Task records are stored as `adversarial-loop-state` session entries and restored only from the current branch. Each completed task also saves `loop-result.json` in its archive. Cumulative child usage, including work preceding a child error, is retained per task. This ledger sums child assistant-message usage; it does not aggregate separate tool-reported or compaction usage. **Background usage is currently an extension ledger, not part of Pi's native footer or `/session` tool-usage totals**, because a startup tool result is finalized before that usage exists. Completion notifications and repeated reads do not charge it again.

The concurrency limit applies to one session runtime, not globally across separate Pi processes. Formatted result bodies have a 48 KiB content budget, plus a truncation marker when needed; automatic notifications add a short delivery preamble and carry at most six results each, with remaining results kept in the inbox.

## Goal Mode

`/goal` runs the main agent toward a persistent goal and independently audits the workspace only after the main agent has fully settled, all background loops have ended, and their results have been delivered for integration. Neither automatic yielding after startup nor yielding with `adversarial_loop_wait` is completion; neither starts an audit. The last background result first wakes the main agent; audit waits for that agent to finish integrating it. The goal task is carried in the system prompt; the extension sends only a short kickoff user message to start the run. If the evaluator does not accept the result, its failed checks and feedback are queued as a follow-up and the main agent continues automatically.

```text
/goal Implement the requested feature and verify it with the project tests
/goal status
/goal stop
/goal resume
```

Goal state is appended to the current session as `goal-state` custom entries. It is restored from the active session branch after reloads, resumes, forks, and tree navigation. A previously running or auditing goal is restored as interrupted rather than starting work unexpectedly. `/goal resume` accepts stopped, exhausted, errored, or interrupted goals, assigns a new unique ID, and resets the continuation budget; completed goals cannot be resumed. Creating or resuming a goal requires an idle main agent and an available model. An active or auditing goal blocks creation of another goal.

While a Goal is active, `before_agent_start` also saves the full system prompt after Goal instructions are appended as a `goal-system-prompt` custom entry containing `version: 1`, `goalId`, `continuationCount`, and `systemPrompt`. A snapshot is appended only when its prompt text differs from the latest valid snapshot on the current branch. Session load and tree navigation restore only that deduplication baseline, never replay the historical prompt. These entries are audit records: they do not enter LLM context or have a custom UI renderer, and they do not capture later extensions' changes or provider payload rewrites. Full snapshots may include local context file contents; treat the session archive accordingly. Goal stop/completion remains recorded in `goal-state`, without a separate prompt-removal event.

Each audit invokes a new evaluator-only adversarial loop with `maxIterations: 0`; this internal mode does not run a generator and does not change the public tool's `maxIterations` range. Each audit derives fresh criteria from the goal task and current workspace rather than carrying criteria forward from a previous audit. Audit usage remains in the child archive, not the background-task ledger. Audits reserve an exclusive slot in the same pool and block new loop submissions while inspecting the workspace. When a goal is active, `/goal stop` cancels background loops and prevents automatic wakeups as well as stopping the audit/main agent. Ordinary user input is blocked while an audit is inspecting the workspace, but `/goal status` and `/goal stop` remain available. Errors and unverified results never mark the goal complete.

The default automatic continuation limit is `5`: up to five audit-feedback follow-ups after the initial run. A failed audit after that budget is used marks the goal `exhausted`; acceptance on that audit still completes it. Configure the limit with a positive safe integer; invalid values produce a warning and fall back to `5`:

```bash
pi --adversarial-loop-goal-max-continuations 40
```

For example, tell the parent agent directly:

> Use adversarial loop to implement a user login endpoint and ensure that the existing tests pass.

> Use adversarial loop to produce a review-ready architecture proposal in docs/architecture.md. Cover alternatives, trade-offs, migration steps, risks, and rollback strategy, and make it polished enough to enter review immediately.

## Current Base-Version Limitations

- The evaluator and generator currently use the same model and thinking level.
- The evaluator may use `edit` and `write` to save intermediate materials and may run `bash` for verification. Currently, a system prompt is the primary mechanism preventing it from modifying workspace deliverables; OS-level write isolation has not yet been implemented.
- A subprocess failure or a model error remaining after pi's retry handling terminates that background task with an `error` result without cancelling independent siblings. Evaluator parsing failures receive up to two corrective prompts in the same RPC session; RPC failures and missing final output do not use those structured-output retries. A valid non-passing evaluation continues the loop until the safety limit.
- Criteria normalization inspects at most 12 criteria and 16 feedback items; most text fields have a 2 KiB content budget. The prohibition on weakening criteria is prompt-based, not a semantic check enforced by the controller.
- Generator reports and formatted result bodies have content budgets of 12 KiB and 48 KiB respectively, plus truncation markers where needed. Child session JSONL retains the full conversation.
