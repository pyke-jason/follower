/**
 * LLM cost estimation with cache-aware pricing.
 *
 * Pure function — no dependencies, no state. Usable by both
 * the web UI (display) and backend (logging).
 *
 * Pricing is per million tokens. Cache reads are 90% cheaper than
 * regular input; cache writes are 25% more expensive. Backtests
 * benefit heavily from prompt caching (system prompt + tools are
 * cached via cache_control: { type: 'ephemeral' }).
 */

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

type ModelPricing = {
  input: number;    // $/MTok for regular (non-cached) input
  output: number;   // $/MTok for output
  cacheWrite: number; // $/MTok for cache creation
  cacheRead: number;  // $/MTok for cache reads
};

const PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude Sonnet 4.6
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  // Anthropic Claude Haiku 3.5
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, cacheWrite: 1.00, cacheRead: 0.08 },
  // xAI Grok 4.1 Fast
  'grok-4-1-fast-reasoning': { input: 0.20, output: 0.50, cacheWrite: 0.20, cacheRead: 0.02 },
  'grok-4-1-fast-non-reasoning': { input: 0.20, output: 0.50, cacheWrite: 0.20, cacheRead: 0.02 },
};

// Conservative fallback — assumes Sonnet-class pricing
const DEFAULT_PRICING: ModelPricing = { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 };

// ─── Rate limits ────────────────────────────────────

type ModelRateLimits = {
  /** Max API requests per minute (from provider docs / console). */
  rpm: number;
};

const RATE_LIMITS: Record<string, ModelRateLimits> = {
  // Anthropic — Tier 1 (shared across the Sonnet 4.x and Haiku families)
  'claude-sonnet-4-6': { rpm: 50 },
  'claude-haiku-4-5-20251001': { rpm: 50 },
  // xAI — from console (480 RPM on current plan)
  'grok-4-1-fast-reasoning': { rpm: 480 },
  'grok-4-1-fast-non-reasoning': { rpm: 480 },
};

const DEFAULT_RATE_LIMITS: ModelRateLimits = { rpm: 50 };

export function getModelRateLimits(model: string): ModelRateLimits {
  return RATE_LIMITS[model] ?? DEFAULT_RATE_LIMITS;
}

/**
 * Estimate LLM cost in USD from model name and token usage.
 *
 * Returns a rough estimate — actual billing may differ slightly
 * due to rounding and provider-specific rules.
 */
export function estimateLlmCost(model: string, usage: TokenUsage): number {
  const pricing = PRICING[model] ?? DEFAULT_PRICING;

  const inputCost = usage.inputTokens * pricing.input;
  const outputCost = usage.outputTokens * pricing.output;
  const cacheWriteCost = (usage.cacheCreationInputTokens ?? 0) * pricing.cacheWrite;
  const cacheReadCost = (usage.cacheReadInputTokens ?? 0) * pricing.cacheRead;

  return (inputCost + outputCost + cacheWriteCost + cacheReadCost) / 1_000_000;
}
