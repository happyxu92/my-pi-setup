import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { Criterion, Evaluation, GeneratorResult } from "./types.ts";

export interface LoopArtifacts {
  rootDirectory: string;
  loopDirectory: string;
  taskSpecPath: string;
  evaluatorResultsPath: string;
  generatorResultsPath: string;
  iterationsDirectory: string;
}

export interface IterationArtifacts {
  iterationDirectory: string;
  evaluatorDirectory: string;
  generatorDirectory: string;
}

function timestampForPath() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export async function createLoopArtifacts(cwd: string, task: string) {
  const rootDirectory = join(resolve(cwd), ".adversarial-loop");
  await mkdir(rootDirectory, { recursive: true });
  const loopDirectory = await mkdtemp(
    join(rootDirectory, `${timestampForPath()}-`),
  );
  const artifacts: LoopArtifacts = {
    rootDirectory,
    loopDirectory,
    taskSpecPath: join(loopDirectory, "task-spec.md"),
    evaluatorResultsPath: join(loopDirectory, "evaluator-results.jsonl"),
    generatorResultsPath: join(loopDirectory, "generator-results.jsonl"),
    iterationsDirectory: join(loopDirectory, "iterations"),
  };

  await mkdir(artifacts.iterationsDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(loopDirectory, "original-task.md"),
      `# Original Task\n\n${task.trim()}\n`,
      "utf8",
    ),
    writeFile(artifacts.evaluatorResultsPath, "", "utf8"),
    writeFile(artifacts.generatorResultsPath, "", "utf8"),
  ]);
  return artifacts;
}

export async function createIterationArtifacts(
  artifacts: LoopArtifacts,
  iteration: number,
) {
  const iterationDirectory = join(
    artifacts.iterationsDirectory,
    String(iteration).padStart(3, "0"),
  );
  const result: IterationArtifacts = {
    iterationDirectory,
    evaluatorDirectory: join(iterationDirectory, "evaluator"),
    generatorDirectory: join(iterationDirectory, "generator"),
  };
  await Promise.all([
    mkdir(result.evaluatorDirectory, { recursive: true }),
    mkdir(result.generatorDirectory, { recursive: true }),
  ]);
  return result;
}

export function formatTaskSpec(task: string, criteria: Criterion[]) {
  const criterionSections = criteria
    .map(
      (criterion) =>
        `## ${criterion.id}\n\n${criterion.description}\n\n**Verification:** ${criterion.verification}`,
    )
    .join("\n\n");

  return `# Task Specification\n\n## Original task\n\n${task.trim()}\n\n## Frozen acceptance criteria\n\n${criterionSections}\n\n## Acceptance policy\n\nThe evaluator may accept the task only when every frozen criterion passes with concrete evidence from the current workspace or verification output. Failed or unverifiable criteria require another generator iteration.\n`;
}

export async function writeTaskSpec(
  artifacts: LoopArtifacts,
  task: string,
  criteria: Criterion[],
) {
  await writeFile(
    artifacts.taskSpecPath,
    formatTaskSpec(task, criteria),
    "utf8",
  );
}

async function appendJsonLine(path: string, value: unknown) {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export async function appendEvaluatorResult(
  artifacts: LoopArtifacts,
  iteration: number,
  evaluatorDirectory: string,
  result: Evaluation | { error: string },
) {
  await appendJsonLine(artifacts.evaluatorResultsPath, {
    iteration,
    timestamp: new Date().toISOString(),
    agentDirectory: relative(artifacts.loopDirectory, evaluatorDirectory),
    result,
  });
}

export async function appendGeneratorResult(
  artifacts: LoopArtifacts,
  iteration: number,
  generatorDirectory: string,
  result: GeneratorResult | { error: string },
) {
  await appendJsonLine(artifacts.generatorResultsPath, {
    iteration,
    timestamp: new Date().toISOString(),
    agentDirectory: relative(artifacts.loopDirectory, generatorDirectory),
    summary: "report" in result ? result.report : undefined,
    stopReason: "stopReason" in result ? result.stopReason : undefined,
    error: "error" in result ? result.error : undefined,
  });
}
