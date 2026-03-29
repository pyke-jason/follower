CREATE TABLE `eval_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`label` text NOT NULL,
	`source` text DEFAULT 'agent' NOT NULL,
	`model` text,
	`version` integer DEFAULT 2 NOT NULL,
	`human_verified` integer DEFAULT false,
	`human_label` text,
	`reviewed_at` text,
	`duration_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_eval_labels_message_version` ON `eval_labels` (`message_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_eval_labels_source` ON `eval_labels` (`source`);--> statement-breakpoint
CREATE INDEX `idx_eval_labels_human_verified` ON `eval_labels` (`human_verified`);
