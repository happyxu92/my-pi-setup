# Adversarial Loop

`adversarial_loop` 是一个 evaluator-generator 工作流工具，用两个相互独立的临时 pi 进程反复实现和验收任务。

## 工作流

1. 第一个 **evaluator** 检查当前 workspace，根据任务生成可验证的验收标准，并给出逐项结论。
2. 若未通过，新的 **generator** 根据冻结的标准和 evaluator 反馈直接修改 workspace、运行检查。
3. 下一轮启动全新的 evaluator，独立验证 generator 的结果。
4. 全部标准通过后结束；若始终未通过，则在安全上限处明确返回失败，不会伪报完成。

每个子 agent 都使用 `--no-session` 启动，因此不继承主 agent 或上一轮子 agent 的会话上下文。它们继承主会话当前的模型和 thinking level：

- evaluator 工具：`read,bash,grep,find,ls`
- generator 工具：`read,bash,edit,write,grep,find,ls`

Evaluator 的标准在第一轮后冻结；后续 agent 只通过任务、标准、反馈、generator 报告和 workspace 交换信息。

## 使用

主 agent 可调用：

```json
{
  "task": "实现……；要求……；运行……验证",
  "maxIterations": 6
}
```

参数：

- `task`：完整、自包含的任务描述。子 agent 不会看到主会话历史。
- `maxIterations`：generator 的最大执行次数，默认 `6`，范围 `1-20`。最后一次 generator 后仍会再启动 evaluator 做最终验收。

例如直接告诉主 agent：

> 使用 adversarial loop 实现用户登录接口，并确保现有测试通过。

## 当前基础版本的边界

- evaluator 与 generator 暂时使用同一个模型和 thinking level。
- evaluator 可运行 `bash` 做验证，主要依靠 system prompt 约束其不修改 workspace，尚未加入 OS 级只读沙箱。
- 遇到子进程、模型或结构化输出错误时会终止并报告工具错误；任务未通过则持续到安全上限。
- 每个子 agent 的最终报告和工具最终输出都有长度限制，避免撑爆主会话上下文。
