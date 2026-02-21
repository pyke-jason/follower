LEG_OFF action + trade events table

Problem:
  When a trader says "exit CDS, hold straight calls", the system closed the entire spread. There was no action between CLOSE (all legs) and TRIM (partial quantity). Separately, the trades table had no history — each action mutated fields in place with no audit trail.

Decision — LEG_OFF:
  Added LEG_OFF as a new TradeAction. It's a position mutation, not a partial exit — the same trade row stays open the entire lifecycle: OPEN CDS → LEG_OFF (mutate to CALL, adjust cost basis) → CLOSE CALL. Cost basis: original spread debit + buyback cost. Only two transitions: CDS→CALL, PDS→PUT. Signal schema gets a targetStrategy field.

Decision — trade events:
  Added trade_events table as an append-only event log. Every action (OPEN, CLOSE, ADD, TRIM, LEG_OFF) emits an immutable event row, then mutates the denormalized trades row as before. All readers are untouched — only the write path changed.

Key files:
  src/lib/enums.ts — added LEG_OFF to TradeActionSchema
  src/agent/schemas.ts — added targetStrategy field to SignalSchema with validation refine
  src/pipeline/execute.ts — added executeLegOff(): finds SELL leg, builds buy-back order
  src/intents/extract-intent.ts — added LEG_OFF docs to LLM system prompt
  src/db/schema.ts — added tradeEvents table definition
  drizzle/0017_trade_events.sql — migration SQL
  src/trades/record-trade.ts — added LEG_OFF handler + emitEvent() calls for all 5 actions
  src/backtest/sim-broker.ts — closePositionAtPrice() now delegates to recordTrade()

Watch out:
  targetStrategy is passed through metadata from pipeline to record-trade. If metadata shape changes, both files break together.
  PnL is only computed at final CLOSE against the adjusted entry price. No intermediate PnL for the leg-off itself.
  recordTrade() is the single write path for all trade mutations. closePositionAtPrice() delegates to it.
  drizzle-kit push has CJS/ESM issues. Apply migrations with sqlite3 data.db < drizzle/NNNN_name.sql.
