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

test("creates and persists a Goal, sends only a kickoff, and injects its task", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.command("Implement the feature");

  const goal = latestGoal(harness.entries);
  assert.equal(goal?.id, "goal-1");
  assert.equal(goal?.task, "Implement the feature");
  assert.equal(goal?.status, "running");
  assert.deepEqual(harness.sent, [
    { content: "Start working on the current Goal.", options: undefined },
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
  assert.doesNotMatch(harness.sent[0].content, /Implement the feature/);

  await harness.emit("session_compact", { type: "session_compact" });
  const [afterCompaction] = await harness.emit("before_agent_start", {
    systemPrompt: "compacted base",
  });
  assert.match(
    (afterCompaction as { systemPrompt: string }).systemPrompt,
    /Implement the feature/,
  );
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
});

test("runs an evaluator-only loop after agent_end and queues feedback", async () => {
  const harness = createHarness();
  await harness.emit("session_start");
  await harness.command("Finish the task");
  harness.setIdle(false);
  await harness.emit("agent_end", agentEndEvent());

  assert.equal(harness.auditOptions.length, 1);
  assert.equal(harness.auditOptions[0].maxIterations, 0);
  assert.equal(harness.auditOptions[0].task, "Finish the task");
  const goal = latestGoal(harness.entries);
  assert.equal(goal?.status, "running");
  assert.equal(goal?.continuationCount, 1);
  assert.equal(harness.sent.at(-1)?.options?.deliverAs, "followUp");
  assert.match(harness.sent.at(-1)?.content ?? "", /Finish the missing work/);
});

test("completes on evaluator acceptance and stops at the continuation limit", async () => {
  const accepted = createHarness({
    runLoop: async (options) => loopResult(true, options),
  });
  await accepted.emit("session_start");
  await accepted.command("Accepted task");
  accepted.setIdle(false);
  await accepted.emit("agent_end", agentEndEvent());
  assert.equal(latestGoal(accepted.entries)?.status, "completed");
  assert.equal(accepted.sent.length, 1);

  const limited = createHarness({ maxContinuations: 1 });
  await limited.emit("session_start");
  await limited.command("Limited task");
  limited.setIdle(false);
  await limited.emit("agent_end", agentEndEvent());
  await limited.emit("agent_end", agentEndEvent());
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
  const auditPromise = harness.emit("agent_end", agentEndEvent());
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
