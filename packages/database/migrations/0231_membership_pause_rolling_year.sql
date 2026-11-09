BEGIN;

-- Rolling-year pause cap (0231, owner decision 2026-11-09 03:24Z: "Rolling"). The paused-days-per-year limit set by
-- each school (0224 P2) counts only the paused days that fall within the last 365 days, the school's local today
-- included. 0224 counted every past pause that STARTED in that window, in full, and ignored a pause that started
-- before the window but ended inside it; that pause now counts the days it overlaps the window. The window is taken
-- at the school's local today: as the new pause runs, older days only leave the window, so the check is never looser
-- than a day-by-day rolling count. Nothing else changes: same signature, lock order, authority checks, idempotency,
-- audit and outbox.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid)') IS NULL THEN RAISE EXCEPTION '0231 requires 0224'; END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.pause_school_membership(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  m hon.memberships%ROWTYPE; updated hon.memberships%ROWTYPE; policy hon.school_membership_pause_policies%ROWTYPE; pause hon.membership_pauses%ROWTYPE;
  today date; resume_on date; used_days integer; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR NOT p ?& ARRAY['expectedVersion','resumeOn','pauseReason']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedVersion','resumeOn','pauseReason'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.membership_pause_text_ok(p->'pauseReason',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  resume_on:=hon.membership_pause_date(p->'resumeOn');
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','billing.membership.pause','membershipId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.membership_pause_begin(subject,'billing.membership.pause',key,fp);
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.pause');
  IF replay IS NOT NULL THEN
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.pause') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_PAUSE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('pause',replay,'replayed',true);
  END IF;
  LOCK TABLE hon.memberships IN ROW EXCLUSIVE MODE;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  LOCK TABLE hon.school_membership_pause_policies,hon.membership_payment_schedules IN SHARE MODE;
  IF m.state<>'ACTIVE' THEN RAISE EXCEPTION 'MEMBERSHIP_NOT_ACTIVE' USING ERRCODE='40001'; END IF;
  IF m.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  SELECT * INTO policy FROM hon.school_membership_pause_policies x WHERE x.organization_id=org AND x.school_id=school ORDER BY x.version DESC LIMIT 1;
  IF NOT FOUND OR NOT policy.pauses_allowed THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_NOT_OFFERED' USING ERRCODE='40001'; END IF;
  today:=hon.membership_school_today();
  IF resume_on<=today OR resume_on-today>policy.max_pause_days THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_TOO_LONG' USING ERRCODE='22023'; END IF;
  -- Rolling year (0231): only the paused days inside the last 365 days (today-364 .. today) count, plus this pause.
  -- A pause covers starts_on .. ended_on-1; a pause straddling the window edge counts only its days inside it.
  SELECT coalesce(sum(greatest(least(coalesce(x.ended_on,today),today)-greatest(x.starts_on,today-364),0)),0) INTO used_days
    FROM hon.membership_pauses x
    WHERE x.membership_id=m.id AND x.organization_id=org AND x.school_id=school AND coalesce(x.ended_on,today)>today-364;
  IF used_days+(resume_on-today)>policy.max_paused_days_per_year THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_YEARLY_LIMIT' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM hon.membership_payment_schedules s WHERE s.membership_id=m.id AND s.organization_id=org AND s.school_id=school AND s.status='ACTIVE') THEN
    RAISE EXCEPTION 'MEMBERSHIP_PAUSE_REQUIRES_BILLING_ARRANGEMENT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.membership_pauses(organization_id,school_id,membership_id,policy_version,starts_on,planned_resume_on,pause_reason,
      hold_fee_minor,hold_fee_currency,paused_by_principal_id,pause_prior_version,pause_next_version)
    VALUES(org,school,m.id,policy.version,today,resume_on,p->>'pauseReason',policy.hold_fee_minor,policy.hold_fee_currency,actor,m.version,m.version+1)
    RETURNING * INTO pause;
  UPDATE hon.memberships SET state='FROZEN',version=version+1
    WHERE id=m.id AND organization_id=org AND school_id=school AND state='ACTIVE' AND version=m.version RETURNING * INTO updated;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  result:=hon.membership_pause_json(pause)||jsonb_build_object('membershipState','FROZEN','membershipVersion',updated.version);
  PERFORM hon.membership_pause_finish(subject,'billing.membership.pause',key,actor,result,'billing.membership.pause','MEMBERSHIP',m.id,
    jsonb_build_object('state','ACTIVE','version',m.version),result,'billing.membership.paused','MEMBERSHIP',m.id,updated.version,request,correlation);
  RETURN jsonb_build_object('pause',result,'replayed',false);
END $$;

-- CREATE OR REPLACE keeps the existing ACL; restate it deny-first so the result is exact.
REVOKE ALL ON FUNCTION hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
