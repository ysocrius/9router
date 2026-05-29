/**
 * Context Auto-Compactor
 *
 * Intercepts incoming request bodies and prunes older messages when the
 * estimated token count exceeds the provider's effective input budget.
 *
 * Strategy: Reverse-Chronological Drop with Protected Tail
 *   - Always preserve the system prompt (both OpenAI and Anthropic formats)
 *   - Always protect the most recent `minRecentMessages` at the tail
 *   - Drop oldest messages chronologically (starting after the system prompt)
 *   - Treat tool_call + tool_result as atomic units (drop together)
 *   - Orphaned tool_result (no preceding tool_call) is droppable standalone
 *
 * NOTE: This module returns a SHALLOW COPY of the messages array.
 * Message objects themselves are treated as strictly READ-ONLY.
 * Downstream middleware MUST NOT mutate individual message objects.
 * Deep-cloning is deliberately avoided for performance reasons.
 *
 * @module contextCompactor
 */

import {
  getProviderLimits,
  DEFAULT_MAX_TOKENS_RESERVATION,
} from "../config/providerLimits.js";

// ── Token Estimation Cache ───────────────────────────────────────────────────

/**
 * Cache keyed by a lightweight fingerprint: role + length + first8 + last8.
 * NOTE: Known accepted collision risk — two messages with the same role,
 * length, and bookend characters but different middle content will share
 * a cache entry. This is an intentional performance tradeoff, not an oversight.
 * Index is deliberately excluded so cache entries survive array shifts
 * during multi-pass compaction.
 */
const tokenEstimateCache = new Map();

function fingerprint(msg) {
  const content = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content ?? "");
  const len = content.length;
  const head = content.slice(0, 8);
  const tail = content.slice(-8);
  return `${msg.role}:${len}:${head}:${tail}`;
}

// ── Token Estimation ─────────────────────────────────────────────────────────

/**
 * Estimates the token count for a single text string.
 * Uses chars/4 normally; chars/2 if >20% of characters are non-ASCII
 * (CJK/emoji-heavy text can be severely underestimated by chars/4).
 */
function estimateTextTokens(text) {
  if (!text || text.length === 0) return 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) nonAscii++;
  }
  const ratio = nonAscii / text.length;
  return Math.ceil(text.length / (ratio > 0.2 ? 2 : 4));
}

/**
 * Estimates tokens for a single content block within a message.
 * Handles text blocks (char math), image blocks (fixed cost), and arrays.
 *
 * @param {*} block - A content block or string
 * @param {number} imageTokenCost - Fixed cost per image
 * @returns {number}
 */
function estimateBlockTokens(block, imageTokenCost) {
  if (!block) return 0;

  // Plain string content
  if (typeof block === "string") {
    return estimateTextTokens(block);
  }

  // Content block objects
  if (typeof block === "object") {
    // Image block (OpenAI: image_url, Anthropic: image)
    if (block.type === "image_url" || block.type === "image") {
      return imageTokenCost;
    }
    // Text block
    if (block.type === "text" && typeof block.text === "string") {
      return estimateTextTokens(block.text);
    }
    // Input audio / other non-text blocks — treat as minimal overhead
    if (block.type === "input_audio" || block.type === "audio") {
      return 100;
    }
    // Fallback: serialize and estimate
    return estimateTextTokens(JSON.stringify(block));
  }

  return 0;
}

/**
 * Estimates total token cost for a single message object.
 * Handles both string and array content (multi-part messages summing ALL parts).
 * Results are cached using a lightweight fingerprint.
 *
 * @param {object} msg - A message object with role + content
 * @param {number} imageTokenCost
 * @returns {number}
 */
export function estimateMessageTokens(msg, imageTokenCost) {
  const key = fingerprint(msg);
  if (tokenEstimateCache.has(key)) return tokenEstimateCache.get(key);

  let total = 4; // Base overhead per message (role encoding)

  if (Array.isArray(msg.content)) {
    // Multi-part content: MUST sum ALL blocks, not just the first
    for (const block of msg.content) {
      total += estimateBlockTokens(block, imageTokenCost);
    }
  } else {
    total += estimateBlockTokens(msg.content, imageTokenCost);
  }

  tokenEstimateCache.set(key, total);
  return total;
}

/**
 * Estimates token cost for an Anthropic top-level `system` field,
 * which can be a plain string or an array of content blocks.
 *
 * @param {string|Array} system
 * @param {number} imageTokenCost
 * @returns {number}
 */
function estimateSystemTokens(system, imageTokenCost) {
  if (!system) return 0;
  if (typeof system === "string") return estimateTextTokens(system);
  if (Array.isArray(system)) {
    let total = 0;
    for (const block of system) {
      total += estimateBlockTokens(block, imageTokenCost);
    }
    return total;
  }
  return 0;
}

// ── Tool Block Helpers ────────────────────────────────────────────────────────

/**
 * Detects if a message is a tool_call (assistant wanting to call a tool).
 * Handles OpenAI format (tool_calls array) and Anthropic format (content blocks).
 */
function isToolCall(msg) {
  if (!msg) return false;
  if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    return msg.content.some(b => b?.type === "tool_use");
  }
  return false;
}

/**
 * Detects if a message is a tool_result (response to a tool call).
 * Handles OpenAI format (role:tool) and Anthropic format (tool_result blocks).
 */
function isToolResult(msg) {
  if (!msg) return false;
  if (msg.role === "tool") return true;
  if (Array.isArray(msg.content)) {
    return msg.content.some(b => b?.type === "tool_result");
  }
  return false;
}

// ── Main Compactor ────────────────────────────────────────────────────────────

/**
 * Auto-compacts the request body by pruning older messages when the estimated
 * token count exceeds the provider's effective input budget.
 *
 * Returns an object with:
 *   { compacted: boolean, body: object, dropped: number, tokensBefore: number, tokensAfter: number, error: object|null }
 *
 * On hard rejection (cannot compact to fit), error will be an OpenAI-formatted
 * error object. The caller is responsible for returning it to the client.
 *
 * @param {object} body         - Request body (OpenAI or Anthropic format)
 * @param {string} provider     - Provider alias (e.g. "cerebras")
 * @returns {object}
 */
export function compactContext(body, provider) {
  const result = { compacted: false, body, dropped: 0, tokensBefore: 0, tokensAfter: 0, error: null };

  if (!body) return result;

  const limits = getProviderLimits(provider);
  const { inputContextLimit, imageTokenCost, minRecentMessages } = limits;

  // Resolve effective input budget (subtract max_tokens from context limit)
  const maxTokensReserved = (body.max_tokens && body.max_tokens > 0)
    ? body.max_tokens
    : DEFAULT_MAX_TOKENS_RESERVATION;
  const effectiveBudget = inputContextLimit - maxTokensReserved;

  // Resolve messages array (OpenAI: body.messages, Anthropic: body.messages)
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return result;

  // ── System Prompt Handling ─────────────────────────────────────────────────
  // Handle both OpenAI role:system (first message) and Anthropic body.system
  const anthropicSystem = body.system; // string or array of content blocks
  const systemTokens = estimateSystemTokens(anthropicSystem, imageTokenCost);

  // Identify OpenAI-style inline system message
  const hasInlineSystem = messages[0]?.role === "system";
  const inlineSystemTokens = hasInlineSystem
    ? estimateMessageTokens(messages[0], imageTokenCost)
    : 0;

  const totalSystemTokens = systemTokens + inlineSystemTokens;

  // Early rejection: system prompt alone exceeds budget
  if (totalSystemTokens > effectiveBudget) {
    result.error = {
      error: {
        message: `The system prompt alone (est. ${totalSystemTokens} tokens) exceeds the effective input budget (${effectiveBudget} tokens) for provider "${provider}". Reduce your system prompt or increase the context limit.`,
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    };
    return result;
  }

  // ── Estimate Total Tokens ──────────────────────────────────────────────────
  let total = systemTokens;
  for (const msg of messages) {
    total += estimateMessageTokens(msg, imageTokenCost);
  }

  result.tokensBefore = total;

  // Already under budget — no compaction needed
  if (total <= effectiveBudget) return result;

  // ── Compaction Loop ───────────────────────────────────────────────────────
  // Work on a shallow copy of the messages array (message objects are read-only)
  let msgs = [...messages];
  const start = hasInlineSystem ? 1 : 0; // First droppable index
  const MAX_ITERATIONS = 100; // Safety rail for degenerate arrays
  let iterations = 0;
  let dropped = 0;

  while (total > effectiveBudget && iterations < MAX_ITERATIONS) {
    iterations++;

    // Protected tail: never drop the last minRecentMessages
    const droppableEnd = msgs.length - minRecentMessages;
    if (start >= droppableEnd) break; // Nothing left to drop

    const candidate = msgs[start];

    // Detect tool_call: if next message is a tool_result, drop both atomically
    if (isToolCall(candidate) && msgs.length > start + 1 && isToolResult(msgs[start + 1])) {
      const callTokens = estimateMessageTokens(candidate, imageTokenCost);
      const resultTokens = estimateMessageTokens(msgs[start + 1], imageTokenCost);
      total -= (callTokens + resultTokens);
      msgs = [...msgs.slice(0, start), ...msgs.slice(start + 2)];
      dropped += 2;
      continue;
    }

    // Detect orphaned tool_result (no preceding tool_call in current window)
    // Treat as a droppable standalone message
    if (isToolResult(candidate)) {
      total -= estimateMessageTokens(candidate, imageTokenCost);
      msgs = [...msgs.slice(0, start), ...msgs.slice(start + 1)];
      dropped++;
      continue;
    }

    // Standard message drop
    const msgTokens = estimateMessageTokens(candidate, imageTokenCost);
    if (msgTokens === 0) break; // No progress — prevent infinite loop
    total -= msgTokens;
    msgs = [...msgs.slice(0, start), ...msgs.slice(start + 1)];
    dropped++;
  }

  // ── Post-Loop Check (Protected Tail Exhaustion) ────────────────────────────
  // If we couldn't get under budget, check if the remaining tail itself exceeds
  // the budget (e.g., one massive tool result in the protected window)
  if (total > effectiveBudget) {
    result.error = {
      error: {
        message: `Context auto-compaction could not reduce the request to fit within the budget (est. ${total} tokens, budget: ${effectiveBudget}) for provider "${provider}". The protected tail alone exceeds the limit. Reduce your message history.`,
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    };
    return result;
  }

  // ── Success ────────────────────────────────────────────────────────────────
  result.compacted = true;
  result.dropped = dropped;
  result.tokensAfter = total;
  result.body = { ...body, messages: msgs };

  return result;
}

/** Clears the token estimate cache (useful for testing) */
export function clearCompactorCache() {
  tokenEstimateCache.clear();
}
