-- Partial exits, adds, and leg adjustments support
-- All columns nullable — purely additive, no data transformation needed

-- messageLabels: track exit percentage for TRIM actions
ALTER TABLE message_labels ADD COLUMN exit_percent REAL;

-- trades: link child trades (partial slices) to parent, track exit % and avg entry
ALTER TABLE trades ADD COLUMN parent_trade_id TEXT REFERENCES trades(id);
ALTER TABLE trades ADD COLUMN exit_percent REAL;
ALTER TABLE trades ADD COLUMN avg_entry_price TEXT;

-- Index for efficient parent-child lookups
CREATE INDEX idx_trades_parent ON trades(parent_trade_id);
