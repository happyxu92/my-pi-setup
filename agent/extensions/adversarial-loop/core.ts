import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

import {
  appendEvaluatorResult,
  appendGeneratorResult,
  createIterationArtifacts,
  createLoopArtifacts,
  writeTaskSpec,
} from "./artifacts.ts";
import { runChildAgent } from "./child-agent.ts";
import {
  buildEvaluatorOutputRetryPrompt,
  buildEvaluatorPrompt,
  DEFAULT_EVALUATOR_OUTPUT_RETRIES,
  parseEvaluatorOutput,
} from "./evaluator.ts";
import { buildGeneratorPrompt } from "./generator.ts";
import type {
  AdversarialLoopBatchDetails,
  AdversarialLoopDetails,
  AdversarialLoopRequest,
  Criterion,
  LoopRound,
  RunLoopOptions,
} from "./types.ts";
import { addUsage, emptyUsage, truncateUtf8 } from "./utils.ts";

export { parseEvaluatorOutput };
export type {
  AdversarialLoopBatchDetails,
  AdversarialLoopDetails,
  AdversarialLoopRequest,
  CheckStatus,
  Criterion,
  CriterionCheck,
  Evaluation,
  GeneratorResult,
  LoopRound,
  ThinkingLevel,
} from "./types.ts";

function copyDetails(details: AdversarialLoopDetails): AdversarialLoopDetails {
  return {
    ...details,
    criteria: details.criteria.map((criterion) => ({ ...criterion })),
    rounds: details.rounds.map((round) => ({
      ...round,
      evaluation: {
        ...round.evaluation,
        criteria: round.evaluation.criteria.map((criterion) => ({
          ...criterion,
        })),
        checks: round.evaluation.checks.map((check) => ({ ...check })),
        feedback: [...round.evaluation.feedback],
      },
      generator: round.generator ? { ...round.generator } : undefined,
    })),
  };
}

function copyBatchDetails(
  details: AdversarialLoopBatchDetails,
): AdversarialLoopBatchDetails {
  return {
    ...details,
    loops: details.loops.map(copyDetails),
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function runAdversarialLoop(options: RunLoopOptions) {
  options.signal?.throwIfAborted();
  const artifacts = await createLoopArtifacts(options.cwd, options.task);
  const usage = emptyUsage();
  const details: AdversarialLoopDetails = {
    status: "running",
    task: options.task,
    model: options.model,
    loopDirectory: artifacts.loopDirectory,
    maxIterations: options.maxIterations,
    criteria: [],
    rounds: [],
  };

  const update = (message: string) => {
    options.onUpdate?.({
      content: [{ type: "text", text: message }],
      details: copyDetails(details),
    });
  };

  update(`Loop archive: ${artifacts.loopDirectory}`);
  let criteria: Criterion[] | undefined;
  let previousGeneratorReport: string | undefined;

  for (let round = 1; round <= options.maxIterations + 1; round++) {
    const iterationArtifacts = await createIterationArtifacts(artifacts, round);
    const evaluationLabel = criteria
      ? `Evaluation ${round}: checking the frozen criteria`
      : "Evaluation 1: defining acceptance criteria and inspecting the workspace";
    update(evaluationLabel);

    let evaluation: ReturnType<typeof parseEvaluatorOutput>;
    try {
      const evaluator = await runChildAgent({
        role: "evaluator",
        cwd: options.cwd,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        projectTrusted: options.projectTrusted,
        prompt: buildEvaluatorPrompt(options.task, round, criteria, {
          taskSpecPath: artifacts.taskSpecPath,
          agentDirectory: iterationArtifacts.evaluatorDirectory,
        }),
        agentDirectory: iterationArtifacts.evaluatorDirectory,
        signal: options.signal,
        onActivity: (activity) => update(`Evaluation ${round}: ${activity}`),
        outputValidation: {
          maxRetries: DEFAULT_EVALUATOR_OUTPUT_RETRIES,
          validate: (output) => {
            parseEvaluatorOutput(output, criteria);
          },
          buildRetryPrompt: buildEvaluatorOutputRetryPrompt,
          onRetry: (retry, maxRetries) =>
            update(
              `Evaluation ${round}: invalid structured output; requesting correction ${retry}/${maxRetries}`,
            ),
        },
      });
      addUsage(usage, evaluator.usage);
      evaluation = parseEvaluatorOutput(evaluator.output, criteria);
      if (!criteria) {
        await writeTaskSpec(artifacts, options.task, evaluation.criteria);
      }
    } catch (error) {
      await appendEvaluatorResult(
        artifacts,
        round,
        iterationArtifacts.evaluatorDirectory,
        { error: getErrorMessage(error) },
      );
      throw error;
    }
    await appendEvaluatorResult(
      artifacts,
      round,
      iterationArtifacts.evaluatorDirectory,
      evaluation,
    );

    criteria ??= evaluation.criteria;
    details.criteria = criteria;
    const loopRound: LoopRound = { round, evaluation };
    details.rounds.push(loopRound);

    if (evaluation.completed) {
      details.status = "completed";
      update(`Accepted in evaluation ${round}: all criteria passed`);
      return {
        details: copyDetails(details),
        usage,
        latestGeneratorReport: previousGeneratorReport,
      };
    }

    if (round > options.maxIterations) break;

    update(
      `Generator ${round}/${options.maxIterations}: addressing ${evaluation.feedback.length} feedback item(s)`,
    );
    let generatorResult: NonNullable<LoopRound["generator"]>;
    try {
      const generator = await runChildAgent({
        role: "generator",
        cwd: options.cwd,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        projectTrusted: options.projectTrusted,
        prompt: buildGeneratorPrompt(options.task, criteria, evaluation, {
          taskSpecPath: artifacts.taskSpecPath,
          agentDirectory: iterationArtifacts.generatorDirectory,
        }),
        agentDirectory: iterationArtifacts.generatorDirectory,
        signal: options.signal,
        onActivity: (activity) =>
          update(`Generator ${round}/${options.maxIterations}: ${activity}`),
      });
      addUsage(usage, generator.usage);
      generatorResult = {
        report: generator.output,
        stopReason: generator.stopReason,
      };
    } catch (error) {
      await appendGeneratorResult(
        artifacts,
        round,
        iterationArtifacts.generatorDirectory,
        { error: getErrorMessage(error) },
      );
      throw error;
    }
    await appendGeneratorResult(
      artifacts,
      round,
      iterationArtifacts.generatorDirectory,
      generatorResult,
    );

    previousGeneratorReport = generatorResult.report;
    loopRound.generator = generatorResult;
    update(
      `Generator ${round}/${options.maxIterations}: finished; re-evaluating`,
    );
  }

  details.status = "exhausted";
  update(
    `Stopped at the ${options.maxIterations}-iteration safety limit without evaluator acceptance`,
  );
  return {
    details: copyDetails(details),
    usage,
    latestGeneratorReport: previousGeneratorReport,
  };
}

interface RunLoopBatchOptions extends Omit<
  RunLoopOptions,
  "task" | "maxIterations" | "onUpdate"
> {
  loops: AdversarialLoopRequest[];
  onUpdate?: AgentToolUpdateCallback<AdversarialLoopBatchDetails>;
  runLoop?: typeof runAdversarialLoop;
}

export async function runAdversarialLoopBatch(options: RunLoopBatchOptions) {
  options.signal?.throwIfAborted();
  if (options.loops.length === 0) {
    throw new Error("At least one adversarial loop is required");
  }

  const usage = emptyUsage();
  const details: AdversarialLoopBatchDetails = {
    status: "running",
    model: options.model,
    loops: options.loops.map((loop) => ({
      status: "running",
      task: loop.task,
      model: options.model,
      maxIterations: loop.maxIterations,
      criteria: [],
      rounds: [],
    })),
  };
  const batchAbortController = new AbortController();
  const abortFromParent = () =>
    batchAbortController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromParent, { once: true });

  let firstError: unknown;
  const runLoop = options.runLoop ?? runAdversarialLoop;
  const executions = options.loops.map(async (loop, index) => {
    try {
      const result = await runLoop({
        task: loop.task,
        cwd: options.cwd,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        projectTrusted: options.projectTrusted,
        maxIterations: loop.maxIterations,
        signal: batchAbortController.signal,
        onUpdate: (update) => {
          details.loops[index] = update.details;
          const message = update.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          options.onUpdate?.({
            content: [
              {
                type: "text",
                text: `[Loop ${index + 1}/${options.loops.length}] ${message}`,
              },
            ],
            details: copyBatchDetails(details),
          });
        },
      });
      details.loops[index] = result.details;
      return result;
    } catch (error) {
      if (!batchAbortController.signal.aborted) firstError = error;
      batchAbortController.abort(error);
      throw error;
    }
  });

  try {
    const settled = await Promise.allSettled(executions);
    options.signal?.throwIfAborted();

    const results = settled.map((result) => {
      if (result.status === "rejected") {
        throw firstError ?? result.reason;
      }
      return result.value;
    });
    for (const result of results) addUsage(usage, result.usage);

    details.status = details.loops.every((loop) => loop.status === "completed")
      ? "completed"
      : "exhausted";
    options.onUpdate?.({
      content: [
        {
          type: "text",
          text:
            details.status === "completed"
              ? `All ${details.loops.length} parallel loops were accepted`
              : `${details.loops.filter((loop) => loop.status === "completed").length}/${details.loops.length} parallel loops were accepted`,
        },
      ],
      details: copyBatchDetails(details),
    });

    return {
      details: copyBatchDetails(details),
      usage,
      latestGeneratorReports: results.map(
        (result) => result.latestGeneratorReport,
      ),
    };
  } finally {
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

export function formatLoopResult(
  details: AdversarialLoopDetails,
  latestGeneratorReport?: string,
  maxBytes = 48 * 1024,
) {
  const finalEvaluation = details.rounds.at(-1)?.evaluation;
  const generatorIterations = details.rounds.filter(
    (round) => round.generator,
  ).length;
  const heading =
    details.status === "completed"
      ? `Adversarial loop completed after ${generatorIterations} generator iteration(s).`
      : `Adversarial loop did not pass after the ${details.maxIterations}-iteration safety limit.`;
  const criteria = details.criteria
    .map((criterion) => `- ${criterion.id}: ${criterion.description}`)
    .join("\n");
  const checks =
    finalEvaluation?.checks
      .map(
        (check) =>
          `- ${check.criterionId} [${check.status}]: ${check.evidence}`,
      )
      .join("\n") ?? "- No final checks were returned.";
  const feedback =
    finalEvaluation && !finalEvaluation.completed
      ? `\n\nRemaining feedback:\n${finalEvaluation.feedback.map((item) => `- ${item}`).join("\n")}`
      : "";
  const report = latestGeneratorReport
    ? `\n\nLatest generator report:\n${latestGeneratorReport}`
    : "";

  const archive = details.loopDirectory
    ? `\n\nLoop archive: ${details.loopDirectory}`
    : "";

  return truncateUtf8(
    `${heading}${archive}\n\nAcceptance criteria:\n${criteria}\n\nFinal evaluation:\n${finalEvaluation?.summary ?? "No evaluation summary."}\n${checks}${feedback}${report}`,
    maxBytes,
  );
}

export function formatLoopBatchResult(
  details: AdversarialLoopBatchDetails,
  latestGeneratorReports: Array<string | undefined>,
) {
  const completed = details.loops.filter(
    (loop) => loop.status === "completed",
  ).length;
  const heading = `Parallel adversarial loops finished: ${completed}/${details.loops.length} accepted.`;
  const perLoopBytes = Math.floor((46 * 1024) / details.loops.length);
  const results = details.loops.map(
    (loop, index) =>
      `Loop ${index + 1}/${details.loops.length}\n${formatLoopResult(loop, latestGeneratorReports[index], perLoopBytes)}`,
  );

  return truncateUtf8(`${heading}\n\n${results.join("\n\n")}`, 48 * 1024);
}
