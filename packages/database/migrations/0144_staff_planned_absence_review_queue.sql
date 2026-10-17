BEGIN;

-- Additive functions only: preserve 0038/0039's source table, FORCE RLS,
-- lifecycle, policies and grants. No directory, history, count or export API.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Planned absence review requires a trusted migration owner';
  END IF;
END $$;

CREATE FUNCTION hon.resolve_planned_absence_review_scope(p_subject text)
RETURNS TABLE (principal_id uuid, organization_id uuid, school_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  WITH identity AS MATERIALIZED (
    SELECT p.id FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
    WHERE u.external_subject = p_subject AND length(p_subject) BETWEEN 1 AND 200 AND btrim(p_subject) = p_subject
      AND p.principal_type = 'HUMAN_USER' AND p.is_active
      AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
      AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
        AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))
      AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
        WHERE g.principal_id = p.id AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
          AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
          AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
  ), schools AS MATERIALIZED (
    SELECT DISTINCT i.id AS principal_id, g.organization_id, g.school_id
    FROM identity i JOIN hon.principal_role_grants g ON g.principal_id = i.id
    JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
    JOIN hon.schools s ON s.id = g.school_id AND s.organization_id = g.organization_id AND s.status = 'ACTIVE'
    JOIN hon.organizations o ON o.id = s.organization_id AND o.status = 'ACTIVE'
    WHERE g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
      AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (r.management_school_id IS NULL OR r.management_school_id = g.school_id)
      AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
  )
  SELECT s.principal_id, s.organization_id, s.school_id FROM schools s
  WHERE (SELECT count(*) FROM schools) = 1
    AND EXISTS (SELECT 1 FROM hon.principal_role_grants g
      JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id = r.id AND rp.organization_id = r.organization_id
      JOIN hon.permissions permission ON permission.code = rp.permission_code
      WHERE g.principal_id = s.principal_id AND g.organization_id = s.organization_id AND g.school_id = s.school_id
        AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id = s.school_id)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND permission.code = 'schedule.planned_absence.review' AND permission.is_staff_assignable)
    AND EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = s.organization_id
      AND e.status = 'ACTIVE' AND e.tier IN ('ESSENTIAL','CORE','COMPLETE')
      AND e.effective_from <= clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until > clock_timestamp()));
$$;

-- Private exact context check, also used before returning the projection.
CREATE FUNCTION hon.require_planned_absence_review_actor(p_subject text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM hon.resolve_planned_absence_review_scope(p_subject) s
      WHERE s.principal_id = nullif(current_setting('app.hon_principal_id',true),'')::uuid
        AND s.organization_id = hon.current_organization_id() AND s.school_id = hon.current_school_id()) THEN
    RAISE EXCEPTION 'PLANNED_ABSENCE_REVIEW_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Only the existing decision transaction uses this lock. Authority table SHARE
-- locks exclude revocations and new mixed-grant/identity phantoms through commit.
CREATE FUNCTION hon.lock_planned_absence_review_actor(p_subject text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  PERFORM hon.require_planned_absence_review_actor(p_subject);
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.roles,
    hon.role_permissions, hon.permissions, hon.hq_operator_grants,
    hon.family_access_grants, hon.organizations, hon.schools, hon.organization_entitlements IN SHARE MODE;
  PERFORM hon.require_planned_absence_review_actor(p_subject);
END;
$$;

CREATE FUNCTION hon.read_staff_planned_absence_review_queue(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE items jsonb;
BEGIN
  PERFORM hon.require_planned_absence_review_actor(p_subject);
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.submitted_at, x.id), '[]'::jsonb) INTO items FROM (
    SELECT request.id, request.created_at AS submitted_at, jsonb_build_object(
      'id', request.id, 'studentProfileId', request.student_profile_id,
      'startsAt', to_char(request.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endsAt', to_char(request.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'reason', request.reason, 'version', request.version,
      'submittedAt', to_char(request.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) AS item FROM hon.planned_absence_requests request
    WHERE request.organization_id = hon.current_organization_id() AND request.school_id = hon.current_school_id()
      AND request.status = 'SUBMITTED'::hon.planned_absence_request_status
    ORDER BY request.created_at, request.id LIMIT 50
  ) x;
  PERFORM hon.require_planned_absence_review_actor(p_subject);
  RETURN jsonb_build_object('organizationId', hon.current_organization_id(), 'schoolId', hon.current_school_id(), 'items', items);
END;
$$;

REVOKE ALL ON FUNCTION hon.resolve_planned_absence_review_scope(text), hon.require_planned_absence_review_actor(text),
  hon.lock_planned_absence_review_actor(text), hon.read_staff_planned_absence_review_queue(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','hon_runtime') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.resolve_planned_absence_review_scope(text), hon.require_planned_absence_review_actor(text), hon.lock_planned_absence_review_actor(text), hon.read_staff_planned_absence_review_queue(text) FROM %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_planned_absence_review_scope(text), hon.lock_planned_absence_review_actor(text), hon.read_staff_planned_absence_review_queue(text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
