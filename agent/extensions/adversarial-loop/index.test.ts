import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import adversarialLoopExtension from "./index.ts";

function loadExtension(flagValue: string, goalFlagValue = "25") {
  const tools: Array<{
    parameters: { properties: { loops: { maxItems: number } } };
  }> = [];
  const sessionStartHandlers: Array<(event: unknown, ctx: unknown) => void> =
    [];
  const notifications: string[] = [];

  const pi = {
    registerFlag() {},
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
    registerCommand() {},
    appendEntry() {},
    getFlag(name: string) {
      return name === "adversarial-loop-max-loops" ? flagValue : goalFlagValue;
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") sessionStartHandlers.push(handler);
    },
  } as unknown as ExtensionAPI;

  adversarialLoopExtension(pi);
  const ctx = {
    sessionManager: { getBranch: () => [] },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus() {},
    },
  };
  for (const handler of sessionStartHandlers) handler({}, ctx);
  return { tools, notifications };
}

test("registers six as the default maximum loop count", () => {
  const { tools } = loadExtension("6");
  assert.equal(tools[0].parameters.properties.loops.maxItems, 6);
  assert.equal(tools.at(-1)?.parameters.properties.loops.maxItems, 6);
});

test("applies the configured maximum loop count when the session starts", () => {
  const { tools, notifications } = loadExtension("10");
  assert.equal(tools.at(-1)?.parameters.properties.loops.maxItems, 10);
  assert.deepEqual(notifications, []);
});

test("falls back to six for an invalid configured maximum", () => {
  const { tools, notifications } = loadExtension("0");
  assert.equal(tools.at(-1)?.parameters.properties.loops.maxItems, 6);
  assert.match(notifications[0], /using 6/);
});

test("warns and falls back for an invalid Goal continuation limit", () => {
  const { notifications } = loadExtension("6", "0");
  assert.ok(notifications.some((message) => /using 25/.test(message)));
});
