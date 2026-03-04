ALTER TABLE `message_labels` ADD `model_provider` text;--> statement-breakpoint
ALTER TABLE `message_labels` ADD `model_name` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `model_provider` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `model_name` text;--> statement-breakpoint
ALTER TABLE `tracked_traders` ADD `position_sizing_config` text;