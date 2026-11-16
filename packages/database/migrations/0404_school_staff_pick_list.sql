BEGIN;

-- 0404 (owner 2026-11-16): staff pick a teammate by name instead of typing a staff principal UUID.
-- One closed, read-only list of the people who currently hold an active role at the caller's own school
-- (the tenant transaction's school) and are eligible staff there (hon.staff_member_eligible), returning only principal id and display name: no email, external
-- subject, roles, grants or history. The caller must be a signed-in human (HUMAN_UI) who holds, at this
-- exact school, the permission of the screen asking (an allow-listed manage/grant permission), and the
-- organization must have a live ESSENTIAL/CORE/COMPLETE entitlement. Nothing here writes.

CREATE FUNCTION hon.list_school_staff_for_picker(p_subject text, p_permission text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_org uuid := hon.current_organization_id();
  v_school uuid := hon.current_school_id();
  v_actor uuid;
  v_items jsonb;
BEGIN
  IF p_permission IS NULL OR p_permission NOT IN ('crm.follow_up.manage', 'work_item.manage', 'staff.instructor_qualification.manage',
      'iam.staff_role.grant', 'staff.availability.manage') THEN
    RAISE EXCEPTION 'STAFF_PICKER_PURPOSE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_org IS NULL OR v_school IS NULL OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI' THEN
    RAISE EXCEPTION 'STAFF_PICKER_SCOPE_DENIED' USING ERRCODE = '42501';
  END IF;
  SELECT s.principal_id INTO v_actor FROM hon.resolve_authorized_scope(p_subject, v_school, p_permission) AS s
   WHERE s.organization_id = v_org AND s.school_id = v_school;
  IF v_actor IS NULL OR v_actor IS DISTINCT FROM nullif(current_setting('app.hon_principal_id', true), '')::uuid THEN
    RAISE EXCEPTION 'STAFF_PICKER_SCOPE_DENIED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.read_current_organization_entitlement() AS e WHERE e.tier IN ('ESSENTIAL', 'CORE', 'COMPLETE')) THEN
    RAISE EXCEPTION 'TIER_ENTITLEMENT_REQUIRED' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('principalId', rows.id, 'displayName', rows.name) ORDER BY rows.name, rows.id), '[]'::jsonb)
    INTO v_items
    FROM (
      SELECT p.id, left(COALESCE(NULLIF(btrim(p.display_name), ''), NULLIF(btrim(u.display_name), ''), 'Staff member'), 120) AS name
        FROM hon.principals AS p
        JOIN hon.users AS u ON u.id = p.user_id
       WHERE p.principal_type = 'HUMAN_USER' AND p.is_active
         -- 0077's staff eligibility: a staff-assignable role grant live at this school, excluding HQ operators and
         -- family, student, HQ and platform role codes.
         AND EXISTS (SELECT 1 FROM hon.principal_role_grants AS g
                      WHERE g.principal_id = p.id AND g.organization_id = v_org AND g.school_id = v_school
                        AND g.revoked_at IS NULL AND g.effective_from <= statement_timestamp()
                        AND (g.effective_until IS NULL OR g.effective_until > statement_timestamp()))
         AND hon.staff_member_eligible(p.id, v_org, v_school)
       ORDER BY 2, p.id
       LIMIT 200
    ) AS rows;
  RETURN jsonb_build_object('items', v_items);
END;
$$;

DO $$
DECLARE v_role text;
BEGIN
  REVOKE ALL ON FUNCTION hon.list_school_staff_for_picker(text, text) FROM PUBLIC;
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role', 'hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.list_school_staff_for_picker(text, text) FROM %I', v_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.list_school_staff_for_picker(text, text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
