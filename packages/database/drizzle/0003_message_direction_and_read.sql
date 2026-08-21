CREATE TYPE "public"."message_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
ALTER TYPE "public"."message_status" ADD VALUE 'read' BEFORE 'bounced';--> statement-breakpoint
ALTER TYPE "public"."message_status" ADD VALUE 'received';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "direction" "message_direction" DEFAULT 'outbound' NOT NULL;