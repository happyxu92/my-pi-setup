import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GOAL_MAX_CONTINUATIONS,
  DEFAULT_MAX_PARALLEL_LOOPS,
  parseGoalMaxContinuations,
  parseMaxParallelLoops,
} from "./config.ts";

test("defaults the maximum parallel loop count to six", () => {
  assert.equal(DEFAULT_MAX_PARALLEL_LOOPS, 6);
  assert.equal(parseMaxParallelLoops(undefined), 6);
});

test("parses a configured maximum parallel loop count", () => {
  assert.equal(parseMaxParallelLoops(" 12 "), 12);
});

test("rejects invalid maximum parallel loop counts", () => {
  for (const value of ["", "0", "-1", "1.5", "many", true]) {
    assert.throws(() => parseMaxParallelLoops(value), /positive/);
  }
});

test("defaults and parses the Goal continuation limit", () => {
  assert.equal(DEFAULT_GOAL_MAX_CONTINUATIONS, 25);
  assert.equal(parseGoalMaxContinuations(undefined), 25);
  assert.equal(parseGoalMaxContinuations(" 40 "), 40);
});

test("rejects invalid Goal continuation limits", () => {
  for (const value of ["", "0", "-1", "1.5", "many", false]) {
    assert.throws(() => parseGoalMaxContinuations(value), /positive/);
  }
});
