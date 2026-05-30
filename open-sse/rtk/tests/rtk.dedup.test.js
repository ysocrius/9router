// Phase 1 — dedup reduction pass tests.
// Run: node --test open-sse/rtk/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { deduplicateRepeatedLines } from "../dedup.js";

test("collapses a run of N identical lines into one + markers", () => {
  const input = ["x", "dup", "dup", "dup", "dup", "y"].join("\n");
  const { text, collapsed } = deduplicateRepeatedLines(input, 3);
  assert.equal(collapsed, 3); // 4 dup lines → 1 kept, 3 dropped
  assert.match(text, /\[line repeated 3x\]/);
  assert.match(text, /\[rtk:dropped 3 repeated lines\]/);
  // The unique lines survive verbatim.
  assert.match(text, /^x$/m);
  assert.match(text, /^y$/m);
});

test("leaves non-duplicate lines byte-identical", () => {
  const input = ["alpha", "beta", "gamma"].join("\n");
  const { text, collapsed } = deduplicateRepeatedLines(input, 3);
  assert.equal(collapsed, 0);
  assert.equal(text, input);
});

test("does not collapse runs below the threshold", () => {
  const input = ["dup", "dup", "tail"].join("\n"); // run of 2, threshold 3
  const { text, collapsed } = deduplicateRepeatedLines(input, 3);
  assert.equal(collapsed, 0);
  assert.equal(text, input);
});

test("does not collapse blank-line runs", () => {
  const input = ["a", "", "", "", "", "b"].join("\n");
  const { text, collapsed } = deduplicateRepeatedLines(input, 3);
  assert.equal(collapsed, 0);
  assert.equal(text, input);
});

test("handles empty and single-line input without throwing", () => {
  assert.deepEqual(deduplicateRepeatedLines("", 3), { text: "", collapsed: 0 });
  assert.deepEqual(deduplicateRepeatedLines("solo", 3), { text: "solo", collapsed: 0 });
});

test("threshold floors at 2 even if a smaller value is passed", () => {
  const input = ["d", "d", "z"].join("\n");
  const { collapsed } = deduplicateRepeatedLines(input, 1);
  assert.equal(collapsed, 1); // run of 2 collapses at effective threshold 2
});
