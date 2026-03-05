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
	`channel_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "message_id", "task_type", "status", "assignee", "priority", "context", "result", "created_at", "started_at", "completed_at", "error", "model_provider", "model_name", "channel_id") SELECT "id", "message_id", "task_type", "status", "assignee", "priority", "context", "result", "created_at", "started_at", "completed_at", "error", "model_provider", "model_name", "channel_id" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_message` ON `tasks` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_channel` ON `tasks` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_message_channel_unique` ON `tasks` (`message_id`,`channel_id`) WHERE message_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_message_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`signals` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`reviewed` integer DEFAULT false,
	`notes` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_message_labels`("id", "message_id", "signals", "source", "reviewed", "notes", "created_at", "updated_at") SELECT "id", "message_id", "signals", "source", "reviewed", "notes", "created_at", "updated_at" FROM `message_labels`;--> statement-breakpoint
DROP TABLE `message_labels`;--> statement-breakpoint
ALTER TABLE `__new_message_labels` RENAME TO `message_labels`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_labels_message_unique` ON `message_labels` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_labels_reviewed` ON `message_labels` (`reviewed`);--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`author` text NOT NULL,
	`timestamp` text NOT NULL,
	`raw_html` text NOT NULL,
	`clean_text` text NOT NULL,
	`badges` text DEFAULT '[]' NOT NULL,
	`symbols` text DEFAULT '[]' NOT NULL,
	`action_hint` text,
	`direction_hint` text,
	`detected_strategies` text DEFAULT '[]' NOT NULL,
	`is_paper_trade` integer DEFAULT false,
	`confidence` text,
	`ingested_at` text,
	`content_hash` text
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "author", "timestamp", "raw_html", "clean_text", "badges", "symbols", "action_hint", "direction_hint", "detected_strategies", "is_paper_trade", "confidence", "ingested_at", "content_hash") SELECT "id", "author", "timestamp", "raw_html", "clean_text", "badges", "symbols", "action_hint", "direction_hint", "detected_strategies", "is_paper_trade", "confidence", "ingested_at", "content_hash" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
CREATE INDEX `idx_messages_author` ON `messages` (`author`);--> statement-breakpoint
CREATE INDEX `idx_messages_timestamp` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_messages_content_hash` ON `messages` (`author`,`content_hash`);--> statement-breakpoint
CREATE TABLE `__new_tracked_traders` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true,
	`strategies` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`position_sizing_config` text
);
--> statement-breakpoint
INSERT INTO `__new_tracked_traders`("name", "enabled", "strategies", "notes", "position_sizing_config") SELECT "name", "enabled", "strategies", "notes", "position_sizing_config" FROM `tracked_traders`;--> statement-breakpoint
DROP TABLE `tracked_traders`;--> statement-breakpoint
ALTER TABLE `__new_tracked_traders` RENAME TO `tracked_traders`;--> statement-breakpoint
CREATE TABLE `__new_trade_events` (
	`id` text PRIMARY KEY NOT NULL,
	`trade_id` text NOT NULL,
	`action` text NOT NULL,
	`price` text,
	`quantity` integer,
	`legs` text DEFAULT '[]' NOT NULL,
	`strategy` text,
	`direction` text,
	`message_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`timestamp` text NOT NULL,
	`created_at` text,
	FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_trade_events`("id", "trade_id", "action", "price", "quantity", "legs", "strategy", "direction", "message_id", "metadata", "timestamp", "created_at") SELECT "id", "trade_id", "action", "price", "quantity", "legs", "strategy", "direction", "message_id", "metadata", "timestamp", "created_at" FROM `trade_events`;--> statement-breakpoint
DROP TABLE `trade_events`;--> statement-breakpoint
ALTER TABLE `__new_trade_events` RENAME TO `trade_events`;--> statement-breakpoint
CREATE INDEX `idx_trade_events_trade` ON `trade_events` (`trade_id`);--> statement-breakpoint
CREATE INDEX `idx_trade_events_timestamp` ON `trade_events` (`timestamp`);--> statement-breakpoint
CREATE TABLE `__new_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`source_message_id` text,
	`trader` text NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`strategy` text NOT NULL,
	`legs` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`entry_price` text,
	`exit_price` text,
	`quantity` integer DEFAULT 1,
	`pnl` text,
	`opened_at` text,
	`closed_at` text,
	`close_message_id` text,
	`channel_id` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`avg_entry_price` text,
	`broker_fill_price` text,
	`broker_fill_qty` integer,
	`broker_commission` text,
	`broker_fill_time` text,
	`broker_leg_fills` text,
	`realized_pnl` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`close_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_trades`("id", "task_id", "source_message_id", "trader", "symbol", "direction", "strategy", "legs", "status", "entry_price", "exit_price", "quantity", "pnl", "opened_at", "closed_at", "close_message_id", "channel_id", "metadata", "avg_entry_price", "broker_fill_price", "broker_fill_qty", "broker_commission", "broker_fill_time", "broker_leg_fills", "realized_pnl") SELECT "id", "task_id", "source_message_id", "trader", "symbol", "direction", "strategy", "legs", "status", "entry_price", "exit_price", "quantity", "pnl", "opened_at", "closed_at", "close_message_id", "channel_id", "metadata", "avg_entry_price", "broker_fill_price", "broker_fill_qty", "broker_commission", "broker_fill_time", "broker_leg_fills", "realized_pnl" FROM `trades`;--> statement-breakpoint
DROP TABLE `trades`;--> statement-breakpoint
ALTER TABLE `__new_trades` RENAME TO `trades`;--> statement-breakpoint
CREATE INDEX `idx_trades_trader` ON `trades` (`trader`);--> statement-breakpoint
CREATE INDEX `idx_trades_symbol` ON `trades` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_trades_status` ON `trades` (`status`);--> statement-breakpoint
CREATE INDEX `idx_trades_channel` ON `trades` (`channel_id`);