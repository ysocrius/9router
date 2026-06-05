import { getAdapter } from "../driver.js";

/**
 * Count all successful requests made by an API key since the billing cycle reset.
 *
 * @param {string} apiKeyId - The DB `id` of the API key (not the raw sk-... string)
 * @param {string} resetAt  - ISO timestamp of the billing cycle start (from Kiro's /usage endpoint)
 * @returns {Promise<number>} Number of requests this cycle
 */
export async function getKeyRequestsThisCycle(apiKeyId, resetAt) {
  const { requests } = await getCycleSummaryForKey(apiKeyId, resetAt);
  return requests;
}

/**
 * Aggregate usage for an API key since the billing cycle reset.
 *
 * @param {string} apiKeyId - The DB `id` of the API key
 * @param {string} resetAt  - ISO timestamp of billing cycle start
 * @returns {Promise<{ requests: number, promptTokens: number, completionTokens: number }>}
 */
export async function getCycleSummaryForKey(apiKeyId, resetAt) {
  const db = await getAdapter();

  // Resolve the raw key string (sk-...) from the key ID
  const keyRow = db.get(`SELECT key FROM apiKeys WHERE id = ?`, [apiKeyId]);
  if (!keyRow) {
    return { requests: 0, promptTokens: 0, completionTokens: 0 };
  }

  const resetIso = new Date(resetAt).toISOString();

  // Count directly from usageHistory — precise to the second, unlike the daily aggregate.
  // Only count successful requests (status = 'ok') to match Kiro's credit deduction logic.
  const row = db.get(
    `SELECT
       COUNT(*)              AS requests,
       SUM(promptTokens)     AS promptTokens,
       SUM(completionTokens) AS completionTokens
     FROM usageHistory
     WHERE apiKey = ? AND timestamp >= ? AND status = 'ok'`,
    [keyRow.key, resetIso]
  );

  return {
    requests: row?.requests || 0,
    promptTokens: row?.promptTokens || 0,
    completionTokens: row?.completionTokens || 0,
  };
}
