// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getMonthlyUsageByUser } from "@/lib/db/repos/usageRepo.js";
import { getCachedSeatCredit } from "@/lib/seatCreditCache.js";
import { getCycleSummaryForKey } from "@/lib/db/repos/usageCycleRepo.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/monthly
 *
 * Returns per-key usage for the current Kiro billing cycle.
 *
 * Response shape:
 * {
 *   cycle: { resetAt: string, daysRemaining: number } | null,
 *   users: Array<{
 *     keyId, keyName, seatName, seatConnectionId,
 *     mode: "kiro-credit" | "request-count",
 *     limit: number,
 *     thisCycle: { requests, promptTokens, completionTokens },
 *     liveCredit: { used, total, resetAt } | null
 *   }>
 * }
 */
export async function GET() {
  try {
    const users = await getMonthlyUsageByUser();

    if (!users.length) {
      return Response.json({ cycle: null, users: [] });
    }

    // Fetch live credit data for all unique seats in parallel
    const uniqueSeatIds = [...new Set(users.map((u) => u.seatConnectionId))];
    const creditMap = {};
    await Promise.all(
      uniqueSeatIds.map(async (id) => {
        try {
          creditMap[id] = await getCachedSeatCredit(id);
        } catch {
          creditMap[id] = null;
        }
      })
    );

    // Determine overall cycle resetAt from the first seat that has data
    let cycleResetAt = null;
    for (const id of uniqueSeatIds) {
      if (creditMap[id]?.resetAt) {
        cycleResetAt = creditMap[id].resetAt;
        break;
      }
    }

    const daysRemaining = cycleResetAt
      ? Math.max(0, Math.ceil((new Date(cycleResetAt) - Date.now()) / 86400000))
      : null;

    // Enrich each user entry with cycle summary + live credit
    const enriched = await Promise.all(
      users.map(async (user) => {
        const credit = creditMap[user.seatConnectionId];
        const resetAt = credit?.resetAt || cycleResetAt;

        let thisCycle = { requests: 0, promptTokens: 0, completionTokens: 0 };
        if (resetAt) {
          try {
            thisCycle = await getCycleSummaryForKey(user.keyId, resetAt);
          } catch {}
        }

        return {
          keyId: user.keyId,
          keyName: user.keyName,
          seatName: user.seatName,
          seatConnectionId: user.seatConnectionId,
          mode: user.mode,
          limit: user.limit,
          thisCycle,
          // liveCredit only populated for kiro-credit mode (sole-use seat)
          liveCredit: user.mode === "kiro-credit" ? (credit ?? null) : null,
        };
      })
    );

    return Response.json({
      cycle: cycleResetAt ? { resetAt: cycleResetAt, daysRemaining } : null,
      users: enriched,
    });
  } catch (error) {
    console.error("[usage/monthly] Error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
