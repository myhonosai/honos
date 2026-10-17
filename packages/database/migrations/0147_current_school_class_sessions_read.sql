BEGIN;

-- Fixed current-school operational projection only. It neither changes the
-- class_sessions model nor joins instructors, bookings, attendance, families,
-- enrollment, ClassPass, membership, payments, providers, AI, or Action Engine.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Class-session read requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')) THEN
    RAISE EXCEPTION 'Class-session read requires a restricted runtime';
  END IF;
END $$;

-- schedule.session.manage is a command authority. This separate, non-sensitive
-- fact-read authority is intentionally granted only to existing system OWNERs;
-- future system OWNER provisioning already copies all current permissions.
INSERT INTO hon.permissions (code, description, is_sensitive, is_staff_assignable)
VALUES ('schedule.session.read', 'Read a bounded current-school operational class-session list', false, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code = 'schedule.session.read'
WHERE role.code = 'OWNER' AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Private helper rejects non-human, HQ, family/parent/student/mixed-role,
-- delegated, action-request, cross-school, expired, revoked and unentitled
-- contexts. Its exact school is established from the runtime tenant GUCs, not
-- from a caller-provided selector inside the projection function.
CREATE FUNCTION hon.require_current_school_class_sessions_read_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE org uuid; school uuid; principal uuid; actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject', true)
    OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  BEGIN
    org := hon.current_organization_id();
    school := hon.current_school_id();
    principal := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE = '42501';
  END;
  IF org::text IS DISTINCT FROM current_setting('app.hon_organization_id', true)
    OR school::text IS DISTINCT FROM current_setting('app.hon_school_id', true) THEN
    RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT p.id INTO actor
  FROM hon.users AS u
  JOIN hon.principals AS p ON p.user_id = u.id
  WHERE u.external_subject = p_subject
    AND p.id = principal AND p.principal_type = 'HUMAN_USER' AND p.is_active
    -- Reject a nonhuman or any other active principal for this user.
    AND (SELECT count(*) FROM hon.principals AS other WHERE other.user_id = u.id AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.organizations AS organization WHERE organization.id = org AND organization.status = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM hon.schools AS current_school
      WHERE current_school.id = school AND current_school.organization_id = org AND current_school.status = 'ACTIVE')
    -- This is never an HQ, family/delegated, parent, student or mixed context.
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
        AND permission.code = 'schedule.session.read' AND permission.is_staff_assignable
    )
    AND EXISTS (
      SELECT 1 FROM hon.organization_entitlements AS entitlement
      WHERE entitlement.organization_id = org AND entitlement.status = 'ACTIVE'
        AND entitlement.tier IN ('ESSENTIAL','CORE','COMPLETE')
        AND entitlement.effective_from <= clock_timestamp()
        AND (entitlement.effective_until IS NULL OR entitlement.effective_until > clock_timestamp())
    );
  IF actor IS NULL THEN RAISE EXCEPTION 'CLASS_SESSIONS_READ_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- The window is fixed per database statement: starts inclusive at 00:00 UTC 30
-- calendar days before today and ends exclusive at 00:00 UTC 91 days after
-- today (therefore it includes today through 90 days forward). Sorting is by
-- persisted starts_at then id; no client filter, cursor, range, search or list
-- selector exists. The sole effect is a bounded JSON projection of session facts.
CREATE FUNCTION hon.read_current_school_class_sessions(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE window_start timestamptz; window_end timestamptz; result jsonb;
BEGIN
  PERFORM hon.require_current_school_class_sessions_read_actor(p_subject);
  window_start := (date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') - interval '30 days') AT TIME ZONE 'UTC';
  window_end := (date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') + interval '91 days') AT TIME ZONE 'UTC';
  SELECT coalesce(jsonb_agg(item.item ORDER BY item.starts_at, item.id), '[]'::jsonb) INTO result
  FROM (
    SELECT session.id, session.starts_at, jsonb_build_object(
      'sessionId', session.id,
      'name', session.name,
      'startsAt', to_char(session.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'endsAt', to_char(session.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'roomName', session.room_name,
      'capacity', session.capacity,
      'bookingPolicy', session.booking_policy,
      'status', session.status::text,
      'createdAt', to_char(session.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) AS item
    FROM hon.class_sessions AS session
    WHERE session.organization_id = hon.current_organization_id()
      AND session.school_id = hon.current_school_id()
      AND session.starts_at >= window_start AND session.starts_at < window_end
    ORDER BY session.starts_at, session.id
    LIMIT 50
  ) AS item;
  -- A recheck prevents returning a captured projection after a live access loss.
  PERFORM hon.require_current_school_class_sessions_read_actor(p_subject);
  RETURN result;
END $$;

-- Retain the source table's existing tenant policy and force it again as a
-- migration-level invariant. Runtime has no direct session SELECT capability:
-- this named SECURITY DEFINER projection is the only read boundary.
ALTER TABLE hon.class_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.class_sessions FORCE ROW LEVEL SECURITY;
REVOKE SELECT ON TABLE hon.class_sessions FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE SELECT ON TABLE hon.class_sessions FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.require_current_school_class_sessions_read_actor(text) FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_current_school_class_sessions(text) FROM %I', role_name);
  END LOOP;
  REVOKE ALL ON FUNCTION hon.require_current_school_class_sessions_read_actor(text), hon.read_current_school_class_sessions(text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_current_school_class_sessions(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
