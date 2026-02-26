CREATE TABLE `daily_balances` (
	`id` text PRIMARY KEY NOT NULL,
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
CREATE TABLE `reconciliation_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`symbol` text NOT NULL,
	`trade_id` text,
	`expected` text,
	`actual` text,
	`resolved` integer DEFAULT false,
	`resolved_at` text,
	`created_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_recon_alerts_resolved` ON `reconciliation_alerts` (`resolved`);--> statement-breakpoint
CREATE INDEX `idx_recon_alerts_symbol` ON `reconciliation_alerts` (`symbol`);--> statement-breakpoint
ALTER TABLE `trades` ADD `broker_fill_price` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `broker_fill_qty` integer;--> statement-breakpoint
ALTER TABLE `trades` ADD `broker_commission` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `broker_fill_time` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `broker_leg_fills` text;