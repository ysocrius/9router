import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock all external dependencies before importing the module under test ──
// vi.mock calls are hoisted by vitest above all imports.

vi.mock('open-sse/index.js', () => ({}));  // side-effect only import — stub it out

vi.mock('open-sse/services/usage.js', () => ({
  getUsageForProvider: vi.fn(),
}));

vi.mock('@/lib/network/connectionProxy', () => ({
  resolveConnectionProxyConfig: vi.fn().mockResolvedValue({
    connectionProxyEnabled: false,
    connectionProxyUrl: '',
    connectionNoProxy: '',
    vercelRelayUrl: '',
  }),
}));

vi.mock('@/lib/db/repos/connectionsRepo.js', () => ({
  getProviderConnectionById: vi.fn(),
}));

import { getUsageForProvider } from 'open-sse/services/usage.js';
import { getProviderConnectionById } from '@/lib/db/repos/connectionsRepo.js';
import { getCachedSeatCredit, invalidateSeatCredit } from '@/lib/seatCreditCache.js';

// ── Fixtures ───────────────────────────────────────────────────────────────
const CONN_1 = 'conn-1';
const CONN_2 = 'conn-2';

const mockConnection = {
  id: CONN_1,
  provider: 'kiro',
  authType: 'oauth',
  accessToken: 'tok-abc',
  providerSpecificData: {},
};

const mockCredit = { used: 335.21, total: 2000, resetAt: '2026-07-01T00:00:00Z' };
const mockCredit2 = { used: 800,    total: 2000, resetAt: '2026-07-01T00:00:00Z' };

// ── Tests ──────────────────────────────────────────────────────────────────
describe('seatCreditCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Flush any cached state from previous tests
    invalidateSeatCredit(CONN_1);
    invalidateSeatCredit(CONN_2);
    // Default mocks
    getProviderConnectionById.mockResolvedValue(mockConnection);
    getUsageForProvider.mockResolvedValue(mockCredit);
  });

  // ── Cache miss / hit ────────────────────────────────────────────────────
  it('fetches from provider on the first call (cache miss)', async () => {
    const result = await getCachedSeatCredit(CONN_1);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockCredit);
  });

  it('returns the cached value on a second call without re-fetching', async () => {
    await getCachedSeatCredit(CONN_1);
    const result = await getCachedSeatCredit(CONN_1);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1); // still only once
    expect(result).toEqual(mockCredit);
  });

  it('does not re-fetch on repeated calls within TTL', async () => {
    await getCachedSeatCredit(CONN_1);
    await getCachedSeatCredit(CONN_1);
    await getCachedSeatCredit(CONN_1);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  // ── Invalidation ────────────────────────────────────────────────────────
  it('re-fetches after invalidateSeatCredit is called', async () => {
    await getCachedSeatCredit(CONN_1);
    invalidateSeatCredit(CONN_1);
    await getCachedSeatCredit(CONN_1);
    expect(getUsageForProvider).toHaveBeenCalledTimes(2);
  });

  it('invalidating one connection does not affect another', async () => {
    getProviderConnectionById
      .mockResolvedValueOnce({ ...mockConnection, id: CONN_1 })
      .mockResolvedValueOnce({ ...mockConnection, id: CONN_2 });
    getUsageForProvider
      .mockResolvedValueOnce(mockCredit)
      .mockResolvedValueOnce(mockCredit2);

    await getCachedSeatCredit(CONN_1);
    await getCachedSeatCredit(CONN_2);
    invalidateSeatCredit(CONN_1);

    // CONN_1 invalidated — re-fetches; CONN_2 still cached
    getUsageForProvider.mockResolvedValue(mockCredit);
    await getCachedSeatCredit(CONN_1);
    await getCachedSeatCredit(CONN_2);

    // getUsageForProvider should have been called 3 times total (1+1+1)
    expect(getUsageForProvider).toHaveBeenCalledTimes(3);
  });

  // ── Error handling ───────────────────────────────────────────────────────
  it('returns null gracefully when the connection is not found in DB', async () => {
    getProviderConnectionById.mockResolvedValue(null);
    const result = await getCachedSeatCredit('no-such-conn');
    expect(result).toBeNull();
  });

  it('returns null gracefully when getUsageForProvider throws', async () => {
    getUsageForProvider.mockRejectedValue(new Error('Upstream timeout'));
    const result = await getCachedSeatCredit(CONN_1);
    expect(result).toBeNull();
  });

  it('does not cache a null result from a failed fetch (allows retry)', async () => {
    getUsageForProvider.mockRejectedValueOnce(new Error('fail'));
    await getCachedSeatCredit(CONN_1); // null — not cached

    getUsageForProvider.mockResolvedValue(mockCredit);
    const result = await getCachedSeatCredit(CONN_1); // retries
    expect(getUsageForProvider).toHaveBeenCalledTimes(2);
    expect(result).toEqual(mockCredit);
  });

  // ── Per-connection independence ──────────────────────────────────────────
  it('caches independently per connectionId', async () => {
    getProviderConnectionById
      .mockResolvedValueOnce({ ...mockConnection, id: CONN_1 })
      .mockResolvedValueOnce({ ...mockConnection, id: CONN_2 });

    await getCachedSeatCredit(CONN_1);
    await getCachedSeatCredit(CONN_2);
    expect(getUsageForProvider).toHaveBeenCalledTimes(2);
  });

  it('second call for the same id never calls provider again', async () => {
    await getCachedSeatCredit(CONN_1);
    await getCachedSeatCredit(CONN_1);
    await getCachedSeatCredit(CONN_1);
    expect(getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  // ── Return value structure ───────────────────────────────────────────────
  it('returns the exact object from getUsageForProvider', async () => {
    const custom = { used: 1500, total: 2000, resetAt: '2026-08-01T00:00:00Z' };
    getUsageForProvider.mockResolvedValue(custom);

    const result = await getCachedSeatCredit(CONN_1);
    expect(result).toEqual(custom);
  });
});
