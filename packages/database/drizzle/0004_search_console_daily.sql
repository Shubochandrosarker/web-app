CREATE TABLE "search_console_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"date" date NOT NULL,
	"dimension" varchar(16) NOT NULL,
	"dimension_value" varchar(1024) DEFAULT '' NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"position_times_100" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_console_daily" ADD CONSTRAINT "search_console_daily_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_console_daily_key" ON "search_console_daily" USING btree ("workspace_id","date","dimension","dimension_value");--> statement-breakpoint
CREATE INDEX "search_console_daily_workspace_date_idx" ON "search_console_daily" USING btree ("workspace_id","date");