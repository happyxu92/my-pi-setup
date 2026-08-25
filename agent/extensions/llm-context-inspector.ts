import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("system-prompt", {
    description: "View the current system prompt",
    handler: async (_args, ctx) => {
      const prompt = ctx.getSystemPrompt();
      ctx.ui.notify(
        `Current System Prompt (${prompt.length} chars)\n\n${prompt}`,
        "info",
      );
    },
  });

  pi.registerCommand("tools", {
    description: "View the active tool definitions",
    handler: async (_args, ctx) => {
      const activeToolNames = pi.getActiveTools();
      const allTools = pi.getAllTools();
      const tools = activeToolNames.flatMap((name) => {
        const tool = allTools.find((candidate) => candidate.name === name);
        if (!tool) return [];

        return [
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        ];
      });

      ctx.ui.notify(
        `Current Active Tools (${tools.length})\n\n${JSON.stringify(tools, null, 2)}`,
        "info",
      );
    },
  });
}
