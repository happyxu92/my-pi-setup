import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { UndoControllerImpl } from "./src/controller.ts";
import { canonicalJson, checksum } from "./src/encoding.ts";
import type { ManifestId, SnapshotManifest } from "./src/model.ts";
import { SessionState, type SessionEntry } from "./src/session-state.ts";

interface TestEntry extends SessionEntry {
  readonly message?: { readonly role: string };
}

const identity = {
  path: resolve("test-session.jsonl"),
  headerChecksum: checksum("test-session"),
};

function runEntries(systemCount: number): TestEntry[] {
  const entries: TestEntry[] = [
    { type: "model_change", id: "base", parentId: null },
    {
      type: "custom",
      id: "start",
      parentId: "base",
      customType: "pi-undo:start",
    },
  ];
  for (let index = 0; index < systemCount; index += 1) {
    entries.push({
      type: "message",
      id: `system-${index}`,
      parentId: entries.at(-1)!.id,
      message: { role: "system" },
    });
  }
  entries.push(
    {
      type: "message",
      id: "user",
      parentId: entries.at(-1)!.id,
      message: { role: "user" },
    },
    {
      type: "message",
      id: "assistant",
      parentId: "user",
      message: { role: "assistant" },
    },
  );
  return entries;
}

function stateFor(
  entries: readonly TestEntry[],
  leafId: string | null = entries.at(-1)?.id ?? null,
) {
  return new SessionState({
    getEntries: () => entries,
    getLeafId: () => leafId,
    getSessionFile: () => undefined,
  });
}

function checkpointEntry(userEntryId = "user") {
  const payload = {
    schemaVersion: 1,
    checkpointId: "checkpoint-id",
    runId: "run-id",
    sessionIdentity: identity,
    startEntryId: "start",
    userEntryId,
    endLeafId: "assistant",
    rawPrompt: "test prompt",
    beforeManifestId: checksum("before"),
    afterManifestId: checksum("after"),
    changedPaths: [],
  };
  return {
    type: "custom",
    id: "checkpoint",
    parentId: "assistant",
    customType: "pi-undo:checkpoint",
    data: { ...payload, checksum: checksum(canonicalJson(payload)) },
  };
}

for (const systemCount of [0, 1, 2]) {
  test(`finds the run user and reloads its checkpoint across ${systemCount} system messages`, () => {
    const entries = runEntries(systemCount);
    assert.equal(stateFor(entries).findUserEntryAfter("start"), "user");

    const checkpoint = checkpointEntry();
    entries.push(checkpoint);
    assert.deepEqual(stateFor(entries).getCheckpoints(identity), [
      checkpoint.data,
    ]);
  });
}

test("uses the active branch, not the first matching child in append order", () => {
  const entries = runEntries(1);
  entries.splice(2, 0, {
    type: "message",
    id: "abandoned-user",
    parentId: "start",
    message: { role: "user" },
  });
  assert.equal(stateFor(entries).findUserEntryAfter("start"), "user");
  assert.equal(
    stateFor([...entries].reverse(), "assistant").findUserEntryAfter("start"),
    "user",
  );
  entries.push(checkpointEntry("abandoned-user"));
  assert.deepEqual(stateFor(entries).getCheckpoints(identity), []);
});

test("does not borrow a user or start marker from an inactive branch", () => {
  const entries = runEntries(1);
  assert.equal(stateFor(entries, "start").findUserEntryAfter("start"), null);
  assert.equal(stateFor(entries, "system-0").findUserEntryAfter("start"), null);
  assert.equal(stateFor(entries, "base").findUserEntryAfter("start"), null);
  assert.equal(stateFor(entries, null).findUserEntryAfter("start"), null);
  assert.equal(stateFor(entries).findUserEntryAfter("missing"), null);
  assert.equal(stateFor(entries).findUserEntryAfter("base"), null);
});

const blockers: TestEntry[] = [
  {
    type: "custom",
    id: "blocker",
    parentId: "system-0",
    customType: "pi-undo:start",
  },
  {
    type: "custom",
    id: "blocker",
    parentId: "system-0",
    customType: "pi-undo:barrier",
  },
  {
    type: "custom",
    id: "blocker",
    parentId: "system-0",
    customType: "other-extension",
  },
  {
    type: "message",
    id: "blocker",
    parentId: "system-0",
    message: { role: "assistant" },
  },
  {
    type: "message",
    id: "blocker",
    parentId: "system-0",
    message: { role: "toolResult" },
  },
  {
    type: "message",
    id: "blocker",
    parentId: "system-0",
    message: { role: "user" },
  },
];

for (const blocker of blockers) {
  test(`does not skip ${blocker.customType ?? blocker.message?.role} before the run user`, () => {
    const entries = runEntries(1).map((entry) =>
      entry.id === "user" ? { ...entry, parentId: "blocker" } : entry,
    );
    entries.push(blocker);
    assert.equal(
      stateFor(entries, "assistant").findUserEntryAfter("start"),
      blocker.message?.role === "user" ? "blocker" : null,
    );
    entries.push(checkpointEntry());
    assert.deepEqual(stateFor(entries).getCheckpoints(identity), []);
  });
}

test("still rejects checkpoint checksum and session identity mismatches", () => {
  const checkpoint = checkpointEntry();
  const entries = [...runEntries(1), checkpoint];
  assert.deepEqual(
    stateFor(entries).getCheckpoints({
      ...identity,
      headerChecksum: checksum("other"),
    }),
    [],
  );
  checkpoint.data.rawPrompt = "tampered";
  assert.deepEqual(stateFor(entries).getCheckpoints(identity), []);
});

test("fails closed on broken or cyclic active ancestry", () => {
  const entries = runEntries(1);
  assert.throws(
    () =>
      stateFor(
        entries.filter((entry) => entry.id !== "system-0"),
      ).findUserEntryAfter("start"),
    /session parent 缺失/,
  );
  assert.throws(
    () =>
      stateFor(
        entries.map((entry) =>
          entry.id === "start" ? { ...entry, parentId: "user" } : entry,
        ),
      ).findUserEntryAfter("start"),
    /session parent cycle/,
  );
});

test("a run with a persisted system message settles without locking and produces a reloadable checkpoint", async () => {
  const entries: TestEntry[] = [
    { type: "model_change", id: "base", parentId: null },
  ];
  let leafId = "base";
  const state = new SessionState({
    getEntries: () => entries,
    getLeafId: () => leafId,
    getSessionFile: () => undefined,
  });
  const append = (entry: Omit<TestEntry, "id" | "parentId">) => {
    const id = `entry-${entries.length}`;
    entries.push({ ...entry, id, parentId: leafId });
    leafId = id;
    return id;
  };
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    manifestId: checksum("snapshot") as ManifestId,
    workspaceIdentity: "workspace",
    topologyFingerprint: checksum("topology"),
    coverage: "complete",
    roots: [],
    createdAt: "2026-09-23T11:08:14.632Z",
  };
  const unexpectedOperation = () =>
    assert.fail("settling must not restore files or move the session");
  const controller = new UndoControllerImpl({
    workspaceIdentity: manifest.workspaceIdentity,
    sessionIdentity: identity,
    isAgentIdle: () => true,
    abortAgent: unexpectedOperation,
    waitForIdle: unexpectedOperation,
    getLogicalLeafId: () => state.getLogicalLeafId(),
    acquireWorkspaceLock: async () => ({ release: async () => {} }),
    findUserEntryAfter: (startEntryId) =>
      state.findUserEntryAfter(startEntryId),
    resolveSessionTarget: unexpectedOperation,
    navigateSession: unexpectedOperation,
    restoreSessionLeaf: unexpectedOperation,
    resolveTreeTarget: unexpectedOperation,
    appendControl: async (customType, data) =>
      append({ type: "custom", customType, data }),
    appendCursor: unexpectedOperation,
    capture: async () => manifest,
    changedPaths: async () => [],
    loadManifest: unexpectedOperation,
    planRestore: unexpectedOperation,
    applyRestore: unexpectedOperation,
    recoverPending: unexpectedOperation,
    journal: {
      prepare: unexpectedOperation,
      setPhase: unexpectedOperation,
      markCommitted: unexpectedOperation,
      loadPending: unexpectedOperation,
    },
    clock: Date.now,
  });

  assert.deepEqual(
    await controller.prepareInput("test prompt", { streaming: false }),
    { action: "continue" },
  );
  await controller.beforeAgentStart();
  append({ type: "message", message: { role: "system" } });
  const userEntryId = append({ type: "message", message: { role: "user" } });
  append({ type: "message", message: { role: "assistant" } });
  await controller.agentSettled();

  assert.deepEqual(controller.history(), {
    undoCount: 1,
    redoCount: 0,
    locked: false,
  });
  assert.equal(controller.listCheckpoints()[0]?.userEntryId, userEntryId);
  assert.deepEqual(
    stateFor(entries).getCheckpoints(identity),
    controller.listCheckpoints(),
  );
  assert.equal(
    entries.some((entry) => entry.customType === "pi-undo:barrier"),
    false,
  );
});
