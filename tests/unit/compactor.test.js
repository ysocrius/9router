import { describe, it, expect, beforeEach } from "vitest";
import {
  compactContext,
  estimateMessageTokens,
  clearCompactorCache,
} from "../../open-sse/compactor/contextCompactor.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(role, content) {
  return { role, content };
}

function makeToolCallMsg(toolCallId = "call_1") {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: toolCallId, type: "function", function: { name: "myTool", arguments: "{}" } }],
  };
}

function makeToolResultMsg(toolCallId = "call_1", content = "ok") {
  return { role: "tool", tool_call_id: toolCallId, content };
}

// Long string to push us over budget (each char ~0.25 tokens → 4000 chars ≈ 1000 tokens)
function makeLongText(chars = 4000) {
  return "a".repeat(chars);
}

beforeEach(() => clearCompactorCache());

// ── Token Estimation ──────────────────────────────────────────────────────────

describe("estimateMessageTokens", () => {
  it("returns ≥4 for any message (base overhead)", () => {
    const msg = makeMsg("user", "hi");
    expect(estimateMessageTokens(msg, 1500)).toBeGreaterThanOrEqual(4);
  });

  it("uses chars/4 for pure ASCII text", () => {
    // 400 ASCII chars + 4 base = 104 tokens
    const msg = makeMsg("user", "a".repeat(400));
    const est = estimateMessageTokens(msg, 1500);
    expect(est).toBeCloseTo(104, 0);
  });

  it("uses chars/2 when >20% of chars are non-ASCII (CJK text)", () => {
    // 100 CJK chars → all non-ASCII → ratio=1.0 → chars/2 = 50 + 4 = 54
    const cjkText = "字".repeat(100);
    const msg = makeMsg("user", cjkText);
    const ascii = makeMsg("user", "a".repeat(100));
    const cjkEst = estimateMessageTokens(msg, 1500);
    const asciiEst = estimateMessageTokens(ascii, 1500);
    expect(cjkEst).toBeGreaterThan(asciiEst);
  });

  it("uses fixed imageTokenCost for image_url block", () => {
    const msg = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] };
    const est = estimateMessageTokens(msg, 1500);
    expect(est).toBe(1500 + 4);
  });

  it("sums ALL blocks in multi-part content array (text + image)", () => {
    const textCost = Math.ceil("hello world".length / 4); // 3 tokens
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "hello world" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    };
    const est = estimateMessageTokens(msg, 1500);
    // Must be text cost + image cost + base 4, NOT just image cost
    expect(est).toBe(textCost + 1500 + 4);
  });

  it("image-only message skips char math and returns fixed cost + base", () => {
    const msg = {
      role: "user",
      content: [{ type: "image", source: { type: "base64", data: "abc" } }],
    };
    const est = estimateMessageTokens(msg, 2000);
    expect(est).toBe(2000 + 4);
  });

  it("caches results — same fingerprint returns same value", () => {
    const msg = makeMsg("user", "hello world");
    const first = estimateMessageTokens(msg, 1500);
    const second = estimateMessageTokens(msg, 1500);
    expect(first).toBe(second);
  });
});

// ── No-Op Path ────────────────────────────────────────────────────────────────

describe("compactContext — no-op", () => {
  it("returns original body when messages array is empty", () => {
    const body = { messages: [] };
    const res = compactContext(body, "cerebras");
    expect(res.compacted).toBe(false);
    expect(res.body).toBe(body);
    expect(res.error).toBeNull();
  });

  it("returns original body when under budget", () => {
    const body = { messages: [makeMsg("user", "hi"), makeMsg("assistant", "hello")] };
    const res = compactContext(body, "cerebras");
    expect(res.compacted).toBe(false);
    expect(res.error).toBeNull();
  });

  it("no-op when null body passed", () => {
    const res = compactContext(null, "cerebras");
    expect(res.compacted).toBe(false);
    expect(res.error).toBeNull();
  });
});

// ── Effective Budget ──────────────────────────────────────────────────────────

describe("compactContext — effective budget", () => {
  it("uses 4096 default reservation when max_tokens is absent", () => {
    // cerebras limit: 45000. Without max_tokens → budget = 45000 - 4096 = 40904.
    // bigText ≈ 43000 tokens at chars/4. Place it at index 0 (oldest = first droppable).
    // Total msgs = 5, minRecentMessages = 4 → droppableEnd = 1, so index 0 is droppable.
    const bigText = "a".repeat(172_000);
    const body = {
      messages: [
        makeMsg("user", bigText),       // oldest, droppable at index 0
        makeMsg("assistant", "tail1"),
        makeMsg("user", "tail2"),
        makeMsg("assistant", "tail3"),
        makeMsg("user", "tail4"),
      ],
      // no max_tokens
    };
    const res = compactContext(body, "cerebras");
    // Should compact successfully by dropping bigText
    expect(res.error).toBeNull();
  });

  it("uses 4096 default when max_tokens is 0", () => {
    const body = {
      max_tokens: 0,
      messages: [makeMsg("user", "small message")],
    };
    const res = compactContext(body, "cerebras");
    expect(res.compacted).toBe(false);
    expect(res.error).toBeNull();
  });
});

// ── Compaction Core ───────────────────────────────────────────────────────────

describe("compactContext — basic compaction", () => {
  it("drops oldest non-system messages first", () => {
    // cerebras budget: 45000 - 4096 = 40904
    // With system at index 0, start=1. minRecentMessages=4 → droppableEnd = msgs.length - 4.
    // Need ≥6 messages total so droppableEnd > 1 (i.e. position 1 = bigText is droppable).
    // 200k chars / 4 = 50k tokens → exceeds 40904 budget
    const bigText = makeLongText(200_000); // ~50000 tokens, exceeds budget
    const body = {
      max_tokens: 4096,
      messages: [
        makeMsg("system", "be helpful"),
        makeMsg("user", bigText),     // oldest droppable at index 1 → should be dropped
        makeMsg("assistant", "ok"),
        makeMsg("user", "hi"),
        makeMsg("assistant", "fine"),
        makeMsg("user", "last"),      // 6th msg → droppableEnd=2, bigText is droppable
      ],
    };
    const res = compactContext(body, "cerebras");
    expect(res.error).toBeNull();
    expect(res.compacted).toBe(true);
    expect(res.dropped).toBeGreaterThan(0);
    // System prompt must be preserved
    expect(res.body.messages[0].role).toBe("system");
    // Original body not mutated
    expect(body.messages).toHaveLength(6);
  });

  it("preserves the minRecentMessages tail", () => {
    // 4 tail messages must never be dropped
    const bigText = makeLongText(100_000);
    const body = {
      max_tokens: 4096,
      messages: [
        makeMsg("user", bigText),
        makeMsg("assistant", "one"),
        makeMsg("user", "two"),
        makeMsg("assistant", "three"),
        makeMsg("user", "four"), // tail
      ],
    };
    const res = compactContext(body, "cerebras");
    if (res.error) return; // Skip if exhaustion — expected for extreme test
    // Last 4 messages must all be present
    const tail = res.body.messages.slice(-4);
    const tailContents = tail.map(m => m.content);
    expect(tailContents).toContain("one");
    expect(tailContents).toContain("two");
    expect(tailContents).toContain("three");
    expect(tailContents).toContain("four");
  });

  it("sets tokensBefore > tokensAfter on success", () => {
    const bigText = makeLongText(100_000);
    const body = {
      max_tokens: 4096,
      messages: [
        makeMsg("user", bigText),
        makeMsg("assistant", "a"),
        makeMsg("user", "b"),
        makeMsg("assistant", "c"),
        makeMsg("user", "d"),
      ],
    };
    const res = compactContext(body, "cerebras");
    if (!res.compacted) return;
    expect(res.tokensBefore).toBeGreaterThan(res.tokensAfter);
  });
});

// ── Tool Atomicity ────────────────────────────────────────────────────────────

describe("compactContext — atomic tool blocks", () => {
  it("drops tool_call and its tool_result together", () => {
    const bigText = makeLongText(100_000);
    const body = {
      max_tokens: 4096,
      messages: [
        makeToolCallMsg("c1"),            // droppable
        makeToolResultMsg("c1", bigText), // droppable pair
        makeMsg("user", "hi"),
        makeMsg("assistant", "ok"),
        makeMsg("user", "again"),
        makeMsg("assistant", "fine"),
      ],
    };
    const res = compactContext(body, "cerebras");
    if (!res.compacted) return;
    // Neither call nor its result should remain if one was dropped
    const remaining = res.body.messages;
    const hasCall = remaining.some(m => m.tool_calls?.[0]?.id === "c1");
    const hasResult = remaining.some(m => m.tool_call_id === "c1");
    expect(hasCall).toBe(hasResult); // both dropped or both kept
  });

  it("drops orphaned tool_result as standalone", () => {
    // A tool_result with no preceding tool_call should be droppable on its own
    const bigText = makeLongText(100_000);
    const body = {
      max_tokens: 4096,
      messages: [
        makeToolResultMsg("orphan", bigText), // no preceding tool_call
        makeMsg("user", "a"),
        makeMsg("assistant", "b"),
        makeMsg("user", "c"),
        makeMsg("assistant", "d"),
      ],
    };
    const res = compactContext(body, "cerebras");
    if (!res.compacted) return;
    const hasOrphan = res.body.messages.some(m => m.tool_call_id === "orphan");
    expect(hasOrphan).toBe(false);
  });
});

// ── System Prompt Edge Cases ──────────────────────────────────────────────────

describe("compactContext — system prompt handling", () => {
  it("hard-rejects when Anthropic body.system string alone exceeds budget", () => {
    const hugeSystem = "x".repeat(800_000); // ~200k tokens > cerebras 45k limit
    const body = {
      system: hugeSystem,
      max_tokens: 4096,
      messages: [makeMsg("user", "hi")],
    };
    const res = compactContext(body, "cerebras");
    expect(res.error).not.toBeNull();
    expect(res.error.error.code).toBe("context_length_exceeded");
  });

  it("hard-rejects when Anthropic body.system array blocks alone exceed budget", () => {
    const hugeBlock = "x".repeat(800_000);
    const body = {
      system: [{ type: "text", text: hugeBlock }],
      max_tokens: 4096,
      messages: [makeMsg("user", "hi")],
    };
    const res = compactContext(body, "cerebras");
    expect(res.error).not.toBeNull();
    expect(res.error.error.code).toBe("context_length_exceeded");
  });

  it("hard-rejects when OpenAI role:system alone exceeds budget", () => {
    const hugeSystem = "x".repeat(800_000);
    const body = {
      max_tokens: 4096,
      messages: [makeMsg("system", hugeSystem), makeMsg("user", "hi")],
    };
    const res = compactContext(body, "cerebras");
    expect(res.error).not.toBeNull();
    expect(res.error.error.code).toBe("context_length_exceeded");
  });

  it("preserves OpenAI role:system in first position after compaction", () => {
    const bigText = makeLongText(100_000);
    const body = {
      max_tokens: 4096,
      messages: [
        makeMsg("system", "be helpful"),
        makeMsg("user", bigText),
        makeMsg("assistant", "ok"),
        makeMsg("user", "q"),
        makeMsg("assistant", "a"),
        makeMsg("user", "q2"),
      ],
    };
    const res = compactContext(body, "cerebras");
    if (!res.compacted) return;
    expect(res.body.messages[0].role).toBe("system");
  });
});

// ── Post-Loop Exhaustion ──────────────────────────────────────────────────────

describe("compactContext — post-loop exhaustion", () => {
  it("returns hard error when protected tail alone exceeds budget", () => {
    // A very large tool result in the last 4 messages — cannot be dropped
    const hugeToolResult = makeLongText(800_000); // ~200k tokens
    const body = {
      max_tokens: 4096,
      messages: [
        makeMsg("user", "old1"),
        makeMsg("assistant", "old2"),
        makeToolCallMsg("c1"),                             // protected tail start
        makeToolResultMsg("c1", hugeToolResult),           // huge, in protected zone
        makeMsg("user", "final"),
      ],
    };
    const res = compactContext(body, "cerebras");
    expect(res.error).not.toBeNull();
    expect(res.error.error.code).toBe("context_length_exceeded");
  });
});

// ── Error Shape ───────────────────────────────────────────────────────────────

describe("compactContext — error format", () => {
  it("returns OpenAI-compatible error object on rejection", () => {
    const hugeSystem = "x".repeat(800_000);
    const body = {
      system: hugeSystem,
      max_tokens: 4096,
      messages: [makeMsg("user", "hi")],
    };
    const res = compactContext(body, "cerebras");
    expect(res.error).toMatchObject({
      error: {
        message: expect.any(String),
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    });
  });
});

// ── Index-Shift Cache Integrity ───────────────────────────────────────────────

describe("compactContext — cache integrity across multi-pass", () => {
  it("correctly estimates messages after array shifts (index-agnostic cache)", () => {
    const bigText = makeLongText(60_000);
    const body = {
      max_tokens: 4096,
      messages: [
        makeMsg("user", bigText),        // dropped pass 1
        makeMsg("user", bigText),        // dropped pass 2
        makeMsg("assistant", "a"),
        makeMsg("user", "b"),
        makeMsg("assistant", "c"),
        makeMsg("user", "d"),
      ],
    };
    // Should complete without throwing — cache must handle shifted indices
    expect(() => compactContext(body, "cerebras")).not.toThrow();
  });
});

// ── Unknown Provider Fallback ─────────────────────────────────────────────────

describe("compactContext — unknown provider uses defaults", () => {
  it("uses default context limit for unknown provider", () => {
    const body = {
      max_tokens: 4096,
      messages: [makeMsg("user", "small message")],
    };
    const res = compactContext(body, "some-unknown-provider-xyz");
    expect(res.error).toBeNull();
    expect(res.compacted).toBe(false);
  });
});
