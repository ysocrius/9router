// Phase 1 — Gemini contents[] coverage + locked string-detection tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compressMessages } from "../index.js";

// Build a Gemini body with one functionResponse leaf at response.result.
function geminiBody(name, response, { envelope = false } = {}) {
  const content = { role: "user", parts: [{ functionResponse: { name, response } }] };
  return envelope ? { request: { contents: [content] } } : { contents: [content] };
}

// A long, compressible plain-text shell output (git status style, > MIN_COMPRESS_SIZE).
function longGitStatus() {
  const head = "On branch main\nYour branch is up to date with 'origin/main'.\n\nChanges not staged for commit:\n";
  const body = Array.from({ length: 80 }, (_, i) => `\tmodified:   src/file_${i}.js`).join("\n");
  return head + body + "\n";
}

test("compresses a free-form text leaf from a shell tool (case 3)", () => {
  const text = longGitStatus();
  const body = geminiBody("run_command", { result: text });
  const stats = compressMessages(body, true);
  const out = body.contents[0].parts[0].functionResponse.response.result;
  assert.ok(stats, "stats returned");
  assert.ok(out.length < text.length, "shell output was reduced");
  assert.ok(out.length > 0, "never empty");
});

test("skips a string leaf that is valid JSON (case 2, byte-identical)", () => {
  const json = JSON.stringify({ files: Array.from({ length: 50 }, (_, i) => `f${i}.js`) });
  const body = geminiBody("run_command", { result: json });
  compressMessages(body, true);
  const out = body.contents[0].parts[0].functionResponse.response.result;
  assert.equal(out, json, "JSON-as-string left untouched");
});

test("skips an already-parsed object leaf (case 1, untouched)", () => {
  const obj = { files: ["a.js", "b.js"], count: 2 };
  const body = geminiBody("run_command", { result: obj });
  compressMessages(body, true);
  const out = body.contents[0].parts[0].functionResponse.response.result;
  assert.deepEqual(out, obj, "object leaf untouched");
});

test("walks the deeper result.result path (OpenAI->Gemini shape)", () => {
  const text = longGitStatus();
  const body = geminiBody("run_command", { result: { result: text } });
  compressMessages(body, true);
  const out = body.contents[0].parts[0].functionResponse.response.result.result;
  assert.ok(out.length < text.length, "deeper leaf compressed");
});

test("does NOT shell-filter a read_file output, but safe passes still apply", () => {
  // Duplicate lines so dedup (content-agnostic) can still reduce, but the
  // git/grep/build shell filters must NOT fire on a read tool.
  const dup = Array.from({ length: 40 }, () => "const x = 1;").join("\n");
  const padded = "function f() {\n" + dup + "\n}\n" + "x".repeat(600);
  const body = geminiBody("read_file", { result: padded });
  compressMessages(body, true);
  const out = body.contents[0].parts[0].functionResponse.response.result;
  // Output stays valid (never empty, never grows). Dedup may collapse the run.
  assert.ok(out.length > 0);
  assert.ok(out.length <= padded.length);
});

test("skips error payloads (status === error)", () => {
  const text = longGitStatus();
  const body = geminiBody("run_command", { result: text, status: "error" });
  compressMessages(body, true);
  const out = body.contents[0].parts[0].functionResponse.response.result;
  assert.equal(out, text, "error payload untouched");
});

test("handles the request.contents[] envelope (Gemini-CLI/Antigravity)", () => {
  const text = longGitStatus();
  const body = geminiBody("run_command", { result: text }, { envelope: true });
  compressMessages(body, true);
  const out = body.request.contents[0].parts[0].functionResponse.response.result;
  assert.ok(out.length < text.length, "envelope leaf compressed");
});

test("returns null and no-ops when disabled", () => {
  const text = longGitStatus();
  const body = geminiBody("run_command", { result: text });
  const stats = compressMessages(body, false);
  assert.equal(stats, null);
  assert.equal(body.contents[0].parts[0].functionResponse.response.result, text);
});

test("output is never empty and never larger than input across leaves", () => {
  const samples = [longGitStatus(), "x".repeat(700), "short"];
  for (const text of samples) {
    const body = geminiBody("run_command", { result: text });
    compressMessages(body, true);
    const out = body.contents[0].parts[0].functionResponse.response.result;
    assert.ok(out.length > 0, "never empty");
    assert.ok(out.length <= text.length, "never grows");
  }
});
