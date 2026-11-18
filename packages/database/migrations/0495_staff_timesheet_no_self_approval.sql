BEGIN;

-- Staff timesheets: no self-approval (0495, ledger 2026-11-18). Follow-up to the 0478 time clock review (P3): a holder
-- of staff.timesheet.manage could approve their own week. Coordinator request 2026-11-18 for the owner (David): block
-- approving one's own week, with the school's OWNER role exempt (an owner may have nobody above them).
--   S1  APPROVE where the target is the actor is refused with TIMESHEET_SELF_APPROVAL (42501) unless the actor holds a
--       live grant of the system OWNER role at this exact school and organization. REOPEN of one's own week, and adding
--       or fixing one's own entries, are unchanged.
--   S2  Only hon.set_staff_timesheet_week changes (same signature, same ACL); one new private helper.
DO $$ BEGIN
  IF to_regprocedure('hon.set_staff_timesheet_week(text,jsonb,text,uuid,uuid)') IS NULL THEN RAISE EXCEPTION '0495 requires 0478'; END IF;
END $$;

-- Live system OWNER role grant for this principal at this exact school.
CREATE FUNCTION hon.staff_time_actor_is_owner(actor uuid,org uuid,school uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
    WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND r.is_system_role AND r.code='OWNER'
      AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
$$;

CREATE OR REPLACE FUNCTION hon.set_staff_timesheet_week(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; w hon.staff_timesheet_weeks%ROWTYPE;
  before jsonb; result jsonb; target uuid; week date; expected integer; act text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['action','expectedVersion','staffPrincipalId','weekStart']
    OR jsonb_typeof(p->'action') IS DISTINCT FROM 'string' OR p->>'action' NOT IN ('APPROVE','REOPEN')
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR (p->>'action'='REOPEN' AND (p->>'expectedVersion')::integer<1)
    OR jsonb_typeof(p->'staffPrincipalId') IS DISTINCT FROM 'string' OR p->>'staffPrincipalId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT hon.staff_shift_date_ok(p->'weekStart') OR extract(isodow FROM (p->>'weekStart')::date)<>1 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=(p->>'staffPrincipalId')::uuid; week:=(p->>'weekStart')::date; expected:=(p->>'expectedVersion')::integer; act:=p->>'action';
  actor:=hon.require_staff_time_actor(subject,'staff.timesheet.manage');
  prior:=hon.staff_time_begin(subject,'staff.timesheet.manage','staff_timesheet.decide',p,key,actor);
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('approval',prior,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.staff_time:'||target::text,0));
  IF NOT EXISTS(SELECT 1 FROM hon.principals x WHERE x.id=target AND x.principal_type='HUMAN_USER')
    OR NOT (hon.staff_member_eligible(target,org,school) OR EXISTS(SELECT 1 FROM hon.staff_time_entries e WHERE e.organization_id=org AND e.school_id=school
      AND e.principal_id=target AND e.local_date>=week AND e.local_date<week+7)) THEN
    RAISE EXCEPTION 'STAFF_MEMBER_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  -- 0495: nobody approves their own week unless they hold the school's OWNER role (decided after the per-person lock).
  IF act='APPROVE' AND target=actor AND NOT hon.staff_time_actor_is_owner(actor,org,school) THEN
    RAISE EXCEPTION 'TIMESHEET_SELF_APPROVAL' USING ERRCODE='42501'; END IF;
  SELECT * INTO w FROM hon.staff_timesheet_weeks x WHERE x.organization_id=org AND x.school_id=school AND x.principal_id=target AND x.week_start=week FOR UPDATE;
  IF coalesce(w.version,0)<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF (act='APPROVE' AND w.status='APPROVED') OR (act='REOPEN' AND w.status IS DISTINCT FROM 'APPROVED') THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF act='APPROVE' AND EXISTS(SELECT 1 FROM hon.staff_time_entries e WHERE e.organization_id=org AND e.school_id=school AND e.principal_id=target
      AND e.local_date>=week AND e.local_date<week+7 AND e.clock_out_at IS NULL) THEN
    RAISE EXCEPTION 'TIMESHEET_HAS_OPEN_ENTRY' USING ERRCODE='55000'; END IF;
  IF w.version IS NULL THEN
    INSERT INTO hon.staff_timesheet_weeks(organization_id,school_id,principal_id,week_start,status,decided_by_principal_id)
      VALUES(org,school,target,week,'APPROVED',actor) RETURNING * INTO w;
  ELSE
    before:=jsonb_build_object('status',w.status,'version',w.version,'decidedAt',hon.saas_ts(w.decided_at));
    UPDATE hon.staff_timesheet_weeks SET status=CASE act WHEN 'APPROVE' THEN 'APPROVED' ELSE 'OPEN' END,version=w.version+1,
        decided_by_principal_id=actor,decided_at=clock_timestamp()
      WHERE organization_id=org AND school_id=school AND principal_id=target AND week_start=week RETURNING * INTO w;
  END IF;
  result:=jsonb_build_object('status',w.status,'version',w.version,'decidedAt',hon.saas_ts(w.decided_at));
  PERFORM hon.staff_time_record('staff_timesheet.'||lower(act),target,before,result||jsonb_build_object('weekStart',to_char(week,'YYYY-MM-DD')),w.version,actor,request,correlation,
    jsonb_build_object('staffPrincipalId',target,'weekStart',to_char(week,'YYYY-MM-DD'),'version',w.version,'status',w.status));
  PERFORM hon.staff_time_finish(subject,'staff.timesheet.manage',key,actor,result);
  RETURN jsonb_build_object('approval',result,'replayed',false);
END $$;


DO $$ DECLARE r text;
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION hon.staff_time_actor_is_owner(uuid,uuid,uuid) FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.staff_time_actor_is_owner(uuid,uuid,uuid) FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.set_staff_timesheet_week(text,jsonb,text,uuid,uuid) FROM %I',r);
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION hon.set_staff_timesheet_week(text,jsonb,text,uuid,uuid) FROM PUBLIC';
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hon.set_staff_timesheet_week(text,jsonb,text,uuid,uuid) TO hon_runtime';
  END IF;
END $$;
COMMIT;
