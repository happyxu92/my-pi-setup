import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import manualRetry from "./index.ts";
import { findRetryableFailure, WAKE_TYPE } from "./policy.ts";

function assistant(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "test",
    model: "test",
    content: [],
    stopReason: "error",
    errorMessage: "429 rate_limit_exceeded",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
    ...overrides,
  };
}

function harness() {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Do the task", timestamp: 0 });
  manager.appendMessage(assistant());
  const sent: Array<Parameters<ExtensionAPI["sendMessage"]>> = [];
  const notices: string[] = [];
  const handlers = new Map<string, (event: ContextEvent) => unknown>();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  let idle = true;
  let pending = false;
  let throwOnSend = false;
  // Only the APIs used by this extension are stubbed. Unexpected APIs fail.
  const pi = {
    on(name: string, handler: (event: ContextEvent) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, definition: typeof command) {
      assert.equal(name, "retry-last");
      command = definition;
    },
    sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>) {
      if (throwOnSend) throw new Error("dispatch failed");
      sent.push(args);
    },
  } as unknown as ExtensionAPI;
  manualRetry(pi);
  const ctx = {
    model: { id: "test", provider: "test" },
    sessionManager: manager,
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    ui: { notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionCommandContext;
  return {
    manager,
    sent,
    notices,
    ctx,
    run: async (args = "") => {
      assert.ok(command);
      await command.handler(args, ctx);
    },
    emit: (name: string, messages: ContextEvent["messages"] = []) =>
      handlers.get(name)?.({ type: "context", messages }),
    setIdle: (value: boolean) => {
      idle = value;
    },
    setPending: (value: boolean) => {
      pending = value;
    },
    setThrowOnSend: (value: boolean) => {
      throwOnSend = value;
    },
  };
}

for (const errorMessage of [
  "HTTP 429",
  "rate_limit_exceeded",
  "Rate limit reached",
  "Too many requests",
  "insufficient_quota",
  "Quota exceeded",
  "You've hit your usage limit.",
  "Monthly usage limit reached",
  "GoUsageLimitError",
  "out of budget",
  "Your credit balance is too low",
  "RESOURCE_EXHAUSTED",
]) {
  test(`recognizes provider limit: ${errorMessage}`, () => {
    const h = harness();
    const id = h.manager.appendMessage(assistant({ errorMessage }));
    assert.equal(findRetryableFailure(h.manager.getBranch())?.id, id);
  });
}

for (const errorMessage of [
  "HTTP 503",
  "Service unavailable",
  "Service temporarily unavailable",
  "SERVICE_UNAVAILABLE",
  "service-unavailable",
  'Error: sub2api API error (503): {"message":"Service temporarily unavailable","type":"api_error"}',
]) {
  test(`manually retries service-unavailable failure: ${errorMessage}`, async () => {
    const h = harness();
    const id = h.manager.appendMessage(assistant({ errorMessage }));
    assert.equal(findRetryableFailure(h.manager.getBranch())?.id, id);
    await h.run();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0][0].content, "");
    assert.deepEqual(h.sent[0][1], { triggerTurn: true });
  });
}

for (const errorMessage of [
  "401 invalid API key",
  "context_length_exceeded",
  "429 context window exceeded",
  "Maximum context length exceeded",
  "500 server error",
  "502 Bad Gateway",
  "504 Gateway Timeout",
  "HTTP 503 context_length_exceeded",
  "Service temporarily unavailable: prompt too long",
  "Error code 15030",
  "fetch failed",
  "",
]) {
  test(`does not classify unrelated error: ${errorMessage}`, async () => {
    const h = harness();
    h.manager.appendMessage(assistant({ errorMessage }));
    await h.run();
    assert.equal(h.sent.length, 0);
  });
}

test("dispatches only an empty hidden wake with the failed entry ID", async () => {
  const h = harness();
  const failedEntryId = h.manager.getLeafId();
  await h.run();
  assert.deepEqual(h.sent, [
    [
      {
        customType: WAKE_TYPE,
        content: "",
        display: false,
        details: { failedEntryId },
      },
      { triggerTurn: true },
    ],
  ]);
  assert.deepEqual(h.notices, []);
});

test("filters all wake records after reload, preserving other messages and tool results", () => {
  const h = harness();
  const original: ContextEvent["messages"] = [
    { role: "user", content: "task", timestamp: 0 },
    assistant({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "call",
          name: "write",
          arguments: { path: "a" },
        },
      ],
    }),
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "write",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: 1,
    },
    {
      role: "custom",
      customType: "other-extension",
      content: "keep",
      display: false,
      timestamp: 2,
    },
    assistant(),
  ];
  const wake = {
    role: "custom",
    customType: WAKE_TYPE,
    content: "",
    display: false,
    timestamp: 3,
  } as const;
  const messages = [...original, wake, { ...wake, timestamp: 4 }];
  assert.deepEqual(h.emit("context", messages), { messages: original });
  assert.equal(messages.length, original.length + 2, "does not mutate history");
  // Removal must not rely on a currently pending manual retry.
  h.emit("session_start");
  assert.deepEqual(h.emit("context", messages), { messages: original });
});

test("does not interrupt automatic retries, streaming, compaction, or queued input", async () => {
  const h = harness();
  h.setIdle(false);
  await h.run();
  h.emit("agent_end");
  await h.run();
  h.setIdle(true);
  h.setPending(true);
  await h.run();
  assert.equal(h.sent.length, 0);
  h.setPending(false);
  await h.run();
  assert.equal(h.sent.length, 1);
});

test("duplicate requests stay blocked until settlement, not just agent_end", async () => {
  const h = harness();
  await Promise.all([h.run(), h.run()]);
  h.emit("agent_end");
  await h.run();
  assert.equal(h.sent.length, 1);
  h.manager.appendMessage(assistant());
  h.emit("agent_settled");
  await h.run();
  assert.equal(h.sent.length, 2);
});

for (const stopReason of ["stop", "aborted", "length", "toolUse"] as const) {
  test(`rejects ${stopReason}, even if an older error is retryable`, async () => {
    const h = harness();
    h.manager.appendMessage(
      assistant({ stopReason, errorMessage: "503 Service unavailable" }),
    );
    await h.run();
    assert.equal(h.sent.length, 0);
  });
}

test("rejects new user input, foreign custom messages, and summaries after failure", async () => {
  for (const append of [
    (m: SessionManager) =>
      m.appendMessage({ role: "user", content: "new task", timestamp: 2 }),
    (m: SessionManager) =>
      m.appendCustomMessageEntry("other", "new task", false),
    (m: SessionManager) => m.appendCompaction("summary", m.getLeafId()!, 1),
    (m: SessionManager) =>
      m.appendMessage({
        role: "toolResult",
        toolCallId: "call",
        toolName: "write",
        content: [],
        isError: false,
        timestamp: 2,
      }),
  ]) {
    const h = harness();
    append(h.manager);
    await h.run();
    assert.equal(h.sent.length, 0);
  }
});

test("uses the active branch, tolerates metadata and old wakes, and resets after tree changes", async () => {
  const h = harness();
  const failureId = h.manager.getLeafId()!;
  await h.run();
  h.manager.appendMessage(assistant({ stopReason: "stop" }));
  h.emit("agent_settled");
  await h.run();
  assert.equal(h.sent.length, 1);
  h.manager.branch(failureId);
  h.manager.appendSessionInfo("Renamed");
  h.manager.appendModelChange("test", "another-model");
  h.manager.appendCustomMessageEntry(WAKE_TYPE, "", false);
  h.emit("session_tree");
  await h.run();
  assert.equal(h.sent.length, 2);
});

test("rejects arguments and missing models; synchronous dispatch failure unlocks", async () => {
  const h = harness();
  await h.run("continue");
  h.ctx.model = undefined;
  await h.run();
  assert.equal(h.sent.length, 0);
  const withModel = harness();
  withModel.setThrowOnSend(true);
  await assert.rejects(withModel.run(), /dispatch failed/);
  withModel.setThrowOnSend(false);
  await withModel.run();
  assert.equal(withModel.sent.length, 1);
});

for (const event of ["session_start", "session_shutdown"]) {
  test(`${event} clears runtime-only locks`, async () => {
    const h = harness();
    await h.run();
    h.emit(event);
    await h.run();
    assert.equal(h.sent.length, 2);
  });
}
