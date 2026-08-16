import "dotenv/config";
import OpenAI from "openai";

// Both providers speak the OpenAI wire format, so one client library serves both
// and only the connection details differ. PROVIDER in .env picks between them.
export const PROVIDERS = {
  // Sarvam AI. Auth is a custom header rather than the usual Authorization: Bearer.
  sarvam: {
    baseURL: "https://api.sarvam.ai/v1",
    model: "sarvam-105b-conversations",
    keyVar: "SARVAM_API_KEY",
    headers: (key) => ({ "api-subscription-key": key }),
    // Starter tier rejects anything above 2048; higher plans allow more.
    maxTokens: 2048,
    // Probed directly: this model believes the date is June 2025, and misplaces
    // transfers from years earlier, so the warning is specific and blunt.
    knowledge: `Your training data ends around mid-2025 and is patchy well before
that — you have been observed placing players at clubs they left years earlier.
You cannot browse or look anything up.`,
  },
  // AICredits — OpenAI-compatible gateway serving Anthropic models.
  aicredits: {
    baseURL: "https://api.aicredits.in/v1",
    model: "anthropic/claude-haiku-4-5",
    keyVar: "ANTHROPIC_API_KEY",
    headers: () => ({}),
    maxTokens: 4096,
    // Deliberately vague: asserting a specific cutoff to a model whose real one
    // we have not verified would make it hedge about things it actually knows.
    knowledge: `Your training data has a cutoff, and you cannot browse or look
anything up. Assume meaningful time has passed since that cutoff — compare it
against today's date, given below.`,
  },
};

export const PROVIDER = process.env.PROVIDER || "sarvam";

const config = PROVIDERS[PROVIDER];
if (!config) {
  console.error(`Unknown PROVIDER "${PROVIDER}". Valid: ${Object.keys(PROVIDERS).join(", ")}`);
  process.exit(1);
}

// Any of these may be overridden per-provider from .env.
export const BASE_URL = process.env.BASE_URL || config.baseURL;
export const MODEL = process.env.MODEL || config.model;
export const MAX_TOKENS = Number(process.env.MAX_TOKENS) || config.maxTokens;
export const KNOWLEDGE = config.knowledge.replace(/\s+/g, " ").trim();
export const KEY_VAR = config.keyVar;

const apiKey = process.env[config.keyVar];
if (!apiKey) {
  console.error(`PROVIDER is "${PROVIDER}", which needs ${config.keyVar} in .env.`);
  if (PROVIDER === "sarvam") {
    console.error("Get a key at https://dashboard.sarvam.ai — new accounts get free credits, no card needed.");
    console.error("Or set PROVIDER=aicredits in .env to keep using the gateway.");
  }
  process.exit(1);
}

export const client = new OpenAI({
  apiKey,
  baseURL: BASE_URL,
  defaultHeaders: config.headers(apiKey),
});
