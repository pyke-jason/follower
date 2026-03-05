CREATE TABLE `run_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`backtest_run_id` text NOT NULL,
	`message_id` text NOT NULL,
	`path` text NOT NULL,
	`decision` text NOT NULL,
	`reasoning` text,
	`trade_id` text,
	`pnl` text,
	`duration_ms` integer,
	`created_at` text,
	FOREIGN KEY (`backtest_run_id`) REFERENCES `backtest_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_run_decisions_run` ON `run_decisions` (`backtest_run_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_message` ON `run_decisions` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_run_message` ON `run_decisions` (`backtest_run_id`,`message_id`);--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `name` text;--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `experiment_tag` text;--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `parent_run_id` text REFERENCES backtest_runs(id);--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `pinned` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `backtest_runs` ADD `extended_metrics` text;--> statement-breakpoint
CREATE INDEX `idx_backtest_runs_experiment_tag` ON `backtest_runs` (`experiment_tag`);