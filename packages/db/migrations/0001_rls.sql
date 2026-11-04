-- Row-level security and application-role privileges.
--
-- The API connects as `traiblazer_app` (no superuser, no BYPASSRLS). Every tenant-owned table has
-- a policy that only exposes rows whose tenant_id equals the transaction-local setting
-- `app.tenant_id` (set by withTenant() in packages/db). If the setting is missing, no rows match.

-- Create the role if the environment didn't (local docker creates it with LOGIN + password).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'traiblazer_app') THEN
    CREATE ROLE traiblazer_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO traiblazer_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO traiblazer_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO traiblazer_app;
--> statement-breakpoint
-- Tables created by later migrations get the same privileges automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO traiblazer_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO traiblazer_app;
--> statement-breakpoint

ALTER TABLE "bots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "bots"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "bot_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "bot_keys"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "business_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "business_profiles"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "audit_logs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- Widget requests arrive with only a public key, before any tenant context exists.
-- This function (owned by the migration role, so it bypasses RLS) returns just the routing info
-- for an active key, without giving the app role cross-tenant read access to bot_keys.
CREATE OR REPLACE FUNCTION app_resolve_bot_key(p_public_key text)
RETURNS TABLE (tenant_id uuid, bot_id uuid, allowed_origins text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.tenant_id, k.bot_id, k.allowed_origins
  FROM bot_keys k
  WHERE k.public_key = p_public_key
    AND k.revoked_at IS NULL
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_bot_key(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_bot_key(text) TO traiblazer_app;
