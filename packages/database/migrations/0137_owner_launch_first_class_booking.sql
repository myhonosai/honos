BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Owner launch booking requires trusted migration owner'; END IF;
END $$;

-- This command accepts only an immutable registration receipt identifier and its
-- optimistic versions. It never accepts a student, family, program, class or
-- school selector. The actual booking remains the canonical class_bookings row,
-- capacity count, lock, audit, outbox and idempotency model.
CREATE FUNCTION hon.book_owner_launch_first_class(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
 registration uuid; class_version integer; class_program uuid; class_status text; expected_class_version integer; expected_receipt_version integer;
 receipt record; locked record; prior record; existing hon.class_bookings%ROWTYPE; booking hon.class_bookings%ROWTYPE;
 seats integer; decision hon.class_booking_status; fp bytea; key_digest bytea; result jsonb; payload jsonb;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
 OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('registrationId','expectedReceiptVersion','expectedClassSessionVersion'))
 OR jsonb_typeof(p_input->'registrationId') IS DISTINCT FROM 'string'
 OR (p_input->>'registrationId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(p_input->'expectedReceiptVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedReceiptVersion' !~ '^[1-9][0-9]{0,8}$'
 OR jsonb_typeof(p_input->'expectedClassSessionVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedClassSessionVersion' !~ '^[1-9][0-9]{0,8}$' THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
 END IF;
 registration:=(p_input->>'registrationId')::uuid;
 expected_receipt_version:=(p_input->>'expectedReceiptVersion')::integer;
 expected_class_version:=(p_input->>'expectedClassSessionVersion')::integer;
 -- Existing registration receipts are immutable; version 1 is the only valid
 -- receipt version. Keep this explicit expected version so an eventual receipt
 -- evolution cannot be silently accepted by this command.
 IF expected_receipt_version<>1 THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_STALE' USING ERRCODE='40001'; END IF;

 -- The receipt is the sole selector and must be owned by this current live actor.
 -- Both receipt variants are checked independently, then linked back to current
 -- same-school profile, program-only enrollment and exact class/program context.
 SELECT r.id AS registration_id,r.student_profile_id,r.program_id,r.class_session_id
 INTO receipt
 FROM hon.student_registration_receipts r
 JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
 JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
 WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
  AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
 FOR SHARE OF r,sp,e;
 IF NOT FOUND THEN
 SELECT r.id AS registration_id,r.student_profile_id,r.program_id,r.class_session_id
 INTO receipt
 FROM hon.guardian_child_registration_receipts r
 JOIN hon.student_profiles sp ON sp.id=r.student_profile_id AND sp.organization_id=r.organization_id AND sp.school_id=r.school_id
 JOIN hon.student_curriculum_enrollments e ON e.id=r.enrollment_id AND e.student_profile_id=r.student_profile_id AND e.program_id=r.program_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.id=registration AND r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor
   AND r.receipt->>'status'='REGISTERED_NO_BOOKING'
  FOR SHARE OF r,sp,e;
 END IF;
 IF receipt.registration_id IS NULL THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;

 -- Reuse the canonical human booking lock. It independently rechecks exact
 -- schedule.booking.manage/tier/direct-human authority and serializes every
 -- capacity decision on this same class session; UI or receipt IDs are never
 -- substitutes for that authority.
 SELECT * INTO locked FROM hon.lock_class_booking_session(p_subject,receipt.class_session_id);
 IF locked.id IS NULL THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 SELECT s.version,s.program_id,s.status INTO class_version,class_program,class_status
 FROM hon.class_sessions s WHERE s.id=receipt.class_session_id AND s.organization_id=org AND s.school_id=school;
 IF class_version IS NULL OR class_program<>receipt.program_id THEN RAISE EXCEPTION 'OWNER_LAUNCH_RECEIPT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF class_version<>expected_class_version THEN RAISE EXCEPTION 'OWNER_LAUNCH_CLASS_STALE' USING ERRCODE='40001'; END IF;
 IF class_status='CANCELLED' THEN RAISE EXCEPTION 'OWNER_LAUNCH_BOOKING_UNAVAILABLE' USING ERRCODE='22023'; END IF;

 fp:=sha256(convert_to(p_input::text,'UTF8')); key_digest:=sha256(convert_to(p_key,'UTF8'));
 INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
 VALUES(org,school,actor,p_key,encode(fp,'hex'),'IN_PROGRESS',now()+interval '24 hours')
 ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING;
 SELECT request_fingerprint,status,response_body INTO prior FROM hon.idempotency_records
 WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
 IF prior.request_fingerprint IS DISTINCT FROM encode(fp,'hex') THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
 IF prior.status='COMPLETED' AND prior.response_body IS NOT NULL THEN
  PERFORM hon.require_owner_launch_actor(p_subject);
  RETURN prior.response_body || jsonb_build_object('replayed',true);
 END IF;
 IF prior.status<>'IN_PROGRESS' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='23505'; END IF;

 SELECT * INTO existing FROM hon.class_bookings
 WHERE organization_id=org AND school_id=school AND class_session_id=receipt.class_session_id AND student_profile_id=receipt.student_profile_id FOR SHARE;
 IF existing.id IS NOT NULL THEN
  IF existing.booking_kind<>'REGULAR' OR existing.status NOT IN('BOOKED','WAITLISTED') THEN RAISE EXCEPTION 'OWNER_LAUNCH_BOOKING_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  booking:=existing;
 ELSE
  SELECT count(*)::integer INTO seats FROM hon.class_bookings
  WHERE organization_id=org AND school_id=school AND class_session_id=receipt.class_session_id AND status IN('BOOKED','CHECKED_IN');
  decision:=CASE WHEN locked.booking_policy='WALK_IN' OR seats<locked.capacity THEN 'BOOKED'::hon.class_booking_status ELSE 'WAITLISTED'::hon.class_booking_status END;
  INSERT INTO hon.class_bookings(organization_id,school_id,class_session_id,student_profile_id,booking_kind,status,source)
  VALUES(org,school,receipt.class_session_id,receipt.student_profile_id,'REGULAR',decision,'STAFF') RETURNING * INTO booking;
 END IF;

 result:=jsonb_build_object('registrationId',receipt.registration_id,'bookingId',booking.id,'classSessionId',booking.class_session_id,
  'status',booking.status::text,'bookingVersion',booking.version,
  'recordedAt',to_char(booking.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 payload:=jsonb_build_object('classBookingId',booking.id,'classSessionId',booking.class_session_id,'studentProfileId',booking.student_profile_id,
  'bookingKind',booking.booking_kind,'status',booking.status::text,'source',booking.source,'sessionCapacity',locked.capacity,
  'bookingPolicy',locked.booking_policy,'activeSeatCount',seats+CASE WHEN booking.status='BOOKED' AND existing.id IS NULL THEN 1 ELSE 0 END,
  'bookedAt',booking.booked_at,'version',booking.version,'operation','CREATED');
 IF existing.id IS NULL THEN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
  VALUES(org,school,actor,'HUMAN_UI','schedule.booking.create','CLASS_BOOKING',booking.id,NULL,payload,'SUCCEEDED',p_request,p_correlation,NULL,now());
  INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
  VALUES(gen_random_uuid(),org,school,'class.booking.created',1,'CLASS_BOOKING',booking.id,booking.version,p_correlation,p_request,payload);
 END IF;
 UPDATE hon.idempotency_records SET status='COMPLETED',response_status=CASE WHEN existing.id IS NULL THEN 201 ELSE 200 END,response_body=result
 WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 PERFORM hon.require_owner_launch_actor(p_subject);
 RETURN result || jsonb_build_object('replayed',existing.id IS NOT NULL);
END $$;

DO $$ DECLARE r text; BEGIN
 REVOKE ALL ON FUNCTION hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid) FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.book_owner_launch_first_class(text,jsonb,text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
