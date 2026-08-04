import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Enables pi's built-in grep and find tools by default.
 * These tools are off by default; this extension adds them to the active tool set on session start.
 */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const additions = ["grep", "find"].filter((t) => !active.includes(t));
    if (additions.length > 0) {
      pi.setActiveTools([...active, ...additions]);
    }
  });
}
