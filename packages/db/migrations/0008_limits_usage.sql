CREATE TABLE "usage_counters" (
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"questions" integer DEFAULT 0 NOT NULL,
	"blocked_quota" integer DEFAULT 0 NOT NULL,
	"blocked_busy" integer DEFAULT 0 NOT NULL,
	"blocked_visitor" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_pk" PRIMARY KEY("tenant_id","period")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "monthly_question_limit" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "visitor_daily_limit" integer;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_visitor_idx" ON "conversations" USING btree ("tenant_id","visitor_id");--> statement-breakpoint
CREATE INDEX "messages_tenant_created_idx" ON "messages" USING btree ("tenant_id","created_at");