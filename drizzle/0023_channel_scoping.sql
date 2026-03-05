-- Channel scoping: replace is_backtest + backtest_run_id with channel_id.
-- Format: 'bt:<runId>', 'live:<accountId>', 'paper:<accountId>'.

-- ── trades ────────────────────────────────────────────
ALTER TABLE trades ADD COLUMN channel_id TEXT;
UPDATE trades SET channel_id = 'bt:' || backtest_run_id WHERE backtest_run_id IS NOT NULL;
CREATE INDEX idx_trades_channel ON trades(channel_id);

-- ── tasks ─────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN channel_id TEXT;
UPDATE tasks SET channel_id = 'bt:' || backtest_run_id WHERE backtest_run_id IS NOT NULL;
CREATE INDEX idx_tasks_channel ON tasks(channel_id);

-- ── run_decisions ─────────────────────────────────────
ALTER TABLE run_decisions ADD COLUMN channel_id TEXT;
UPDATE run_decisions SET channel_id = 'bt:' || backtest_run_id WHERE backtest_run_id IS NOT NULL;
CREATE INDEX idx_run_decisions_channel ON run_decisions(channel_id);
CREATE INDEX idx_run_decisions_channel_message ON run_decisions(channel_id, message_id);
CREATE INDEX idx_run_decisions_channel_event ON run_decisions(channel_id, event);

-- ── backtest_mtm_snapshots ────────────────────────────
ALTER TABLE backtest_mtm_snapshots ADD COLUMN channel_id TEXT;
UPDATE backtest_mtm_snapshots SET channel_id = 'bt:' || backtest_run_id WHERE backtest_run_id IS NOT NULL;
CREATE INDEX idx_mtm_snapshots_channel ON backtest_mtm_snapshots(channel_id);
CREATE INDEX idx_mtm_snapshots_channel_date ON backtest_mtm_snapshots(channel_id, date);

-- Old columns (is_backtest, backtest_run_id) are left in place.
-- SQLite doesn't support DROP COLUMN without table rebuild.
-- Drizzle maps by name, so they're simply ignored.
