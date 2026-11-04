ALTER TABLE "users" ADD COLUMN "platform_role" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_platform_role_check" CHECK ("platform_role" IN ('super_admin'));--> statement-breakpoint
-- Staff and business accounts are kept apart: former operators become super admins only if they
-- don't belong to any business.
UPDATE "users" u SET "platform_role" = 'super_admin'
WHERE u."is_operator" AND NOT EXISTS (SELECT 1 FROM "memberships" m WHERE m."user_id" = u."id");--> statement-breakpoint
-- A staff account can never be a member of a business, and a business member can never be made
-- staff, whichever side changes.
CREATE FUNCTION app_staff_not_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'memberships' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND platform_role IS NOT NULL) THEN
      RAISE EXCEPTION 'Staff accounts can''t belong to a business' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.platform_role IS NOT NULL AND EXISTS (SELECT 1 FROM memberships WHERE user_id = NEW.id) THEN
    RAISE EXCEPTION 'Accounts that belong to a business can''t be staff' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_staff_not_member() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER memberships_staff_guard BEFORE INSERT OR UPDATE OF user_id ON memberships
  FOR EACH ROW EXECUTE FUNCTION app_staff_not_member();--> statement-breakpoint
CREATE TRIGGER users_staff_guard BEFORE INSERT OR UPDATE OF platform_role ON users
  FOR EACH ROW EXECUTE FUNCTION app_staff_not_member();
