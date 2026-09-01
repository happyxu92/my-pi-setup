import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_PARALLEL_LOOPS, parseMaxParallelLoops } from "./config.ts";

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
