ALTER TABLE "sessions" ADD COLUMN "parent_source_id" text;--> statement-breakpoint
CREATE INDEX "sessions_user_parent_source_idx" ON "sessions" USING btree ("user_id","parent_source_id");