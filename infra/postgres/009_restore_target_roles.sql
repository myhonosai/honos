-- HON fresh-target restore, step 1 of docs/operations/BACKUP_RESTORE_AND_RECOVERY.md §3 (launch-readiness review [23]).
-- Run on a FRESH, isolated target BEFORE pg_restore, as its administrator, after replacing each password placeholder
-- with its own freshly generated base64url secret (never reuse production passwords; never save them in Git):
--   node -e "console.log(require('node:crypto').randomBytes(36).toString('base64url'))"
--
-- Why this exists: a `pg_dump --schema=hon` file carries every HON object, owner and grant, but not the login roles
-- those grants name, nor their database CONNECT grant or search_path. 010/012/013/014 cannot run first on a fresh
-- target (they reconcile grants on HON objects that are not restored yet, and 012-014 refuse an existing role), and
-- pg_restore --exit-on-error stops at the first grant to a missing role. So the roles come first, with exactly the
-- attributes 010/012/013/014 give them and NO object privileges; the dump restores the grants; 010 then reconciles.
ROLLBACK;
BEGIN;

DO $$
BEGIN
  IF to_regnamespace('hon') IS NOT NULL THEN
    RAISE EXCEPTION 'Schema hon already exists. This script runs only on a fresh target, before pg_restore.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('hon_runtime','hon_outbox_worker','hon_communication_worker','hon_automation_worker')) THEN
    RAISE EXCEPTION 'A HON login role already exists on this target. Restore only into a fresh, isolated target.';
  END IF;
END;
$$;

CREATE ROLE hon_runtime LOGIN PASSWORD '<PASTE_FRESH_RUNTIME_PASSWORD_HERE>'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 20;
CREATE ROLE hon_outbox_worker LOGIN PASSWORD '<PASTE_FRESH_OUTBOX_WORKER_PASSWORD_HERE>'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 10;
CREATE ROLE hon_communication_worker LOGIN PASSWORD '<PASTE_FRESH_COMMUNICATION_WORKER_PASSWORD_HERE>'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 10;
CREATE ROLE hon_automation_worker LOGIN PASSWORD '<PASTE_FRESH_AUTOMATION_WORKER_PASSWORD_HERE>'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 5;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['hon_runtime','hon_outbox_worker','hon_communication_worker','hon_automation_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.member WHERE x.rolname = r) THEN
      RAISE EXCEPTION 'Fresh role % unexpectedly has a role membership.', r;
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE postgres FROM %I', r);
    EXECUTE format('GRANT CONNECT ON DATABASE postgres TO %I', r);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', r);
    EXECUTE format('ALTER ROLE %I SET search_path = hon, pg_catalog', r);
  END LOOP;
END;
$$;

-- As 0126 and 010 do: bound parameters (tenant data) never reach the server log for the runtime, from its first login.
ALTER ROLE hon_runtime SET log_parameter_max_length = 0;
ALTER ROLE hon_runtime SET log_parameter_max_length_on_error = 0;

COMMIT;
