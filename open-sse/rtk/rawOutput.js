// Phase 3 — raw-output retention (DORMANT by default).
// When RTK compresses a tool result, the original can optionally be stashed so
// it is recoverable (e.g. to re-expand a truncated build log on demand). This
// adds zero behavior by default: retention mode `never` keeps nothing and the
// store stays empty, so it is invisible until a higher-reduction workflow opts
// in. Ported conceptually from OmniRoute's rawOutput hook.

import { RAW_CAP } from "./constants.js";

// Retention policies.
export const RETENTION = {
  NEVER: "never",       // default: keep nothing (no behavior change)
  FAILURES: "failures", // keep originals only for error/failure-bearing outputs
  ALWAYS: "always",     // keep every compressed original (size-capped)
};

// Resolve the active policy from config/env. Default NEVER.
export function resolveRetention(cfg) {
  const v = (cfg && cfg.rawOutputRetention) || process.env.RTK_RAW_RETENTION || RETENTION.NEVER;
  return v === RETENTION.FAILURES || v === RETENTION.ALWAYS ? v : RETENTION.NEVER;
}

// A bounded LRU-ish store. Capacity is intentionally small; this is a recovery
// buffer, not a cache. Total retained bytes are capped at RAW_CAP.
export class RawOutputStore {
  constructor({ maxEntries = 64, maxBytes = RAW_CAP } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.map = new Map(); // key -> { text, bytes, ts }
    this.totalBytes = 0;
  }

  // Decide whether a given output should be retained under the policy.
  shouldRetain(policy, { isError = false } = {}) {
    if (policy === RETENTION.ALWAYS) return true;
    if (policy === RETENTION.FAILURES) return isError === true;
    return false; // NEVER
  }

  // Stash an original. No-op when policy says skip or text is empty.
  retain(key, text, policy, meta = {}) {
    if (!this.shouldRetain(policy, meta)) return false;
    if (typeof text !== "string" || text.length === 0 || !key) return false;

    const bytes = Buffer.byteLength(text, "utf8");
    // A single output larger than the whole cap is never retained.
    if (bytes > this.maxBytes) return false;

    // Evict if the key already existed (replace).
    if (this.map.has(key)) {
      this.totalBytes -= this.map.get(key).bytes;
      this.map.delete(key);
    }

    this.map.set(key, { text, bytes, ts: Date.now() });
    this.totalBytes += bytes;
    this._evictToFit();
    return true;
  }

  // Recover a retained original, or null if absent.
  recover(key) {
    const e = this.map.get(key);
    return e ? e.text : null;
  }

  // Evict oldest entries until both caps are satisfied.
  _evictToFit() {
    // Map preserves insertion order, so the first key is the oldest.
    while (this.map.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.totalBytes -= this.map.get(oldest).bytes;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
    this.totalBytes = 0;
  }
}

// Module-level singleton for the common case; callers may also instantiate
// their own store. Dormant until something retains into it.
export const defaultRawStore = new RawOutputStore();
