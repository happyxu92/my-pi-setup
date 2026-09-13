import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LoopManager, parseLoopRecord } from "./loop-manager.ts";
import type { BackgroundLoopRecord, RunLoopOptions } from "./types.ts";
import { emptyUsage } from "./utils.ts";

const context = {
  cwd: "/workspace",
  model: "fake/model",
  thinkingLevel: "high" as const,
  projectTrusted: true,
};
const request = (task: string) => ({ task, maxIterations: 2 });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function result(options: RunLoopOptions, completed = true) {
  return {
    details: {
      status: completed ? ("completed" as const) : ("exhausted" as const),
      task: options.task,
      model: options.model,
      maxIterations: options.maxIterations,
      criteria: [],
      rounds: [],
    },
    usage: { ...emptyUsage(), totalTokens: 10 },
    latestGeneratorReport: "Produced the artifact",
  };
}

function controlledManager(limit = 2) {
  const executions: Array<{
    options: RunLoopOptions;
    resolve: (value: ReturnType<typeof result>) => void;
    reject: (error: Error) => void;
  }> = [];
  const persisted: BackgroundLoopRecord[] = [];
  const manager = new LoopManager({
    limit,
    persist: (record) => persisted.push(record),
    saveResult: async () => {},
    runLoop: (options) =>
      new Promise((resolve, reject) =>
        executions.push({ options, resolve, reject }),
      ),
  });
  return { manager, executions, persisted };
}

test("reserves capacity across calls synchronously and rejects batches atomically", async () => {
  const { manager, executions } = controlledManager(3);
  const a = manager.start([request("A"), request("B")], context, "call-1");
  assert.equal(executions.length, 0);
  assert.equal(manager.capacity().active, 2);
  assert.throws(
    () => manager.start([request("C"), request("D")], context, "call-2"),
    /available 1\/3/,
  );
  assert.equal(manager.records().length, 2);
  manager.start([request("C")], context, "call-3");
  assert.throws(
    () => manager.start([request("D")], context, "call-4"),
    /capacity exceeded/,
  );
  await tick();
  assert.equal(executions.length, 3);
  assert.notEqual(a[0].id, a[1].id);
  for (const execution of executions)
    execution.resolve(result(execution.options));
  await tick();
  assert.equal(manager.capacity().active, 0);
});

test("first completion releases capacity without waiting for siblings", async () => {
  const { manager, executions } = controlledManager();
  const records = manager.start([request("A"), request("B")], context, "start");
  await tick();
  executions[0].resolve(result(executions[0].options));
  await tick();
  assert.equal(manager.get(records[0].id).status, "completed");
  assert.equal(manager.get(records[1].id).status, "running");
  assert.equal(manager.capacity().available, 1);
  manager.start([request("C")], context, "replacement");
  await tick();
  assert.equal(executions.length, 3);
  executions[1].resolve(result(executions[1].options, false));
  executions[2].resolve(result(executions[2].options));
  await tick();
  assert.equal(manager.pending().length, 3);
  assert.equal(manager.get(records[1].id).status, "exhausted");
});

test("failure keeps sibling alive and preserves partial usage", async () => {
  const { manager, executions } = controlledManager();
  const records = manager.start([request("A"), request("B")], context, "start");
  await tick();
  executions[0].options.onUsage?.({ ...emptyUsage(), totalTokens: 7 });
  executions[0].reject(new Error("provider failure"));
  await tick();
  assert.equal(manager.get(records[0].id).status, "error");
  assert.equal(manager.get(records[0].id).usage.totalTokens, 7);
  assert.match(manager.get(records[0].id).error ?? "", /provider failure/);
  assert.equal(executions[1].options.signal?.aborted, false);
  executions[1].resolve(result(executions[1].options));
  await tick();
});

test("cancellation holds capacity until the runner finishes cleanup and suppresses wakeups", async () => {
  const { manager, executions } = controlledManager(1);
  const [record] = manager.start([request("A")], context, "start");
  await tick();
  assert.throws(() => manager.cancel([record.id, "missing"]), /Unknown loop/);
  assert.equal(executions[0].options.signal?.aborted, false);
  manager.cancel([record.id]);
  assert.equal(executions[0].options.signal?.aborted, true);
  assert.equal(manager.get(record.id).status, "cancelling");
  assert.equal(manager.capacity().available, 0);
  executions[0].resolve(result(executions[0].options));
  await tick();
  assert.equal(manager.get(record.id).status, "cancelled");
  assert.equal(manager.capacity().available, 1);
  assert.equal(manager.pending().length, 0);
});

test("cancellation before startup does not invoke a runner", async () => {
  const { manager, executions } = controlledManager(1);
  const [record] = manager.start([request("A")], context, "start");
  manager.cancel();
  await tick();
  assert.equal(executions.length, 0);
  assert.equal(manager.get(record.id).status, "cancelled");
});

test("shutdown waits for cleanup and restores unfinished records as interrupted", async () => {
  const { manager, executions, persisted } = controlledManager(1);
  const [record] = manager.start([request("A")], context, "start");
  const restored = new LoopManager({ limit: 1, persist: () => {} });
  restored.restore([persisted[0]]);
  assert.equal(restored.get(record.id).status, "interrupted");
  assert.equal(restored.pending().length, 0);
  assert.equal(restored.capacity().active, 0);
  await tick();
  let shutDown = false;
  const shutdown = manager.shutdown().then(() => {
    shutDown = true;
  });
  await tick();
  assert.equal(shutDown, false);
  assert.equal(executions[0].options.signal?.aborted, true);
  assert.throws(
    () => manager.start([request("new")], context, "new"),
    /shutting down/,
  );
  executions[0].reject(new Error("aborted"));
  await shutdown;
  assert.equal(manager.get(record.id).status, "interrupted");
});

test("snapshots and repeated result reads cannot mutate state or consume usage", async () => {
  const { manager, executions } = controlledManager(1);
  const [record] = manager.start([request("A")], context, "start");
  record.task = "mutated";
  await tick();
  executions[0].resolve(result(executions[0].options));
  await tick();
  const first = manager.get(record.id);
  const second = manager.get(record.id);
  assert.equal(first.task, "A");
  assert.deepEqual(first.usage, second.usage);
  manager.acknowledge([record.id]);
  manager.acknowledge([record.id]);
  assert.equal(manager.pending().length, 0);
  assert.equal(manager.get(record.id).usage.totalTokens, 10);
  assert.equal(parseLoopRecord(first)?.id, record.id);
  assert.equal(parseLoopRecord({ version: 9 }), undefined);
});

test("audit uses pool capacity and excludes new background starts", async () => {
  const { manager, executions } = controlledManager(1);
  const audit = manager.runAudit({
    ...context,
    task: "audit",
    maxIterations: 0,
  });
  assert.equal(manager.capacity().active, 1);
  assert.equal(manager.capacity().auditing, true);
  assert.throws(
    () => manager.start([request("A")], context, "start"),
    /Goal audit/,
  );
  await tick();
  executions[0].resolve(result(executions[0].options));
  await audit;
  assert.equal(manager.capacity().active, 0);
  const [record] = manager.start([request("A")], context, "start");
  await assert.rejects(
    manager.runAudit({ ...context, task: "audit", maxIterations: 0 }),
    /idle loop pool/,
  );
  await tick();
  executions[1].resolve(result(executions[1].options));
  await tick();
  await assert.rejects(
    manager.runAudit({ ...context, task: "audit", maxIterations: 0 }),
    /pending results/,
  );
  manager.acknowledge([record.id]);
});

test("persists complete results to the loop archive before announcing completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "background-loop-result-"));
  try {
    const manager = new LoopManager({
      limit: 1,
      persist: () => {},
      runLoop: async (options) => ({
        ...result(options),
        details: { ...result(options).details, loopDirectory: directory },
      }),
    });
    const [record] = manager.start([request("A")], context, "start");
    while (manager.capacity().active) await tick();
    const saved = JSON.parse(
      await readFile(join(directory, "loop-result.json"), "utf8"),
    );
    assert.equal(saved.id, record.id);
    assert.equal(saved.status, "completed");
    assert.equal(saved.usage.totalTokens, 10);
    assert.equal(manager.pending().length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation during archival corrects the saved terminal status before releasing capacity", async () => {
  let finishArchive: (() => void) | undefined;
  const saved: BackgroundLoopRecord[] = [];
  const manager = new LoopManager({
    limit: 1,
    persist: () => {},
    runLoop: async (options) => result(options),
    saveResult: async (record) => {
      saved.push(record);
      if (saved.length === 1)
        await new Promise<void>((resolve) => {
          finishArchive = resolve;
        });
    },
  });
  const [record] = manager.start([request("A")], context, "start");
  await tick();
  manager.cancel([record.id]);
  assert.equal(manager.capacity().available, 0);
  assert.ok(finishArchive);
  finishArchive();
  await tick();
  assert.equal(saved.length, 2);
  assert.equal(saved[1].status, "cancelled");
  assert.equal(saved[1].delivery, "suppressed");
  assert.equal(manager.get(record.id).status, "cancelled");
  assert.equal(manager.capacity().available, 1);
});

test("archival failures surface as errors rather than false acceptance", async () => {
  const manager = new LoopManager({
    limit: 1,
    persist: () => {},
    runLoop: async (options) => result(options),
    saveResult: async () => {
      throw new Error("disk full");
    },
  });
  const [record] = manager.start([request("A")], context, "start");
  await tick();
  assert.equal(manager.get(record.id).status, "error");
  assert.match(manager.get(record.id).error ?? "", /disk full/);
});
