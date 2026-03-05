CREATE TABLE `eval_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`label_set` text NOT NULL,
	`ran_at` text NOT NULL,
	`total_labels` integer NOT NULL,
	`action_accuracy` real,
	`direction_accuracy` real,
	`strategy_accuracy` real,
	`price_accuracy` real,
	`exit_price_accuracy` real,
	`strikes_accuracy` real,
	`overall_accuracy` real,
	`total_mislabelings` integer,
	`failures_json` text
);
