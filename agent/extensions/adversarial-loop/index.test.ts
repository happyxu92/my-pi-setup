import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import adversarialLoopExtension from "./index.ts";

function loadExtension(flagValue: string) {
  const tools: Array<{
    parameters: { properties: { loops: { maxItems: number } } };
  }> = [];
  let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
  const notifications: string[] = [];

  const pi = {
    registerFlag() {},
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
    getFlag() {
      return flagValue;
    },
    on(event: string, handler: typeof sessionStart) {
      if (event === "session_start") sessionStart = handler;
    },
  } as unknown as ExtensionAPI;

  adversarialLoopExtension(pi);
  sessionStart?.(
    {},
    {
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    },
  );
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
