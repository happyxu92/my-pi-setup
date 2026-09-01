import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  DEFAULT_MAX_PARALLEL_LOOPS,
  MAX_PARALLEL_LOOPS_FLAG,
  parseMaxParallelLoops,
} from "./config.ts";
import { formatLoopBatchResult, runAdversarialLoopBatch } from "./core.ts";

const DEFAULT_MAX_ITERATIONS = 6;

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

function createParameters(maxParallelLoops: number) {
  return Type.Object({
    loops: Type.Array(
      Type.Object({
        task: taskParameter,
        maxIterations: Type.Optional(maxIterationsParameter),
      }),
      {
        minItems: 1,
        maxItems: maxParallelLoops,
        description: `One to ${maxParallelLoops} loops to start concurrently. Each loop shares the current workspace, so scopes should not overlap.`,
      },
    ),
  });
}

function registerTool(pi: ExtensionAPI, maxParallelLoops: number) {
  pi.registerTool({
    name: "adversarial_loop",
    label: "Adversarial Loop",
    description:
      "Run evaluator-generator delivery loops with fresh isolated pi agents. Use for tasks that need strict completion standards or high quality. Each loop establishes explicit acceptance criteria, allows later evaluators to revise them only when necessary, repeatedly improves the artifact, and independently evaluates it until every criterion passes or the safety limit is reached. Parallel loops share the workspace and must have non-overlapping scopes. Child output is truncated.",
    promptSnippet:
      "Iteratively produce and independently review workspace deliverables that require strict completion standards or high quality",
    promptGuidelines: [
      "Use adversarial_loop when the user explicitly requests a loop, when a task has strict completion criteria requiring independent acceptance, or when a workspace deliverable needs unusually high quality; adversarial_loop is not limited to coding and also suits documents, specifications, reports, plans, analyses, and configuration.",
      "Prefer adversarial_loop for substantial work that benefits from repeated production and review, not for casual questions or trivial edits.",
      "Pass adversarial_loop a self-contained task that names the expected workspace artifact and includes all relevant requirements, constraints, and quality expectations because its child agents do not receive the parent conversation.",
      "Always pass adversarial_loop a loops array, including for a single task; concurrent loop tasks must have independent, non-overlapping workspace scopes.",
      "Do not claim success when adversarial_loop reports that its evaluator did not accept the task.",
    ],
    parameters: createParameters(maxParallelLoops),

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
        projectTrusted: ctx.isProjectTrusted(),
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

export default function (pi: ExtensionAPI) {
  pi.registerFlag(MAX_PARALLEL_LOOPS_FLAG, {
    description: `Maximum number of concurrent adversarial loops (default: ${DEFAULT_MAX_PARALLEL_LOOPS})`,
    type: "string",
    default: String(DEFAULT_MAX_PARALLEL_LOOPS),
  });

  // Register the default immediately so the tool is available in startup flows
  // that inspect tools before a session starts. Re-register it after CLI flags
  // are resolved to apply a configured limit.
  registerTool(pi, DEFAULT_MAX_PARALLEL_LOOPS);
  pi.on("session_start", (_event, ctx) => {
    let maxParallelLoops = DEFAULT_MAX_PARALLEL_LOOPS;
    try {
      maxParallelLoops = parseMaxParallelLoops(
        pi.getFlag(MAX_PARALLEL_LOOPS_FLAG),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Ignoring invalid --${MAX_PARALLEL_LOOPS_FLAG}: ${message}; using ${DEFAULT_MAX_PARALLEL_LOOPS}`,
        "warning",
      );
    }
    registerTool(pi, maxParallelLoops);
  });
}
