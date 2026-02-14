CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`author` text NOT NULL,
	`timestamp` text NOT NULL,
	`raw_html` text NOT NULL,
	`clean_text` text NOT NULL,
	`badges` text DEFAULT '[]',
	`symbols` text DEFAULT '[]',
	`action_hint` text,
	`direction_hint` text,
	`detected_strategies` text DEFAULT '[]',
	`is_paper_trade` integer DEFAULT false,
	`has_multiple_trades` integer DEFAULT false,
	`confidence` text,
	`ingested_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_messages_author` ON `messages` (`author`);--> statement-breakpoint
CREATE INDEX `idx_messages_timestamp` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE TABLE `task_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`step_number` integer NOT NULL,
	`tool_name` text,
	`tool_input` text,
	`tool_output` text,
	`reasoning` text,
	`duration_ms` integer,
	`created_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_steps_task` ON `task_steps` (`task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`task_type` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`assignee` text DEFAULT 'agent' NOT NULL,
	`priority` integer DEFAULT 0,
	`context` text DEFAULT '{}',
	`result` text,
	`created_at` text,
	`started_at` text,
	`completed_at` text,
	`error` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_message` ON `tasks` (`message_id`);--> statement-breakpoint
CREATE TABLE `tracked_traders` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true,
	`strategies` text DEFAULT '[]',
	`max_allocation` text,
	`max_daily_allocation` text,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `trades` (
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
	`is_backtest` integer DEFAULT false,
	`metadata` text DEFAULT '{}',
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`close_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_trades_trader` ON `trades` (`trader`);--> statement-breakpoint
CREATE INDEX `idx_trades_symbol` ON `trades` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_trades_status` ON `trades` (`status`);