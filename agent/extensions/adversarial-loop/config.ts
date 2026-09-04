export const DEFAULT_MAX_PARALLEL_LOOPS = 6;
export const MAX_PARALLEL_LOOPS_FLAG = "adversarial-loop-max-loops";
export const DEFAULT_GOAL_MAX_CONTINUATIONS = 25;
export const GOAL_MAX_CONTINUATIONS_FLAG =
  "adversarial-loop-goal-max-continuations";

function parsePositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new Error("must be a positive integer");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("must be a positive safe integer");
  }
  return parsed;
}

export function parseMaxParallelLoops(value: unknown): number {
  return parsePositiveInteger(value, DEFAULT_MAX_PARALLEL_LOOPS);
}

export function parseGoalMaxContinuations(value: unknown): number {
  return parsePositiveInteger(value, DEFAULT_GOAL_MAX_CONTINUATIONS);
}
