## Problem

The LLM daily budget guard treated cost as an execution blocker: at 2x the configured budget, ambiguous messages were routed to MANUAL_REVIEW instead of calling the classifier. For live trading, token spend should page the operator, not interrupt classification.

## Decision

Make alert-only the default budget policy. Crossing the budget sends a warning alert, crossing 2x sends a critical alert, and classification continues. Keep `LLM_BUDGET_MODE=block` as an explicit escape hatch for the old hard-stop behavior.

## Key Files

- `src/intents/orchestrator/llm-path.ts`
- `src/intents/orchestrator/llm-path.test.ts`

## Watch Out

Alert-only can spam alerts after the threshold because the check runs before every LLM call. If live volume gets high, add a cooldown or persist the last budget alert threshold per day.
