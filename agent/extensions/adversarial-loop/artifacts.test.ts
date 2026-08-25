import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEvaluatorResult,
  appendGeneratorResult,
  createIterationArtifacts,
  createLoopArtifacts,
  writeTaskSpec,
} from "./artifacts.ts";

const criterion = {
  id: "C1",
  description: "A concrete deliverable exists",
  verification: "Inspect the deliverable",
};

test("creates a unique loop archive with per-iteration agent directories", async () => {
  const workspace = join(
    tmpdir(),
    `adversarial-loop-artifacts-${process.pid}-${Date.now()}`,
  );

  try {
    const first = await createLoopArtifacts(workspace, "Create the artifact");
    const second = await createLoopArtifacts(
      workspace,
      "Create another artifact",
    );
    assert.notEqual(first.loopDirectory, second.loopDirectory);
    assert.equal(
      first.loopDirectory.startsWith(join(workspace, ".adversarial-loop")),
      true,
    );

    const iteration = await createIterationArtifacts(first, 1);
    await writeTaskSpec(first, "Create the artifact", [criterion]);
    await appendEvaluatorResult(first, 1, iteration.evaluatorDirectory, {
      criteria: [criterion],
      checks: [
        {
          criterionId: "C1",
          status: "fail",
          evidence: "The deliverable is missing",
        },
      ],
      completed: false,
      feedback: ["Create it"],
      summary: "Not complete",
    });
    await appendGeneratorResult(first, 1, iteration.generatorDirectory, {
      report: "Created the artifact",
      stopReason: "end",
    });

    const taskSpec = await readFile(first.taskSpecPath, "utf8");
    assert.match(taskSpec, /# Task Specification/);
    assert.match(taskSpec, /## C1/);

    const evaluatorLines = (await readFile(first.evaluatorResultsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(evaluatorLines.length, 1);
    assert.equal(evaluatorLines[0].iteration, 1);
    assert.equal(evaluatorLines[0].result.checks[0].status, "fail");
    assert.equal(evaluatorLines[0].agentDirectory, "iterations/001/evaluator");

    const generatorLines = (await readFile(first.generatorResultsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(generatorLines.length, 1);
    assert.equal(generatorLines[0].summary, "Created the artifact");
    assert.equal(generatorLines[0].agentDirectory, "iterations/001/generator");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
