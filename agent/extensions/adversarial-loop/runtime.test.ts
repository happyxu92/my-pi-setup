import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import adversarialLoopExtension from "./index.ts";
import type { RunLoopOptions } from "./types.ts";
import { emptyUsage } from "./utils.ts";

test(
  "real Pi runtime shares the wait threshold after user reentry and waits for the last loop",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "adversarial-loop-runtime-"));
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const children: Array<{ options: RunLoopOptions; finish: () => void }> = [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) =>
          adversarialLoopExtension(pi, {
            saveResult: async () => {},
            runLoop: (options) =>
              new Promise((resolve, reject) => {
                children.push({
                  options,
                  finish: () =>
                    resolve({
                      details: {
                        status: "completed",
                        task: options.task,
                        model: options.model,
                        maxIterations: options.maxIterations,
                        criteria: [],
                        rounds: [],
                      },
                      usage: emptyUsage(),
                      latestGeneratorReport: undefined,
                    }),
                });
                options.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("cancelled")),
                  { once: true },
                );
              }),
          }),
      ],
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: join(root, "models.json"),
      modelsStorePath: join(root, "models-store.json"),
      allowModelNetwork: false,
    });
    await modelRuntime.setRuntimeApiKey("anthropic", "fake-no-network");
    const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime,
      model,
      settingsManager,
      sessionManager: SessionManager.inMemory(root),
      resourceLoader,
      noTools: "builtin",
    });
    const errors: string[] = [];
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) => errors.push(error.error),
    });
    let requests = 0;
    const contexts: string[] = [];
    // Replace the entire provider stream: this test makes no model/API requests.
    session.agent.streamFunction = (model, context) => {
      requests++;
      contexts.push(JSON.stringify(context.messages));
      let content: AssistantMessage["content"];
      if (requests === 1)
        content = [
          {
            type: "toolCall",
            id: "start-abc",
            name: "adversarial_loop",
            arguments: { loops: [{ task: "A" }, { task: "B" }, { task: "C" }] },
          },
        ];
      else if (requests === 2 || requests === 4)
        content = [
          {
            type: "toolCall",
            id: `wait-${requests}`,
            name: "adversarial_loop_wait",
            arguments: {},
          },
        ];
      else if (requests === 3)
        content = [
          {
            type: "toolCall",
            id: "start-d",
            name: "adversarial_loop",
            arguments: { loops: [{ task: "D" }] },
          },
        ];
      else content = [{ type: "text", text: "All results integrated." }];
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        timestamp: Date.now(),
        stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
      };
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end(message);
      return stream;
    };
    const nextSettlement = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error("Main agent did not settle"));
        }, 3000);
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "agent_settled") {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
      });
    try {
      await session.prompt("Start independent work and wait for results.");
      assert.deepEqual(errors, []);
      assert.equal(
        requests,
        1,
        "start must suppress the ordinary post-tool LLM request without an explicit wait",
      );
      assert.equal(children.length, 3);
      assert.equal(session.isIdle, true);
      await session.prompt(
        "No independent work remains; manually wait for the loops.",
      );
      assert.equal(
        requests,
        2,
        "user input resumes the agent, which manually yields",
      );
      children[0].finish();
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(
        requests,
        2,
        "manual wait: 3 → 2 must not wake the main agent",
      );
      const firstWake = nextSettlement();
      children[1].finish();
      await firstWake;
      assert.equal(requests, 3, "replenishment must automatically yield again");
      assert.equal(children.length, 4);
      assert.equal(children[2].options.signal?.aborted, false);
      assert.match(contexts[2], /Loop wait ended/);
      assert.match(contexts[2], /Some background loop results are ready/);
      assert.match(
        contexts[2],
        /Other loops are still active; their results will be delivered automatically/,
      );
      const manualWait = nextSettlement();
      children[2].finish();
      await manualWait;
      assert.equal(
        requests,
        4,
        "manual wait must suppress the post-tool request",
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(
        requests,
        4,
        "manual wait at one loop must not immediately wake",
      );
      const lastWake = nextSettlement();
      children[3].finish();
      await lastWake;
      assert.equal(requests, 5);
      assert.match(
        contexts[4],
        /No active background loops remain\. Available results are below\./,
      );
      assert.deepEqual(errors, []);
      assert.equal(
        session.messages.filter(
          (message) => message.role === "toolResult" && message.isError,
        ).length,
        0,
      );
    } finally {
      await session.prompt("/loops stop all");
      await session.abort();
      session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
