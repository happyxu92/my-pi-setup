import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { EVALUATOR_SYSTEM_PROMPT } from "./evaluator.ts";
import { GENERATOR_SYSTEM_PROMPT } from "./generator.ts";
import type { ThinkingLevel } from "./types.ts";
import {
  addUsage,
  cleanString,
  emptyUsage,
  isRecord,
  truncateUtf8,
} from "./utils.ts";

const CHILD_AGENT_TOOLS_EXTENSION = fileURLToPath(
  new URL("./child-tools.ts", import.meta.url),
);
const ROLE_SYSTEM_PROMPTS = {
  evaluator: EVALUATOR_SYSTEM_PROMPT,
  generator: GENERATOR_SYSTEM_PROMPT,
} as const;
const MAX_GENERATOR_REPORT_BYTES = 12 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
export const DEFAULT_OUTPUT_VALIDATION_RETRIES = 2;

interface ChildAgentResult {
  output: string;
  stderr: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  outputRetries: number;
  usage: Usage;
}

interface ChildAgentOutputValidation {
  validate: (output: string) => void;
  maxRetries?: number;
  buildRetryPrompt: (
    error: string,
    retry: number,
    maxRetries: number,
  ) => string;
  onRetry?: (retry: number, maxRetries: number, error: string) => void;
}

interface RunChildAgentOptions {
  role: "evaluator" | "generator";
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  prompt: string;
  agentDirectory: string;
  projectTrusted: boolean;
  signal?: AbortSignal;
  onActivity?: (activity: string) => void;
  outputValidation?: ChildAgentOutputValidation;
}

interface OutputRetryLoopOptions {
  initialPrompt: string;
  runPrompt: (prompt: string) => Promise<string>;
  validation?: ChildAgentOutputValidation;
}

export async function runOutputRetryLoop(options: OutputRetryLoopOptions) {
  const maxRetries = Math.max(
    0,
    Math.floor(
      options.validation?.maxRetries ?? DEFAULT_OUTPUT_VALIDATION_RETRIES,
    ),
  );
  let prompt = options.initialPrompt;
  let retries = 0;

  while (true) {
    const output = await options.runPrompt(prompt);
    if (!options.validation) return { output, retries };

    try {
      options.validation.validate(output);
      return { output, retries };
    } catch (error) {
      const message = getErrorText(error);
      if (retries >= maxRetries) {
        throw new Error(
          `Child agent output remained invalid after ${retries} ${retries === 1 ? "retry" : "retries"}: ${message}`,
          { cause: error },
        );
      }

      retries++;
      options.validation.onRetry?.(retries, maxRetries, message);
      prompt = options.validation.buildRetryPrompt(
        message,
        retries,
        maxRetries,
      );
    }
  }
}

export function findPiWebAccessExtension(agentDir = getAgentDir()) {
  const extensionPath = join(
    agentDir,
    "npm",
    "node_modules",
    "pi-web-access",
    "index.ts",
  );
  return existsSync(extensionPath) ? extensionPath : undefined;
}

function hasPiExtensionManifest(directory: string) {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    return (
      isRecord(manifest) &&
      isRecord(manifest.pi) &&
      Array.isArray(manifest.pi.extensions) &&
      manifest.pi.extensions.length > 0
    );
  } catch {
    return false;
  }
}

function isProjectExtensionDirectory(directory: string) {
  return (
    existsSync(join(directory, "index.ts")) ||
    existsSync(join(directory, "index.js")) ||
    hasPiExtensionManifest(directory)
  );
}

export function findProjectExtensionSources(
  cwd: string,
  projectTrusted: boolean,
) {
  if (!projectTrusted) return [];
  const extensionDirectory = join(cwd, CONFIG_DIR_NAME, "extensions");

  try {
    return readdirSync(extensionDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => {
        const entryPath = join(extensionDirectory, entry.name);
        let isFile = entry.isFile();
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            const stats = statSync(entryPath);
            isFile = stats.isFile();
            isDirectory = stats.isDirectory();
          } catch {
            return [];
          }
        }

        if (isFile && /\.(?:js|ts)$/.test(entry.name)) return [entryPath];
        if (isDirectory && isProjectExtensionDirectory(entryPath)) {
          return [entryPath];
        }
        return [];
      });
  } catch {
    return [];
  }
}

export function getChildAgentExtensionPaths(
  cwd: string,
  projectTrusted: boolean,
  agentDir = getAgentDir(),
) {
  const piWebAccessExtension = findPiWebAccessExtension(agentDir);
  return [
    ...findProjectExtensionSources(cwd, projectTrusted),
    ...(piWebAccessExtension ? [piWebAccessExtension] : []),
  ];
}

export function createChildSessionPath(
  agentDirectory: string,
  now = new Date(),
  randomSuffix = randomBytes(4).toString("base64url"),
) {
  const timestamp = now
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return join(agentDirectory, `session-${timestamp}-${randomSuffix}.jsonl`);
}

function getPiInvocation(args: string[]) {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executableName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
  return isGenericRuntime
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isRecord(value) &&
    value.role === "assistant" &&
    Array.isArray(value.content)
  );
}

function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getAssistantText(message: AssistantMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

const ARCHIVED_EVENT_FIELDS = {
  agent_start: [],
  agent_end: ["willRetry"],
  agent_settled: [],
  turn_start: [],
  turn_end: [],
  tool_execution_start: ["toolCallId", "toolName"],
  tool_execution_end: ["toolCallId", "toolName", "isError"],
  compaction_start: ["reason"],
  compaction_end: ["reason", "aborted", "willRetry", "errorMessage"],
  auto_retry_start: ["attempt", "maxAttempts", "delayMs", "errorMessage"],
  auto_retry_end: ["success", "attempt", "finalError"],
  summarization_retry_scheduled: [
    "attempt",
    "maxAttempts",
    "delayMs",
    "errorMessage",
  ],
  summarization_retry_attempt_start: ["source", "reason"],
  summarization_retry_finished: [],
} as const;

/**
 * Keep only a compact execution timeline. Message bodies, tool arguments/results,
 * streaming deltas, and session entries already live in the pi session JSONL.
 */
export function toArchivedEvent(event: Record<string, unknown>) {
  const type = cleanString(event.type, 128);
  if (!Object.hasOwn(ARCHIVED_EVENT_FIELDS, type)) return undefined;

  const archived: Record<string, string | number | boolean> = { type };
  const fields =
    ARCHIVED_EVENT_FIELDS[type as keyof typeof ARCHIVED_EVENT_FIELDS];
  for (const field of fields) {
    const value = event[field];
    if (typeof value === "string") archived[field] = cleanString(value);
    else if (typeof value === "number" && Number.isFinite(value)) {
      archived[field] = value;
    } else if (typeof value === "boolean") archived[field] = value;
  }
  return archived;
}

export async function runChildAgent(options: RunChildAgentOptions) {
  options.signal?.throwIfAborted();

  await mkdir(options.agentDirectory, { recursive: true });

  const extensionPaths = [
    ...getChildAgentExtensionPaths(options.cwd, options.projectTrusted),
    CHILD_AGENT_TOOLS_EXTENSION,
  ];
  const sessionPath = createChildSessionPath(options.agentDirectory);
  const args = [
    "--no-extensions",
    ...extensionPaths.flatMap((path) => ["--extension", path]),
    "--mode",
    "rpc",
    "--session-dir",
    options.agentDirectory,
    "--session",
    sessionPath,
    "--model",
    options.model,
    "--thinking",
    options.thinkingLevel,
    "--exclude-tools",
    "adversarial_loop",
    "--append-system-prompt",
    ROLE_SYSTEM_PROMPTS[options.role],
  ];

  const result: ChildAgentResult = {
    output: "",
    stderr: "",
    exitCode: -1,
    outputRetries: 0,
    usage: emptyUsage(),
  };
  const eventsLog = createWriteStream(
    join(options.agentDirectory, "events.jsonl"),
    { flags: "w", mode: 0o600 },
  );
  let stderrFullLog: ReturnType<typeof createWriteStream> | undefined;
  let stderrFullLogDone: Promise<void> | undefined;
  const archiveErrors: string[] = [];
  const eventsLogDone = finished(eventsLog).catch((error) => {
    archiveErrors.push(`events.jsonl: ${getErrorText(error)}`);
  });
  const writeFullStderr = (data: Buffer) => {
    if (!stderrFullLog) {
      stderrFullLog = createWriteStream(
        join(options.agentDirectory, "stderr-full.log"),
        { flags: "w", mode: 0o600 },
      );
      stderrFullLogDone = finished(stderrFullLog).catch((error) => {
        archiveErrors.push(`stderr-full.log: ${getErrorText(error)}`);
      });
    }
    stderrFullLog.write(data);
  };

  try {
    const invocation = getPiInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let protocolError: Error | undefined;
    let closed = false;
    let wasAborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let shutdownTimer: NodeJS.Timeout | undefined;
    let promptSequence = 0;

    interface PendingTurn {
      id: string;
      output: string;
      stopReason?: string;
      errorMessage?: string;
      resolve: (turn: {
        output: string;
        stopReason?: string;
        errorMessage?: string;
      }) => void;
      reject: (error: Error) => void;
    }

    let pendingTurn: PendingTurn | undefined;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const appendStderr = (text: string) => {
      result.stderr = truncateUtf8(
        `${result.stderr}${result.stderr ? "\n" : ""}${text}`,
        MAX_STDERR_BYTES,
      );
    };

    const rejectPendingTurn = (error: Error) => {
      const pending = pendingTurn;
      pendingTurn = undefined;
      pending?.reject(error);
    };

    const finish = (code: number) => {
      if (closed) return;
      closed = true;
      result.exitCode = code;
      stdoutBuffer += stdoutDecoder.end();
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      stdoutBuffer = "";
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      options.signal?.removeEventListener("abort", abortChild);
      rejectPendingTurn(
        new Error(
          `${options.role} agent exited before the RPC prompt settled with code ${code}: ${result.stderr || "no diagnostic output"}`,
        ),
      );
      resolveClosed();
    };

    const sendRpc = (value: Record<string, unknown>) => {
      if (closed || child.stdin.destroyed || child.stdin.writableEnded) {
        throw new Error(`${options.role} agent RPC input is closed`);
      }
      child.stdin.write(`${JSON.stringify(value)}\n`);
    };

    const cancelExtensionDialog = (event: Record<string, unknown>) => {
      const method = cleanString(event.method, 64);
      const id = cleanString(event.id, 256);
      if (
        !closed &&
        !child.stdin.writableEnded &&
        id &&
        (method === "select" ||
          method === "confirm" ||
          method === "input" ||
          method === "editor")
      ) {
        sendRpc({ type: "extension_ui_response", id, cancelled: true });
      }
    };

    const processLine = (rawLine: string) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) return;

      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (error) {
        protocolError ??= new Error(
          `${options.role} agent returned invalid RPC JSON: ${getErrorText(error)}`,
        );
        appendStderr(protocolError.message);
        rejectPendingTurn(protocolError);
        if (!closed && !child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.end();
        }
        return;
      }
      if (!isRecord(event)) return;

      const archivedEvent = toArchivedEvent(event);
      if (archivedEvent) {
        eventsLog.write(`${JSON.stringify(archivedEvent)}\n`);
      }

      if (event.type === "extension_ui_request") {
        cancelExtensionDialog(event);
        return;
      }

      if (
        event.type === "response" &&
        pendingTurn &&
        event.id === pendingTurn.id &&
        event.success === false
      ) {
        rejectPendingTurn(
          new Error(
            `${options.role} agent RPC prompt was rejected: ${cleanString(event.error) || "unknown error"}`,
          ),
        );
        return;
      }

      if (event.type === "tool_execution_start") {
        const toolName = cleanString(event.toolName, 128) || "tool";
        options.onActivity?.(`using ${toolName}`);
      }

      if (event.type === "message_end" && isAssistantMessage(event.message)) {
        const message = event.message;
        const text = getAssistantText(message);
        if (pendingTurn && text) pendingTurn.output = text;
        if (pendingTurn) {
          pendingTurn.stopReason = message.stopReason;
          pendingTurn.errorMessage = message.errorMessage;
        }
        addUsage(result.usage, message.usage);
      }

      if (event.type === "agent_settled" && pendingTurn) {
        const pending = pendingTurn;
        pendingTurn = undefined;
        if (
          pending.stopReason === "error" ||
          pending.stopReason === "aborted"
        ) {
          pending.reject(
            new Error(
              `${options.role} agent ${pending.stopReason}: ${pending.errorMessage || result.stderr || "unknown error"}`,
            ),
          );
        } else if (!pending.output) {
          pending.reject(
            new Error(`${options.role} agent returned no final output`),
          );
        } else {
          pending.resolve({
            output: pending.output,
            stopReason: pending.stopReason,
            errorMessage: pending.errorMessage,
          });
        }
      }
    };

    const abortChild = () => {
      if (closed) return;
      wasAborted = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 5_000);
      forceKillTimer.unref();
    };

    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += stdoutDecoder.write(data);
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    child.stderr.on("data", (data: Buffer) => {
      writeFullStderr(data);
      result.stderr = truncateUtf8(
        `${result.stderr}${data.toString()}`,
        MAX_STDERR_BYTES,
      );
    });

    child.stdin.on("error", (error) => {
      appendStderr(`RPC stdin: ${error.message}`);
      rejectPendingTurn(error);
    });
    child.on("error", (error) => {
      appendStderr(error.message);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));

    if (options.signal?.aborted) abortChild();
    else options.signal?.addEventListener("abort", abortChild, { once: true });

    const runPrompt = async (prompt: string) => {
      options.signal?.throwIfAborted();
      if (pendingTurn) {
        throw new Error(
          `${options.role} agent already has a pending RPC prompt`,
        );
      }

      const id = `${options.role}-prompt-${++promptSequence}`;
      const turnPromise = new Promise<{
        output: string;
        stopReason?: string;
        errorMessage?: string;
      }>((resolve, reject) => {
        pendingTurn = {
          id,
          output: "",
          resolve,
          reject,
        };
      });

      try {
        sendRpc({ id, type: "prompt", message: prompt });
      } catch (error) {
        rejectPendingTurn(
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      const turn = await turnPromise;
      result.output = turn.output;
      result.stopReason = turn.stopReason;
      result.errorMessage = turn.errorMessage;
      return turn.output;
    };

    const requestShutdown = async () => {
      if (!closed && !child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
      if (!closed && !shutdownTimer) {
        shutdownTimer = setTimeout(() => {
          if (closed) return;
          child.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            if (!closed) child.kill("SIGKILL");
          }, 5_000);
          forceKillTimer.unref();
        }, 5_000);
        shutdownTimer.unref();
      }
      await closedPromise;
    };

    try {
      const validation = options.outputValidation
        ? {
            ...options.outputValidation,
            onRetry: (retry: number, maxRetries: number, error: string) => {
              result.outputRetries = retry;
              options.outputValidation?.onRetry?.(retry, maxRetries, error);
            },
          }
        : undefined;
      const retryResult = await runOutputRetryLoop({
        initialPrompt: options.prompt,
        runPrompt,
        validation,
      });
      result.output = retryResult.output;
      result.outputRetries = retryResult.retries;
      await requestShutdown();

      if (protocolError) throw protocolError;
      if (wasAborted) throw new Error(`${options.role} agent was aborted`);
      if (result.exitCode !== 0) {
        throw new Error(
          `${options.role} agent exited with code ${result.exitCode}: ${result.stderr || "no diagnostic output"}`,
        );
      }

      if (options.role === "generator") {
        result.output = truncateUtf8(result.output, MAX_GENERATOR_REPORT_BYTES);
      }
      return result;
    } catch (error) {
      await requestShutdown();
      if (protocolError) throw protocolError;
      if (wasAborted) throw new Error(`${options.role} agent was aborted`);
      throw error;
    }
  } finally {
    eventsLog.end();
    if (stderrFullLog) stderrFullLog.end();
    await Promise.all([eventsLogDone, stderrFullLogDone]);
    if (archiveErrors.length > 0) {
      result.stderr = truncateUtf8(
        `${result.stderr}\nArchive errors: ${archiveErrors.join("; ")}`,
        MAX_STDERR_BYTES,
      );
    }
    const artifactWrites = [
      writeFile(
        join(options.agentDirectory, "final-response.txt"),
        result.output,
        "utf8",
      ),
      writeFile(
        join(options.agentDirectory, "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8",
      ),
    ];
    if (result.stderr) {
      artifactWrites.push(
        writeFile(
          join(options.agentDirectory, "stderr.log"),
          result.stderr,
          "utf8",
        ),
      );
    }
    await Promise.all(artifactWrites);
  }
}
