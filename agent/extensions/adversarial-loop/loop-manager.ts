import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runAdversarialLoop } from "./core.ts";
import type {
  AdversarialLoopRequest,
  BackgroundLoopRecord,
  BackgroundLoopStatus,
  LoopCapacity,
  RunLoopOptions,
} from "./types.ts";
import { emptyUsage, isRecord, truncateUtf8 } from "./utils.ts";

export const LOOP_STATE_ENTRY = "adversarial-loop-state";
const ACTIVE_STATUSES = new Set<BackgroundLoopStatus>([
  "starting",
  "running",
  "cancelling",
]);
const TERMINAL_STATUSES = new Set<BackgroundLoopStatus>([
  "completed",
  "exhausted",
  "error",
  "cancelled",
  "interrupted",
]);

type LoopRunner = typeof runAdversarialLoop;
type StartContext = Pick<
  RunLoopOptions,
  "cwd" | "model" | "thinkingLevel" | "projectTrusted"
>;

interface ManagedLoop {
  record: BackgroundLoopRecord;
  controller: AbortController;
  execution?: Promise<void>;
}

export interface LoopManagerOptions {
  limit: number;
  persist: (record: BackgroundLoopRecord) => void;
  changed?: () => void;
  onError?: (error: unknown) => void;
  runLoop?: LoopRunner;
  saveResult?: (record: BackgroundLoopRecord) => Promise<void>;
}

export function isActiveLoop(record: BackgroundLoopRecord) {
  return ACTIVE_STATUSES.has(record.status);
}

export function parseLoopRecord(
  value: unknown,
): BackgroundLoopRecord | undefined {
  if (!isRecord(value) || value.version !== 1) return;
  if (
    ![
      "id",
      "toolCallId",
      "task",
      "cwd",
      "model",
      "thinkingLevel",
      "phase",
      "createdAt",
      "updatedAt",
    ].every((key) => typeof value[key] === "string")
  )
    return;
  if (
    typeof value.status !== "string" ||
    ![...ACTIVE_STATUSES, ...TERMINAL_STATUSES].includes(
      value.status as BackgroundLoopStatus,
    )
  )
    return;
  if (!["pending", "delivered", "suppressed"].includes(String(value.delivery)))
    return;
  if (
    !Number.isSafeInteger(value.maxIterations) ||
    !isRecord(value.usage) ||
    typeof value.usage.totalTokens !== "number" ||
    !isRecord(value.usage.cost)
  )
    return;
  // These are extension-owned, versioned session records, not tool arguments.
  return structuredClone(value) as unknown as BackgroundLoopRecord;
}

export class LoopManager {
  private readonly options: LoopManagerOptions;
  private readonly jobs = new Map<string, ManagedLoop>();
  private closed = false;
  private audit?: {
    controller: AbortController;
    execution: Promise<Awaited<ReturnType<LoopRunner>>>;
  };

  constructor(options: LoopManagerOptions) {
    this.options = options;
  }

  capacity(): LoopCapacity {
    const active =
      [...this.jobs.values()].filter((job) => isActiveLoop(job.record)).length +
      (this.audit ? 1 : 0);
    return {
      active,
      limit: this.options.limit,
      available: this.options.limit - active,
      auditing: !!this.audit,
    };
  }

  records() {
    return [...this.jobs.values()].map((job) => structuredClone(job.record));
  }

  get(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown loop ID: ${id}`);
    return structuredClone(job.record);
  }

  pending() {
    return [...this.jobs.values()]
      .filter(
        ({ record }) => !isActiveLoop(record) && record.delivery === "pending",
      )
      .map(({ record }) => structuredClone(record));
  }

  restore(records: BackgroundLoopRecord[]) {
    if (this.jobs.size)
      throw new Error("Restore requires a fresh loop manager");
    for (const record of records) {
      this.jobs.set(record.id, {
        record: structuredClone(record),
        controller: new AbortController(),
      });
    }
    for (const job of this.jobs.values()) {
      const changed =
        isActiveLoop(job.record) || job.record.delivery === "pending";
      if (isActiveLoop(job.record)) {
        job.record.status = "interrupted";
        job.record.phase = "Session runtime ended; not automatically restarted";
      }
      // Restoring a branch must never unexpectedly start the main agent.
      if (job.record.delivery === "pending") job.record.delivery = "suppressed";
      if (changed) this.persist(job);
    }
    this.changed();
  }

  start(
    requests: AdversarialLoopRequest[],
    context: StartContext,
    toolCallId: string,
  ) {
    if (this.closed) throw new Error("The loop manager is shutting down");
    if (this.audit)
      throw new Error(
        "Cannot start loops while the Goal audit is inspecting the workspace",
      );
    if (!requests.length) throw new Error("At least one loop is required");
    for (const request of requests) {
      if (!request.task.trim()) throw new Error("Loop task must not be empty");
      if (
        !Number.isInteger(request.maxIterations) ||
        request.maxIterations < 1 ||
        request.maxIterations > 20
      ) {
        throw new Error("maxIterations must be an integer between 1 and 20");
      }
    }
    const capacity = this.capacity();
    if (requests.length > capacity.available) {
      throw new Error(
        `Loop capacity exceeded: requested ${requests.length}, available ${capacity.available}/${capacity.limit}. No loops were started. Wait for a result or submit fewer loops.`,
      );
    }

    // Reserve the entire batch synchronously, before any I/O or child startup.
    const jobs = requests.map((request): ManagedLoop => {
      const timestamp = new Date().toISOString();
      return {
        controller: new AbortController(),
        record: {
          version: 1,
          id: randomUUID(),
          toolCallId,
          task: request.task.trim(),
          cwd: context.cwd,
          model: context.model,
          thinkingLevel: context.thinkingLevel,
          maxIterations: request.maxIterations,
          status: "starting",
          phase: "Starting",
          createdAt: timestamp,
          updatedAt: timestamp,
          delivery: "pending",
          usage: emptyUsage(),
        },
      };
    });
    for (const job of jobs) this.jobs.set(job.record.id, job);
    for (const job of jobs) this.persist(job);
    for (const job of jobs) {
      job.execution = Promise.resolve().then(() => this.execute(job, context));
    }
    this.changed();
    return jobs.map((job) => structuredClone(job.record));
  }

  acknowledge(ids: string[]) {
    let changed = false;
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (!job || isActiveLoop(job.record) || job.record.delivery !== "pending")
        continue;
      job.record.delivery = "delivered";
      this.persist(job);
      changed = true;
    }
    if (changed) this.changed();
  }

  cancel(ids?: string[]) {
    // Validate the whole selection before applying any cancellation.
    const jobs = ids
      ? ids.map((id) => {
          const job = this.jobs.get(id);
          if (!job) throw new Error(`Unknown loop ID: ${id}`);
          return job;
        })
      : [...this.jobs.values()];
    for (const job of jobs) {
      if (!isActiveLoop(job.record) && job.record.delivery !== "pending")
        continue;
      job.record.delivery = "suppressed";
      if (isActiveLoop(job.record)) {
        job.record.status = "cancelling";
        job.record.phase =
          "Cancelling; capacity remains reserved until the child exits";
        job.controller.abort();
      }
      this.persist(job);
    }
    this.changed();
    return jobs.map((job) => structuredClone(job.record));
  }

  async runAudit(options: RunLoopOptions) {
    if (this.closed || this.capacity().active || this.pending().length) {
      throw new Error(
        "Goal audit requires an idle loop pool with no pending results",
      );
    }
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const execution = Promise.resolve().then(() =>
      (this.options.runLoop ?? runAdversarialLoop)({ ...options, signal }),
    );
    const audit = { controller, execution };
    this.audit = audit;
    this.changed();
    try {
      return await execution;
    } finally {
      if (this.audit === audit) this.audit = undefined;
      this.changed();
    }
  }

  async shutdown() {
    this.closed = true;
    this.audit?.controller.abort();
    this.cancel();
    await Promise.allSettled([
      ...[...this.jobs.values()].map((job) => job.execution),
      this.audit?.execution,
    ]);
  }

  private persist(job: ManagedLoop) {
    job.record.updatedAt = new Date().toISOString();
    try {
      this.options.persist(structuredClone(job.record));
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private changed() {
    this.options.changed?.();
  }

  private async execute(job: ManagedLoop, context: StartContext) {
    const record = job.record;
    let status: BackgroundLoopStatus;
    try {
      job.controller.signal.throwIfAborted();
      record.status = "running";
      const result = await (this.options.runLoop ?? runAdversarialLoop)({
        ...context,
        task: record.task,
        maxIterations: record.maxIterations,
        signal: job.controller.signal,
        onUpdate: (update) => {
          const previousDirectory = record.details?.loopDirectory;
          record.details = structuredClone(update.details);
          if (record.details?.loopDirectory !== previousDirectory)
            this.persist(job);
          if (!job.controller.signal.aborted) {
            record.phase = truncateUtf8(
              update.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
              1024,
            );
          }
          this.changed();
        },
        onUsage: (usage) => {
          record.usage = structuredClone(usage);
          this.persist(job);
        },
      });
      record.details = result.details;
      record.usage = result.usage;
      record.latestGeneratorReport = result.latestGeneratorReport;
      status =
        result.details.status === "completed" ? "completed" : "exhausted";
    } catch (error) {
      record.error = truncateUtf8(
        error instanceof Error ? error.message : String(error),
        4096,
      );
      status = "error";
    }
    if (job.controller.signal.aborted)
      status = this.closed ? "interrupted" : "cancelled";

    // Archive before releasing the slot or publishing a completion event.
    const terminal = {
      ...structuredClone(record),
      status,
      phase: status,
      updatedAt: new Date().toISOString(),
    };
    const save = async () => {
      try {
        if (this.options.saveResult)
          await this.options.saveResult(structuredClone(terminal));
        else if (terminal.details?.loopDirectory) {
          await writeFile(
            join(terminal.details.loopDirectory, "loop-result.json"),
            `${JSON.stringify(terminal, null, 2)}\n`,
            "utf8",
          );
        }
      } catch (error) {
        terminal.error = `${terminal.error ? `${terminal.error}\n` : ""}Result archival failed: ${String(error)}`;
        if (terminal.status === "completed" || terminal.status === "exhausted")
          terminal.status = "error";
      }
    };
    await save();
    // Cancellation can arrive during archival. Keep the slot reserved while
    // correcting the archive, rather than reporting a stale accepted result.
    if (
      job.controller.signal.aborted &&
      (terminal.status !== (this.closed ? "interrupted" : "cancelled") ||
        terminal.delivery !== record.delivery)
    ) {
      terminal.status = this.closed ? "interrupted" : "cancelled";
      terminal.delivery = record.delivery;
      terminal.phase = terminal.status;
      await save();
    }
    terminal.phase = terminal.status;
    job.record = terminal;
    this.persist(job);
    this.changed();
  }
}
