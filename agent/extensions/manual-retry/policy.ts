import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const WAKE_TYPE = "my-pi-setup/manual-retry-wake";

// Match provider limit errors, not arbitrary messages containing "limit".
const LIMIT_ERROR =
  /\b429\b|rate[\s_-]?limit|too many requests|insufficient[_\s-]quota|quota.{0,40}(?:exceed|exhaust)|(?:exceed|exhaust).{0,40}quota|usage[_\s-]?limit|(?:out of|exceeded).{0,10}budget|credit balance.{0,20}(?:low|exhaust)|resource[_\s-]?exhausted/i;
const SERVICE_UNAVAILABLE_ERROR =
  /\b503\b|\bservice[\s_-]+(?:temporarily[\s_-]+)?unavailable\b/i;
const CONTEXT_ERROR =
  /context[_\s-]?(?:length|window)|maximum context|prompt.{0,20}too long|too many tokens/i;

export function findRetryableFailure(entries: readonly SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "system") continue;
      if (message.role === "custom" && message.customType === WAKE_TYPE)
        continue;
      if (
        message.role === "assistant" &&
        message.stopReason === "error" &&
        (LIMIT_ERROR.test(message.errorMessage ?? "") ||
          SERVICE_UNAVAILABLE_ERROR.test(message.errorMessage ?? "")) &&
        !CONTEXT_ERROR.test(message.errorMessage ?? "")
      ) {
        return entry;
      }
      // Never look past new input, tool results, aborts, or successful replies.
      return undefined;
    }
    if (entry.type === "custom_message") {
      if (entry.customType === WAKE_TYPE) continue;
      return undefined;
    }
    // These entries replace/add conversation context, unlike labels and settings.
    if (entry.type === "compaction" || entry.type === "branch_summary")
      return undefined;
  }
  return undefined;
}
