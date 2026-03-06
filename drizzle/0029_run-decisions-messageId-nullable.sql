PRAGMA foreign_keys = OFF;
--> statement-breakpoint
CREATE TABLE `run_decisions_new` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`task_id` text,
	`message_id` text,
	`event` text DEFAULT 'SETTLED' NOT NULL,
	`signal_index` integer,
	`outcome` text,
	`phase` text,
	`reasoning` text,
	`trade_id` text,
	`pnl` text,
	`snapshot` text,
	`duration_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text,
	`path` text,
	`decision` text,
	`skip_category` text
);
--> statement-breakpoint
INSERT INTO `run_decisions_new` SELECT * FROM `run_decisions`;
--> statement-breakpoint
DROP TABLE `run_decisions`;
--> statement-breakpoint
ALTER TABLE `run_decisions_new` RENAME TO `run_decisions`;
--> statement-breakpoint
CREATE INDEX `idx_run_decisions_channel` ON `run_decisions` (`channel_id`);
--> statement-breakpoint
CREATE INDEX `idx_run_decisions_message` ON `run_decisions` (`message_id`);
--> statement-breakpoint
CREATE INDEX `idx_run_decisions_channel_message` ON `run_decisions` (`channel_id`,`message_id`);
--> statement-breakpoint
CREATE INDEX `idx_run_decisions_task` ON `run_decisions` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_run_decisions_settled` ON `run_decisions` (`channel_id`,`event`);
--> statement-breakpoint
PRAGMA foreign_keys = ON;
