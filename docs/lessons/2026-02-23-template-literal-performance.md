Template Literal Evaluation in Suppressed Logs

Problem: JavaScript template strings evaluate their interpolations even when the log is suppressed. This means `log.debug(\`...\${formatLogTimestampET(time)}...\`)` runs `formatLogTimestampET()` even at info level.

Discovery: Three debug logs in sim-broker.ts called `formatLogTimestampET()`, which uses `Intl.DateTimeFormat.formatToParts()` for timezone conversion—expensive (~0.5-2ms per call, ICU-backed).
- Line 415 (markToMarket): ~1-10 calls per backtest (quote fetch failures)
- Line 456 (getUnrealizedPnl): ~1-10 calls per backtest (quote fetch failures)
- Line 623 (getAccountBalance): ~5-50 calls per backtest (called per-message, has internal timing)

Fix: Removed expensive timezone formatting from all three debug logs. Kept error details (symbol, strategy, error message) but dropped timestamp formatting since these are error paths.

Key Insight: Always check what template literal interpolations do—cheap operations like `.toFixed()` and `.length` are fine, but expensive ones like `Intl.*`, `JSON.stringify()`, or loops are problems even in suppressed logs.

Recommendation: For future logging, prefer passing raw values and let the logger decide on formatting, or add guards: `if (log.LEVELS.debug) { ... }` (if the logger exposed it).

Files changed: src/backtest/sim-broker.ts (3 lines)
