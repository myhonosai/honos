BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Registration requires trusted migration owner'; END IF;
END $$;

-- Existing family.create/member.manage are not a substitute for this exact
-- sensitive authority. Follow the established system OWNER bootstrap only.
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
VALUES('family.manage','Direct human owner-launch creation of one new guardian and child family',true,true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT id,organization_id,'family.manage' FROM hon.roles WHERE is_system_role AND code='OWNER'
ON CONFLICT DO NOTHING;

-- Evidence relations only: reuse the sole people/family/student/enrollment models.
ALTER TABLE hon.family_members ADD CONSTRAINT launch_family_member_relation_unique UNIQUE(id,family_id,person_id,member_role,organization_id,school_id);
ALTER TABLE hon.student_profiles ADD CONSTRAINT launch_student_family_relation_unique UNIQUE(id,person_id,primary_family_id,organization_id,school_id);
CREATE TABLE hon.guardian_child_registration_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), family_id uuid NOT NULL,
 guardian_person_id uuid NOT NULL, child_person_id uuid NOT NULL,
 guardian_member_id uuid NOT NULL, child_member_id uuid NOT NULL,
 guardian_role hon.family_member_role NOT NULL DEFAULT 'GUARDIAN' CHECK(guardian_role='GUARDIAN'),
 child_role hon.family_member_role NOT NULL DEFAULT 'STUDENT' CHECK(child_role='STUDENT'),
 student_profile_id uuid NOT NULL, enrollment_id uuid NOT NULL, program_id uuid NOT NULL, class_session_id uuid NOT NULL,
 idempotency_digest bytea NOT NULL CHECK(octet_length(idempotency_digest)=32), fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32),
 receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(guardian_person_id<>child_person_id AND guardian_member_id<>child_member_id),
 UNIQUE(organization_id,school_id,actor_principal_id,idempotency_digest), UNIQUE(id,organization_id,school_id),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
 CONSTRAINT child_registration_guardian_fk FOREIGN KEY(guardian_member_id,family_id,guardian_person_id,guardian_role,organization_id,school_id) REFERENCES hon.family_members(id,family_id,person_id,member_role,organization_id,school_id),
 CONSTRAINT child_registration_child_fk FOREIGN KEY(child_member_id,family_id,child_person_id,child_role,organization_id,school_id) REFERENCES hon.family_members(id,family_id,person_id,member_role,organization_id,school_id),
 CONSTRAINT child_registration_student_family_fk FOREIGN KEY(student_profile_id,child_person_id,family_id,organization_id,school_id) REFERENCES hon.student_profiles(id,person_id,primary_family_id,organization_id,school_id),
 CONSTRAINT child_registration_enrollment_fk FOREIGN KEY(enrollment_id,student_profile_id,program_id,organization_id,school_id) REFERENCES hon.student_curriculum_enrollments(id,student_profile_id,program_id,organization_id,school_id),
 CONSTRAINT child_registration_class_fk FOREIGN KEY(class_session_id,program_id,organization_id,school_id) REFERENCES hon.class_sessions(id,program_id,organization_id,school_id)
);
CREATE TABLE hon.guardian_child_registration_outbox (
 registration_id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 CONSTRAINT child_registration_outbox_scope_fk FOREIGN KEY(registration_id,organization_id,school_id) REFERENCES hon.guardian_child_registration_receipts(id,organization_id,school_id),
 event_code text NOT NULL DEFAULT 'student.guardian_child_registered.v1' CHECK(event_code='student.guardian_child_registered.v1'),
 state text NOT NULL DEFAULT 'INERT' CHECK(state='INERT')
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['guardian_child_registration_receipts','guardian_child_registration_outbox'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE TRIGGER registration_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_history()',t);
  EXECUTE format('CREATE TRIGGER registration_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_history()',t);
 END LOOP;
END $$;

CREATE FUNCTION hon.require_owner_launch_family_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
 actor:=hon.require_owner_launch_actor(p_subject);
 IF NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),'family.manage') THEN RAISE EXCEPTION 'REGISTRATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;

-- Never widen register_owner_launch_student: a separate closed direct-human command.
CREATE FUNCTION hon.register_owner_launch_guardian_child(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
 program hon.programs%ROWTYPE; session hon.class_sessions%ROWTYPE; previous hon.guardian_child_registration_receipts%ROWTYPE;
 child_birth date; guardian_birth date; class_date date; months integer; guardian uuid; child uuid; family uuid;
 guardian_member uuid; child_member uuid; student uuid; enrollment uuid; registration uuid:=gen_random_uuid(); instant timestamptz;
 fp bytea; key_digest bytea; result jsonb; field text; guardian_given text; guardian_family text; child_given text; child_family text;
BEGIN
 actor:=hon.lock_owner_launch_actor(p_subject);
 PERFORM hon.require_owner_launch_family_actor(p_subject);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
 OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
 OR (SELECT count(*) FROM jsonb_object_keys(p_input))<>11
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('programId','expectedProgramVersion','classSessionId','expectedClassSessionVersion','guardianGivenName','guardianFamilyName','guardianBirthDate','childGivenName','childFamilyName','childBirthDate','attestation'))
 OR p_input->>'attestation' IS DISTINCT FROM 'NEW_CHILD_WITH_NEW_GUARDIAN'
 OR jsonb_typeof(p_input->'expectedProgramVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedProgramVersion' !~ '^[1-9][0-9]{0,8}$'
 OR jsonb_typeof(p_input->'expectedClassSessionVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedClassSessionVersion' !~ '^[1-9][0-9]{0,8}$'
 OR jsonb_typeof(p_input->'programId') IS DISTINCT FROM 'string' OR p_input->>'programId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR jsonb_typeof(p_input->'classSessionId') IS DISTINCT FROM 'string' OR p_input->>'classSessionId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 FOREACH field IN ARRAY ARRAY['guardianGivenName','guardianFamilyName','childGivenName','childFamilyName'] LOOP
  IF jsonb_typeof(p_input->field) IS DISTINCT FROM 'string' OR length(p_input->>field) NOT BETWEEN 1 AND 100 OR btrim(p_input->>field)<>p_input->>field OR p_input->>field ~ '[[:cntrl:]<>]' OR regexp_replace(p_input->>field,'[^[:alnum:]]','','g')='' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOREACH field IN ARRAY ARRAY['guardianBirthDate','childBirthDate'] LOOP
  IF jsonb_typeof(p_input->field) IS DISTINCT FROM 'string' OR p_input->>field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 child_birth:=(p_input->>'childBirthDate')::date; guardian_birth:=(p_input->>'guardianBirthDate')::date;
 IF NOT isfinite(child_birth) OR NOT isfinite(guardian_birth) OR child_birth<date '1900-01-01' OR guardian_birth<date '1900-01-01'
 OR child_birth>(clock_timestamp() AT TIME ZONE 'UTC')::date OR guardian_birth>(clock_timestamp() AT TIME ZONE 'UTC')::date THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 guardian_given:=lower(regexp_replace(p_input->>'guardianGivenName','[^[:alnum:]]','','g')); guardian_family:=lower(regexp_replace(p_input->>'guardianFamilyName','[^[:alnum:]]','','g'));
 child_given:=lower(regexp_replace(p_input->>'childGivenName','[^[:alnum:]]','','g')); child_family:=lower(regexp_replace(p_input->>'childFamilyName','[^[:alnum:]]','','g'));
 IF guardian_given=child_given AND guardian_family=child_family THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 fp:=sha256(convert_to(p_input::text,'UTF8')); key_digest:=sha256(convert_to(p_key,'UTF8'));
 -- Share serialization with the adult command, then reauthorize AFTER any wait.
 PERFORM pg_advisory_xact_lock(hashtextextended('student.registration:'||org::text||':'||school::text,0));
 PERFORM hon.require_owner_launch_family_actor(p_subject);
 SELECT * INTO previous FROM hon.guardian_child_registration_receipts WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND idempotency_digest=key_digest;
 IF FOUND THEN
  IF previous.fingerprint IS DISTINCT FROM fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('receipt',previous.receipt,'replayed',true);
 END IF;
 SELECT * INTO program FROM hon.programs WHERE id=(p_input->>'programId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
 SELECT * INTO session FROM hon.class_sessions WHERE id=(p_input->>'classSessionId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
 IF program.id IS NULL OR session.id IS NULL OR session.program_id<>program.id THEN RAISE EXCEPTION 'REGISTRATION_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF program.version<>(p_input->>'expectedProgramVersion')::integer OR session.version<>(p_input->>'expectedClassSessionVersion')::integer THEN RAISE EXCEPTION 'REGISTRATION_STALE' USING ERRCODE='40001'; END IF;
 IF program.status NOT IN('DRAFT','SCHEDULED') OR session.status<>'SCHEDULED' OR session.starts_at<=clock_timestamp() THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 class_date:=(session.starts_at AT TIME ZONE 'UTC')::date;
 IF guardian_birth>class_date-interval '18 years' OR child_birth<=class_date-interval '18 years' THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 months:=extract(year FROM age(class_date,child_birth))::integer*12+extract(month FROM age(class_date,child_birth))::integer;
 IF (program.minimum_age_months IS NOT NULL AND months<program.minimum_age_months) OR (program.maximum_age_months IS NOT NULL AND months>program.maximum_age_months) THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 LOCK TABLE hon.people,hon.student_profiles IN SHARE ROW EXCLUSIVE MODE;
 -- Conservative school-local potential identity denial; never search, merge or reveal.
 -- Names are compared without case/spacing/punctuation regardless of DOB; matching
 -- child surname plus DOB is also ambiguous even when the given name differs.
 IF EXISTS(SELECT 1 FROM hon.people p LEFT JOIN hon.student_profiles s ON s.person_id=p.id AND s.organization_id=p.organization_id AND s.school_id=p.school_id
  WHERE p.organization_id=org AND p.school_id=school AND (
   (lower(regexp_replace(p.given_name,'[^[:alnum:]]','','g'))=guardian_given AND lower(regexp_replace(p.family_name,'[^[:alnum:]]','','g'))=guardian_family)
   OR (lower(regexp_replace(p.given_name,'[^[:alnum:]]','','g'))=child_given AND lower(regexp_replace(p.family_name,'[^[:alnum:]]','','g'))=child_family)
   OR (s.birth_date=child_birth AND lower(regexp_replace(p.family_name,'[^[:alnum:]]','','g'))=child_family))) THEN RAISE EXCEPTION 'REGISTRATION_NEEDS_STAFF' USING ERRCODE='22023'; END IF;
 PERFORM hon.require_owner_launch_family_actor(p_subject);
 INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES(org,school,p_input->>'guardianGivenName',p_input->>'guardianFamilyName') RETURNING id INTO guardian;
 INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES(org,school,p_input->>'childGivenName',p_input->>'childFamilyName') RETURNING id INTO child;
 INSERT INTO hon.families(organization_id,school_id,display_name) VALUES(org,school,'Owner launch family') RETURNING id INTO family;
 INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES(org,school,family,guardian,'GUARDIAN',false) RETURNING id INTO guardian_member;
 INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES(org,school,family,child,'STUDENT',false) RETURNING id INTO child_member;
 INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES(org,school,child,family,child_birth) RETURNING id INTO student;
 INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,program_id,curriculum_id,current_rank_id) VALUES(org,school,student,program.id,NULL,NULL) RETURNING id INTO enrollment;
 instant:=clock_timestamp();
 result:=jsonb_build_object('registrationId',registration,'studentProfileId',student,'enrollmentId',enrollment,'programId',program.id,'classSessionId',session.id,'familyId',family,'registrationKind','NEW_CHILD_WITH_NEW_GUARDIAN','status','REGISTERED_NO_BOOKING','createdAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 INSERT INTO hon.guardian_child_registration_receipts(id,organization_id,school_id,actor_principal_id,family_id,guardian_person_id,child_person_id,guardian_member_id,child_member_id,student_profile_id,enrollment_id,program_id,class_session_id,idempotency_digest,fingerprint,receipt,created_at) VALUES(registration,org,school,actor,family,guardian,child,guardian_member,child_member,student,enrollment,program.id,session.id,key_digest,fp,result,instant);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id) VALUES(org,school,actor,'HUMAN_UI','student.guardian_child.register','GUARDIAN_CHILD_REGISTRATION',registration,NULL,result,'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.guardian_child_registration_outbox(registration_id,organization_id,school_id) VALUES(registration,org,school);
 PERFORM hon.require_owner_launch_family_actor(p_subject);
 RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

DO $$ DECLARE r text; t text; f text; BEGIN
 FOREACH t IN ARRAY ARRAY['guardian_child_registration_receipts','guardian_child_registration_outbox'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['require_owner_launch_family_actor(text)','register_owner_launch_guardian_child(text,jsonb,text,uuid,uuid)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM PUBLIC',f);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I',f,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.register_owner_launch_guardian_child(text,jsonb,text,uuid,uuid) TO hon_runtime; END IF;
END $$;
CREATE OR REPLACE FUNCTION hon.read_owner_launch(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); program jsonb; class jsonb; registration jsonb; child_registration jsonb; result jsonb;
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
 IF hon.principal_has_school_permission(actor,org,school,'family.manage') THEN
  SELECT r.receipt INTO child_registration FROM hon.guardian_child_registration_receipts r WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.program_id=(program->>'id')::uuid AND r.class_session_id=(class->>'id')::uuid ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
 END IF;
 SELECT jsonb_build_object('organizationId',org,'schoolId',school,'schoolName',left(regexp_replace(s.name,'[[:cntrl:]<>]','','g'),160),'tier',e.tier,'program',program,'classSession',class,'registration',registration,'guardianChildRegistration',child_registration) INTO result FROM hon.schools s JOIN hon.organization_entitlements e ON e.organization_id=s.organization_id WHERE s.id=school AND s.organization_id=org AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp());
 PERFORM hon.require_owner_launch_actor(p_subject);
 IF child_registration IS NOT NULL THEN PERFORM hon.require_owner_launch_family_actor(p_subject); END IF;
 RETURN result;
END $$;

COMMIT;
