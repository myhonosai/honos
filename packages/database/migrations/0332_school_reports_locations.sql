BEGIN;

-- R2 (0332, assigned by the coordinator 2026-11-13): the multi-location view of the 0331 school reports. Owner (David):
-- "Can we make progress to finish the product?"; the coordinator's brief: a multi-location view across a school owner's
-- locations.
-- One read-only entry point, hon.read_school_reports_locations(subject, input). The caller must pass the 0331 check at the
-- session school (direct human, live reporting.view there, active school, organization and entitlement). The answer lists
-- every active school of the same organization where that same person also holds live school-scoped reporting.view and
-- is an eligible staff member there, at most 20, each with the 0331 month by month totals for the same months (the page
-- adds them up for the organization). A location without that permission is simply not listed: nothing about it is returned.
-- Schools of other organizations are never listed. Counts and money totals only, as in 0331. Nothing is written or sent.
-- As in 0331, a membership counts as ended when its cancellation was recorded (the billing.membership.cancel audit row);
-- a later effective date on that cancellation is not used.

-- Live reporting.view for this principal at this school of the session organization (private).
CREATE FUNCTION hon.school_reports_location_allowed(actor uuid, org uuid, school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.schools s JOIN pg_timezone_names tz ON tz.name=s.timezone
      WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND hon.staff_member_eligible(actor,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code='reporting.view')
$$;

-- Input: {} or { months: 3..12 }.
CREATE FUNCTION hon.read_school_reports_locations(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); actor uuid; months integer:=6; as_of timestamptz:=statement_timestamp();
  locations jsonb; n integer;
BEGIN
  actor:=hon.require_school_reports_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k<>'months')
    OR (p_input ? 'months' AND (jsonb_typeof(p_input->'months')<>'number' OR (p_input->>'months') !~ '^(3|4|5|6|7|8|9|10|11|12)$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_input ? 'months' THEN months:=(p_input->>'months')::integer; END IF;
  SELECT count(*) INTO n FROM hon.schools s WHERE s.organization_id=org AND hon.school_reports_location_allowed(actor,org,s.id);
  -- More than 20 locations is not shown in part: the owner opens each school's own report instead.
  IF n>20 THEN RAISE EXCEPTION 'SCHOOL_REPORTS_TOO_MANY_LOCATIONS' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('schoolId',s.id,'schoolName',s.name,'timezone',s.timezone,
      'cancelledWithoutDate',(SELECT count(*) FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=s.id AND x.state='CANCELLED'
        AND NOT EXISTS(SELECT 1 FROM hon.audit_events a WHERE a.organization_id=org AND a.school_id=s.id AND a.entity_id=x.id
          AND a.action_code='billing.membership.cancel' AND a.result='SUCCEEDED' AND a.entity_type='MEMBERSHIP')),
      'periods',hon.school_report_periods(org,s.id,s.timezone,months,as_of)) ORDER BY lower(s.name), s.id),'[]'::jsonb)
    INTO locations FROM hon.schools s WHERE s.organization_id=org AND hon.school_reports_location_allowed(actor,org,s.id);
  RETURN jsonb_build_object('organizationId',org,'months',months,
    'generatedAt',to_char(as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'locations',locations);
END $$;

REVOKE ALL ON FUNCTION hon.school_reports_location_allowed(uuid,uuid,uuid), hon.read_school_reports_locations(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_reports_locations(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
