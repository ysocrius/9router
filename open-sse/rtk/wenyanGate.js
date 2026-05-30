// Phase 3 — Wenyan gate (decides whether wenyan is ever built).
// LOCKED DECISION: wenyan ships only if it records a reduction delta of
// >= 10 PERCENTAGE POINTS over `ultra` on the fixed corpus. The number is
// binding, not advisory.
//
// Critical honesty: wenyan and the ultra/full/lite levels are OUTPUT-SIDE
// prompt injections. Their benefit appears in the MODEL'S RESPONSE, which only
// exists after a live round-trip. There is no way to measure this offline.
// Therefore this module does NOT fabricate a number. It evaluates recorded
// response samples if the user provides them, and otherwise reports the gate
// as UNDECIDED -> wenyan stays unbuilt. That is the disciplined default.

export const WENYAN_GATE = {
  // Binding threshold: reduction delta over `ultra`, in percentage points.
  minDeltaPoints: 10,
};

// Estimate response "size" the way the proxy bills it: bytes is a fine proxy
// for tokens within a single language, but wenyan switches prose to Classical
// Chinese, so we compare by a token estimate (chars are not comparable across
// scripts). This estimate is intentionally crude and only used for the gate.
function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  // Mixed heuristic: CJK chars count ~1 token each; latin words ~1 token per
  // 4 chars. This avoids unfairly favoring wenyan just because CJK is denser
  // per character.
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9fff) cjk++;
  }
  const nonCjkChars = text.length - cjk;
  return cjk + Math.ceil(nonCjkChars / 4);
}

// Given paired samples [{ ultra: string, wenyan: string }], compute the mean
// reduction delta in percentage points. Each pair must be the SAME underlying
// response produced under the two levels (recorded from a live model).
export function evaluateRecordedSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { decided: false, reason: "no recorded samples provided", deltaPoints: null };
  }

  let ultraTotal = 0;
  let ultraReduced = 0;
  let wenyanReduced = 0;
  let baselineTotal = 0;

  for (const s of samples) {
    if (typeof s.baseline !== "string" || typeof s.ultra !== "string" || typeof s.wenyan !== "string") {
      return { decided: false, reason: "samples must include baseline/ultra/wenyan strings", deltaPoints: null };
    }
    const base = estimateTokens(s.baseline);
    baselineTotal += base;
    ultraTotal += base;
    ultraReduced += base - estimateTokens(s.ultra);
    wenyanReduced += base - estimateTokens(s.wenyan);
  }

  if (baselineTotal === 0) {
    return { decided: false, reason: "baseline is empty", deltaPoints: null };
  }

  const ultraPct = (ultraReduced / ultraTotal) * 100;
  const wenyanPct = (wenyanReduced / baselineTotal) * 100;
  const deltaPoints = wenyanPct - ultraPct;

  return {
    decided: true,
    deltaPoints,
    ultraPct,
    wenyanPct,
    passes: deltaPoints >= WENYAN_GATE.minDeltaPoints,
    sampleCount: samples.length,
  };
}

// Top-level gate decision. Returns whether wenyan should be built.
export function decideWenyanGate(recordedSamples) {
  const evalResult = evaluateRecordedSamples(recordedSamples);
  if (!evalResult.decided) {
    return {
      build: false,
      status: "UNDECIDED",
      detail: `${evalResult.reason}; wenyan stays UNBUILT (gate needs live-model data showing >= ${WENYAN_GATE.minDeltaPoints} pts over ultra)`,
    };
  }
  return {
    build: evalResult.passes,
    status: evalResult.passes ? "PASS" : "FAIL",
    detail: `wenyan delta = ${evalResult.deltaPoints.toFixed(1)} pts over ultra ` +
      `(ultra ${evalResult.ultraPct.toFixed(1)}%, wenyan ${evalResult.wenyanPct.toFixed(1)}%, ` +
      `n=${evalResult.sampleCount}); gate = ${WENYAN_GATE.minDeltaPoints} pts -> ` +
      (evalResult.passes ? "BUILD" : "stays UNBUILT"),
  };
}

export const _internal = { estimateTokens };
