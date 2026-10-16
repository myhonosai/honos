BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Registration requires trusted migration owner'; END IF;
END $$;

-- Reuse the sole enrollment model. A program-only enrollment has no inferred
-- curriculum/rank. Historical curriculum enrollments are unchanged.
ALTER TABLE hon.student_curriculum_enrollments ADD COLUMN program_id uuid;
ALTER TABLE hon.student_curriculum_enrollments ALTER COLUMN curriculum_id DROP NOT NULL;
ALTER TABLE hon.student_curriculum_enrollments ADD CONSTRAINT enrollment_program_scope_fk
 FOREIGN KEY(program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT;
ALTER TABLE hon.student_curriculum_enrollments ADD CONSTRAINT enrollment_truthful_target
 CHECK((curriculum_id IS NOT NULL OR program_id IS NOT NULL) AND (curriculum_id IS NOT NULL OR current_rank_id IS NULL));
CREATE UNIQUE INDEX enrollment_student_program_unique ON hon.student_curriculum_enrollments(student_profile_id,program_id) WHERE program_id IS NOT NULL;
CREATE FUNCTION hon.guard_enrollment_program_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF NEW.program_id IS DISTINCT FROM OLD.program_id THEN RAISE EXCEPTION 'IMMUTABLE_ENROLLMENT_PROGRAM' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER enrollment_program_identity BEFORE UPDATE ON hon.student_curriculum_enrollments FOR EACH ROW EXECUTE FUNCTION hon.guard_enrollment_program_identity();

ALTER TABLE hon.student_curriculum_enrollments ADD UNIQUE(id,student_profile_id,program_id,organization_id,school_id);
ALTER TABLE hon.class_sessions ADD UNIQUE(id,program_id,organization_id,school_id);
CREATE TABLE hon.student_registration_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), student_profile_id uuid NOT NULL, enrollment_id uuid NOT NULL,
 program_id uuid NOT NULL, class_session_id uuid NOT NULL,
 idempotency_digest bytea NOT NULL CHECK(octet_length(idempotency_digest)=32), fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
 receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,school_id,actor_principal_id,idempotency_digest),
 UNIQUE(id,organization_id,school_id),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
 FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
 CONSTRAINT registration_enrollment_relation_fk FOREIGN KEY(enrollment_id,student_profile_id,program_id,organization_id,school_id) REFERENCES hon.student_curriculum_enrollments(id,student_profile_id,program_id,organization_id,school_id),
 FOREIGN KEY(program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id),
 CONSTRAINT registration_class_program_fk FOREIGN KEY(class_session_id,program_id,organization_id,school_id) REFERENCES hon.class_sessions(id,program_id,organization_id,school_id)
);
CREATE TABLE hon.student_registration_outbox (
 registration_id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 CONSTRAINT registration_outbox_scope_fk FOREIGN KEY(registration_id,organization_id,school_id) REFERENCES hon.student_registration_receipts(id,organization_id,school_id),
 event_code text NOT NULL DEFAULT 'student.registered.v1' CHECK(event_code='student.registered.v1'),
 state text NOT NULL DEFAULT 'INERT' CHECK(state='INERT'),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['student_registration_receipts','student_registration_outbox'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE TRIGGER registration_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_history()',t);
  EXECUTE format('CREATE TRIGGER registration_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_history()',t);
 END LOOP;
END $$;

-- Selector-free, one live school only; existing permission policy, not a new role.
CREATE FUNCTION hon.resolve_owner_launch_scope(p_subject text) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH eligible AS (
 SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id
 FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
 JOIN hon.principal_role_grants g ON g.principal_id=p.id
 JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id AND s.status='ACTIVE'
 JOIN hon.organizations o ON o.id=s.organization_id AND o.status='ACTIVE'
 WHERE u.external_subject=p_subject AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=s.id)
 AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
 AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
 AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id AND h.effective_from<=clock_timestamp() AND (h.effective_until IS NULL OR h.effective_until>clock_timestamp()))
 AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants x JOIN hon.roles xr ON xr.id=x.role_id AND xr.organization_id=x.organization_id WHERE x.principal_id=p.id AND x.revoked_at IS NULL AND x.effective_from<=clock_timestamp() AND (x.effective_until IS NULL OR x.effective_until>clock_timestamp()) AND xr.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
 AND (SELECT count(*) FROM hon.organization_entitlements e WHERE e.organization_id=o.id AND e.status='ACTIVE' AND e.tier IN('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))=1
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['school.view','people.create','student.profile.manage','curriculum.progress.record','program.manage','schedule.session.manage']) permission WHERE NOT hon.principal_has_school_permission(p.id,o.id,s.id,permission))
 ) SELECT * FROM eligible WHERE (SELECT count(*) FROM eligible)=1;
$$;
CREATE FUNCTION hon.require_owner_launch_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE scope record;
BEGIN
 IF p_subject IS NULL OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
 OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'REGISTRATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO scope FROM hon.resolve_owner_launch_scope(p_subject);
 IF scope.principal_id IS NULL OR scope.principal_id::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
 OR scope.organization_id IS DISTINCT FROM hon.current_organization_id() OR scope.school_id IS DISTINCT FROM hon.current_school_id() THEN RAISE EXCEPTION 'REGISTRATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN scope.principal_id;
END $$;
CREATE FUNCTION hon.lock_owner_launch_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 PERFORM hon.require_owner_launch_actor(p_subject);
 -- Bounded manual launch commands: prevent IAM inserts/revocations/expiry races,
 -- including ambiguity and family/HQ authority phantoms. No source-table writes.
 LOCK TABLE hon.family_access_grants,hon.hq_operator_grants,hon.organization_entitlements,hon.organizations,
 hon.permissions,hon.principal_role_grants,hon.principals,hon.role_permissions,hon.roles,hon.schools,hon.users IN SHARE MODE;
 RETURN hon.require_owner_launch_actor(p_subject);
END $$;

CREATE FUNCTION hon.register_owner_launch_student(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
 program hon.programs%ROWTYPE; session hon.class_sessions%ROWTYPE; previous hon.student_registration_receipts%ROWTYPE;
 birth date; months integer; person uuid; student uuid; enrollment uuid; registration uuid:=gen_random_uuid(); instant timestamptz;
 fp bytea; key_digest bytea; result jsonb;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
 OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('programId','expectedProgramVersion','classSessionId','expectedClassSessionVersion','givenName','familyName','birthDate','attestation'))
 OR jsonb_typeof(p_input->'givenName') IS DISTINCT FROM 'string' OR length(p_input->>'givenName') NOT BETWEEN 1 AND 100 OR btrim(p_input->>'givenName')<>p_input->>'givenName' OR p_input->>'givenName' ~ '[[:cntrl:]<>]'
 OR jsonb_typeof(p_input->'familyName') IS DISTINCT FROM 'string' OR length(p_input->>'familyName') NOT BETWEEN 1 AND 100 OR btrim(p_input->>'familyName')<>p_input->>'familyName' OR p_input->>'familyName' ~ '[[:cntrl:]<>]'
 OR p_input->>'attestation' IS DISTINCT FROM 'NEW_ADULT_NO_GUARDIAN_REQUIRED'
 OR jsonb_typeof(p_input->'birthDate') IS DISTINCT FROM 'string' OR p_input->>'birthDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 OR jsonb_typeof(p_input->'expectedProgramVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedProgramVersion' !~ '^[1-9][0-9]{0,8}$'
 OR jsonb_typeof(p_input->'expectedClassSessionVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedClassSessionVersion' !~ '^[1-9][0-9]{0,8}$'
 OR jsonb_typeof(p_input->'programId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'classSessionId') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 birth:=(p_input->>'birthDate')::date;
 IF NOT isfinite(birth) OR birth<date '1900-01-01' OR birth>(clock_timestamp() AT TIME ZONE 'UTC')::date-interval '18 years' THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 fp:=sha256(convert_to(p_input::text,'UTF8')); key_digest:=sha256(convert_to(p_key,'UTF8'));
 PERFORM pg_advisory_xact_lock(hashtextextended('student.registration:'||org::text||':'||school::text,0));
 PERFORM hon.require_owner_launch_actor(p_subject);
 SELECT * INTO previous FROM hon.student_registration_receipts WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND idempotency_digest=key_digest;
 IF FOUND THEN
  IF previous.fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('receipt',previous.receipt,'replayed',true);
 END IF;
 SELECT * INTO program FROM hon.programs WHERE id=(p_input->>'programId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
 SELECT * INTO session FROM hon.class_sessions WHERE id=(p_input->>'classSessionId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
 IF program.id IS NULL OR session.id IS NULL OR session.program_id<>program.id THEN RAISE EXCEPTION 'REGISTRATION_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF program.version<>(p_input->>'expectedProgramVersion')::integer OR session.version<>(p_input->>'expectedClassSessionVersion')::integer THEN RAISE EXCEPTION 'REGISTRATION_STALE' USING ERRCODE='40001'; END IF;
 IF program.status NOT IN('DRAFT','SCHEDULED') OR session.status<>'SCHEDULED' OR session.starts_at<=clock_timestamp() THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 months:=extract(year FROM age((session.starts_at AT TIME ZONE 'UTC')::date,birth))::integer*12+extract(month FROM age((session.starts_at AT TIME ZONE 'UTC')::date,birth))::integer;
 IF (program.minimum_age_months IS NOT NULL AND months<program.minimum_age_months) OR (program.maximum_age_months IS NOT NULL AND months>program.maximum_age_months) THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 -- Never merge/infer identity. An exact potential existing student is staff work.
 LOCK TABLE hon.people,hon.student_profiles IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM hon.people p WHERE p.organization_id=org AND p.school_id=school AND lower(btrim(p.given_name))=lower(p_input->>'givenName') AND lower(btrim(p.family_name))=lower(p_input->>'familyName')) THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 PERFORM hon.require_owner_launch_actor(p_subject);
 INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES(org,school,p_input->>'givenName',p_input->>'familyName') RETURNING id INTO person;
 INSERT INTO hon.student_profiles(organization_id,school_id,person_id,birth_date) VALUES(org,school,person,birth) RETURNING id INTO student;
 INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,program_id,curriculum_id,current_rank_id) VALUES(org,school,student,program.id,NULL,NULL) RETURNING id INTO enrollment;
 instant:=clock_timestamp();
 result:=jsonb_build_object('registrationId',registration,'studentProfileId',student,'enrollmentId',enrollment,'programId',program.id,'classSessionId',session.id,'status','REGISTERED_NO_BOOKING','createdAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 INSERT INTO hon.student_registration_receipts(id,organization_id,school_id,actor_principal_id,student_profile_id,enrollment_id,program_id,class_session_id,idempotency_digest,fingerprint,receipt,created_at) VALUES(registration,org,school,actor,student,enrollment,program.id,session.id,key_digest,fp,result,instant);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id) VALUES(org,school,actor,'HUMAN_UI','student.register','STUDENT_REGISTRATION',registration,NULL,result,'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.student_registration_outbox(registration_id,organization_id,school_id) VALUES(registration,org,school);
 PERFORM hon.require_owner_launch_actor(p_subject);
 RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

CREATE FUNCTION hon.read_owner_launch(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); program jsonb; class jsonb; registration jsonb; result jsonb;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 -- Immutable requester-owned saved creation receipts only, not a directory.
 SELECT jsonb_build_object('id',p.id,'version',(i.response_body->>'version')::integer,'status',i.response_body->>'status') INTO program
 FROM hon.idempotency_records i JOIN hon.programs p ON p.id::text=i.response_body->>'id' AND p.organization_id=i.organization_id AND p.school_id=i.school_id
 WHERE i.organization_id=org AND i.school_id=school AND i.principal_id=actor AND i.status='COMPLETED'
 AND EXISTS(SELECT 1 FROM hon.audit_events a WHERE a.organization_id=org AND a.school_id=school AND a.actor_principal_id=actor AND a.entity_id=p.id AND a.action_code='program.create') ORDER BY i.created_at DESC,i.id DESC LIMIT 1;
 SELECT jsonb_build_object('id',s.id,'programId',s.program_id,'version',(i.response_body->>'version')::integer,'status',i.response_body->>'status') INTO class
 FROM hon.idempotency_records i JOIN hon.class_sessions s ON s.id::text=i.response_body->>'id' AND s.organization_id=i.organization_id AND s.school_id=i.school_id
 WHERE i.organization_id=org AND i.school_id=school AND i.principal_id=actor AND i.status='COMPLETED' AND s.program_id=(program->>'id')::uuid
 AND EXISTS(SELECT 1 FROM hon.audit_events a WHERE a.organization_id=org AND a.school_id=school AND a.actor_principal_id=actor AND a.entity_id=s.id AND a.action_code='schedule.session.create') ORDER BY i.created_at DESC,i.id DESC LIMIT 1;
 SELECT r.receipt INTO registration FROM hon.student_registration_receipts r WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.program_id=(program->>'id')::uuid AND r.class_session_id=(class->>'id')::uuid ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
 SELECT jsonb_build_object('organizationId',org,'schoolId',school,'schoolName',left(regexp_replace(s.name,'[[:cntrl:]<>]','','g'),160),'tier',e.tier,'program',program,'classSession',class,'registration',registration) INTO result FROM hon.schools s JOIN hon.organization_entitlements e ON e.organization_id=s.organization_id WHERE s.id=school AND s.organization_id=org AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp());
 PERFORM hon.require_owner_launch_actor(p_subject);
 RETURN result;
END $$;

DO $$ DECLARE r text; t text; f text; BEGIN
 FOREACH t IN ARRAY ARRAY['student_registration_receipts','student_registration_outbox'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['guard_enrollment_program_identity()','resolve_owner_launch_scope(text)','require_owner_launch_actor(text)','lock_owner_launch_actor(text)','register_owner_launch_student(text,jsonb,text,uuid,uuid)','read_owner_launch(text)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I',f,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_owner_launch_scope(text),hon.register_owner_launch_student(text,jsonb,text,uuid,uuid),hon.read_owner_launch(text) TO hon_runtime; END IF;
END $$;
COMMIT;
