import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTreeNavigationEvent } from "./src/tree-navigation.ts";

const entries = [
  { type: "thinking_level_change", id: "base", parentId: null },
  {
    type: "custom",
    id: "start",
    parentId: "base",
    customType: "pi-undo:start",
  },
  { type: "message", id: "user", parentId: "start", message: { role: "user" } },
  {
    type: "message",
    id: "assistant",
    parentId: "user",
    message: { role: "assistant" },
  },
  {
    type: "branch_summary",
    id: "summary",
    parentId: "start",
  },
];

const source = {
  getEntries: () => entries,
  getSessionFile: () => undefined,
};

test("normalizes a physical pi-undo control leaf after tree navigation", () => {
  assert.deepEqual(
    normalizeTreeNavigationEvent(source, { newLeafId: "start" }),
    {
      newLeafId: "base",
      navigationTargetLeafId: "base",
    },
  );
});

test("keeps a summary as the observed leaf and normalizes its target", () => {
  assert.deepEqual(
    normalizeTreeNavigationEvent(source, {
      newLeafId: "summary",
      summaryEntry: { parentId: "start" },
    }),
    {
      newLeafId: "summary",
      navigationTargetLeafId: "base",
    },
  );
});
