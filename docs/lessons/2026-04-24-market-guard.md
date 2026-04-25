# Market Guard, Halt Tracker, RTH Gating

## Problem

Bot had no awareness of market session when placing orders. OPEN signals arriving pre-market, post-market, on holidays, or after early close would be submitted as GTC and queue until next open — potentially causing gap-fill executions the trader never intended. No halt detection existed, so orders sent during a T1/T2/regulatory halt would be rejected by IBKR with no retry suppression.

## Decision

Added a two-layer guard in the pipeline:

1. **Session gating** (`MarketGuard.checkSignal`): OPEN signals outside RTH (pre, post, holiday) are dropped with a warning alert. CLOSE/TRIM bypass the session check because exits should never be blocked — only the halt check applies.

2. **Halt detection** (`HaltTracker`): When IBKR rejects an order with "halted"/"suspended" in the error message, the symbol is registered in-memory for 15 minutes. Subsequent signals for that symbol are skipped immediately (both OPEN and CLOSE, since halted instruments are not tradeable).

The guard is backtest-transparent: `marketGuard` is `undefined` when `config.isBacktestScope` is true, so no session check runs in simulation.

## Key Files

- `src/lib/et-date.ts` — added `MarketSession` type and `getMarketSession(d)`. Also added 2027 NYSE holiday and early-close calendars.
- `src/lib/halt-tracker.ts` — in-memory symbol halt registry with per-symbol TTL.
- `src/lib/market-guard.ts` — composes HaltTracker + clock into `checkSignal()`.
- `src/pipeline/execute-resolved.ts` — market guard check before OPEN path; halt detection in catch block.
- `src/pipeline/build-deps.ts` — `MarketGuard` instantiated for live/paper, `undefined` for backtest.

## Watch Out

- The 15-min halt cooldown is conservative. NYSE T1 halts can run 30+ min. The halt auto-expires and normal trading resumes. No manual clear path exists in the UI yet — operator must restart the bot if a halt outlasts the window and they need to close immediately.
- LULD (limit-up/limit-down) bands and circuit breakers (Level 1/2/3) are NOT yet detected. These require either an ITP data feed or scraping IBKR's halt list endpoint. Noted as a future improvement.
- 2027 early closes include July 2 (before observed July 4 long weekend) and Nov 26 (day after Thanksgiving). Dec 23 early close is not included — NYSE does not always observe it and it was unconfirmed. Verify against NYSE official calendar before year-end 2026.
- GTC orders placed before this change may still be queued at IBKR. Any working orders from before the guard was added should be reviewed manually.
