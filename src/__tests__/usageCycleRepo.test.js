import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ── In-memory adapter factory ──────────────────────────────────────────────
// Wraps a real better-sqlite3 :memory: DB in the same interface as
// betterSqliteAdapter.js so the repo functions see no difference.
function createTestAdapter() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE apiKeys (
      id   TEXT PRIMARY KEY,
      key  TEXT NOT NULL,
      name TEXT,
      machineId TEXT,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT,
      seatConnectionId TEXT,
      monthlyRequestLimit INTEGER,
      monthlyCreditLimit  INTEGER
    );
    CREATE TABLE usageHistory (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp        TEXT,
      provider         TEXT,
      model            TEXT,
      connectionId     TEXT,
      apiKey           TEXT,
      endpoint         TEXT,
      promptTokens     INTEGER DEFAULT 0,
      completionTokens INTEGER DEFAULT 0,
      cost             REAL    DEFAULT 0,
      status           TEXT    DEFAULT 'ok',
      tokens           TEXT,
      meta             TEXT
    );
  `);
  return {
    driver: 'test',
    run(sql, params = [])  { return db.prepare(sql).run(params); },
    get(sql, params = [])  { return db.prepare(sql).get(params); },
    all(sql, params = [])  { return db.prepare(sql).all(params); },
    exec(sql)              { return db.exec(sql); },
    transaction(fn)        { return db.transaction(fn)(); },
    close()                { db.close(); },
  };
}

// Mock getAdapter BEFORE the module under test is imported.
// vi.mock is hoisted by vitest so the mock is in place for all imports below.
let testAdapter;
vi.mock('@/lib/db/driver.js', () => ({
  getAdapter: vi.fn(async () => testAdapter),
}));

import { getCycleSummaryForKey, getKeyRequestsThisCycle } from '@/lib/db/repos/usageCycleRepo.js';

// ── Helpers ────────────────────────────────────────────────────────────────
const RESET_AT = '2026-01-01T00:00:00Z';  // billing cycle start used in all tests
const BEFORE   = '2025-12-31T23:59:59Z';  // timestamp before the cycle
const AFTER_1  = '2026-02-01T00:00:00Z';  // timestamp within the cycle
const AFTER_2  = '2026-02-15T12:00:00Z';  // second timestamp within the cycle

function insertKey(id, key = `sk-${id}`) {
  testAdapter.run(`INSERT INTO apiKeys (id, key, name) VALUES (?, ?, ?)`, [id, key, id]);
}

function insertRequest(apiKey, timestamp, promptTokens, completionTokens, status = 'ok') {
  testAdapter.run(
    `INSERT INTO usageHistory (timestamp, apiKey, promptTokens, completionTokens, status)
     VALUES (?, ?, ?, ?, ?)`,
    [timestamp, apiKey, promptTokens, completionTokens, status]
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('usageCycleRepo', () => {
  beforeEach(() => {
    testAdapter = createTestAdapter();
  });

  afterEach(() => {
    testAdapter?.close();
  });

  // ── getCycleSummaryForKey ────────────────────────────────────────────────
  describe('getCycleSummaryForKey', () => {
    it('returns zeros when the key ID does not exist', async () => {
      const result = await getCycleSummaryForKey('nonexistent', RESET_AT);
      expect(result).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0 });
    });

    it('returns zeros when no requests have been made since resetAt', async () => {
      insertKey('key1');
      insertRequest('sk-key1', BEFORE, 100, 50); // before the cycle — not counted

      const result = await getCycleSummaryForKey('key1', RESET_AT);
      expect(result).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0 });
    });

    it('counts requests made after resetAt', async () => {
      insertKey('key1');
      insertRequest('sk-key1', AFTER_1, 1000, 500);
      insertRequest('sk-key1', AFTER_2, 2000, 800);

      const result = await getCycleSummaryForKey('key1', RESET_AT);
      expect(result.requests).toBe(2);
      expect(result.promptTokens).toBe(3000);
      expect(result.completionTokens).toBe(1300);
    });

    it('includes a request made exactly at resetAt (boundary)', async () => {
      insertKey('key1');
      insertRequest('sk-key1', RESET_AT, 100, 50);

      const result = await getCycleSummaryForKey('key1', RESET_AT);
      expect(result.requests).toBe(1);
    });

    it('does not count failed requests (status != ok)', async () => {
      insertKey('key1');
      insertRequest('sk-key1', AFTER_1, 1000, 500, 'error');   // should be excluded
      insertRequest('sk-key1', AFTER_2, 500,  200, 'ok');      // should be counted

      const result = await getCycleSummaryForKey('key1', RESET_AT);
      expect(result.requests).toBe(1);
      expect(result.promptTokens).toBe(500);
      expect(result.completionTokens).toBe(200);
    });

    it('only counts requests for the specified API key, not others', async () => {
      insertKey('key1', 'sk-key1');
      insertKey('key2', 'sk-key2');
      insertRequest('sk-key1', AFTER_1, 100, 50);
      insertRequest('sk-key2', AFTER_1, 9999, 9999); // different key — must not leak

      const result = await getCycleSummaryForKey('key1', RESET_AT);
      expect(result.requests).toBe(1);
      expect(result.promptTokens).toBe(100);
      expect(result.completionTokens).toBe(50);
    });

    it('mixes before/after correctly with multiple requests', async () => {
      insertKey('key1');
      insertRequest('sk-key1', BEFORE,  100, 50,  'ok'); // before — excluded
      insertRequest('sk-key1', AFTER_1, 200, 100, 'ok'); // after  — counted
      insertRequest('sk-key1', AFTER_2, 300, 150, 'error'); // after but error — excluded
      insertRequest('sk-key1', AFTER_2, 400, 200, 'ok'); // after  — counted

      const result = await getCycleSummaryForKey('key1', RESET_AT);
      expect(result.requests).toBe(2);
      expect(result.promptTokens).toBe(600);
      expect(result.completionTokens).toBe(300);
    });
  });

  // ── getKeyRequestsThisCycle ──────────────────────────────────────────────
  describe('getKeyRequestsThisCycle', () => {
    it('returns the total successful request count', async () => {
      insertKey('key1');
      insertRequest('sk-key1', AFTER_1, 100, 50);
      insertRequest('sk-key1', AFTER_2, 200, 100);

      const count = await getKeyRequestsThisCycle('key1', RESET_AT);
      expect(count).toBe(2);
    });

    it('returns 0 for a nonexistent key', async () => {
      const count = await getKeyRequestsThisCycle('nonexistent', RESET_AT);
      expect(count).toBe(0);
    });

    it('matches getCycleSummaryForKey.requests', async () => {
      insertKey('key1');
      insertRequest('sk-key1', AFTER_1, 500, 200);
      insertRequest('sk-key1', AFTER_2, 300, 100);

      const count = await getKeyRequestsThisCycle('key1', RESET_AT);
      const { requests } = await getCycleSummaryForKey('key1', RESET_AT);
      expect(count).toBe(requests);
    });
  });
});
