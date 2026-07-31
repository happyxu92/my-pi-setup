import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("system-prompt", {
    description: "View the current system prompt",
    handler: async (_args, ctx) => {
      const prompt = ctx.getSystemPrompt();

      await ctx.ui.editor(
        `Current System Prompt (${prompt.length} chars)`,
        prompt,
      );
    },
  });
}
