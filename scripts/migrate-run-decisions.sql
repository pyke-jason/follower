-- Migration: Drop and recreate run_decisions table for unified decisions schema.
-- Old backtest decisions are lost (re-runnable). No backwards compat needed.

DROP TABLE IF EXISTS run_decisions;

CREATE TABLE run_decisions (
  id             TEXT PRIMARY KEY,
  backtest_run_id TEXT REFERENCES backtest_runs(id),
  task_id        TEXT REFERENCES tasks(id),
  message_id     TEXT NOT NULL REFERENCES messages(id),
  signal_index   INTEGER,
  outcome        TEXT NOT NULL,
  phase          TEXT NOT NULL,
  reasoning      TEXT,
  trade_id       TEXT,
  pnl            TEXT,
  snapshot       TEXT,
  duration_ms    INTEGER,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  created_at     TEXT
);

CREATE INDEX idx_run_decisions_run ON run_decisions(backtest_run_id);
CREATE INDEX idx_run_decisions_task ON run_decisions(task_id);
CREATE INDEX idx_run_decisions_message ON run_decisions(message_id);
CREATE INDEX idx_run_decisions_run_message ON run_decisions(backtest_run_id, message_id);
