import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi's actual Jiti loader loads the local directory entry without builds or credential access", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-accounts-loader-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
    const result = await discoverAndLoadExtensions([entry], root, root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0]?.commands.has("accounts"));
    assert.ok(result.extensions[0]?.handlers.has("session_start"));
    assert.ok(result.extensions[0]?.handlers.has("session_shutdown"));
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
