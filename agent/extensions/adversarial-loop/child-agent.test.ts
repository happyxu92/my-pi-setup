import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createChildSessionPath,
  findProjectExtensionSources,
  getChildAgentExtensionPaths,
  runChildAgent,
  runOutputRetryLoop,
  toArchivedEvent,
} from "./child-agent.ts";
import { addChildAgentBaseTools } from "./child-tools.ts";

const FAKE_RPC_CHILD = String.raw`
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const args = process.argv.slice(2);
const sessionDirectory = args[args.indexOf("--session-dir") + 1];
const observed = {
  args,
  prompts: [],
  dialogResponses: [],
  overlappingPrompt: false,
  stdinEnded: false,
};
const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let active = false;
let inputBuffer = "";
const decoder = new StringDecoder("utf8");

function writeRecord(record) {
  process.stdout.write(JSON.stringify(record) + "\r\n");
}

function writeFragmentedRecord(record, callback) {
  const bytes = Buffer.from(JSON.stringify(record) + "\r\n");
  const marker = Buffer.from("汉");
  const markerIndex = bytes.indexOf(marker);
  process.stdout.write(bytes.subarray(0, markerIndex + 1));
  setTimeout(() => {
    process.stdout.write(bytes.subarray(markerIndex + 1));
    callback();
  }, 5);
}

function assistantEvent(text) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage,
    },
  };
}

function settle() {
  active = false;
  writeRecord({ type: "agent_settled" });
}

function handlePrompt(command) {
  if (active) observed.overlappingPrompt = true;
  active = true;
  observed.prompts.push(command);
  const mode = observed.prompts[0].message;
  const attempt = observed.prompts.length;

  if (mode === "integration-stderr") {
    process.stderr.write("raw diagnostic\n");
  }

  if (mode === "integration-command-failure") {
    active = false;
    writeRecord({
      type: "response",
      id: command.id,
      success: false,
      error: "fake command rejection",
    });
    return;
  }

  if (mode === "integration-success" && attempt === 1) {
    writeRecord({
      type: "extension_ui_request",
      id: "dialog-1",
      method: "confirm",
    });
    writeFragmentedRecord(assistantEvent("汉 invalid"), () => {
      setTimeout(settle, 5);
    });
    return;
  }

  const text =
    mode === "integration-success"
      ? JSON.stringify({ ok: true, label: "汉" })
      : mode === "integration-protocol-after-settled"
        ? JSON.stringify({ ok: true })
        : "invalid-" + attempt;
  writeRecord(assistantEvent(text));
  setTimeout(() => {
    settle();
    if (mode === "integration-protocol-after-settled") {
      process.stdout.write("not-json\r\n");
    }
  }, 5);
}

function processLine(rawLine) {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line) return;
  const command = JSON.parse(line);
  if (command.type === "prompt") handlePrompt(command);
  else if (command.type === "extension_ui_response") {
    observed.dialogResponses.push(command);
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer += decoder.write(chunk);
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop() || "";
  for (const line of lines) processLine(line);
});
process.stdin.on("end", () => {
  inputBuffer += decoder.end();
  if (inputBuffer) processLine(inputBuffer);
  observed.stdinEnded = true;
  writeFileSync(
    join(sessionDirectory, "fake-rpc-observed.json"),
    JSON.stringify(observed, null, 2) + "\n",
  );
});
`;

async function runWithFakeRpc(
  mode: string,
  validation?: {
    validate: (output: string) => void;
    buildRetryPrompt: (error: string, retry: number, max: number) => string;
    onRetry?: (retry: number, max: number, error: string) => void;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "adversarial-loop-rpc-"));
  const fakePi = join(root, "fake-pi.cjs");
  const agentDirectory = join(root, "agent");
  await writeFile(fakePi, FAKE_RPC_CHILD, "utf8");

  const originalScript = process.argv[1];
  process.argv[1] = fakePi;
  let result: Awaited<ReturnType<typeof runChildAgent>> | undefined;
  let error: unknown;
  try {
    result = await runChildAgent({
      role: "evaluator",
      cwd: root,
      model: "fake/model",
      thinkingLevel: "low",
      prompt: mode,
      agentDirectory,
      projectTrusted: false,
      outputValidation: validation,
    });
  } catch (caught) {
    error = caught;
  } finally {
    process.argv[1] = originalScript;
  }
  return { root, agentDirectory, result, error };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("loads only trusted project extension configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "adversarial-loop-extensions-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const projectPiDir = join(workspace, ".pi");
  const projectExtensions = join(projectPiDir, "extensions");
  const directExtension = join(projectExtensions, "direct.ts");
  const configuredExtension = join(projectPiDir, "configured.ts");
  const packageDirectory = join(projectPiDir, "vendor-package");
  const packageExtension = join(packageDirectory, "src", "index.ts");
  const globalExtension = join(agentDir, "extensions", "global.ts");
  const webAccessExtension = join(
    agentDir,
    "npm",
    "node_modules",
    "pi-web-access",
    "index.ts",
  );

  try {
    assert.deepEqual(
      await findProjectExtensionSources(workspace, true, agentDir),
      [],
    );

    await mkdir(projectExtensions, { recursive: true });
    await mkdir(dirname(packageExtension), { recursive: true });
    await mkdir(dirname(globalExtension), { recursive: true });
    await mkdir(dirname(webAccessExtension), { recursive: true });
    await writeFile(directExtension, "export default function () {}\n", "utf8");
    await writeFile(
      configuredExtension,
      "export default function () {}\n",
      "utf8",
    );
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ pi: { extensions: ["src/index.ts"] } }),
      "utf8",
    );
    await writeFile(
      packageExtension,
      "export default function () {}\n",
      "utf8",
    );
    await writeFile(globalExtension, "export default function () {}\n", "utf8");
    await writeFile(
      webAccessExtension,
      "export default function () {}\n",
      "utf8",
    );
    await writeFile(
      join(projectPiDir, "settings.json"),
      JSON.stringify({
        extensions: ["./configured.ts"],
        packages: ["./vendor-package"],
      }),
      "utf8",
    );

    const expected = [
      directExtension,
      configuredExtension,
      packageExtension,
    ].sort();
    assert.deepEqual(
      (await findProjectExtensionSources(workspace, false, agentDir)).sort(),
      [],
    );
    assert.deepEqual(
      (await findProjectExtensionSources(workspace, true, agentDir)).sort(),
      expected,
    );
    assert.deepEqual(
      (await getChildAgentExtensionPaths(workspace, false, agentDir)).sort(),
      [],
    );
    assert.deepEqual(
      (await getChildAgentExtensionPaths(workspace, true, agentDir)).sort(),
      expected,
    );
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

test("retries invalid structured output twice in the same prompt loop", async () => {
  const outputs = ["not json", "{}", '{"criteria":["exists"]}'];
  const prompts: string[] = [];
  const retries: number[] = [];

  const result = await runOutputRetryLoop({
    initialPrompt: "evaluate",
    runPrompt: async (prompt) => {
      prompts.push(prompt);
      return outputs[prompts.length - 1];
    },
    validation: {
      validate: (output) => {
        const parsed = JSON.parse(output);
        if (!Array.isArray(parsed.criteria))
          throw new Error("missing criteria");
      },
      buildRetryPrompt: (error, retry, maxRetries) =>
        `repair ${retry}/${maxRetries}: ${error}`,
      onRetry: (retry) => retries.push(retry),
    },
  });

  assert.equal(result.output, outputs[2]);
  assert.equal(result.retries, 2);
  assert.deepEqual(retries, [1, 2]);
  assert.equal(prompts[0], "evaluate");
  assert.match(prompts[1], /^repair 1\/2:/);
  assert.equal(prompts[2], "repair 2/2: missing criteria");
});

test("fails structured output after the default two retries", async () => {
  let attempts = 0;

  await assert.rejects(
    runOutputRetryLoop({
      initialPrompt: "evaluate",
      runPrompt: async () => {
        attempts++;
        return "invalid";
      },
      validation: {
        validate: (output) => JSON.parse(output),
        buildRetryPrompt: () => "return valid JSON",
      },
    }),
    /remained invalid after 2 retries/,
  );

  assert.equal(attempts, 3);
});

test("RPC child corrects output in-session with UTF-8 framing and clean shutdown", async () => {
  const retries: number[] = [];
  const run = await runWithFakeRpc("integration-success", {
    validate: (output) => {
      const value = JSON.parse(output);
      if (value.ok !== true) throw new Error("expected ok=true");
    },
    buildRetryPrompt: (error, retry, max) =>
      `correct ${retry}/${max}: ${error}`,
    onRetry: (retry) => retries.push(retry),
  });

  try {
    assert.ifError(run.error);
    assert.ok(run.result);
    assert.equal(run.result.output, '{"ok":true,"label":"汉"}');
    assert.equal(run.result.outputRetries, 1);
    assert.equal(run.result.usage.totalTokens, 6);
    assert.deepEqual(retries, [1]);

    const observed = await readJson(
      join(run.agentDirectory, "fake-rpc-observed.json"),
    );
    assert.equal(observed.prompts.length, 2);
    assert.equal(observed.prompts[0].message, "integration-success");
    assert.match(observed.prompts[1].message, /^correct 1\/2:/);
    assert.equal(observed.overlappingPrompt, false);
    assert.equal(observed.stdinEnded, true);
    assert.deepEqual(observed.dialogResponses, [
      {
        type: "extension_ui_response",
        id: "dialog-1",
        cancelled: true,
      },
    ]);
    assert.equal(observed.args[observed.args.indexOf("--mode") + 1], "rpc");

    assert.equal(
      await readFile(join(run.agentDirectory, "final-response.txt"), "utf8"),
      run.result.output,
    );
    const archivedResult = await readJson(
      join(run.agentDirectory, "result.json"),
    );
    assert.equal(archivedResult.outputRetries, 1);
    assert.equal(archivedResult.usage.totalTokens, 6);
    const events = (
      await readFile(join(run.agentDirectory, "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      events.filter((event) => event.type === "agent_settled").length,
      2,
    );
    assert.equal(existsSync(join(run.agentDirectory, "stderr.log")), false);
    assert.equal(
      existsSync(join(run.agentDirectory, "stderr-full.log")),
      false,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("RPC child archives raw and summarized stderr only when present", async () => {
  const run = await runWithFakeRpc("integration-stderr");

  try {
    assert.ifError(run.error);
    assert.ok(run.result);
    assert.equal(run.result.stderr, "raw diagnostic\n");
    assert.equal(
      await readFile(join(run.agentDirectory, "stderr.log"), "utf8"),
      "raw diagnostic\n",
    );
    assert.equal(
      await readFile(join(run.agentDirectory, "stderr-full.log"), "utf8"),
      "raw diagnostic\n",
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("RPC child archives the third invalid output after default exhaustion", async () => {
  const run = await runWithFakeRpc("integration-exhaustion", {
    validate: (output) => JSON.parse(output),
    buildRetryPrompt: (_error, retry, max) => `return JSON (${retry}/${max})`,
  });

  try {
    assert.match(String(run.error), /remained invalid after 2 retries/);
    assert.equal(run.result, undefined);
    const observed = await readJson(
      join(run.agentDirectory, "fake-rpc-observed.json"),
    );
    assert.equal(observed.prompts.length, 3);
    assert.equal(observed.overlappingPrompt, false);
    assert.equal(observed.stdinEnded, true);

    assert.equal(
      await readFile(join(run.agentDirectory, "final-response.txt"), "utf8"),
      "invalid-3",
    );
    const archivedResult = await readJson(
      join(run.agentDirectory, "result.json"),
    );
    assert.equal(archivedResult.output, "invalid-3");
    assert.equal(archivedResult.outputRetries, 2);
    assert.equal(archivedResult.usage.totalTokens, 9);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("RPC malformed output after settlement remains fatal", async () => {
  const run = await runWithFakeRpc("integration-protocol-after-settled");

  try {
    assert.match(String(run.error), /returned invalid RPC JSON/);
    assert.equal(run.result, undefined);
    const observed = await readJson(
      join(run.agentDirectory, "fake-rpc-observed.json"),
    );
    assert.equal(observed.prompts.length, 1);
    assert.equal(observed.stdinEnded, true);
    assert.match(
      await readFile(join(run.agentDirectory, "stderr.log"), "utf8"),
      /returned invalid RPC JSON/,
    );
    assert.equal(
      existsSync(join(run.agentDirectory, "stderr-full.log")),
      false,
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("RPC command rejection is not treated as output validation", async () => {
  let validations = 0;
  const run = await runWithFakeRpc("integration-command-failure", {
    validate: () => {
      validations++;
    },
    buildRetryPrompt: () => "should not be sent",
  });

  try {
    assert.match(String(run.error), /RPC prompt was rejected/);
    assert.equal(validations, 0);
    const observed = await readJson(
      join(run.agentDirectory, "fake-rpc-observed.json"),
    );
    assert.equal(observed.prompts.length, 1);
    assert.equal(observed.stdinEnded, true);
    const archivedResult = await readJson(
      join(run.agentDirectory, "result.json"),
    );
    assert.equal(archivedResult.outputRetries, 0);
  } finally {
    await rm(run.root, { recursive: true, force: true });
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
