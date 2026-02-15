ALTER TABLE `message_labels` ADD `exit_percent` real;--> statement-breakpoint
ALTER TABLE `reconciliation_alerts` ADD `resolved_reason` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `parent_trade_id` text REFERENCES trades(id);--> statement-breakpoint
ALTER TABLE `trades` ADD `exit_percent` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `avg_entry_price` text;--> statement-breakpoint
CREATE INDEX `idx_trades_parent` ON `trades` (`parent_trade_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_message_unique` ON `tasks` (`message_id`) WHERE message_id IS NOT NULL;