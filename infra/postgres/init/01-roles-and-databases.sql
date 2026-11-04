-- Runs once, when the local Postgres volume is first created.
--
-- Two roles:
--   traiblazer      owner / superuser  -> runs migrations (DATABASE_URL)
--   traiblazer_app  application role   -> used by the API (DATABASE_APP_URL).
--                   NOT a superuser and NO BYPASSRLS, so row-level security applies to it.
-- Table privileges for traiblazer_app are granted by the migrations, not here.

CREATE ROLE traiblazer_app LOGIN PASSWORD 'traiblazer_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- Separate database for automated tests.
CREATE DATABASE traiblazer_test OWNER traiblazer;
