BEGIN;

-- Conventional human-recorded workforce evidence only. This slice never assigns
-- an instructor, creates scheduling/testing eligibility, certifies a person,
-- changes employment/payroll/discipline, or invokes Action Engine/AI/provider.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Instructor qualification migration requires a trusted migration owner';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('staff.instructor_qualification.read','Read one known current-school redacted instructor qualification definition or evidence record',true,true),
 ('staff.instructor_qualification.manage','Human record, review, or retire one known current-school instructor qualification evidence record',true,true)
ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r JOIN hon.permissions p
   ON p.code IN('staff.instructor_qualification.read','staff.instructor_qualification.manage')
 WHERE r.is_system_role AND r.code='OWNER' ON CONFLICT DO NOTHING;

CREATE FUNCTION hon.instructor_qualification_safe_text(p_value text,p_maximum integer)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT p_value IS NOT NULL AND length(p_value) BETWEEN 1 AND p_maximum AND btrim(p_value)=p_value
   AND p_value !~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF<>\[\]{}=`$]'
   AND p_value !~* 'https?:|www\\.|\\y(javascript|eval|function|script|attachment|upload|iframe|legal credential|legal certification)\\y'
$$;

CREATE TABLE hon.instructor_qualifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
 title text NOT NULL CHECK(hon.instructor_qualification_safe_text(title,120)),
 kind text NOT NULL CHECK(kind IN('QUALIFICATION','CERTIFICATION')),
 course_program_id uuid,
 created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(course_program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT,
 UNIQUE(id,organization_id,school_id), UNIQUE(organization_id,school_id,code)
);
CREATE TABLE hon.instructor_qualification_revisions (
 qualification_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 status text NOT NULL CHECK(status IN('ACTIVE','RETIRED')),
 recorded_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(qualification_id,version),
 FOREIGN KEY(qualification_id,organization_id,school_id) REFERENCES hon.instructor_qualifications(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.instructor_qualification_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 staff_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 qualification_id uuid NOT NULL, qualification_version integer NOT NULL CHECK(qualification_version BETWEEN 1 AND 999999999),
 course_program_id uuid,
 kind text NOT NULL CHECK(kind IN('QUALIFICATION','CERTIFICATION')),
 attained_on date NOT NULL CHECK(attained_on BETWEEN '2000-01-01'::date AND '2099-12-31'::date),
 expires_on date CHECK(expires_on IS NULL OR expires_on>=attained_on),
 evidence_reference text NOT NULL CHECK(hon.instructor_qualification_safe_text(evidence_reference,160)),
 recorded_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(qualification_id,organization_id,school_id) REFERENCES hon.instructor_qualifications(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(course_program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT,
 UNIQUE(id,organization_id,school_id)
);
CREATE TABLE hon.instructor_qualification_evidence_reviews (
 evidence_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 status text NOT NULL CHECK(status IN('RECORDED','REVIEWED','RETIRED')),
 review_note text NOT NULL CHECK(hon.instructor_qualification_safe_text(review_note,500)),
 recorded_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(evidence_id,version),
 FOREIGN KEY(evidence_id,organization_id,school_id) REFERENCES hon.instructor_qualification_evidence(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.instructor_qualification_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200 AND btrim(idempotency_key)=idempotency_key AND idempotency_key !~ '[[:cntrl:]]'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
-- Separate from the dispatchable global outbox. No worker/consumer is granted or
-- registered; the DB constraint makes all emitted evidence deliberately inert.
CREATE TABLE hon.instructor_qualification_outbox (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, evidence_id uuid NOT NULL,
 review_version integer NOT NULL CHECK(review_version BETWEEN 1 AND 999999999),
 event_type text NOT NULL CHECK(event_type IN('staff.instructor_qualification.recorded','staff.instructor_qualification.reviewed','staff.instructor_qualification.retired','staff.instructor_qualification.definition.retired')),
 status text NOT NULL DEFAULT 'INERT' CHECK(status='INERT'), execution_allowed boolean NOT NULL DEFAULT false CHECK(NOT execution_allowed),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(evidence_id,review_version),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(evidence_id,organization_id,school_id) REFERENCES hon.instructor_qualification_evidence(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX instructor_qualification_evidence_scope_idx ON hon.instructor_qualification_evidence(organization_id,school_id,staff_principal_id,id);

CREATE FUNCTION hon.guard_instructor_qualification_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_INSTRUCTOR_QUALIFICATION_HISTORY' USING ERRCODE='42501'; END $$;

CREATE FUNCTION hon.instructor_qualification_permission(p_actor uuid,p_org uuid,p_school uuid,p_permission text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT p_permission IN('staff.instructor_qualification.read','staff.instructor_qualification.manage')
  AND hon.staff_member_eligible(p_actor,p_org,p_school)
  AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
    JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
    WHERE g.principal_id=p_actor AND g.organization_id=p_org AND g.school_id=p_school AND rp.permission_code=p_permission
     AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
     AND (r.management_school_id IS NULL OR r.management_school_id=p_school))
  AND (SELECT count(*) FROM hon.organization_entitlements e WHERE e.organization_id=p_org AND e.tier IN('ESSENTIAL','CORE','COMPLETE') AND e.status='ACTIVE'
    AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))=1
$$;

-- There is deliberately no school selector. A direct human session must have one
-- exact live eligible school for this optional staff workbench.
CREATE FUNCTION hon.resolve_instructor_qualification_scope(p_subject text)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS (
  SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
   JOIN hon.principal_role_grants g ON g.principal_id=p.id
  WHERE p_subject IS NOT NULL AND length(p_subject) BETWEEN 1 AND 200 AND u.external_subject=p_subject
   AND p.principal_type='HUMAN_USER' AND p.is_active
   AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=p.user_id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
   AND (hon.instructor_qualification_permission(p.id,g.organization_id,g.school_id,'staff.instructor_qualification.read')
     OR hon.instructor_qualification_permission(p.id,g.organization_id,g.school_id,'staff.instructor_qualification.manage'))
 ) SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1
$$;

CREATE FUNCTION hon.require_instructor_qualification_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF p_permission NOT IN('staff.instructor_qualification.read','staff.instructor_qualification.manage') OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200
  OR org IS NULL OR school IS NULL OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_QUALIFICATION_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=p_subject
  AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active
  AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=p.user_id AND x.principal_type='HUMAN_USER' AND x.is_active)=1;
 IF actor IS NULL OR NOT (hon.instructor_qualification_permission(actor,org,school,p_permission)
   OR (p_permission='staff.instructor_qualification.read' AND hon.instructor_qualification_permission(actor,org,school,'staff.instructor_qualification.manage'))) THEN RAISE EXCEPTION 'INSTRUCTOR_QUALIFICATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_instructor_qualification_actor(p_subject text,p_permission text,p_writing boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF p_writing THEN PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE; PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 ELSE PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR SHARE; PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR SHARE; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'INSTRUCTOR_QUALIFICATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_instructor_qualification_actor(p_subject,p_permission);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR SHARE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR SHARE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org ORDER BY id FOR SHARE;
 RETURN hon.require_instructor_qualification_actor(p_subject,p_permission);
END $$;

CREATE FUNCTION hon.instructor_qualification_definition_projection(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',q.id,'code',q.code,'title',q.title,'kind',q.kind,'courseProgramId',q.course_program_id,
   'version',r.version,'status',r.status,'humanRecordedOnly',true,'qualificationOnly',true)
 FROM hon.instructor_qualifications q JOIN LATERAL(SELECT * FROM hon.instructor_qualification_revisions x WHERE x.qualification_id=q.id ORDER BY x.version DESC LIMIT 1) r ON true
 WHERE q.id=p_id AND q.organization_id=hon.current_organization_id() AND q.school_id=hon.current_school_id()
$$;
CREATE FUNCTION hon.instructor_qualification_evidence_projection(p_id uuid,p_staff uuid) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',e.id,'staffPrincipalId',e.staff_principal_id,'qualificationId',e.qualification_id,'qualificationVersion',e.qualification_version,
   'courseProgramId',e.course_program_id,'kind',e.kind,'attainedOn',e.attained_on,'expiresOn',e.expires_on,'evidenceRecordedAt',e.recorded_at,'evidenceRecorded',true,
   'reviewVersion',r.version,'reviewStatus',r.status,'reviewedAt',r.recorded_at,
   'expiredOnRead',e.expires_on IS NOT NULL AND e.expires_on < ((clock_timestamp() AT TIME ZONE s.timezone)::date),
   'humanRecordedOnly',true,'qualificationOnly',true,'notEligibility',true)
 FROM hon.instructor_qualification_evidence e JOIN hon.schools s ON s.id=e.school_id AND s.organization_id=e.organization_id
 JOIN LATERAL(SELECT * FROM hon.instructor_qualification_evidence_reviews x WHERE x.evidence_id=e.id ORDER BY x.version DESC LIMIT 1) r ON true
 WHERE e.id=p_id AND e.staff_principal_id=p_staff AND e.organization_id=hon.current_organization_id() AND e.school_id=hon.current_school_id()
$$;

CREATE FUNCTION hon.read_instructor_qualification(p_subject text,p_mode text,p_staff uuid DEFAULT NULL,p_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb; permission text:='staff.instructor_qualification.read'; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF p_mode NOT IN('ACCESS','QUALIFICATION','EVIDENCE') OR (p_mode='ACCESS' AND (p_staff IS NOT NULL OR p_id IS NOT NULL))
  OR (p_mode='QUALIFICATION' AND (p_id IS NULL OR p_staff IS NOT NULL)) OR (p_mode='EVIDENCE' AND (p_id IS NULL OR p_staff IS NULL)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_instructor_qualification_actor(p_subject,permission,false);
 IF p_mode='ACCESS' THEN RETURN jsonb_build_object('canRead',true,'canManage',hon.instructor_qualification_permission(actor,org,school,'staff.instructor_qualification.manage'),'humanRecordedOnly',true,'qualificationOnly',true); END IF;
 IF p_mode='QUALIFICATION' THEN result:=hon.instructor_qualification_definition_projection(p_id); ELSE
  IF NOT hon.staff_member_eligible(p_staff,org,school) THEN RAISE EXCEPTION 'STAFF_MEMBER_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  result:=hon.instructor_qualification_evidence_projection(p_id,p_staff);
 END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'INSTRUCTOR_QUALIFICATION_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 PERFORM hon.require_instructor_qualification_actor(p_subject,permission); RETURN result;
END $$;

CREATE FUNCTION hon.mutate_instructor_qualification(p_subject text,p_action text,p_staff uuid,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
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
 IF p_action<>'QUALIFICATION_CREATE' THEN
  IF p_action='QUALIFICATION_RETIRE' THEN INSERT INTO hon.instructor_qualification_outbox(organization_id,school_id,evidence_id,review_version,event_type) SELECT org,school,e.id,0,event FROM hon.instructor_qualification_evidence e WHERE false;
  ELSE INSERT INTO hon.instructor_qualification_outbox(organization_id,school_id,evidence_id,review_version,event_type) VALUES(org,school,entity,version,event); END IF;
 END IF;
 INSERT INTO hon.instructor_qualification_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 PERFORM hon.require_instructor_qualification_actor(p_subject,'staff.instructor_qualification.manage'); RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- A definition retirement has no evidence event to dispatch. Its audit record is
-- authoritative; the inert evidence outbox intentionally has no placeholder row.

DO $$ DECLARE t text; r text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['instructor_qualifications','instructor_qualification_revisions','instructor_qualification_evidence','instructor_qualification_evidence_reviews','instructor_qualification_requests','instructor_qualification_outbox'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t); EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER instructor_qualification_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_instructor_qualification_history()',t);
  EXECUTE format('CREATE TRIGGER instructor_qualification_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_instructor_qualification_history()',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%instructor_qualification%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOREACH t IN ARRAY ARRAY['instructor_qualifications','instructor_qualification_revisions','instructor_qualification_evidence','instructor_qualification_evidence_reviews','instructor_qualification_requests','instructor_qualification_outbox'] LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%instructor_qualification%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_instructor_qualification_scope(text),hon.read_instructor_qualification(text,text,uuid,uuid),hon.mutate_instructor_qualification(text,text,uuid,uuid,jsonb,text,uuid,uuid) TO hon_runtime; END IF;
END $$;

COMMENT ON FUNCTION hon.mutate_instructor_qualification(text,text,uuid,uuid,jsonb,text,uuid,uuid) IS
 'Fixed direct HUMAN_USER/HUMAN_UI-only internal instructor qualification evidence boundary. It records/reviews/retires immutable evidence only; it never certifies a person, determines class or testing eligibility, schedules/assigns staff, changes employment/payroll/discipline, or invokes Action Engine/AI/automation/provider/payment/voice.';

COMMIT;
