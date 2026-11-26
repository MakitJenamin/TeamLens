CREATE TABLE "ingest_batches" (
	"user_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"device_id" uuid,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_batches_pkey" PRIMARY KEY("user_id","batch_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "permission_mode" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "instruction_files" jsonb;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "interrupted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "ingest_batches" ADD CONSTRAINT "ingest_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_batches" ADD CONSTRAINT "ingest_batches_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_batches_created_idx" ON "ingest_batches" USING btree ("created_at");