import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createChildSessionPath,
  findPiWebAccessExtension,
  findProjectExtensionSources,
  getChildAgentExtensionPaths,
  toArchivedEvent,
} from "./child-agent.ts";
import { addChildAgentBaseTools } from "./child-tools.ts";

test("loads trusted project extensions and global pi-web-access", async () => {
  const root = await mkdtemp(join(tmpdir(), "adversarial-loop-extensions-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const projectExtensions = join(workspace, ".pi", "extensions");
  const directExtension = join(projectExtensions, "direct.ts");
  const nestedExtension = join(projectExtensions, "nested");
  const packagedExtension = join(projectExtensions, "packaged");
  const webAccessExtension = join(
    agentDir,
    "npm",
    "node_modules",
    "pi-web-access",
    "index.ts",
  );

  try {
    assert.equal(findPiWebAccessExtension(agentDir), undefined);
    assert.deepEqual(findProjectExtensionSources(workspace, true), []);

    await mkdir(nestedExtension, { recursive: true });
    await mkdir(join(packagedExtension, "src"), { recursive: true });
    await mkdir(dirname(webAccessExtension), { recursive: true });
    await writeFile(directExtension, "export default function () {}\n", "utf8");
    await writeFile(
      join(nestedExtension, "index.ts"),
      "export default function () {}\n",
      "utf8",
    );
    await writeFile(
      join(packagedExtension, "package.json"),
      JSON.stringify({ pi: { extensions: ["src/index.ts"] } }),
      "utf8",
    );
    await writeFile(
      join(packagedExtension, "src", "index.ts"),
      "export default function () {}\n",
      "utf8",
    );
    await writeFile(
      webAccessExtension,
      "export default function () {}\n",
      "utf8",
    );

    assert.equal(findPiWebAccessExtension(agentDir), webAccessExtension);
    assert.deepEqual(findProjectExtensionSources(workspace, false), []);
    assert.deepEqual(findProjectExtensionSources(workspace, true), [
      directExtension,
      nestedExtension,
      packagedExtension,
    ]);
    assert.deepEqual(getChildAgentExtensionPaths(workspace, false, agentDir), [
      webAccessExtension,
    ]);
    assert.deepEqual(getChildAgentExtensionPaths(workspace, true, agentDir), [
      directExtension,
      nestedExtension,
      packagedExtension,
      webAccessExtension,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adds base tools without removing project extension tools", () => {
  assert.deepEqual(addChildAgentBaseTools(["project_tool", "read"]), [
    "project_tool",
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ]);
});

test("creates timestamped child session filenames with random suffixes", () => {
  const timestamp = new Date("2026-08-26T03:29:57.123Z");

  assert.equal(
    createChildSessionPath("/loop/evaluator", timestamp, "ALBXrg"),
    "/loop/evaluator/session-20260826T032957Z-ALBXrg.jsonl",
  );
  assert.notEqual(
    createChildSessionPath("/loop/evaluator", timestamp, "ALBXrg"),
    createChildSessionPath("/loop/evaluator", timestamp, "x9_Q-w"),
  );
});

test("archives only compact execution timeline fields", () => {
  assert.deepEqual(
    toArchivedEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "large duplicated command" },
    }),
    {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
    },
  );

  assert.deepEqual(
    toArchivedEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: "large duplicated result" },
      isError: false,
    }),
    {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      isError: false,
    },
  );

  assert.deepEqual(
    toArchivedEvent({
      type: "agent_end",
      messages: [{ role: "assistant", content: "duplicated transcript" }],
      willRetry: true,
    }),
    { type: "agent_end", willRetry: true },
  );
});

test("omits transcript, streaming, session, and unknown events", () => {
  for (const event of [
    { type: "session", id: "session-1" },
    { type: "message_start", message: { role: "user", content: "prompt" } },
    { type: "message_update", assistantMessageEvent: { delta: "token" } },
    {
      type: "message_end",
      message: { role: "assistant", content: "final response" },
    },
    { type: "tool_execution_update", partialResult: "partial output" },
    { type: "entry_appended", entry: { type: "message" } },
    { type: "future_large_event", payload: "not allowlisted" },
    { type: "toString", payload: "inherited object property" },
  ]) {
    assert.equal(toArchivedEvent(event), undefined);
  }
});

test("keeps retry diagnostics without arbitrary nested payloads", () => {
  assert.deepEqual(
    toArchivedEvent({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1_000,
      errorMessage: "rate limited",
      providerResponse: { body: "duplicated response" },
    }),
    {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1_000,
      errorMessage: "rate limited",
    },
  );
});
