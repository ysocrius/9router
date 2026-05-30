// Phase 3 benchmark harness.
// Measures the two things that ARE deterministic offline:
//   1. Added latency per request (p50/p95) against the LOCKED budget.
//   2. Input-side byte reduction per mode (off / rtk / stacked / stacked+caveman).
//
// What it deliberately does NOT measure: the output-side Caveman levels
// (lite/full/ultra) and wenyan change the model's RESPONSE, whose benefit only
// appears after a live model round-trip. Those are reported via the wenyan-gate
// module, which consumes recorded responses when present. See wenyanGate.js.
//
// Run: node open-sse/rtk/bench/compression.bench.js
//      (exits non-zero if the latency budget is exceeded)

import { performance } from "node:perf_hooks";
import { runCompressionPipeline, _internal as pipelineInternal } from "../pipeline.js";
import { compressMessages } from "../index.js";
import { buildMixedBody, buildGeminiBody, TOOL_OUTPUTS } from "./corpus.js";

const { measureBodyBytes } = pipelineInternal;

// Locked latency budget (implementation_plan.md). The run FAILS above this.
export const LATENCY_BUDGET = { p95Ms: 10, p50Ms: 2 };
const WARMUP = 50;
const ITERATIONS = 500;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// Deep clone so each iteration starts from the same uncompressed body.
function clone(body) {
  return JSON.parse(JSON.stringify(body));
}

// Time a single mode over many iterations, returning latency stats + the
// reduction measured on one representative pass.
function timeMode(name, makeBody, runOnce) {
  // Reduction (measure once on a fresh body).
  const sampleBody = makeBody();
  const before = measureBodyBytes(sampleBody);
  runOnce(sampleBody);
  const after = measureBodyBytes(sampleBody);
  const reductionPct = before > 0 ? ((before - after) / before) * 100 : 0;

  // Warmup (let the JIT settle) — not recorded.
  for (let i = 0; i < WARMUP; i++) runOnce(makeBody());

  // Timed iterations.
  const samples = new Array(ITERATIONS);
  for (let i = 0; i < ITERATIONS; i++) {
    const body = makeBody();
    const t0 = performance.now();
    runOnce(body);
    samples[i] = performance.now() - t0;
  }
  samples.sort((a, b) => a - b);

  return {
    name,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    beforeBytes: before,
    afterBytes: after,
    reductionPct,
  };
}

export function runBenchmark() {
  const results = [];

  // Mode: off (baseline — no compression, pure measurement overhead).
  results.push(timeMode("off", () => buildMixedBody(), () => {}));

  // Mode: rtk only (tool-output compression on the OpenAI-shaped body).
  results.push(timeMode("rtk", () => buildMixedBody(), (body) => {
    compressMessages(body, true);
  }));

  // Mode: rtk on the Gemini-shaped body (the user's actual MITM traffic shape).
  results.push(timeMode("rtk-gemini", () => buildGeminiBody(), (body) => {
    compressMessages(body, true);
  }));

  // Mode: stacked (rtk -> cavemanText, but caveman OFF == rtk-equivalent).
  results.push(timeMode("stacked", () => buildMixedBody(), (body) => {
    runCompressionPipeline(body, { steps: ["rtk", "cavemanText"], inputCaveman: false });
  }));

  // Mode: stacked + input-side caveman (the maximal input-side pipeline).
  results.push(timeMode("stacked+caveman", () => buildMixedBody(), (body) => {
    runCompressionPipeline(body, {
      steps: ["rtk", "cavemanText"],
      inputCaveman: true,
      cavemanOptions: { intensity: "full" },
    });
  }));

  return results;
}

function fmt(n) {
  return n.toFixed(3).padStart(8);
}

function printReport(results) {
  console.log("\n=== RTK Compression Benchmark ===");
  console.log(`corpus: ${TOOL_OUTPUTS.length} tool outputs + verbose prompts | iters=${ITERATIONS}\n`);
  console.log("mode               p50(ms)  p95(ms) mean(ms)   reduction");
  console.log("-----------------------------------------------------------");
  for (const r of results) {
    const red = r.name === "off" ? "    n/a" : `${r.reductionPct.toFixed(1)}%`.padStart(8);
    console.log(
      `${r.name.padEnd(16)} ${fmt(r.p50)} ${fmt(r.p95)} ${fmt(r.mean)}  ${red}`
    );
  }
  console.log("-----------------------------------------------------------");
}

// Enforce the locked budget against the heaviest real mode (stacked+caveman),
// which is the worst case a request can incur.
function enforceBudget(results) {
  const heavy = results.find((r) => r.name === "stacked+caveman");
  const failures = [];
  if (heavy.p95 > LATENCY_BUDGET.p95Ms) {
    failures.push(`p95 ${heavy.p95.toFixed(2)}ms > ${LATENCY_BUDGET.p95Ms}ms`);
  }
  if (heavy.p50 > LATENCY_BUDGET.p50Ms) {
    failures.push(`p50 ${heavy.p50.toFixed(2)}ms > ${LATENCY_BUDGET.p50Ms}ms`);
  }
  return failures;
}

// Run directly (ESM "main" check).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("compression.bench.js")) {
  const results = runBenchmark();
  printReport(results);
  const failures = enforceBudget(results);
  if (failures.length > 0) {
    console.error(`\nLATENCY BUDGET EXCEEDED: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log(`\nLatency budget OK (p95 <= ${LATENCY_BUDGET.p95Ms}ms, p50 <= ${LATENCY_BUDGET.p50Ms}ms).\n`);
}
