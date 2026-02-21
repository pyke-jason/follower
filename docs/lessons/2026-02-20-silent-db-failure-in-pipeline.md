Silent DB failures swallowed as warnings in pipeline

Problem:
  executeSignals() in src/pipeline/execute.ts catches ALL errors from signal execution and logs them as warnings. When the trade_events table was missing, every insert threw a DrizzleQueryError, but the pipeline caught it, logged "Signal OPEN SPY failed: Failed query..." as a warn, and continued. The backtest ran to completion with zero trades, looking like a parsing issue rather than a broken database. 100% of signals silently failed.

Decision:
  Infrastructure errors (DrizzleQueryError — DB down, missing table, query syntax) are now re-thrown instead of caught. Business logic errors (no open position, risk blocked, sizing returned 0) remain as warnings. The distinction: a DB error means the system is broken and nothing will work; a signal error means this particular trade can't execute but the next one might.

Key files:
  src/pipeline/execute.ts — added DrizzleQueryError import from drizzle-orm, re-throw in the catch block of executeSignals()

Watch out:
  Any new catch blocks in the pipeline should follow the same pattern: re-throw infrastructure errors, warn on business logic errors. The symptom of swallowing DB errors is a backtest that completes successfully with zero trades — extremely misleading.
  The original trigger was applying a migration to the wrong DB file (data.db at root instead of data/trade-follower.db). The table existed in one place but not where the app connects.
