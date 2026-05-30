// Phase 3 — JSON filter pack schema + validation.
// Filter packs are declarative, lazy-loaded JSON describing line-level rewrite
// rules for a specific command family (docker, kubectl, pytest, ...). They are
// the SECOND tier: the 10 hand-written filters remain the fast path. A pack
// must validate fully before it is ever applied — a malformed pack is rejected
// at load and never touches request bodies.

// Shape (validated below):
// {
//   "name": "docker",                       // unique pack id
//   "match": {                              // when this pack is eligible
//     "commandPrefixes": ["docker"],        // command string starts-with (any)
//     "keywords": ["CONTAINER ID"]          // OR output contains (any)
//   },
//   "maxLines": 200,                        // optional output line cap
//   "rules": [
//     { "pattern": "^\\s+$", "flags": "gm", "replacement": "" },
//     { "dropMatching": "^DEBUG:", "flags": "m" }   // drop whole matching lines
//   ]
// }

const ALLOWED_FLAGS = /^[gimsuy]*$/;

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// Validate one rule. Returns an error string or null.
function validateRule(rule, i) {
  if (!rule || typeof rule !== "object") return `rule[${i}] is not an object`;

  const hasReplace = typeof rule.pattern === "string";
  const hasDrop = typeof rule.dropMatching === "string";
  if (hasReplace === hasDrop) {
    return `rule[${i}] must have exactly one of "pattern"+"replacement" or "dropMatching"`;
  }
  if (rule.flags != null && (typeof rule.flags !== "string" || !ALLOWED_FLAGS.test(rule.flags))) {
    return `rule[${i}] has invalid flags`;
  }
  if (hasReplace && typeof rule.replacement !== "string") {
    return `rule[${i}] "replacement" must be a string`;
  }

  // The regex must compile. A bad regex rejects the whole pack.
  const src = hasReplace ? rule.pattern : rule.dropMatching;
  try {
    // eslint-disable-next-line no-new
    new RegExp(src, rule.flags || "");
  } catch (e) {
    return `rule[${i}] regex does not compile: ${e.message}`;
  }
  return null;
}

// Validate a parsed pack object. Returns { valid, errors, pack }.
export function validatePack(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") {
    return { valid: false, errors: ["pack is not an object"], pack: null };
  }
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    errors.push('pack "name" must be a non-empty string');
  }
  const match = obj.match;
  if (!match || typeof match !== "object") {
    errors.push('pack "match" object is required');
  } else {
    const hasPrefixes = match.commandPrefixes != null;
    const hasKeywords = match.keywords != null;
    if (!hasPrefixes && !hasKeywords) {
      errors.push('pack "match" must declare commandPrefixes and/or keywords');
    }
    if (hasPrefixes && !isStringArray(match.commandPrefixes)) {
      errors.push('"match.commandPrefixes" must be a string array');
    }
    if (hasKeywords && !isStringArray(match.keywords)) {
      errors.push('"match.keywords" must be a string array');
    }
  }
  if (obj.maxLines != null && (typeof obj.maxLines !== "number" || obj.maxLines <= 0)) {
    errors.push('"maxLines" must be a positive number when present');
  }
  if (!Array.isArray(obj.rules) || obj.rules.length === 0) {
    errors.push('pack "rules" must be a non-empty array');
  } else {
    obj.rules.forEach((r, i) => {
      const err = validateRule(r, i);
      if (err) errors.push(err);
    });
  }

  return { valid: errors.length === 0, errors, pack: errors.length === 0 ? obj : null };
}

// Decide whether a validated pack applies to this command/text.
export function packMatches(pack, { command = "", text = "" } = {}) {
  const m = pack.match || {};
  const cmd = (command || "").trim().toLowerCase();
  if (cmd && isStringArray(m.commandPrefixes)) {
    if (m.commandPrefixes.some((p) => cmd.startsWith(p.toLowerCase()))) return true;
  }
  if (text && isStringArray(m.keywords)) {
    if (m.keywords.some((k) => text.includes(k))) return true;
  }
  return false;
}
