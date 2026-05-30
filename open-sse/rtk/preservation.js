// Input-side Caveman: protected-block extraction and restoration.
// Port of OmniRoute's preservation step. The whole point of this module is
// "no risk": anything that must survive a prose rewrite byte-for-byte (code,
// paths, URLs, identifiers, error lines) is lifted out into placeholders
// BEFORE rules run, then restored AFTER. Caveman rules therefore only ever
// touch free-form prose, never structure.

// Private-use sentinels. These never appear in real text, contain no spaces or
// word characters, so no caveman rule or whitespace-cleanup pass can match
// them. Format: <OPEN><index><CLOSE>.
const PH_OPEN = "\uE000";
const PH_CLOSE = "\uE001";

// Ordered most-specific-first. Earlier patterns claim their spans before later
// ones get a chance, so a URL inside a code fence is preserved as part of the
// fence, not split.
const PRESERVE_PATTERNS = [
  /```[\s\S]*?```/g,                                   // fenced code blocks
  /~~~[\s\S]*?~~~/g,                                   // alt fenced code blocks
  /`[^`\n]+`/g,                                        // inline code spans
  /\bhttps?:\/\/[^\s)<>"']+/gi,                         // URLs
  /\b[A-Za-z]:\\[^\s"'<>|]+/g,                          // windows abs paths
  /(?:^|[\s(])(?:\.{1,2}\/|\/)[A-Za-z0-9_@./-]+/g,      // posix / relative paths
  /\b[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,9}\b(?=[\s:)\]]|$)/g, // file.ext tokens
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,                // CONST_CASE identifiers
  /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b/g,         // process.env.X
  /\$[A-Za-z_][A-Za-z0-9_]*\b/g,                       // $ENV vars
  /\b\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?\b/g,     // version / semver numbers
  /\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\(?\)?/g,  // dotted.member.calls()
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|Error|Exception):[^\n]*/g, // error lines
];

// A cheap prefilter: if none of these characters are present, nothing above can
// match, so we skip the (more expensive) pattern loop entirely.
const PREFILTER_RE = /[`~\[\]$#\\/:_().]|https?:|\d/i;

export function hasProtectedStructure(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  PREFILTER_RE.lastIndex = 0;
  return PREFILTER_RE.test(text);
}

// Compile user-supplied preserve patterns; invalid regexes are skipped with a
// warning rather than throwing (a bad config must never break the request).
export function compileUserPatterns(patterns) {
  const compiled = [];
  const warnings = [];
  for (const p of patterns || []) {
    try {
      compiled.push(new RegExp(p, "g"));
    } catch (e) {
      warnings.push(`invalid preserve pattern ignored: ${p} (${e.message})`);
    }
  }
  return { compiled, warnings };
}

// Collect [start, end) spans matched by any pattern, then drop spans that
// overlap an earlier (already-claimed) span. Returns sorted, non-overlapping.
function collectSpans(text, patterns) {
  const spans = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // Some patterns intentionally include a leading separator char; trim it
      // back to the first structural char so the placeholder is tight.
      let start = m.index;
      const raw = m[0];
      const lead = raw.match(/^[\s(]/);
      if (lead) start += lead[0].length;
      const end = m.index + raw.length;
      if (end > start) spans.push([start, end]);
      if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const kept = [];
  let lastEnd = -1;
  for (const [s, e] of spans) {
    if (s >= lastEnd) {
      kept.push([s, e]);
      lastEnd = e;
    }
  }
  return kept;
}

// Replace every protected span with a placeholder. Returns the lifted text and
// a blocks[] array mapping placeholder index -> original substring.
export function extractPreservedBlocks(text, opts = {}) {
  const patterns = PRESERVE_PATTERNS.concat(opts.preservePatterns || []);
  const spans = collectSpans(text, patterns);
  if (spans.length === 0) return { text, blocks: [] };

  const blocks = [];
  let out = "";
  let cursor = 0;
  for (const [s, e] of spans) {
    out += text.slice(cursor, s);
    const idx = blocks.length;
    blocks.push(text.slice(s, e));
    out += `${PH_OPEN}${idx}${PH_CLOSE}`;
    cursor = e;
  }
  out += text.slice(cursor);
  return { text: out, blocks };
}

// Restore placeholders to their original substrings. Unmatched placeholders
// (should never happen) are left as-is and surface as a validation failure.
export function restorePreservedBlocks(text, blocks) {
  if (!blocks || blocks.length === 0) return text;
  return text.replace(
    new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"),
    (whole, n) => {
      const i = Number(n);
      return i >= 0 && i < blocks.length ? blocks[i] : whole;
    }
  );
}

export const _internal = { PH_OPEN, PH_CLOSE, collectSpans, PRESERVE_PATTERNS };
