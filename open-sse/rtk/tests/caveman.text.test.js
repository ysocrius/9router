// Phase 2 — input-side caveman text rewrite tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compressTextMessage, compressBodyText } from "../cavemanText.js";
import { shouldAttemptRule } from "../cavemanRules.js";

test("removes pleasantries/politeness from long prose", () => {
  const text =
    "Sure, I would be happy to help. Could you please go ahead and refactor " +
    "this module so that it is a bit cleaner and basically easier to read?";
  const r = compressTextMessage(text);
  assert.equal(r.changed, true);
  assert.ok(r.text.length < text.length, "text shrank");
  assert.ok(!/could you please/i.test(r.text), "politeness removed");
});

test("never touches code, paths, or identifiers in mixed prose", () => {
  const text =
    "Please could you simply run `npm run build` and then open src/app/main.ts " +
    "and set the MAX_BUFFER_SIZE constant, basically because it is important to fix it.";
  const r = compressTextMessage(text);
  assert.ok(r.text.includes("`npm run build`"), "command intact");
  assert.ok(r.text.includes("src/app/main.ts"), "path intact");
  assert.ok(r.text.includes("MAX_BUFFER_SIZE"), "identifier intact");
});

test("returns original text verbatim when no rule fires", () => {
  const text = "Refactor the parser to support nested arrays and emit a typed AST node.";
  const r = compressTextMessage(text);
  assert.equal(r.changed, false);
  assert.equal(r.text, text);
});

test("skips messages below the min length", () => {
  const text = "please fix this";
  const r = compressTextMessage(text);
  assert.equal(r.changed, false);
  assert.equal(r.text, text);
});

test("rule prefilter: a no-keyword text attempts zero keyworded rules", () => {
  // Pure code-review prose containing none of the trigger keywords.
  const lower = "refactor the parser and emit a typed ast node for arrays".toLowerCase();
  // These keyworded rules must all decline.
  for (const name of ["pleasantries", "polite_framing", "hedging", "excessive_gratitude"]) {
    assert.equal(shouldAttemptRule(name, lower), false, name);
  }
});

test("compressBodyText only rewrites user-role messages", () => {
  const body = {
    messages: [
      { role: "system", content: "Please be sure to always respond politely and kindly." },
      { role: "user", content: "Sure, could you please simply refactor this for me, I'd really appreciate it a lot here." },
      { role: "assistant", content: "Of course, I am happy to help with that right away here." },
    ],
  };
  const before = body.messages.map((m) => m.content);
  const stats = compressBodyText(body, true);
  assert.ok(stats, "stats returned");
  assert.equal(body.messages[0].content, before[0], "system untouched");
  assert.equal(body.messages[2].content, before[2], "assistant untouched");
  assert.ok(body.messages[1].content.length <= before[1].length, "user shrank or equal");
});

test("compressBodyText is a no-op when disabled (default OFF)", () => {
  const body = { messages: [{ role: "user", content: "Sure, could you please help me out here a lot, thanks so much." }] };
  const before = body.messages[0].content;
  const stats = compressBodyText(body, false);
  assert.equal(stats, null);
  assert.equal(body.messages[0].content, before);
});

test("output is never empty and never larger than input", () => {
  const samples = [
    "Sure, thanks so much, could you please just simply help me here a bit.",
    "Refactor `foo()` in src/x.ts now.",
    "x".repeat(200),
  ];
  for (const text of samples) {
    const r = compressTextMessage(text);
    assert.ok(r.text.length > 0, "never empty");
    assert.ok(r.text.length <= text.length, "never grows");
  }
});

test("idempotent: rewriting already-compressed text changes nothing further", () => {
  const text =
    "Sure, I would be happy to help. Could you please refactor this module so " +
    "that it is a bit cleaner and basically easier to read for everyone here.";
  const once = compressTextMessage(text).text;
  const twice = compressTextMessage(once).text;
  assert.equal(twice, once);
});
