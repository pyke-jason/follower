Problem
Stop placement had started carrying a runtime compatibility guard for historical trade rows whose leg JSON lacked `symbol`.

Decision
Keep `OrderLeg.symbol` as a hard invariant and clean malformed historical rows with a one-time migration. The hot path should fail loudly on future invalid writes instead of silently treating bad persisted trade legs as normal.

Key Files
`src/config/stop-defaults.ts`
`drizzle/0003_prune_malformed_trade_legs.sql`

Watch Out
If a future importer creates trade legs without `symbol`, fix the importer or schema boundary. Do not reintroduce fallback handling in stop calculation.
