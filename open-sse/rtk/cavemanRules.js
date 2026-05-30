// Input-side Caveman: English rule set + keyword prefilter.
// Port of OmniRoute's cavemanRules. Each rule is { name, pattern, replacement }.
// A rule's regex only runs when its trigger keyword is present in the text
// (see shouldAttemptRule) — this is the performance optimization that keeps the
// pass cheap on text that has nothing to compress.
//
// Rules operate ONLY on free-form prose. All structure (code, paths, URLs,
// identifiers, error lines) has already been lifted out by preservation.js
// before these run, so they can never corrupt code or commands.

// rule name -> trigger keywords (lowercased substring test). A rule with no
// entry here always attempts (used for the article remover, which is gated by
// its own cheap test instead).
const RULE_KEYWORDS = {
  pleasantries: ["sure", "certainly", "of course", "happy to", "glad to", "no problem", "you're welcome", "absolutely"],
  polite_framing: ["please", "kindly", "could you please", "would you please", "can you please", "i would like you", "i want you", "i need you"],
  hedging: ["it seems like", "it appears that", "i think that", "i believe that", "probably", "possibly"],
  filler_adverbs: ["basically", "essentially", "actually", "literally", "simply", "currently"],
  filler_phrases: ["i want to", "i need to", "i'd like to", "i'm looking for"],
  redundant_openers: ["hi there", "hello", "good morning", "hey"],
  verbose_requests: ["i was wondering", "would it be possible"],
  excessive_gratitude: ["thank you so much", "thanks in advance", "i really appreciate"],
  qualifier_removal: ["a bit", "a little", "somewhat", "kind of", "sort of"],
  softeners: ["if possible", "when you get a chance", "at your convenience", "just wondering"],
  uncertainty_fillers: ["i guess", "i suppose", "more or less", "in a way"],
  meta_commentary: ["note that", "keep in mind", "remember that"],
  purpose_phrases: ["in order to", "so as to"],
  verbose_connectors: ["furthermore", "additionally", "moreover", "in addition"],
  emphasis_removal: ["very", "really", "extremely", "highly", "quite"],
  redundant_because: ["due to the fact that", "the reason is because"],
  redundant_directive: ["it is important to", "you should", "remember to"],
};

// The rules. Order matters: phrase-level rewrites first, single-word fillers
// after, so a phrase isn't half-eaten by a word rule.
const CAVEMAN_RULES = [
  { name: "redundant_because", pattern: /\bdue to the fact that\b/gi, replacement: "because" },
  { name: "redundant_because", pattern: /\bthe reason is because\b/gi, replacement: "because" },
  { name: "purpose_phrases", pattern: /\bin order to\b/gi, replacement: "to" },
  { name: "purpose_phrases", pattern: /\bso as to\b/gi, replacement: "to" },
  { name: "polite_framing", pattern: /\b(?:could|would|can) you please\b/gi, replacement: "" },
  { name: "polite_framing", pattern: /\bi (?:would like|want|need) you to\b/gi, replacement: "" },
  { name: "polite_framing", pattern: /\b(?:please|kindly)\b/gi, replacement: "" },
  { name: "verbose_requests", pattern: /\bi was wondering (?:if )?\b/gi, replacement: "" },
  { name: "verbose_requests", pattern: /\bwould it be possible to\b/gi, replacement: "" },
  { name: "redundant_openers", pattern: /^(?:hi there|hello|good morning|hey)[,!.\s]+/gi, replacement: "" },
  { name: "excessive_gratitude", pattern: /\b(?:thank you so much|thanks in advance|i really appreciate(?: it| this)?)\b[,!.\s]*/gi, replacement: "" },
  { name: "pleasantries", pattern: /\b(?:sure|certainly|of course|absolutely)\b[,!.\s]*/gi, replacement: "" },
  { name: "pleasantries", pattern: /\b(?:i'?m |i am )?(?:happy|glad) to help\b[,!.\s]*/gi, replacement: "" },
  { name: "pleasantries", pattern: /\b(?:no problem|you'?re welcome)\b[,!.\s]*/gi, replacement: "" },
  { name: "hedging", pattern: /\b(?:it seems like|it appears that|i think that|i believe that)\b/gi, replacement: "" },
  { name: "hedging", pattern: /\b(?:probably|possibly)\b/gi, replacement: "" },
  { name: "softeners", pattern: /\b(?:if possible|when you get a chance|at your convenience|just wondering)\b[,!.\s]*/gi, replacement: "" },
  { name: "uncertainty_fillers", pattern: /\b(?:i guess|i suppose|more or less|in a way)\b[,!.\s]*/gi, replacement: "" },
  { name: "qualifier_removal", pattern: /\b(?:a bit|a little|somewhat|kind of|sort of)\b/gi, replacement: "" },
  { name: "verbose_connectors", pattern: /\b(?:furthermore|additionally|moreover|in addition)\b[,!.\s]*/gi, replacement: "" },
  { name: "meta_commentary", pattern: /\b(?:note that|keep in mind that|remember that)\b/gi, replacement: "" },
  { name: "redundant_directive", pattern: /\bit is important to\b/gi, replacement: "" },
  { name: "filler_phrases", pattern: /\bi(?:'| a)?m looking for\b/gi, replacement: "" },
  { name: "filler_adverbs", pattern: /\b(?:basically|essentially|actually|literally|simply)\b/gi, replacement: "" },
  { name: "emphasis_removal", pattern: /\b(?:very|really|extremely|highly|quite)\b/gi, replacement: "" },
];

const ARTICLE_HINT_RE = /\b(?:a|an|the)\b/i;

// Decide whether a rule's regex is worth running on this text.
export function shouldAttemptRule(ruleName, lowerText) {
  if (ruleName === "articles") {
    ARTICLE_HINT_RE.lastIndex = 0;
    return ARTICLE_HINT_RE.test(lowerText);
  }
  const keywords = RULE_KEYWORDS[ruleName];
  return !keywords || keywords.some((k) => lowerText.includes(k));
}

// Return the rules for a given intensity. lite = phrase-level only; full = all.
// (ultra-level abbreviations are intentionally excluded from the input side —
// they hurt readability of the prompt the model actually reads.)
export function getRulesForContext(intensity = "full") {
  if (intensity === "lite") {
    const liteNames = new Set([
      "redundant_because", "purpose_phrases", "polite_framing",
      "verbose_requests", "redundant_openers", "excessive_gratitude",
      "pleasantries", "softeners",
    ]);
    return CAVEMAN_RULES.filter((r) => liteNames.has(r.name));
  }
  return CAVEMAN_RULES;
}

export const _internal = { CAVEMAN_RULES, RULE_KEYWORDS };
