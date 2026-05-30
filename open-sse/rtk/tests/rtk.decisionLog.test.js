// Phase 1 — decision log tests.
// This file runs with logging ENABLED. The env var must be set before the
// modules load, because RTK_DECISION_LOG is read once at module-load time.
process.env.RTK_DECISION_LOG = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

const { DecisionLog, isEnabled, SKIP } = await import("../decisionLog.js");
const { compressMessages } = await import("../index.js");

test("logging is enabled in this file", () => {
  assert.equal(isEnabled(), true);
});

test("DecisionLog keeps one entry per output (five skips -> five entries)", () => {
  const log = new DecisionLog({ mode: "rtk", format: "gemini" });
  const reasons = [
    SKIP.ERROR_PAYLOAD, SKIP.JSON_STRING, SKIP.STRUCTURED_OBJECT,
    SKIP.UNKNOWN_SHAPE, SKIP.UNKNOWN_TOOL,
  ];
  for (const r of reasons) log.addOutput({ shape: "gemini-fnresp", skipped: r });

  const record = log.toRecord();
  assert.equal(record.outputs.length, 5, "never merged");
  assert.deepEqual(record.outputs.map(o => o.skipped), reasons, "order + reasons preserved");
  assert.equal(record.count, 5);
});

test("each entry carries its own bytes/pct/filter", () => {
  const log = new DecisionLog({});
  log.addOutput({ shape: "s", inputBytes: 1000, outputBytes: 250, filter: "git-status", engines: ["rtk"] });
  log.addOutput({ shape: "s", inputBytes: 800, outputBytes: 800, filter: "none", skipped: SKIP.JSON_STRING });

  const [a, b] = log.toRecord().outputs;
  assert.equal(a.inputBytes, 1000);
  assert.equal(a.outputBytes, 250);
  assert.equal(a.pct, 75); // (1000-250)/1000
  assert.equal(a.filter, "git-status");
  assert.equal(b.pct, 0);
  assert.equal(b.skipped, SKIP.JSON_STRING);
});

test("request-level rollup sums the per-output bytes", () => {
  const log = new DecisionLog({});
  log.addOutput({ inputBytes: 1000, outputBytes: 250 });
  log.addOutput({ inputBytes: 500, outputBytes: 500, skipped: SKIP.JSON_STRING });
  const r = log.toRecord();
  assert.equal(r.inputBytes, 1500);
  assert.equal(r.outputBytes, 750);
  assert.equal(r.pct, 50);
});

test("a multi-output Gemini request emits exactly one record with per-output detail", () => {
  // One compressible shell output + one JSON-string skip + one object skip + one error skip.
  const longText = "On branch main\n" + Array.from({ length: 80 }, (_, i) => `\tmodified: f${i}.js`).join("\n");
  const contents = [{
    role: "user",
    parts: [
      { functionResponse: { name: "run_command", response: { result: longText } } },
      { functionResponse: { name: "run_command", response: { result: JSON.stringify({ a: 1, b: 2 }) } } },
      { functionResponse: { name: "read_file", response: { result: { parsed: true } } } },
      { functionResponse: { name: "run_command", response: { result: "boom", status: "error" } } },
    ],
  }];

  const captured = [];
  const orig = console.debug;
  console.debug = (...args) => captured.push(args.join(" "));
  try {
    compressMessages({ contents }, true);
  } finally {
    console.debug = orig;
  }

  const records = captured
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(r => r && r.tag === "RTK_DECISION");
  assert.equal(records.length, 1, "exactly one record per request");

  const rec = records[0];
  assert.equal(rec.outputs.length, 4, "one entry per tool output, never merged");
  const skips = rec.outputs.map(o => o.skipped);
  assert.ok(skips.includes(SKIP.JSON_STRING));
  assert.ok(skips.includes(SKIP.STRUCTURED_OBJECT));
  assert.ok(skips.includes(SKIP.ERROR_PAYLOAD));
  // The first (shell) output should have compressed, not skipped.
  const compressed = rec.outputs.find(o => o.skipped === null);
  assert.ok(compressed, "shell output compressed");
  assert.ok(compressed.outputBytes < compressed.inputBytes);
});
