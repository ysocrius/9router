/**
 * Adaptive Token Limit Store
 * 
 * Tracks per-provider:model token limits that automatically reduce
 * when the upstream provider rejects requests due to token limits.
 * 
 * Flow:
 *   1. First request uses DEFAULT_MAX_TOKENS (64k)
 *   2. On token-related error → halve the limit (64k → 32k → 16k → 8k → 4k)
 *   3. Subsequent requests use the reduced limit
 *   4. After 30 min cooldown, limit resets and tries the previous value again
 */

import { DEFAULT_MAX_TOKENS } from "./runtimeConfig.js";

const MIN_ADAPTIVE_TOKENS = 4096;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes before retrying higher

// Map<"provider:model", { maxTokens, previousMaxTokens, reducedAt, reductions }>
const store = new Map();

/**
 * Get the adaptive max_tokens for a provider:model pair.
 * @returns {number|null} Reduced limit, or null if no reduction recorded (use default)
 */
export function getAdaptiveMaxTokens(provider, model) {
  const key = `${provider}:${model}`;
  const entry = store.get(key);
  if (!entry) return null;

  // Cooldown expired — try the previous (higher) value
  if (Date.now() - entry.reducedAt > COOLDOWN_MS && entry.previousMaxTokens > entry.maxTokens) {
    const probe = entry.previousMaxTokens;
    // Don't fully restore yet — set as probe (will be re-reduced if it fails again)
    entry.previousMaxTokens = entry.maxTokens;
    entry.maxTokens = probe;
    entry.reducedAt = Date.now();
    return probe;
  }

  return entry.maxTokens;
}

/**
 * Record a token limit failure and reduce the limit.
 * Called when a provider rejects a request due to token limits.
 * 
 * @param {string} provider
 * @param {string} model
 * @param {number} failedMaxTokens - The max_tokens value that was rejected
 * @returns {number} The new reduced limit
 */
export function recordTokenLimitFailure(provider, model, failedMaxTokens) {
  const key = `${provider}:${model}`;
  const existing = store.get(key);
  const reductions = (existing?.reductions || 0) + 1;

  // Halve from the failed value, but never below MIN
  const newLimit = Math.max(Math.floor(failedMaxTokens / 2), MIN_ADAPTIVE_TOKENS);

  store.set(key, {
    maxTokens: newLimit,
    previousMaxTokens: existing?.maxTokens || DEFAULT_MAX_TOKENS,
    reducedAt: Date.now(),
    reductions,
  });

  return newLimit;
}

/**
 * Reset adaptive tokens for a provider:model (e.g., after successful request).
 * Optional: call after successful request to allow gradual recovery.
 */
export function resetAdaptiveTokens(provider, model) {
  store.delete(`${provider}:${model}`);
}

/**
 * Check if an error message indicates a token-limit / model-lock issue.
 * Matches common patterns from free-tier providers.
 * 
 * @param {string} errorText
 * @param {number} [statusCode]
 * @returns {boolean}
 */
export function isTokenLimitError(errorText, statusCode) {
  if (!errorText) return false;
  const text = String(errorText);

  // Status codes that commonly accompany token limits
  // 400 (bad request), 413 (payload too large), 422 (unprocessable)
  const isLikelyStatus = !statusCode || statusCode === 400 || statusCode === 413 || statusCode === 422;

  if (!isLikelyStatus) return false;

  const patterns = [
    /max.?tokens?/i,
    /token.*limit/i,
    /token.*exceed/i,
    /context.*length/i,
    /maximum.*context/i,
    /output.*token/i,
    /generation.*length/i,
    /request.*too.*large/i,
    /payload.*too.*large/i,
    /model.*lock/i,
    /context.*window/i,
    /too.*many.*tokens/i,
    /input.*too.*long/i,
    /maximum.*length/i,
    /invalid.*argument/i,
  ];

  return patterns.some(p => p.test(text));
}

/**
 * Get full store state for debugging/logging.
 */
export function getAdaptiveStoreState() {
  const state = {};
  for (const [key, entry] of store.entries()) {
    state[key] = {
      maxTokens: entry.maxTokens,
      previousMaxTokens: entry.previousMaxTokens,
      reductions: entry.reductions,
      reducedAt: new Date(entry.reducedAt).toISOString(),
      cooldownRemaining: Math.max(0, COOLDOWN_MS - (Date.now() - entry.reducedAt)),
    };
  }
  return state;
}
