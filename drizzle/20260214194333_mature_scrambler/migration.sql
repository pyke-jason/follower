CREATE TABLE `backtest_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`config` text NOT NULL,
	`summary` text,
	`by_trader` text,
	`by_strategy` text,
	`equity_curve` text,
	`created_at` text,
	`started_at` text,
	`completed_at` text,
	`duration_ms` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_runs_status` ON `backtest_runs` (`status`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `backtest_run_id` text REFERENCES backtest_runs(id);--> statement-breakpoint
CREATE INDEX `idx_tasks_backtest_run` ON `tasks` (`backtest_run_id`);--> statement-breakpoint
ALTER TABLE `trades` ADD `backtest_run_id` text REFERENCES backtest_runs(id);--> statement-breakpoint
CREATE INDEX `idx_trades_backtest_run` ON `trades` (`backtest_run_id`);