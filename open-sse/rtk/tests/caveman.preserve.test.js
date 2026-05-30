// Phase 2 — preservation round-trip + validation fallback tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPreservedBlocks,
  restorePreservedBlocks,
  hasProtectedStructure,
} from "../preservation.js";
import { validateCompression } from "../validation.js";

test("code fences survive extraction and restore verbatim", () => {
  const text = "Here is code:\n```js\nconst x = 1;\n```\nDone.";
  const { text: stripped, blocks } = extractPreservedBlocks(text);
  assert.equal(blocks.length, 1);
  assert.ok(!stripped.includes("const x = 1;"), "code lifted out");
  assert.equal(restorePreservedBlocks(stripped, blocks), text);
});

test("inline code, URLs, and paths are each preserved", () => {
  const text = "Run `npm test` see https://example.com/docs and src/a/b.ts please.";
  const { text: stripped, blocks } = extractPreservedBlocks(text);
  assert.ok(blocks.length >= 3, "multiple blocks lifted");
  assert.equal(restorePreservedBlocks(stripped, blocks), text);
});

test("windows paths and CONST_CASE identifiers are preserved", () => {
  const text = "Open C:\\Users\\me\\file.txt and set MAX_RETRY_COUNT to 5.";
  const { text: stripped, blocks } = extractPreservedBlocks(text);
  assert.equal(restorePreservedBlocks(stripped, blocks), text);
  assert.ok(blocks.some((b) => b.includes("C:\\Users")), "win path captured");
});

test("error lines and version numbers are preserved", () => {
  const text = "Got TypeError: cannot read x on version 1.2.3-beta.4 of the lib.";
  const { text: stripped, blocks } = extractPreservedBlocks(text);
  assert.equal(restorePreservedBlocks(stripped, blocks), text);
});

test("text with no structure returns zero blocks unchanged", () => {
  const text = "just some plain prose with no special tokens at all";
  const { text: stripped, blocks } = extractPreservedBlocks(text);
  assert.equal(blocks.length, 0);
  assert.equal(stripped, text);
  assert.equal(hasProtectedStructure(text), false);
});

test("hasProtectedStructure is true when structure is present", () => {
  assert.equal(hasProtectedStructure("see `code`"), true);
  assert.equal(hasProtectedStructure("path src/x.js"), true);
});

test("validation passes an identical-token rewrite", () => {
  const orig = "Please run `npm test` now.";
  const compressed = "Run `npm test` now.";
  const v = validateCompression(orig, compressed);
  assert.equal(v.valid, true, v.errors.join("; "));
});

test("validation fails when a protected token is dropped", () => {
  const orig = "Run `npm test` on src/index.js now.";
  const compressed = "Run `npm test` now."; // dropped the path
  const v = validateCompression(orig, compressed);
  assert.equal(v.valid, false);
  assert.ok(v.errors.length > 0);
});

test("validation fails an emptied or grown output", () => {
  assert.equal(validateCompression("real content here", "   ").valid, false);
  assert.equal(validateCompression("short", "short but now much longer").valid, false);
});

test("validation fails on leftover placeholder sentinel", () => {
  const v = validateCompression("a `b` c", "a \uE0000\uE001 c");
  assert.equal(v.valid, false);
});
