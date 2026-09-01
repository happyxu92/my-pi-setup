export const DEFAULT_MAX_PARALLEL_LOOPS = 6;
export const MAX_PARALLEL_LOOPS_FLAG = "adversarial-loop-max-loops";

export function parseMaxParallelLoops(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_PARALLEL_LOOPS;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new Error("must be a positive integer");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("must be a positive safe integer");
  }
  return parsed;
}
