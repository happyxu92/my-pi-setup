# my-pi-setup

Personal configuration repository for [pi](https://github.com/earendil-works/pi-coding-agent), including a custom system prompt, extensions, prompt templates, and skills.

## Project Structure

```
my-pi-setup/
├── AGENT.md                   # Agent guidelines (coding style and preferences)
├── agent/                     # pi agent configuration (symlink target)
│   ├── SYSTEM.MD              # pi system prompt (loaded at startup)
│   ├── extensions/            # pi extensions
│   │   ├── adversarial-loop/      # Adversarial evaluator-generator task loop
│   │   ├── codex-fast.ts          # Enables the Fast service tier for Codex subscriptions
│   │   ├── enable-grep-find.ts    # Enables pi's built-in grep/find tools by default
│   │   ├── pi-undo/               # Local workspace undo/redo extension
│   │   ├── tokens-per-second.ts   # Displays the real-time token/s rate in the status bar
│   │   └── llm-context-inspector.ts # Inspects the system prompt and active tool definitions
│   ├── prompts/               # pi prompt templates
│   │   ├── commit.md              # Commits changes from the current session only
│   │   └── commit-all.md          # Commits all workspace changes
│   └── skills/                # pi skills
│       └── browser-tools/         # Browser automation via Chrome DevTools Protocol
├── package.json
└── tsconfig.json
```

## Installation

### 1. Clone the Repository and Install Dependencies

```bash
git clone <repo-url> ~/Documents/code/happy/my-pi-setup
cd ~/Documents/code/happy/my-pi-setup
npm install
PUPPETEER_SKIP_DOWNLOAD=true npm --prefix agent/skills/browser-tools ci
```

### 2. Create Symlinks

Symlink the configuration in this repository's `agent/` directory into `~/.pi/agent/`. pi will load it automatically at startup:

```bash
# Make sure ~/.pi/agent/ exists
mkdir -p ~/.pi/agent

# Remove existing targets (old files or symlinks), if any
rm -f ~/.pi/agent/SYSTEM.MD
rm -f ~/.pi/agent/extensions
rm -f ~/.pi/agent/prompts
rm -f ~/.pi/agent/skills

# Create symlinks
ln -s "$(pwd)/agent/SYSTEM.MD"   ~/.pi/agent/SYSTEM.MD
ln -s "$(pwd)/agent/extensions"  ~/.pi/agent/extensions
ln -s "$(pwd)/agent/prompts"     ~/.pi/agent/prompts
ln -s "$(pwd)/agent/skills"      ~/.pi/agent/skills
```

Verify the symlinks:

```bash
ls -la ~/.pi/agent/SYSTEM.MD ~/.pi/agent/extensions ~/.pi/agent/prompts ~/.pi/agent/skills
```

The output should look similar to this:

```
~/.pi/agent/SYSTEM.MD   -> /Users/happy/.../my-pi-setup/agent/SYSTEM.MD
~/.pi/agent/extensions  -> /Users/happy/.../my-pi-setup/agent/extensions
~/.pi/agent/prompts     -> /Users/happy/.../my-pi-setup/agent/prompts
~/.pi/agent/skills      -> /Users/happy/.../my-pi-setup/agent/skills
```

If pi is already running, run `/reload` to load the new skill.

### 3. Install Third-Party Extensions (Optional)

The following third-party extension must be installed manually with `pi install` and is not managed by this repository:

```bash
pi install npm:pi-web-access
```

| Package | Description |
|---------|-------------|
| **pi-web-access** | Web search and content-fetching tools, including `web_search` and `fetch_content` |

This repository already includes a local copy of `pi-undo`. Do not enable `pi-undo-redo` or the npm version of `@davideasden/pi-undo` at the same time, or commands such as `/undo` and `/redo` will be registered more than once.

> Verify the installation with `pi list`.

## Extensions

| Extension | Description |
|-----------|-------------|
| **adversarial-loop** | Registers the `adversarial_loop` tool. For code and non-code deliverables with strict completion criteria or high quality requirements, it uses independent evaluator and generator subprocesses to establish acceptance criteria, iteratively improve the deliverable, and verify it independently until it passes or reaches a safety limit. |
| **codex-fast** | Injects `service_tier: "priority"` into `openai-codex` subscription requests to enable the Codex Fast service tier. Actual availability depends on the account, plan, and model permissions. |
| **enable-grep-find** | Enables pi's built-in `grep` and `find` tools, which are disabled by default. It adds them to the active tool list automatically during the `session_start` event. |
| **pi-undo** | Based on `@davideasden/pi-undo@0.2.11`, with directory-exclusion support and a fix for logical-leaf comparison in `/tree`. Project configuration is stored in `<workspace>/.pi/pi-undo.json`. |
| **tokens-per-second** | Displays the token generation rate (`tok/s`) for the current streaming response in the status bar. It shows `… tok/s` when streaming begins and the measured rate when streaming ends. |
| **llm-context-inspector** | Registers the `/system-prompt` and `/tools` commands, which display the complete current system prompt and active tool definitions, respectively. |

## Skills

| Skill | Description |
|-------|-------------|
| **browser-tools** | Launches and controls a visible Chrome browser through the Chrome DevTools Protocol. It supports navigation, JavaScript execution, screenshots, interactive element selection, cookie inspection, and main-content extraction. Load it explicitly with `/skill:browser-tools`. |

The skill is sourced from [badlogic/pi-skills](https://github.com/badlogic/pi-skills/tree/main/browser-tools) and distributed under the MIT License. The `--profile` option copies the default Chrome profile, including cookies and login state, to `~/.cache/browser-tools`; use it only when necessary.

## Prompt Templates

| Template | Command | Description |
|----------|---------|-------------|
| **commit** | `/commit` | Commits only changes made during the **current session**, without touching pre-existing changes from outside the session. It automatically runs lint/check tasks and generates a Conventional Commit message. |
| **commit-all** | `/commit-all` | Commits **all** workspace changes (`git add -A`). It also includes safety checks and automatic linting. |

## Development

```bash
# Type-check
npm run check

# Format
npm run format

# Check formatting
npm run format:check

# Run tests
npm run test
```
