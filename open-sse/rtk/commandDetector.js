// Command-aware gating for RTK (focused JS port of OmniRoute engines-rtk/commandDetector.ts).
//
// Purpose: decide whether a tool output is eligible for the shell-output filters
// (git-status/grep/build/ls/tree/...). RTK's shell filters were written for *raw
// command output*. Running them on structured tool results (a read_file dump, a
// grep_search result the harness already formatted, an edit confirmation) risks
// content-based false positives — e.g. a .ts file that happens to match a build
// filter. The gate keeps shell filters on shell results only.
//
// Two entry points:
//   - Name-based (Gemini / any tool-name flow): Gemini's functionResponse carries
//     no tool_call_id, only `name`. categorizeToolName(name) maps that to a category;
//     isShellEligibleToolName(name) is the binary gate.
//   - Command/text-based (when a command string is available): detectCommandFromText
//     sniffs the first lines, isShellCommand checks the prefix allow-list.

// Tool names whose output is RAW shell/terminal output → eligible for shell filters.
const SHELL_TOOL_NAMES = new Set([
  "run_command", "run_terminal_cmd", "runcommand", "run_in_terminal",
  "execute_command", "executebash", "executecommand", "launch-process",
  "bash", "shell", "terminal", "command", "run", "exec", "sh", "powershell", "cmd",
]);

// Tool names whose output is STRUCTURED / harness-formatted → never shell-filtered.
// (Still eligible for the content-agnostic safe passes: dedup + smart-truncate.)
const READ_TOOL_NAMES = new Set([
  "read_file", "view_file", "read", "readfile", "open", "cat_file", "open_file",
]);
const SEARCH_TOOL_NAMES = new Set([
  "grep_search", "grep", "search", "codebase_search", "file_search",
  "search_files", "findreferences", "find_references", "glob_search",
]);
const EDIT_TOOL_NAMES = new Set([
  "edit_file", "replace_file_content", "multi_replace_file_content",
  "write_to_file", "write", "str_replace", "apply_diff", "create_file",
  "edit", "insert", "delete_file",
]);
const LIST_TOOL_NAMES = new Set([
  "list_dir", "ls", "list_directory", "find", "glob", "tree",
]);

/**
 * Map a tool name to a coarse category used for gating.
 * @param {string} name
 * @returns {"shell"|"read"|"search"|"edit"|"list"|"unknown"}
 */
export function categorizeToolName(name) {
  if (typeof name !== "string" || name.length === 0) return "unknown";
  const n = name.trim().toLowerCase();
  if (SHELL_TOOL_NAMES.has(n)) return "shell";
  if (READ_TOOL_NAMES.has(n)) return "read";
  if (SEARCH_TOOL_NAMES.has(n)) return "search";
  if (EDIT_TOOL_NAMES.has(n)) return "edit";
  if (LIST_TOOL_NAMES.has(n)) return "list";
  return "unknown";
}

/**
 * Binary gate: may shell filters run on output from this tool name?
 * Unknown names are NOT shell-eligible (safe default) and should be logged as
 * `unknown-tool` by the caller.
 * @param {string} name
 * @returns {boolean}
 */
export function isShellEligibleToolName(name) {
  return categorizeToolName(name) === "shell";
}

// Command prefixes that indicate raw shell output (used when a command string is
// available rather than a tool name). Mirrors OmniRoute's COMMAND_PREFIXES.
const COMMAND_PREFIXES = [
  "git", "make", "terraform", "tofu", "opentofu", "systemctl", "npm", "pnpm",
  "yarn", "vitest", "jest", "pytest", "python", "go", "cargo", "tsc", "eslint",
  "webpack", "vite", "biome", "prettier", "turbo", "nx", "playwright", "ruff",
  "mypy", "pip", "uv", "poetry", "golangci-lint", "bundle", "rubocop", "kubectl",
  "composer", "gh", "docker", "aws", "gcloud", "ssh", "rsync", "curl", "wget",
  "ls", "find", "grep", "rg", "ag", "ps", "df", "du", "cat", "tail", "head",
  "echo", "sed", "awk", "node", "deno", "bun", "rustc", "javac", "mvn", "gradle",
];

const COMMAND_PREFIX_PATTERN = new RegExp(`^(?:${COMMAND_PREFIXES.join("|")})\\b`, "i");

/**
 * Sniff a command from the first few lines of output (OmniRoute parity:
 * strips a leading "$ " prompt, checks the prefix allow-list).
 * @param {string} text
 * @returns {string|null}
 */
export function detectCommandFromText(text) {
  if (typeof text !== "string") return null;
  const firstLines = text.split(/\r?\n/).slice(0, 4);
  for (const line of firstLines) {
    const trimmed = line.trim().replace(/^\$\s+/, "");
    if (!trimmed) continue;
    if (COMMAND_PREFIX_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Is this command string raw shell output? A command is shell-eligible when it
 * starts with one of the known prefixes.
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isShellCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) return false;
  return COMMAND_PREFIX_PATTERN.test(command.trim());
}

/**
 * Unified gate decision. Prefers an explicit tool name (Gemini path); otherwise
 * falls back to a command string or sniffs the text. Returns the resolved
 * category and the binary shell-eligibility used by compressText.
 * @param {string} text
 * @param {{ name?: string|null, command?: string|null }} [hints]
 * @returns {{ category: string, shellEligible: boolean, source: string }}
 */
export function detectCommandType(text, hints = {}) {
  const { name, command } = hints;

  if (typeof name === "string" && name.length > 0) {
    const category = categorizeToolName(name);
    return { category, shellEligible: category === "shell", source: "tool-name" };
  }

  const resolved = (typeof command === "string" && command.trim()) || detectCommandFromText(text);
  if (resolved) {
    return { category: "shell", shellEligible: isShellCommand(resolved), source: "command" };
  }

  // No name, no command, nothing sniffable → unknown, not shell-eligible.
  return { category: "unknown", shellEligible: false, source: "none" };
}
