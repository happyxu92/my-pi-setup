import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import manualRetry from "./index.ts";
import { WAKE_TYPE } from "./policy.ts";

for (const failure of [
  { status: 429, message: "rate_limit_exceeded", type: "rate_limit" },
  {
    status: 503,
    message: "Service temporarily unavailable",
    type: "api_error",
  },
]) {
  test(
    `HTTP ${failure.status}: real session/provider pipeline retries without sending wake records, errors, or extra user messages`,
    { timeout: 60_000 },
    async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), "pi-manual-retry-"));
      t.after(() => rm(cwd, { recursive: true, force: true }));
      const requests: Array<{
        messages: Array<{
          role: string;
          content: unknown;
          tool_calls?: unknown;
        }>;
      }> = [];
      let failing = false;
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (failing) {
          response.writeHead(failure.status, {
            "content-type": "application/json",
            "retry-after": "0",
          });
          response.end(
            JSON.stringify({
              error: {
                message: failure.message,
                type: failure.type,
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            `data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { role: "assistant", content: "Recovered" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(() => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const runtime = await ModelRuntime.create({
        authPath: join(cwd, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(cwd, "models-cache.json"),
        refreshOnCreate: false,
      });
      runtime.registerProvider("manual-retry-test", {
        api: "openai-completions",
        apiKey: "test-only",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        models: [
          {
            id: "test",
            name: "Test",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 128,
          },
        ],
      });
      const model = runtime.getModel("manual-retry-test", "test");
      assert.ok(model);
      const settings = SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
        compaction: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [manualRetry],
        systemPrompt: "Test assistant",
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const manager = SessionManager.inMemory(cwd);
      manager.appendMessage({
        role: "system",
        content: "Test assistant",
        timestamp: 0,
      });
      manager.appendMessage({
        role: "user",
        content: "Write the file",
        timestamp: 1,
      });
      const base: AssistantMessage = {
        role: "assistant",
        api: "openai-completions",
        provider: model.provider,
        model: model.id,
        content: [
          {
            type: "toolCall",
            id: "write-call",
            name: "write",
            arguments: { path: "a", content: "done" },
          },
        ],
        stopReason: "toolUse",
        timestamp: 2,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      manager.appendMessage(base);
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "write-call",
        toolName: "write",
        content: [{ type: "text", text: "File already written" }],
        isError: false,
        timestamp: 3,
      });
      manager.appendMessage({
        ...base,
        content: [{ type: "text", text: "FAILED_PARTIAL_OUTPUT" }],
        stopReason: "error",
        errorMessage: `sub2api API error (${failure.status}): ${JSON.stringify({ message: failure.message, type: failure.type })}`,
        timestamp: 4,
      });
      const { session } = await createAgentSession({
        cwd,
        agentDir: cwd,
        modelRuntime: runtime,
        model,
        thinkingLevel: "off",
        settingsManager: settings,
        sessionManager: manager,
        resourceLoader: loader,
        noTools: "all",
      });
      t.after(() => session.dispose());
      const retrySettings = settings.getRetrySettings();
      let automaticRetries = 0;
      session.subscribe((event) => {
        if (event.type === "auto_retry_start") automaticRetries++;
      });

      await session.prompt("/retry-last");
      await session.waitForIdle();
      assert.equal(requests.length, 1);
      assert.equal(session.getLastAssistantText(), "Recovered");
      assert.deepEqual(
        requests[0].messages.map((message) => message.role),
        ["system", "user", "assistant", "tool"],
      );
      assert.ok(requests[0].messages[2].tool_calls);
      assert.match(JSON.stringify(requests[0]), /File already written/);
      assert.doesNotMatch(
        JSON.stringify(requests[0]),
        /FAILED_PARTIAL_OUTPUT|rate_limit|Service temporarily unavailable|manual-retry-wake|retry-last/,
      );
      assert.equal(
        manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" && entry.customType === WAKE_TYPE,
          ).length,
        1,
      );
      assert.equal(
        manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "message" && entry.message.role === "user",
          ).length,
        1,
      );

      await session.prompt("/retry-last");
      await session.waitForIdle();
      assert.equal(requests.length, 1, "a completed task cannot be retried");

      failing = true;
      await session.prompt("Next task");
      assert.equal(
        automaticRetries,
        1,
        "normal automatic retry policy is unchanged",
      );
      assert.equal(session.isIdle, true);
      const stoppedAt = requests.length;
      failing = false;
      await session.prompt("/retry-last");
      await session.waitForIdle();
      assert.equal(requests.length, stoppedAt + 1);
      assert.equal(session.getLastAssistantText(), "Recovered");
      assert.deepEqual(settings.getRetrySettings(), retrySettings);
      for (const body of requests) {
        assert.doesNotMatch(
          JSON.stringify(body),
          /FAILED_PARTIAL_OUTPUT|rate_limit|Service temporarily unavailable|manual-retry-wake|retry-last/,
        );
        assert.ok(
          body.messages.filter((message) => message.role === "user").length <=
            2,
        );
      }
      assert.equal(
        requests.at(-1)!.messages.filter((message) => message.role === "user")
          .length,
        2,
      );
    },
  );
}
