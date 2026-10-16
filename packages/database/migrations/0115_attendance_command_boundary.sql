BEGIN;
-- Close the record-table loophole without changing 0114's immutable snapshots.
-- The trusted owner runs only this fixed command; no caller SQL or evidence input.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Attendance migration requires trusted migration owner';
 END IF;
END $$;

CREATE FUNCTION hon.record_attendance(p_subject text,p_session uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; student uuid;
 v_state text; v_category text; v_note text; expected bigint; booking uuid; reservation uuid;
 previous hon.idempotency_records%ROWTYPE; current_record hon.attendance_records%ROWTYPE;
 prior jsonb; result jsonb; fp text; legacy_fp text; serialized text; operation text; created boolean:=false;
 trim_chars text:=E' \t\n\r\f' || chr(11) || U&'\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff';
BEGIN
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('studentProfileId','status','category','note','expectedVersion'))
  OR jsonb_typeof(p_input->'studentProfileId') IS DISTINCT FROM 'string'
  OR (p_input->>'studentProfileId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string'
  OR (p_input->>'status') NOT IN('PRESENT','LATE','EXCUSED_ABSENCE','UNEXCUSED_ABSENCE','MAKEUP')
  OR p_session IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 student:=(p_input->>'studentProfileId')::uuid; v_state:=p_input->>'status';
 v_category:=CASE WHEN p_input ? 'category' THEN p_input->>'category' WHEN v_state='MAKEUP' THEN 'MAKEUP_CLASS' ELSE 'REGULAR_PARTICIPANT' END;
 IF (p_input ? 'category' AND jsonb_typeof(p_input->'category') IS DISTINCT FROM 'string') OR v_category IS NULL
  OR v_category NOT IN('REGULAR_PARTICIPANT','OBSERVER','TRIAL_STUDENT','GUEST_DROP_IN','PRIVATE_LESSON','SPECIAL_EVENT','MAKEUP_CLASS') THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_input ? 'note' AND jsonb_typeof(p_input->'note') NOT IN('string','null') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 v_note:=p_input->>'note';
 -- Match normalized TypeScript trim/UTF-16 length; receipts alone may contain notes.
 IF v_note IS NOT NULL AND (v_note='' OR btrim(v_note,trim_chars)<>v_note OR v_note ~ '[[:cntrl:]]' OR v_note ~ U&'[\0080-\009f]'
  OR length(v_note)+(SELECT count(*) FROM regexp_split_to_table(v_note,'') ch WHERE ascii(ch)>65535)>2000) THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_input ? 'expectedVersion' THEN
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[0-9]{1,16}$'
   OR (p_input->>'expectedVersion')::numeric NOT BETWEEN 1 AND 9007199254740991 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p_input->>'expectedVersion')::bigint;
 END IF;
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key,trim_chars)<>p_key OR p_key ~ '[[:cntrl:]]' OR p_key ~ U&'[\0080-\009f]'
  OR length(p_key)+(SELECT count(*) FROM regexp_split_to_table(p_key,'') ch WHERE ascii(ch)>65535)>200
  OR p_request IS NULL OR p_correlation IS NULL
  OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
  OR p_correlation::text IS DISTINCT FROM current_setting('app.hon_correlation_id',true) THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'ATTENDANCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.lock_attendance_actor(p_subject,'attendance.record');
 -- Definer scope must be explicit even though the caller's exact read uses RLS.
 PERFORM 1 FROM hon.class_sessions WHERE id=p_session AND organization_id=org AND school_id=school FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM hon.student_profiles WHERE id=student AND organization_id=org AND school_id=school FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;

 -- Preserve the pre-command-boundary JSON.stringify fingerprint byte order.
 serialized:='{"sessionId":' || to_json(p_session::text)::text || ',"category":' || to_json(v_category)::text
  || ',"studentProfileId":' || to_json(student::text)::text || ',"status":' || to_json(v_state)::text || ',"note":' || coalesce(to_json(v_note)::text,'null')
  || CASE WHEN expected IS NULL THEN '' ELSE ',"expectedVersion":' || expected::text END || '}';
 fp:=encode(sha256(convert_to(serialized,'UTF8')),'hex');
 legacy_fp:=encode(sha256(convert_to('{"sessionId":' || to_json(p_session::text)::text
  || ',"studentProfileId":' || to_json(student::text)::text || ',"status":' || to_json(v_state)::text || ',"note":' || coalesce(to_json(v_note)::text,'null')
  || CASE WHEN expected IS NULL THEN '' ELSE ',"expectedVersion":' || expected::text END || '}','UTF8')),'hex');
 INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
 VALUES(org,school,actor,p_key,fp,'IN_PROGRESS',now()+interval '24 hours')
 ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id INTO reservation;
 IF reservation IS NULL THEN
  SELECT * INTO previous FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  actor:=hon.lock_attendance_actor(p_subject,'attendance.record');
  IF previous.request_fingerprint<>fp AND NOT (previous.request_fingerprint=legacy_fp
   AND v_category=CASE WHEN v_state='MAKEUP' THEN 'MAKEUP_CLASS' ELSE 'REGULAR_PARTICIPANT' END
   AND NOT coalesce(previous.response_body ? 'category',false)) THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='40001'; END IF;
  IF previous.status='COMPLETED' AND previous.response_body IS NOT NULL THEN
   result:=previous.response_body;
   -- Historical receipts are never replaced by the current row or today's policy.
   IF NOT (result ? 'category') THEN result:=result || jsonb_build_object('category',CASE WHEN result->>'status'='MAKEUP' THEN 'MAKEUP_CLASS' ELSE 'REGULAR_PARTICIPANT' END,
    'progressionPolicyVersion',0,'progressionEnabled',true,'progressionWeightMilli',1000,'progressionCreditMilli',CASE WHEN result->>'status' IN('PRESENT','LATE','MAKEUP') THEN 1000 ELSE 0 END); END IF;
   RETURN jsonb_build_object('attendance',result,'replayed',true,'created',false);
  END IF;
  RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001';
 END IF;

 PERFORM pg_advisory_xact_lock(hashtextextended(p_session::text || ':' || student::text,0));
 actor:=hon.lock_attendance_actor(p_subject,'attendance.record');
 SELECT * INTO current_record FROM hon.attendance_records WHERE organization_id=org AND school_id=school AND class_session_id=p_session AND student_profile_id=student FOR UPDATE;
 actor:=hon.lock_attendance_actor(p_subject,'attendance.record');
 IF current_record.id IS NOT NULL THEN
  prior:=jsonb_strip_nulls(jsonb_build_object('id',current_record.id,'classSessionId',current_record.class_session_id,'studentProfileId',current_record.student_profile_id,
   'classBookingId',current_record.class_booking_id,'status',current_record.status,'category',current_record.category,
   'progressionPolicyVersion',current_record.progression_policy_version,'progressionEnabled',current_record.progression_enabled,
   'progressionWeightMilli',current_record.progression_weight_milli,'progressionCreditMilli',current_record.progression_credit_milli,
   'recordedByPrincipalId',current_record.recorded_by_principal_id,'recordedAt',to_char(current_record.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'note',current_record.note,'version',current_record.version,'createdAt',to_char(current_record.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'updatedAt',to_char(current_record.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  IF expected IS NOT NULL AND expected<>current_record.version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF current_record.status::text=v_state AND current_record.category=v_category AND current_record.note IS NOT DISTINCT FROM v_note THEN
   UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=prior WHERE id=reservation;
   RETURN jsonb_build_object('attendance',prior,'replayed',true,'created',false);
  END IF;
  IF expected IS NULL THEN RAISE EXCEPTION 'VERSION_REQUIRED' USING ERRCODE='40001'; END IF;
  UPDATE hon.attendance_records SET status=v_state::hon.attendance_status,category=v_category,note=v_note,
   recorded_by_principal_id=actor,recorded_at=now(),version=version+1,updated_at=now()
  WHERE id=current_record.id AND organization_id=org AND school_id=school AND version=expected RETURNING * INTO current_record;
  IF NOT FOUND THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  operation:='UPDATED';
 ELSE
  SELECT id INTO booking FROM hon.class_bookings WHERE organization_id=org AND school_id=school AND class_session_id=p_session AND student_profile_id=student FOR SHARE;
  INSERT INTO hon.attendance_records(organization_id,school_id,class_session_id,student_profile_id,class_booking_id,status,category,recorded_by_principal_id,note)
  VALUES(org,school,p_session,student,booking,v_state::hon.attendance_status,v_category,actor,v_note) RETURNING * INTO current_record;
  operation:='CREATED'; created:=true;
 END IF;
 -- 0114's trigger resolves and locks live eligibility/policy and snapshots credit.
 result:=jsonb_strip_nulls(jsonb_build_object('id',current_record.id,'classSessionId',current_record.class_session_id,'studentProfileId',current_record.student_profile_id,
  'classBookingId',current_record.class_booking_id,'status',current_record.status,'category',current_record.category,
  'progressionPolicyVersion',current_record.progression_policy_version,'progressionEnabled',current_record.progression_enabled,
  'progressionWeightMilli',current_record.progression_weight_milli,'progressionCreditMilli',current_record.progression_credit_milli,
  'recordedByPrincipalId',current_record.recorded_by_principal_id,'recordedAt',to_char(current_record.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'note',current_record.note,'version',current_record.version,'createdAt',to_char(current_record.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(current_record.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI','attendance.record','ATTENDANCE_RECORD',current_record.id,prior-'note',result-'note','SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(gen_random_uuid(),org,school,'attendance.recorded',2,'ATTENDANCE_RECORD',current_record.id,current_record.version,p_correlation,p_request,
  (result-'id'-'note'-'createdAt'-'updatedAt') || jsonb_build_object('attendanceRecordId',current_record.id,'classBookingId',current_record.class_booking_id,
   'recordedByPrincipalId',current_record.recorded_by_principal_id,'operation',operation,'externalEffects','NONE'));
 UPDATE hon.idempotency_records SET status='COMPLETED',response_status=CASE WHEN created THEN 201 ELSE 200 END,response_body=result WHERE id=reservation;
 RETURN jsonb_build_object('attendance',result,'replayed',false,'created',created);
END $$;

REVOKE ALL ON FUNCTION hon.record_attendance(text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON hon.attendance_records FROM PUBLIC;
DO $$ DECLARE r text; a text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.record_attendance(text,uuid,jsonb,text,uuid,uuid) FROM %I',r);
  EXECUTE format('REVOKE ALL ON hon.attendance_records FROM %I',r);
 END LOOP;
 FOR a IN SELECT attname FROM pg_attribute WHERE attrelid='hon.attendance_records'::regclass AND attnum>0 AND NOT attisdropped LOOP
  EXECUTE format('REVOKE ALL (%I) ON hon.attendance_records FROM PUBLIC',a);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
   EXECUTE format('REVOKE ALL (%I) ON hon.attendance_records FROM %I',a,r);
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT SELECT ON hon.attendance_records TO hon_runtime;
  GRANT EXECUTE ON FUNCTION hon.record_attendance(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
