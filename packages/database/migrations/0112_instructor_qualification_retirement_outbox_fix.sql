BEGIN;
-- Definition retirement has audit evidence but no related evidence outbox record.
CREATE OR REPLACE FUNCTION hon.mutate_instructor_qualification(p_subject text,p_action text,p_staff uuid,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; prior hon.instructor_qualification_requests%ROWTYPE;
 q hon.instructor_qualifications%ROWTYPE; qr hon.instructor_qualification_revisions%ROWTYPE; e hon.instructor_qualification_evidence%ROWTYPE; er hon.instructor_qualification_evidence_reviews%ROWTYPE;
 entity uuid; version integer; result jsonb; audit_next jsonb; event text; expected integer; status text;
BEGIN
 IF p_action NOT IN('QUALIFICATION_CREATE','QUALIFICATION_RETIRE','EVIDENCE_RECORD','EVIDENCE_REVIEW') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key~'[[:cntrl:]]' OR p_request IS NULL OR p_correlation IS NULL
  OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF (p_action IN('QUALIFICATION_CREATE','QUALIFICATION_RETIRE'))<> (p_staff IS NULL) OR (p_action='QUALIFICATION_CREATE' AND p_id IS NOT NULL)
  OR (p_action='QUALIFICATION_RETIRE' AND p_id IS NULL) OR (p_action='EVIDENCE_RECORD' AND p_id IS NOT NULL) OR (p_action='EVIDENCE_REVIEW' AND p_id IS NULL) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_instructor_qualification_actor(p_subject,'staff.instructor_qualification.manage',true);
 fp:=encode(sha256(convert_to(jsonb_build_object('action',p_action,'staffPrincipalId',p_staff,'id',p_id,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM hon.instructor_qualification_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  PERFORM hon.require_instructor_qualification_actor(p_subject,'staff.instructor_qualification.manage'); RETURN jsonb_build_object('record',prior.response,'replayed',true);
 END IF;
 IF p_action='QUALIFICATION_CREATE' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>4 OR NOT p_input ?& ARRAY['code','title','kind','courseProgramId']
   OR jsonb_typeof(p_input->'code') IS DISTINCT FROM 'string' OR p_input->>'code' !~ '^[A-Z][A-Z0-9_.-]{0,63}$'
   OR jsonb_typeof(p_input->'title') IS DISTINCT FROM 'string' OR NOT hon.instructor_qualification_safe_text(p_input->>'title',120)
   OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string' OR p_input->>'kind' NOT IN('QUALIFICATION','CERTIFICATION')
   OR (p_input->'courseProgramId'<>'null'::jsonb AND (jsonb_typeof(p_input->'courseProgramId') IS DISTINCT FROM 'string' OR p_input->>'courseProgramId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_input->'courseProgramId'<>'null'::jsonb THEN PERFORM 1 FROM hon.programs WHERE id=(p_input->>'courseProgramId')::uuid AND organization_id=org AND school_id=school FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'COURSE_PROGRAM_UNAVAILABLE' USING ERRCODE='P0002'; END IF; END IF;
  INSERT INTO hon.instructor_qualifications(organization_id,school_id,code,title,kind,course_program_id,created_by_principal_id) VALUES(org,school,p_input->>'code',p_input->>'title',p_input->>'kind',(p_input->>'courseProgramId')::uuid,actor) RETURNING * INTO q;
  INSERT INTO hon.instructor_qualification_revisions(qualification_id,organization_id,school_id,version,status,recorded_by_principal_id,request_id) VALUES(q.id,org,school,1,'ACTIVE',actor,p_request);
  entity:=q.id; version:=1; result:=hon.instructor_qualification_definition_projection(entity); event:='staff.instructor_qualification.recorded'; audit_next:=jsonb_build_object('id',entity,'version',1,'kind',q.kind,'courseProgramId',q.course_program_id,'status','ACTIVE','definitionOnly',true);
 ELSIF p_action='QUALIFICATION_RETIRE' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>1 OR NOT p_input ? 'expectedVersion' OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO q FROM hon.instructor_qualifications WHERE id=p_id AND organization_id=org AND school_id=school FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'INSTRUCTOR_QUALIFICATION_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO qr FROM hon.instructor_qualification_revisions WHERE qualification_id=q.id ORDER BY version DESC LIMIT 1 FOR UPDATE; expected:=(p_input->>'expectedVersion')::integer;
  IF qr.version<>expected OR qr.status<>'ACTIVE' THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.instructor_qualification_revisions(qualification_id,organization_id,school_id,version,status,recorded_by_principal_id,request_id) VALUES(q.id,org,school,qr.version+1,'RETIRED',actor,p_request);
  entity:=q.id; version:=qr.version+1; result:=hon.instructor_qualification_definition_projection(entity); event:='staff.instructor_qualification.definition.retired'; audit_next:=jsonb_build_object('id',entity,'version',version,'status','RETIRED','definitionOnly',true);
 ELSIF p_action='EVIDENCE_RECORD' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>5 OR NOT p_input ?& ARRAY['qualificationId','expectedQualificationVersion','attainedOn','expiresOn','evidenceReference']
   OR jsonb_typeof(p_input->'qualificationId') IS DISTINCT FROM 'string' OR p_input->>'qualificationId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
   OR jsonb_typeof(p_input->'expectedQualificationVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedQualificationVersion' !~ '^[1-9][0-9]{0,8}$'
   OR jsonb_typeof(p_input->'attainedOn') IS DISTINCT FROM 'string' OR p_input->>'attainedOn' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
   OR NOT hon.instructor_qualification_safe_text(p_input->>'evidenceReference',160)
   OR (p_input->'expiresOn'<>'null'::jsonb AND (jsonb_typeof(p_input->'expiresOn') IS DISTINCT FROM 'string' OR p_input->>'expiresOn' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF to_char((p_input->>'attainedOn')::date,'YYYY-MM-DD')<>p_input->>'attainedOn' OR (p_input->'expiresOn'<>'null'::jsonb AND (to_char((p_input->>'expiresOn')::date,'YYYY-MM-DD')<>p_input->>'expiresOn' OR (p_input->>'expiresOn')::date<(p_input->>'attainedOn')::date)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF NOT hon.staff_member_eligible(p_staff,org,school) THEN RAISE EXCEPTION 'STAFF_MEMBER_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  SELECT * INTO q FROM hon.instructor_qualifications WHERE id=(p_input->>'qualificationId')::uuid AND organization_id=org AND school_id=school FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'INSTRUCTOR_QUALIFICATION_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO qr FROM hon.instructor_qualification_revisions WHERE qualification_id=q.id ORDER BY version DESC LIMIT 1 FOR SHARE;
  IF qr.status<>'ACTIVE' OR qr.version<>(p_input->>'expectedQualificationVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.instructor_qualification_evidence(organization_id,school_id,staff_principal_id,qualification_id,qualification_version,course_program_id,kind,attained_on,expires_on,evidence_reference,recorded_by_principal_id,request_id)
   VALUES(org,school,p_staff,q.id,qr.version,q.course_program_id,q.kind,(p_input->>'attainedOn')::date,(p_input->>'expiresOn')::date,p_input->>'evidenceReference',actor,p_request) RETURNING * INTO e;
  INSERT INTO hon.instructor_qualification_evidence_reviews(evidence_id,organization_id,school_id,version,status,review_note,recorded_by_principal_id,request_id) VALUES(e.id,org,school,1,'RECORDED','Human-recorded evidence',actor,p_request);
  entity:=e.id; version:=1; result:=hon.instructor_qualification_evidence_projection(entity,p_staff); event:='staff.instructor_qualification.recorded'; audit_next:=jsonb_build_object('id',entity,'qualificationId',q.id,'qualificationVersion',qr.version,'reviewVersion',1,'reviewStatus','RECORDED','expiresOn',e.expires_on,'humanRecordedOnly',true,'notEligibility',true);
 ELSE
  IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>3 OR NOT p_input ?& ARRAY['expectedReviewVersion','status','reviewNote']
   OR jsonb_typeof(p_input->'expectedReviewVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedReviewVersion' !~ '^[1-9][0-9]{0,8}$'
   OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR p_input->>'status' NOT IN('REVIEWED','RETIRED')
   OR jsonb_typeof(p_input->'reviewNote') IS DISTINCT FROM 'string' OR NOT hon.instructor_qualification_safe_text(p_input->>'reviewNote',500) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF NOT hon.staff_member_eligible(p_staff,org,school) THEN RAISE EXCEPTION 'STAFF_MEMBER_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  SELECT * INTO e FROM hon.instructor_qualification_evidence WHERE id=p_id AND staff_principal_id=p_staff AND organization_id=org AND school_id=school FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'INSTRUCTOR_QUALIFICATION_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO er FROM hon.instructor_qualification_evidence_reviews WHERE evidence_id=e.id ORDER BY version DESC LIMIT 1 FOR UPDATE; expected:=(p_input->>'expectedReviewVersion')::integer;
  IF er.version<>expected OR er.status='RETIRED' THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  status:=p_input->>'status'; INSERT INTO hon.instructor_qualification_evidence_reviews(evidence_id,organization_id,school_id,version,status,review_note,recorded_by_principal_id,request_id) VALUES(e.id,org,school,er.version+1,status,p_input->>'reviewNote',actor,p_request);
  entity:=e.id; version:=er.version+1; result:=hon.instructor_qualification_evidence_projection(entity,p_staff); event:=CASE status WHEN 'RETIRED' THEN 'staff.instructor_qualification.retired' ELSE 'staff.instructor_qualification.reviewed' END;
  audit_next:=jsonb_build_object('id',entity,'qualificationId',e.qualification_id,'reviewVersion',version,'reviewStatus',status,'humanRecordedOnly',true,'notEligibility',true);
 END IF;
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
  VALUES(org,school,actor,'HUMAN_UI','staff.instructor_qualification.manage',CASE WHEN p_action LIKE 'QUALIFICATION%' THEN 'INSTRUCTOR_QUALIFICATION' ELSE 'INSTRUCTOR_QUALIFICATION_EVIDENCE' END,entity,NULL,audit_next,'SUCCEEDED',p_request,p_correlation,NULL,clock_timestamp());
 IF p_action NOT IN('QUALIFICATION_CREATE','QUALIFICATION_RETIRE') THEN
  INSERT INTO hon.instructor_qualification_outbox(organization_id,school_id,evidence_id,review_version,event_type)
   VALUES(org,school,entity,version,event);
 END IF;
 INSERT INTO hon.instructor_qualification_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 PERFORM hon.require_instructor_qualification_actor(p_subject,'staff.instructor_qualification.manage'); RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

COMMIT;
