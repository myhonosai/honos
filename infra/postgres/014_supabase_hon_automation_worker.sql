-- HON / Supabase automation engine role (0368, docs/architecture/AUTOMATION_WORKFLOWS.md)
-- Run after HON migrations through 0368 have completed. Replace the placeholder with a freshly generated
-- base64url password; do not save it in Git. Store the Session Pooler URI only as
-- HON_AUTOMATION_WORKER_DATABASE_URL (never DATABASE_URL, HON_RUNTIME_DATABASE_URL or the communication worker URL).
ROLLBACK;
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_automation_worker') THEN
    RAISE EXCEPTION 'Role hon_automation_worker already exists. Inspect and rotate it deliberately rather than overwriting it.';
  END IF;
  IF to_regprocedure('hon.run_due_automation_steps(integer)') IS NULL THEN
    RAISE EXCEPTION 'Apply automation engine migration 0368 first.';
  END IF;
END;
$$;

CREATE ROLE hon_automation_worker
  LOGIN
  PASSWORD '<PASTE_FRESH_BASE64URL_PASSWORD_HERE>'
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  CONNECTION LIMIT 5;

REVOKE ALL PRIVILEGES ON DATABASE postgres FROM hon_automation_worker;
GRANT CONNECT ON DATABASE postgres TO hon_automation_worker;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM hon_automation_worker;
GRANT USAGE ON SCHEMA hon TO hon_automation_worker;
ALTER ROLE hon_automation_worker SET search_path = hon, pg_catalog;

-- No direct HON table, sequence or function access. The engine starts runs from qualifying outbox events and runs
-- due steps only through these two fixed functions; every message it creates is delivered by the 0243 worker.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA hon FROM hon_automation_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hon FROM hon_automation_worker;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA hon FROM hon_automation_worker;
GRANT EXECUTE ON FUNCTION hon.consume_automation_events(integer) TO hon_automation_worker;
GRANT EXECUTE ON FUNCTION hon.run_due_automation_steps(integer) TO hon_automation_worker;

COMMIT;
