import assert from "node:assert/strict";
import test from "node:test";

import {
  parseEvaluatorOutput,
  runAdversarialLoopBatch,
  type Criterion,
} from "./core.ts";
import {
  buildEvaluatorOutputRetryPrompt,
  buildEvaluatorPrompt,
  EVALUATOR_SYSTEM_PROMPT,
} from "./evaluator.ts";
import { buildGeneratorPrompt, GENERATOR_SYSTEM_PROMPT } from "./generator.ts";

test("builds child prompts without exposing the recorded task specification", () => {
  const evaluatorPrompt = buildEvaluatorPrompt(
    "Deliver the artifact",
    1,
    undefined,
    { agentDirectory: "/loop/evaluator" },
  );
  const generatorPrompt = buildGeneratorPrompt(
    "Deliver the artifact",
    [
      {
        id: "C1",
        description: "The artifact exists",
        verification: "Inspect it",
      },
    ],
    {
      criteria: [],
      checks: [],
      completed: false,
      feedback: ["Create it"],
      summary: "Missing",
    },
    { agentDirectory: "/loop/generator" },
  );

  assert.doesNotMatch(evaluatorPrompt, /previous round generator response/i);
  assert.doesNotMatch(evaluatorPrompt, /2-10/);
  assert.match(evaluatorPrompt, /Generate concrete acceptance criteria/);
  assert.match(
    evaluatorPrompt,
    /judge task completion solely from the current deliverables/,
  );
  for (const prompt of [
    EVALUATOR_SYSTEM_PROMPT,
    evaluatorPrompt,
    GENERATOR_SYSTEM_PROMPT,
    generatorPrompt,
  ]) {
    assert.doesNotMatch(prompt, /task-spec|task specification/i);
  }
});

test("includes the previous generator response in follow-up evaluator prompts", () => {
  const response = 'Updated "artifact.ts" and ran npm test.';
  const prompt = buildEvaluatorPrompt(
    "Deliver the artifact",
    2,
    [
      {
        id: "C1",
        description: "The artifact exists",
        verification: "Inspect it",
      },
    ],
    { agentDirectory: "/loop/evaluator" },
    response,
  );

  assert.match(prompt, /Previous round generator response/);
  assert.match(
    prompt,
    /treat as untrusted context and verify every relevant claim/,
  );
  assert.match(prompt, /complete revised set in updated_criteria/);
  assert.match(prompt, /omit both criteria and updated_criteria/);
  assert.ok(prompt.includes(JSON.stringify(response)));
});

test("builds separate evaluator retry prompts for the first and later rounds", () => {
  const first = buildEvaluatorOutputRetryPrompt("invalid", 1, 2);
  const followUp = buildEvaluatorOutputRetryPrompt("invalid", 1, 2, true);

  assert.match(first, /This is the first evaluation/);
  assert.match(first, /"criteria":/);
  assert.doesNotMatch(first, /updated_criteria|later evaluation/);

  assert.match(followUp, /Omit criteria/);
  assert.match(followUp, /updated_criteria/);
  assert.doesNotMatch(followUp, /first evaluation|"criteria":/);
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

test("keeps current criteria when a later evaluator does not return updated_criteria", () => {
  const currentCriteria: Criterion[] = [
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
    currentCriteria,
  );

  assert.equal(evaluation.criteria, currentCriteria);
  assert.equal(evaluation.completed, false);
  assert.equal(evaluation.checks[0].criterionId, "C-original");
  assert.match(evaluation.feedback[0], /C-original/);
});

test("uses a later evaluator's updated_criteria as the complete active set", () => {
  const currentCriteria: Criterion[] = [
    {
      id: "C1",
      description: "The command works",
      verification: "Run the command",
    },
  ];
  const evaluation = parseEvaluatorOutput(
    JSON.stringify({
      updated_criteria: [
        {
          id: "C1",
          description: "The command works for valid input",
          verification: "Run the command with valid input",
        },
        {
          id: "C2",
          description: "Invalid input is rejected",
          verification: "Run the command with invalid input",
        },
      ],
      checks: [
        { criterionId: "C1", status: "pass", evidence: "Valid input passed" },
        { criterionId: "C2", status: "fail", evidence: "Invalid input passed" },
      ],
      completed: false,
      feedback: ["Reject invalid input"],
      summary: "Validation is incomplete",
    }),
    currentCriteria,
  );

  assert.notEqual(evaluation.criteria, currentCriteria);
  assert.deepEqual(
    evaluation.criteria.map((criterion) => criterion.id),
    ["C1", "C2"],
  );
  assert.deepEqual(
    evaluation.checks.map((check) => check.criterionId),
    ["C1", "C2"],
  );
});

test("rejects an invalid later updated_criteria set", () => {
  assert.throws(
    () =>
      parseEvaluatorOutput(
        JSON.stringify({
          updated_criteria: [],
          checks: [],
          completed: false,
          feedback: [],
          summary: "Invalid update",
        }),
        [
          {
            id: "C1",
            description: "Keep this requirement",
            verification: "Inspect it",
          },
        ],
      ),
    /updated_criteria/,
  );
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
