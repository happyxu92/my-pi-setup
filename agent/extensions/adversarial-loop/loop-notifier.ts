import { randomUUID } from "node:crypto";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { formatLoopResult } from "./core.ts";
import { isActiveLoop, type LoopManager } from "./loop-manager.ts";
import type { BackgroundLoopRecord, LoopCapacity } from "./types.ts";
import { isRecord, truncateUtf8 } from "./utils.ts";

export const LOOP_COMPLETION_MESSAGE = "adversarial-loop-completion";
const MAX_RESULTS_PER_NOTIFICATION = 6;

export function formatCapacity(capacity: LoopCapacity) {
  return `Loop capacity: ${capacity.active}/${capacity.limit} active; ${capacity.available} available${capacity.auditing ? " (Goal audit)" : ""}.`;
}

export function summarizeLoop(record: BackgroundLoopRecord) {
  return {
    id: record.id,
    status: record.status,
    phase: record.phase,
    task: truncateUtf8(record.task, 512),
    model: record.model,
    loopDirectory: record.details?.loopDirectory,
    usage: record.usage,
    error: record.error,
  };
}

export function formatBackgroundResults(
  records: BackgroundLoopRecord[],
  capacity: LoopCapacity,
) {
  const perLoopBytes = Math.max(
    1024,
    Math.floor((40 * 1024) / Math.max(records.length, 1)),
  );
  return truncateUtf8(
    [
      formatCapacity(capacity),
      ...records.map((record) => {
        const heading = `Loop ${record.id}: ${record.status}`;
        const result =
          record.details &&
          (record.status === "completed" || record.status === "exhausted")
            ? formatLoopResult(
                record.details,
                record.latestGeneratorReport,
                perLoopBytes,
              )
            : `${record.phase}${record.error ? `\n${record.error}` : ""}${record.details?.loopDirectory ? `\nLoop archive: ${record.details.loopDirectory}` : ""}`;
        return `${heading}\n${result}`;
      }),
      "Use adversarial_loop_manage(action=result, ids=[...]) to reread results. Only completed loops passed independent acceptance.",
    ].join("\n\n"),
    48 * 1024,
  );
}

interface Notification {
  notificationId: string;
  loopIds: string[];
}

/** Owns wakeups, not execution. No timer or model request is used to poll jobs. */
export class LoopNotifier {
  private readonly manager: LoopManager;
  private readonly pi: Pick<ExtensionAPI, "sendMessage">;
  private readonly getContext: () => ExtensionContext | undefined;
  private readonly announcedStarts = new Set<string>();
  private readonly revoked = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Notification;
  private phase: "working" | "parking" | "waiting" = "working";
  private ending = false;
  private paused = false;
  private deliverySuspended = false;
  private disposed = false;

  constructor(
    manager: LoopManager,
    pi: Pick<ExtensionAPI, "sendMessage">,
    getContext: () => ExtensionContext | undefined,
  ) {
    this.manager = manager;
    this.pi = pi;
    this.getContext = getContext;
  }

  get waiting() {
    return this.phase !== "working";
  }

  get blocksAudit() {
    return (
      this.waiting ||
      this.paused ||
      this.deliverySuspended ||
      this.manager.capacity().active > 0 ||
      this.manager.pending().length > 0 ||
      !!this.inFlight
    );
  }

  announceStart(toolCallId: string) {
    this.announcedStarts.add(toolCallId);
    this.schedule();
  }

  schedule() {
    if (
      this.disposed ||
      this.paused ||
      this.deliverySuspended ||
      this.timer ||
      this.inFlight
    )
      return;
    if (
      !this.manager
        .pending()
        .some((record) => this.announcedStarts.has(record.toolCallId))
    )
      return;
    // Coalesce simultaneous completions without waiting for unrelated jobs.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 25);
  }

  private flush() {
    const ctx = this.getContext();
    if (
      !ctx ||
      ctx.signal?.aborted ||
      this.disposed ||
      this.paused ||
      this.deliverySuspended ||
      this.inFlight ||
      this.ending ||
      this.phase === "parking"
    )
      return;
    const records = this.manager
      .pending()
      .filter((record) => this.announcedStarts.has(record.toolCallId))
      .slice(0, MAX_RESULTS_PER_NOTIFICATION);
    if (!records.length) return;
    const notification = {
      notificationId: randomUUID(),
      loopIds: records.map((record) => record.id),
    };
    this.inFlight = notification;
    this.phase = "working";
    try {
      this.pi.sendMessage(
        {
          customType: LOOP_COMPLETION_MESSAGE,
          content: `Background loop results are ready. Process these results and continue independent work, start additional loops within capacity, or call adversarial_loop_wait alone when there is nothing else to do.\n\n${formatBackgroundResults(records, this.manager.capacity())}`,
          display: true,
          details: notification,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } catch (error) {
      this.inFlight = undefined;
      // No retry timer: a user action or the next lifecycle boundary can retry.
      ctx.ui.notify(
        `Loop notification failed; results remain available: ${String(error)}`,
        "warning",
      );
    }
  }

  wait() {
    const records = this.manager
      .pending()
      .slice(0, MAX_RESULTS_PER_NOTIFICATION);
    if (records.length) {
      this.consume(records.map((record) => record.id));
      return { waiting: false, records, reason: "results_ready" as const };
    }
    if (!this.manager.records().some(isActiveLoop)) {
      return {
        waiting: false,
        records: [],
        reason: "no_active_loops" as const,
      };
    }
    if (this.getContext()?.hasPendingMessages()) {
      return {
        waiting: false,
        records: [],
        reason: "pending_messages" as const,
      };
    }
    // There is deliberately no await between inspecting the inbox and parking.
    this.phase = "parking";
    this.paused = false;
    return {
      waiting: true,
      records: [],
      reason: "waiting_for_results" as const,
    };
  }

  consume(ids: string[]) {
    this.revokeFlight();
    this.manager.acknowledge(ids);
    this.phase = "working";
    this.schedule();
  }

  cancelNotification() {
    this.revokeFlight();
    this.schedule();
  }

  private revokeFlight() {
    if (this.inFlight) this.revoked.add(this.inFlight.notificationId);
    this.inFlight = undefined;
  }

  /** Called before each actual LLM request; queued is not the same as consumed. */
  context(messages: ContextEvent["messages"]) {
    this.phase = "working";
    this.ending = false;
    const seen = new Set<string>();
    const filtered = messages.filter((message) => {
      if (
        !isRecord(message) ||
        message.role !== "custom" ||
        message.customType !== LOOP_COMPLETION_MESSAGE ||
        !isRecord(message.details)
      )
        return true;
      const { notificationId, loopIds } = message.details;
      if (typeof notificationId !== "string" || !Array.isArray(loopIds))
        return true;
      if (this.revoked.has(notificationId) || seen.has(notificationId))
        return false;
      seen.add(notificationId);
      this.manager.acknowledge(
        loopIds.filter((id): id is string => typeof id === "string"),
      );
      if (this.inFlight?.notificationId === notificationId)
        this.inFlight = undefined;
      return true;
    });
    this.schedule();
    return filtered;
  }

  suspendDelivery() {
    this.deliverySuspended = true;
  }

  resumeDelivery() {
    this.deliverySuspended = false;
    this.schedule();
  }

  agentEnd() {
    this.ending = true;
  }

  settled(failed: boolean) {
    this.ending = false;
    this.deliverySuspended = false;
    if (failed) {
      this.stop();
      return;
    }
    if (this.phase === "parking") this.phase = "waiting";
    // sendMessage is fire-and-forget. An unconsumed message may have been lost
    // to an abort/queue clear. Revoke its ID before resubmitting at idle.
    this.revokeFlight();
    this.schedule();
  }

  userInput() {
    this.paused = false;
    this.phase = "working";
    this.schedule();
  }

  stop() {
    this.paused = true;
    this.phase = "working";
    this.revokeFlight();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose() {
    this.stop();
    this.disposed = true;
  }
}
