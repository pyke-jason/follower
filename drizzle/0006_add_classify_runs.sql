CREATE TABLE `classify_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`config` text NOT NULL,
	`summary` text,
	`created_at` text,
	`started_at` text,
	`completed_at` text,
	`duration_ms` integer,
	`error` text,
	`pid` integer,
	`name` text,
	`experiment_tag` text,
	`pinned` integer DEFAULT false,
	`progress_index` integer DEFAULT 0,
	`progress_total` integer DEFAULT 0,
	`last_message_ts` text,
	`last_message_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_classify_runs_status` ON `classify_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_classify_runs_experiment_tag` ON `classify_runs` (`experiment_tag`);--> statement-breakpoint
DROP TABLE IF EXISTS `message_labels`;