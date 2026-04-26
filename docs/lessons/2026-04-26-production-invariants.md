Problem
Production classification code was still carrying defensive fallbacks for malformed open positions, ambiguous position matching, missing expiries, and classifier snapshot shapes. Those fallbacks increased code size and could turn uncertainty into live execution.

Decision
Move the invariants upstream: open trade positions must have a concrete positive quantity, SETTLED snapshots must carry top-level classifierSignals, strategy mismatches no longer fuzzy-match positions, ambiguous exits/adds route to manual review, and live option opens no longer invent weekly expiries when market data has none.

Key Files
src/intents/orchestrator/types.ts
src/intents/orchestrator/position-path.ts
src/intents/orchestrator/open-path.ts
src/pipeline/process-task.ts
src/pipeline/execute-resolved.ts
src/safety/schemas.ts
web/src/lib/snapshot-accessors.ts
drizzle/0004_trade_quantity_invariant.sql

Watch Out
Older local data with null trades.quantity must run the 0004 migration before these paths execute. The stricter matching will increase MANUAL_REVIEW volume for ambiguous symbols, which is intentional for production safety.
