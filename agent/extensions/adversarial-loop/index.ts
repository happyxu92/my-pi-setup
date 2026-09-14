import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  DEFAULT_GOAL_MAX_CONTINUATIONS,
  DEFAULT_MAX_PARALLEL_LOOPS,
  GOAL_MAX_CONTINUATIONS_FLAG,
  MAX_PARALLEL_LOOPS_FLAG,
  parseGoalMaxContinuations,
  parseMaxParallelLoops,
} from "./config.ts";
import { registerGoalFeature } from "./goal.ts";
import {
  LOOP_STATE_ENTRY,
  LoopManager,
  parseLoopRecord,
  type LoopManagerOptions,
} from "./loop-manager.ts";
import {
  formatBackgroundResults,
  formatCapacity,
  LoopNotifier,
  summarizeLoop,
} from "./loop-notifier.ts";
import { truncateUtf8 } from "./utils.ts";

const DEFAULT_MAX_ITERATIONS = 6;
const STATUS_KEY = "adversarial-loops";

function createParameters(maxParallelLoops: number) {
  return Type.Object({
    loops: Type.Array(
      Type.Object({
        task: Type.String({
          minLength: 1,
          description:
            "Complete self-contained delivery task, including artifacts, acceptance criteria, constraints and an independent, non-overlapping workspace scope.",
        }),
        maxIterations: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 20,
            default: DEFAULT_MAX_ITERATIONS,
            description:
              "Maximum generator attempts before the safety stop. A final evaluator still runs.",
          }),
        ),
      }),
      {
        minItems: 1,
        maxItems: maxParallelLoops,
        description: `Start background loops. All calls share a session-wide limit of ${maxParallelLoops}; insufficient capacity rejects the entire request.`,
      },
    ),
  });
}

function requireStandaloneCall(
  toolName: "adversarial_loop" | "adversarial_loop_wait",
  toolCallId: string,
  ctx: ExtensionContext,
) {
  const assistant = ctx.sessionManager
    .getBranch()
    .filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    )
    .at(-1);
  const calls =
    assistant?.type === "message" && assistant.message.role === "assistant"
      ? assistant.message.content.filter((part) => part.type === "toolCall")
      : [];
  if (
    calls.length !== 1 ||
    calls[0].id !== toolCallId ||
    calls[0].name !== toolName
  ) {
    throw new Error(
      `${toolName} must be the only tool call in its assistant message. Do not batch it with other tools or another call; put multiple loop tasks in one loops array.`,
    );
  }
}

export default function (
  pi: ExtensionAPI,
  options: Pick<LoopManagerOptions, "runLoop" | "saveResult"> = {},
) {
  pi.registerFlag(MAX_PARALLEL_LOOPS_FLAG, {
    description: `Session-wide maximum concurrent adversarial loops (default: ${DEFAULT_MAX_PARALLEL_LOOPS})`,
    type: "string",
    default: String(DEFAULT_MAX_PARALLEL_LOOPS),
  });
  pi.registerFlag(GOAL_MAX_CONTINUATIONS_FLAG, {
    description: `Maximum automatic Goal continuations (default: ${DEFAULT_GOAL_MAX_CONTINUATIONS})`,
    type: "string",
    default: String(DEFAULT_GOAL_MAX_CONTINUATIONS),
  });

  let goalMaxContinuations = DEFAULT_GOAL_MAX_CONTINUATIONS;
  let maxParallelLoops = DEFAULT_MAX_PARALLEL_LOOPS;
  let runtime:
    | {
        manager: LoopManager;
        notifier: LoopNotifier;
        ctx: ExtensionContext;
        live: boolean;
        persist: boolean;
        lastRunFailed: boolean;
      }
    | undefined;

  const requireRuntime = (ctx: ExtensionContext) => {
    if (!runtime?.live)
      throw new Error("Background loop runtime is unavailable");
    runtime.ctx = ctx;
    return runtime;
  };
  const requireBackgroundMode = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
      throw new Error(
        "Background loops require a persistent TUI or RPC session. Print/JSON mode can exit before background work finishes and is not supported.",
      );
    }
  };
  const showStatus = () => {
    if (!runtime?.live || !runtime.ctx.hasUI) return;
    const capacity = runtime.manager.capacity();
    const pending = runtime.manager.pending().length;
    runtime.ctx.ui.setStatus(
      STATUS_KEY,
      capacity.active || pending
        ? `Loops ${capacity.active}/${capacity.limit}${runtime.notifier.waiting ? " · waiting" : ""}${pending ? ` · ${pending} ready` : ""}`
        : undefined,
    );
  };

  const registerStartTool = () =>
    pi.registerTool({
      name: "adversarial_loop",
      label: "Adversarial Loop",
      description:
        "Start background evaluator-generator delivery loops with fresh isolated pi agents. Returns task IDs immediately, NOT final acceptance. Loops independently establish acceptance criteria, improve deliverables, and verify them until acceptance or the safety limit. All calls share the session concurrency limit. An individual failure does not stop other loops. Must be the ONLY tool call in its assistant message. Completion results arrive automatically. Output exceeding 48 KiB is truncated; archives retain full results.",
      promptSnippet:
        "Start background delivery and independent review loops; call alone",
      promptGuidelines: [
        "Use adversarial_loop when explicitly requested, for strict completion criteria, or for substantial workspace deliverables needing unusually high quality; it supports code, documents, specifications, reports, analyses and configuration, not casual questions or trivial edits.",
        "Pass adversarial_loop a loops array of complete self-contained tasks because child agents cannot see the parent conversation. Both concurrent loops and the main agent must avoid modifying each other's active workspace scopes.",
        "adversarial_loop only acknowledges submission; never claim acceptance until a completed result arrives. Capacity is session-wide across all calls.",
        "Call adversarial_loop alone, with all new tasks in one loops array. Results arrive automatically. Continue independent work, or call adversarial_loop_wait alone when nothing useful remains. Never poll status or emit waiting commentary.",
      ],
      parameters: createParameters(maxParallelLoops),
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        requireBackgroundMode(ctx);
        signal?.throwIfAborted();
        requireStandaloneCall("adversarial_loop", toolCallId, ctx);
        if (!ctx.model)
          throw new Error("No active model is available for child agents");
        const { manager, notifier } = requireRuntime(ctx);
        const records = manager.start(
          params.loops.map((loop) => ({
            task: loop.task,
            maxIterations: loop.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          })),
          {
            cwd: ctx.cwd,
            model: `${ctx.model.provider}/${ctx.model.id}`,
            thinkingLevel: ctx.thinkingLevel ?? "off",
            projectTrusted: ctx.isProjectTrusted(),
          },
          toolCallId,
        );
        const result = notifier.waitAfterStart();
        showStatus();
        const capacity = manager.capacity();
        return {
          content: [
            {
              type: "text",
              text: truncateUtf8(
                `Started background loops: ${records.map((record) => record.id).join(", ")}.\n${formatCapacity(capacity)}\nSubmission is not acceptance. ${result.waiting ? "Main agent yielded. Results will arrive automatically." : "Continue independent work, or call adversarial_loop_wait alone. Results will arrive automatically."}`,
                48 * 1024,
              ),
            },
          ],
          details: { ...result, loops: records.map(summarizeLoop), capacity },
          terminate: result.waiting,
        };
      },
    });
  registerStartTool();

  pi.registerTool({
    name: "adversarial_loop_wait",
    label: "Wait for Adversarial Loops",
    description:
      "Yield the main agent while background loops run. Results or user input resume work automatically. Must be the ONLY tool call in the assistant message.",
    promptSnippet: "Yield while background loops run; call alone",
    promptGuidelines: [
      "Call adversarial_loop_wait alone when background loops are running and no useful independent work remains. Never combine adversarial_loop_wait with another tool call, including another wait.",
    ],
    parameters: Type.Object({}),
    async execute(toolCallId, _params, signal, _onUpdate, ctx) {
      requireBackgroundMode(ctx);
      signal?.throwIfAborted();
      requireStandaloneCall("adversarial_loop_wait", toolCallId, ctx);
      const { manager, notifier } = requireRuntime(ctx);
      const result = notifier.wait();
      showStatus();
      const capacity = manager.capacity();
      let text: string;
      switch (result.reason) {
        case "results_ready":
          text = formatBackgroundResults(result.records, capacity);
          break;
        case "no_active_loops":
          text = `Not waiting: no active loops remain.\n${formatCapacity(capacity)}`;
          break;
        case "pending_messages":
          text = `Not waiting: another message is pending.\n${formatCapacity(capacity)}`;
          break;
        case "waiting_for_results":
          text = `Main agent yielded. Background loops continue; results or user input will resume work.\n${formatCapacity(capacity)}`;
          break;
      }
      return {
        content: [{ type: "text", text }],
        details: {
          waiting: result.waiting,
          reason: result.reason,
          loops: result.records.map(summarizeLoop),
          capacity,
        },
        terminate: result.waiting,
      };
    },
  });

  pi.registerTool({
    name: "adversarial_loop_manage",
    label: "Manage Adversarial Loops",
    description:
      "Inspect background loop status/capacity, reread results by ID, or cancel loops. Results are retained and reads are repeatable. Cancellation reserves capacity until the child actually exits. Cancelled results are suppressed. Output is limited to 48 KiB; full results and usage are retained in the archive/session ledger.",
    promptSnippet: "Inspect, retrieve, or cancel background loops",
    parameters: Type.Object({
      action: StringEnum(["status", "result", "cancel"] as const),
      ids: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          description:
            "Loop IDs. Required for result; omit for all loops with status/cancel.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { manager, notifier } = requireRuntime(ctx);
      if (params.action === "result" && !params.ids?.length)
        throw new Error("result requires loop ids");
      const records =
        params.action === "cancel"
          ? manager.cancel(params.ids)
          : params.ids
            ? params.ids.map((id) => manager.get(id))
            : manager.records();
      if (params.action === "cancel") notifier.cancelNotification();
      if (params.action === "result")
        notifier.consume(records.map((record) => record.id));
      const capacity = manager.capacity();
      return {
        content: [
          {
            type: "text",
            text:
              params.action === "result"
                ? formatBackgroundResults(records, capacity)
                : truncateUtf8(
                    `${formatCapacity(capacity)}\n${JSON.stringify(records.map(summarizeLoop), null, 2)}`,
                    48 * 1024,
                  ),
          },
        ],
        details: { loops: records.map(summarizeLoop), capacity },
      };
    },
  });

  const stopAll = () => {
    runtime?.notifier.stop();
    runtime?.manager.cancel();
    showStatus();
  };
  pi.registerCommand("loops", {
    description: "Background loops: status | stop <id|all>",
    handler: async (args, ctx) => {
      const { manager, notifier } = requireRuntime(ctx);
      const [command = "status", target, ...extra] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (command === "status" && !target) {
        ctx.ui.notify(
          truncateUtf8(
            `${formatCapacity(manager.capacity())}\n${manager
              .records()
              .map(
                (record) => `${record.id}: ${record.status} — ${record.phase}`,
              )
              .join("\n")}`,
            48 * 1024,
          ),
          "info",
        );
      } else if (command === "stop" && target && !extra.length) {
        try {
          if (target === "all") {
            stopAll();
            if (!ctx.isIdle()) ctx.abort();
          } else {
            manager.cancel([target]);
            notifier.cancelNotification();
          }
          ctx.ui.notify(
            "Cancellation requested. Capacity is released after the child exits.",
            "info",
          );
        } catch (error) {
          ctx.ui.notify(String(error), "warning");
        }
      } else
        ctx.ui.notify("Usage: /loops status | /loops stop <id|all>", "warning");
    },
  });

  const shutdown = async (persist: boolean) => {
    const current = runtime;
    if (!current) return;
    current.live = false;
    current.persist = persist;
    // Invalidate Goal callbacks before awaiting its shared audit runner. During
    // /tree the leaf already changed, so a late audit must not persist there.
    goalFeature.invalidate();
    current.notifier.dispose();
    await current.manager.shutdown();
    current.persist = false;
    if (runtime === current) runtime = undefined;
  };
  const startRuntime = (ctx: ExtensionContext) => {
    const manager = new LoopManager({
      ...options,
      limit: maxParallelLoops,
      persist: (record) => {
        if (runtime?.manager === manager && runtime.persist)
          pi.appendEntry(LOOP_STATE_ENTRY, record);
      },
      changed: () => {
        if (runtime?.manager !== manager || !runtime.live) return;
        showStatus();
        runtime.notifier.schedule();
      },
      onError: (error) => {
        if (runtime?.manager === manager && runtime.live)
          ctx.ui.notify(
            `Could not persist loop state: ${String(error)}`,
            "warning",
          );
      },
    });
    const notifier = new LoopNotifier(manager, pi, () =>
      runtime?.manager === manager && runtime.live ? runtime.ctx : undefined,
    );
    runtime = {
      manager,
      notifier,
      ctx,
      live: true,
      persist: true,
      lastRunFailed: false,
    };
    const records = ctx.sessionManager.getBranch().flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== LOOP_STATE_ENTRY)
        return [];
      const record = parseLoopRecord(entry.data);
      return record ? [record] : [];
    });
    manager.restore(records);
    showStatus();
  };

  pi.on("session_start", async (_event, ctx) => {
    await shutdown(false);
    try {
      maxParallelLoops = parseMaxParallelLoops(
        pi.getFlag(MAX_PARALLEL_LOOPS_FLAG),
      );
    } catch (error) {
      maxParallelLoops = DEFAULT_MAX_PARALLEL_LOOPS;
      ctx.ui.notify(
        `Ignoring invalid --${MAX_PARALLEL_LOOPS_FLAG}: ${String(error)}; using ${maxParallelLoops}`,
        "warning",
      );
    }
    try {
      goalMaxContinuations = parseGoalMaxContinuations(
        pi.getFlag(GOAL_MAX_CONTINUATIONS_FLAG),
      );
    } catch (error) {
      goalMaxContinuations = DEFAULT_GOAL_MAX_CONTINUATIONS;
      ctx.ui.notify(
        `Ignoring invalid --${GOAL_MAX_CONTINUATIONS_FLAG}: ${String(error)}; using ${goalMaxContinuations}`,
        "warning",
      );
    }
    startRuntime(ctx);
    registerStartTool();
  });
  pi.on("session_shutdown", async () => shutdown(true));
  pi.on("session_tree", async (_event, ctx) => {
    // The leaf has already changed: never append old task updates to this branch.
    await shutdown(false);
    startRuntime(ctx);
  });
  // Never start a competing main run while the host is rebuilding its context.
  // On hosts without a compaction-failed extension event, a failed manual
  // compaction remains suspended until the next agent_start/user-driven run.
  pi.on("session_before_tree", () => runtime?.notifier.suspendDelivery());
  pi.on("session_before_compact", () => runtime?.notifier.suspendDelivery());
  pi.on("session_compact", () => runtime?.notifier.resumeDelivery());
  pi.on("agent_start", () => runtime?.notifier.resumeDelivery());
  pi.on("input", (_event, ctx) => {
    if (!runtime?.live) return;
    runtime.ctx = ctx;
    runtime.notifier.userInput();
  });
  pi.on("context", (event, ctx) => {
    if (!runtime?.live) return;
    runtime.ctx = ctx;
    return { messages: runtime.notifier.context(event.messages) };
  });
  pi.on("message_end", (event) => {
    if (
      event.message.role === "toolResult" &&
      event.message.toolName === "adversarial_loop"
    ) {
      runtime?.notifier.announceStart(event.message.toolCallId);
    }
  });
  pi.on("agent_end", (event, ctx) => {
    if (!runtime?.live) return;
    const finalAssistant = event.messages
      .filter((message) => message.role === "assistant")
      .at(-1);
    runtime.lastRunFailed =
      finalAssistant?.stopReason === "error" ||
      finalAssistant?.stopReason === "aborted" ||
      ctx.signal?.aborted === true;
    runtime.notifier.agentEnd();
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!runtime?.live) return;
    runtime.ctx = ctx;
    runtime.notifier.settled(runtime.lastRunFailed);
    showStatus();
  });

  const goalFeature = registerGoalFeature(pi, {
    getMaxContinuations: () => goalMaxContinuations,
    canAudit: () => !!runtime?.live && !runtime.notifier.blocksAudit,
    onStop: stopAll,
    runLoop: (options) => {
      if (!runtime?.live)
        throw new Error("Loop runtime is unavailable for Goal audit");
      return runtime.manager.runAudit(options);
    },
  });
}
