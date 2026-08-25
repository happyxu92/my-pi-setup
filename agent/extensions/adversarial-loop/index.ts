import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatLoopBatchResult, runAdversarialLoopBatch } from "./core.ts";

const DEFAULT_MAX_ITERATIONS = 6;
const MAX_PARALLEL_LOOPS = 4;

const taskParameter = Type.String({
  minLength: 1,
  description:
    "The complete delivery task. Describe the expected workspace artifact, quality bar, requirements, and constraints because child agents have isolated context.",
});

const maxIterationsParameter = Type.Integer({
  minimum: 1,
  maximum: 20,
  default: DEFAULT_MAX_ITERATIONS,
  description: `Maximum generator attempts before the safety stop. Defaults to ${DEFAULT_MAX_ITERATIONS}.`,
});

const parameters = Type.Object({
  loops: Type.Array(
    Type.Object({
      task: taskParameter,
      maxIterations: Type.Optional(maxIterationsParameter),
    }),
    {
      minItems: 1,
      maxItems: MAX_PARALLEL_LOOPS,
      description: `One to ${MAX_PARALLEL_LOOPS} loops to start concurrently. Each loop shares the current workspace, so scopes should not overlap.`,
    },
  ),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "adversarial_loop",
    label: "Adversarial Loop",
    description:
      "Run evaluator-generator delivery loops with fresh isolated pi agents. Use for tasks that need strict completion standards or high quality. Each loop freezes explicit acceptance criteria, repeatedly improves the artifact, and independently evaluates it until every criterion passes or the safety limit is reached. Parallel loops share the workspace and must have non-overlapping scopes. Child output is truncated.",
    promptSnippet:
      "Iteratively produce and independently review workspace deliverables that require strict completion standards or high quality",
    promptGuidelines: [
      "Use adversarial_loop when the user explicitly requests a loop, when a task has strict completion criteria requiring independent acceptance, or when a workspace deliverable needs unusually high quality; adversarial_loop is not limited to coding and also suits documents, specifications, reports, plans, analyses, and configuration.",
      "Prefer adversarial_loop for substantial work that benefits from repeated production and review, not for casual questions or trivial edits.",
      "Pass adversarial_loop a self-contained task that names the expected workspace artifact and includes all relevant requirements, constraints, and quality expectations because its child agents do not receive the parent conversation.",
      "Always pass adversarial_loop a loops array, including for a single task; concurrent loop tasks must have independent, non-overlapping workspace scopes.",
      "Do not claim success when adversarial_loop reports that its evaluator did not accept the task.",
    ],
    parameters,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.model)
        throw new Error("No active model is available for child agents");

      const loops = params.loops.map((loop, index) => {
        const task = loop.task.trim();
        if (!task) throw new Error(`loops[${index}].task must not be empty`);
        return {
          task,
          maxIterations: loop.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        };
      });
      const result = await runAdversarialLoopBatch({
        loops,
        cwd: ctx.cwd,
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinkingLevel: ctx.thinkingLevel ?? "off",
        signal,
        onUpdate,
      });

      return {
        content: [
          {
            type: "text",
            text: formatLoopBatchResult(
              result.details,
              result.latestGeneratorReports,
            ),
          },
        ],
        details: result.details,
        usage: result.usage,
      };
    },
  });
}
