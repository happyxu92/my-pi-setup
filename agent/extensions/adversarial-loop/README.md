# Adversarial Loop

`adversarial_loop` 是一个 evaluator-generator 交付工作流：它让相互独立的临时 pi agent 反复产出、审查和改进 workspace 中的交付物，直到满足验收标准。

它的定位是处理以下任一类任务：

- 有严格完成标准，需要独立、逐项验收；
- 对完整性、准确性、连贯性、可用性或打磨程度有较高要求，需要多轮产出与审查。

交付物既可以是代码，也可以是文档、规格、报告、方案、分析、配置或其他可落到 workspace 并被检查的产物。简单问答和微小修改通常不值得启动 loop。

## 工作流

1. 第一个 **evaluator** 检查当前 workspace，根据任务生成具体、可观察的验收标准；除正确性和硬约束外，也会按任务纳入完整性、受众适配、可用性、证据和成品质量等要求。控制器解析并冻结这些标准后，将其写入 `task-spec.md` 作为过程记录。若 evaluator 的最终结构化输出无法解析，会在同一 RPC session 中追加纠错 prompt，默认最多重试 2 次（首次加两次重试，共最多 3 次输出）。
2. 若未通过，新的 **generator** 根据验收标准和 evaluator 反馈直接创建或改进交付物，并执行适用的检查或复核。
3. 下一轮启动全新的 evaluator；它不会收到 generator 报告，而是只根据原始任务、冻结的验收标准、当前交付物及自己的验证结果独立判断是否完成。
4. 全部标准通过后结束；若始终未通过，则在安全上限处明确返回失败，不会伪报完成。

每个子 agent 都以 RPC 模式启动全新的独立 session，并通过 `--session-dir` 将 session JSONL 保存在该轮对应的 `evaluator/` 或 `generator/` 目录中，因此不继承主 agent 或上一轮子 agent 的会话上下文。RPC 子进程在该 agent 完成前保持存活，使 evaluator 的结构化输出出错时可以在同一会话中接收纠错 user prompt；完成后通过关闭 stdin 正常退出。为保持无头执行且避免项目扩展阻塞，RPC 的 `select`、`confirm`、`input` 和 `editor` 对话请求会自动取消。它们继承主会话当前的模型和 thinking level：

- evaluator 基础工具：`read,bash,edit,write,grep,find,ls`
- generator 基础工具：`read,bash,edit,write,grep,find,ls`
- 父会话已信任项目且 `<workspace>/.pi/extensions/` 存在时，两类子 agent 都会显式加载该目录中的项目扩展及其工具
- 如果用户级 pi 包目录中存在 `pi-web-access/index.ts`，两类子 agent 都会显式加载它，并启用 `web_search,source_check,fetch_content,get_search_content`

子进程仍使用 `--no-extensions` 禁止自动发现其他扩展，只通过显式 `--extension` 加载已信任 workspace 的 `.pi/extensions/`、全局 `pi-web-access`（若已安装）和用于恢复基础工具集的内部扩展。项目扩展注册的工具默认可用，但 `adversarial_loop` 工具会被排除，避免 child agent 递归启动新的 loop。不会加载其他全局扩展，也不会尝试联网安装插件。项目扩展与普通 pi extension 一样以当前用户权限执行，因此只应信任并加载已审查的代码。

Evaluator 的 `edit` / `write` 仅用于保存自己的评估中间材料，不应修改 workspace 交付物。第一轮确定的验收标准作为后续评估的稳定基线；控制器生成的 `task-spec.md` 仅用于过程记录，不会把它的存在或路径告知 child agent。Generator 会直接收到任务、冻结的验收标准和 evaluator 反馈；evaluator 不会收到 generator 报告，只根据任务、标准和当前 workspace 独立验收。Loop 归档用于保存过程记录。

## Loop 归档

每个 loop 启动时都会在 `workspace/.adversarial-loop/` 下创建唯一目录。控制文件和非交付物中间结果不会在子 agent 退出时删除：

```text
.adversarial-loop/<loop-id>/
├── original-task.md
├── task-spec.md
├── evaluator-results.jsonl
├── generator-results.jsonl
└── iterations/
    ├── 001/
    │   ├── evaluator/
    │   │   ├── session-<UTC timestamp>-<random>.jsonl  # pi session
    │   │   ├── events.jsonl
    │   │   ├── final-response.txt
    │   │   ├── result.json
    │   │   ├── stderr.log
    │   │   └── stderr-full.log
    │   └── generator/
    │       └── ...
    └── 002/
        └── ...
```

- `evaluator-results.jsonl`：每行记录一次 evaluator 迭代的结构化结果；结构化输出在默认 2 次同会话纠错后仍无法解析、子进程失败或其他解析错误也会记录错误。每个 agent 目录的 `result.json` 通过 `outputRetries` 记录实际结构化输出重试次数。
- `generator-results.jsonl`：每行记录一次 generator 的工作总结、停止原因或错误。
- 每次迭代都会预先创建独立的 `evaluator/` 和 `generator/` 目录。子 agent 的 session 使用 `session-<UTC timestamp>-<random>.jsonl` 文件名（例如 `session-20260826T032957Z-ALBXrg.jsonl`），其中包含 user prompt、会话消息、工具调用参数和结果，是完整会话记录；`events.jsonl` 只保存精简的执行时间线，包括 agent/turn 生命周期、工具名称与成功状态、compaction 和 retry 诊断，不重复保存消息正文、流式 delta、工具参数或工具结果。最终响应、诊断信息以及 agent 主动保存的 task 相关中间材料也保留在对应目录。角色 system prompt 直接通过 CLI 参数注入。

`.adversarial-loop/` 是工作流归档，不属于任务交付物；其中的 `task-spec.md` 是控制器生成的验收标准记录。Child agent 应忽略归档内容，不应将其当成交付物或修改其他 agent 的目录。

## 代码结构

- `index.ts`：工具注册、参数 schema 和 pi 上下文适配。
- `core.ts`：单 loop / 并发 batch 编排与最终结果格式化。
- `child-agent.ts`：临时 pi 子进程的启动、取消、扩展选择、事件读取和 usage 汇总。
- `child-tools.ts`：启用 child agent 基础工具，同时保留项目扩展注册的工具。
- `evaluator.ts`：evaluator 提示词、验收输出解析和规范化。
- `generator.ts`：generator 提示词构建。
- `types.ts`：共享领域类型。
- `utils.ts`：usage、字符串清理和截断等无状态工具。

## 使用

调用使用 `loops` 参数。支持单个或多个 loop：

```json
{
  "loops": [
    {
      "task": "在 docs/ 下交付……；必须覆盖……；面向……；用……复核",
      "maxIterations": 6
    }
  ]
}
```

多个独立 loop 可通过一次工具调用并发启动（最多 `n` 个）：

```json
{
  "loops": [
    {
      "task": "在 packages/a 中实现……；运行……验证",
      "maxIterations": 4
    },
    {
      "task": "在 packages/b 中实现……；运行……验证",
      "maxIterations": 6
    }
  ]
}
```

参数：

- `loops`：必填的 loop 列表，包含 `1-n` 项。
- `loops[].task`：完整、自包含的任务描述。子 agent 不会看到主会话历史。
- `loops[].maxIterations`：generator 的最大执行次数，默认 `6`，范围 `1-20`。最后一次 generator 后仍会再启动 evaluator 做最终验收。

并发 loop 共享当前 workspace，可能同时运行 generator。应为每项划分互不重叠的目录或文件范围；存在依赖关系或会修改相同文件的任务应使用单个 loop 串行完成。

例如直接告诉主 agent：

> 使用 adversarial loop 实现用户登录接口，并确保现有测试通过。

> 使用 adversarial loop 在 docs/architecture.md 中产出可评审的架构方案，要求覆盖备选方案、权衡、迁移步骤、风险和回滚策略，并达到可以直接进入评审的质量。

## 当前基础版本的边界

- evaluator 与 generator 暂时使用同一个模型和 thinking level。
- evaluator 可使用 `edit` / `write` 保存中间材料，也可运行 `bash` 做验证；目前主要依靠 system prompt 约束其不修改 workspace 交付物，尚未加入 OS 级写入隔离。
- 遇到子进程或模型错误时会终止并报告工具错误。Evaluator 的结构化输出错误会先在同一 RPC session 中默认重试 2 次，仍失败才终止；并发模式下终止错误会同时取消其他 loop。任务未通过则持续到安全上限。
- 每个子 agent 的最终报告和工具最终输出都有长度限制，避免撑爆主会话上下文。
