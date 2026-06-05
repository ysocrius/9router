import React from "react";

export default function WhatsNewPage() {
  // Fetch the changelog at build time (static generation)
  // For simplicity, we embed the latest change manually.
  const changelog = `# v0.4.56-private.13 (2026-06-05)

## Bugfixes
- Fixed a server crash (TypeError) when routing requests for seat-bound keys due to a missing internal export.

# v0.4.56-private.12 (2026-06-05)

## Features
- **Kiro Seat Sharing**: Bind any API key to a specific Kiro seat. Requests from that key are pinned to the bound seat, bypassing the normal round-robin selector.
- **Per-User Credit Caps (Mode A)**: Set a \`monthlyCreditLimit\` on a seat-bound key. Requests are blocked (429) when the seat's live Kiro credit usage reaches the cap. A 60-second server-side cache avoids hammering the Kiro API.
- **Per-User Request Caps (Mode B)**: Set a \`monthlyRequestLimit\` on a seat-bound key. A local billing-cycle counter (from \`usageHistory\`) enforces the cap — ideal for shared seats with multiple users.
- **Usage by User Dashboard**: New "Usage by User (Billing Cycle)" view in the Usage tab. Per-key credit/request progress bars, color-coded by utilisation (green/yellow/red), with a live reset countdown.
- **Share Button**: Each API key row now has a Share button. Shows the best available endpoint URL (Tailscale > CF Tunnel > Local), masked key reveal/copy, and one-click copy-as-config for OpenAI env vars, Hermes config.yaml, and OpenClaw models.json.
- **Key Creation — Seat & Cap Fields**: The Create Key modal includes an optional Kiro seat picker and monthly cap selector (no cap / request count / credit cap + numeric limit).
- **Unit Tests**: vitest suite added covering \`usageCycleRepo\` (10 tests) and \`seatCreditCache\` (11 tests) — all 21 passing in < 2 s.

# v0.4.64 (2026-05-28)

## Features
- Re‑enable Freebuff AI provider in OAuth Providers dashboard (was hidden as deprecated)

## Changes
- Provider registry: set \`deprecated: false\` for Freebuff, restoring full visibility and functionality in the Providers page`;

  return (
    <div className="min-h-screen bg-gradient-to-r from-indigo-900 via-purple-900 to-pink-800 p-8 text-white font-sans">
      <h1 className="text-4xl font-extrabold mb-6 text-center animate-fade-in">What’s New</h1>
      <article className="prose prose-invert max-w-3xl mx-auto bg-black bg-opacity-30 rounded-lg p-6 shadow-lg backdrop-blur-md">
        <pre className="whitespace-pre-wrap" style={{ overflowX: "auto" }}>{changelog}</pre>
      </article>
    </div>
  );
}
