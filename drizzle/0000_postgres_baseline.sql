CREATE TABLE "backtest_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"pid" integer,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"started_at" text NOT NULL,
	"completed_at" text,
	"exit_code" integer,
	"signal" text,
	"error" text,
	"log_tail" text
);
--> statement-breakpoint
CREATE TABLE "backtest_checkpoints" (
	"run_id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_message_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"message_index" integer NOT NULL,
	"status" text NOT NULL,
	"phase" text DEFAULT 'REPLAYING' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"started_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "backtest_mtm_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"date" text NOT NULL,
	"unrealized_pnl" real NOT NULL,
	"created_at" text
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"config" jsonb NOT NULL,
	"summary" jsonb,
	"by_trader" jsonb,
	"by_strategy" jsonb,
	"equity_curve" jsonb,
	"created_at" text,
	"started_at" text,
	"completed_at" text,
	"duration_ms" integer,
	"error" text,
	"pid" integer,
	"name" text,
	"experiment_tag" text,
	"pinned" boolean DEFAULT false,
	"extended_metrics" jsonb,
	"live_metrics" jsonb
);
--> statement-breakpoint
CREATE TABLE "classify_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"config" jsonb NOT NULL,
	"summary" jsonb,
	"created_at" text,
	"started_at" text,
	"completed_at" text,
	"duration_ms" integer,
	"error" text,
	"pid" integer,
	"name" text,
	"experiment_tag" text,
	"pinned" boolean DEFAULT false,
	"progress_index" integer DEFAULT 0,
	"progress_total" integer DEFAULT 0,
	"last_message_ts" text,
	"last_message_id" text
);
--> statement-breakpoint
CREATE TABLE "daily_balances" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"date" text NOT NULL,
	"cash_balance" text NOT NULL,
	"buying_power" text NOT NULL,
	"equity" text NOT NULL,
	"market_value" text NOT NULL,
	"unrealized_pnl" text NOT NULL,
	"realized_pnl" text NOT NULL,
	"captured_at" text
);
--> statement-breakpoint
CREATE TABLE "discrepancy_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"category" text NOT NULL,
	"verdict" text,
	"reason" text,
	"reviewed" boolean DEFAULT false,
	"reviewed_at" text,
	"parser_action" text,
	"parser_strategy" text,
	"parser_direction" text,
	"parser_skip_reason" text,
	"parser_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"label_action" text,
	"label_strategy" text,
	"label_direction" text,
	"label_notes" text,
	"agent_verdict" text,
	"agent_reason" text,
	"author" text NOT NULL,
	"clean_text" text NOT NULL,
	"badges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"symbols" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timestamp" text NOT NULL,
	"created_at" text
);
--> statement-breakpoint
CREATE TABLE "eval_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"label" jsonb NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"model" text,
	"version" integer DEFAULT 2 NOT NULL,
	"human_verified" boolean DEFAULT false,
	"human_label" jsonb,
	"rejection_reason" text,
	"feedback" text,
	"reviewed_at" text,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" text
);
--> statement-breakpoint
CREATE TABLE "historical_fetch_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"date" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0,
	"fetched_count" integer DEFAULT 0,
	"saved_count" integer DEFAULT 0,
	"last_attempt_at" text,
	"next_retry_at" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "historical_fetch_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"since" text NOT NULL,
	"until" text NOT NULL,
	"clear_existing" boolean DEFAULT false,
	"fetched_count" integer DEFAULT 0,
	"saved_count" integer DEFAULT 0,
	"current_date" text,
	"started_at" text,
	"completed_at" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "message_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"model" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"route" text NOT NULL,
	"decision" text NOT NULL,
	"reasoning" text,
	"signals" jsonb,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_input_tokens" integer,
	"cache_creation_input_tokens" integer,
	"cost_usd" real,
	"turns" integer,
	"steps" jsonb,
	"created_at" text
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"author" text NOT NULL,
	"timestamp" text NOT NULL,
	"raw_html" text NOT NULL,
	"clean_text" text NOT NULL,
	"badges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"symbols" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_hint" text,
	"direction_hint" text,
	"detected_strategies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_paper_trade" boolean DEFAULT false,
	"confidence" text,
	"ingested_at" text,
	"content_hash" text,
	"reactions" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orphan_fills" (
	"order_id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"strategy" text NOT NULL,
	"direction" text NOT NULL,
	"filled_price" real NOT NULL,
	"filled_at" text NOT NULL,
	"filled_quantity" integer,
	"commission" real,
	"legs" text,
	"raw_order" text,
	"detected_at" text NOT NULL,
	"resolved" boolean DEFAULT false,
	"task_id" text,
	"channel_id" text
);
--> statement-breakpoint
CREATE TABLE "reconciliation_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"type" text NOT NULL,
	"symbol" text NOT NULL,
	"trade_id" text,
	"expected" jsonb,
	"actual" jsonb,
	"resolved" boolean DEFAULT false,
	"resolved_at" text,
	"resolved_reason" text,
	"created_at" text
);
--> statement-breakpoint
CREATE TABLE "run_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"task_id" text,
	"message_id" text,
	"event" text DEFAULT 'SETTLED' NOT NULL,
	"signal_index" integer,
	"outcome" text,
	"phase" text,
	"reasoning" text,
	"trade_id" text,
	"pnl" text,
	"snapshot" jsonb,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" text,
	"skip_category" text
);
--> statement-breakpoint
CREATE TABLE "runtime_health" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"broker_healthy" boolean DEFAULT true NOT NULL,
	"circuit_open" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text,
	"task_type" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"assignee" text DEFAULT 'agent' NOT NULL,
	"priority" integer DEFAULT 0,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text,
	"started_at" text,
	"completed_at" text,
	"error" text,
	"model_provider" text,
	"model_name" text,
	"channel_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_traders" (
	"name" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true,
	"strategies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"position_sizing_config" jsonb
);
--> statement-breakpoint
CREATE TABLE "trade_events" (
	"id" text PRIMARY KEY NOT NULL,
	"trade_id" text NOT NULL,
	"action" text NOT NULL,
	"price" text,
	"quantity" integer,
	"legs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"strategy" text,
	"direction" text,
	"message_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timestamp" text NOT NULL,
	"created_at" text
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"source_message_id" text,
	"trader" text NOT NULL,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"strategy" text NOT NULL,
	"legs" jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"entry_price" text,
	"exit_price" text,
	"quantity" integer DEFAULT 1,
	"pnl" text,
	"opened_at" text,
	"closed_at" text,
	"close_message_id" text,
	"channel_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"avg_entry_price" text,
	"broker_fill_price" text,
	"broker_fill_qty" integer,
	"broker_commission" text,
	"broker_fill_time" text,
	"broker_leg_fills" jsonb,
	"realized_pnl" text
);
--> statement-breakpoint
ALTER TABLE "backtest_attempts" ADD CONSTRAINT "backtest_attempts_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_checkpoints" ADD CONSTRAINT "backtest_checkpoints_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_message_progress" ADD CONSTRAINT "backtest_message_progress_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtest_message_progress" ADD CONSTRAINT "backtest_message_progress_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancy_reviews" ADD CONSTRAINT "discrepancy_reviews_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_labels" ADD CONSTRAINT "eval_labels_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_fetch_chunks" ADD CONSTRAINT "historical_fetch_chunks_run_id_historical_fetch_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historical_fetch_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_intents" ADD CONSTRAINT "message_intents_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_decisions" ADD CONSTRAINT "run_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_decisions" ADD CONSTRAINT "run_decisions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_close_message_id_messages_id_fk" FOREIGN KEY ("close_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_backtest_attempts_run" ON "backtest_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_backtest_attempts_run_attempt" ON "backtest_attempts" USING btree ("run_id","attempt");--> statement-breakpoint
CREATE INDEX "idx_backtest_checkpoints_updated" ON "backtest_checkpoints" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_backtest_progress_run" ON "backtest_message_progress" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_backtest_progress_channel" ON "backtest_message_progress" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_backtest_progress_run_message" ON "backtest_message_progress" USING btree ("run_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_mtm_snapshots_channel" ON "backtest_mtm_snapshots" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_mtm_snapshots_channel_date" ON "backtest_mtm_snapshots" USING btree ("channel_id","date");--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_status" ON "backtest_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_experiment_tag" ON "backtest_runs" USING btree ("experiment_tag");--> statement-breakpoint
CREATE INDEX "idx_classify_runs_status" ON "classify_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_classify_runs_experiment_tag" ON "classify_runs" USING btree ("experiment_tag");--> statement-breakpoint
CREATE INDEX "idx_daily_balances_date" ON "daily_balances" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_daily_balances_channel" ON "daily_balances" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_daily_balances_channel_date_unique" ON "daily_balances" USING btree ("channel_id","date");--> statement-breakpoint
CREATE INDEX "idx_disc_reviews_message" ON "discrepancy_reviews" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_disc_reviews_verdict" ON "discrepancy_reviews" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX "idx_disc_reviews_category" ON "discrepancy_reviews" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_disc_reviews_reviewed" ON "discrepancy_reviews" USING btree ("reviewed");--> statement-breakpoint
CREATE INDEX "idx_disc_reviews_category_verdict" ON "discrepancy_reviews" USING btree ("category","verdict");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_eval_labels_message_version" ON "eval_labels" USING btree ("message_id","version");--> statement-breakpoint
CREATE INDEX "idx_eval_labels_source" ON "eval_labels" USING btree ("source");--> statement-breakpoint
CREATE INDEX "idx_eval_labels_human_verified" ON "eval_labels" USING btree ("human_verified");--> statement-breakpoint
CREATE INDEX "idx_fetch_chunks_run" ON "historical_fetch_chunks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_fetch_chunks_status" ON "historical_fetch_chunks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fetch_runs_status" ON "historical_fetch_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_intents_message" ON "message_intents" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_intents_model_version" ON "message_intents" USING btree ("model","version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_intents_unique" ON "message_intents" USING btree ("message_id","model","version");--> statement-breakpoint
CREATE INDEX "idx_messages_author" ON "messages" USING btree ("author");--> statement-breakpoint
CREATE INDEX "idx_messages_timestamp" ON "messages" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_content_hash" ON "messages" USING btree ("author","content_hash");--> statement-breakpoint
CREATE INDEX "idx_recon_alerts_resolved" ON "reconciliation_alerts" USING btree ("resolved");--> statement-breakpoint
CREATE INDEX "idx_recon_alerts_symbol" ON "reconciliation_alerts" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "idx_recon_alerts_channel" ON "reconciliation_alerts" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_recon_alerts_channel_resolved" ON "reconciliation_alerts" USING btree ("channel_id","resolved");--> statement-breakpoint
CREATE INDEX "idx_run_decisions_channel" ON "run_decisions" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_run_decisions_message" ON "run_decisions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_run_decisions_channel_message" ON "run_decisions" USING btree ("channel_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_run_decisions_task" ON "run_decisions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_run_decisions_settled" ON "run_decisions" USING btree ("channel_id","event");--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tasks_message" ON "tasks" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_channel" ON "tasks" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tasks_message_channel_unique" ON "tasks" USING btree ("message_id","channel_id") WHERE message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_trade_events_trade" ON "trade_events" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "idx_trade_events_timestamp" ON "trade_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_trades_trader" ON "trades" USING btree ("trader");--> statement-breakpoint
CREATE INDEX "idx_trades_symbol" ON "trades" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "idx_trades_status" ON "trades" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_trades_channel" ON "trades" USING btree ("channel_id");