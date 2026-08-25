import type { Usage } from "@earendil-works/pi-ai";

const MAX_FIELD_BYTES = 2 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function addUsage(total: Usage, addition: Usage) {
  total.input += addition.input;
  total.output += addition.output;
  total.cacheRead += addition.cacheRead;
  total.cacheWrite += addition.cacheWrite;
  total.totalTokens += addition.totalTokens;
  total.cost.input += addition.cost.input;
  total.cost.output += addition.cost.output;
  total.cost.cacheRead += addition.cost.cacheRead;
  total.cost.cacheWrite += addition.cost.cacheWrite;
  total.cost.total += addition.cost.total;

  if (addition.cacheWrite1h !== undefined) {
    total.cacheWrite1h = (total.cacheWrite1h ?? 0) + addition.cacheWrite1h;
  }
  if (addition.reasoning !== undefined) {
    total.reasoning = (total.reasoning ?? 0) + addition.reasoning;
  }
}

export function truncateUtf8(text: string, maxBytes: number) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return `${text.slice(0, low)}\n[truncated]`;
}

export function cleanString(value: unknown, maxBytes = MAX_FIELD_BYTES) {
  if (typeof value !== "string") return "";
  return truncateUtf8(value.trim(), maxBytes);
}
