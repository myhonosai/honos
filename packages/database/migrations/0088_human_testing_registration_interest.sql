BEGIN;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Testing registration foundation requires a trusted migration owner';
 END IF;
END $$;

CREATE TYPE hon.testing_registration_interest_status AS ENUM ('SUBMITTED','ACCEPTED','DECLINED','WAITLISTED');
REVOKE USAGE ON TYPE hon.testing_registration_interest_status FROM PUBLIC;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
VALUES ('testing.registration.review','Review a family testing interest as accepted, declined, or waitlisted',true,true)
ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT id,organization_id,'testing.registration.review'
FROM hon.roles WHERE is_system_role AND code='OWNER'
ON CONFLICT DO NOTHING;

CREATE TABLE hon.testing_registration_interests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 school_id uuid NOT NULL,
 testing_event_id uuid NOT NULL,
 family_id uuid NOT NULL,
 student_profile_id uuid NOT NULL,
 requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 parent_note text,
 status hon.testing_registration_interest_status NOT NULL DEFAULT 'SUBMITTED',
 reviewed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
 reviewed_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 999999999),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(testing_event_id,organization_id,school_id) REFERENCES hon.testing_events(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id) ON DELETE RESTRICT,
 UNIQUE(id,organization_id,school_id),
 UNIQUE(testing_event_id,student_profile_id),
 CHECK(parent_note IS NULL OR (length(btrim(parent_note)) BETWEEN 1 AND 500 AND parent_note !~ '[[:cntrl:]]')),
 CHECK((status='SUBMITTED' AND reviewed_by_principal_id IS NULL AND reviewed_at IS NULL) OR (status IN('ACCEPTED','DECLINED','WAITLISTED') AND reviewed_by_principal_id IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX testing_registration_interest_staff_queue_idx ON hon.testing_registration_interests(organization_id,school_id,status,created_at DESC,id);
CREATE INDEX testing_registration_interest_family_idx ON hon.testing_registration_interests(organization_id,school_id,family_id,created_at DESC,id);

CREATE TABLE hon.testing_registration_command_receipts (
 organization_id uuid NOT NULL,
 school_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200 AND btrim(idempotency_key)=idempotency_key AND idempotency_key !~ '[[:cntrl:]]'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);

ALTER TABLE hon.testing_registration_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_registration_interests FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_registration_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_registration_command_receipts FORCE ROW LEVEL SECURITY;
-- No policies: these private records may be accessed only by the fixed functions below.

CREATE FUNCTION hon.guard_testing_registration_interest() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'IMMUTABLE_TESTING_REGISTRATION_INTEREST' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'SUBMITTED' OR NEW.reviewed_by_principal_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.version<>1 THEN
   RAISE EXCEPTION 'INVALID_TESTING_REGISTRATION_INTEREST' USING ERRCODE='42501';
  END IF;
 ELSIF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.testing_event_id<>OLD.testing_event_id
   OR NEW.family_id<>OLD.family_id OR NEW.student_profile_id<>OLD.student_profile_id OR NEW.requested_by_principal_id<>OLD.requested_by_principal_id
   OR NEW.parent_note IS DISTINCT FROM OLD.parent_note OR NEW.created_at<>OLD.created_at OR OLD.status<>'SUBMITTED'
   OR NEW.status NOT IN('ACCEPTED','DECLINED','WAITLISTED') OR NEW.reviewed_by_principal_id IS NULL OR NEW.reviewed_at IS NULL
   OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'IMMUTABLE_TESTING_REGISTRATION_INTEREST' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER testing_registration_interest_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.testing_registration_interests
FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_registration_interest();
CREATE TRIGGER testing_registration_interest_no_truncate BEFORE TRUNCATE ON hon.testing_registration_interests
FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_testing_registration_interest();

CREATE FUNCTION hon.guard_testing_registration_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_TESTING_REGISTRATION_RECEIPT' USING ERRCODE='42501'; END $$;
CREATE TRIGGER testing_registration_receipt_guard BEFORE UPDATE OR DELETE ON hon.testing_registration_command_receipts
FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_registration_receipt();
CREATE TRIGGER testing_registration_receipt_no_truncate BEFORE TRUNCATE ON hon.testing_registration_command_receipts
FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_testing_registration_receipt();

CREATE FUNCTION hon.require_parent_testing_registration_actor(p_subject text,p_family uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
BEGIN
 IF p_subject IS NULL OR length(btrim(p_subject)) NOT BETWEEN 1 AND 200 OR p_family IS NULL
  OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'PARENT_TESTING_REGISTRATION_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.resolve_parent_family_scope(p_subject,hon.current_school_id()) s
   WHERE s.principal_id=actor AND s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id() AND s.family_id=p_family) THEN
  RAISE EXCEPTION 'PARENT_TESTING_REGISTRATION_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM hon.organizations WHERE id=hon.current_organization_id() AND status='ACTIVE' FOR UPDATE;
 PERFORM 1 FROM hon.schools WHERE id=hon.current_school_id() AND organization_id=hon.current_organization_id() AND status='ACTIVE' FOR UPDATE;
 PERFORM 1 FROM hon.users WHERE external_subject=p_subject FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor AND principal_type='HUMAN_USER' AND is_active FOR UPDATE;
 PERFORM 1 FROM hon.family_access_grants WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND family_id=p_family AND principal_id=actor ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.families WHERE id=p_family AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND status='ACTIVE' FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM hon.resolve_parent_family_scope(p_subject,hon.current_school_id()) s
   WHERE s.principal_id=actor AND s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id() AND s.family_id=p_family) THEN
  RAISE EXCEPTION 'PARENT_TESTING_REGISTRATION_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 RETURN actor;
END $$;

CREATE FUNCTION hon.require_staff_testing_registration_reviewer(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
 org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF p_subject IS NULL OR length(btrim(p_subject)) NOT BETWEEN 1 AND 200
  OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
  OR NOT hon.principal_has_school_permission(actor,org,school,'testing.registration.review') THEN
  RAISE EXCEPTION 'TESTING_REGISTRATION_REVIEW_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor AND principal_type='HUMAN_USER' AND is_active FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 IF NOT hon.principal_has_school_permission(actor,org,school,'testing.registration.review') THEN
  RAISE EXCEPTION 'TESTING_REGISTRATION_REVIEW_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 RETURN actor;
END $$;

-- Staff UI has no caller-selected school. Return at most two reviewed scopes so
-- the API can fail closed whenever the verified human has ambiguous authority.
CREATE FUNCTION hon.resolve_testing_registration_review_scopes(p_subject text)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT DISTINCT p.id,g.organization_id,g.school_id
 FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
 JOIN hon.principal_role_grants g ON g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id AND (r.management_school_id IS NULL OR r.management_school_id=g.school_id)
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='testing.registration.review'
 JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id AND s.status='ACTIVE'
 JOIN hon.organizations o ON o.id=s.organization_id AND o.status='ACTIVE'
 WHERE u.external_subject=p_subject AND length(btrim(p_subject)) BETWEEN 1 AND 200
  AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
 ORDER BY g.organization_id,g.school_id LIMIT 2;
$$;

CREATE FUNCTION hon.read_parent_testing_registration_view(p_subject text,p_family uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE children jsonb; events jsonb; registrations jsonb;
BEGIN
 PERFORM hon.require_parent_testing_registration_actor(p_subject,p_family);
 SELECT coalesce(jsonb_agg(jsonb_build_object('studentProfileId',profile.id,'displayName',left(regexp_replace(concat_ws(' ',person.given_name,person.family_name),'[[:cntrl:]]','','g'),400)) ORDER BY person.given_name,person.family_name,profile.id),'[]') INTO children
 FROM hon.student_profiles profile JOIN hon.people person ON person.id=profile.person_id AND person.organization_id=profile.organization_id AND person.school_id=profile.school_id
 JOIN hon.family_members member ON member.family_id=p_family AND member.person_id=profile.person_id AND member.organization_id=profile.organization_id AND member.school_id=profile.school_id AND member.member_role='STUDENT'
 WHERE profile.organization_id=hon.current_organization_id() AND profile.school_id=hon.current_school_id() AND profile.primary_family_id=p_family AND profile.status='ACTIVE';
 SELECT coalesce(jsonb_agg(item ORDER BY starts_at,id),'[]') INTO events FROM (
  SELECT e.starts_at,e.id,jsonb_build_object('testingEventId',e.id,'name',left(regexp_replace(e.name,'[[:cntrl:]]','','g'),200),'startsAt',e.starts_at,'endsAt',e.ends_at) item
  FROM hon.testing_events e WHERE e.organization_id=hon.current_organization_id() AND e.school_id=hon.current_school_id() AND e.status='OPEN'
   AND e.starts_at>clock_timestamp() AND (e.registration_opens_at IS NULL OR e.registration_opens_at<=clock_timestamp())
   AND (e.registration_closes_at IS NULL OR e.registration_closes_at>clock_timestamp()) ORDER BY e.starts_at,e.id LIMIT 50
 ) safe;
 SELECT coalesce(jsonb_agg(item ORDER BY submitted_at DESC),'[]') INTO registrations FROM (
  SELECT r.created_at submitted_at,jsonb_build_object('childName',left(regexp_replace(concat_ws(' ',p.given_name,p.family_name),'[[:cntrl:]]','','g'),400),'eventName',left(regexp_replace(e.name,'[[:cntrl:]]','','g'),200),'startsAt',e.starts_at,'status',r.status::text,'submittedAt',r.created_at,'reviewedAt',r.reviewed_at) item
  FROM hon.testing_registration_interests r JOIN hon.student_profiles profile ON profile.id=r.student_profile_id AND profile.organization_id=r.organization_id AND profile.school_id=r.school_id AND profile.primary_family_id=p_family
  JOIN hon.people p ON p.id=profile.person_id AND p.organization_id=profile.organization_id AND p.school_id=profile.school_id
  JOIN hon.family_members m ON m.family_id=p_family AND m.person_id=profile.person_id AND m.organization_id=profile.organization_id AND m.school_id=profile.school_id AND m.member_role='STUDENT'
  JOIN hon.testing_events e ON e.id=r.testing_event_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.organization_id=hon.current_organization_id() AND r.school_id=hon.current_school_id() AND r.family_id=p_family ORDER BY r.created_at DESC,r.id LIMIT 100
 ) safe;
 PERFORM hon.require_parent_testing_registration_actor(p_subject,p_family);
 RETURN jsonb_build_object('children',children,'events',events,'registrations',registrations);
END $$;

CREATE FUNCTION hon.mutate_parent_testing_registration_interest(p_subject text,p_family uuid,p_event uuid,p_student uuid,p_note text,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior hon.testing_registration_command_receipts%ROWTYPE;
 row hon.testing_registration_interests%ROWTYPE; fp text; result jsonb;
BEGIN
 IF p_event IS NULL OR p_student IS NULL OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key~'[[:cntrl:]]'
  OR (p_note IS NOT NULL AND (length(btrim(p_note)) NOT BETWEEN 1 AND 500 OR btrim(p_note)<>p_note OR p_note~'[[:cntrl:]]')) THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
 END IF;
 actor:=hon.require_parent_testing_registration_actor(p_subject,p_family);
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':'||school::text||':'||actor::text||':'||p_key,0));
 fp:=encode(sha256(convert_to(jsonb_build_object('familyId',p_family,'testingEventId',p_event,'studentProfileId',p_student,'note',p_note)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM hon.testing_registration_command_receipts WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF; RETURN jsonb_build_object('record',prior.response,'replayed',true); END IF;
 PERFORM 1 FROM hon.testing_events WHERE id=p_event AND organization_id=org AND school_id=school AND status='OPEN' AND starts_at>clock_timestamp()
  AND (registration_opens_at IS NULL OR registration_opens_at<=clock_timestamp()) AND (registration_closes_at IS NULL OR registration_closes_at>clock_timestamp()) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TESTING_EVENT_NOT_OPEN' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM hon.student_profiles profile JOIN hon.family_members member ON member.family_id=p_family AND member.person_id=profile.person_id AND member.organization_id=profile.organization_id AND member.school_id=profile.school_id AND member.member_role='STUDENT'
 WHERE profile.id=p_student AND profile.organization_id=org AND profile.school_id=school AND profile.primary_family_id=p_family AND profile.status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FAMILY_STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_event::text||':'||p_student::text,0));
 IF EXISTS(SELECT 1 FROM hon.testing_registration_interests WHERE testing_event_id=p_event AND student_profile_id=p_student) THEN RAISE EXCEPTION 'TESTING_INTEREST_ALREADY_SUBMITTED' USING ERRCODE='23505'; END IF;
 actor:=hon.require_parent_testing_registration_actor(p_subject,p_family);
 INSERT INTO hon.testing_registration_interests(organization_id,school_id,testing_event_id,family_id,student_profile_id,requested_by_principal_id,parent_note)
 VALUES(org,school,p_event,p_family,p_student,actor,p_note) RETURNING * INTO row;
 result:=jsonb_build_object('status','SUBMITTED','submittedAt',row.created_at,'version',row.version);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
 VALUES(org,school,actor,'HUMAN_UI','testing.registration.interest.submit','TESTING_REGISTRATION_INTEREST',row.id,NULL,jsonb_build_object('status',row.status::text,'version',row.version),'SUCCEEDED',p_request,p_correlation,NULL,clock_timestamp());
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'testing.registration.interest.submitted',1,'TESTING_REGISTRATION_INTEREST',row.id,row.version,p_correlation,p_request,jsonb_build_object('id',row.id,'status',row.status::text,'version',row.version,'internalOnly',true));
 INSERT INTO hon.testing_registration_command_receipts(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

CREATE FUNCTION hon.read_staff_testing_registrations(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
 PERFORM hon.require_staff_testing_registration_reviewer(p_subject);
 SELECT jsonb_build_object('registrations',coalesce(jsonb_agg(item ORDER BY submitted_at DESC,id),'[]'),'limited',count(*)>100) INTO result FROM (
  SELECT r.created_at submitted_at,r.id,jsonb_build_object('id',r.id,'childName',left(regexp_replace(concat_ws(' ',p.given_name,p.family_name),'[[:cntrl:]]','','g'),400),'eventName',left(regexp_replace(e.name,'[[:cntrl:]]','','g'),200),'startsAt',e.starts_at,'status',r.status::text,'parentNote',r.parent_note,'submittedAt',r.created_at,'reviewedAt',r.reviewed_at,'version',r.version) item
  FROM hon.testing_registration_interests r JOIN hon.student_profiles profile ON profile.id=r.student_profile_id AND profile.organization_id=r.organization_id AND profile.school_id=r.school_id
  JOIN hon.people p ON p.id=profile.person_id AND p.organization_id=profile.organization_id AND p.school_id=profile.school_id
  JOIN hon.testing_events e ON e.id=r.testing_event_id AND e.organization_id=r.organization_id AND e.school_id=r.school_id
  WHERE r.organization_id=hon.current_organization_id() AND r.school_id=hon.current_school_id() ORDER BY r.created_at DESC,r.id LIMIT 101
 ) queued;
 -- The projection returns no family, guardian, reviewer identity, curriculum/rank,
 -- candidate, eligibility, payment, roster, communication, or outbox data.
 IF jsonb_array_length(result->'registrations')>100 THEN result:=jsonb_set(result,'{registrations}',(SELECT jsonb_agg(v) FROM jsonb_array_elements(result->'registrations') WITH ORDINALITY x(v,n) WHERE n<=100)); END IF;
 PERFORM hon.require_staff_testing_registration_reviewer(p_subject);
 RETURN result;
END $$;

CREATE FUNCTION hon.mutate_staff_testing_registration_decision(p_subject text,p_interest uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior hon.testing_registration_command_receipts%ROWTYPE;
 row hon.testing_registration_interests%ROWTYPE; fp text; decision hon.testing_registration_interest_status; expected integer; result jsonb;
BEGIN
 IF p_interest IS NULL OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key~'[[:cntrl:]]'
  OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('decision','expectedVersion'))
  OR jsonb_typeof(p_input->'decision') IS DISTINCT FROM 'string' OR p_input->>'decision' NOT IN('ACCEPT','DECLINE','WAITLIST')
  OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 expected:=(p_input->>'expectedVersion')::integer; decision:=CASE p_input->>'decision' WHEN 'ACCEPT' THEN 'ACCEPTED'::hon.testing_registration_interest_status WHEN 'DECLINE' THEN 'DECLINED'::hon.testing_registration_interest_status ELSE 'WAITLISTED'::hon.testing_registration_interest_status END;
 actor:=hon.require_staff_testing_registration_reviewer(p_subject);
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':'||school::text||':'||actor::text||':'||p_key,0));
 fp:=encode(sha256(convert_to(jsonb_build_object('interestId',p_interest,'decision',p_input->>'decision','expectedVersion',expected)::text,'UTF8')),'hex');
 SELECT * INTO prior FROM hon.testing_registration_command_receipts WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF; RETURN jsonb_build_object('record',prior.response,'replayed',true); END IF;
 SELECT * INTO row FROM hon.testing_registration_interests WHERE id=p_interest AND organization_id=org AND school_id=school FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TESTING_INTEREST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF row.status<>'SUBMITTED' THEN RAISE EXCEPTION 'TESTING_INTEREST_NOT_SUBMITTED' USING ERRCODE='40001'; END IF;
 IF row.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 actor:=hon.require_staff_testing_registration_reviewer(p_subject);
 UPDATE hon.testing_registration_interests SET status=decision,reviewed_by_principal_id=actor,reviewed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
 WHERE id=row.id AND status='SUBMITTED' AND version=expected RETURNING * INTO row;
 IF NOT FOUND THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 result:=jsonb_build_object('id',row.id,'status',row.status::text,'reviewedAt',row.reviewed_at,'version',row.version);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
 VALUES(org,school,actor,'HUMAN_UI','testing.registration.interest.review','TESTING_REGISTRATION_INTEREST',row.id,jsonb_build_object('status','SUBMITTED','version',expected),jsonb_build_object('status',row.status::text,'version',row.version),'SUCCEEDED',p_request,p_correlation,NULL,clock_timestamp());
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'testing.registration.interest.reviewed',1,'TESTING_REGISTRATION_INTEREST',row.id,row.version,p_correlation,p_request,jsonb_build_object('id',row.id,'status',row.status::text,'version',row.version,'internalOnly',true));
 INSERT INTO hon.testing_registration_command_receipts(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

REVOKE ALL ON TABLE hon.testing_registration_interests,hon.testing_registration_command_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_testing_registration_interest(),hon.guard_testing_registration_receipt(),hon.require_parent_testing_registration_actor(text,uuid),hon.require_staff_testing_registration_reviewer(text),hon.resolve_testing_registration_review_scopes(text),hon.read_parent_testing_registration_view(text,uuid),hon.mutate_parent_testing_registration_interest(text,uuid,uuid,uuid,text,text,uuid,uuid),hon.read_staff_testing_registrations(text),hon.mutate_staff_testing_registration_decision(text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role','hon_runtime') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.testing_registration_interests,hon.testing_registration_command_receipts FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_testing_registration_interest(),hon.guard_testing_registration_receipt(),hon.require_parent_testing_registration_actor(text,uuid),hon.require_staff_testing_registration_reviewer(text),hon.resolve_testing_registration_review_scopes(text),hon.read_parent_testing_registration_view(text,uuid),hon.mutate_parent_testing_registration_interest(text,uuid,uuid,uuid,text,text,uuid,uuid),hon.read_staff_testing_registrations(text),hon.mutate_staff_testing_registration_decision(text,uuid,jsonb,text,uuid,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_testing_registration_review_scopes(text),hon.read_parent_testing_registration_view(text,uuid),hon.mutate_parent_testing_registration_interest(text,uuid,uuid,uuid,text,text,uuid,uuid),hon.read_staff_testing_registrations(text),hon.mutate_staff_testing_registration_decision(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
