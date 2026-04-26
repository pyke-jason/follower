CREATE TABLE "classification_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"task_id" text,
	"message_id" text NOT NULL,
	"run_decision_id" text,
	"audit_kind" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"category" text,
	"title" text NOT NULL,
	"details" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"critic" jsonb,
	"alert_key" text,
	"alert_sent_at" text,
	"resolved_at" text,
	"resolved_reason" text,
	"created_at" text
);
--> statement-breakpoint
ALTER TABLE "classification_audits" ADD CONSTRAINT "classification_audits_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_audits" ADD CONSTRAINT "classification_audits_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_audits" ADD CONSTRAINT "classification_audits_run_decision_id_run_decisions_id_fk" FOREIGN KEY ("run_decision_id") REFERENCES "public"."run_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_classification_audits_channel" ON "classification_audits" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_classification_audits_message" ON "classification_audits" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_classification_audits_decision" ON "classification_audits" USING btree ("run_decision_id");--> statement-breakpoint
CREATE INDEX "idx_classification_audits_status" ON "classification_audits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_classification_audits_severity_status" ON "classification_audits" USING btree ("severity","status");--> statement-breakpoint
CREATE INDEX "idx_classification_audits_alert_key" ON "classification_audits" USING btree ("alert_key");