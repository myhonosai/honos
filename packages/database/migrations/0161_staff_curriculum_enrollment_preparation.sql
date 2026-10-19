BEGIN;

-- This boundary owns no mutable state. It must be installed only by the trusted
-- migration owner, while the runtime account remains a restricted executor.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Curriculum enrollment preparation requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')) THEN
    RAISE EXCEPTION 'Curriculum enrollment preparation requires a restricted runtime';
  END IF;
END $$;

-- Private direct-human proof. The selected tenant is established solely by the
-- transaction-local GUCs; neither helper nor projection accepts organization,
-- school, principal, permission, delegated, action, page, search, or filter data.
CREATE FUNCTION hon.require_staff_curriculum_enrollment_preparation_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE org uuid; school uuid; principal uuid; actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject', true)
    OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'CURRICULUM_ENROLLMENT_PREPARATION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  BEGIN
    org := hon.current_organization_id();
    school := hon.current_school_id();
    principal := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'CURRICULUM_ENROLLMENT_PREPARATION_FORBIDDEN' USING ERRCODE = '42501';
  END;
  IF org IS NULL OR school IS NULL OR principal IS NULL
    OR org::text IS DISTINCT FROM current_setting('app.hon_organization_id', true)
    OR school::text IS DISTINCT FROM current_setting('app.hon_school_id', true) THEN
    RAISE EXCEPTION 'CURRICULUM_ENROLLMENT_PREPARATION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT p.id INTO actor
  FROM hon.users AS u
  JOIN hon.principals AS p ON p.user_id = u.id
  WHERE u.external_subject = p_subject
    AND p.id = principal AND p.principal_type = 'HUMAN_USER' AND p.is_active
    -- A human with any other active principal is mixed and cannot use this read.
    AND (SELECT count(*) FROM hon.principals AS other WHERE other.user_id = u.id AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.organizations AS organization WHERE organization.id = org AND organization.status = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM hon.schools AS current_school
      WHERE current_school.id = school AND current_school.organization_id = org AND current_school.status = 'ACTIVE')
    AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants AS family WHERE family.principal_id = p.id
      AND family.effective_from <= clock_timestamp() AND (family.effective_until IS NULL OR family.effective_until > clock_timestamp()))
    AND NOT EXISTS (
      SELECT 1 FROM hon.principal_role_grants AS mixed
      JOIN hon.roles AS mixed_role ON mixed_role.id = mixed.role_id AND mixed_role.organization_id = mixed.organization_id
      WHERE mixed.principal_id = p.id AND mixed.revoked_at IS NULL
        AND mixed.effective_from <= clock_timestamp() AND (mixed.effective_until IS NULL OR mixed.effective_until > clock_timestamp())
        AND mixed_role.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
    )
    AND hon.staff_member_eligible(p.id, org, school)
    AND EXISTS (
      SELECT 1 FROM hon.principal_role_grants AS role_grant
      JOIN hon.roles AS role ON role.id = role_grant.role_id AND role.organization_id = role_grant.organization_id
      JOIN hon.role_permissions AS role_permission ON role_permission.role_id = role.id AND role_permission.organization_id = role.organization_id
      JOIN hon.permissions AS permission ON permission.code = role_permission.permission_code
      WHERE role_grant.principal_id = p.id AND role_grant.organization_id = org AND role_grant.school_id = school
        AND role_grant.revoked_at IS NULL AND role_grant.effective_from <= clock_timestamp()
        AND (role_grant.effective_until IS NULL OR role_grant.effective_until > clock_timestamp())
        AND (role.management_school_id IS NULL OR role.management_school_id = school)
        AND role.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND permission.code = 'curriculum.progress.record' AND permission.is_staff_assignable
    )
    AND EXISTS (
      SELECT 1 FROM hon.organization_entitlements AS entitlement
      WHERE entitlement.organization_id = org AND entitlement.status = 'ACTIVE'
        AND entitlement.tier IN ('ESSENTIAL','CORE','COMPLETE')
        AND entitlement.effective_from <= clock_timestamp()
        AND (entitlement.effective_until IS NULL OR entitlement.effective_until > clock_timestamp())
    );
  IF actor IS NULL THEN RAISE EXCEPTION 'CURRICULUM_ENROLLMENT_PREPARATION_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- The only selector is one exact existing active student. Curricula remain an
-- unfiltered same-school preparation list: canonical enrollment has no
-- published-only gate. No enrollment is created or altered by this function.
CREATE FUNCTION hon.read_staff_curriculum_enrollment_preparation(p_subject text, p_student_profile_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE org uuid; school uuid; student_display_name text; curricula jsonb; result jsonb;
BEGIN
  IF p_student_profile_id IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_staff_curriculum_enrollment_preparation_actor(p_subject);
  org := hon.current_organization_id();
  school := hon.current_school_id();

  SELECT btrim(concat_ws(' ', person.given_name, person.family_name)) INTO student_display_name
  FROM hon.student_profiles AS student
  JOIN hon.people AS person ON person.id = student.person_id
    AND person.organization_id = student.organization_id AND person.school_id = student.school_id
  WHERE student.id = p_student_profile_id AND student.organization_id = org AND student.school_id = school
    AND student.status = 'ACTIVE';
  IF NOT FOUND OR student_display_name IS NULL OR length(student_display_name) NOT BETWEEN 1 AND 201
    OR student_display_name <> btrim(student_display_name) OR student_display_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'CURRICULUM_ENROLLMENT_PREPARATION_STUDENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(jsonb_agg(curriculum.item ORDER BY curriculum.name COLLATE "C", curriculum.id), '[]'::jsonb) INTO curricula
  FROM (
    SELECT c.id, c.name,
      jsonb_build_object('id', c.id, 'name', c.name, 'ranks', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', rank.id, 'name', rank.name, 'progressionOrder', rank.progression_order)
          ORDER BY rank.progression_order, rank.name COLLATE "C", rank.id)
        FROM hon.curriculum_ranks AS rank
        WHERE rank.organization_id = org AND rank.school_id = school AND rank.curriculum_id = c.id
      ), '[]'::jsonb)) AS item
    FROM hon.curricula AS c
    WHERE c.organization_id = org AND c.school_id = school
      AND length(c.name) BETWEEN 1 AND 140 AND c.name = btrim(c.name) AND c.name !~ '[[:cntrl:]]'
      AND NOT EXISTS (
        SELECT 1 FROM hon.curriculum_ranks AS unsafe_rank
        WHERE unsafe_rank.organization_id = org AND unsafe_rank.school_id = school AND unsafe_rank.curriculum_id = c.id
          AND (length(unsafe_rank.name) NOT BETWEEN 1 AND 120 OR unsafe_rank.name <> btrim(unsafe_rank.name)
            OR unsafe_rank.name ~ '[[:cntrl:]]' OR unsafe_rank.progression_order < 1)
      )
    ORDER BY c.name COLLATE "C", c.id
    LIMIT 250
  ) AS curriculum;
  -- Do not silently omit malformed existing curriculum records from a preparation
  -- list. Their presence makes the projection unavailable rather than widening it.
  IF EXISTS (
    SELECT 1 FROM hon.curricula AS c
    WHERE c.organization_id = org AND c.school_id = school
      AND (length(c.name) NOT BETWEEN 1 AND 140 OR c.name <> btrim(c.name) OR c.name ~ '[[:cntrl:]]'
        OR EXISTS (SELECT 1 FROM hon.curriculum_ranks AS rank WHERE rank.organization_id = org AND rank.school_id = school
          AND rank.curriculum_id = c.id AND (length(rank.name) NOT BETWEEN 1 AND 120 OR rank.name <> btrim(rank.name)
            OR rank.name ~ '[[:cntrl:]]' OR rank.progression_order < 1)))
  ) OR (SELECT count(*) FROM hon.curricula WHERE organization_id = org AND school_id = school) > 250
    OR EXISTS (SELECT 1 FROM hon.curriculum_ranks WHERE organization_id = org AND school_id = school GROUP BY curriculum_id HAVING count(*) > 250) THEN
    RAISE EXCEPTION 'CURRICULUM_ENROLLMENT_PREPARATION_UNAVAILABLE' USING ERRCODE = '22023';
  END IF;

  result := jsonb_build_object('student', jsonb_build_object('id', p_student_profile_id, 'displayName', student_display_name), 'curricula', curricula);
  -- Live authority is checked again immediately before returning captured data.
  PERFORM hon.require_staff_curriculum_enrollment_preparation_actor(p_subject);
  RETURN result;
END $$;

-- Preserve forced source-table RLS. The projection is the only new executable
-- routine; it grants no source-table privilege. Existing separately governed
-- curriculum/person operations retain only their prior runtime grants, and the
-- actor helper for this projection stays private.
ALTER TABLE hon.people ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.people FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.student_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.student_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.curricula ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.curricula FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_ranks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_ranks FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hon.people, hon.student_profiles, hon.curricula, hon.curriculum_ranks FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.require_staff_curriculum_enrollment_preparation_actor(text),
  hon.read_staff_curriculum_enrollment_preparation(text,uuid) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.require_staff_curriculum_enrollment_preparation_actor(text) FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_staff_curriculum_enrollment_preparation(text,uuid) FROM %I', role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_staff_curriculum_enrollment_preparation(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
