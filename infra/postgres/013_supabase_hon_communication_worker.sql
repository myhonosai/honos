-- HON / Supabase communication delivery worker role (0243, docs/architecture/COMMUNICATION_DELIVERY.md)
-- Run after HON migrations through 0243 have completed. Replace the placeholder with a freshly generated
-- base64url password; do not save it in Git. Store the Session Pooler URI only as
-- HON_COMMUNICATION_WORKER_DATABASE_URL (never DATABASE_URL or HON_RUNTIME_DATABASE_URL).
ROLLBACK;
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_communication_worker') THEN
    RAISE EXCEPTION 'Role hon_communication_worker already exists. Inspect and rotate it deliberately rather than overwriting it.';
  END IF;
  IF to_regprocedure('hon.claim_communication_deliveries(text[],integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'Apply communication delivery migration 0243 first.';
  END IF;
END;
$$;

CREATE ROLE hon_communication_worker
  LOGIN
  PASSWORD '<PASTE_FRESH_BASE64URL_PASSWORD_HERE>'
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  CONNECTION LIMIT 10;

REVOKE ALL PRIVILEGES ON DATABASE postgres FROM hon_communication_worker;
GRANT CONNECT ON DATABASE postgres TO hon_communication_worker;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM hon_communication_worker;
GRANT USAGE ON SCHEMA hon TO hon_communication_worker;
ALTER ROLE hon_communication_worker SET search_path = hon, pg_catalog;

-- No direct HON table, sequence or function access. The worker receives one leased send at a time and
-- reports results and verified provider receipts only through these four fixed functions.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA hon FROM hon_communication_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hon FROM hon_communication_worker;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA hon FROM hon_communication_worker;
GRANT EXECUTE ON FUNCTION hon.claim_communication_deliveries(text[], integer, integer) TO hon_communication_worker;
GRANT EXECUTE ON FUNCTION hon.reconcile_expired_communication_leases(integer) TO hon_communication_worker;
GRANT EXECUTE ON FUNCTION hon.record_communication_send_result(uuid, uuid, text, text, text, text, integer, text, text, integer) TO hon_communication_worker;
GRANT EXECUTE ON FUNCTION hon.record_communication_provider_event(text, text, text, uuid, text, timestamptz, bigint) TO hon_communication_worker;

COMMIT;
