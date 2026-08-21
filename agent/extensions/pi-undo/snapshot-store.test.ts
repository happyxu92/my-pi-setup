import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RestoreEngine } from "./src/restore-engine.ts";
import { RootDiscovery } from "./src/root-discovery.ts";
import { SnapshotStore } from "./src/snapshot-store.ts";

test("collapses a fully ignored directory while protecting its descendants", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-undo-workspace-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "pi-undo-store-"));
  try {
    await mkdir(join(workspace, "cache"));
    await writeFile(join(workspace, ".gitignore"), "");
    await writeFile(join(workspace, "cache", "artifact.txt"), "generated");

    const discovery = new RootDiscovery();
    const topology = await discovery.discover(workspace);
    const store = new SnapshotStore({ storeRoot, discovery });
    const current = await store.capture(topology);

    await writeFile(join(workspace, ".gitignore"), "cache/\n");
    const target = await store.capture(topology);
    assert.deepEqual(target.roots[0]?.ignoredPresentPaths, ["cache"]);
    assert.equal((await store.capture(topology)).manifestId, target.manifestId);

    const restore = new RestoreEngine({
      workspaceRoot: workspace,
      store,
      discovery,
    });
    const plan = await restore.plan(current, target);
    assert.equal(plan.deletePaths.includes("cache/artifact.txt"), false);
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(storeRoot, { recursive: true, force: true }),
    ]);
  }
});
