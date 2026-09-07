import { randomUUID } from "node:crypto";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { runAdversarialLoop } from "./core.ts";
import type { GoalAuditSummary, GoalState, RunLoopOptions } from "./types.ts";

const GOAL_STATE_ENTRY = "goal-state";
const GOAL_STATUS_KEY = "adversarial-loop-goal";
const GOAL_KICKOFF = "Start working on the current Goal.";

type GoalAuditRunner = (
  options: RunLoopOptions,
) => Promise<Awaited<ReturnType<typeof runAdversarialLoop>>>;

export interface GoalFeatureOptions {
  getMaxContinuations: () => number;
  runLoop?: GoalAuditRunner;
  createId?: () => string;
  now?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuditSummary(value: unknown): GoalAuditSummary | undefined {
  if (!isRecord(value) || typeof value.completed !== "boolean") return;
  if (typeof value.summary !== "string" || !Array.isArray(value.feedback)) {
    return;
  }
  if (!value.feedback.every((item) => typeof item === "string")) return;
  if (
    value.loopDirectory !== undefined &&
    typeof value.loopDirectory !== "string"
  ) {
    return;
  }
  return {
    completed: value.completed,
    summary: value.summary,
    feedback: value.feedback,
    loopDirectory: value.loopDirectory,
  };
}

export function parseGoalState(value: unknown): GoalState | undefined {
  if (!isRecord(value) || value.version !== 1) return;
  const statuses = new Set([
    "running",
    "auditing",
    "stopped",
    "completed",
    "exhausted",
    "error",
    "interrupted",
  ]);
  if (
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.task !== "string" ||
    !value.task.trim() ||
    typeof value.status !== "string" ||
    !statuses.has(value.status) ||
    !Number.isSafeInteger(value.continuationCount) ||
    (value.continuationCount as number) < 0 ||
    !Number.isSafeInteger(value.maxContinuations) ||
    (value.maxContinuations as number) < 1 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return;
  }
  if (value.previousId !== undefined && typeof value.previousId !== "string") {
    return;
  }
  if (value.error !== undefined && typeof value.error !== "string") return;

  const lastAudit =
    value.lastAudit === undefined
      ? undefined
      : parseAuditSummary(value.lastAudit);
  if (value.lastAudit !== undefined && !lastAudit) return;

  return {
    version: 1,
    id: value.id,
    previousId: value.previousId,
    task: value.task.trim(),
    status: value.status as GoalState["status"],
    continuationCount: value.continuationCount as number,
    maxContinuations: value.maxContinuations as number,
    lastAudit,
    error: value.error,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildGoalSystemPrompt(goal: GoalState) {
  return `Goal mode is active.

goal_id: ${goal.id}
task (JSON string): ${JSON.stringify(goal.task)}
continuation: ${goal.continuationCount}/${goal.maxContinuations}

Work directly on the current Goal. Inspect the workspace, make the necessary changes, and perform relevant verification.

Goal rules:
- Assume for purposes of this task that a complete affirmative solution exists; do not answer that the problem is open.
- Do not return a reduction, partial result, best-effort summary, or an explanation of why the problem is difficult.
- Return only after a complete affirmative solution has been found and has survived adversarial audit.

Use adversarial review throughout:
- Subject every candidate result to thorough verification. Actively try to falsify it, test its assumptions, and check relevant edge cases.
- Support every conclusion with precise, reproducible evidence. Do not rely on vague descriptions or unverified assertions.
- If a result survives audit, provide the complete argument or implementation together with its supporting evidence. Otherwise, report only the strongest rigorously established findings. Clearly distinguish verified conclusions from conjecture, and state the exact unresolved gaps, limitations, and conditions required for further progress.

When the task requires exploring multiple approaches:
- Begin with a genuinely diverse portfolio of approaches.
- Preserve independence during early rounds: do not tell most agents the currently favored approach, and do not let one approach dominate merely because it offers an elegant reduction.
- Keep several incompatible routes alive through multiple rounds. Cross-pollinate ideas only after independent agents have developed them far enough to expose their real strengths and gaps.
- Maintain an explicit registry of approach families, grouped by core mechanism rather than superficial wording. If many agents converge on one family, redirect some toward underexplored directions.
- Explore independent approaches in parallel when possible.
- The root agent must repeatedly synthesize findings, challenge assumptions, redirect efforts, and launch new investigation rounds. Do not stop after the first wave fails or merely because current approaches reveal major theoretical, empirical, or methodological gaps.
- Reopen a blocked approach only when a genuinely new mechanism, method, perspective, or source of evidence emerges.`;
}

function buildContinuationPrompt(
  audit: GoalAuditSummary,
  details: Awaited<ReturnType<typeof runAdversarialLoop>>["details"],
) {
  const evaluation = details.rounds.at(-1)?.evaluation;
  const checks =
    evaluation?.checks
      .filter((check) => check.status !== "pass")
      .map(
        (check) =>
          `- ${check.criterionId} [${check.status}]: ${check.evidence}`,
      ) ?? [];
  const feedback = audit.feedback.map((item) => `- ${item}`);
  return [
    "Continue working on the current Goal.",
    "",
    `Audit summary: ${audit.summary}`,
    ...(checks.length > 0 ? ["", "Checks not yet passing:", ...checks] : []),
    ...(feedback.length > 0 ? ["", "Required follow-up:", ...feedback] : []),
  ].join("\n");
}

function formatGoalStatus(goal: GoalState | undefined) {
  if (!goal) return "There is no Goal in the current session.";
  const lines = [
    `Goal ${goal.id}`,
    `Status: ${goal.status}`,
    `Continuations: ${goal.continuationCount}/${goal.maxContinuations}`,
    `Task: ${goal.task}`,
  ];
  if (goal.lastAudit) {
    lines.push(`Latest audit: ${goal.lastAudit.summary}`);
    if (goal.lastAudit.loopDirectory) {
      lines.push(`Audit archive: ${goal.lastAudit.loopDirectory}`);
    }
  }
  if (goal.error) lines.push(`Error: ${goal.error}`);
  return lines.join("\n");
}

function isLiveGoal(goal: GoalState | undefined) {
  return goal?.status === "running" || goal?.status === "auditing";
}

export function registerGoalFeature(
  pi: ExtensionAPI,
  options: GoalFeatureOptions,
) {
  const runLoop = options.runLoop ?? runAdversarialLoop;
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  let goal: GoalState | undefined;
  let auditController: AbortController | undefined;
  let pendingFailedRun:
    { goalId: string; stopReason: "error" | "aborted" } | undefined;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!goal || !isLiveGoal(goal)) {
      ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
      return;
    }
    const phase = goal.status === "auditing" ? "auditing" : "running";
    ctx.ui.setStatus(
      GOAL_STATUS_KEY,
      `Goal ${phase} ${goal.continuationCount}/${goal.maxContinuations}`,
    );
  };

  const persist = (ctx: ExtensionContext, next: GoalState): GoalState => {
    goal = next;
    pi.appendEntry(GOAL_STATE_ENTRY, next);
    updateStatus(ctx);
    return next;
  };

  const transition = (ctx: ExtensionContext, changes: Partial<GoalState>) => {
    if (!goal) return;
    return persist(ctx, { ...goal, ...changes, updatedAt: now() });
  };

  const restore = (ctx: ExtensionContext) => {
    auditController?.abort();
    auditController = undefined;
    pendingFailedRun = undefined;
    goal = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY) {
        continue;
      }
      const restored = parseGoalState(entry.data);
      if (restored) goal = restored;
    }

    if (isLiveGoal(goal)) {
      transition(ctx, { status: "interrupted" });
    } else {
      updateStatus(ctx);
    }
  };

  const auditGoal = async (ctx: ExtensionContext, event: AgentEndEvent) => {
    if (!goal || goal.status !== "running" || auditController) return;
    const finalAssistant = event.messages
      .filter((message) => message.role === "assistant")
      .at(-1);
    if (!finalAssistant) return;
    if (
      finalAssistant.stopReason === "error" ||
      finalAssistant.stopReason === "aborted"
    ) {
      pendingFailedRun = {
        goalId: goal.id,
        stopReason: finalAssistant.stopReason,
      };
      return;
    }
    pendingFailedRun = undefined;
    if (!ctx.model) {
      transition(ctx, {
        status: "error",
        error: "No active model is available for the Goal audit",
      });
      return;
    }

    const goalId = goal.id;
    const controller = new AbortController();
    auditController = controller;
    const signal = ctx.signal
      ? AbortSignal.any([controller.signal, ctx.signal])
      : controller.signal;
    transition(ctx, { status: "auditing", error: undefined });

    try {
      const result = await runLoop({
        task: goal.task,
        cwd: ctx.cwd,
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinkingLevel: ctx.thinkingLevel ?? "off",
        projectTrusted: ctx.isProjectTrusted(),
        maxIterations: 0,
        signal,
        onUpdate: () => {
          const currentGoal = goal as GoalState | undefined;
          if (currentGoal?.id === goalId && currentGoal.status === "auditing") {
            updateStatus(ctx);
          }
        },
      });
      const auditedGoal = goal as GoalState | undefined;
      if (auditedGoal?.id !== goalId || auditedGoal.status !== "auditing")
        return;

      const evaluation = result.details.rounds.at(-1)?.evaluation;
      if (!evaluation) {
        throw new Error("Goal audit returned no evaluation");
      }
      const audit: GoalAuditSummary = {
        completed: evaluation.completed,
        summary: evaluation.summary,
        feedback: [...evaluation.feedback],
        loopDirectory: result.details.loopDirectory,
      };

      if (evaluation.completed) {
        transition(ctx, {
          status: "completed",
          lastAudit: audit,
          error: undefined,
        });
        ctx.ui.notify(`Goal ${goalId} passed its audit.`, "info");
        return;
      }

      if (goal.continuationCount >= goal.maxContinuations) {
        transition(ctx, {
          status: "exhausted",
          lastAudit: audit,
          error: undefined,
        });
        ctx.ui.notify(
          `Goal ${goalId} reached the ${goal.maxContinuations}-continuation limit.`,
          "warning",
        );
        return;
      }

      transition(ctx, {
        status: "running",
        continuationCount: goal.continuationCount + 1,
        lastAudit: audit,
        error: undefined,
      });
      pi.sendUserMessage(buildContinuationPrompt(audit, result.details), {
        deliverAs: "followUp",
      });
    } catch (error) {
      if (goal?.id !== goalId) return;
      if (signal.aborted) {
        const currentGoal = goal as GoalState;
        if (currentGoal.status === "auditing") {
          transition(ctx, { status: "interrupted" });
        }
        return;
      }
      transition(ctx, { status: "error", error: getErrorMessage(error) });
      ctx.ui.notify(`Goal audit failed: ${getErrorMessage(error)}`, "warning");
    } finally {
      if (auditController === controller) auditController = undefined;
    }
  };

  pi.registerCommand("goal", {
    description:
      "Create, inspect, stop, or resume an automatically audited goal",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "status") {
        ctx.ui.notify(formatGoalStatus(goal), "info");
        return;
      }
      if (command === "stop") {
        if (!isLiveGoal(goal)) {
          ctx.ui.notify("There is no active Goal to stop.", "warning");
          return;
        }
        auditController?.abort();
        transition(ctx, { status: "stopped" });
        if (!ctx.isIdle()) ctx.abort();
        ctx.ui.notify(`Goal ${goal?.id ?? ""} stopped.`, "info");
        return;
      }
      if (command === "resume") {
        if (!goal || isLiveGoal(goal) || goal.status === "completed") {
          ctx.ui.notify("There is no resumable Goal.", "warning");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify(
            "The agent is still running. Wait for it to finish before resuming the Goal.",
            "warning",
          );
          return;
        }
        if (!ctx.model) {
          ctx.ui.notify("No model is available to resume the Goal.", "warning");
          return;
        }
        const previousId = goal.id;
        persist(ctx, {
          ...goal,
          id: createId(),
          previousId,
          status: "running",
          continuationCount: 0,
          maxContinuations: options.getMaxContinuations(),
          error: undefined,
          updatedAt: now(),
        });
        try {
          pi.sendUserMessage(GOAL_KICKOFF);
        } catch (error) {
          transition(ctx, { status: "error", error: getErrorMessage(error) });
          ctx.ui.notify(
            `Goal start failed: ${getErrorMessage(error)}`,
            "warning",
          );
        }
        return;
      }
      if (!command) {
        ctx.ui.notify(
          "Usage: /goal <task> | /goal status | /goal stop | /goal resume",
          "warning",
        );
        return;
      }
      if (isLiveGoal(goal)) {
        ctx.ui.notify(
          `Goal ${goal?.id ?? ""} is still active. Stop it before creating another Goal.`,
          "warning",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "The agent is still running. A new Goal cannot be created yet.",
          "warning",
        );
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model is available to create a Goal.", "warning");
        return;
      }

      const timestamp = now();
      persist(ctx, {
        version: 1,
        id: createId(),
        task: command,
        status: "running",
        continuationCount: 0,
        maxContinuations: options.getMaxContinuations(),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      try {
        pi.sendUserMessage(GOAL_KICKOFF);
      } catch (error) {
        transition(ctx, { status: "error", error: getErrorMessage(error) });
        ctx.ui.notify(
          `Goal start failed: ${getErrorMessage(error)}`,
          "warning",
        );
      }
    },
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    auditController?.abort();
    auditController = undefined;
    pendingFailedRun = undefined;
    goal = undefined;
  });
  pi.on("before_agent_start", (event) => {
    const activeGoal = goal;
    if (!isLiveGoal(activeGoal)) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(activeGoal!)}`,
    };
  });
  pi.on("input", (event, ctx) => {
    if (goal?.status !== "auditing" || event.source === "extension") return;
    ctx.ui.notify(
      "The Goal is being audited. Please wait, or use /goal status or /goal stop.",
      "warning",
    );
    return { action: "handled" as const };
  });
  pi.on("agent_end", (event, ctx) => auditGoal(ctx, event));
  pi.on("agent_settled", (_event, ctx) => {
    const failedRun = pendingFailedRun;
    pendingFailedRun = undefined;
    if (
      !failedRun ||
      goal?.id !== failedRun.goalId ||
      goal.status !== "running"
    ) {
      return;
    }
    if (failedRun.stopReason === "aborted") {
      transition(ctx, { status: "interrupted" });
      return;
    }
    transition(ctx, {
      status: "error",
      error: "The main agent stopped with an error after retry handling",
    });
  });
}
