import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type CheckStatus = "pass" | "fail" | "unknown";

export interface AgentArtifactPaths {
  taskSpecPath: string;
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
  maxIterations: number;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<AdversarialLoopDetails>;
}
