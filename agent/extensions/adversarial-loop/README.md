# Adversarial Loop

`adversarial_loop` is an evaluator-generator delivery workflow. It uses independent, temporary pi agents to repeatedly produce, review, and improve deliverables in the workspace until they satisfy the acceptance criteria.

It is intended for tasks that meet either of the following descriptions:

- They have strict completion requirements and need independent, criterion-by-criterion validation.
- They demand a high degree of completeness, accuracy, coherence, usability, or polish and therefore benefit from multiple rounds of production and review.

Deliverables may include code, documentation, specifications, reports, proposals, analyses, configuration, or any other artifact that can be written to the workspace and inspected. Simple questions and minor edits generally do not justify starting a loop.

## Workflow

1. The first **evaluator** inspects the current workspace, derives concrete and observable acceptance criteria from the task, and returns them in the JSON `criteria` field. In addition to correctness and hard constraints, the criteria may cover completeness, audience fit, usability, evidence, and production quality as appropriate for the task. After parsing the criteria, the controller writes them to `task-spec.md` as a process record. If the evaluator's final structured output cannot be parsed, the controller sends a corrective prompt in the same RPC session. By default, it retries up to twice, allowing at most three outputs in total: the initial output plus two retries.
2. If the task does not pass, a new **generator** directly creates or improves the deliverables according to the current acceptance criteria and evaluator feedback, then runs any applicable checks or reviews.
3. The next iteration starts a fresh evaluator. It receives the previous generator's response as untrusted context about changes and checks, but independently determines completion using only the original task, the current acceptance criteria, the current deliverables, and its own verification results. Later evaluators normally do not return `criteria`. They return a complete replacement set in `updated_criteria` only when inspection or verification reveals a genuine need to correct, clarify, deduplicate, or add an omitted requirement already implied by the original task. Updates must not weaken requirements merely to let the current deliverables pass, nor may they introduce unrelated scope.
4. The loop ends when all criteria pass. If they never pass, the loop explicitly reports failure at the safety limit rather than falsely claiming completion.

Each child agent starts in RPC mode with a fresh, independent session. The `--session-dir` option stores session JSONL in the corresponding iteration's `evaluator/` or `generator/` directory, so child agents do not inherit conversation context from the parent agent or a previous child agent. The RPC subprocess remains alive until the agent finishes, allowing a corrective user prompt to be sent in the same session if the evaluator produces invalid structured output. It then exits cleanly when stdin is closed. To support headless execution and prevent project extensions from blocking, RPC dialog requests for `select`, `confirm`, `input`, and `editor` are automatically canceled. Child agents inherit the current model and thinking level from the parent session:

- Evaluator base tools: `read,bash,edit,write,grep,find,ls`
- Generator base tools: `read,bash,edit,write,grep,find,ls`
- If the parent session trusts the project, both types of child agent resolve the project's enabled extensions using only `<workspace>/.pi/settings.json` and the auto-discovered entries under `<workspace>/.pi/extensions/`. This includes already-installed npm, git, and local packages configured in the project's `packages` list, project-level `extensions` paths, package filters, and ordinary project-local extensions.
- User/global extension configuration is ignored.

The subprocess still uses `--no-extensions` to disable automatic extension discovery, then explicitly loads only the trusted project's resolved extension paths plus an internal extension that restores the base toolset. Tools registered by project extensions are available by default, except for `adversarial_loop`, which is excluded to prevent child agents from recursively starting new loops. The workflow does not install missing plugins from the network; project packages must already be installed, as they normally are during trusted project startup. Project extensions run with the current user's permissions, just like ordinary pi extensions, so only reviewed code should be trusted and loaded.

The evaluator's `edit` and `write` tools are intended only for saving its own intermediate evaluation materials; it should not modify workspace deliverables. The acceptance criteria established in the first iteration serve as a stable baseline for subsequent evaluations, but later evaluators may submit a complete replacement set through `updated_criteria` when genuinely necessary. When no update is needed, they may omit both `criteria` and `updated_criteria`. The controller writes the latest criteria to `task-spec.md`. Whenever the criteria change, it archives both the old and new sets in `criteria-revisions.jsonl`. These control files exist only as process records, and their presence and paths are not disclosed to child agents. The generator directly receives the task, current acceptance criteria, and evaluator feedback. Later evaluators receive the previous generator response as untrusted context, but must verify its claims themselves and independently evaluate the task against the criteria and current workspace.

## Loop Archive

Each loop creates a unique directory under `workspace/.adversarial-loop/` when it starts. Control files and non-deliverable intermediate results are retained after child agents exit:

```text
.adversarial-loop/<loop-id>/
├── original-task.md
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

- `criteria-revisions.jsonl`: Created only when a later evaluator first returns a valid `updated_criteria`. Each subsequent update appends one line recording the iteration, the old criteria, and the complete new criteria, ensuring that older versions are not lost when `task-spec.md` is updated. The file is not created if the criteria never change.
- `evaluator-results.jsonl`: Each line records the normalized structured result of one evaluator iteration. It also records errors when structured output still cannot be parsed after the default two in-session corrections, when the subprocess fails, or when another parsing error occurs. The `result.json` in each agent directory records the actual number of structured-output retries in `outputRetries`.
- `generator-results.jsonl`: Each line records a generator work summary, stop reason, or error.
- Every iteration pre-creates separate `evaluator/` and `generator/` directories. Child-agent sessions use filenames in the form `session-<UTC timestamp>-<random>.jsonl` (for example, `session-20260826T032957Z-ALBXrg.jsonl`). These files contain user prompts, conversation messages, tool-call arguments, and results, making them complete session records. `events.jsonl` stores only a compact execution timeline, including agent and turn lifecycle events, tool names and success states, compaction events, and retry diagnostics. It does not duplicate message bodies, streaming deltas, tool arguments, or tool results. Final responses, diagnostics, and task-related intermediate materials explicitly saved by an agent are also retained in the corresponding directory. Role-specific system prompts are injected directly through CLI arguments.
- `stderr-full.log` contains the subprocess's raw, untruncated stderr byte stream. `stderr.log` contains the same diagnostic summary written to `result.json`, limited to 8 KiB, and may additionally include controller diagnostics for RPC protocol, stdin, spawn, or archival errors. Neither file is created when its corresponding content is empty.

`.adversarial-loop/` is a workflow archive, not part of the task deliverables. Its `task-spec.md` is the controller-generated record of acceptance criteria. Child agents should ignore archive contents and must not treat them as deliverables or modify other agents' directories.

## Code Structure

- `index.ts`: Tool registration, parameter schemas, and pi context adaptation.
- `config.ts`: Default and CLI-configured maximum parallel loop count validation.
- `core.ts`: Single-loop and concurrent batch orchestration, plus final result formatting.
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

Multiple independent loops can run concurrently in a single tool call. The default maximum is `6` loops:

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
- `loops[].maxIterations`: Maximum number of generator runs. Defaults to `6`; allowed range: `1-20`. A final evaluator still runs after the last generator iteration.

Concurrent loops share the current workspace and may run generators at the same time. Assign each loop a non-overlapping set of directories or files. Tasks with dependencies or tasks that modify the same files should run serially in a single loop.

To change the maximum number of loops accepted in one tool call, start pi with the extension flag below. The value must be a positive integer:

```bash
pi --adversarial-loop-max-loops 10
```

## Goal Mode

`/goal` runs the main agent toward a persistent goal and independently audits the workspace whenever that agent run ends. The goal task is carried in the system prompt; the extension sends only a short kickoff user message to start the run. If the evaluator does not accept the result, its failed checks and feedback are queued as a follow-up and the main agent continues automatically.

```text
/goal Implement the requested feature and verify it with the project tests
/goal status
/goal stop
/goal resume
```

Goal state is appended to the current session as `goal-state` custom entries. It is restored from the active session branch after reloads, resumes, forks, and tree navigation. A previously running goal is restored as interrupted rather than starting work unexpectedly; `/goal resume` assigns it a new unique ID and a fresh continuation budget. An active or auditing goal blocks creation of another goal.

Each audit invokes an evaluator-only adversarial loop with `maxIterations: 0`; this internal mode does not run a generator and does not change the public tool's `maxIterations` range. Ordinary user input is blocked while an audit is inspecting the workspace, but `/goal status` and `/goal stop` remain available. Errors and unverified results never mark the goal complete.

The default automatic continuation limit is 25. Configure it with a positive integer:

```bash
pi --adversarial-loop-goal-max-continuations 40
```

For example, tell the parent agent directly:

> Use adversarial loop to implement a user login endpoint and ensure that the existing tests pass.

> Use adversarial loop to produce a review-ready architecture proposal in docs/architecture.md. Cover alternatives, trade-offs, migration steps, risks, and rollback strategy, and make it polished enough to enter review immediately.

## Current Base-Version Limitations

- The evaluator and generator currently use the same model and thinking level.
- The evaluator may use `edit` and `write` to save intermediate materials and may run `bash` for verification. Currently, a system prompt is the primary mechanism preventing it from modifying workspace deliverables; OS-level write isolation has not yet been implemented.
- A subprocess or model error terminates the workflow and reports a tool error. Invalid evaluator structured output is retried twice by default in the same RPC session before the workflow terminates. In concurrent mode, a terminal error also cancels the other loops. If a task does not pass, the loop continues until the safety limit.
- Each child agent's final report and the tool's final output have length limits to prevent the parent conversation context from growing excessively large.
