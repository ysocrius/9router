
const AUTO_RE = /^auto(?:\/(coding|cheap|fast|reasoning))?$/i;

const PROVIDER_DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-latest",
  google: "gemini-2.0-flash",
  gemini: "gemini-2.0-flash",
  "gemini-cli": "gemini-2.5-pro",
  antigravity: "gemini-2.5-pro",
  groq: "llama-3.3-70b-versatile",
  deepseek: "deepseek-chat",
  openrouter: "openai/gpt-4o-mini",
  mistral: "mistral-large-latest",
  cohere: "command-r-plus",
};

const SCORE_PROFILES = {
  auto: { quality: 3, cost: 2, speed: 2 },
  coding: { quality: 4, coding: 4, cost: 1, speed: 1 },
  cheap: { cost: 5, speed: 2, quality: 1 },
  fast: { speed: 5, cost: 2, quality: 1 },
  reasoning: { quality: 4, reasoning: 4, cost: 1, speed: 1 },
};

const MODEL_HINTS = [
  { re: /opus|o3|gpt-5|2\.5-pro|reason/i, quality: 5, reasoning: 5, coding: 4, cost: 1, speed: 2 },
  { re: /sonnet|gpt-4|gemini-2|deepseek|qwen|coder/i, quality: 4, reasoning: 3, coding: 4, cost: 3, speed: 3 },
  { re: /mini|flash|haiku|llama|mistral|command-r/i, quality: 3, reasoning: 2, coding: 2, cost: 4, speed: 4 },
  { re: /turbo|fast|instant/i, quality: 2, reasoning: 1, coding: 2, cost: 4, speed: 5 },
];

export function parseAutoRoute(modelStr) {
  const match = typeof modelStr === "string" ? modelStr.match(AUTO_RE) : null;
  if (!match) return null;
  return { name: match[0].toLowerCase(), profile: (match[1] || "auto").toLowerCase() };
}

function defaultModelForConnection(connection) {
  return connection.defaultModel || PROVIDER_DEFAULT_MODELS[connection.provider] || null;
}

function scoreModel(modelStr, profileName) {
  const profile = SCORE_PROFILES[profileName] || SCORE_PROFILES.auto;
  const hints = MODEL_HINTS.find((item) => item.re.test(modelStr)) || { quality: 2, reasoning: 2, coding: 2, cost: 2, speed: 2 };
  return Object.entries(profile).reduce((sum, [key, weight]) => sum + (hints[key] || 0) * weight, 0);
}

export async function getAutoRouteModels(modelStr, limit = 4) {
  const route = parseAutoRoute(modelStr);
  if (!route) return null;

  const { getProviderConnections } = await import("@/lib/localDb");
  const connections = await getProviderConnections({ isActive: true });
  const uniqueModels = new Map();

  for (const connection of connections) {
    const model = defaultModelForConnection(connection);
    if (!model) continue;
    const routedModel = `${connection.provider}/${model}`;
    if (!uniqueModels.has(routedModel)) uniqueModels.set(routedModel, routedModel);
  }

  return [...uniqueModels.values()]
    .sort((a, b) => scoreModel(b, route.profile) - scoreModel(a, route.profile))
    .slice(0, limit);
}
