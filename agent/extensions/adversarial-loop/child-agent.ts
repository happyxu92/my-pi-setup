import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

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

const EVALUATOR_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const GENERATOR_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ROLE_SYSTEM_PROMPTS = {
  evaluator: EVALUATOR_SYSTEM_PROMPT,
  generator: GENERATOR_SYSTEM_PROMPT,
} as const;
const MAX_GENERATOR_REPORT_BYTES = 12 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

interface ChildAgentResult {
  output: string;
  stderr: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  usage: Usage;
}

interface RunChildAgentOptions {
  role: "evaluator" | "generator";
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  prompt: string;
  agentDirectory: string;
  signal?: AbortSignal;
  onActivity?: (activity: string) => void;
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

export async function runChildAgent(options: RunChildAgentOptions) {
  options.signal?.throwIfAborted();

  await mkdir(options.agentDirectory, { recursive: true });

  const tools =
    options.role === "evaluator" ? EVALUATOR_TOOLS : GENERATOR_TOOLS;
  const args = [
    "--mode",
    "json",
    "--print",
    "--session-dir",
    options.agentDirectory,
    "--model",
    options.model,
    "--thinking",
    options.thinkingLevel,
    "--tools",
    tools.join(","),
    "--append-system-prompt",
    ROLE_SYSTEM_PROMPTS[options.role],
    options.prompt,
  ];

  const result: ChildAgentResult = {
    output: "",
    stderr: "",
    exitCode: 0,
    usage: emptyUsage(),
  };
  const eventsLog = createWriteStream(
    join(options.agentDirectory, "events.jsonl"),
    { flags: "w", mode: 0o600 },
  );
  const stderrLog = createWriteStream(
    join(options.agentDirectory, "stderr-full.log"),
    { flags: "w", mode: 0o600 },
  );
  const archiveErrors: string[] = [];
  const eventsLogDone = finished(eventsLog).catch((error) => {
    archiveErrors.push(`events.jsonl: ${getErrorText(error)}`);
  });
  const stderrLogDone = finished(stderrLog).catch((error) => {
    archiveErrors.push(`stderr-full.log: ${getErrorText(error)}`);
  });

  try {
    const invocation = getPiInvocation(args);
    let wasAborted = false;

    result.exitCode = await new Promise<number>((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdoutBuffer = "";
      let closed = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const processLine = (line: string) => {
        if (!line.trim()) return;

        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(event)) return;

        if (event.type === "tool_execution_start") {
          const toolName = cleanString(event.toolName, 128) || "tool";
          options.onActivity?.(`using ${toolName}`);
        }

        if (event.type === "message_end" && isAssistantMessage(event.message)) {
          const message = event.message;
          const text = getAssistantText(message);
          if (text) result.output = text;
          addUsage(result.usage, message.usage);
          result.stopReason = message.stopReason;
          result.errorMessage = message.errorMessage;
        }
      };

      const finish = (code: number) => {
        if (closed) return;
        closed = true;
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", abortChild);
        resolve(code);
      };

      const abortChild = () => {
        wasAborted = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!closed) child.kill("SIGKILL");
        }, 5_000);
        forceKillTimer.unref();
      };

      child.stdout.on("data", (data: Buffer) => {
        eventsLog.write(data);
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      child.stderr.on("data", (data: Buffer) => {
        stderrLog.write(data);
        result.stderr = truncateUtf8(
          `${result.stderr}${data.toString()}`,
          MAX_STDERR_BYTES,
        );
      });

      child.on("error", (error) => {
        result.stderr = truncateUtf8(
          `${result.stderr}\n${error.message}`,
          MAX_STDERR_BYTES,
        );
        finish(1);
      });
      child.on("close", (code) => finish(code ?? 1));

      if (options.signal?.aborted) abortChild();
      else
        options.signal?.addEventListener("abort", abortChild, { once: true });
    });

    if (wasAborted) throw new Error(`${options.role} agent was aborted`);
    if (result.exitCode !== 0) {
      throw new Error(
        `${options.role} agent exited with code ${result.exitCode}: ${result.stderr || "no diagnostic output"}`,
      );
    }
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      throw new Error(
        `${options.role} agent ${result.stopReason}: ${result.errorMessage || result.stderr || "unknown error"}`,
      );
    }
    if (!result.output) {
      throw new Error(`${options.role} agent returned no final output`);
    }

    if (options.role === "generator") {
      result.output = truncateUtf8(result.output, MAX_GENERATOR_REPORT_BYTES);
    }
    return result;
  } finally {
    eventsLog.end();
    stderrLog.end();
    await Promise.all([eventsLogDone, stderrLogDone]);
    if (archiveErrors.length > 0) {
      result.stderr = truncateUtf8(
        `${result.stderr}\nArchive errors: ${archiveErrors.join("; ")}`,
        MAX_STDERR_BYTES,
      );
    }
    await Promise.all([
      writeFile(
        join(options.agentDirectory, "final-response.txt"),
        result.output,
        "utf8",
      ),
      writeFile(
        join(options.agentDirectory, "stderr.log"),
        result.stderr,
        "utf8",
      ),
      writeFile(
        join(options.agentDirectory, "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8",
      ),
    ]);
  }
}
