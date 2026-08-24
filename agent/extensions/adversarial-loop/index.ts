import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatLoopResult, runAdversarialLoop } from "./core.ts";

const DEFAULT_MAX_ITERATIONS = 6;

const parameters = Type.Object({
  task: Type.String({
    minLength: 1,
    description:
      "The complete task to implement. Include all user requirements and constraints because child agents have isolated context.",
  }),
  maxIterations: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      default: DEFAULT_MAX_ITERATIONS,
      description:
        "Maximum generator attempts before the safety stop. Defaults to 6.",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "adversarial_loop",
    label: "Adversarial Loop",
    description:
      "Complete a coding task with fresh, isolated evaluator and generator pi agents. The first evaluator creates frozen acceptance criteria; each generator edits the workspace from strict feedback; fresh evaluators repeat until every criterion passes or the safety limit is reached. Child output is truncated and the default limit is 6 generator attempts.",
    promptSnippet:
      "Run an evaluator-generator loop for difficult coding tasks that need independent verification",
    promptGuidelines: [
      "Use adversarial_loop when the user explicitly asks for an adversarial/evaluator-generator loop or requests unusually persistent independent implementation and verification.",
      "Pass adversarial_loop a self-contained task containing all relevant requirements because its child agents do not receive the parent conversation.",
      "Do not claim success when adversarial_loop reports that its evaluator did not accept the task.",
    ],
    parameters,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const task = params.task.trim();
      if (!task) throw new Error("task must not be empty");
      if (!ctx.model)
        throw new Error("No active model is available for child agents");

      const model = `${ctx.model.provider}/${ctx.model.id}`;
      const result = await runAdversarialLoop({
        task,
        cwd: ctx.cwd,
        model,
        thinkingLevel: ctx.thinkingLevel ?? "off",
        maxIterations: params.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        signal,
        onUpdate,
      });

      return {
        content: [
          {
            type: "text",
            text: formatLoopResult(
              result.details,
              result.latestGeneratorReport,
            ),
          },
        ],
        details: result.details,
        usage: result.usage,
      };
    },
  });
}
