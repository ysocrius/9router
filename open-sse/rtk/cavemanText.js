// Input-side Caveman: per-message text rewrite (DEFAULT OFF).
// Ties the no-risk chain together for one string:
//   preserve protected blocks -> apply rules -> cleanup artifacts ->
//   restore blocks -> validate -> fall back to original on ANY failure.
// Nothing here ever throws to the caller; a failure returns the input verbatim.

import {
  extractPreservedBlocks,
  restorePreservedBlocks,
  hasProtectedStructure,
  compileUserPatterns,
} from "./preservation.js";
import { validateCompression } from "./validation.js";
import { getRulesForContext, shouldAttemptRule } from "./cavemanRules.js";

const MIN_MESSAGE_LENGTH = 80; // skip short prose; not worth the risk/cost
const DEFAULT_ROLES = ["user"]; // only rewrite user prose by default

// Apply the gated rule set to a single (already structure-stripped) string.
function applyRules(text, rules) {
  let result = text;
  const lower = text.toLowerCase();
  const applied = [];
  for (const rule of rules) {
    if (!shouldAttemptRule(rule.name, lower)) continue;
    const before = result;
    result = result.replace(rule.pattern, rule.replacement);
    if (result !== before) applied.push(rule.name);
  }
  return { text: result, applied };
}

// Collapse the whitespace/punctuation artifacts that rule deletions leave
// behind (double spaces, space-before-comma, orphaned blank lines). Conservative
// on purpose: only touches horizontal whitespace and runs of blank lines.
function cleanupArtifacts(text) {
  return text
    .replace(/[ \t]{2,}/g, " ")          // collapse horizontal runs
    .replace(/[ \t]+([,.;:!?])/g, "$1")  // space before punctuation
    .replace(/([,;:])\1+/g, "$1")        // doubled separators from deletions
    .replace(/[ \t]+\n/g, "\n")          // trailing horizontal ws
    .replace(/\n{3,}/g, "\n\n")          // excess blank lines
    .replace(/^[ \t\n]+/, "")            // leading ws
    .replace(/[ \t]+$/, "");             // trailing horizontal ws at very end
}

// Rewrite one string. Returns { text, changed, applied, fallback }.
export function compressTextMessage(text, opts = {}) {
  const out = { text, changed: false, applied: [], fallback: false };
  if (typeof text !== "string" || text.length < (opts.minMessageLength ?? MIN_MESSAGE_LENGTH)) {
    return out;
  }

  try {
    const user = compileUserPatterns(opts.preservePatterns);
    const shouldPreserve = user.compiled.length > 0 || hasProtectedStructure(text);
    const { text: stripped, blocks } = shouldPreserve
      ? extractPreservedBlocks(text, { preservePatterns: user.compiled })
      : { text, blocks: [] };

    const rules = getRulesForContext(opts.intensity ?? "full");
    const { text: ruled, applied } = applyRules(stripped, rules);

    // No rule fired -> nothing to do, return original untouched (no risk).
    if (applied.length === 0) return out;

    const cleaned = cleanupArtifacts(ruled);
    const restored = blocks.length > 0 ? restorePreservedBlocks(cleaned, blocks) : cleaned;
    const finalText = cleanupArtifacts(restored);

    // Validate against the ORIGINAL. Any protected-token loss -> fall back.
    const v = validateCompression(text, finalText);
    if (!v.valid) {
      out.fallback = true;
      return out; // original text, unchanged
    }
    // Never-grow guard (validation already checks bytes, but be explicit).
    if (finalText.length >= text.length) return out;

    out.text = finalText;
    out.changed = true;
    out.applied = applied;
    return out;
  } catch {
    out.fallback = true;
    return out; // any unexpected error -> original text
  }
}

// Rewrite the prose messages of a request body in place. DEFAULT OFF: the
// caller must pass enabled=true. Returns a small stats object or null.
export function compressBodyText(body, enabled, opts = {}) {
  if (!enabled || !body) return null;
  const roles = opts.roles ?? DEFAULT_ROLES;
  const arr = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!arr) return null;

  const stats = { bytesBefore: 0, bytesAfter: 0, changed: 0, fallbacks: 0, applied: [] };
  for (const msg of arr) {
    if (!msg || !roles.includes(msg.role)) continue;

    if (typeof msg.content === "string") {
      const r = rewriteAndAccount(msg.content, stats, opts);
      msg.content = r;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && (part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
          part.text = rewriteAndAccount(part.text, stats, opts);
        }
      }
    }
  }
  return stats;
}

function rewriteAndAccount(text, stats, opts) {
  stats.bytesBefore += text.length;
  const r = compressTextMessage(text, opts);
  stats.bytesAfter += r.text.length;
  if (r.changed) {
    stats.changed += 1;
    for (const a of r.applied) if (!stats.applied.includes(a)) stats.applied.push(a);
  }
  if (r.fallback) stats.fallbacks += 1;
  return r.text;
}

export const _internal = { applyRules, cleanupArtifacts };
