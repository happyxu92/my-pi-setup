import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RootDiscovery } from "./src/root-discovery.ts";
import { SnapshotStore } from "./src/snapshot-store.ts";

test("excluded directories become inactive boundary roots and are not traversed", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-undo-discovery-"));
  await mkdir(join(workspace, "outputs", "nested", ".git"), {
    recursive: true,
  });
  await mkdir(join(workspace, "src"));

  const topology = await new RootDiscovery({
    excludeDirectories: ["outputs"],
  }).discover(workspace);

  assert.deepEqual(
    topology.roots.map((root) => ({
      path: root.relativeRoot,
      state: root.state,
      source: root.sourceIdentity,
    })),
    [
      { path: ".", state: "active", source: topology.workspaceIdentity },
      { path: "outputs", state: "uninitialized", source: "excluded:outputs" },
    ],
  );
});

test("default cache directory names are ignored at any depth", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-undo-default-caches-"));
  const workspace = join(parent, "workspace");
  const discovery = new RootDiscovery();
  try {
    await mkdir(join(workspace, "packages", "app", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "app", "src", "kept.py"),
      "pass",
    );
    const initialTopology = await discovery.discover(workspace);
    assert.deepEqual(initialTopology.ignoredDirectoryPaths, []);

    await mkdir(join(workspace, "packages", "app", ".pytest_cache", ".git"), {
      recursive: true,
    });
    await mkdir(join(workspace, "packages", "app", ".venv"), {
      recursive: true,
    });
    await mkdir(join(workspace, "packages", "web", "node_modules", ".git"), {
      recursive: true,
    });
    await mkdir(join(workspace, "tools", ".ruff_cache"), { recursive: true });
    await writeFile(
      join(workspace, "packages", "app", ".pytest_cache", "state"),
      "pytest",
    );
    await writeFile(
      join(workspace, "packages", "app", ".venv", "state"),
      "venv",
    );
    await writeFile(
      join(workspace, "packages", "web", "node_modules", "state"),
      "npm",
    );
    await writeFile(join(workspace, "tools", ".ruff_cache", "state"), "ruff");

    const refreshedTopology = await discovery.discover(workspace);
    assert.deepEqual(refreshedTopology.ignoredDirectoryPaths, [
      "packages/app/.pytest_cache",
      "packages/app/.venv",
      "packages/web/node_modules",
      "tools/.ruff_cache",
    ]);
    assert.deepEqual(
      refreshedTopology.roots.map((root) => root.relativeRoot),
      ["."],
    );

    const store = new SnapshotStore({
      storeRoot: join(parent, "store"),
      discovery,
    });
    const manifest = await store.capture(initialTopology);
    assert.deepEqual(manifest.roots[0]?.ignoredPresentPaths, [
      "packages/app/.pytest_cache",
      "packages/app/.venv",
      "packages/web/node_modules",
      "tools/.ruff_cache",
    ]);
    assert.deepEqual(
      (await store.listTree(manifest.manifestId, "."))
        .filter((entry) => entry.kind !== "directory")
        .map((entry) => entry.relativePath),
      ["packages/app/src/kept.py"],
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("excluded directories are omitted from snapshots", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-undo-snapshot-"));
  const workspace = join(parent, "workspace");
  await mkdir(join(workspace, "outputs"), { recursive: true });
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "outputs", "ignored.txt"), "ignored");
  await writeFile(join(workspace, "src", "kept.txt"), "kept");

  const discovery = new RootDiscovery({ excludeDirectories: ["outputs"] });
  const topology = await discovery.discover(workspace);
  const store = new SnapshotStore({
    storeRoot: join(parent, "store"),
    discovery,
  });
  const manifest = await store.capture(topology);

  assert.deepEqual(
    (await store.listTree(manifest.manifestId, "."))
      .filter((entry) => entry.kind !== "directory")
      .map((entry) => entry.relativePath),
    ["src/kept.txt"],
  );
  assert.deepEqual(await store.listTree(manifest.manifestId, "outputs"), []);
});
