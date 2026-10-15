-- HON / Supabase durable outbox worker role
-- Run after HON migrations through 0021 have completed. Replace the placeholder
-- with a freshly generated base64url password; do not save it in Git.
ROLLBACK;
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_outbox_worker') THEN
    RAISE EXCEPTION 'Role hon_outbox_worker already exists. Inspect and rotate it deliberately rather than overwriting it.';
  END IF;
END;
$$;

CREATE ROLE hon_outbox_worker
  LOGIN
  PASSWORD '<PASTE_FRESH_BASE64URL_PASSWORD_HERE>'
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  CONNECTION LIMIT 10;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members AS membership
    JOIN pg_roles AS member_role ON member_role.oid = membership.member
    WHERE member_role.rolname = 'hon_outbox_worker'
  ) THEN
    RAISE EXCEPTION 'Fresh hon_outbox_worker unexpectedly has an explicit role membership.';
  END IF;
END;
$$;

REVOKE ALL PRIVILEGES ON DATABASE postgres FROM hon_outbox_worker;
GRANT CONNECT ON DATABASE postgres TO hon_outbox_worker;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM hon_outbox_worker;
GRANT USAGE ON SCHEMA hon TO hon_outbox_worker;
ALTER ROLE hon_outbox_worker SET search_path = hon, pg_catalog;

-- No direct HON table, sequence, schema, role, migration, or extension access.
-- The worker has only the two reviewed security-definer delivery functions.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA hon FROM hon_outbox_worker;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA hon FROM hon_outbox_worker;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA hon FROM hon_outbox_worker;
REVOKE USAGE ON TYPE hon.outbox_delivery_outcome FROM PUBLIC;
GRANT USAGE ON TYPE hon.outbox_delivery_outcome TO hon_outbox_worker;
REVOKE EXECUTE ON FUNCTION hon.claim_outbox_delivery_batch(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION hon.record_outbox_delivery_result(uuid, uuid, hon.outbox_delivery_outcome, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hon.claim_outbox_delivery_batch(integer, integer) TO hon_outbox_worker;
GRANT EXECUTE ON FUNCTION hon.record_outbox_delivery_result(uuid, uuid, hon.outbox_delivery_outcome, jsonb, integer) TO hon_outbox_worker;

COMMIT;
