CREATE TABLE `runtime_health` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`broker_healthy` integer DEFAULT true NOT NULL,
	`circuit_open` integer DEFAULT false NOT NULL,
	`last_error` text,
	`updated_at` text NOT NULL
);
