BEGIN;

-- 0406 (owner 2026-11-16, "these ids don't make sense"): staff open qualifications, evidence, roles and grants from
-- lists at their own signed-in school instead of typing record UUIDs. Two read-only definer entry points, each
-- authorized exactly like the existing single-record read it complements:
--   * hon.list_instructor_qualifications(subject, mode, staff) mirrors hon.read_instructor_qualification (0109/0111):
--     direct HUMAN_UI human, staff.instructor_qualification.read (or .manage), live school/organization and
--     entitlement through the existing actor checks, re-checked after the read; items use the same redacted
--     projections (no evidence reference, review note or actor), plus a staff list that names eligible staff only.
--   * hon.list_staff_roles(subject) mirrors hon.read_staff_role (0059): iam.staff_role.manage for the session
--     principal, HUMAN_USER/HUMAN_UI; custom school roles and their current grants, never system/owner/HQ roles.
-- Nothing here writes. Each list is bounded.

CREATE FUNCTION hon.list_instructor_qualifications(p_subject text, p_mode text, p_staff uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_permission constant text := 'staff.instructor_qualification.read';
  v_org uuid := hon.current_organization_id();
  v_school uuid := hon.current_school_id();
  v_items jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('DEFINITIONS', 'STAFF', 'EVIDENCE')
     OR (p_mode = 'EVIDENCE') IS DISTINCT FROM (p_staff IS NOT NULL) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.lock_instructor_qualification_actor(p_subject, v_permission, false);
  IF p_mode = 'DEFINITIONS' THEN
    SELECT COALESCE(jsonb_agg(rows.item ORDER BY (rows.item->>'status') = 'RETIRED', rows.code, rows.id), '[]'::jsonb) INTO v_items
      FROM (SELECT q.id, q.code, projection.item
              FROM hon.instructor_qualifications AS q
              CROSS JOIN LATERAL (SELECT hon.instructor_qualification_definition_projection(q.id) AS item) AS projection
             WHERE q.organization_id = v_org AND q.school_id = v_school
             ORDER BY (projection.item->>'status') = 'RETIRED', q.code, q.id
             LIMIT 200) AS rows;
  ELSIF p_mode = 'STAFF' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('principalId', rows.id, 'displayName', rows.name, 'evidenceCount', rows.evidence)
             ORDER BY rows.name, rows.id), '[]'::jsonb) INTO v_items
      FROM (SELECT p.id, left(COALESCE(NULLIF(btrim(p.display_name), ''), NULLIF(btrim(u.display_name), ''), 'Staff member'), 120) AS name,
                   (SELECT count(*) FROM hon.instructor_qualification_evidence AS e
                     WHERE e.staff_principal_id = p.id AND e.organization_id = v_org AND e.school_id = v_school)::integer AS evidence
              FROM hon.principals AS p
              JOIN hon.users AS u ON u.id = p.user_id
             WHERE p.principal_type = 'HUMAN_USER' AND p.is_active
               AND hon.staff_member_eligible(p.id, v_org, v_school)
             ORDER BY 2, p.id
             LIMIT 200) AS rows;
  ELSE
    IF NOT hon.staff_member_eligible(p_staff, v_org, v_school) THEN
      RAISE EXCEPTION 'STAFF_MEMBER_UNAVAILABLE' USING ERRCODE = '42501';
    END IF;
    SELECT COALESCE(jsonb_agg(rows.item ORDER BY rows.recorded_at DESC, rows.id), '[]'::jsonb) INTO v_items
      FROM (SELECT e.id, e.recorded_at, hon.instructor_qualification_evidence_projection(e.id, p_staff) AS item
              FROM hon.instructor_qualification_evidence AS e
             WHERE e.staff_principal_id = p_staff AND e.organization_id = v_org AND e.school_id = v_school
             ORDER BY e.recorded_at DESC, e.id
             LIMIT 100) AS rows;
  END IF;
  -- Authority is decided again after the read, as hon.read_instructor_qualification does.
  PERFORM hon.require_instructor_qualification_actor(p_subject, v_permission);
  RETURN jsonb_build_object('items', v_items);
END;
$$;

CREATE FUNCTION hon.list_staff_roles(p_external_subject text)
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
  v_roles jsonb;
  v_grants jsonb;
BEGIN
  SELECT principal_id INTO v_actor FROM hon.resolve_authorized_scope(p_external_subject, v_school, 'iam.staff_role.manage')
   WHERE organization_id = v_org;
  IF v_org IS NULL OR v_school IS NULL OR v_actor IS NULL OR v_actor::text IS DISTINCT FROM current_setting('app.hon_principal_id', true)
     OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
     OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI' THEN
    RAISE EXCEPTION 'STAFF_ROLE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rows.id, 'code', rows.code, 'name', rows.name, 'version', rows.version,
           'permissionCodes', rows.permissions) ORDER BY rows.name, rows.id), '[]'::jsonb) INTO v_roles
    FROM (SELECT r.id, r.code, r.name, r.version,
                 COALESCE((SELECT jsonb_agg(rp.permission_code ORDER BY rp.permission_code) FROM hon.role_permissions AS rp WHERE rp.role_id = r.id), '[]'::jsonb) AS permissions
            FROM hon.roles AS r
           WHERE r.organization_id = v_org AND NOT r.is_system_role AND r.code !~ '^(OWNER|HON_|HQ|PLATFORM|SYSTEM)'
             AND (r.management_school_id IS NULL OR r.management_school_id = v_school)
           ORDER BY r.name, r.id
           LIMIT 200) AS rows;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', rows.id, 'roleId', rows.role_id, 'roleName', rows.role_name,
           'principalId', rows.principal_id, 'displayName', rows.display_name, 'version', rows.version,
           'effectiveFrom', rows.effective_from, 'effectiveUntil', rows.effective_until)
           ORDER BY rows.display_name, rows.role_name, rows.id), '[]'::jsonb) INTO v_grants
    FROM (SELECT g.id, g.role_id, r.name AS role_name, g.principal_id, g.version, g.effective_from, g.effective_until,
                 left(COALESCE(NULLIF(btrim(p.display_name), ''), NULLIF(btrim(u.display_name), ''), 'Staff member'), 120) AS display_name
            FROM hon.principal_role_grants AS g
            JOIN hon.roles AS r ON r.id = g.role_id AND r.organization_id = g.organization_id
            JOIN hon.principals AS p ON p.id = g.principal_id
            JOIN hon.users AS u ON u.id = p.user_id
           WHERE g.organization_id = v_org AND g.school_id = v_school AND g.revoked_at IS NULL
             AND (g.effective_until IS NULL OR g.effective_until > statement_timestamp())
             AND NOT r.is_system_role AND r.code !~ '^(OWNER|HON_|HQ|PLATFORM|SYSTEM)'
           ORDER BY 8, 3, g.id
           LIMIT 200) AS rows;
  RETURN jsonb_build_object('roles', v_roles, 'grants', v_grants);
END;
$$;

DO $$
DECLARE v_role text; v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['hon.list_instructor_qualifications(text,text,uuid)', 'hon.list_staff_roles(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role', 'hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_fn, v_role);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime', v_fn);
    END IF;
  END LOOP;
END $$;

COMMIT;
