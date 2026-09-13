import assert from "node:assert/strict";
import test from "node:test";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { LoopManager } from "./loop-manager.ts";
import { LOOP_COMPLETION_MESSAGE, LoopNotifier } from "./loop-notifier.ts";
import type { RunLoopOptions } from "./types.ts";
import { emptyUsage } from "./utils.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const notifyTick = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 45));

function harness(limit = 3) {
  const sent: Array<{
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: Parameters<ExtensionAPI["sendMessage"]>[1];
  }> = [];
  const completions: Array<() => void> = [];
  let notifier: LoopNotifier;
  let failSend = false;
  let pendingMessages = false;
  const manager = new LoopManager({
    limit,
    persist: () => {},
    saveResult: async () => {},
    changed: () => notifier?.schedule(),
    runLoop: (options: RunLoopOptions) =>
      new Promise((resolve) => {
        completions.push(() =>
          resolve({
            details: {
              status: "completed",
              task: options.task,
              model: options.model,
              maxIterations: 1,
              criteria: [],
              rounds: [],
            },
            usage: emptyUsage(),
            latestGeneratorReport: undefined,
          }),
        );
      }),
  });
  const ctx = {
    hasPendingMessages: () => pendingMessages,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  notifier = new LoopNotifier(
    manager,
    {
      sendMessage: (message, options) => {
        if (failSend) throw new Error("send failed");
        sent.push({ message, options });
      },
    },
    () => ctx,
  );
  const start = (count = 1) =>
    manager.start(
      Array.from({ length: count }, (_, index) => ({
        task: `Task ${index}`,
        maxIterations: 1,
      })),
      {
        cwd: "/workspace",
        model: "fake/model",
        thinkingLevel: "off",
        projectTrusted: false,
      },
      "start",
    );
  const messages = (): ContextEvent["messages"] =>
    sent.map(({ message }) => ({
      ...message,
      role: "custom",
      timestamp: Date.now(),
    }));
  return {
    manager,
    notifier,
    sent,
    completions,
    start,
    messages,
    failSend: (value: boolean) => {
      failSend = value;
    },
    pendingMessages: (value: boolean) => {
      pendingMessages = value;
    },
  };
}

test("first result is steered without waiting for other loops and is acknowledged only in model context", async () => {
  const h = harness();
  h.start(2);
  h.notifier.announceStart("start");
  await tick();
  h.completions[0]();
  await notifyTick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.manager.capacity().active, 1);
  assert.equal(h.sent[0].message.customType, LOOP_COMPLETION_MESSAGE);
  assert.deepEqual(h.sent[0].options, {
    deliverAs: "steer",
    triggerTurn: true,
  });
  assert.equal(h.manager.pending().length, 1);
  h.notifier.context(h.messages());
  assert.equal(h.manager.pending().length, 0);
  h.completions[1]();
  await notifyTick();
  assert.equal(h.sent.length, 2);
  h.notifier.dispose();
});

test("very fast completion cannot overtake the startup tool result", async () => {
  const h = harness();
  h.start();
  await tick();
  h.completions[0]();
  await notifyTick();
  assert.equal(h.sent.length, 0);
  h.notifier.announceStart("start");
  await notifyTick();
  assert.equal(h.sent.length, 1);
  h.notifier.dispose();
});

test("wait parks synchronously and a completion during tool finalization wakes only after settlement", async () => {
  const h = harness();
  h.start();
  h.notifier.announceStart("start");
  await tick();
  assert.deepEqual(h.notifier.wait(), {
    waiting: true,
    records: [],
    reason: "waiting_for_results",
  });
  assert.equal(h.notifier.blocksAudit, true);
  h.completions[0]();
  await notifyTick();
  assert.equal(h.sent.length, 0);
  h.notifier.agentEnd();
  h.notifier.settled(false);
  await notifyTick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.notifier.blocksAudit, true);
  h.notifier.context(h.messages());
  assert.equal(h.notifier.blocksAudit, false);
  h.notifier.dispose();
});

test("wait immediately returns already-ready results and deduplicates an earlier queued notification", async () => {
  const h = harness();
  h.start();
  h.notifier.announceStart("start");
  await tick();
  h.completions[0]();
  await notifyTick();
  assert.equal(h.sent.length, 1);
  const outcome = h.notifier.wait();
  assert.equal(outcome.waiting, false);
  assert.equal(outcome.reason, "results_ready");
  assert.equal(outcome.records.length, 1);
  assert.equal(h.manager.pending().length, 0);
  assert.deepEqual(h.notifier.context(h.messages()), []);
  h.notifier.dispose();
});

test("wait distinguishes no active loops from pending user input", async () => {
  const h = harness();
  assert.deepEqual(h.notifier.wait(), {
    waiting: false,
    records: [],
    reason: "no_active_loops",
  });
  h.pendingMessages(true);
  assert.equal(h.notifier.wait().reason, "no_active_loops");
  h.start();
  await tick();
  assert.deepEqual(h.notifier.wait(), {
    waiting: false,
    records: [],
    reason: "pending_messages",
  });
  assert.equal(h.notifier.waiting, false);
  h.completions[0]();
  await tick();
  // Ready results still take priority, even with pending input and no active loops.
  const ready = h.notifier.wait();
  assert.equal(ready.reason, "results_ready");
  assert.equal(ready.waiting, false);
  assert.equal(ready.records.length, 1);
  h.notifier.dispose();
});

test("simultaneous completions coalesce and repeated context/settled events do not resubmit delivered results", async () => {
  const h = harness();
  h.start(2);
  h.notifier.announceStart("start");
  await tick();
  h.completions.forEach((complete) => complete());
  await notifyTick();
  assert.equal(h.sent.length, 1);
  assert.equal(
    (h.sent[0].message.details as { loopIds: string[] }).loopIds.length,
    2,
  );
  const messages = h.messages();
  assert.equal(h.notifier.context([...messages, ...messages]).length, 1);
  h.notifier.context(messages);
  h.notifier.settled(false);
  await notifyTick();
  assert.equal(h.sent.length, 1);
  h.notifier.dispose();
});

test("a large completion backlog is delivered in bounded batches without losing the remainder", async () => {
  const h = harness(8);
  h.start(8);
  h.notifier.announceStart("start");
  await tick();
  h.completions.forEach((complete) => complete());
  await notifyTick();
  assert.equal(h.sent.length, 1);
  assert.equal(
    (h.sent[0].message.details as { loopIds: string[] }).loopIds.length,
    6,
  );
  h.notifier.context(h.messages());
  assert.equal(h.manager.pending().length, 2);
  await notifyTick();
  assert.equal(h.sent.length, 2);
  h.notifier.context(h.messages());
  assert.equal(h.manager.pending().length, 0);
  h.notifier.dispose();
});

test("stop, cancellation and disposed runtimes cannot auto-wake", async () => {
  const h = harness();
  h.start();
  h.notifier.announceStart("start");
  await tick();
  h.notifier.stop();
  h.manager.cancel();
  h.completions[0]();
  await notifyTick();
  assert.equal(h.sent.length, 0);
  h.notifier.userInput();
  await notifyTick();
  assert.equal(h.sent.length, 0);
  h.notifier.dispose();
  h.notifier.announceStart("another");
  assert.equal(h.sent.length, 0);
});

test("failed main runs pause automatic wakeups until a new user instruction", async () => {
  const h = harness();
  h.start();
  h.notifier.announceStart("start");
  await tick();
  h.notifier.settled(true);
  h.completions[0]();
  await notifyTick();
  assert.equal(h.sent.length, 0);
  h.notifier.userInput();
  await notifyTick();
  assert.equal(h.sent.length, 1);
  h.notifier.dispose();
});

test("completion cannot start a competing model run during context compaction", async () => {
  const h = harness();
  h.start();
  h.notifier.announceStart("start");
  await tick();
  h.notifier.suspendDelivery();
  h.completions[0]();
  await notifyTick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.manager.pending().length, 1);
  h.notifier.resumeDelivery();
  await notifyTick();
  assert.equal(h.sent.length, 1);
  h.notifier.dispose();
});

test("notification failure retains results and a later lifecycle boundary can retry", async () => {
  const h = harness();
  h.start();
  h.notifier.announceStart("start");
  await tick();
  h.failSend(true);
  h.completions[0]();
  await notifyTick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.manager.pending().length, 1);
  h.failSend(false);
  h.notifier.settled(false);
  await notifyTick();
  assert.equal(h.sent.length, 1);
  h.notifier.dispose();
});

test("unconsumed in-flight notification is retried at idle with its old ID revoked", async () => {
  const h = harness();
  h.start();
  h.notifier.announceStart("start");
  await tick();
  h.completions[0]();
  await notifyTick();
  h.notifier.settled(false);
  await notifyTick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.notifier.context(h.messages()).length, 1);
  assert.equal(h.manager.pending().length, 0);
  h.notifier.dispose();
});
