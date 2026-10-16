BEGIN;

-- Reconcile 0129's historical entitlement SELECT exception only after the API
-- has moved to this fixed read boundary. Applied migrations remain immutable.
-- Keep the established trusted definer owner; never elevate the runtime role or
-- give it BYPASSRLS, ownership, a selector, or source-table mutation authority.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
      AND rolname NOT IN ('hon_runtime', 'anon', 'authenticated', 'service_role')
  ) THEN
    RAISE EXCEPTION 'Entitlement read boundary requires a trusted migration owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')
  ) THEN
    RAISE EXCEPTION 'Entitlement read boundary requires a restricted, non-bypass runtime role';
  END IF;
END;
$$;

ALTER TABLE hon.organization_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.organization_entitlements FORCE ROW LEVEL SECURITY;

-- organization_id is the primary key: equality below returns at most one row.
-- Missing context or an inactive/not-yet-effective/expired entitlement returns
-- no row. Keep transaction-time activation and fail closed at statement-time
-- expiry so a post-wait Action review cannot reuse an expired tier.
CREATE FUNCTION hon.read_current_organization_entitlement()
RETURNS TABLE (tier text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT entitlement.tier::text
  FROM hon.organization_entitlements AS entitlement
  WHERE entitlement.organization_id = hon.current_organization_id()
    AND entitlement.status = 'ACTIVE'::hon.membership_status
    AND entitlement.effective_from <= current_timestamp
    AND (entitlement.effective_until IS NULL OR entitlement.effective_until > statement_timestamp())
$$;

DO $$
DECLARE
  v_role text;
  v_column text;
BEGIN
  REVOKE ALL ON TABLE hon.organization_entitlements FROM PUBLIC CASCADE;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.organization_entitlements FROM %I CASCADE', v_role);
  END LOOP;
  -- Table-level REVOKE does not remove independently granted column privileges.
  FOR v_column IN SELECT attname FROM pg_attribute
    WHERE attrelid = 'hon.organization_entitlements'::regclass AND attnum > 0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON TABLE hon.organization_entitlements FROM PUBLIC CASCADE', v_column);
    FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON TABLE hon.organization_entitlements FROM %I CASCADE', v_column, v_role);
    END LOOP;
  END LOOP;

  REVOKE ALL ON FUNCTION hon.read_current_organization_entitlement() FROM PUBLIC;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_current_organization_entitlement() FROM %I', v_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_current_organization_entitlement() TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
