import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRetryableFailure, WAKE_TYPE } from "./policy.ts";

export default function manualRetry(pi: ExtensionAPI) {
  let retryRequested = false;

  // display:false only hides rendering. Filter every wake record, including ones
  // restored from disk, before Pi converts custom messages into user messages.
  pi.on("context", (event) => ({
    messages: event.messages.filter(
      (message) =>
        !(message.role === "custom" && message.customType === WAKE_TYPE),
    ),
  }));

  // agent_end is too early: Pi may still be automatically retrying.
  pi.on("agent_settled", () => {
    retryRequested = false;
  });
  pi.on("session_start", () => {
    retryRequested = false;
  });
  pi.on("session_tree", () => {
    retryRequested = false;
  });
  pi.on("session_shutdown", () => {
    retryRequested = false;
  });

  pi.registerCommand("retry-last", {
    description:
      "Retry the last rate-limit/quota or service-unavailable failure without a new user message",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /retry-last (no arguments)", "warning");
        return;
      }
      if (retryRequested || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Pi is still running or has queued messages. Wait until it has fully stopped.",
          "warning",
        );
        return;
      }
      const failure = findRetryableFailure(ctx.sessionManager.getBranch());
      if (!failure) {
        ctx.ui.notify(
          "The current branch does not end with a rate-limit, quota, or service-unavailable failure.",
          "warning",
        );
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("Select a model before retrying.", "warning");
        return;
      }

      // No await between validation and dispatch: prevent concurrent commands
      // from queuing a second wake before the session marks itself busy.
      retryRequested = true;
      try {
        pi.sendMessage(
          {
            customType: WAKE_TYPE,
            content: "",
            display: false,
            details: { failedEntryId: failure.id },
          },
          { triggerTurn: true },
        );
      } catch (error) {
        retryRequested = false;
        throw error;
      }
    },
  });
}
