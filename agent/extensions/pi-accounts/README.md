# pi-accounts (local fork)

A local fork of `@narumitw/pi-accounts` with **per-project default OAuth accounts**.
See [UPSTREAM.md](./UPSTREAM.md) for source/version details and [README.upstream.md](./README.upstream.md) for inherited OAuth behavior and limitations.

## Loading

Run `npm install` at this repository's root. With this repository's `agent/extensions` symlinked to `~/.pi/agent/extensions`, Pi auto-discovers `pi-accounts/index.ts`. No build or separate `pi install` is needed. Requires Pi 0.85.1 or newer.

**Do not load the npm versions of `@narumitw/pi-accounts` or `@narumitw/pi-codex-accounts` alongside this fork.** They manage the same credentials and commands. If installed, remove/disable them before restarting Pi:

```bash
pi uninstall npm:@narumitw/pi-accounts
# Only if the legacy package is installed:
pi uninstall npm:@narumitw/pi-codex-accounts
```

Restart Pi after removing a competing account manager. Otherwise `/reload` loads this local extension. Existing saved accounts are reused; this fork does not require copying OAuth credentials into a project.

## Quick start

1. Open `/accounts` and **Login new account** to save a named Codex account, such as `work` or `personal`.
2. Start Pi in the desired project directory.
3. Open `/accounts` → **Set project default account** → **OpenAI Codex** → **Account: work**.
4. Use `/new` to start a session with that default. To change the current session instead, use **Switch OpenAI Codex account**.

The project must be trusted. If the menu refuses, use `/trust` and restart Pi.
Choosing **Set default account** still changes only the user-wide default.

## Project configuration

The project file is `<ctx.cwd>/.pi/pi-accounts.json`:

```json
{
  "defaults": {
    "openai-codex": "work"
  }
}
```

Only the **exact Pi working directory** is used. There is no upward search, Git-root inference or cross-worktree inheritance. Start Pi from the project root to use the root's configuration. Other projects can choose another saved account name while sharing the same global credential library.

Supported provider IDs: `openai-codex`, `anthropic`, `github-copilot`, `kimi-coding`, `openrouter`, `radius`, `xai`.

- An omitted provider inherits its global default.
- `null` (or the reserved string `"default"`) explicitly chooses Pi's built-in login, even if the global default is a named account.
- Remove a provider key, or choose **Inherit global default** in the menu, to clear its project override.
- `{"defaults": {}}` is a valid empty configuration.
- Only `defaults` is allowed at the top level. Unknown providers, malformed JSON and invalid account names are rejected rather than silently ignored.

## Precedence and lifecycle

```text
Saved current-session selection
  > trusted project default
  > global default
  > Pi built-in login
```

- New sessions, `/new`, forks and clones snapshot defaults from their target working directory.
- Restart, resume and `/reload` preserve existing session selections. Editing a default never switches an already initialized session.
- A legacy session without saved selections snapshots the current defaults once. Missing provider selections are initialized without overriding already saved provider selections.
- Untrusted project configuration is not read; missing configuration inherits global defaults.
- A missing named account fails closed for that provider; it never silently falls back to another identity. Select a valid session account to recover, and repair the project default for future sessions.
- Malformed/unreadable project configuration fails managed providers closed during initialization and does not persist fallback selections. Fix the file and `/reload`, or explicitly select a session account via `/accounts` to recover. Fully initialized sessions do not re-read project defaults on restore.
- Removing a saved account does not rewrite every project's references to it. Update affected project defaults manually or through the menu.

## Storage and security

OAuth credentials and user-wide defaults remain in `<getAgentDir()>/pi-accounts.json` (normally `~/.pi/agent/pi-accounts.json`). `PI_CODING_AGENT_DIR` changes this global location, not the project file's location.

Project configuration contains **account names only**, never access tokens or refresh tokens. Session JSONL entries also contain account names rather than credentials. The menu saves project preferences without modifying the current session or global defaults.

Project writes reuse the upstream cross-process lock and atomic file replacement. Like upstream credential storage, the backend uses private file permissions (`0600`) and parent-directory permissions (`0700`); it rejects symlink/non-regular config files and does not overwrite malformed configuration. Missing configuration reads create no files.

Account names may reveal personal labels and differ across machines. Consider ignoring `.pi/pi-accounts.json` in each project's `.git/info/exclude` instead of committing it. Never commit the global credential file.

## Verification

From the repository root:

```bash
npm run check
node --test --experimental-strip-types agent/extensions/pi-accounts/*.test.ts
```

Tests cover configuration validation, trust gating, concurrent stores/projects, session precedence, reload/resume, fork/clone ownership, fail-closed behavior, menu cancellation and saves, and Pi's actual extension loader. Tests use temporary files and synthetic OAuth credentials, not live accounts. Real OAuth login and provider requests still need manual verification.
