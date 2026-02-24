# Grok Text-to-Tool-Call Recovery

## Problem

Grok (xai/grok-4-1-fast-non-reasoning) stochastically emits tool calls as plain text instead of structured `tool_calls` in the API response. The agent loop sees zero tool calls and breaks, recording the message as SKIP with no signals.

Observed in backtest run ff861c28: message 467778 ("Bought back the short Puts on MSFT") was correctly analyzed by Grok but the decision was emitted as text: `submit_decision(EXECUTE): action CLOSE, symbol MSFT, strategy PDS`. The MSFT PDS position expired worthless instead of being closed, losing $1,194.

The identical message pattern on Sep 25 (message 469579) worked correctly with structured tool calls — same model, same prompt. This is non-deterministic.

## Decision

Added text-to-tool-call recovery in `XAIProvider.parseResponse()`. When no structured tool calls are present but the text contains recognizable patterns (`submit_decision(...)` or `flag_for_review(...)`), synthesize proper tool call objects and set `stopReason` to `tool_use`.

Recovery is in the XAI provider (not agent loop) because this is Grok-specific behavior. Other providers (Anthropic) don't exhibit this.

## Key Files

- `src/agent/providers/xai.ts:148-171` — recovery block in `parseResponse`
- `src/agent/providers/xai.ts:174-286` — helper functions: `recoverToolCallsFromText`, `extractReasoning`, `parseSignalText`, `parseLegsText`
- `src/agent/providers/xai-recovery.test.ts` — 26 unit tests
- `src/agent/agent-loop.ts:103` — the `if (toolCalls.length === 0) break` guard that drops unrecovered text

## Watch Out

- Recovery only handles known tool names (`submit_decision`, `flag_for_review`). New tools need new patterns.
- The regex patterns are tuned to observed Grok output. If Grok changes its text format, patterns may need updating.
- `log.warn` fires on every recovery — monitor for frequency. If it's >5% of calls, the model may need a stronger system prompt nudge.
- Secondary issue: Grok classified "Bought back the short Puts on MSFT" as CLOSE instead of LEG_OFF. The intent prompt's `exit_language` section doesn't include "bought back the short puts/calls" as a leg-off variant.
