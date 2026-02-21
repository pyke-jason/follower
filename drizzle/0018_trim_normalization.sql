-- Normalize TRIM: eliminate child trade rows, accumulate PnL on parent.
-- Requires SQLite 3.35.0+ for ALTER TABLE DROP COLUMN.

-- Step 1: Add realized_pnl column (accumulated PnL from partial exits)
ALTER TABLE trades ADD COLUMN realized_pnl TEXT;

-- Step 2: Roll up child trade PnL into parent's realized_pnl
UPDATE trades SET realized_pnl = (
  SELECT CAST(SUM(CAST(c.pnl AS REAL)) AS TEXT)
  FROM trades c
  WHERE c.parent_trade_id = trades.id
    AND c.status = 'CLOSED'
    AND c.pnl IS NOT NULL
)
WHERE id IN (SELECT DISTINCT parent_trade_id FROM trades WHERE parent_trade_id IS NOT NULL);

-- Step 3: PARTIAL parents with remaining qty > 0 become OPEN
UPDATE trades SET status = 'OPEN' WHERE status = 'PARTIAL' AND quantity > 0;

-- Step 4: Edge case — PARTIAL parents with qty = 0 (100% trim) become CLOSED
UPDATE trades SET
  status = 'CLOSED',
  pnl = realized_pnl,
  closed_at = (SELECT MAX(c.closed_at) FROM trades c WHERE c.parent_trade_id = trades.id)
WHERE status = 'PARTIAL' AND quantity = 0 AND realized_pnl IS NOT NULL;

-- Step 5: Delete child trade rows (their PnL has been rolled up)
DELETE FROM trades WHERE parent_trade_id IS NOT NULL;

-- Step 6: Drop obsolete columns and index
DROP INDEX IF EXISTS idx_trades_parent;
ALTER TABLE trades DROP COLUMN parent_trade_id;
ALTER TABLE trades DROP COLUMN exit_percent;
