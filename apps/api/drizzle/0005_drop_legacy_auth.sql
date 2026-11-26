DROP TABLE "device_codes" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_admin";--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "project_members" DROP COLUMN "role";