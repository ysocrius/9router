// Server-side in-memory cache for Kiro seat credit data.
// TTL = 60 seconds. Stored on globalThis so it survives Next.js hot-module reloads in dev.

// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const TTL_MS = 60 * 1000;

if (!global._seatCreditCache) global._seatCreditCache = {};
const cache = global._seatCreditCache;

/**
 * Return cached (or freshly fetched) credit data for a Kiro seat connection.
 *
 * @param {string} connectionId - The provider connection ID (seat)
 * @returns {Promise<{ used: number, total: number, resetAt: string } | null>}
 */
export async function getCachedSeatCredit(connectionId) {
  const entry = cache[connectionId];
  if (entry && Date.now() - entry.ts < TTL_MS) {
    return entry.data;
  }

  const { getProviderConnectionById } = await import("@/lib/db/repos/connectionsRepo.js");
  const connection = await getProviderConnectionById(connectionId);
  if (!connection) {
    console.warn(`[seatCreditCache] Connection not found: ${connectionId}`);
    return null;
  }

  const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };

  try {
    const usage = await getUsageForProvider(connection, proxyOptions);
    cache[connectionId] = { ts: Date.now(), data: usage };
    return usage;
  } catch (err) {
    console.warn(`[seatCreditCache] Failed to fetch usage for ${connectionId}: ${err.message}`);
    return null;
  }
}

/**
 * Force-invalidate the cache entry for a connection.
 * Call this after receiving a 429 from Kiro so the next request gets a fresh read.
 *
 * @param {string} connectionId
 */
export function invalidateSeatCredit(connectionId) {
  delete cache[connectionId];
}
