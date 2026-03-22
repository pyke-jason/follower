CREATE TABLE `discrepancy_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`category` text NOT NULL,
	`verdict` text,
	`reason` text,
	`reviewed` integer DEFAULT false,
	`reviewed_at` text,
	`parser_action` text,
	`parser_strategy` text,
	`parser_direction` text,
	`parser_skip_reason` text,
	`parser_flags` text DEFAULT '[]' NOT NULL,
	`label_action` text,
	`label_strategy` text,
	`label_direction` text,
	`label_notes` text,
	`agent_verdict` text,
	`agent_reason` text,
	`author` text NOT NULL,
	`clean_text` text NOT NULL,
	`badges` text DEFAULT '[]' NOT NULL,
	`symbols` text DEFAULT '[]' NOT NULL,
	`timestamp` text NOT NULL,
	`created_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_disc_reviews_message` ON `discrepancy_reviews` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_disc_reviews_verdict` ON `discrepancy_reviews` (`verdict`);--> statement-breakpoint
CREATE INDEX `idx_disc_reviews_category` ON `discrepancy_reviews` (`category`);--> statement-breakpoint
CREATE INDEX `idx_disc_reviews_reviewed` ON `discrepancy_reviews` (`reviewed`);--> statement-breakpoint
CREATE INDEX `idx_disc_reviews_category_verdict` ON `discrepancy_reviews` (`category`,`verdict`);