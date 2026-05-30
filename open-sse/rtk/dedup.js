// Line-run deduplication (JS port of OmniRoute engines-rtk/deduplicator.ts).
//
// Collapses runs of >= threshold identical consecutive lines into the first
// occurrence plus two marker lines. Pure, single-pass, content-agnostic — safe
// to run on any text leaf (it never parses or reserializes structure).
//
// This is a content-agnostic *reduction pass*, not a shell filter, so it is NOT
// gated by commandDetector — it runs on the safe path for any plain-text leaf.
import { DEDUP_RUN_THRESHOLD } from "./constants.js";

/**
 * Collapse runs of identical consecutive lines.
 * @param {string} text
 * @param {number} [threshold] minimum run length to collapse (>= 2)
 * @returns {{ text: string, collapsed: number }}
 */
export function deduplicateRepeatedLines(text, threshold = DEDUP_RUN_THRESHOLD) {
  if (typeof text !== "string" || text.length === 0) {
    return { text: typeof text === "string" ? text : "", collapsed: 0 };
  }

  const minRun = Math.max(2, Math.floor(threshold));
  const lines = text.split(/\r?\n/);
  const output = [];
  let collapsed = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let runLength = 1;
    while (index + runLength < lines.length && lines[index + runLength] === line) {
      runLength++;
    }

    // Only collapse non-blank lines (blank runs are cheap and meaningful as spacing).
    if (line.trim() && runLength >= minRun) {
      output.push(line);
      output.push(`[line repeated ${runLength - 1}x]`);
      output.push(`[rtk:dropped ${runLength - 1} repeated lines]`);
      collapsed += runLength - 1;
      index += runLength - 1;
      continue;
    }

    output.push(line);
  }

  return { text: output.join("\n"), collapsed };
}
