import assert from "node:assert/strict";
import test from "node:test";

import { parseEvaluatorOutput, type Criterion } from "./core.ts";

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
