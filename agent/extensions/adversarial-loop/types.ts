import type { Usage } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type CheckStatus = "pass" | "fail" | "unknown";

export interface AgentArtifactPaths {
  agentDirectory: string;
}

export interface Criterion {
  id: string;
  description: string;
  verification: string;
}

export interface CriterionCheck {
  criterionId: string;
  status: CheckStatus;
  evidence: string;
}

export interface Evaluation {
  criteria: Criterion[];
  checks: CriterionCheck[];
  completed: boolean;
  feedback: string[];
  summary: string;
}

export interface GeneratorResult {
  report: string;
  stopReason?: string;
}

export interface LoopRound {
  round: number;
  evaluation: Evaluation;
  generator?: GeneratorResult;
}

export interface AdversarialLoopDetails {
  status: "running" | "completed" | "exhausted";
  task: string;
  model: string;
  loopDirectory?: string;
  maxIterations: number;
  criteria: Criterion[];
  rounds: LoopRound[];
}

export interface AdversarialLoopRequest {
  task: string;
  maxIterations: number;
}

export interface AdversarialLoopBatchDetails {
  status: "running" | "completed" | "exhausted";
  model: string;
  loops: AdversarialLoopDetails[];
}

export interface RunLoopOptions {
  task: string;
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  projectTrusted: boolean;
  maxIterations: number;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<AdversarialLoopDetails>;
  /** Cumulative usage, including work performed before a child fails. */
  onUsage?: (usage: Usage) => void;
}

export type BackgroundLoopStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "exhausted"
  | "error"
  | "cancelled"
  | "interrupted";

export interface BackgroundLoopRecord {
  version: 1;
  id: string;
  toolCallId: string;
  task: string;
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  maxIterations: number;
  status: BackgroundLoopStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  delivery: "pending" | "delivered" | "suppressed";
  usage: Usage;
  details?: AdversarialLoopDetails;
  latestGeneratorReport?: string;
  error?: string;
}

export interface LoopCapacity {
  active: number;
  limit: number;
  available: number;
  auditing: boolean;
}

export type GoalStatus =
  | "running"
  | "auditing"
  | "stopped"
  | "completed"
  | "exhausted"
  | "error"
  | "interrupted";

export interface GoalAuditSummary {
  completed: boolean;
  summary: string;
  feedback: string[];
  loopDirectory?: string;
}

export interface GoalState {
  version: 1;
  id: string;
  previousId?: string;
  task: string;
  status: GoalStatus;
  continuationCount: number;
  maxContinuations: number;
  lastAudit?: GoalAuditSummary;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
