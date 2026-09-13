import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showAccountsMenu } from "./src/account-menu.ts";
import {
  AccountStore,
  InMemoryAccountStorageBackend,
} from "./src/account-store.ts";
import { createBuiltinProviderAdapters } from "./src/oauth.ts";
import { ProjectDefaultsStore } from "./src/project-defaults.ts";

async function setup(
  t: TestContext,
  choices: (string | undefined)[],
  trusted = true,
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-accounts-project-menu-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  const credential = {
    type: "oauth" as const,
    access: "secret-access",
    refresh: "secret-refresh",
    expires: 2_000_000_000_000,
  };
  await store.updateProvider("openai-codex", () => ({
    active: "personal",
    accounts: { work: credential, personal: credential },
  }));
  const session = { selections: { "openai-codex": "personal" } };
  const controller = new AbortController();
  const owner = {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  };
  const notices: string[] = [];
  const screens: string[] = [];
  let beforeSelect: (() => Promise<void>) | undefined;
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: true,
    isProjectTrusted: () => trusted,
    ui: {
      select: async (title: string, options: string[]) => {
        screens.push(`${title}\n${options.join("\n")}`);
        await beforeSelect?.();
        const choice = choices.shift();
        if (choice !== undefined)
          assert.ok(
            options.includes(choice),
            `missing choice ${choice} in ${options}`,
          );
        return choice;
      },
      notify: (message: string) => {
        notices.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;
  const handlers = {
    async login() {
      throw new Error("Unexpected login");
    },
    async switch() {
      throw new Error("Unexpected session switch");
    },
    async remove() {
      throw new Error("Unexpected removal");
    },
  };
  const adapters = new Map(
    createBuiltinProviderAdapters().map((adapter) => [adapter.id, adapter]),
  );
  return {
    cwd,
    store,
    session,
    controller,
    notices,
    screens,
    setBeforeSelect(callback: () => Promise<void>) {
      beforeSelect = callback;
    },
    run: () => showAccountsMenu(ctx, store, adapters, session, handlers, owner),
  };
}

test("/accounts project menu saves a name only and leaves session and global defaults unchanged", async (t) => {
  const harness = await setup(t, [
    "Set project default account",
    "OpenAI Codex",
    "Account: work",
  ]);
  const before = harness.store.read();
  await harness.run();
  const project = new ProjectDefaultsStore(harness.cwd);
  assert.deepEqual(await project.read(), { "openai-codex": "work" });
  assert.deepEqual(JSON.parse(await readFile(project.path, "utf8")), {
    defaults: { "openai-codex": "work" },
  });
  assert.deepEqual(harness.store.read(), before);
  assert.deepEqual(harness.session.selections, { "openai-codex": "personal" });
  assert.match(harness.notices.join("\n"), /session is unchanged/);
  assert.doesNotMatch(
    [...harness.notices, ...harness.screens].join("\n"),
    /secret-access|secret-refresh/,
  );
});

for (const choice of [
  "Pi built-in login",
  "Inherit global default (personal)",
]) {
  test(`project menu supports ${choice}`, async (t) => {
    const harness = await setup(t, [
      "Set project default account",
      "OpenAI Codex",
      choice,
    ]);
    const project = new ProjectDefaultsStore(harness.cwd);
    await project.set("openai-codex", "work", () => true);
    await harness.run();
    assert.deepEqual(
      await project.read(),
      choice === "Pi built-in login" ? { "openai-codex": null } : {},
    );
    assert.equal(
      harness.store.read().providers["openai-codex"]?.active,
      "personal",
    );
  });
}

for (const choices of [
  ["Set project default account", undefined],
  ["Set project default account", "OpenAI Codex", undefined],
]) {
  test(`project menu cancellation at screen ${choices.length} does not create a file`, async (t) => {
    const harness = await setup(t, choices);
    await harness.run();
    assert.deepEqual(await readdir(harness.cwd), []);
  });
}

test("untrusted projects cannot set project defaults", async (t) => {
  const harness = await setup(t, ["Set project default account"], false);
  await harness.run();
  assert.deepEqual(await readdir(harness.cwd), []);
  assert.match(harness.notices.join("\n"), /trusted project/);
});

for (const failure of ["removed", "shutdown", "malformed"] as const) {
  test(`project menu handles ${failure} between selection and save without false success`, async (t) => {
    const harness = await setup(t, [
      "Set project default account",
      "OpenAI Codex",
      "Account: work",
    ]);
    const project = new ProjectDefaultsStore(harness.cwd);
    harness.setBeforeSelect(async () => {
      if (harness.screens.length !== 3) return;
      if (failure === "removed") {
        await harness.store.updateProvider("openai-codex", (state) => {
          delete state.accounts.work;
          return state;
        });
      } else if (failure === "shutdown") {
        harness.controller.abort();
      } else {
        await project.set("openai-codex", "personal", () => true);
        await writeFile(project.path, "broken");
      }
    });
    await harness.run();
    assert.doesNotMatch(harness.notices.join("\n"), /Saved to/);
    if (failure === "malformed")
      assert.equal(await readFile(project.path, "utf8"), "broken");
    else assert.deepEqual(await project.read(), {});
  });
}

test("the original global default menu still updates only the global default", async (t) => {
  const harness = await setup(t, [
    "Set default account",
    "OpenAI Codex",
    "work",
  ]);
  await harness.run();
  assert.equal(harness.store.read().providers["openai-codex"]?.active, "work");
  assert.deepEqual(harness.session.selections, { "openai-codex": "personal" });
  assert.deepEqual(await readdir(harness.cwd), []);
});
