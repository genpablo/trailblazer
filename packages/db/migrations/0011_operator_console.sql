CREATE TABLE "operator_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_fr" text NOT NULL,
	"monthly_questions" integer NOT NULL,
	"concurrent" integer NOT NULL,
	"per_minute" integer NOT NULL,
	"price_monthly_cents" integer,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_operator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_audit_logs" ADD CONSTRAINT "operator_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_audit_logs_created_idx" ON "operator_audit_logs" USING btree ("created_at");--> statement-breakpoint
-- Seed plans (previously hard-coded) and platform policies; operators edit them in the console.
INSERT INTO "plans" ("id", "name_en", "name_fr", "monthly_questions", "concurrent", "per_minute", "price_monthly_cents", "sort_order") VALUES
  ('trial', 'Free trial', 'Essai gratuit', 100, 3, 20, 0, 0),
  ('local', 'Local', 'Local', 1000, 5, 40, 3900, 10),
  ('local_plus', 'Local Plus', 'Local Plus', 3000, 8, 60, 7900, 20),
  ('professional', 'Professional', 'Professionnel', 5000, 10, 90, 19900, 30),
  ('business', 'Business', 'Affaires', 20000, 25, 200, 49900, 40)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "platform_settings" ("key", "value") VALUES
  ('default_plan', '"trial"'),
  ('visitor_daily_limit', '30'),
  ('conversation_max_questions', '40'),
  ('chat_ip_per_minute', '20'),
  ('released_pack_phase', '1')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Any business on an unknown plan id moves to the trial plan before the foreign key is added.
UPDATE "tenants" SET "plan" = 'trial' WHERE "plan" NOT IN (SELECT "id" FROM "plans");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_plans_id_fk" FOREIGN KEY ("plan") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
-- Platform-wide numbers for the operator console. Tenant tables are protected by row-level
-- security, so this SECURITY DEFINER function returns only per-business aggregates (no content).
CREATE OR REPLACE FUNCTION app_operator_tenant_stats(p_period text, p_since timestamptz)
RETURNS TABLE (tenant_id uuid, bots int, active_bots int, questions int, blocked int, cost_micros bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id,
    (SELECT count(*)::int FROM bots b WHERE b.tenant_id = t.id),
    (SELECT count(*)::int FROM bots b WHERE b.tenant_id = t.id AND b.status = 'active'),
    coalesce((SELECT u.questions FROM usage_counters u WHERE u.tenant_id = t.id AND u.period = p_period), 0),
    coalesce((SELECT u.blocked_quota + u.blocked_busy + u.blocked_visitor FROM usage_counters u
              WHERE u.tenant_id = t.id AND u.period = p_period), 0),
    coalesce((SELECT sum(e.cost_micros)::bigint FROM usage_events e WHERE e.tenant_id = t.id AND e.created_at >= p_since), 0)
  FROM tenants t
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_operator_tenant_stats(text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_operator_tenant_stats(text, timestamptz) TO traiblazer_app;
