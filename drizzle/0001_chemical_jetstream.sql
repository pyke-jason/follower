ALTER TABLE "trades" ADD COLUMN "planned_exit_date" text;--> statement-breakpoint
CREATE INDEX "idx_trades_planned_exit" ON "trades" USING btree ("channel_id","status","planned_exit_date");