Problem
Close messages without HTML badge spans (e.g. "closed $ m WATM for a profit") were filtered out by the backtest runner's `badges.length > 0` predicate at runner.ts:130. The pipeline at execute.ts:417 correctly sets closeMessageId, but messages never reached it. This caused trade detail panels to show only the OPEN signal, missing the CLOSE signal entirely.

Decision
Widened the backtest filter from `badges.length > 0` to `symbols.length > 0` — the classifier extracts symbols from badge-less messages, so this is the correct gate. A retroactive closeMessageId linking mechanism was investigated to handle the sweepExpired race (CLOSE signal arrives after position already auto-closed), but it was removed after producing 0 successful matches across 15 backtest runs. The dominant failure causes were partial exit modeling and strategy mismatch, not the sweepExpired race it was designed for. For the live path (factory.ts), badge-less messages now create tasks but are always routed to REVIEW_MESSAGE (never auto-execute) — a safety gate against routing commentary through the LLM and accidentally executing real trades.

Key Files
src/backtest/runner.ts — filter change at line 130
src/tasks/factory.ts — live path safety gate: badges=0 + symbols>0 -> REVIEW_MESSAGE
src/trades/filters.ts — composable Drizzle fragments (forSymbol, forTrader) used by position queries

Watch Out
The live path factory.ts intentionally forces REVIEW_MESSAGE for all badge-less messages regardless of confidence. This is a safety gate — without it, commentary with extracted symbols could flow through the LLM agent and execute real trades. The backtest path has no such gate because it is non-destructive. If you change the live routing, add an explicit execution-approval step first.
