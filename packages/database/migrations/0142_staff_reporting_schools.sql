BEGIN;

-- Dashboard-only choices, not an arbitrary directory, default, or authority.
-- The existing 0141 exact-one resolver and all table/RLS grants are untouched.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
      AND rolname NOT IN ('hon_runtime', 'anon', 'authenticated', 'service_role')
  ) THEN
    RAISE EXCEPTION 'Staff reporting schools require a trusted migration owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')
  ) THEN
    RAISE EXCEPTION 'Staff reporting schools require a restricted non-bypass runtime role';
  END IF;
END;
$$;

CREATE FUNCTION hon.read_staff_reporting_schools(p_subject text)
RETURNS TABLE (organization_id uuid, school_id uuid, organization_name text, school_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  WITH live_identity AS MATERIALIZED (
    SELECT principal.id AS principal_id
    FROM hon.users AS app_user
    JOIN hon.principals AS principal ON principal.user_id = app_user.id
    WHERE app_user.external_subject = p_subject
      AND principal.principal_type = 'HUMAN_USER' AND principal.is_active
      AND (SELECT count(*) FROM hon.principals AS other
           WHERE other.user_id = app_user.id AND other.is_active) = 1
      AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq
                      WHERE hq.principal_id = principal.id)
      AND NOT EXISTS (
        SELECT 1 FROM hon.family_access_grants AS family
        WHERE family.principal_id = principal.id AND family.effective_from <= statement_timestamp()
          AND (family.effective_until IS NULL OR family.effective_until > statement_timestamp())
      )
      -- Mixed roles anywhere disqualify the entire response, even without reporting.
      AND NOT EXISTS (
        SELECT 1 FROM hon.principal_role_grants AS mixed
        JOIN hon.roles AS mixed_role ON mixed_role.id = mixed.role_id
          AND mixed_role.organization_id = mixed.organization_id
        WHERE mixed.principal_id = principal.id AND mixed.revoked_at IS NULL
          AND mixed.effective_from <= statement_timestamp()
          AND (mixed.effective_until IS NULL OR mixed.effective_until > statement_timestamp())
          AND mixed_role.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
      )
  ), current_scopes AS MATERIALIZED (
    -- Count ALL live active school scopes before reporting/role compatibility.
    -- A second non-reporting or incompatible scope must not reveal a subset.
    SELECT DISTINCT identity.principal_id, role_grant.organization_id, role_grant.school_id
    FROM live_identity AS identity
    JOIN hon.principal_role_grants AS role_grant ON role_grant.principal_id = identity.principal_id
    JOIN hon.roles AS role ON role.id = role_grant.role_id AND role.organization_id = role_grant.organization_id
    JOIN hon.schools AS school ON school.id = role_grant.school_id
      AND school.organization_id = role_grant.organization_id AND school.status = 'ACTIVE'
    JOIN hon.organizations AS organization ON organization.id = school.organization_id AND organization.status = 'ACTIVE'
    WHERE role_grant.revoked_at IS NULL AND role_grant.effective_from <= statement_timestamp()
      AND (role_grant.effective_until IS NULL OR role_grant.effective_until > statement_timestamp())
  ), candidates AS MATERIALIZED (
    SELECT scope.organization_id, scope.school_id,
      btrim(organization.display_name) AS organization_name, btrim(school.name) AS school_name
    FROM current_scopes AS scope
    JOIN hon.schools AS school ON school.id = scope.school_id AND school.organization_id = scope.organization_id
    JOIN hon.organizations AS organization ON organization.id = scope.organization_id
    WHERE hon.staff_member_eligible(scope.principal_id, scope.organization_id, scope.school_id)
      AND EXISTS (
        SELECT 1 FROM hon.principal_role_grants AS role_grant
        JOIN hon.roles AS role ON role.id = role_grant.role_id AND role.organization_id = role_grant.organization_id
        JOIN hon.role_permissions AS role_permission ON role_permission.role_id = role.id
          AND role_permission.organization_id = role.organization_id
        JOIN hon.permissions AS permission ON permission.code = role_permission.permission_code
        WHERE role_grant.principal_id = scope.principal_id
          AND role_grant.organization_id = scope.organization_id AND role_grant.school_id = scope.school_id
          AND role_grant.revoked_at IS NULL AND role_grant.effective_from <= statement_timestamp()
          AND (role_grant.effective_until IS NULL OR role_grant.effective_until > statement_timestamp())
          AND (role.management_school_id IS NULL OR role.management_school_id = scope.school_id)
          AND role.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
          AND permission.code = 'reporting.view' AND permission.is_staff_assignable
      )
  )
  SELECT candidate.organization_id, candidate.school_id, candidate.organization_name, candidate.school_name
  FROM candidates AS candidate
  -- Exact-one remains solely 0141's default. Over-cap is common nonresolution,
  -- never a truncated directory. No list unless EVERY live scope is eligible.
  WHERE (SELECT count(*) FROM current_scopes) BETWEEN 2 AND 20
    AND (SELECT count(*) FROM candidates) = (SELECT count(*) FROM current_scopes)
    AND NOT EXISTS (
      SELECT 1 FROM candidates AS unsafe
      WHERE length(unsafe.organization_name) NOT BETWEEN 1 AND 120
        OR length(unsafe.school_name) NOT BETWEEN 1 AND 120
        OR unsafe.organization_name ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]'
        OR unsafe.school_name ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]'
    )
  ORDER BY candidate.organization_name, candidate.school_name, candidate.organization_id, candidate.school_id
  LIMIT 20;
$$;

REVOKE ALL ON FUNCTION hon.read_staff_reporting_schools(text) FROM PUBLIC;
DO $$
DECLARE client_role text;
BEGIN
  FOR client_role IN SELECT rolname FROM pg_roles
    WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role')
      OR oid IN (
        SELECT acl.grantee FROM pg_proc AS proc
        CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS acl
        WHERE proc.oid = 'hon.read_staff_reporting_schools(text)'::regprocedure AND acl.grantee <> proc.proowner
      ) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_staff_reporting_schools(text) FROM %I', client_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_staff_reporting_schools(text) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
