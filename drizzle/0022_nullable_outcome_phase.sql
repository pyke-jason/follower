-- SQLite cannot ALTER COLUMN to drop NOT NULL. Rebuild the table.
-- outcome and phase must be nullable for non-SETTLED events (PARSED, ORDER_PLACED, etc.)

PRAGMA foreign_keys=OFF;

CREATE TABLE run_decisions_new (
  id TEXT PRIMARY KEY NOT NULL,
  backtest_run_id TEXT,
  task_id TEXT,
  message_id TEXT NOT NULL,
  event TEXT NOT NULL DEFAULT 'SETTLED',
  signal_index INTEGER,
  outcome TEXT,
  phase TEXT,
  reasoning TEXT,
  trade_id TEXT,
  pnl TEXT,
  snapshot TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO run_decisions_new (
  id, backtest_run_id, task_id, message_id, event,
  signal_index, outcome, phase, reasoning, trade_id,
  pnl, snapshot, duration_ms, input_tokens, output_tokens, created_at
)
SELECT
  id, backtest_run_id, task_id, message_id, COALESCE(event, 'SETTLED'),
  signal_index, outcome, phase, reasoning, trade_id,
  pnl, snapshot, duration_ms, input_tokens, output_tokens, created_at
FROM run_decisions;

DROP TABLE run_decisions;

ALTER TABLE run_decisions_new RENAME TO run_decisions;

-- Recreate indexes
CREATE INDEX idx_run_decisions_run ON run_decisions(backtest_run_id);
CREATE INDEX idx_run_decisions_task ON run_decisions(task_id);
CREATE INDEX idx_run_decisions_message ON run_decisions(message_id);
CREATE INDEX idx_run_decisions_run_message ON run_decisions(backtest_run_id, message_id);
CREATE INDEX idx_run_decisions_settled ON run_decisions(backtest_run_id, event);

PRAGMA foreign_keys=ON;
