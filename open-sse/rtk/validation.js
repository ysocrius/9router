// Input-side Caveman: post-rewrite validation.
// This is the second half of the no-risk contract. Preservation lifts
// structure out before rules run; validation is the backstop that confirms the
// restored output still contains every protected token the original had. If a
// rewrite altered or dropped any protected token, the change is rejected and
// the caller falls back to the original text. Validation never mutates text.

// Extract the set of must-survive tokens from a piece of text. These mirror the
// preservation patterns but are compared as a multiset of literal strings, so a
// token that was reordered, edited, or dropped is caught even if preservation
// somehow missed it.
const TOKEN_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /\bhttps?:\/\/[^\s)<>"']+/gi,
  /\b[A-Za-z]:\\[^\s"'<>|]+/g,
  /(?:\.{1,2}\/|\/)[A-Za-z0-9_@./-]+/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
  /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b/g,
  /\$[A-Za-z_][A-Za-z0-9_]*\b/g,
  /\b\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?\b/g,
  /\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\(?\)?/g,
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|Error|Exception):[^\n]*/g,
];

function collectTokens(text) {
  const counts = new Map();
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const tok = m[0];
      counts.set(tok, (counts.get(tok) || 0) + 1);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return counts;
}

// Validate that `compressed` preserved every protected token from `original`.
// Returns { valid, errors, warnings }. A single missing/reduced token fails.
export function validateCompression(original, compressed) {
  const errors = [];
  const warnings = [];

  if (typeof compressed !== "string") {
    return { valid: false, errors: ["compressed output is not a string"], warnings };
  }
  // Never-empty: an originally non-empty message must not vanish.
  if (original.trim().length > 0 && compressed.trim().length === 0) {
    return { valid: false, errors: ["compressed output is empty"], warnings };
  }
  // Never-grow (byte length): a prose-reduction pass that grows is suspicious.
  if (Buffer.byteLength(compressed, "utf8") > Buffer.byteLength(original, "utf8")) {
    return { valid: false, errors: ["compressed output larger than original"], warnings };
  }

  const before = collectTokens(original);
  const after = collectTokens(compressed);
  for (const [tok, n] of before) {
    const m = after.get(tok) || 0;
    if (m < n) {
      errors.push(`protected token altered or dropped: ${truncate(tok)} (${n}->${m})`);
    }
  }

  // Leftover placeholder sentinels mean restoration failed — hard fail.
  if (/[\uE000\uE001]/.test(compressed)) {
    errors.push("unrestored preservation placeholder remained");
  }

  return { valid: errors.length === 0, errors, warnings };
}

function truncate(s) {
  return s.length > 40 ? s.slice(0, 37) + "..." : s;
}

export const _internal = { collectTokens, TOKEN_PATTERNS };
