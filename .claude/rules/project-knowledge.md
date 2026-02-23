# Project Knowledge

Non-obvious patterns and active issues that can't be inferred from reading code or CLAUDE.md.

## Backtest Runner Phases
- **Phase 1**: Batch intent extraction (LLM). Worker pool with bounded concurrency.
- **Phase 1.5**: Pre-seeds daily bars for ALL traded symbols across full date range. Phase 2 getBars() is 100% cache hits.
- **Phase 2**: Deterministic message replay. No LLM. `advanceTo()` no-ops when no working orders exist.

## Non-Obvious Patterns
- **Expanding quote lookback**: `getQuote()` tries 1m → 2m → 5m → ... → 10d windows until data found
- **Fill models**: orats (leg-count-based %), midpoint, natural
- **Fuzzy position matching**: CLOSE/TRIM/LEG_OFF falls back to symbol-only match when strategy doesn't match and only 1 position exists
- **closeMessageId**: Actively used in web UI (Signal/Auto badges, Close Context panel). Written for CLOSE/TRIM/LEG_OFF in `execute.ts`. Null for auto-closes (sweepExpired).
- **Databento cache filenames are hashed** — you can't tell equity vs options by name. Match OCC patterns (`/[A-Z]{1,6}\s{0,5}\d{6}[CP]/`) in file content before surgical deletes.
