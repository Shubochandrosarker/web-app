ALTER TYPE "public"."document_status" ADD VALUE 'pending_upload' BEFORE 'uploaded';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "claim_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "scanned_at" timestamp with time zone;