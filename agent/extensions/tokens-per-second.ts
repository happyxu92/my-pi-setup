import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { performance } from "node:perf_hooks";

const STATUS_KEY = "tokens-per-second";

function formatRate(tokensPerSecond: number): string {
  return tokensPerSecond < 100
    ? tokensPerSecond.toFixed(1)
    : Math.round(tokensPerSecond).toString();
}

export default function (pi: ExtensionAPI) {
  let streamStartedAt: number | undefined;

  pi.on("session_start", (_event, ctx) => {
    streamStartedAt = undefined;
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "— tok/s"));
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;

    streamStartedAt = performance.now();
    // Keep showing the most recently completed request while this one streams.
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const startedAt = streamStartedAt;
    streamStartedAt = undefined;

    if (startedAt === undefined || event.message.usage.output <= 0) {
      return;
    }

    // Use provider-reported output tokens over the full response stream. This
    // includes reasoning tokens when the provider counts them as output.
    const elapsedSeconds = Math.max(
      (performance.now() - startedAt) / 1000,
      0.001,
    );
    const tokensPerSecond = event.message.usage.output / elapsedSeconds;
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg("dim", `${formatRate(tokensPerSecond)} tok/s`),
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    streamStartedAt = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
