// Structured decision log for RTK (ships in Phase 1, not deferred).
//
// In a MITM proxy, compression failures are silent and dangerous: a mangled tool
// output surfaces later as a confused model reply, with no obvious cause. This
// module emits ONE structured record per request, carrying request-level rollups
// plus a per-tool-output `outputs[]` array so resolution is never lost to a
// flattened summary.
//
// Hot-path discipline: when logging is disabled, no record object is ever built.
// The caller checks `isEnabled()` before constructing a DecisionLog.

import { RTK_DECISION_LOG } from "./constants.js";

// Skip reasons (closed set — keep in sync with tests).
export const SKIP = {
  ERROR_PAYLOAD: "error-payload",       // is_error / status==="error"
  STRUCTURED_OBJECT: "structured-object", // leaf is object/array, not a string
  JSON_STRING: "json-string",           // string that parses as JSON
  GREW: "grew",                         // filtered output >= input
  EMPTY_RESULT: "empty-result",         // filter produced empty output
  UNKNOWN_TOOL: "unknown-tool",         // tool name not in allow-list
  UNKNOWN_SHAPE: "unknown-shape",       // no known leaf path found
  STRUCTURED_TOOL: "structured-tool",   // read/search/edit/list output left byte-identical
  TOO_SMALL: "too-small",               // below MIN_COMPRESS_SIZE
  TOO_LARGE: "too-large",               // above RAW_CAP
  NO_FILTER: "no-filter",               // autodetect returned null
};

/**
 * @returns {boolean} whether decision logging is active.
 */
export function isEnabled() {
  return RTK_DECISION_LOG === true;
}

/**
 * One record per request. Construct only when isEnabled() is true.
 */
export class DecisionLog {
  /**
   * @param {object} meta { mode, format, provider, model }
   */
  constructor(meta = {}) {
    this.mode = meta.mode || "rtk";
    this.format = meta.format || null;
    this.provider = meta.provider || null;
    this.model = meta.model || null;
    this.engines = [];        // engines that fired, e.g. ["rtk","dedup"]
    this.inputBytes = 0;
    this.outputBytes = 0;
    /** @type {Array<object>} per-tool-output detail */
    this.outputs = [];
  }

  /** Record that an engine fired at least once this request. */
  markEngine(name) {
    if (name && !this.engines.includes(name)) this.engines.push(name);
  }

  /**
   * Record a single tool output's outcome.
   * @param {object} entry {
   *   shape, tool, inputBytes, outputBytes, filter, skipped, engines
   * }
   */
  addOutput(entry) {
    const inB = entry.inputBytes || 0;
    const outB = (entry.outputBytes != null) ? entry.outputBytes : inB;
    this.inputBytes += inB;
    this.outputBytes += outB;
    this.outputs.push({
      shape: entry.shape || null,
      tool: entry.tool || null,
      category: entry.category || null,
      inputBytes: inB,
      outputBytes: outB,
      pct: pct(inB, outB),
      filter: entry.filter || "none",
      skipped: entry.skipped || null,
      engines: entry.engines || [],
    });
  }

  /** Build the plain object record (call once, at emit time). */
  toRecord() {
    return {
      tag: "RTK_DECISION",
      mode: this.mode,
      format: this.format,
      provider: this.provider,
      model: this.model,
      engines: this.engines,
      inputBytes: this.inputBytes,
      outputBytes: this.outputBytes,
      pct: pct(this.inputBytes, this.outputBytes),
      count: this.outputs.length,
      outputs: this.outputs,
    };
  }

  /** Emit at debug level via the provided logger (falls back to console.debug). */
  emit(log) {
    if (this.outputs.length === 0) return;
    const record = this.toRecord();
    const line = JSON.stringify(record);
    if (log && typeof log.debug === "function") log.debug("RTK_DECISION", line);
    else console.debug(line);
  }
}

/** Percent reduction, one decimal, guarded against divide-by-zero. */
function pct(inB, outB) {
  if (!inB || inB <= 0) return 0;
  return Number((((inB - outB) / inB) * 100).toFixed(1));
}
