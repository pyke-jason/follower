CREATE TABLE "tracked_trader_channels" (
	"trader_name" text NOT NULL,
	"channel_id" text NOT NULL,
	"position_sizing_config_override" jsonb,
	"created_at" text
);
--> statement-breakpoint
ALTER TABLE "tracked_trader_channels" ADD CONSTRAINT "tracked_trader_channels_trader_name_tracked_traders_name_fk" FOREIGN KEY ("trader_name") REFERENCES "public"."tracked_traders"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tracked_trader_channels_pk" ON "tracked_trader_channels" USING btree ("trader_name","channel_id");--> statement-breakpoint
CREATE INDEX "idx_tracked_trader_channels_channel" ON "tracked_trader_channels" USING btree ("channel_id");--> statement-breakpoint
-- Backfill: every currently-enabled trader gets associations to both the
-- existing paper account (DUP246375) and the existing live account (U14368257).
-- This preserves Stage-0 behavior: enabled traders fire on both channels.
-- Disabled traders get no associations (they were inert anyway).
INSERT INTO "tracked_trader_channels" ("trader_name", "channel_id", "created_at")
SELECT "name", 'ibkr:paper:DUP246375', now()::text
FROM "tracked_traders"
WHERE "enabled" = true
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "tracked_trader_channels" ("trader_name", "channel_id", "created_at")
SELECT "name", 'ibkr:live:U14368257', now()::text
FROM "tracked_traders"
WHERE "enabled" = true
ON CONFLICT DO NOTHING;