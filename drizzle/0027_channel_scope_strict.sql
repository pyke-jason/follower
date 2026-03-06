PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`task_type` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`assignee` text DEFAULT 'agent' NOT NULL,
	`priority` integer DEFAULT 0,
	`context` text DEFAULT '{}' NOT NULL,
	`result` text,
	`created_at` text,
	`started_at` text,
	`completed_at` text,
	`error` text,
	`model_provider` text,
	`model_name` text,
	`channel_id` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_tasks`(
	`id`, `message_id`, `task_type`, `status`, `assignee`, `priority`, `context`,
	`result`, `created_at`, `started_at`, `completed_at`, `error`, `model_provider`,
	`model_name`, `channel_id`
) SELECT
	`t`.`id`,
	`t`.`message_id`,
	`t`.`task_type`,
	`t`.`status`,
	`t`.`assignee`,
	`t`.`priority`,
	`t`.`context`,
	`t`.`result`,
	`t`.`created_at`,
	`t`.`started_at`,
	`t`.`completed_at`,
	`t`.`error`,
	`t`.`model_provider`,
	`t`.`model_name`,
	COALESCE(
		`t`.`channel_id`,
		(SELECT `tr`.`channel_id` FROM `trades` AS `tr` WHERE `tr`.`task_id` = `t`.`id` LIMIT 1),
		(SELECT `rd`.`channel_id` FROM `run_decisions` AS `rd` WHERE `rd`.`task_id` = `t`.`id` AND `rd`.`channel_id` IS NOT NULL LIMIT 1),
		'unknown:unscoped'
	)
FROM `tasks` AS `t`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_message` ON `tasks` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_channel` ON `tasks` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_message_channel_unique` ON `tasks` (`message_id`,`channel_id`) WHERE message_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_run_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`task_id` text,
	`message_id` text NOT NULL,
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
	`skip_category` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_run_decisions`(
	`id`, `channel_id`, `task_id`, `message_id`, `event`, `signal_index`, `outcome`,
	`phase`, `reasoning`, `trade_id`, `pnl`, `snapshot`, `duration_ms`, `input_tokens`,
	`output_tokens`, `created_at`, `path`, `decision`, `skip_category`
) SELECT
	`rd`.`id`,
	COALESCE(
		`rd`.`channel_id`,
		(SELECT `t`.`channel_id` FROM `tasks` AS `t` WHERE `t`.`id` = `rd`.`task_id` LIMIT 1),
		(SELECT `tr`.`channel_id` FROM `trades` AS `tr` WHERE `tr`.`id` = `rd`.`trade_id` LIMIT 1),
		(SELECT `tr2`.`channel_id` FROM `trades` AS `tr2` WHERE `tr2`.`source_message_id` = `rd`.`message_id` LIMIT 1),
		'unknown:unscoped'
	),
	`rd`.`task_id`,
	`rd`.`message_id`,
	`rd`.`event`,
	`rd`.`signal_index`,
	`rd`.`outcome`,
	`rd`.`phase`,
	`rd`.`reasoning`,
	`rd`.`trade_id`,
	`rd`.`pnl`,
	`rd`.`snapshot`,
	`rd`.`duration_ms`,
	`rd`.`input_tokens`,
	`rd`.`output_tokens`,
	`rd`.`created_at`,
	`rd`.`path`,
	`rd`.`decision`,
	`rd`.`skip_category`
FROM `run_decisions` AS `rd`;--> statement-breakpoint
DROP TABLE `run_decisions`;--> statement-breakpoint
ALTER TABLE `__new_run_decisions` RENAME TO `run_decisions`;--> statement-breakpoint
CREATE INDEX `idx_run_decisions_channel` ON `run_decisions` (`channel_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_message` ON `run_decisions` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_channel_message` ON `run_decisions` (`channel_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_task` ON `run_decisions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_settled` ON `run_decisions` (`channel_id`,`event`);--> statement-breakpoint
ALTER TABLE `daily_balances` ADD `channel_id` text NOT NULL DEFAULT 'unknown:unscoped';--> statement-breakpoint
CREATE INDEX `idx_daily_balances_channel` ON `daily_balances` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_daily_balances_channel_date_unique` ON `daily_balances` (`channel_id`,`date`);--> statement-breakpoint
ALTER TABLE `reconciliation_alerts` ADD `channel_id` text NOT NULL DEFAULT 'unknown:unscoped';--> statement-breakpoint
UPDATE `reconciliation_alerts`
SET `channel_id` = COALESCE(
	(SELECT `tr`.`channel_id` FROM `trades` AS `tr` WHERE `tr`.`id` = `reconciliation_alerts`.`trade_id` LIMIT 1),
	'unknown:unscoped'
);--> statement-breakpoint
CREATE INDEX `idx_recon_alerts_channel` ON `reconciliation_alerts` (`channel_id`);--> statement-breakpoint
CREATE INDEX `idx_recon_alerts_channel_resolved` ON `reconciliation_alerts` (`channel_id`,`resolved`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
