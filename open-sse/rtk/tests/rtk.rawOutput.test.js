// Phase 3 — raw-output retention tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RawOutputStore, RETENTION, resolveRetention } from "../rawOutput.js";

test("default policy is NEVER and retains nothing", () => {
  const store = new RawOutputStore();
  const kept = store.retain("k1", "some original output", RETENTION.NEVER);
  assert.equal(kept, false);
  assert.equal(store.size, 0);
  assert.equal(store.recover("k1"), null);
});

test("resolveRetention defaults to NEVER for missing/invalid values", () => {
  assert.equal(resolveRetention(undefined), RETENTION.NEVER);
  assert.equal(resolveRetention({ rawOutputRetention: "bogus" }), RETENTION.NEVER);
  assert.equal(resolveRetention({ rawOutputRetention: "always" }), RETENTION.ALWAYS);
  assert.equal(resolveRetention({ rawOutputRetention: "failures" }), RETENTION.FAILURES);
});

test("ALWAYS retains and recovers originals", () => {
  const store = new RawOutputStore();
  assert.equal(store.retain("k1", "original text", RETENTION.ALWAYS), true);
  assert.equal(store.recover("k1"), "original text");
});

test("FAILURES retains only error-bearing outputs", () => {
  const store = new RawOutputStore();
  assert.equal(store.retain("ok", "fine output", RETENTION.FAILURES, { isError: false }), false);
  assert.equal(store.retain("bad", "error output", RETENTION.FAILURES, { isError: true }), true);
  assert.equal(store.recover("ok"), null);
  assert.equal(store.recover("bad"), "error output");
});

test("evicts oldest entries past the entry cap", () => {
  const store = new RawOutputStore({ maxEntries: 3 });
  store.retain("a", "aaa", RETENTION.ALWAYS);
  store.retain("b", "bbb", RETENTION.ALWAYS);
  store.retain("c", "ccc", RETENTION.ALWAYS);
  store.retain("d", "ddd", RETENTION.ALWAYS); // evicts "a"
  assert.equal(store.size, 3);
  assert.equal(store.recover("a"), null);
  assert.equal(store.recover("d"), "ddd");
});

test("evicts to satisfy the byte cap", () => {
  const store = new RawOutputStore({ maxEntries: 100, maxBytes: 10 });
  store.retain("a", "12345", RETENTION.ALWAYS); // 5 bytes
  store.retain("b", "67890", RETENTION.ALWAYS); // 5 bytes (total 10, ok)
  store.retain("c", "X", RETENTION.ALWAYS);     // pushes over -> evicts "a"
  assert.equal(store.recover("a"), null);
  assert.ok(store.totalBytes <= 10);
});

test("a single output larger than the cap is never retained", () => {
  const store = new RawOutputStore({ maxBytes: 4 });
  assert.equal(store.retain("big", "way too large", RETENTION.ALWAYS), false);
  assert.equal(store.size, 0);
});

test("empty text and missing key are not retained", () => {
  const store = new RawOutputStore();
  assert.equal(store.retain("k", "", RETENTION.ALWAYS), false);
  assert.equal(store.retain("", "text", RETENTION.ALWAYS), false);
});

test("re-retaining a key replaces and keeps byte accounting correct", () => {
  const store = new RawOutputStore();
  store.retain("k", "12345", RETENTION.ALWAYS);
  store.retain("k", "67", RETENTION.ALWAYS);
  assert.equal(store.size, 1);
  assert.equal(store.recover("k"), "67");
  assert.equal(store.totalBytes, 2);
});
