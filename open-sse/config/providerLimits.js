/**
 * Provider Context Limits
 *
 * Centralizes per-provider limits for the auto-compaction system.
 * Kept separate from providerModels.js to avoid mixing routing config
 * with operational limits.
 *
 * Fields per provider:
 *   inputContextLimit  - Maximum total input tokens (prompt-side only).
 *                        Effective input budget = inputContextLimit − max_tokens.
 *                        Reasoning: 64k default leaves a 4k-8k output budget
 *                        on typical 100k-128k context/TPM quotas without
 *                        triggering rate limits.
 *   imageTokenCost     - Fixed token overhead per image block (default: 1500).
 *                        OpenAI vision pricing can reach 1700-2800 per tile at
 *                        high resolution; 1500 is a conservative safe floor.
 *   minRecentMessages  - Minimum number of recent messages (tail) to always
 *                        preserve during compaction. Unit: message objects
 *                        (e.g., 4 objects = ~2 user/assistant turns).
 */

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONTEXT_LIMIT   = 64_000;
export const DEFAULT_IMAGE_TOKEN_COST = 1_500;
export const DEFAULT_MIN_RECENT_MSGS = 4;
export const DEFAULT_MAX_TOKENS_RESERVATION = 4_096; // Used when max_tokens is absent/0

// ── Per-Provider Overrides ──────────────────────────────────────────────────

const PROVIDER_LIMITS = {
  // Cerebras has a strict 60k TPM quota — set conservatively below that
  cerebras: {
    inputContextLimit: 45_000,
  },

  // Groq has generous context but strict TPM on free tier
  groq: {
    inputContextLimit: 100_000,
  },

  // Anthropic supports up to 200k context
  anthropic: {
    inputContextLimit: 180_000,
    imageTokenCost: 1_700, // Anthropic vision: ~1600-2000 per image
  },

  // OpenAI: GPT-4o supports 128k, vision uses 1700-2800 per tile
  openai: {
    inputContextLimit: 120_000,
    imageTokenCost: 2_000,
  },

  // Google Gemini: very large context windows
  google: {
    inputContextLimit: 900_000,
  },

  // Mistral: varies by model, use safe conservative limit
  mistral: {
    inputContextLimit: 30_000,
  },

  // Together: depends on model family
  together: {
    inputContextLimit: 60_000,
  },

  // Deepseek: 64k context on most models
  deepseek: {
    inputContextLimit: 60_000,
  },
};

/**
 * Returns the resolved limits for a given provider alias,
 * merging provider-specific overrides with global defaults.
 *
 * @param {string} provider - Provider alias (e.g. "cerebras", "openai")
 * @returns {{ inputContextLimit: number, imageTokenCost: number, minRecentMessages: number }}
 */
export function getProviderLimits(provider) {
  const overrides = PROVIDER_LIMITS[provider] || {};
  return {
    inputContextLimit:  overrides.inputContextLimit  ?? DEFAULT_CONTEXT_LIMIT,
    imageTokenCost:     overrides.imageTokenCost     ?? DEFAULT_IMAGE_TOKEN_COST,
    minRecentMessages:  overrides.minRecentMessages  ?? DEFAULT_MIN_RECENT_MSGS,
  };
}

// ── Startup Validation ──────────────────────────────────────────────────────

/**
 * Validates all provider limit configurations at startup.
 * Logs a warning (never throws) if any limit is dangerously low,
 * preventing silent 400-rejection loops at runtime.
 */
export function validateProviderLimits() {
  for (const [provider, overrides] of Object.entries(PROVIDER_LIMITS)) {
    const limits = getProviderLimits(provider);
    const minimumSafeLimit = limits.minRecentMessages * 2_000;
    if (limits.inputContextLimit < minimumSafeLimit) {
      console.warn(
        `[COMPACTOR CONFIG] Provider "${provider}" has inputContextLimit=${limits.inputContextLimit} ` +
        `which is below the safe minimum (${minimumSafeLimit} = minRecentMessages×2000). ` +
        `Auto-compaction may hard-reject valid requests.`
      );
    }
  }
}
