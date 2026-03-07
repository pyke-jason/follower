CREATE TABLE `backtest_mtm_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`date` text NOT NULL,
	`unrealized_pnl` real NOT NULL,
	`created_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_mtm_snapshots_channel` ON `backtest_mtm_snapshots` (`channel_id`);--> statement-breakpoint
CREATE INDEX `idx_mtm_snapshots_channel_date` ON `backtest_mtm_snapshots` (`channel_id`,`date`);--> statement-breakpoint
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
	`error` text,
	`pid` integer,
	`name` text,
	`experiment_tag` text,
	`pinned` integer DEFAULT false,
	`extended_metrics` text,
	`live_metrics` text
);
--> statement-breakpoint
CREATE INDEX `idx_backtest_runs_status` ON `backtest_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_backtest_runs_experiment_tag` ON `backtest_runs` (`experiment_tag`);--> statement-breakpoint
CREATE TABLE `daily_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`date` text NOT NULL,
	`cash_balance` text NOT NULL,
	`buying_power` text NOT NULL,
	`equity` text NOT NULL,
	`market_value` text NOT NULL,
	`unrealized_pnl` text NOT NULL,
	`realized_pnl` text NOT NULL,
	`captured_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_daily_balances_date` ON `daily_balances` (`date`);--> statement-breakpoint
CREATE INDEX `idx_daily_balances_channel` ON `daily_balances` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_daily_balances_channel_date_unique` ON `daily_balances` (`channel_id`,`date`);--> statement-breakpoint
CREATE TABLE `historical_fetch_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`date` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0,
	`fetched_count` integer DEFAULT 0,
	`saved_count` integer DEFAULT 0,
	`last_attempt_at` text,
	`next_retry_at` text,
	`error` text,
	FOREIGN KEY (`run_id`) REFERENCES `historical_fetch_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_fetch_chunks_run` ON `historical_fetch_chunks` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_fetch_chunks_status` ON `historical_fetch_chunks` (`status`);--> statement-breakpoint
CREATE TABLE `historical_fetch_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`since` text NOT NULL,
	`until` text NOT NULL,
	`clear_existing` integer DEFAULT false,
	`fetched_count` integer DEFAULT 0,
	`saved_count` integer DEFAULT 0,
	`current_date` text,
	`started_at` text,
	`completed_at` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_fetch_runs_status` ON `historical_fetch_runs` (`status`);--> statement-breakpoint
CREATE TABLE `message_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`model` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`route` text NOT NULL,
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
CREATE INDEX `idx_intents_message` ON `message_intents` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_intents_model_version` ON `message_intents` (`model`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_intents_unique` ON `message_intents` (`message_id`,`model`,`version`);--> statement-breakpoint
CREATE TABLE `message_labels` (
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
CREATE UNIQUE INDEX `idx_labels_message_unique` ON `message_labels` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_labels_reviewed` ON `message_labels` (`reviewed`);--> statement-breakpoint
CREATE TABLE `messages` (
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
CREATE INDEX `idx_messages_author` ON `messages` (`author`);--> statement-breakpoint
CREATE INDEX `idx_messages_timestamp` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_messages_content_hash` ON `messages` (`author`,`content_hash`);--> statement-breakpoint
CREATE TABLE `orphan_fills` (
	`order_id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`strategy` text NOT NULL,
	`direction` text NOT NULL,
	`filled_price` real NOT NULL,
	`filled_at` text NOT NULL,
	`filled_quantity` integer,
	`commission` real,
	`legs` text,
	`raw_order` text,
	`detected_at` text NOT NULL,
	`resolved` integer DEFAULT 0,
	`task_id` text,
	`channel_id` text
);
--> statement-breakpoint
CREATE TABLE `reconciliation_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`type` text NOT NULL,
	`symbol` text NOT NULL,
	`trade_id` text,
	`expected` text,
	`actual` text,
	`resolved` integer DEFAULT false,
	`resolved_at` text,
	`resolved_reason` text,
	`created_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_recon_alerts_resolved` ON `reconciliation_alerts` (`resolved`);--> statement-breakpoint
CREATE INDEX `idx_recon_alerts_symbol` ON `reconciliation_alerts` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_recon_alerts_channel` ON `reconciliation_alerts` (`channel_id`);--> statement-breakpoint
CREATE INDEX `idx_recon_alerts_channel_resolved` ON `reconciliation_alerts` (`channel_id`,`resolved`);--> statement-breakpoint
CREATE TABLE `run_decisions` (
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
	`skip_category` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_run_decisions_channel` ON `run_decisions` (`channel_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_message` ON `run_decisions` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_channel_message` ON `run_decisions` (`channel_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_task` ON `run_decisions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_run_decisions_settled` ON `run_decisions` (`channel_id`,`event`);--> statement-breakpoint
CREATE TABLE `runtime_health` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`broker_healthy` integer DEFAULT true NOT NULL,
	`circuit_open` integer DEFAULT false NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
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
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_message` ON `tasks` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_channel` ON `tasks` (`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_message_channel_unique` ON `tasks` (`message_id`,`channel_id`) WHERE message_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `tracked_traders` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true,
	`strategies` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`position_sizing_config` text
);
--> statement-breakpoint
CREATE TABLE `trade_events` (
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
CREATE INDEX `idx_trade_events_trade` ON `trade_events` (`trade_id`);--> statement-breakpoint
CREATE INDEX `idx_trade_events_timestamp` ON `trade_events` (`timestamp`);--> statement-breakpoint
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
CREATE INDEX `idx_trades_trader` ON `trades` (`trader`);--> statement-breakpoint
CREATE INDEX `idx_trades_symbol` ON `trades` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_trades_status` ON `trades` (`status`);--> statement-breakpoint
CREATE INDEX `idx_trades_channel` ON `trades` (`channel_id`);