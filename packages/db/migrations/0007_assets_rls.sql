-- Assets: tenant-isolated like other tables; public images (avatars) are readable by anyone who
-- knows the asset id, through a SECURITY DEFINER function that returns only the image itself.

ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "assets"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_get_public_asset(p_id uuid)
RETURNS TABLE (content_type text, bytes bytea, sha256 text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.content_type, a.bytes, a.sha256
  FROM assets a
  WHERE a.id = p_id AND a.kind IN ('avatar')
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_get_public_asset(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_get_public_asset(uuid) TO traiblazer_app;
