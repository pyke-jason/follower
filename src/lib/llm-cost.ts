/**
 * Anthropic cost estimation from token counts.
 *
 * Anthropic does not return cost on responses, so `AnthropicAgent` computes it
 * from published per-MTok rates. xAI returns the real billed cost via
 * `usage.cost_in_usd_ticks` and stores it directly on `AgentUsage.costUsd` —
 * that path never touches this file.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/models/overview
 * Cache write (5m) = input × 1.25; cache read = input × 0.10.
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
  cacheWrite: number; // $/MTok for cache creation (5-minute TTL)
  cacheRead: number;  // $/MTok for cache reads
};

const PRICING: Record<string, ModelPricing> = {
  // Claude Opus 4.7 — $5/$25 per MTok
  'claude-opus-4-7':            { input: 5.00, output: 25.00, cacheWrite: 6.25, cacheRead: 0.50 },
  // Claude Sonnet 4.6 — $3/$15 per MTok
  'claude-sonnet-4-6':          { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  // Claude Haiku 4.5 — $1/$5 per MTok
  'claude-haiku-4-5':           { input: 1.00, output: 5.00,  cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-haiku-4-5-20251001':  { input: 1.00, output: 5.00,  cacheWrite: 1.25, cacheRead: 0.10 },
  // Legacy models still pinned in some runs
  'claude-opus-4-6':            { input: 5.00, output: 25.00, cacheWrite: 6.25, cacheRead: 0.50 },
  'claude-sonnet-4-5':          { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
};

// Conservative fallback — Sonnet-class pricing
const DEFAULT_PRICING: ModelPricing = { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 };

export function estimateLlmCost(model: string, usage: TokenUsage): number {
  const pricing = PRICING[model] ?? DEFAULT_PRICING;

  const inputCost = usage.inputTokens * pricing.input;
  const outputCost = usage.outputTokens * pricing.output;
  const cacheWriteCost = (usage.cacheCreationInputTokens ?? 0) * pricing.cacheWrite;
  const cacheReadCost = (usage.cacheReadInputTokens ?? 0) * pricing.cacheRead;

  return (inputCost + outputCost + cacheWriteCost + cacheReadCost) / 1_000_000;
}

/**
 * Convert the xAI `usage.cost_in_usd_ticks` integer to dollars.
 * Per xAI docs: 10,000,000,000 ticks = $1 (1 tick = $1e-10).
 */
export function xaiCostTicksToUsd(ticks: number): number {
  return ticks / 10_000_000_000;
}
