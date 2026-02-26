CREATE TABLE `message_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`label_set` text DEFAULT 'baseline' NOT NULL,
	`is_trade` integer,
	`action` text,
	`direction` text,
	`strategy` text,
	`symbol` text,
	`price` text,
	`strikes` text,
	`quantity` text,
	`expiry` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`reviewed` integer DEFAULT false,
	`notes` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_labels_message` ON `message_labels` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_labels_reviewed` ON `message_labels` (`reviewed`);