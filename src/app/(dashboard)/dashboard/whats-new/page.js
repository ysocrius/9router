import React from "react";

export default function WhatsNewPage() {
  // Fetch the changelog at build time (static generation)
  // For simplicity, we embed the latest change manually.
  const changelog = `# v0.4.56-private.10 (2026-05-30)

## Features
- **RTK Token Saver Integration**: Gemini-path activation with three-case string detection to cleanly compress tool outputs and prevent massive token ingestion on heavy tasks.
- **Smart Caveman Reducer**: Input-side stacked pipeline mapping \`rtk -> cavemanText\` to surgically truncate shell, diff, and read outputs without losing protected code structures (opt-in).
- **Latency Benchmarked**: Strictly enforces an offline 10ms latency budget per request with measurable 50% token reduction across the proxy layer.
- **Lazy Load Extensibility**: Declarative JSON filter packs for tool output parsers like Docker and kubectl load efficiently only when explicitly triggered.

# v0.4.56-private.9 (2026-05-29)

## Features
- OmniRoute-Inspired Auto Routing: New virtual routes (auto, auto/coding, auto/cheap, auto/fast, auto/reasoning) build dynamic fallback model lists from your active provider connections at request time. No persisted config or DB changes needed.
- Expanded Combo Strategies: Added deterministic reverse, plus random and shuffle ordering modes alongside the existing fallback and round-robin strategies.

## Notes
- All existing private features (auth, token refresh, project ID, context compaction, logging, combo fallback) remain intact.

# v0.4.56-private.8 (2026-05-29)

## Features
- Context Auto-Compaction: 9Router now automatically prunes older messages when a request approaches the provider's context limit. Prevents Cerebras/Groq 429 TPM errors from oversized conversation histories.
- Smart Drop Strategy: Tool call + tool result pairs are treated as atomic units and always dropped together. The most recent 4 messages are always preserved.
- CJK-Aware Token Estimation: Uses chars/2 for text with >20% non-ASCII characters (CJK/emoji) for more accurate token estimates in multilingual conversations.
- Per-Provider Limits: Context window and image token costs are configurable per provider (Cerebras: 45k, Groq: 100k, Anthropic: 180k, OpenAI: 120k).
- Observability Headers: Compacted responses include X-9Router-Compacted, X-9Router-Compacted-Dropped, X-9Router-Tokens-Before, and X-9Router-Tokens-After headers.

## Bug Fixes
- Hard rejection with OpenAI-compatible error when compaction cannot fit the request (e.g. system prompt alone exceeds budget).
- Effective budget now correctly subtracts max_tokens reservation (defaults to 4096 when absent).

# v0.4.56-private.7 (2026-05-28)

## Bug Fixes
- Fixed adaptive token minimum limit constraint overriding the dynamic floor: hardcoded MIN_ADAPTIVE_TOKENS is now 500.

# v0.4.56-private.6 (2026-05-28)

## Bug Fixes
- Aggressive adaptive token reduction: increased retries to 6 and lowered floor to 500 tokens to handle large prompts hitting TPM limits (e.g. Cerebras).

# v0.4.56-private.5 (2026-05-28)

## Bug Fixes
- Adaptive token start value: increased from 8k to 64k to allow higher initial requests.
- Adaptive token retries: increased from 3 to 4 attempts to ensure minimum limit (4k) is reached.
- Replaced hardcoded 64000 fallbacks with shared DEFAULT_MAX_TOKENS constant for consistency.

# v0.4.56-private.4 (2026-05-28)

## Features
- Synchronized Kilo Models: The pop-up now correctly displays all Kilo Code models (premium, free, and custom) matching the dashboard view.

## Bug Fixes
- Fixed missing Kilo free models in popup.

# v0.4.56-private.3 (2026-05-28)

## Features
- MITM Popup Sync: Merged Kilo Code free dynamic models into the popup to match Dashboard counts.

# v0.4.56-private.2 (2026-05-28)

## Features
- Model Selector Sync: The MITM proxy "Start Server" pop-up model list now accurately syncs with the Dashboard Models card (merging all hardcoded, alias, and custom registered models seamlessly).

# v0.4.56-private.1 (2026-05-28)

## Features
- In-app Release Notes: Introduced the new /dashboard/whats-new page to showcase changelogs directly inside the UI.`;

  return (
    <div className="min-h-screen bg-gradient-to-r from-indigo-900 via-purple-900 to-pink-800 p-8 text-white font-sans">
      <h1 className="text-4xl font-extrabold mb-6 text-center animate-fade-in">What&apos;s New</h1>
      <article className="prose prose-invert max-w-3xl mx-auto bg-black bg-opacity-30 rounded-lg p-6 shadow-lg backdrop-blur-md">
        <pre className="whitespace-pre-wrap" style={{ overflowX: "auto" }}>{changelog}</pre>
      </article>
    </div>
  );
}
