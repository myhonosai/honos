BEGIN;

-- 0412 (owner 2026-11-16, "under staff, there should be setting to give permission to staff"): the Roles & permissions
-- page shows a checklist of the permissions the signed-in manager may put in a custom role, instead of typed codes.
-- One read-only definer entry point, authorized exactly like hon.list_staff_roles (0406): iam.staff_role.manage at the
-- exact school for the session principal, HUMAN_USER and HUMAN_UI only. It returns only what hon.mutate_staff_role
-- (0059) would accept: staff-assignable definitions, never hq./platform./system. codes, and only ones the caller holds
-- at this school. Nothing here writes; the write path keeps every check. Bounded to 200 rows.

CREATE FUNCTION hon.list_assignable_staff_permissions(p_external_subject text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid;
  v_org uuid := hon.current_organization_id();
  v_school uuid := hon.current_school_id();
  v_items jsonb;
BEGIN
  SELECT principal_id INTO v_actor FROM hon.resolve_authorized_scope(p_external_subject, v_school, 'iam.staff_role.manage')
   WHERE organization_id = v_org;
  IF v_org IS NULL OR v_school IS NULL OR v_actor IS NULL OR v_actor::text IS DISTINCT FROM current_setting('app.hon_principal_id', true)
     OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
     OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI' THEN
    RAISE EXCEPTION 'STAFF_ROLE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', rows.code, 'description', rows.description, 'sensitive', rows.is_sensitive)
           ORDER BY rows.code), '[]'::jsonb) INTO v_items
    FROM (SELECT p.code, left(COALESCE(NULLIF(btrim(p.description), ''), p.code), 300) AS description, p.is_sensitive
            FROM hon.permissions AS p
           WHERE p.is_staff_assignable AND p.code !~ '^(hq|platform|system)\.'
             AND hon.principal_has_school_permission(v_actor, v_org, v_school, p.code)
           ORDER BY p.code
           LIMIT 200) AS rows;
  RETURN jsonb_build_object('permissions', v_items);
END;
$$;

DO $$
DECLARE v_role text; v_fn constant text := 'hon.list_assignable_staff_permissions(text)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role', 'hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_fn, v_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime', v_fn);
  END IF;
END $$;

COMMIT;
