import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openai-codex") return;
    if (
      event.payload === null ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    ) {
      return;
    }

    // Codex exposes this as "fast", but the backend request tier is "priority".
    return {
      ...(event.payload as Record<string, unknown>),
      service_tier: "priority",
    };
  });
}
