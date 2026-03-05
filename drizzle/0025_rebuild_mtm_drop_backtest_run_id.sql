-- Rebuild backtest_mtm_snapshots to drop orphan backtest_run_id (NOT NULL)
-- left behind by migration 0023 (SQLite can't ALTER/DROP columns).
-- New table matches schema.ts: only id, channel_id, date, unrealized_pnl, created_at.

CREATE TABLE `backtest_mtm_snapshots_new` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`date` text NOT NULL,
	`unrealized_pnl` real NOT NULL,
	`created_at` text
);
--> statement-breakpoint
INSERT INTO `backtest_mtm_snapshots_new` (`id`, `channel_id`, `date`, `unrealized_pnl`, `created_at`)
  SELECT `id`, `channel_id`, `date`, `unrealized_pnl`, `created_at`
  FROM `backtest_mtm_snapshots`
  WHERE `channel_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `backtest_mtm_snapshots`;
--> statement-breakpoint
ALTER TABLE `backtest_mtm_snapshots_new` RENAME TO `backtest_mtm_snapshots`;
--> statement-breakpoint
CREATE INDEX `idx_mtm_snapshots_channel` ON `backtest_mtm_snapshots` (`channel_id`);
--> statement-breakpoint
CREATE INDEX `idx_mtm_snapshots_channel_date` ON `backtest_mtm_snapshots` (`channel_id`, `date`);
