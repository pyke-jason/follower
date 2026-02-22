Problem
The pipeline was using `as` casts on DB row fields (direction, strategy, legs) after `getOpenPositions()` returned raw Drizzle rows. FilledOrderResult did not exist as a type, forcing `!` assertions on filledPrice and fillTimestamp even after OrderResultSchema.parse(). The `get_recent_chat` tool input in extract-intent.ts was parsed with inline `as` casts instead of a schema. TS env vars were validated inside individual function bodies rather than at module load time.

Decision
Added `parseTradeFromDb()` to `src/db/parse.ts` as the single boundary function for DB trade rows — it calls `parseDirection()`, `StrategySchema.parse()`, and `parseLegs()` so callers get real types. In `execute.ts`, all three close-side executors (executeClose, executeTrim, executeLegOff) now call `parseTradeFromDb()` immediately after `getOpenPositions()`, eliminating all `as 'LONG' | 'SHORT'`, `as OrderLeg[]`, and `as Signal['strategy']` casts. Added `FilledOrderResult` to `order-schemas.ts` using Omit+intersection to narrow optional fields to required; used it in `order-manager.ts` to eliminate `!` assertions. Added `GetRecentChatInput` schema to `agent/schemas.ts` and replaced inline `as` casts in `extract-intent.ts`. Moved TS env var validation to module-level Zod parse in both `tradestation.ts` and `auth.ts`.

Key Files
src/db/parse.ts — parseTradeFromDb() is the new boundary function for all DB trade row consumption.
src/pipeline/execute.ts — executeClose/executeTrim/executeLegOff now parse at the query boundary; exhaustiveness guard replaces (signal as any).action.
src/broker/order-schemas.ts — FilledOrderResult type added after OrderResultSchema.
src/broker/auth.ts, src/broker/tradestation.ts — AuthEnvSchema/TsEnvSchema parsed at module init.

Watch Out
parseTradeFromDb() uses StrategySchema from enums.ts which only accepts STOCK/CALL/PUT/CDS/PDS — if a trade row has a legacy or unexpected strategy value it will throw at runtime. The `_never: never = signal.action` exhaustiveness guard in the switch default only works correctly when Signal is fully typed; in the broken tsc environment (missing @types/node) it shows a spurious TS2322 error that doesn't appear in the real build. FilledOrderResult is defined in order-schemas.ts using OrderResult from types.ts — the import is at the top as required.
