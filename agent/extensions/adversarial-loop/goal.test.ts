import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { parseGoalState, registerGoalFeature } from "./goal.ts";
import type { Evaluation, GoalState, RunLoopOptions } from "./types.ts";
import { emptyUsage } from "./utils.ts";

function evaluation(completed: boolean): Evaluation {
  return {
    criteria: [
      {
        id: "C1",
        description: "The task is complete",
        verification: "Inspect the workspace",
      },
    ],
    checks: [
      {
        criterionId: "C1",
        status: completed ? "pass" : "fail",
        evidence: completed ? "Verified" : "Still missing",
      },
    ],
    completed,
    feedback: completed ? [] : ["Finish the missing work"],
    summary: completed ? "Accepted" : "Incomplete",
  };
}

function loopResult(completed: boolean, options: RunLoopOptions) {
  const result = evaluation(completed);
  return {
    details: {
      status: completed ? ("completed" as const) : ("exhausted" as const),
      task: options.task,
      model: options.model,
      loopDirectory: "/workspace/.adversarial-loop/audit",
      maxIterations: options.maxIterations,
      criteria: result.criteria,
      rounds: [{ round: 1, evaluation: result }],
    },
    usage: emptyUsage(),
    latestGeneratorReport: undefined,
  };
}

function createHarness(options?: {
  maxContinuations?: number;
  canAudit?: () => boolean;
  onStop?: () => void;
  ids?: string[];
  initialEntries?: Array<Record<string, unknown>>;
  runLoop?: (options: RunLoopOptions) => Promise<ReturnType<typeof loopResult>>;
}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  let commandHandler:
    ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const entries = [...(options?.initialEntries ?? [])];
  const sent: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const auditOptions: RunLoopOptions[] = [];
  const ids = [...(options?.ids ?? ["goal-1", "goal-2"])];
  let idle = true;
  let abortCount = 0;

  const runLoop =
    options?.runLoop ??
    (async (input: RunLoopOptions) => {
      auditOptions.push(input);
      return loopResult(false, input);
    });

  const pi = {
    registerCommand(
      name: string,
      definition: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      if (name === "goal") commandHandler = definition.handler;
    },
    on(event: string, handler: (event: any, ctx: any) => any) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage(content: string, sendOptions?: { deliverAs?: string }) {
      sent.push({ content, options: sendOptions });
    },
  } as unknown as ExtensionAPI;

  registerGoalFeature(pi, {
    getMaxContinuations: () => options?.maxContinuations ?? 25,
    canAudit: options?.canAudit,
    onStop: options?.onStop,
    createId: () => ids.shift() ?? "fallback-id",
    now: () => "2026-01-01T00:00:00.000Z",
    runLoop: async (input) => {
      if (options?.runLoop) auditOptions.push(input);
      return runLoop(input);
    },
  });

  const ctx = {
    cwd: "/workspace",
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    sessionManager: { getBranch: () => entries },
    isProjectTrusted: () => true,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort: () => {
      abortCount++;
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (_key: string, value: string | undefined) => {
        statuses.push(value);
      },
    },
  } as unknown as ExtensionCommandContext;

  const emit = async (event: string, payload: unknown = {}) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(payload, ctx as ExtensionContext));
    }
    return results;
  };

  return {
    auditOptions,
    command: async (args: string) => {
      assert.ok(commandHandler);
      await commandHandler(args, ctx);
    },
    ctx,
    emit,
    finishRun: async (stopReason = "stop") => {
      await emit("agent_end", agentEndEvent(stopReason));
      idle = true;
      await emit("agent_settled");
    },
    entries,
    get abortCount() {
      return abortCount;
    },
    notifications,
    sent,
    setIdle(value: boolean) {
      idle = value;
    },
    statuses,
  };
}

function latestGoal(entries: Array<Record<string, unknown>>) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === "goal-state") {
      const parsed = parseGoalState(entry.data);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

function promptEntries(entries: Array<Record<string, unknown>>) {
  return entries.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === "goal-system-prompt",
  );
}

function agentEndEvent(stopReason = "stop") {
  return {
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Work report" }],
        stopReason,
      },
    ],
  };
}

test("creates and persists a Goal with its task in both user and system prompts", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.command("Implement the feature");

  const goal = latestGoal(harness.entries);
  assert.equal(goal?.id, "goal-1");
  assert.equal(goal?.task, "Implement the feature");
  assert.equal(goal?.status, "running");
  assert.deepEqual(harness.sent, [
    {
      content: "Start working on the current Goal.\n\nOriginal task:\nImplement the feature",
      options: undefined,
    },
  ]);

  const [promptResult] = await harness.emit("before_agent_start", {
    systemPrompt: "base",
  });
  assert.match(
    (promptResult as { systemPrompt: string }).systemPrompt,
    /Implement the feature/,
  );
  assert.doesNotMatch(
    (promptResult as { systemPrompt: string }).systemPrompt,
    /Do not proactively call adversarial_loop|Only an independent audit can complete the Goal/,
  );
  assert.ok(harness.statuses.some((status) => status?.includes("running")));
  assert.match(harness.sent[0].content, /Implement the feature/);

  await harness.emit("session_compact", { type: "session_compact" });
  const [afterCompaction] = await harness.emit("before_agent_start", {
    systemPrompt: "compacted base",
  });
  assert.match(
    (afterCompaction as { systemPrompt: string }).systemPrompt,
    /Implement the feature/,
  );
});

test("records full Goal prompts only when the latest snapshot differs", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.command("Task");
  assert.equal(promptEntries(harness.entries).length, 0);

  const [first] = await harness.emit("before_agent_start", {
    systemPrompt: "base",
  });
  const firstSnapshot = promptEntries(harness.entries)[0];
  assert.deepEqual(firstSnapshot.data, {
    version: 1,
    goalId: "goal-1",
    continuationCount: 0,
    systemPrompt: (first as { systemPrompt: string }).systemPrompt,
  });
  const [repeated] = await harness.emit("before_agent_start", {
    systemPrompt: "base",
  });
  assert.deepEqual(repeated, first);
  assert.equal(promptEntries(harness.entries).length, 1);

  const [changed] = await harness.emit("before_agent_start", {
    systemPrompt: "changed base",
  });
  assert.equal(promptEntries(harness.entries).length, 2);
  assert.deepEqual(promptEntries(harness.entries)[1].data, {
    ...(firstSnapshot.data as Record<string, unknown>),
    systemPrompt: (changed as { systemPrompt: string }).systemPrompt,
  });

  // Compare with the latest snapshot, not every prompt ever recorded.
  await harness.emit("before_agent_start", { systemPrompt: "base" });
  assert.equal(promptEntries(harness.entries).length, 3);
  assert.deepEqual(promptEntries(harness.entries)[2], firstSnapshot);
  assert.equal(latestGoal(harness.entries)?.status, "running");
});

test("records continuation and resumed Goal ID changes", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.command("Task");
  await harness.emit("before_agent_start", { systemPrompt: "base" });
  await harness.finishRun();
  assert.equal(promptEntries(harness.entries).length, 1);
  await harness.emit("before_agent_start", { systemPrompt: "base" });
  const continued = promptEntries(harness.entries)[1].data as {
    goalId: string;
    continuationCount: number;
    systemPrompt: string;
  };
  assert.equal(continued.goalId, "goal-1");
  assert.equal(continued.continuationCount, 1);
  assert.match(continued.systemPrompt, /continuation: 1\/25/);

  await harness.command("stop");
  await harness.command("resume");
  await harness.emit("before_agent_start", { systemPrompt: "base" });
  const resumed = promptEntries(harness.entries)[2].data as typeof continued;
  assert.equal(resumed.goalId, "goal-2");
  assert.equal(resumed.continuationCount, 0);
  assert.match(resumed.systemPrompt, /goal_id: goal-2/);
  assert.equal(promptEntries(harness.entries).length, 3);
});

test("restores only the current branch's latest valid prompt as a deduplication baseline", async () => {
  const source = createHarness();
  await source.command("Task");
  await source.emit("before_agent_start", { systemPrompt: "base" });
  const snapshot = promptEntries(source.entries)[0];
  const data = snapshot.data as Record<string, unknown>;
  const invalidSnapshots = [
    null,
    [],
    { ...data, version: 2 },
    { ...data, goalId: "" },
    { ...data, goalId: 1 },
    { ...data, continuationCount: -1 },
    { ...data, continuationCount: 0.5 },
    { ...data, continuationCount: "0" },
    { ...data, systemPrompt: null },
  ].map((data) => ({ ...snapshot, data }));

  for (const event of ["session_start", "session_tree"]) {
    // Reuse deterministic IDs to reproduce identical prompt text after restore.
    const harness = createHarness({ ids: Array(5).fill("goal-1") });
    const selectBranch = async (branch: Array<Record<string, unknown>>) => {
      harness.entries.splice(0, harness.entries.length, ...branch);
      await harness.emit(event);
      await harness.command("Task");
      await harness.emit("before_agent_start", { systemPrompt: "base" });
    };

    const olderSnapshot = {
      ...snapshot,
      data: { ...data, systemPrompt: "older snapshot" },
    };
    const branch = [olderSnapshot, snapshot, ...invalidSnapshots];
    await selectBranch(branch);
    assert.equal(promptEntries(harness.entries).length, branch.length);

    // A different branch must replace the cached baseline, not replay it.
    await selectBranch([olderSnapshot]);
    assert.equal(promptEntries(harness.entries).length, 2);
    assert.deepEqual(promptEntries(harness.entries).at(-1), snapshot);

    // Even though another branch recorded the same prompt, this one has not.
    await selectBranch([]);
    assert.deepEqual(promptEntries(harness.entries), [snapshot]);

    // Invalid entries alone cannot supply a baseline.
    await selectBranch(invalidSnapshots);
    assert.equal(
      promptEntries(harness.entries).length,
      invalidSnapshots.length + 1,
    );
    assert.deepEqual(promptEntries(harness.entries).at(-1), snapshot);
  }
});

test("does not record or replay prompts for inactive Goals and clears on shutdown", async () => {
  const harness = createHarness({ ids: ["goal-1", "goal-1"] });
  await harness.emit("session_start");
  assert.deepEqual(
    await harness.emit("before_agent_start", { systemPrompt: "base" }),
    [undefined],
  );
  assert.equal(promptEntries(harness.entries).length, 0);
  await harness.command("Task");
  await harness.emit("before_agent_start", { systemPrompt: "base" });
  await harness.command("stop");
  assert.deepEqual(
    await harness.emit("before_agent_start", { systemPrompt: "base" }),
    [undefined],
  );
  assert.equal(promptEntries(harness.entries).length, 1);

  await harness.emit("session_shutdown");
  await harness.command("Task");
  await harness.emit("before_agent_start", { systemPrompt: "base" });
  assert.equal(promptEntries(harness.entries).length, 2);

  // Existing Goal restoration still interrupts the Goal; snapshots do not run it.
  await harness.emit("session_start");
  assert.equal(latestGoal(harness.entries)?.status, "interrupted");
  assert.deepEqual(
    await harness.emit("before_agent_start", { systemPrompt: "new base" }),
    [undefined],
  );
  assert.equal(promptEntries(harness.entries).length, 2);
});

test("rejects a second active Goal and resume assigns a new id", async () => {
  const harness = createHarness({ ids: ["first-id", "resumed-id"] });
  await harness.emit("session_start");
  await harness.command("First task");
  await harness.command("Second task");
  assert.equal(harness.sent.length, 1);
  assert.ok(
    harness.notifications.some((message) =>
      /before creating another/.test(message),
    ),
  );

  await harness.command("stop");
  assert.equal(latestGoal(harness.entries)?.status, "stopped");
  await harness.command("resume");
  const resumed = latestGoal(harness.entries);
  assert.equal(resumed?.id, "resumed-id");
  assert.equal(resumed?.previousId, "first-id");
  assert.equal(resumed?.continuationCount, 0);
  assert.equal(harness.sent.length, 2);
  assert.equal(
    harness.sent[1].content,
    "Start working on the current Goal.\n\nOriginal task:\nFirst task",
  );
});

test("runs an evaluator-only loop only after agent_settled and queues feedback", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.command("Finish the task");
  harness.setIdle(false);
  await harness.emit("agent_end", agentEndEvent());
  assert.equal(harness.auditOptions.length, 0);
  harness.setIdle(true);
  await harness.emit("agent_settled");

  assert.equal(harness.auditOptions.length, 1);
  assert.equal(harness.auditOptions[0].maxIterations, 0);
  assert.equal(harness.auditOptions[0].task, "Finish the task");
  const goal = latestGoal(harness.entries);
  assert.equal(goal?.status, "running");
  assert.equal(goal?.continuationCount, 1);
  assert.equal(harness.sent.at(-1)?.options?.deliverAs, "followUp");
  assert.equal(
    harness.sent.at(-1)?.content,
    [
      "Continue working on the current Goal.",
      "",
      "Original task:",
      "Finish the task",
      "",
      "Audit summary: Incomplete",
      "",
      "Checks not yet passing:",
      "- C1 [fail]: Still missing",
      "",
      "Required follow-up:",
      "- Finish the missing work",
    ].join("\n"),
  );
});

test("completes on evaluator acceptance and stops at the continuation limit", async () => {
  const accepted = createHarness({
    runLoop: async (options) => loopResult(true, options),
  });
  await accepted.emit("session_start");
  await accepted.command("Accepted task");
  accepted.setIdle(false);
  await accepted.finishRun();
  assert.equal(latestGoal(accepted.entries)?.status, "completed");
  assert.equal(accepted.sent.length, 1);

  const limited = createHarness({ maxContinuations: 1 });
  await limited.emit("session_start");
  await limited.command("Limited task");
  limited.setIdle(false);
  await limited.finishRun();
  await limited.finishRun();
  assert.equal(latestGoal(limited.entries)?.status, "exhausted");
  assert.equal(limited.sent.length, 2);
});

test("restores an active Goal as interrupted and resumes with a new id", async () => {
  const state: GoalState = {
    version: 1,
    id: "old-id",
    task: "Persisted task",
    status: "auditing",
    continuationCount: 4,
    maxContinuations: 25,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
  const harness = createHarness({
    ids: ["new-id"],
    initialEntries: [{ type: "custom", customType: "goal-state", data: state }],
  });
  await harness.emit("session_start");
  assert.equal(latestGoal(harness.entries)?.status, "interrupted");
  await harness.command("resume");
  assert.equal(latestGoal(harness.entries)?.id, "new-id");
  assert.equal(latestGoal(harness.entries)?.continuationCount, 0);
  assert.equal(
    harness.sent[0].content,
    "Start working on the current Goal.\n\nOriginal task:\nPersisted task",
  );
});

test("preserves a multiline task across kickoff, continuations, and restored resume", async () => {
  const task = '实现 "feature"。\n\n- Keep `existing behavior`\n- Verify edge cases';
  const harness = createHarness();
  await harness.command(task);
  await harness.finishRun();
  await harness.finishRun();
  assert.equal(harness.sent.length, 3);
  for (const message of harness.sent) {
    assert.ok(message.content.includes(`Original task:\n${task}`));
  }

  const restored = createHarness({ initialEntries: harness.entries });
  await restored.emit("session_start");
  await restored.command("resume");
  assert.equal(
    restored.sent[0].content,
    `Start working on the current Goal.\n\nOriginal task:\n${task}`,
  );
});

test("blocks ordinary input while auditing but allows extension follow-ups", async () => {
  let resolveAudit:
    ((value: ReturnType<typeof loopResult>) => void) | undefined;
  const harness = createHarness({
    runLoop: (options) =>
      new Promise((resolve) => {
        resolveAudit = resolve;
        void options;
      }),
  });
  await harness.emit("session_start");
  await harness.command("Long audit task");
  harness.setIdle(false);
  const auditPromise = harness.finishRun();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(latestGoal(harness.entries)?.status, "auditing");

  const originalNotifyCount = harness.notifications.length;
  const [inputResult] = await harness.emit("input", {
    type: "input",
    text: "new user work",
    source: "interactive",
  });
  assert.deepEqual(inputResult, { action: "handled" });
  assert.equal(harness.notifications.length, originalNotifyCount + 1);
  const [extensionInputResult] = await harness.emit("input", {
    type: "input",
    text: "controller follow-up",
    source: "extension",
  });
  assert.equal(extensionInputResult, undefined);

  assert.ok(resolveAudit);
  resolveAudit(loopResult(false, harness.auditOptions[0]));
  await auditPromise;
  assert.equal(latestGoal(harness.entries)?.status, "running");
});

test("defers Goal audit until background work and pending results are integrated", async () => {
  let ready = false;
  const harness = createHarness({ canAudit: () => ready });
  await harness.emit("session_start");
  await harness.command("Task with background work");
  await harness.finishRun("toolUse");
  assert.equal(harness.auditOptions.length, 0);
  assert.equal(latestGoal(harness.entries)?.continuationCount, 0);
  ready = true;
  // Finishing the last background loop alone must not audit the workspace.
  await harness.emit("agent_settled");
  assert.equal(harness.auditOptions.length, 0);
  await harness.finishRun();
  assert.equal(harness.auditOptions.length, 1);
});

test("Goal stop also stops owned background work", async () => {
  let stops = 0;
  const harness = createHarness({
    onStop: () => {
      stops++;
    },
  });
  await harness.emit("session_start");
  await harness.command("Task");
  await harness.command("stop");
  assert.equal(stops, 1);
  assert.equal(latestGoal(harness.entries)?.status, "stopped");
});

test("skips audits for aborted and errored runs and resolves them after retries settle", async () => {
  const aborted = createHarness();
  await aborted.emit("session_start");
  await aborted.command("Task");
  await aborted.emit("agent_end", agentEndEvent("aborted"));
  assert.equal(aborted.auditOptions.length, 0);
  await aborted.emit("agent_settled", { type: "agent_settled" });
  assert.equal(latestGoal(aborted.entries)?.status, "interrupted");

  const errored = createHarness();
  await errored.emit("session_start");
  await errored.command("Task");
  await errored.emit("agent_end", agentEndEvent("error"));
  assert.equal(errored.auditOptions.length, 0);
  await errored.emit("agent_settled", { type: "agent_settled" });
  assert.equal(latestGoal(errored.entries)?.status, "error");
});
