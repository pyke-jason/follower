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
CREATE INDEX `idx_fetch_runs_status` ON `historical_fetch_runs` (`status`);