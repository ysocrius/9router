// Phase 2 — stacked pipeline composition + marginal accounting tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompressionPipeline, _internal } from "../pipeline.js";

const { measureBodyBytes } = _internal;

// A Gemini body with one long, compressible shell output leaf.
function geminiShellBody() {
  const text =
    "On branch main\n" +
    Array.from({ length: 80 }, (_, i) => `\tmodified:   src/file_${i}.js`).join("\n") +
    "\n";
  return {
    contents: [{
      role: "user",
      parts: [{ functionResponse: { name: "run_command", response: { result: text } } }],
    }],
  };
}

// An OpenAI body mixing a verbose user prose message + a tool result.
function openAiMixedBody() {
  return {
    messages: [
      { role: "user", content: "Sure, could you please simply go ahead and basically refactor this, thanks so much, I really appreciate it a lot here." },
      { role: "tool", content: "line\n".repeat(40) + "dup\ndup\ndup\ndup\ndup\n" + "x".repeat(600) },
    ],
  };
}

test("rtk-only pipeline reduces a Gemini shell body", () => {
  const body = geminiShellBody();
  const before = measureBodyBytes(body);
  const report = runCompressionPipeline(body, { steps: ["rtk"] });
  assert.equal(report.totalBefore, before);
  assert.ok(report.totalSaved > 0, "saved bytes");
  assert.equal(report.totalAfter, measureBodyBytes(body), "after matches re-measure");
});

test("marginal savings sum EXACTLY to total savings", () => {
  const body = openAiMixedBody();
  const report = runCompressionPipeline(body, {
    steps: ["rtk", "cavemanText"],
    inputCaveman: true,
  });
  const marginalSum = report.steps.reduce((a, s) => a + s.marginalSaved, 0);
  assert.equal(marginalSum, report.totalSaved, "marginal-sum == total");
});

test("a no-op stage leaves the body deep-equal to its input", () => {
  // cavemanText disabled -> that step is a pure no-op.
  const body = { messages: [{ role: "user", content: "Refactor the AST walker to support nested nodes." }] };
  const snapshot = JSON.parse(JSON.stringify(body));
  const report = runCompressionPipeline(body, { steps: ["cavemanText"], inputCaveman: false });
  assert.deepEqual(body, snapshot, "body untouched");
  assert.equal(report.totalSaved, 0);
});

test("disabled input-caveman contributes zero marginal savings", () => {
  const body = openAiMixedBody();
  const report = runCompressionPipeline(body, {
    steps: ["rtk", "cavemanText"],
    inputCaveman: false,
  });
  const cm = report.steps.find((s) => s.name === "cavemanText");
  assert.equal(cm.marginalSaved, 0, "caveman off => no marginal savings");
});

test("idempotency: a second pipeline run yields no further reduction", () => {
  const body = geminiShellBody();
  runCompressionPipeline(body, { steps: ["rtk"] });
  const afterFirst = measureBodyBytes(body);
  const report2 = runCompressionPipeline(body, { steps: ["rtk"] });
  assert.equal(report2.totalSaved, 0, "no further savings");
  assert.equal(measureBodyBytes(body), afterFirst, "body stable");
});

test("a failing step is isolated and does not break the run", () => {
  const body = geminiShellBody();
  // An unknown step name returns null (no-op); the rtk step still runs.
  const report = runCompressionPipeline(body, { steps: ["rtk", "bogus_engine"] });
  assert.ok(report.totalSaved > 0, "rtk still reduced");
  const bogus = report.steps.find((s) => s.name === "bogus_engine");
  assert.equal(bogus.marginalSaved, 0);
});

test("totalAfter never exceeds totalBefore (never-grow at body level)", () => {
  const bodies = [geminiShellBody(), openAiMixedBody()];
  for (const body of bodies) {
    const report = runCompressionPipeline(body, { steps: ["rtk", "cavemanText"], inputCaveman: true });
    assert.ok(report.totalAfter <= report.totalBefore, "never grows");
    assert.ok(report.totalAfter > 0, "never empty");
  }
});
