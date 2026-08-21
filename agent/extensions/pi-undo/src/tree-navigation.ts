import { SessionState, type SessionEntrySource } from "./session-state.ts";

interface TreeSessionSource {
  getEntries(): readonly unknown[];
  getSessionFile(): string | undefined;
}

interface TreeNavigationEvent {
  readonly newLeafId: string | null;
  readonly summaryEntry?: { readonly parentId: string | null };
}

/** Converts Pi's physical tree leaves to pi-undo logical leaves. */
export function normalizeTreeNavigationEvent(
  source: TreeSessionSource,
  event: TreeNavigationEvent,
) {
  const navigationTarget = event.summaryEntry?.parentId ?? event.newLeafId;
  return {
    newLeafId: logicalLeafAt(source, event.newLeafId),
    navigationTargetLeafId: logicalLeafAt(source, navigationTarget),
  };
}

function logicalLeafAt(source: TreeSessionSource, leafId: string | null) {
  const sessionSource: SessionEntrySource = {
    getEntries: () => source.getEntries(),
    getLeafId: () => leafId,
    getSessionFile: () => source.getSessionFile(),
  };
  return new SessionState(sessionSource).getLogicalLeafId();
}
