// Fixed benchmark corpus: representative real-world tool outputs and prompts.
// Kept deterministic and in-repo so the latency budget and input-side
// reduction numbers are reproducible run-to-run. No live model is involved
// here — these measure what the input-side engines can do offline.

// --- Tool outputs (what RTK shell filters + dedup + smart-truncate operate on) ---

const gitStatus =
  "On branch main\nYour branch is up to date with 'origin/main'.\n\n" +
  "Changes not staged for commit:\n" +
  "  (use \"git add <file>...\" to update what will be committed)\n" +
  Array.from({ length: 60 }, (_, i) => `\tmodified:   src/components/widget_${i}.tsx`).join("\n") +
  "\n\nUntracked files:\n" +
  Array.from({ length: 40 }, (_, i) => `\tsrc/generated/asset_${i}.json`).join("\n") +
  "\n";

const gitDiff =
  "diff --git a/src/app.js b/src/app.js\n" +
  "index 1a2b3c4..5d6e7f8 100644\n--- a/src/app.js\n+++ b/src/app.js\n" +
  Array.from({ length: 120 }, (_, i) =>
    i % 5 === 0 ? `@@ -${i},7 +${i},7 @@ function block${i}()` :
    i % 3 === 0 ? `+  const added_${i} = compute(${i});` :
    `   const ctx_${i} = ctx.get(${i});`
  ).join("\n") +
  "\n";

const grepOutput =
  Array.from({ length: 50 }, (_, i) =>
    `src/module_${i % 12}/file_${i}.ts:${10 + i}:  const result = handler.process(payload_${i});`
  ).join("\n") + "\n";

const lsOutput =
  Array.from({ length: 80 }, (_, i) =>
    `-rw-r--r--  1 user  staff  ${1000 + i * 37}  Jan ${1 + (i % 28)} 10:${(i % 60).toString().padStart(2, "0")}  file_${i}.js`
  ).join("\n") + "\n";

const buildLogWithDups =
  "Building project...\n" +
  Array.from({ length: 30 }, () => "  warning: unused variable 'x'").join("\n") +
  "\n" +
  Array.from({ length: 20 }, (_, i) => `  compiled module_${i}.ts`).join("\n") +
  "\n  Build succeeded in 4.2s\n";

const npmInstall =
  "npm install\n" +
  Array.from({ length: 45 }, (_, i) => `npm WARN deprecated pkg_${i}@1.0.0: use pkg_${i}-next instead`).join("\n") +
  "\nadded 312 packages in 8s\n";

// --- Verbose user prompts (what input-side Caveman operates on) ---

const verbosePrompt1 =
  "Hi there! Sure, I was wondering if you could please go ahead and basically " +
  "refactor the `parseConfig()` function in src/config/loader.js so that it is " +
  "a bit cleaner and essentially easier to read. Thanks so much in advance, I " +
  "really appreciate it! It is important to keep the MAX_RETRIES constant intact.";

const verbosePrompt2 =
  "I would like you to simply take a look at the following code and, if possible, " +
  "kindly explain why it is throwing a TypeError: cannot read property 'map' of " +
  "undefined. I think that it is probably related to the async handler at " +
  "https://example.com/docs/async, but I am not totally sure about that honestly.";

const leanPrompt =
  "Refactor parseConfig() in src/config/loader.js to stream large files and emit " +
  "a typed Config object. Preserve the MAX_RETRIES behavior.";

export const TOOL_OUTPUTS = [
  { name: "git-status", tool: "run_command", text: gitStatus },
  { name: "git-diff", tool: "run_command", text: gitDiff },
  { name: "grep", tool: "run_command", text: grepOutput },
  { name: "ls", tool: "run_command", text: lsOutput },
  { name: "build-log", tool: "run_command", text: buildLogWithDups },
  { name: "npm-install", tool: "run_command", text: npmInstall },
];

export const USER_PROMPTS = [
  { name: "verbose-1", text: verbosePrompt1 },
  { name: "verbose-2", text: verbosePrompt2 },
  { name: "lean", text: leanPrompt },
];

// Build an OpenAI-shaped body mixing verbose prose + tool outputs, used to
// exercise the full stacked pipeline in one pass.
export function buildMixedBody() {
  const messages = [];
  for (const p of USER_PROMPTS) messages.push({ role: "user", content: p.text });
  for (const t of TOOL_OUTPUTS) messages.push({ role: "tool", content: t.text });
  return { messages };
}

// Build a Gemini-shaped body (functionResponse leaves) from the tool outputs.
export function buildGeminiBody() {
  const parts = TOOL_OUTPUTS.map((t) => ({
    functionResponse: { name: t.tool, response: { result: t.text } },
  }));
  return { contents: [{ role: "user", parts }] };
}
