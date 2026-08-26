import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_AGENT_BASE_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

export function addChildAgentBaseTools(activeTools: string[]) {
  return [...new Set([...activeTools, ...CHILD_AGENT_BASE_TOOLS])];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    pi.setActiveTools(addChildAgentBaseTools(pi.getActiveTools()));
  });
}
