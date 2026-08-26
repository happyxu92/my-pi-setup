import assert from "node:assert/strict";
import test from "node:test";

import {
  parseEvaluatorOutput,
  runAdversarialLoopBatch,
  type Criterion,
} from "./core.ts";
import { buildEvaluatorPrompt } from "./evaluator.ts";

test("builds an independent evaluator prompt without a generator report or criteria count", () => {
  const prompt = buildEvaluatorPrompt("Deliver the artifact", 1, undefined, {
    taskSpecPath: "/loop/task-spec.md",
    agentDirectory: "/loop/evaluator",
  });

  assert.doesNotMatch(prompt, /generator report/i);
  assert.doesNotMatch(prompt, /2-10/);
  assert.match(prompt, /Generate concrete acceptance criteria/);
  assert.match(
    prompt,
    /judge task completion solely from the current deliverables/,
  );
});

test("parses fenced evaluator JSON and accepts evidenced passing checks", () => {
  const evaluation = parseEvaluatorOutput(`The result is:\n\n\`\`\`json
{
  "criteria": [
    {
      "id": "C1",
      "description": "The command returns success",
      "verification": "Run npm test"
    }
  ],
  "checks": [
    {
      "criterionId": "C1",
      "status": "pass",
      "evidence": "npm test exited 0"
    }
  ],
  "completed": true,
  "feedback": [],
  "summary": "Verified"
}
\`\`\``);

  assert.equal(evaluation.completed, true);
  assert.equal(evaluation.criteria[0].id, "C1");
  assert.equal(evaluation.checks[0].status, "pass");
});

test("does not accept completion when a pass has no evidence", () => {
  const evaluation = parseEvaluatorOutput(
    JSON.stringify({
      criteria: [
        {
          id: "C1",
          description: "Tests pass",
          verification: "Run tests",
        },
      ],
      checks: [{ criterionId: "C1", status: "pass", evidence: "" }],
      completed: true,
      feedback: [],
      summary: "Done",
    }),
  );

  assert.equal(evaluation.completed, false);
  assert.equal(evaluation.checks[0].status, "unknown");
  assert.match(evaluation.feedback[0], /C1/);
});

test("keeps frozen criteria and synthesizes feedback for missing checks", () => {
  const frozenCriteria: Criterion[] = [
    {
      id: "C-original",
      description: "Preserve the public API",
      verification: "Run the compatibility test",
    },
  ];

  const evaluation = parseEvaluatorOutput(
    JSON.stringify({
      criteria: [
        {
          id: "C-weakened",
          description: "Only compile",
          verification: "Run tsc",
        },
      ],
      checks: [],
      completed: true,
      feedback: [],
      summary: "Looks fine",
    }),
    frozenCriteria,
  );

  assert.deepEqual(evaluation.criteria, frozenCriteria);
  assert.equal(evaluation.completed, false);
  assert.equal(evaluation.checks[0].criterionId, "C-original");
  assert.match(evaluation.feedback[0], /C-original/);
});

test("rejects a first evaluation without criteria", () => {
  assert.throws(
    () =>
      parseEvaluatorOutput(
        JSON.stringify({
          criteria: [],
          checks: [],
          completed: false,
          feedback: ["Keep working"],
          summary: "Incomplete",
        }),
      ),
    /acceptance criteria/,
  );
});

test("runs a batch concurrently while preserving loop order and usage", async () => {
  let active = 0;
  let maximumActive = 0;
  const updates: string[] = [];

  const result = await runAdversarialLoopBatch({
    loops: [
      { task: "first", maxIterations: 2 },
      { task: "second", maxIterations: 3 },
    ],
    cwd: "/workspace",
    model: "provider/model",
    thinkingLevel: "high",
    projectTrusted: true,
    onUpdate: (update) => {
      updates.push(
        update.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
    },
    runLoop: async (options) => {
      assert.equal(options.projectTrusted, true);
      active++;
      maximumActive = Math.max(maximumActive, active);
      options.onUpdate?.({
        content: [{ type: "text", text: `checking ${options.task}` }],
        details: {
          status: "running",
          task: options.task,
          model: options.model,
          maxIterations: options.maxIterations,
          criteria: [],
          rounds: [],
        },
      });
      await new Promise((resolve) =>
        setTimeout(resolve, options.task === "first" ? 20 : 5),
      );
      active--;

      return {
        details: {
          status: "completed",
          task: options.task,
          model: options.model,
          maxIterations: options.maxIterations,
          criteria: [],
          rounds: [],
        },
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: {
            input: 0.1,
            output: 0.2,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.3,
          },
        },
        latestGeneratorReport: `${options.task} report`,
      };
    },
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(
    result.details.loops.map((loop) => loop.task),
    ["first", "second"],
  );
  assert.deepEqual(result.latestGeneratorReports, [
    "first report",
    "second report",
  ]);
  assert.equal(result.details.status, "completed");
  assert.equal(result.usage.totalTokens, 6);
  assert.ok(updates.some((update) => update.startsWith("[Loop 1/2]")));
  assert.ok(updates.some((update) => update.startsWith("[Loop 2/2]")));
});
