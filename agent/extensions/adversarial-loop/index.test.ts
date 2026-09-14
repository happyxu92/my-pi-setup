import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import adversarialLoopExtension from "./index.ts";
import type { RunLoopOptions } from "./types.ts";
import { emptyUsage } from "./utils.ts";

function loopResult(options: RunLoopOptions) {
  return {
    details: {
      status: "completed" as const,
      task: options.task,
      model: options.model,
      maxIterations: options.maxIterations,
      criteria: [],
      rounds: [],
    },
    usage: emptyUsage(),
    latestGeneratorReport: undefined,
  };
}

async function loadExtension(flagValue = "6", goalFlagValue = "25") {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void>
  >();
  const notifications: string[] = [];
  const entries: Array<Record<string, unknown>> = [];
  const sent: Array<Parameters<ExtensionAPI["sendMessage"]>[0]> = [];
  const executions: Array<{ options: RunLoopOptions; resolve: () => void }> =
    [];
  let idle = false;

  const pi = {
    registerFlag() {},
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    registerCommand(
      name: string,
      definition: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commands.set(name, definition.handler);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0]) {
      sent.push(message);
    },
    sendUserMessage() {},
    getFlag(name: string) {
      return name === "adversarial-loop-max-loops" ? flagValue : goalFlagValue;
    },
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  } as unknown as ExtensionAPI;

  adversarialLoopExtension(pi, {
    saveResult: async () => {},
    runLoop: (options) =>
      new Promise((resolve, reject) => {
        executions.push({
          options,
          resolve: () => resolve(loopResult(options)),
        });
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        );
      }),
  });
  const ctx = {
    cwd: "/workspace",
    mode: "tui",
    hasUI: true,
    model: { provider: "fake", id: "model" },
    thinkingLevel: "high",
    isProjectTrusted: () => true,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort() {},
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}) => {
    const values = [];
    for (const handler of handlers.get(name) ?? [])
      values.push(await handler(event, ctx));
    return values;
  };
  const tool = (name: string) => {
    const definition = tools.filter((tool) => tool.name === name).at(-1);
    assert.ok(definition);
    return definition;
  };
  const call = async (
    name: string,
    params: Record<string, unknown> = {},
    id = `${name}-${entries.length}`,
    siblings: string[] = [],
  ) => {
    entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id, name, arguments: params },
          ...siblings.map((name, index) => ({
            type: "toolCall",
            id: `sibling-${index}`,
            name,
            arguments: {},
          })),
        ],
      },
    });
    const result = await tool(name).execute(
      id,
      params,
      undefined,
      undefined,
      ctx,
    );
    const message = {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      ...result,
    };
    entries.push({ type: "message", message });
    await emit("message_end", { type: "message_end", message });
    return result;
  };
  await emit("session_start");
  return {
    tools,
    tool,
    call,
    notifications,
    executions,
    entries,
    emit,
    ctx,
    commands,
    sent,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

const details = (result: { details: unknown }) =>
  result.details as {
    waiting?: boolean;
    reason?: string;
    loops: Array<{ id: string; status: string }>;
    capacity: { active: number; available: number };
  };
const maximumLoops = (tool: ToolDefinition) =>
  (
    tool.parameters as unknown as {
      properties: { loops: { maxItems: number } };
    }
  ).properties.loops.maxItems;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const notifyTick = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 45));

test("registers exactly the start, wait and manage tools and applies the session limit", async () => {
  const h = await loadExtension("10");
  assert.deepEqual(
    [...new Set(h.tools.map((tool) => tool.name))],
    ["adversarial_loop", "adversarial_loop_wait", "adversarial_loop_manage"],
  );
  assert.equal(maximumLoops(h.tools[0]), 6);
  assert.equal(maximumLoops(h.tool("adversarial_loop")), 10);
  assert.deepEqual(h.notifications, []);
  await h.emit("session_shutdown");
});

test("LLM-facing guidance and messages omit scheduling mechanics but retain usage constraints", async () => {
  const h = await loadExtension();
  const mechanics =
    /at most one|more than one|only one|buffer|threshold|drain/i;
  for (const name of [
    "adversarial_loop",
    "adversarial_loop_wait",
    "adversarial_loop_manage",
  ]) {
    const tool = h.tool(name);
    assert.doesNotMatch(
      [
        tool.description,
        tool.promptSnippet,
        ...(tool.promptGuidelines ?? []),
      ].join("\n"),
      mechanics,
    );
    if (name !== "adversarial_loop_manage")
      assert.match(tool.description, /ONLY tool call/);
  }
  const first = await h.call("adversarial_loop", { loops: [{ task: "A" }] });
  const second = await h.call("adversarial_loop", { loops: [{ task: "B" }] });
  for (const result of [first, second]) {
    assert.doesNotMatch(JSON.stringify(result.content), mechanics);
    assert.match(
      JSON.stringify(result.content),
      /Submission is not acceptance/,
    );
    assert.match(
      JSON.stringify(result.content),
      /Results will arrive automatically/,
    );
  }
  assert.equal(first.terminate, false);
  assert.equal(second.terminate, true);
  await h.emit("input");
  const waited = await h.call("adversarial_loop_wait");
  assert.equal(waited.terminate, true);
  assert.doesNotMatch(JSON.stringify(waited.content), mechanics);
  await h.emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "toolUse" }],
  });
  h.setIdle(true);
  await h.emit("agent_settled");
  h.executions[0].resolve();
  await notifyTick();
  assert.equal(h.sent.length, 1);
  assert.doesNotMatch(String(h.sent[0].content), mechanics);
  assert.match(
    String(h.sent[0].content),
    /Some background loop results are ready/,
  );
  await h.emit("session_shutdown");
});

test("invalid flags fall back to default limits with warnings", async () => {
  const h = await loadExtension("0", "0");
  assert.equal(maximumLoops(h.tool("adversarial_loop")), 6);
  assert.ok(h.notifications.some((message) => /using 6/.test(message)));
  assert.ok(h.notifications.some((message) => /using 25/.test(message)));
  await h.emit("session_shutdown");
});

test("start returns immediately, independent calls share capacity, and wait terminates without blocking", async () => {
  const h = await loadExtension("1");
  const started = await h.call("adversarial_loop", { loops: [{ task: "A" }] });
  assert.equal(started.terminate, false);
  assert.equal(details(started).reason, "at_most_one_active_loop");
  assert.equal(details(started).capacity.active, 1);
  assert.equal(details(started).loops.length, 1);
  await assert.rejects(
    h.call("adversarial_loop", { loops: [{ task: "B" }] }),
    /capacity exceeded/,
  );
  const waited = await h.call("adversarial_loop_wait");
  assert.equal(waited.terminate, true);
  assert.equal(details(waited).waiting, true);
  assert.equal(details(waited).reason, "waiting_for_results");
  assert.match(JSON.stringify(waited.content), /Main agent yielded/);
  assert.equal(h.executions.length, 1);
  await h.emit("session_shutdown");
});

test("wait must be the only tool call, including when all siblings are waits", async () => {
  const h = await loadExtension();
  for (const sibling of ["bash", "adversarial_loop", "adversarial_loop_wait"]) {
    await assert.rejects(
      h.call("adversarial_loop_wait", {}, "wait", [sibling]),
      /only tool call/,
    );
  }
  const empty = await h.call("adversarial_loop_wait");
  assert.equal(empty.terminate, false);
  assert.equal(details(empty).waiting, false);
  assert.equal(details(empty).reason, "no_active_loops");
  assert.match(
    JSON.stringify(empty.content),
    /Not waiting: no active loops remain\./,
  );
  assert.doesNotMatch(
    JSON.stringify(empty.content),
    /another message is pending/,
  );
  await h.emit("session_shutdown");
});

test("wait reports pending messages using the notifier decision without rechecking", async () => {
  const h = await loadExtension();
  await h.call("adversarial_loop", { loops: [{ task: "A" }] });
  let pendingChecks = 0;
  h.ctx.hasPendingMessages = () => ++pendingChecks === 1;
  const result = await h.call("adversarial_loop_wait");
  assert.equal(result.terminate, false);
  assert.equal(details(result).waiting, false);
  assert.equal(details(result).reason, "pending_messages");
  assert.deepEqual(details(result).loops, []);
  assert.match(
    JSON.stringify(result.content),
    /Not waiting: another message is pending\./,
  );
  assert.doesNotMatch(JSON.stringify(result.content), /no active loops remain/);
  assert.equal(pendingChecks, 1);
  await h.emit("session_shutdown");
});

test("wait reports ready results without yielding", async () => {
  const h = await loadExtension();
  const started = await h.call("adversarial_loop", { loops: [{ task: "A" }] });
  h.executions[0].resolve();
  await tick();
  const result = await h.call("adversarial_loop_wait");
  assert.equal(result.terminate, false);
  assert.equal(details(result).waiting, false);
  assert.equal(details(result).reason, "results_ready");
  assert.equal(details(result).loops[0].id, details(started).loops[0].id);
  assert.equal(details(result).loops[0].status, "completed");
  assert.match(JSON.stringify(result.content), /Adversarial loop completed/);
  assert.doesNotMatch(
    JSON.stringify(result.content),
    /Main agent yielded|Not waiting:/,
  );
  await h.emit("session_shutdown");
});

for (const pendingInput of [false, true])
  test(`manual wait buffers ready results above the threshold, pending input: ${pendingInput}`, async () => {
    const h = await loadExtension();
    await h.call("adversarial_loop", {
      loops: [{ task: "A" }, { task: "B" }, { task: "C" }],
    });
    await h.emit("input");
    h.executions[0].resolve();
    await tick();
    h.ctx.hasPendingMessages = () => pendingInput;
    const result = await h.call("adversarial_loop_wait");
    assert.equal(result.terminate, !pendingInput);
    assert.equal(details(result).waiting, !pendingInput);
    assert.equal(details(result).capacity.active, 2);
    assert.deepEqual(details(result).loops, []);
    assert.equal(
      details(result).reason,
      pendingInput ? "pending_messages" : "waiting_for_results",
    );
    if (!pendingInput) {
      assert.match(JSON.stringify(result.content), /Main agent yielded/);
      await h.emit("agent_end", {
        messages: [{ role: "assistant", stopReason: "toolUse" }],
      });
      h.setIdle(true);
      await h.emit("agent_settled");
      await notifyTick();
      assert.equal(h.sent.length, 0);
      h.executions[1].resolve();
      await notifyTick();
      assert.equal(h.sent.length, 1);
      assert.match(String(h.sent[0].content), /1\/6 active/);
    }
    await h.emit("session_shutdown");
  });

test("print and JSON modes explicitly reject background execution", async () => {
  const h = await loadExtension();
  for (const mode of ["print", "json"] as const) {
    h.ctx.mode = mode;
    await assert.rejects(
      h.call("adversarial_loop", { loops: [{ task: "A" }] }),
      /persistent TUI or RPC/,
    );
    await assert.rejects(
      h.call("adversarial_loop_wait"),
      /persistent TUI or RPC/,
    );
  }
  assert.equal(h.executions.length, 0);
  await h.emit("session_shutdown");
});

test("start rejects mixed batches before creating any background jobs", async () => {
  const h = await loadExtension();
  for (const sibling of ["bash", "adversarial_loop", "adversarial_loop_wait"]) {
    await assert.rejects(
      h.call(
        "adversarial_loop",
        { loops: [{ task: "A" }, { task: "B" }] },
        "start",
        [sibling],
      ),
      /only tool call/,
    );
  }
  assert.equal(h.executions.length, 0);
  const status = await h.call("adversarial_loop_manage", { action: "status" });
  assert.equal(details(status).capacity.active, 0);
  await h.emit("session_shutdown");
});

test("start automatically waits on the session-wide count across calls", async () => {
  const h = await loadExtension();
  const first = await h.call("adversarial_loop", { loops: [{ task: "A" }] });
  assert.equal(first.terminate, false);
  const second = await h.call("adversarial_loop", { loops: [{ task: "B" }] });
  assert.equal(second.terminate, true);
  assert.equal(details(second).waiting, true);
  assert.equal(details(second).reason, "waiting_for_capacity");
  assert.equal(details(second).capacity.active, 2);
  assert.match(JSON.stringify(second.content), /Main agent yielded/);
  await h.emit("session_shutdown");
});

test("pending user input prevents automatic parking after starting loops", async () => {
  const h = await loadExtension();
  h.ctx.hasPendingMessages = () => true;
  const result = await h.call("adversarial_loop", {
    loops: [{ task: "A" }, { task: "B" }],
  });
  assert.equal(result.terminate, false);
  assert.equal(details(result).waiting, false);
  assert.equal(details(result).reason, "pending_messages");
  assert.equal(h.executions.length, 2);
  await h.emit("session_shutdown");
});

test("completion wakes an automatically parked main agent while another loop keeps running", async () => {
  const h = await loadExtension("2");
  const started = await h.call("adversarial_loop", {
    loops: [{ task: "A" }, { task: "B" }],
  });
  assert.equal(started.terminate, true);
  await h.emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "toolUse" }],
  });
  h.setIdle(true);
  await h.emit("agent_settled");
  h.executions[0].resolve();
  await notifyTick();
  assert.equal(h.sent.length, 1);
  assert.match(String(h.sent[0].content), /1\/2 active/);
  const status = await h.call("adversarial_loop_manage", { action: "status" });
  assert.equal(details(status).capacity.active, 1);
  await h.emit("session_shutdown");
});

test("manage rereads results, validates ids, and does not duplicate usage accounting", async () => {
  const h = await loadExtension();
  const started = await h.call("adversarial_loop", { loops: [{ task: "A" }] });
  const id = details(started).loops[0].id;
  h.executions[0].resolve();
  await tick();
  const first = await h.call("adversarial_loop_manage", {
    action: "result",
    ids: [id],
  });
  const second = await h.call("adversarial_loop_manage", {
    action: "result",
    ids: [id],
  });
  assert.deepEqual(first, second);
  assert.equal(first.usage, undefined);
  await assert.rejects(
    h.call("adversarial_loop_manage", { action: "result" }),
    /requires loop ids/,
  );
  await assert.rejects(
    h.call("adversarial_loop_manage", { action: "cancel", ids: ["missing"] }),
    /Unknown loop/,
  );
  await h.emit("session_shutdown");
});

test("shutdown cancels active workers and old completions never notify the replacement session", async () => {
  const h = await loadExtension();
  const started = await h.call("adversarial_loop", {
    loops: [{ task: "A" }, { task: "B" }],
  });
  assert.equal(started.terminate, true);
  await h.emit("session_shutdown");
  assert.equal(h.executions[0].options.signal?.aborted, true);
  h.executions[0].resolve();
  await h.emit("session_start");
  await notifyTick();
  assert.equal(h.sent.length, 0);
  const status = await h.call("adversarial_loop_manage", { action: "status" });
  assert.equal(details(status).loops[0].status, "interrupted");
  assert.equal(details(status).capacity.active, 0);
  await h.emit("session_shutdown");
});

test("tree replacement invalidates Goal audit callbacks before shared-pool cleanup", async () => {
  const h = await loadExtension();
  h.setIdle(true);
  const goal = h.commands.get("goal");
  assert.ok(goal);
  await goal("Audit this task", h.ctx as ExtensionCommandContext);
  await h.emit("agent_end", {
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  const audit = h.emit("agent_settled");
  await tick();
  assert.equal(h.executions.length, 1);
  assert.equal(h.executions[0].options.maxIterations, 0);
  h.entries.length = 0;
  await h.emit("session_tree");
  await audit;
  assert.equal(h.executions[0].options.signal?.aborted, true);
  assert.deepEqual(h.entries, []);
  await h.emit("session_shutdown");
});

test("tree replacement never appends old job completions onto the new branch", async () => {
  const h = await loadExtension();
  const started = await h.call("adversarial_loop", {
    loops: [{ task: "A" }, { task: "B" }],
  });
  assert.equal(started.terminate, true);
  h.entries.length = 0;
  await h.emit("session_tree");
  await notifyTick();
  assert.equal(h.entries.length, 0);
  assert.equal(h.sent.length, 0);
  await h.emit("session_shutdown");
});
