# my-pi-setup

个人 [pi](https://github.com/earendil-works/pi-coding-agent) 配置仓库，包含自定义 System Prompt、扩展、Prompt 模板和 Skills。

## 项目结构

```
my-pi-setup/
├── AGENT.md                   # Agent 行为守则（编码风格/习惯偏好）
├── agent/                     # pi agent 配置（软链接目标）
│   ├── SYSTEM.MD              # pi 系统提示词（启动时加载）
│   ├── extensions/            # pi 扩展
│   │   ├── enable-grep-find.ts    # 默认启用 pi 原生 grep / find 工具
│   │   ├── tokens-per-second.ts   # 状态栏实时显示 token/s 速率
│   │   └── show-system-prompt.ts  # 注册 `system-prompt` 命令，查看当前系统提示
│   ├── prompts/               # pi Prompt 模板
│   │   ├── commit.md              # 仅提交当前会话的改动
│   │   └── commit-all.md          # 提交工作区所有改动
│   └── skills/                # pi Skills
│       └── browser-tools/         # 基于 Chrome DevTools Protocol 的浏览器自动化
├── package.json
└── tsconfig.json
```

## 安装

### 1. 克隆并安装依赖

```bash
git clone <repo-url> ~/Documents/code/happy/my-pi-setup
cd ~/Documents/code/happy/my-pi-setup
npm install
PUPPETEER_SKIP_DOWNLOAD=true npm --prefix agent/skills/browser-tools ci
```

### 2. 创建软链接

将本仓库的 `agent/` 目录下的配置软链接到 `~/.pi/agent/`，pi 启动时会自动加载：

```bash
# 确保 ~/.pi/agent/ 目录存在
mkdir -p ~/.pi/agent

# 如果目标已存在（旧文件或旧链接），先删除
rm -f ~/.pi/agent/SYSTEM.MD
rm -f ~/.pi/agent/extensions
rm -f ~/.pi/agent/prompts
rm -f ~/.pi/agent/skills

# 创建软链接
ln -s "$(pwd)/agent/SYSTEM.MD"   ~/.pi/agent/SYSTEM.MD
ln -s "$(pwd)/agent/extensions"  ~/.pi/agent/extensions
ln -s "$(pwd)/agent/prompts"     ~/.pi/agent/prompts
ln -s "$(pwd)/agent/skills"      ~/.pi/agent/skills
```

验证链接是否正确：

```bash
ls -la ~/.pi/agent/SYSTEM.MD ~/.pi/agent/extensions ~/.pi/agent/prompts ~/.pi/agent/skills
```

应输出类似：

```
~/.pi/agent/SYSTEM.MD   -> /Users/happy/.../my-pi-setup/agent/SYSTEM.MD
~/.pi/agent/extensions  -> /Users/happy/.../my-pi-setup/agent/extensions
~/.pi/agent/prompts     -> /Users/happy/.../my-pi-setup/agent/prompts
~/.pi/agent/skills      -> /Users/happy/.../my-pi-setup/agent/skills
```

如果 pi 已在运行，执行 `/reload` 使新 Skill 生效。

### 3. 安装第三方扩展（可选）

以下第三方扩展需通过 `pi install` 手动安装，不在本仓库管理：

```bash
pi install npm:pi-web-access
pi install npm:pi-undo-redo
```

| 包名 | 说明 |
|------|------|
| **pi-web-access** | 网页搜索与内容抓取工具（web_search、fetch_content 等） |
| **pi-undo-redo** | 会话撤销/重做命令（`/undo`、`/redo`） |

> 验证安装：`pi list`

## 扩展说明

| 扩展 | 说明 |
|------|------|
| **enable-grep-find** | 默认启用 pi 原生的 `grep` 和 `find` 工具（两者默认关闭）。通过 `session_start` 事件自动添加到活跃工具列表。 |
| **tokens-per-second** | 在状态栏显示当前流式响应的 token 生成速率（`tok/s`）。流开始时显示 `… tok/s`，结束后显示实际速率。 |
| **show-system-prompt** | 注册 `:system-prompt` 命令，运行后在通知中展示当前完整系统提示及字符数。 |

## Skill 说明

| Skill | 说明 |
|-------|------|
| **browser-tools** | 通过 Chrome DevTools Protocol 启动和控制可见 Chrome，支持导航、执行 JavaScript、截图、交互式选择元素、Cookie 检查和正文提取。可使用 `/skill:browser-tools` 显式加载。 |

Skill 来源于 [badlogic/pi-skills](https://github.com/badlogic/pi-skills/tree/main/browser-tools)，按 MIT License 分发。`--profile` 会将 Chrome 默认配置（包括 Cookie 和登录状态）复制到 `~/.cache/browser-tools`，请仅在需要时使用。

## Prompt 模板说明

| 模板 | 命令 | 说明 |
|------|------|------|
| **commit** | `/commit` | 仅提交**当前会话**中产生的改动，不触碰会话外的已有变更。自动运行 lint/check、生成 Conventional Commit 消息。 |
| **commit-all** | `/commit-all` | 提交工作区**全部**改动（`git add -A`）。同样包含安全检查和自动 lint。 |

## 开发

```bash
# 类型检查
npm run check

# 格式化
npm run format

# 格式化检查
npm run format:check

# 运行测试
npm run test
```