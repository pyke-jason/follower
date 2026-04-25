# LLM Integration Security Audit — 2026-04-24

## Problem

Pre-live audit uncovered four issues in the LLM integration:

1. Prompt injection surface: user message text flowed into the NLU prompt as a bare
   string with no delimiters. A hostile message containing `</message_text><system>…`
   could attempt to escape the input context and override system instructions.

2. No timeout on LLM calls. AnthropicAgent had no AbortController; XAIAgent had no
   abortSignal. A stalled request (SDK-level hang or network drop) would block the
   agent loop indefinitely — this was confirmed as the root cause of a prior 6-hour
   backtest hang.

3. No daily cost tracking or alerting. Per-call cost was written to message_intents but
   never aggregated. Runaway spend (e.g. an eval loop hitting the live pipeline) would
   go unnoticed until the next billing statement.

4. No operational alert when the LLM path threw. The catch block logged an error but
   did not page the operator, so a quota exhaustion or service outage during live trading
   would be silent until someone checked logs.

## Decision

All four issues fixed in place, minimal scope:

- Prompt injection: added `sanitizeForPrompt()` that strips `<message_text>` tags from
  user-controlled fields (message text, author name) before inserting into the prompt.
  Wrapped the text in `<message_text>…</message_text>` XML delimiters. Added a
  `<security>` block to the system prompt instructing the model to treat content inside
  those tags as opaque data, not commands.

- Timeout: added `timeoutMs?: number` to `AgentRunOptions`. AnthropicAgent uses an
  AbortController attached to the `query()` options; XAIAgent passes `AbortSignal.timeout()`
  to `generateText()`. Default 120 s, overridable via `LLM_TIMEOUT_MS` env var.

- Daily budget: `getDailyLlmCostUsd()` in intent-cache.ts queries `message_intents.cost_usd`
  summed over the UTC calendar day. Called before every LLM call in llm-path.ts. Soft
  alert at `LLM_DAILY_BUDGET_USD` (default $5); hard stop + critical alert at 2× that.

- LLM failure alert: catch block now calls `sendSystemAlert` (Discord + Pushover) with
  severity=critical before returning MANUAL_REVIEW, so any live failure pages the operator.

INTENT_VERSION bumped from 60 → 61 to invalidate cached results from the pre-delimiter
prompt format.

## Key Files

- src/agent/result.ts — `AgentRunOptions.timeoutMs`
- src/agent/anthropic-agent.ts — AbortController + timeout wiring
- src/agent/xai-agent.ts — AbortSignal.timeout() on generateText
- src/intents/orchestrator/intent-cache.ts — `getDailyLlmCostUsd()`, INTENT_VERSION bump
- src/intents/orchestrator/llm-path.ts — delimiters, sanitizer, budget guard, failure alert
- src/intents/orchestrator/llm-path.test.ts — 12 unit tests covering prompt structure and
  injection containment

## Watch Out

- Temperature is NOT settable via the Anthropic path. The `@anthropic-ai/claude-agent-sdk`
  `query()` Options type does not expose temperature — the SDK routes through the Claude
  CLI which owns model defaults. xAI is fixed at 0. If Anthropic non-determinism becomes a
  problem, migrate AnthropicAgent from the agent SDK to a direct `@anthropic-ai/sdk` call.

- `getDailyLlmCostUsd()` adds one DB query per LLM call. If message throughput is very
  high (>100/min), consider caching the result in memory with a 60 s TTL.

- The `LLM_DAILY_BUDGET_USD` hard-stop returns MANUAL_REVIEW (not an exception) so live
  trading degrades gracefully rather than halting. This means high-volume injection attacks
  that run up cost don't take down the system — they just fill the review queue.
