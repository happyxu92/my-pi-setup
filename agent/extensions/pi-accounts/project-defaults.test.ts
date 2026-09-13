import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  loadProjectDefaults,
  parseProjectDefaults,
  ProjectDefaultsStore,
} from "./src/project-defaults.ts";

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-project-accounts-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("project defaults distinguish inherited, named and built-in accounts", () => {
  assert.deepEqual(parseProjectDefaults(undefined), {});
  assert.deepEqual(parseProjectDefaults('{"defaults":{}}'), {});
  assert.deepEqual(
    parseProjectDefaults(
      '{"defaults":{"openai-codex":" work ","anthropic":null,"xai":"default"}}',
    ),
    { "openai-codex": "work", anthropic: null, xai: null },
  );
});

for (const raw of [
  "",
  "{",
  "null",
  "[]",
  "{}",
  '{"defaults":null}',
  '{"defaults":[]}',
  '{"defaults":{"openai-codex":42}}',
  '{"defaults":{"openai-codex":""}}',
  '{"defaults":{"openai-codex":"secret\\nvalue"}}',
  '{"defaults":{"unknown":"work"}}',
  '{"defaults":{"__proto__":"work"}}',
  '{"defaults":{},"providers":{"openai-codex":{"accounts":{"secret":"token"}}}}',
]) {
  test(`invalid project JSON is rejected without echoing its contents: ${raw}`, () => {
    assert.throws(
      () => parseProjectDefaults(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /project defaults/);
        assert.doesNotMatch(error.message, /secret|token/);
        return true;
      },
    );
  });
}

test("missing project configuration has no filesystem side effects", async (t) => {
  const cwd = await workspace(t);
  assert.deepEqual(await new ProjectDefaultsStore(cwd).read(), {});
  assert.deepEqual(await readdir(cwd), []);
});

test("untrusted project configuration is not read, even if malformed", async (t) => {
  const cwd = await workspace(t);
  await mkdir(join(cwd, ".pi"));
  const path = join(cwd, ".pi", "pi-accounts.json");
  await writeFile(path, "invalid");
  assert.deepEqual(
    await loadProjectDefaults({ cwd, isProjectTrusted: () => false }),
    {},
  );
  await assert.rejects(
    loadProjectDefaults({ cwd, isProjectTrusted: () => true }),
    /project defaults/,
  );
});

test("writes are private, atomic and preserve other providers across concurrent stores", async (t) => {
  const cwd = await workspace(t);
  const first = new ProjectDefaultsStore(cwd);
  const second = new ProjectDefaultsStore(cwd);
  await Promise.all([
    first.set("openai-codex", "work", () => true),
    second.set("anthropic", "personal", () => true),
  ]);
  assert.deepEqual(await first.read(), {
    "openai-codex": "work",
    anthropic: "personal",
  });
  await second.set("openai-codex", null, () => true);
  assert.deepEqual(await first.read(), {
    "openai-codex": null,
    anthropic: "personal",
  });
  await second.set("openai-codex", undefined, () => true);
  assert.deepEqual(await first.read(), { anthropic: "personal" });
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(cwd, ".pi")), ["pi-accounts.json"]);
  assert.deepEqual(JSON.parse(await readFile(first.path, "utf8")), {
    defaults: { anthropic: "personal" },
  });
});

test("cancelled writes and malformed files are not replaced; later writes can recover", async (t) => {
  const cwd = await workspace(t);
  const store = new ProjectDefaultsStore(cwd);
  await store.set("openai-codex", "work", () => true);
  await assert.rejects(store.set("openai-codex", "personal", () => false));
  assert.deepEqual(await store.read(), { "openai-codex": "work" });
  await writeFile(store.path, "broken");
  await assert.rejects(store.set("openai-codex", "personal", () => true));
  assert.equal(await readFile(store.path, "utf8"), "broken");
  await writeFile(store.path, '{"defaults":{}}');
  await store.set("openai-codex", "personal", () => true);
  assert.deepEqual(await store.read(), { "openai-codex": "personal" });
});

test("project files cannot symlink to the global credential store", async (t) => {
  const cwd = await workspace(t);
  const target = join(cwd, "global-accounts.json");
  await writeFile(target, "private-credentials");
  await mkdir(join(cwd, ".pi"));
  const store = new ProjectDefaultsStore(cwd);
  await symlink(target, store.path);
  await assert.rejects(store.read());
  await assert.rejects(store.set("openai-codex", "work", () => true));
  assert.equal(await readFile(target, "utf8"), "private-credentials");
});

test("defaults are scoped to exact cwd, not an ancestor project", async (t) => {
  const cwd = await workspace(t);
  await new ProjectDefaultsStore(cwd).set("openai-codex", "work", () => true);
  const child = join(cwd, "child");
  await mkdir(child);
  assert.deepEqual(
    await loadProjectDefaults({ cwd: child, isProjectTrusted: () => true }),
    {},
  );
});
