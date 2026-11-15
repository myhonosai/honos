BEGIN;

-- Parent class booking (0329, assigned by the coordinator 2026-11-13; docs/architecture/PARENT_ACCOUNT_BOOKING_AND_MESSAGES.md).
-- The owner asked to finish the product; parents book class slots from their own account.
--   A1  A signed-in parent with exactly one live family grant sees, per child of that family, the bookable class sessions of
--       the next 14 days: SCHEDULED, booking policy OPTIONAL_BOOKING or REQUIRED_BOOKING (never WALK_IN), a program the child
--       has an ACTIVE curriculum enrollment in, starting after now. Each shows its open spots, never other students.
--   A2  A PRIMARY_GUARDIAN or SECONDARY_GUARDIAN books one ACTIVE child into one such session. The session row is locked
--       FOR UPDATE exactly like the staff path (0118), so capacity (BOOKED + CHECKED_IN) is never passed and the same child is
--       never booked twice. The booking is REGULAR with source PARENT_APP. A cancelled REGULAR booking is booked again in place.
--   A3  The guardian cancels a PARENT_APP booking of their own child until the session starts. Staff bookings stay with staff.
-- VIEWER grants read only. School, organization and entitlement must be live, and the family grant is checked again after
-- the locks. Every write has exact-request idempotency, an audit event and an inert outbox event (ids and version only).
-- The runtime gains no table privilege: three SECURITY DEFINER entry points take only the signed-in subject and a closed body.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Parent class booking requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Parent class booking requires a restricted runtime';
  END IF;
  IF to_regclass('hon.class_bookings') IS NULL OR to_regprocedure('hon.lock_class_booking_session(text,uuid)') IS NULL
    OR to_regprocedure('hon.resolve_parent_journey_scopes(text)') IS NULL THEN
    RAISE EXCEPTION 'Parent class booking requires 0032, 0087 and 0118';
  END IF;
END $$;

-- The one live family grant of the signed-in parent, read with clock_timestamp so a grant, school, organization or
-- entitlement that ends mid-command is seen. It must match the tenant, principal and source the API set.
CREATE FUNCTION hon.parent_class_booking_scope(subject text, guardian boolean)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; r record;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  SELECT count(*) INTO n FROM (
    SELECT DISTINCT g.school_id,g.family_id FROM hon.users u
    JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    JOIN hon.family_access_grants g ON g.principal_id=p.id
    WHERE u.external_subject=subject AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) x;
  IF n<>1 THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id pid,g.organization_id org,g.school_id school,g.family_id fam,g.access_level::text lvl INTO r
  FROM hon.users u
  JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
  JOIN hon.family_access_grants g ON g.principal_id=p.id
  WHERE u.external_subject=subject AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
  ORDER BY CASE g.access_level WHEN 'PRIMARY_GUARDIAN' THEN 3 WHEN 'SECONDARY_GUARDIAN' THEN 2 ELSE 1 END DESC, g.effective_from DESC
  LIMIT 1;
  IF r.pid IS NULL
    OR r.pid::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
    OR r.org IS DISTINCT FROM hon.current_organization_id() OR r.school IS DISTINCT FROM hon.current_school_id()
    OR NOT EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=r.org AND o.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=r.school AND s.organization_id=r.org AND s.status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=r.org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    OR (guardian AND r.lvl NOT IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN')) THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT r.pid,r.org,r.school,r.fam,r.lvl;
END $$;

-- The ACTIVE children of the exact family (STUDENT member whose primary family is this family).
CREATE FUNCTION hon.parent_class_booking_child_ok(fam uuid, child uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.student_profiles sp JOIN hon.family_members m ON m.person_id=sp.person_id
    AND m.organization_id=sp.organization_id AND m.school_id=sp.school_id AND m.family_id=fam AND m.member_role='STUDENT'
    WHERE sp.id=child AND sp.primary_family_id=fam AND sp.status='ACTIVE'
      AND sp.organization_id=hon.current_organization_id() AND sp.school_id=hon.current_school_id());
$$;

-- A session the child may be booked into by a parent right now (A1).
CREATE FUNCTION hon.parent_class_booking_session_ok(child uuid, s hon.class_sessions) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT s.id IS NOT NULL AND s.status='SCHEDULED' AND s.booking_policy IN ('OPTIONAL_BOOKING','REQUIRED_BOOKING')
    AND s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id()
    AND s.starts_at>clock_timestamp() AND s.starts_at<clock_timestamp()+interval '14 days'
    AND EXISTS(SELECT 1 FROM hon.student_curriculum_enrollments e WHERE e.student_profile_id=child AND e.status='ACTIVE'
      AND e.program_id=s.program_id AND e.organization_id=s.organization_id AND e.school_id=s.school_id);
$$;

CREATE FUNCTION hon.parent_class_booking_seats(session uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT count(*)::integer FROM hon.class_bookings WHERE class_session_id=session AND status IN ('BOOKED','CHECKED_IN');
$$;

CREATE FUNCTION hon.parent_class_booking_json(b hon.class_bookings, s hon.class_sessions) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('bookingId',b.id,'sessionId',b.class_session_id,'studentProfileId',b.student_profile_id,
    'status',b.status::text,'source',b.source,'version',b.version,
    'canCancel',b.source='PARENT_APP' AND b.booking_kind='REGULAR' AND b.status IN ('BOOKED','WAITLISTED') AND s.starts_at>clock_timestamp());
$$;

-- Idempotency for one parent command: NULL when reserved now, else the earlier exact result.
CREATE FUNCTION hon.parent_class_booking_begin(subject text, key text, fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  IF key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO sc FROM hon.parent_class_booking_scope(subject,true);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(sc.organization_id,sc.school_id,sc.principal_id,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=sc.organization_id AND school_id=sc.school_id
    AND principal_id=sc.principal_id AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  PERFORM hon.parent_class_booking_scope(subject,true);
  RETURN prior.response_body;
END $$;

CREATE FUNCTION hon.parent_class_booking_finish(subject text, key text, actor uuid, result jsonb, action text, booking uuid,
  prior_state jsonb, next_state jsonb, event_type text, booking_version integer, request uuid, correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); live uuid;
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,'CLASS_BOOKING',booking,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event_type,1,'CLASS_BOOKING',booking,booking_version,correlation,request,next_state);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  -- Authority is checked again after every lock and write of the command.
  SELECT principal_id INTO live FROM hon.parent_class_booking_scope(subject,true);
  IF live IS DISTINCT FROM actor THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

-- A1: choices for every child of the family. Read only; VIEWER sees canBook false.
CREATE FUNCTION hon.read_parent_class_booking_choices(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; tz text; children jsonb;
BEGIN
  SELECT * INTO sc FROM hon.parent_class_booking_scope(subject,false);
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=sc.school_id;
  SELECT coalesce(jsonb_agg(c.j ORDER BY c.name, c.id),'[]') INTO children FROM (
    SELECT sp.id, concat_ws(' ',pe.given_name,pe.family_name) name,
      jsonb_build_object('studentProfileId',sp.id,'displayName',concat_ws(' ',pe.given_name,pe.family_name),'sessions',
        (SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',s.id,'name',s.name,'programName',pr.name,'roomName',s.room_name,
            'startsAt',to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'endsAt',to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'spotsLeft',greatest(s.capacity-hon.parent_class_booking_seats(s.id),0),
            'booking',(SELECT hon.parent_class_booking_json(b,s) FROM hon.class_bookings b
              WHERE b.class_session_id=s.id AND b.student_profile_id=sp.id AND b.status<>'CANCELLED'))
            ORDER BY s.starts_at, s.id),'[]')
         FROM (SELECT * FROM hon.class_sessions s0 WHERE s0.organization_id=sc.organization_id AND s0.school_id=sc.school_id
               AND hon.parent_class_booking_session_ok(sp.id,s0) ORDER BY s0.starts_at, s0.id LIMIT 200) s
         JOIN hon.programs pr ON pr.id=s.program_id AND pr.organization_id=s.organization_id AND pr.school_id=s.school_id)) j
    FROM hon.student_profiles sp
    JOIN hon.family_members m ON m.person_id=sp.person_id AND m.organization_id=sp.organization_id AND m.school_id=sp.school_id
      AND m.family_id=sc.family_id AND m.member_role='STUDENT'
    JOIN hon.people pe ON pe.id=sp.person_id AND pe.organization_id=sp.organization_id AND pe.school_id=sp.school_id
    WHERE sp.primary_family_id=sc.family_id AND sp.status='ACTIVE' AND sp.organization_id=sc.organization_id AND sp.school_id=sc.school_id
    ORDER BY 2, 1 LIMIT 20) c;
  RETURN jsonb_build_object('canBook',sc.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN'),'timezone',tz,
    'horizonDays',14,'children',children);
END $$;

-- A2: book one child into one session.
CREATE FUNCTION hon.book_parent_class_session(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; child uuid; session uuid; prior jsonb; s hon.class_sessions; b hon.class_bookings; result jsonb; before jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)<>ARRAY['sessionId','studentProfileId']
    OR jsonb_typeof(p->'sessionId') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'studentProfileId') IS DISTINCT FROM 'string'
    OR p->>'sessionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p->>'studentProfileId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR request IS NULL OR correlation IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  child:=(p->>'studentProfileId')::uuid; session:=(p->>'sessionId')::uuid;
  prior:=hon.parent_class_booking_begin(subject,key,encode(sha256(convert_to('book:'||child||':'||session,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('receipt',prior,'replayed',true); END IF;
  SELECT * INTO sc FROM hon.parent_class_booking_scope(subject,true);
  IF NOT hon.parent_class_booking_child_ok(sc.family_id,child) THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_CHILD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- Same lock as the staff path (0118): the session row, then its bookings.
  SELECT * INTO s FROM hon.class_sessions WHERE id=session AND organization_id=sc.organization_id AND school_id=sc.school_id FOR UPDATE;
  IF NOT FOUND OR NOT hon.parent_class_booking_session_ok(child,s) THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_NOT_OFFERED' USING ERRCODE='P0002'; END IF;
  SELECT * INTO b FROM hon.class_bookings WHERE class_session_id=s.id AND student_profile_id=child FOR UPDATE;
  IF FOUND AND b.status<>'CANCELLED' THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_ALREADY_BOOKED' USING ERRCODE='23505'; END IF;
  IF FOUND AND b.booking_kind<>'REGULAR' THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_NOT_OFFERED' USING ERRCODE='P0002'; END IF;
  IF hon.parent_class_booking_seats(s.id)>=s.capacity THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_FULL' USING ERRCODE='23505'; END IF;
  IF FOUND THEN
    before:=jsonb_build_object('status',b.status::text,'version',b.version,'source',b.source);
    UPDATE hon.class_bookings SET status='BOOKED',source='PARENT_APP',booked_at=clock_timestamp(),cancelled_at=NULL,
      version=version+1,updated_at=clock_timestamp() WHERE id=b.id RETURNING * INTO b;
  ELSE
    before:=NULL;
    INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source)
      VALUES(sc.organization_id,sc.school_id,s.id,child,'REGULAR','BOOKED','PARENT_APP') RETURNING * INTO b;
  END IF;
  result:=jsonb_build_object('booking',hon.parent_class_booking_json(b,s),'spotsLeft',greatest(s.capacity-hon.parent_class_booking_seats(s.id),0));
  PERFORM hon.parent_class_booking_finish(subject,key,sc.principal_id,result,'class_booking.parent_book',b.id,before,
    jsonb_build_object('bookingId',b.id,'sessionId',s.id,'studentProfileId',child,'familyId',sc.family_id,'status','BOOKED','version',b.version),
    'class_booking.parent_booked',b.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- A3: cancel the family's own app booking before the session starts.
CREATE FUNCTION hon.cancel_parent_class_booking(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; booking uuid; expected integer; prior jsonb; s hon.class_sessions; b hon.class_bookings; session uuid; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)<>ARRAY['bookingId','expectedVersion']
    OR jsonb_typeof(p->'bookingId') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number'
    OR p->>'bookingId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR p->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' OR request IS NULL OR correlation IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  booking:=(p->>'bookingId')::uuid; expected:=(p->>'expectedVersion')::integer;
  prior:=hon.parent_class_booking_begin(subject,key,encode(sha256(convert_to('cancel:'||booking||':'||expected,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN RETURN jsonb_build_object('receipt',prior,'replayed',true); END IF;
  SELECT * INTO sc FROM hon.parent_class_booking_scope(subject,true);
  SELECT x.class_session_id INTO session FROM hon.class_bookings x WHERE x.id=booking AND x.organization_id=sc.organization_id AND x.school_id=sc.school_id;
  IF session IS NULL THEN RAISE EXCEPTION 'PARENT_CLASS_BOOKING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM hon.class_sessions WHERE id=session FOR UPDATE;
  SELECT * INTO b FROM hon.class_bookings WHERE id=booking FOR UPDATE;
  IF NOT hon.parent_class_booking_child_ok(sc.family_id,b.student_profile_id) THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF b.source<>'PARENT_APP' OR b.booking_kind<>'REGULAR' OR b.status NOT IN ('BOOKED','WAITLISTED') OR s.starts_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'PARENT_CLASS_BOOKING_NOT_CANCELLABLE' USING ERRCODE='P0002'; END IF;
  UPDATE hon.class_bookings SET status='CANCELLED',cancelled_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    WHERE id=b.id RETURNING * INTO b;
  result:=jsonb_build_object('booking',hon.parent_class_booking_json(b,s),'spotsLeft',greatest(s.capacity-hon.parent_class_booking_seats(s.id),0));
  PERFORM hon.parent_class_booking_finish(subject,key,sc.principal_id,result,'class_booking.parent_cancel',b.id,
    jsonb_build_object('status','BOOKED','version',expected),
    jsonb_build_object('bookingId',b.id,'sessionId',s.id,'studentProfileId',b.student_profile_id,'familyId',sc.family_id,'status','CANCELLED','version',b.version),
    'class_booking.parent_cancelled',b.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text; fns text[]:=ARRAY['hon.parent_class_booking_scope(text,boolean)','hon.parent_class_booking_child_ok(uuid,uuid)',
  'hon.parent_class_booking_session_ok(uuid,hon.class_sessions)','hon.parent_class_booking_seats(uuid)',
  'hon.parent_class_booking_json(hon.class_bookings,hon.class_sessions)','hon.parent_class_booking_begin(text,text,text)',
  'hon.parent_class_booking_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,integer,uuid,uuid)',
  'hon.read_parent_class_booking_choices(text)','hon.book_parent_class_session(text,jsonb,text,uuid,uuid)',
  'hon.cancel_parent_class_booking(text,jsonb,text,uuid,uuid)']; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_parent_class_booking_choices(text),hon.book_parent_class_session(text,jsonb,text,uuid,uuid),
      hon.cancel_parent_class_booking(text,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') AND EXISTS(SELECT 1 FROM unnest(fns) f2 WHERE f2 NOT IN ('hon.read_parent_class_booking_choices(text)','hon.book_parent_class_session(text,jsonb,text,uuid,uuid)',
      'hon.cancel_parent_class_booking(text,jsonb,text,uuid,uuid)') AND has_function_privilege('hon_runtime',f2,'EXECUTE')) THEN
    RAISE EXCEPTION 'Parent class booking helpers must stay private';
  END IF;
END $$;

COMMIT;
