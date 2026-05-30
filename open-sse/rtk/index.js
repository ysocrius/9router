// RTK port: compress tool_result content in LLM request bodies
// Injected at the top of translateRequest (before any format translation)
import { RAW_CAP, MIN_COMPRESS_SIZE } from "./constants.js";
import { autoDetectFilter } from "./autodetect.js";
import { safeApply } from "./applyFilter.js";
import { deduplicateRepeatedLines } from "./dedup.js";
import { smartTruncate } from "./filters/smartTruncate.js";
import { categorizeToolName } from "./commandDetector.js";
import { DecisionLog, isEnabled as decisionLogEnabled, SKIP } from "./decisionLog.js";

// Compress tool_result content in-place. Returns stats or null if disabled/failed.
export function compressMessages(body, enabled) {
  if (!enabled) return null;
  if (!body) return null;

  // Kiro format: conversationState.history + conversationState.currentMessage
  if (body.conversationState) {
    return compressKiroFormat(body, enabled);
  }

  // Gemini format: contents[] (native) or request.contents[] (Gemini-CLI/Antigravity envelope).
  // This is the shape dispatched on native Gemini/Vertex targets and on Antigravity
  // MITM passthrough — previously skipped entirely, so RTK was a no-op there.
  if (Array.isArray(body.contents) || Array.isArray(body.request?.contents)) {
    return compressGeminiFormat(body, enabled);
  }

  // Support both OpenAI/Claude "messages" and OpenAI Responses "input"
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!items) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    for (let i = 0; i < items.length; i++) {
      const msg = items[i];
      if (!msg) continue;

      // Shape 4: OpenAI Responses — top-level { type:"function_call_output", output: string | [{type:"input_text", text}] }
      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = compressText(msg.output, stats, "openai-responses-string");
        } else if (Array.isArray(msg.output)) {
          for (let k = 0; k < msg.output.length; k++) {
            const part = msg.output[k];
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "openai-responses-array");
            }
          }
        }
        continue;
      }

      // Shape 1: OpenAI tool message — { role:"tool", content: "string" }
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = compressText(msg.content, stats, "openai-tool");
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      // Shape 1b: OpenAI tool message — { role:"tool", content:[{type:"text", text:"..."}] }
      if (msg.role === "tool") {
        for (let k = 0; k < msg.content.length; k++) {
          const part = msg.content[k];
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "openai-tool-array");
          }
        }
        continue;
      }

      // Shape 2/3: blocks array with tool_result entries
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (!block || block.type !== "tool_result") continue;
        if (block.is_error === true) continue; // preserve error traces

        if (typeof block.content === "string") {
          // Shape 2: claude string form
          block.content = compressText(block.content, stats, "claude-string");
        } else if (Array.isArray(block.content)) {
          // Shape 3: claude array form — compress each text part
          for (let k = 0; k < block.content.length; k++) {
            const part = block.content[k];
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = compressText(part.text, stats, "claude-array");
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressMessages error:", e.message);
    return null;
  }
  return stats;
}

// Compress Kiro format: conversationState.history[].userInputMessage.userInputMessageContext.toolResults[].content[].text
function compressKiroFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  try {
    const state = body.conversationState;
    const allMessages = [...(Array.isArray(state?.history) ? state.history : [])];
    if (state?.currentMessage) allMessages.push(state.currentMessage);

    for (const msg of allMessages) {
      const toolResults = msg?.userInputMessage?.userInputMessageContext?.toolResults;
      if (!Array.isArray(toolResults)) continue;

      for (const tr of toolResults) {
        if (tr.status === "error") continue; // preserve error traces
        if (!Array.isArray(tr.content)) continue;

        for (const part of tr.content) {
          if (part && typeof part.text === "string") {
            part.text = compressText(part.text, stats, "kiro-tool-result");
          }
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressKiroFormat error:", e.message);
    return null;
  }
  return stats;
}

// Compress Gemini format: contents[].parts[].functionResponse.response leaf.
// Handles native Gemini/Vertex (body.contents) and the Gemini-CLI/Antigravity
// envelope (body.request.contents). This is the only branch that turns RTK on
// for Antigravity MITM passthrough traffic, where the body stays Gemini-shaped.
function compressGeminiFormat(body, enabled) {
  const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
  const decision = decisionLogEnabled()
    ? new DecisionLog({ mode: "rtk", format: "gemini" })
    : null;
  try {
    const buckets = [];
    if (Array.isArray(body.contents)) buckets.push(body.contents);
    if (Array.isArray(body.request?.contents)) buckets.push(body.request.contents);

    for (const contents of buckets) {
      for (const content of contents) {
        const parts = content?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          const fr = part?.functionResponse;
          if (fr) compressGeminiFunctionResponse(fr, stats, decision);
        }
      }
    }
  } catch (e) {
    console.warn("[RTK] compressGeminiFormat error:", e.message);
    return null;
  }
  if (decision) decision.emit();
  return stats;
}

// Locate the string leaf among the two known Gemini paths:
//   OpenAI→Gemini:        response.result.result
//   Claude→Antigravity:   response.result
// Returns { obj, key } so the caller can read and write the value in place.
// No arbitrary-depth recursion — only these two paths are inspected (Phase 1).
function locateGeminiLeaf(resp) {
  if (!resp || typeof resp !== "object" || !("result" in resp)) return null;
  const result = resp.result;
  if (result && typeof result === "object" && !Array.isArray(result) && "result" in result) {
    return { obj: result, key: "result" }; // deeper path first
  }
  return { obj: resp, key: "result" };
}

// Cheap JSON-string check: a string whose first non-space char is { or [ AND
// that JSON.parse accepts is treated as structured data (line filters would
// corrupt it invisibly), so it is skipped.
function isJsonString(s) {
  const t = s.trim();
  if (t.length === 0) return false;
  const c = t[0];
  if (c !== "{" && c !== "[") return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

// Apply the locked string-detection logic to one functionResponse.
function compressGeminiFunctionResponse(fr, stats, decision) {
  const toolName = typeof fr.name === "string" ? fr.name : null;
  const resp = fr.response;
  if (!resp || typeof resp !== "object") return;

  // Error guard (parity with is_error / status==="error").
  if (resp.error != null || resp.status === "error" || resp.is_error === true) {
    if (decision) decision.addOutput({ shape: "gemini-fnresp", tool: toolName, skipped: SKIP.ERROR_PAYLOAD });
    return;
  }

  const target = locateGeminiLeaf(resp);
  if (!target) {
    if (decision) decision.addOutput({ shape: "gemini-fnresp", tool: toolName, skipped: SKIP.UNKNOWN_SHAPE });
    return;
  }

  const value = target.obj[target.key];
  // Case 1 — not a string (already-parsed object/array): skip.
  if (typeof value !== "string") {
    if (decision) decision.addOutput({ shape: "gemini-fnresp", tool: toolName, skipped: SKIP.STRUCTURED_OBJECT });
    return;
  }
  // Case 2 — string that is valid JSON: skip.
  if (isJsonString(value)) {
    if (decision) decision.addOutput({ shape: "gemini-fnresp", tool: toolName, inputBytes: value.length, outputBytes: value.length, skipped: SKIP.JSON_STRING });
    return;
  }
  // Case 3 — free-form text: compress (gated by tool name; logs its own entry).
  target.obj[target.key] = compressText(value, stats, "gemini-fnresp", { toolName, decision });
}

// Record a per-tool-output entry into the decision log, if one is active.
function recordOutput(decision, entry) {
  if (decision) decision.addOutput(entry);
}

// Compress one text leaf. Returns the (possibly) reduced string.
//
// opts (optional, used by the Gemini branch):
//   - toolName: gate shell filters by tool category (shell-eligible only).
//   - decision: DecisionLog to record this output's outcome.
// When opts is omitted (OpenAI/Claude/Kiro branches), behavior is unchanged
// except the new content-agnostic reduction passes, which are fully guarded.
function compressText(text, stats, shape, opts = {}) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;

  const decision = opts.decision || null;
  const toolName = opts.toolName;
  const hasGate = typeof toolName === "string" && toolName.length > 0;
  const category = hasGate ? categorizeToolName(toolName) : null;
  // Legacy branches (no tool name) stay ungated: shell filter runs as before.
  const shellEligible = hasGate ? category === "shell" : true;

  // Size guards (unchanged thresholds).
  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    recordOutput(decision, {
      shape, tool: toolName, category, inputBytes: bytesIn, outputBytes: bytesIn,
      skipped: bytesIn < MIN_COMPRESS_SIZE ? SKIP.TOO_SMALL : SKIP.TOO_LARGE,
    });
    return text;
  }

  let current = text;
  let filterName = null;
  const engines = [];

  // Stage 1 — shell filter (gated). Only runs on shell-eligible outputs, so a
  // read_file/grep/edit result is never matched by a build/git filter.
  if (shellEligible) {
    const fn = autoDetectFilter(current);
    if (fn) {
      const out = safeApply(fn, current);
      if (out && out.length > 0 && out.length < current.length) {
        current = out;
        filterName = fn.filterName || fn.name;
        engines.push("rtk");
      }
    }
  }

  // Stage 2 — dedup repeated lines (content-agnostic, safe on any text leaf).
  const deduped = deduplicateRepeatedLines(current).text;
  if (deduped && deduped.length > 0 && deduped.length < current.length) {
    current = deduped;
    engines.push("dedup");
  }

  // Stage 3 — smart-truncate (head+tail window; only fires on very long output).
  const truncated = smartTruncate(current);
  if (truncated && truncated.length > 0 && truncated.length < current.length) {
    current = truncated;
    engines.push("smart-truncate");
  }

  // Final safety: never empty, never grow vs. the original input.
  if (!current || current.length === 0 || current.length >= bytesIn) {
    stats.bytesAfter += bytesIn;
    let skipped;
    if (!current || current.length === 0) skipped = SKIP.EMPTY_RESULT;
    else if (hasGate && category === "unknown") skipped = SKIP.UNKNOWN_TOOL;
    else if (hasGate && category !== "shell") skipped = SKIP.STRUCTURED_TOOL;
    else skipped = filterName ? SKIP.GREW : SKIP.NO_FILTER;
    recordOutput(decision, {
      shape, tool: toolName, category, inputBytes: bytesIn, outputBytes: bytesIn,
      filter: filterName || "none", skipped,
    });
    return text;
  }

  stats.bytesAfter += current.length;
  const filterLabel = filterName || (engines.length ? engines.join("+") : "reduce");
  stats.hits.push({ shape, filter: filterLabel, saved: bytesIn - current.length });
  recordOutput(decision, {
    shape, tool: toolName, category, inputBytes: bytesIn, outputBytes: current.length,
    filter: filterLabel, engines, skipped: null,
  });
  return current;
}

// Convenience: format a log line from stats
export function formatRtkLog(stats) {
  if (!stats || !stats.hits || stats.hits.length === 0) return null;
  const saved = stats.bytesBefore - stats.bytesAfter;
  const pct = stats.bytesBefore > 0 ? ((saved / stats.bytesBefore) * 100).toFixed(1) : "0";
  const filters = Array.from(new Set(stats.hits.map(h => h.filter))).join(",");
  return `[RTK] saved ${saved}B / ${stats.bytesBefore}B (${pct}%) via [${filters}] hits=${stats.hits.length}`;
}
