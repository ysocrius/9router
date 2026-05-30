// Phase 1 — command-aware gating tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categorizeToolName,
  isShellEligibleToolName,
  detectCommandFromText,
  isShellCommand,
  detectCommandType,
} from "../commandDetector.js";

test("shell tool names are shell-eligible", () => {
  for (const n of ["run_command", "bash", "terminal", "run_terminal_cmd", "shell"]) {
    assert.equal(categorizeToolName(n), "shell", n);
    assert.equal(isShellEligibleToolName(n), true, n);
  }
});

test("read/search/edit/list tool names are never shell-eligible", () => {
  const cases = [
    ["read_file", "read"],
    ["view_file", "read"],
    ["grep_search", "search"],
    ["codebase_search", "search"],
    ["edit_file", "edit"],
    ["replace_file_content", "edit"],
    ["list_dir", "list"],
  ];
  for (const [name, cat] of cases) {
    assert.equal(categorizeToolName(name), cat, name);
    assert.equal(isShellEligibleToolName(name), false, name);
  }
});

test("unknown tool names fall through as unknown, not shell", () => {
  assert.equal(categorizeToolName("frobnicate_widget"), "unknown");
  assert.equal(isShellEligibleToolName("frobnicate_widget"), false);
  assert.equal(categorizeToolName(""), "unknown");
  assert.equal(categorizeToolName(null), "unknown");
});

test("tool name matching is case-insensitive and trimmed", () => {
  assert.equal(categorizeToolName("  RUN_COMMAND  "), "shell");
  assert.equal(categorizeToolName("Read_File"), "read");
});

test("detectCommandFromText sniffs a known prefix from the first lines", () => {
  assert.equal(detectCommandFromText("$ git status\nOn branch main"), "git status");
  assert.equal(detectCommandFromText("npm install\nadded 1 package"), "npm install");
  assert.equal(detectCommandFromText("just some prose\nno command here"), null);
});

test("isShellCommand recognizes allow-listed prefixes only", () => {
  assert.equal(isShellCommand("git diff"), true);
  assert.equal(isShellCommand("docker ps"), true);
  assert.equal(isShellCommand("frobnicate --all"), false);
  assert.equal(isShellCommand(""), false);
  assert.equal(isShellCommand(null), false);
});

test("detectCommandType prefers an explicit tool name (Gemini path)", () => {
  const shell = detectCommandType("anything", { name: "run_command" });
  assert.equal(shell.category, "shell");
  assert.equal(shell.shellEligible, true);
  assert.equal(shell.source, "tool-name");

  const read = detectCommandType("file contents", { name: "read_file" });
  assert.equal(read.category, "read");
  assert.equal(read.shellEligible, false);
});

test("detectCommandType falls back to command string, then text sniff", () => {
  const byCmd = detectCommandType("output", { command: "git status" });
  assert.equal(byCmd.shellEligible, true);
  assert.equal(byCmd.source, "command");

  const byText = detectCommandType("$ docker ps\nCONTAINER ID");
  assert.equal(byText.shellEligible, true);
  assert.equal(byText.source, "command");

  const none = detectCommandType("plain prose with no command");
  assert.equal(none.category, "unknown");
  assert.equal(none.shellEligible, false);
  assert.equal(none.source, "none");
});
