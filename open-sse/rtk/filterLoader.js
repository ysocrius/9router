// Phase 3 — lazy JSON filter pack loader + applicator.
// Packs are loaded from disk only on first use (cold-start stays fast), then
// cached. The 10 hand-written filters remain the fast path; this is the second
// tier consulted only when no fast-path filter claimed the output.

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePack, packMatches } from "./filterSchema.js";

const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "filterPacks");

// Cache state. `loaded` flips true after the first scan so we never hit disk
// twice. `invokeCount` is exposed for tests asserting lazy behavior.
let _packs = null;          // validated pack[] once loaded
let _loaded = false;
let _invokeCount = 0;

// Load + validate every pack in the directory. Malformed packs are skipped
// with a warning; a bad pack never blocks the good ones or the fast path.
export async function loadPacks({ force = false } = {}) {
  if (_loaded && !force) return _packs;
  _invokeCount += 1;
  const out = [];
  try {
    const entries = await readdir(PACKS_DIR);
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(PACKS_DIR, file), "utf8");
        const parsed = JSON.parse(raw);
        const { valid, errors, pack } = validatePack(parsed);
        if (valid) out.push(pack);
        else console.warn(`[RTK packs] rejected ${file}: ${errors.join("; ")}`);
      } catch (e) {
        console.warn(`[RTK packs] failed to read ${file}: ${e.message}`);
      }
    }
  } catch {
    // No packs directory -> no packs. Fast path is unaffected.
  }
  _packs = out;
  _loaded = true;
  return _packs;
}

// Find the first loaded pack matching this command/text, or null.
export async function findMatchingPack(ctx) {
  const packs = await loadPacks();
  for (const pack of packs) {
    if (packMatches(pack, ctx)) return pack;
  }
  return null;
}

// Apply a validated pack to text. Pure: returns the transformed string.
// Replace rules rewrite in place; dropMatching rules delete whole lines.
export function applyPack(pack, text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let result = text;

  for (const rule of pack.rules) {
    try {
      if (typeof rule.dropMatching === "string") {
        const re = new RegExp(rule.dropMatching, rule.flags || "");
        result = result
          .split("\n")
          .filter((line) => { re.lastIndex = 0; return !re.test(line); })
          .join("\n");
      } else {
        const re = new RegExp(rule.pattern, rule.flags || "");
        result = result.replace(re, rule.replacement);
      }
    } catch {
      // A rule that throws at apply time is skipped; never corrupt the output.
      continue;
    }
  }

  // Optional line cap (head + tail window, mirrors smart-truncate intent).
  if (typeof pack.maxLines === "number" && pack.maxLines > 0) {
    const lines = result.split("\n");
    if (lines.length > pack.maxLines) {
      const head = Math.ceil(pack.maxLines * 0.7);
      const tail = pack.maxLines - head;
      const dropped = lines.length - pack.maxLines;
      result = [
        ...lines.slice(0, head),
        `[rtk:pack ${pack.name} dropped ${dropped} lines]`,
        ...lines.slice(lines.length - tail),
      ].join("\n");
    }
  }

  return result;
}

// Test/maintenance helpers.
export function _resetCache() {
  _packs = null;
  _loaded = false;
  _invokeCount = 0;
}
export function _getInvokeCount() {
  return _invokeCount;
}
