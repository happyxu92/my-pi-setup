# Local pi-undo

Local fork of `@davideasden/pi-undo@0.2.11`.

## Local changes

- Supports project-local `excludeDirectories` configuration.
- Normalizes Pi physical tree leaves before comparing them with pi-undo logical leaves, preventing `/tree` from creating a false `RECOVERY_REQUIRED` transaction.
- Rejects undo/redo between manifests created with different exclusion configurations.

The original documentation is preserved in [UPSTREAM.md](UPSTREAM.md). The upstream MIT license is preserved in [LICENSE](LICENSE).

## Configuration

Create `<workspace>/.pi/pi-undo.json`:

```json
{
  "excludeDirectories": [".venv", "outputs", "logs"]
}
```

Paths are relative to the workspace root. Excluded directories:

- are not traversed during nested-repository discovery;
- are not captured in workspace snapshots;
- are not restored by `/undo`, `/redo`, or `/tree`;
- remain unmanaged even when they do not currently exist.

Configuration is read only for trusted projects and only when the extension session starts. Run `/reload` after changing it. Parent exclusions subsume child exclusions, and `.git`, absolute paths, and parent-directory escapes are rejected.

Changing `excludeDirectories` invalidates compatibility with older snapshots. Existing checkpoints remain stored but cannot be restored until the previous configuration is restored.
