BEGIN;

-- HQ School Management is a read-only, selector-free customer-account directory.
-- It creates no school/HQ authority bridge, support access, provider, financial,
-- messaging, audit, outbox, work, Action Engine, or mutation boundary.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'HQ school directory migration requires a trusted migration owner';
  END IF;
END;
$$;

-- The existing authoritative sources remain private and forced-RLS. The runtime
-- reaches them only through the single fixed projection below.
ALTER TABLE hon.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.schools FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.organization_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.organization_entitlements FORCE ROW LEVEL SECURITY;

CREATE FUNCTION hon.read_hq_school_directory(p_external_subject text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_hq_role text;
  v_directory jsonb;
BEGIN
  SELECT hq_role INTO v_hq_role
  FROM hon.resolve_hq_operator_scope(p_external_subject, 'hq.dashboard.view')
  WHERE hq_role IN ('HON_HQ_OWNER', 'HON_HQ_OPERATOR')
  LIMIT 1;

  IF v_hq_role IS NULL THEN
    RAISE EXCEPTION 'HQ school directory access denied' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schoolId', rows.school_id,
    'organizationDisplayName', rows.organization_display_name,
    'schoolDisplayName', rows.school_display_name,
    'organizationOperationalStatus', rows.organization_operational_status,
    'schoolOperationalStatus', rows.school_operational_status,
    'entitlementTier', rows.entitlement_tier,
    'createdAt', rows.created_at
  ) ORDER BY rows.created_at, rows.school_id), '[]'::jsonb)
  INTO v_directory
  FROM (
    SELECT
      school.id AS school_id,
      organization.display_name AS organization_display_name,
      school.name AS school_display_name,
      organization.status::text AS organization_operational_status,
      school.status::text AS school_operational_status,
      entitlement.tier::text AS entitlement_tier,
      to_char(school.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM hon.schools AS school
    JOIN hon.organizations AS organization ON organization.id = school.organization_id
    LEFT JOIN LATERAL (
      SELECT current_entitlement.tier
      FROM hon.organization_entitlements AS current_entitlement
      WHERE current_entitlement.organization_id = organization.id
        AND current_entitlement.status = 'ACTIVE'
        AND current_entitlement.effective_from <= current_timestamp
        AND (current_entitlement.effective_until IS NULL OR current_entitlement.effective_until > current_timestamp)
      ORDER BY current_entitlement.effective_from DESC, current_entitlement.tier
      LIMIT 1
    ) AS entitlement ON true
  ) AS rows;

  RETURN jsonb_build_object('schools', v_directory);
END;
$$;

-- Deny first: the restricted runtime gets this exact projection with no grant
-- option. Clients receive neither direct source-table access nor function access.
DO $$
DECLARE
  v_role text;
  v_table text;
  v_column text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['organizations', 'schools', 'organization_entitlements'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', v_table);
    FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
      -- organization_entitlements has a pre-existing tenant-RLS SELECT grant
      -- used by conventional school commands. Do not broaden or remove that
      -- established grant here; this HQ projection never sets tenant context.
      IF v_table <> 'organization_entitlements' OR v_role <> 'hon_runtime' THEN
        EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', v_table, v_role);
      END IF;
    END LOOP;
    FOR v_column IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.' || v_table)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON TABLE hon.%I FROM PUBLIC', v_column, v_table);
      FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON TABLE hon.%I FROM %I', v_column, v_table, v_role);
      END LOOP;
    END LOOP;
  END LOOP;

  REVOKE ALL ON FUNCTION hon.read_hq_school_directory(text) FROM PUBLIC;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_hq_school_directory(text) FROM %I', v_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hq_school_directory(text) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
