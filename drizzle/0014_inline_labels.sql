-- Inline label review: simplify message_labels to one label per message
-- Drop old columns, add unique constraint on message_id

-- SQLite doesn't support DROP COLUMN in older versions, but does since 3.35.0.
-- We'll recreate the table cleanly.

-- 1. Create new table with simplified schema
CREATE TABLE IF NOT EXISTS message_labels_new (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  is_trade INTEGER,
  action TEXT,
  direction TEXT,
  strategy TEXT,
  symbol TEXT,
  price TEXT,
  strikes TEXT,
  quantity TEXT,
  expiry TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  reviewed INTEGER DEFAULT 0,
  notes TEXT,
  exit_percent REAL,
  created_at TEXT,
  updated_at TEXT
);

-- 2. Copy existing data (take first label per message if duplicates exist)
INSERT OR IGNORE INTO message_labels_new (
  id, message_id, is_trade, action, direction, strategy, symbol, price,
  strikes, quantity, expiry, source, reviewed, notes, exit_percent,
  created_at, updated_at
)
SELECT
  id, message_id, is_trade, action, direction, strategy, symbol, price,
  strikes, quantity, expiry, source, reviewed, notes, exit_percent,
  created_at, updated_at
FROM message_labels;

-- 3. Drop old table and rename
DROP TABLE IF EXISTS message_labels;
ALTER TABLE message_labels_new RENAME TO message_labels;

-- 4. Add indexes
CREATE UNIQUE INDEX idx_labels_message_unique ON message_labels(message_id);
CREATE INDEX idx_labels_reviewed ON message_labels(reviewed);

-- 5. Update eval_runs: add intent tracking columns, drop labelSet
ALTER TABLE eval_runs ADD COLUMN intent_model TEXT;
ALTER TABLE eval_runs ADD COLUMN intent_version INTEGER;
ALTER TABLE eval_runs ADD COLUMN is_trade_accuracy REAL;
ALTER TABLE eval_runs ADD COLUMN symbol_accuracy REAL;

-- Drop old columns from eval_runs (label_set, exit_price_accuracy)
-- SQLite doesn't have DROP COLUMN before 3.35.0, but these are harmless to leave.
-- The Drizzle schema no longer references them so they'll be ignored.
