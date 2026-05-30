// Phase 3 — JSON filter pack loader + schema tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePack, packMatches } from "../filterSchema.js";
import {
  loadPacks, findMatchingPack, applyPack, _resetCache, _getInvokeCount,
} from "../filterLoader.js";

test("a valid pack passes validation", () => {
  const { valid, errors } = validatePack({
    name: "docker",
    match: { commandPrefixes: ["docker"] },
    rules: [{ dropMatching: "^\\s*$" }],
  });
  assert.equal(valid, true, errors.join("; "));
});

test("a malformed pack is rejected with errors", () => {
  assert.equal(validatePack(null).valid, false);
  assert.equal(validatePack({ name: "x", rules: [] }).valid, false); // empty rules + no match
  assert.equal(validatePack({ name: "", match: { keywords: ["k"] }, rules: [{ dropMatching: "a" }] }).valid, false);
});

test("a rule with an uncompilable regex rejects the pack", () => {
  const { valid, errors } = validatePack({
    name: "bad",
    match: { keywords: ["x"] },
    rules: [{ pattern: "(unclosed", flags: "g", replacement: "" }],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /does not compile/.test(e)));
});

test("a rule needs exactly one of replacement or dropMatching", () => {
  const both = validatePack({
    name: "x", match: { keywords: ["x"] },
    rules: [{ pattern: "a", replacement: "b", dropMatching: "c" }],
  });
  assert.equal(both.valid, false);
});

test("packMatches keys on command prefix and on keywords", () => {
  const pack = { match: { commandPrefixes: ["docker"], keywords: ["CONTAINER ID"] } };
  assert.equal(packMatches(pack, { command: "docker ps -a" }), true);
  assert.equal(packMatches(pack, { text: "CONTAINER ID   IMAGE" }), true);
  assert.equal(packMatches(pack, { command: "git status" }), false);
});

test("applyPack drops blank lines and caps line count", () => {
  const pack = {
    name: "t", match: { keywords: ["x"] }, maxLines: 5,
    rules: [{ dropMatching: "^\\s*$" }],
  };
  const input = "a\n\n\nb\nc\nd\ne\nf\ng\nh\n";
  const out = applyPack(pack, input);
  assert.ok(!/\n\n\n/.test(out), "blank runs gone");
  assert.ok(out.split("\n").length <= 6, "capped (+marker)");
  assert.match(out, /dropped \d+ lines/);
});

test("packs load lazily: loader not invoked until first request", async () => {
  _resetCache();
  assert.equal(_getInvokeCount(), 0, "no disk access before first use");
  await loadPacks();
  assert.equal(_getInvokeCount(), 1, "loaded once");
  await loadPacks(); // cached -> no second scan
  assert.equal(_getInvokeCount(), 1, "cached, not re-scanned");
});

test("the bundled docker pack loads and matches docker output", async () => {
  _resetCache();
  const pack = await findMatchingPack({ command: "docker ps" });
  assert.ok(pack, "docker pack found");
  assert.equal(pack.name, "docker");
});

test("empty input is preserved and global flag replaces all matches", () => {
  // Without the g flag only the first match is replaced (standard regex semantics).
  const firstOnly = { name: "t", match: { keywords: ["x"] }, rules: [{ pattern: "a", replacement: "b" }] };
  assert.equal(applyPack(firstOnly, ""), "");
  assert.equal(applyPack(firstOnly, "aaa"), "baa");

  // With the g flag every match is replaced.
  const global = { name: "t", match: { keywords: ["x"] }, rules: [{ pattern: "a", flags: "g", replacement: "b" }] };
  assert.equal(applyPack(global, "aaa"), "bbb");
});
