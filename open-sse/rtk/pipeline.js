// Phase 2: stacked compression pipeline.
// Runs ordered engines over a single request body, threading the mutated body
// from one stage into the next, and accounts savings as MARGINAL reduction at
// each stage (bytes removed given the prior stage's output). This makes the
// per-engine marginal figures sum to total savings exactly, with no
// double-counting when two engines reduce overlapping content.
//
// Each step is reversible-by-construction: the underlying engines mutate in
// place only when they reduce, and fall back to the original text otherwise.

import { compressMessages } from "./index.js";
import { compressBodyText } from "./cavemanText.js";

// Measure the total byte size of the compressible text in a body. Used to
// compute marginal savings between stages. We sum the same leaves the engines
// touch (messages/input content + Gemini functionResponse string leaves) so
// the figure reflects what compression actually operates on.
function measureBodyBytes(body) {
  if (!body) return 0;
  let total = 0;

  const addText = (t) => { if (typeof t === "string") total += Buffer.byteLength(t, "utf8"); };

  const arr = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (arr) {
    for (const msg of arr) {
      if (!msg) continue;
      if (typeof msg.content === "string") addText(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p && typeof p.text === "string") addText(p.text);
          if (p && typeof p.content === "string") addText(p.content);
        }
      }
      if (typeof msg.output === "string") addText(msg.output);
    }
  }

  const buckets = [];
  if (Array.isArray(body.contents)) buckets.push(body.contents);
  if (Array.isArray(body.request?.contents)) buckets.push(body.request.contents);
  for (const contents of buckets) {
    for (const content of contents) {
      const parts = content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const resp = part?.functionResponse?.response;
        if (!resp || typeof resp !== "object") continue;
        const leaf = resp.result;
        if (typeof leaf === "string") addText(leaf);
        else if (leaf && typeof leaf === "object" && typeof leaf.result === "string") addText(leaf.result);
      }
    }
  }

  return total;
}

// Default pipeline: RTK tool-output compression first, then output-side caveman
// is handled separately (it only adds a system instruction, not a body
// rewrite), so the stack here covers RTK + optional input-side caveman text.
const DEFAULT_STEPS = ["rtk", "cavemanText"];

// Run one named engine against the body. Returns the engine's own stats (or
// null). Engines mutate `body` in place.
function runStep(name, body, cfg) {
  switch (name) {
    case "rtk":
      return compressMessages(body, true);
    case "cavemanText":
      // DEFAULT OFF: only runs when explicitly enabled in cfg.
      if (!cfg.inputCaveman) return null;
      return compressBodyText(body, true, cfg.cavemanOptions || {});
    default:
      return null;
  }
}

// Run the stacked pipeline. Returns a breakdown:
//   { totalBefore, totalAfter, totalSaved, steps: [{name, marginalSaved, stats}] }
// `marginalSaved` is measured by re-sizing the body before/after each step, so
// the marginal values sum to totalSaved exactly.
export function runCompressionPipeline(body, cfg = {}) {
  if (!body) return null;
  const steps = cfg.steps || DEFAULT_STEPS;

  const totalBefore = measureBodyBytes(body);
  let prev = totalBefore;
  const report = { totalBefore, totalAfter: totalBefore, totalSaved: 0, steps: [] };

  for (const name of steps) {
    let stats = null;
    try {
      stats = runStep(name, body, cfg);
    } catch (e) {
      // A failing engine must not break the request; record and move on.
      console.warn(`[RTK pipeline] step ${name} failed:`, e.message);
      report.steps.push({ name, marginalSaved: 0, stats: null, error: e.message });
      continue;
    }
    const now = measureBodyBytes(body);
    const marginalSaved = Math.max(0, prev - now);
    report.steps.push({ name, marginalSaved, stats });
    prev = now;
  }

  report.totalAfter = prev;
  report.totalSaved = Math.max(0, totalBefore - prev);
  return report;
}

// Format a single log line from a pipeline report.
export function formatPipelineLog(report) {
  if (!report || report.totalSaved <= 0) return null;
  const pct = report.totalBefore > 0
    ? ((report.totalSaved / report.totalBefore) * 100).toFixed(1)
    : "0";
  const parts = report.steps
    .filter((s) => s.marginalSaved > 0)
    .map((s) => `${s.name}:${s.marginalSaved}B`)
    .join(" ");
  return `[PIPELINE] saved ${report.totalSaved}B / ${report.totalBefore}B (${pct}%) [${parts}]`;
}

export const _internal = { measureBodyBytes, DEFAULT_STEPS };
