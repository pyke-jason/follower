CREATE TABLE "pushover_cooldowns" (
	"alert_key" text PRIMARY KEY NOT NULL,
	"last_paged_at" text NOT NULL,
	"severity" text,
	"title" text
);
