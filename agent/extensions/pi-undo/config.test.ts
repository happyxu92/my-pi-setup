import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPiUndoConfig, parsePiUndoConfig } from "./src/config.ts";

test("canonicalizes and deduplicates excluded directories", () => {
  assert.deepEqual(
    parsePiUndoConfig({
      excludeDirectories: ["outputs/cache", "./outputs/", ".venv", ".venv"],
    }),
    { excludeDirectories: [".venv", "outputs"] },
  );
});

test("rejects unsafe excluded directories", () => {
  for (const directory of [
    ".",
    "../outside",
    ".git/objects",
    "/absolute",
    "C:/absolute",
  ]) {
    assert.throws(
      () => parsePiUndoConfig({ excludeDirectories: [directory] }),
      /excludeDirectories/,
    );
  }
});

test("loads project configuration and defaults missing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-undo-config-"));
  const configDirectory = join(directory, ".pi");
  const configPath = join(configDirectory, "pi-undo.json");

  assert.deepEqual(await loadPiUndoConfig(configPath), {
    excludeDirectories: [],
  });
  await mkdir(configDirectory);
  await writeFile(
    configPath,
    JSON.stringify({ excludeDirectories: ["outputs"] }),
  );
  assert.deepEqual(await loadPiUndoConfig(configPath), {
    excludeDirectories: ["outputs"],
  });
});
