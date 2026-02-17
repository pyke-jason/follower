CREATE TABLE `backtest_mtm_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`backtest_run_id` text NOT NULL,
	`date` text NOT NULL,
	`unrealized_pnl` real NOT NULL,
	`created_at` text,
	FOREIGN KEY (`backtest_run_id`) REFERENCES `backtest_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_mtm_snapshots_run` ON `backtest_mtm_snapshots` (`backtest_run_id`);--> statement-breakpoint
CREATE INDEX `idx_mtm_snapshots_run_date` ON `backtest_mtm_snapshots` (`backtest_run_id`,`date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `message_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`model` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`decision` text NOT NULL,
	`reasoning` text,
	`signals` text,
	`duration_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`turns` integer,
	`steps` text,
	`created_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_intents_message` ON `message_intents` (`message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_intents_model_version` ON `message_intents` (`model`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_intents_unique` ON `message_intents` (`message_id`,`model`,`version`);--> statement-breakpoint
ALTER TABLE `run_decisions` ADD `skip_category` text;