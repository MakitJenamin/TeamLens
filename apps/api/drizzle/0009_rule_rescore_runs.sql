CREATE TABLE "project_rescore_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"processed_sessions" integer DEFAULT 0 NOT NULL,
	"total_sessions" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "project_rescore_runs" ADD CONSTRAINT "project_rescore_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_rescore_runs_project_created_idx" ON "project_rescore_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_rescore_runs_active_uq" ON "project_rescore_runs" USING btree ("project_id") WHERE "project_rescore_runs"."status" in ('queued', 'running');