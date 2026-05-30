// Phase 3 — Wenyan gate tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideWenyanGate, evaluateRecordedSamples, WENYAN_GATE } from "../wenyanGate.js";

test("the gate threshold is locked at 10 points (binding)", () => {
  assert.equal(WENYAN_GATE.minDeltaPoints, 10);
});

test("with no recorded samples the gate is UNDECIDED and wenyan stays unbuilt", () => {
  const d = decideWenyanGate(undefined);
  assert.equal(d.build, false);
  assert.equal(d.status, "UNDECIDED");

  const d2 = decideWenyanGate([]);
  assert.equal(d2.build, false);
  assert.equal(d2.status, "UNDECIDED");
});

test("malformed samples do not decide the gate", () => {
  const r = evaluateRecordedSamples([{ ultra: "x", wenyan: "y" }]); // missing baseline
  assert.equal(r.decided, false);
});

test("a delta below 10 points FAILS the gate (stays unbuilt)", () => {
  // ultra reduces ~25%, wenyan ~30% -> 5 point delta, below the bar.
  const baseline = "x".repeat(100);
  const samples = [{
    baseline,
    ultra: "x".repeat(75),
    wenyan: "x".repeat(70),
  }];
  const d = decideWenyanGate(samples);
  assert.equal(d.status, "FAIL");
  assert.equal(d.build, false);
});

test("a delta at/above 10 points PASSES the gate (build allowed)", () => {
  // baseline 100 latin chars (~25 tokens). ultra ~ same. wenyan collapses to a
  // few CJK chars -> large token delta, well over 10 points.
  const baseline = "the quick brown fox jumps over the lazy dog ".repeat(4);
  const samples = [{
    baseline,
    ultra: baseline.slice(0, Math.floor(baseline.length * 0.8)),
    wenyan: "犬眠狐越", // 4 CJK chars ~ 4 tokens
  }];
  const d = decideWenyanGate(samples);
  assert.equal(d.status, "PASS");
  assert.equal(d.build, true);
});

test("the decision detail names the delta and the locked bar", () => {
  const baseline = "hello world this is a test sentence ".repeat(3);
  const d = decideWenyanGate([{ baseline, ultra: baseline, wenyan: baseline }]);
  assert.match(d.detail, /pts over ultra/);
  assert.match(d.detail, /10 pts/);
});
