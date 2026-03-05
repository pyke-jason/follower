-- Add event column to run_decisions (discriminator for the event stream)
ALTER TABLE run_decisions ADD COLUMN event TEXT NOT NULL DEFAULT 'SETTLED';

-- Existing rows become SETTLED events (backwards compatible)
-- outcome/phase are now nullable for intermediate events — SQLite allows this with ALTER TABLE

-- Partial index for fast settled-event queries (summary views)
CREATE INDEX idx_run_decisions_settled ON run_decisions(backtest_run_id, event);
