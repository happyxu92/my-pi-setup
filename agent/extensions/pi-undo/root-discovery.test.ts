import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
