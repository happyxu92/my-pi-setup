import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import accountsExtension, { FAIL_CLOSED_API_KEY } from "./src/accounts.ts";
import {
  AccountStore,
  InMemoryAccountStorageBackend,
} from "./src/account-store.ts";
import type { AccountProviderAdapter } from "./src/oauth.ts";
import { ProjectDefaultsStore } from "./src/project-defaults.ts";
import {
  ACCOUNT_SELECTION_ENTRY_TYPE,
  createAccountSelectionEntryData,
  restoreAccountSelections,
} from "./src/session-selection.ts";

const providers: AccountProviderAdapter[] = ["openai-codex", "anthropic"].map(
  (id) => ({
    id: id as AccountProviderAdapter["id"],
    displayName: id,
    requiresApiKeyBridge: id === "openai-codex",
    runtimeAuthMode: "api-key",
    oauth: {
      async login() {
        throw new Error("Unexpected login");
      },
      async refresh() {
        throw new Error("Unexpected refresh");
      },
      async toAuth(credential) {
        return { apiKey: credential.access };
      },
    },
  }),
);

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-accounts-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  for (const provider of providers) {
    await store.updateProvider(provider.id, () => ({
      active: "global",
      accounts: Object.fromEntries(
        ["global", "work", "personal"].map((name) => [
          name,
          {
            type: "oauth" as const,
            access: `test-${provider.id}-${name}`,
            refresh: "test-refresh",
            expires: Date.now() + 3_600_000,
          },
        ]),
      ),
    }));
  }
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const events = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => events.set(event, handler),
    registerCommand() {},
    events: { on() {} },
  } as unknown as ExtensionAPI;
  accountsExtension(pi, { store, providers });

  async function session(name: string, trusted = true) {
    const cwd = join(root, name);
    await mkdir(cwd, { recursive: true });
    const sessionManager = SessionManager.inMemory(cwd);
    const keys = new Map<string, string>();
    const configs = new Map<string, object>();
    const notices: string[] = [];
    let aborted = false;
    const model: Model<Api> = {
      id: "test-codex",
      name: "test-codex",
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1_000,
    };
    const registry = {
      setRuntimeApiKey: (id: string, key: string) => {
        keys.set(id, key);
      },
      removeRuntimeApiKey: (id: string) => {
        keys.delete(id);
      },
      getApiKeyForProvider: async (id: string) => keys.get(id),
      getRegisteredProviderConfig: (id: string) => configs.get(id),
      registerProvider: (id: string, config: object) => {
        configs.set(id, config);
      },
      unregisterProvider: (id: string) => {
        configs.delete(id);
      },
      getAll: () => [model],
      find: (id: string, modelId: string) =>
        id === model.provider && modelId === model.id ? model : undefined,
    };
    const ctx = {
      cwd,
      sessionManager,
      model,
      modelRegistry: registry,
      hasUI: false,
      mode: "print",
      isProjectTrusted: () => trusted,
      ui: {
        notify: (message: string) => notices.push(message),
        setStatus() {},
      },
      abort: () => {
        aborted = true;
      },
    } as unknown as ExtensionContext;
    async function emit(event: string, data: unknown = {}) {
      const handler = events.get(event);
      assert.ok(handler, `missing handler: ${event}`);
      await handler(data, ctx);
    }
    return {
      cwd,
      ctx,
      sessionManager,
      keys,
      notices,
      emit,
      get aborted() {
        return aborted;
      },
      selection() {
        const restored = restoreAccountSelections(
          sessionManager.getEntries(),
          sessionManager.getSessionId(),
        );
        assert.equal(restored.status, "loaded");
        return restored.status === "loaded" ? { ...restored.selections } : {};
      },
    };
  }
  return { store, session };
}

test("two concurrent projects use their own defaults without changing the shared global default", async (t) => {
  const { store, session } = await setup(t);
  const a = await session("a");
  const b = await session("b");
  await new ProjectDefaultsStore(a.cwd).set("openai-codex", "work", () => true);
  await new ProjectDefaultsStore(b.cwd).set(
    "openai-codex",
    "personal",
    () => true,
  );
  const before = store.read();
  await Promise.all([a.emit("session_start"), b.emit("session_start")]);
  assert.deepEqual(a.selection(), {
    "openai-codex": "work",
    anthropic: "global",
  });
  assert.equal(b.selection()["openai-codex"], "personal");
  assert.equal(a.keys.get("openai-codex"), "test-openai-codex-work");
  assert.equal(b.keys.get("openai-codex"), "test-openai-codex-personal");
  assert.deepEqual(store.read(), before);
  await a.emit("session_shutdown");
  assert.equal(a.keys.size, 0);
  assert.equal(b.keys.get("openai-codex"), "test-openai-codex-personal");
});

test("missing and untrusted project defaults inherit global accounts", async (t) => {
  const { session } = await setup(t);
  const missing = await session("missing");
  const untrusted = await session("untrusted", false);
  await new ProjectDefaultsStore(untrusted.cwd).set(
    "openai-codex",
    "work",
    () => true,
  );
  for (const candidate of [missing, untrusted]) {
    await candidate.emit("session_start");
    assert.equal(candidate.selection()["openai-codex"], "global");
    assert.equal(
      candidate.keys.get("openai-codex"),
      "test-openai-codex-global",
    );
  }
});

test("explicit project built-in login overrides a named global default", async (t) => {
  const { session } = await setup(t);
  const current = await session("builtin");
  await new ProjectDefaultsStore(current.cwd).set(
    "openai-codex",
    null,
    () => true,
  );
  await current.emit("session_start");
  assert.equal(current.selection()["openai-codex"], null);
  assert.equal(current.keys.has("openai-codex"), false);
  assert.equal(current.selection().anthropic, "global");
});

for (const reason of ["reload", "resume"] as const) {
  test(`${reason} restores the session selection even after project JSON becomes malformed`, async (t) => {
    const { store, session } = await setup(t);
    const current = await session(reason);
    const config = new ProjectDefaultsStore(current.cwd);
    await config.set("openai-codex", "work", () => true);
    await current.emit("session_start");
    await current.emit("session_shutdown");
    await store.updateProvider("openai-codex", (state) => ({
      ...state,
      active: "personal",
    }));
    await writeFile(config.path, "broken");
    await current.emit("session_start", { reason });
    assert.equal(current.selection()["openai-codex"], "work");
    assert.equal(current.keys.get("openai-codex"), "test-openai-codex-work");
  });
}

for (const reason of ["new", "fork", "clone"] as const) {
  test(`${reason} snapshots the target project's default, not copied parent selections`, async (t) => {
    const { session } = await setup(t);
    const parent = await session("parent");
    await new ProjectDefaultsStore(parent.cwd).set(
      "openai-codex",
      "work",
      () => true,
    );
    await parent.emit("session_start");
    const child = await session("child");
    await new ProjectDefaultsStore(child.cwd).set(
      "openai-codex",
      "personal",
      () => true,
    );
    if (reason !== "new") {
      for (const entry of parent.sessionManager.getEntries()) {
        if (entry.type === "custom")
          child.sessionManager.appendCustomEntry(entry.customType, entry.data);
      }
    }
    await child.emit("session_start", {
      reason: reason === "clone" ? "fork" : reason,
    });
    assert.equal(child.selection()["openai-codex"], "personal");
    assert.equal(parent.selection()["openai-codex"], "work");
  });
}

test("a saved manual built-in session selection takes precedence over project and global defaults", async (t) => {
  const { session } = await setup(t);
  const current = await session("manual");
  await new ProjectDefaultsStore(current.cwd).set(
    "openai-codex",
    "work",
    () => true,
  );
  current.sessionManager.appendCustomEntry(
    ACCOUNT_SELECTION_ENTRY_TYPE,
    createAccountSelectionEntryData(current.sessionManager.getSessionId(), {
      "openai-codex": null,
    }),
  );
  await current.emit("session_start");
  assert.equal(current.selection()["openai-codex"], null);
  assert.equal(current.selection().anthropic, "global");
  assert.equal(current.keys.has("openai-codex"), false);
});

test("a missing named project account fails closed only for that provider and aborts its turn", async (t) => {
  const { session } = await setup(t);
  const current = await session("missing-account");
  await new ProjectDefaultsStore(current.cwd).set(
    "openai-codex",
    "not-saved",
    () => true,
  );
  await current.emit("session_start");
  assert.equal(current.selection()["openai-codex"], "not-saved");
  assert.equal(current.keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
  assert.equal(current.keys.get("anthropic"), "test-anthropic-global");
  await current.emit("before_agent_start");
  await current.emit("turn_start");
  assert.equal(current.aborted, true);
});

test("malformed project config fails closed without persisting fallback; repair and reload recovers", async (t) => {
  const { session } = await setup(t);
  const current = await session("broken");
  const config = new ProjectDefaultsStore(current.cwd);
  await config.set("openai-codex", "work", () => true);
  await writeFile(
    config.path,
    '{"defaults":{"openai-codex":"secret\\nvalue"}}',
  );
  await current.emit("session_start");
  assert.equal(current.keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
  assert.deepEqual(
    restoreAccountSelections(
      current.sessionManager.getEntries(),
      current.sessionManager.getSessionId(),
    ),
    { status: "missing" },
  );
  assert.doesNotMatch(current.notices.join("\n"), /secret/);
  await current.emit("before_agent_start");
  await current.emit("turn_start");
  assert.equal(current.aborted, true);
  await current.emit("session_shutdown");
  await writeFile(config.path, '{"defaults":{"openai-codex":"work"}}');
  await current.emit("session_start", { reason: "reload" });
  assert.equal(current.selection()["openai-codex"], "work");
  assert.equal(current.keys.get("openai-codex"), "test-openai-codex-work");
});

test("malformed saved session selections are not silently replaced by project defaults", async (t) => {
  const { session } = await setup(t);
  const current = await session("broken-session");
  await new ProjectDefaultsStore(current.cwd).set(
    "openai-codex",
    "work",
    () => true,
  );
  current.sessionManager.appendCustomEntry(ACCOUNT_SELECTION_ENTRY_TYPE, {
    version: 999,
    sessionId: current.sessionManager.getSessionId(),
    providers: { "openai-codex": "work" },
  });
  await current.emit("session_start");
  assert.equal(current.keys.get("openai-codex"), FAIL_CLOSED_API_KEY);
});
