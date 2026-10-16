BEGIN;
-- One attendance model. All weights below are nonfinancial milli-classes, never
-- membership/pass/payment credits or an instruction to advance curriculum/rank.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Attendance migration requires trusted migration owner';
 END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive)
VALUES('attendance.policy.manage','Configure human-managed program attendance progression evidence',true)
ON CONFLICT(code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT id,organization_id,'attendance.policy.manage' FROM hon.roles
WHERE is_system_role AND code IN('OWNER','ADMIN') ON CONFLICT(role_id,permission_code) DO NOTHING;

CREATE FUNCTION hon.default_attendance_categories() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_agg(jsonb_build_object('category',category,'operationalAllowed',true,
  'progressionEnabled',category IN('REGULAR_PARTICIPANT','MAKEUP_CLASS'),
  'weightMilli',CASE WHEN category IN('REGULAR_PARTICIPANT','MAKEUP_CLASS') THEN 1000 ELSE 0 END) ORDER BY ordinal)
 FROM unnest(ARRAY['REGULAR_PARTICIPANT','OBSERVER','TRIAL_STUDENT','GUEST_DROP_IN','PRIVATE_LESSON','SPECIAL_EVENT','MAKEUP_CLASS']) WITH ORDINALITY t(category,ordinal)
$$;
CREATE FUNCTION hon.valid_attendance_categories(p_categories jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE rule jsonb; seen text[]:='{}'; category text;
BEGIN
 IF jsonb_typeof(p_categories) IS DISTINCT FROM 'array' OR jsonb_array_length(p_categories)<>7 THEN RETURN false; END IF;
 FOR rule IN SELECT value FROM jsonb_array_elements(p_categories) LOOP
  IF jsonb_typeof(rule) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(rule))<>4 OR EXISTS(SELECT 1 FROM jsonb_object_keys(rule) k WHERE k NOT IN('category','operationalAllowed','progressionEnabled','weightMilli')) THEN RETURN false; END IF;
  category:=rule->>'category';
  IF category IS NULL OR category NOT IN('REGULAR_PARTICIPANT','OBSERVER','TRIAL_STUDENT','GUEST_DROP_IN','PRIVATE_LESSON','SPECIAL_EVENT','MAKEUP_CLASS') OR category=ANY(seen)
   OR jsonb_typeof(rule->'operationalAllowed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(rule->'progressionEnabled') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(rule->'weightMilli') IS DISTINCT FROM 'number' OR (rule->>'weightMilli') !~ '^[0-9]{1,5}$' THEN RETURN false; END IF;
  IF (rule->>'weightMilli')::integer>10000 THEN RETURN false; END IF;
  seen:=array_append(seen,category);
 END LOOP;
 RETURN true;
END $$;
CREATE TABLE hon.attendance_progression_policies (
 organization_id uuid NOT NULL,
 school_id uuid NOT NULL,
 program_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 categories jsonb NOT NULL CHECK(hon.valid_attendance_categories(categories)),
 configured_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 configured_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(program_id,organization_id,school_id,version),
 FOREIGN KEY(program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.attendance_policy_requests (
 organization_id uuid NOT NULL,
 school_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 fingerprint text NOT NULL,
 response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.attendance_progression_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_progression_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_policy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_policy_requests FORCE ROW LEVEL SECURITY;
CREATE TRIGGER attendance_policies_immutable BEFORE UPDATE OR DELETE ON hon.attendance_progression_policies FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER attendance_policies_no_truncate BEFORE TRUNCATE ON hon.attendance_progression_policies FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER attendance_policy_requests_immutable BEFORE UPDATE OR DELETE ON hon.attendance_policy_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER attendance_policy_requests_no_truncate BEFORE TRUNCATE ON hon.attendance_policy_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();

ALTER TABLE hon.attendance_records
 ADD COLUMN category text NOT NULL DEFAULT 'REGULAR_PARTICIPANT' CHECK(category IN('REGULAR_PARTICIPANT','OBSERVER','TRIAL_STUDENT','GUEST_DROP_IN','PRIVATE_LESSON','SPECIAL_EVENT','MAKEUP_CLASS')),
 ADD COLUMN progression_policy_version integer NOT NULL DEFAULT 0 CHECK(progression_policy_version>=0),
 ADD COLUMN progression_enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN progression_weight_milli integer NOT NULL DEFAULT 1000 CHECK(progression_weight_milli BETWEEN 0 AND 10000),
 ADD COLUMN progression_credit_milli integer NOT NULL DEFAULT 0 CHECK(progression_credit_milli BETWEEN 0 AND 10000);
-- Preserve legacy status semantics without guessing category, suitability or age.
UPDATE hon.attendance_records SET category=CASE WHEN status='MAKEUP' THEN 'MAKEUP_CLASS' ELSE 'REGULAR_PARTICIPANT' END,
 progression_credit_milli=CASE WHEN status IN('PRESENT','LATE','MAKEUP') THEN 1000 ELSE 0 END;
ALTER TABLE hon.attendance_records ADD CONSTRAINT attendance_credit_snapshot_coherent CHECK(
 progression_credit_milli=CASE WHEN progression_enabled AND status IN('PRESENT','LATE','MAKEUP') THEN progression_weight_milli ELSE 0 END);

CREATE FUNCTION hon.lock_attendance_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
 IF p_permission IS NULL OR p_permission NOT IN('attendance.record','attendance.policy.manage')
  OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ATTENDANCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ATTENDANCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.users WHERE external_subject=p_subject FOR UPDATE;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
 WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active
 AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1 FOR UPDATE OF p;
 IF actor IS NULL THEN RAISE EXCEPTION 'ATTENDANCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.family_access_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
  JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
  WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=p_permission
  AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
  AND (r.management_school_id IS NULL OR r.management_school_id=school))
  OR (p_permission='attendance.policy.manage' AND EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND organization_id=org AND school_id=school
   AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())))
  OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND tier IN('ESSENTIAL','CORE','COMPLETE')
   AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN
  RAISE EXCEPTION 'ATTENDANCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.read_attendance_policy(p_subject text,p_program uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
 PERFORM hon.lock_attendance_actor(p_subject,'attendance.policy.manage');
 PERFORM 1 FROM hon.programs WHERE id=p_program AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT jsonb_build_object('programId',program_id,'version',version,'categories',categories) INTO result
 FROM hon.attendance_progression_policies WHERE program_id=p_program AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY version DESC LIMIT 1;
 RETURN coalesce(result,jsonb_build_object('programId',p_program,'version',0,'categories',hon.default_attendance_categories()));
END $$;
CREATE FUNCTION hon.configure_attendance_policy(p_subject text,p_program uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior jsonb; result jsonb; previous hon.attendance_policy_requests%ROWTYPE; fp text; expected integer;
BEGIN
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_input))<>2
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('expectedVersion','categories'))
  OR NOT hon.valid_attendance_categories(p_input->'categories') OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number'
  OR (p_input->>'expectedVersion') !~ '^[0-9]{1,10}$' OR (p_input->>'expectedVersion')::numeric>2147483646
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
  OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_attendance_actor(p_subject,'attendance.policy.manage');
 -- Program row serializes policy versions and attendance resolution; no phantom
 -- first-version race, and live IAM is checked again after the wait.
 PERFORM 1 FROM hon.programs WHERE id=p_program AND organization_id=org AND school_id=school FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 actor:=hon.lock_attendance_actor(p_subject,'attendance.policy.manage');
 fp:=encode(sha256(convert_to(jsonb_build_object('programId',p_program,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.attendance_policy_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('policy',previous.response,'replayed',true);
 END IF;
 prior:=hon.read_attendance_policy(p_subject,p_program); expected:=(p_input->>'expectedVersion')::integer;
 IF expected<>(prior->>'version')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 INSERT INTO hon.attendance_progression_policies(organization_id,school_id,program_id,version,categories,configured_by_principal_id)
 VALUES(org,school,p_program,expected+1,p_input->'categories',actor);
 result:=jsonb_build_object('programId',p_program,'version',expected+1,'categories',p_input->'categories');
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI','attendance.policy.manage','ATTENDANCE_PROGRESSION_POLICY',p_program,prior,result,'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(gen_random_uuid(),org,school,'attendance.policy.configured',1,'ATTENDANCE_PROGRESSION_POLICY',p_program,expected+1,p_correlation,p_request,
  jsonb_build_object('programId',p_program,'version',expected+1,'categories',p_input->'categories','externalEffects','NONE'));
 INSERT INTO hon.attendance_policy_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('policy',result,'replayed',false);
END $$;

CREATE FUNCTION hon.snapshot_attendance_credit() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE session hon.class_sessions%ROWTYPE; program hon.programs%ROWTYPE; student hon.student_profiles%ROWTYPE; booking hon.class_bookings%ROWTYPE;
 rule jsonb; rules jsonb; policy_version integer; actor uuid; months integer; required_kind text;
BEGIN
 actor:=hon.lock_attendance_actor(current_setting('app.hon_external_subject',true),'attendance.record');
 IF NEW.organization_id IS DISTINCT FROM hon.current_organization_id() OR NEW.school_id IS DISTINCT FROM hon.current_school_id() THEN RAISE EXCEPTION 'ATTENDANCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.class_session_id<>OLD.class_session_id OR NEW.student_profile_id<>OLD.student_profile_id OR NEW.class_booking_id IS DISTINCT FROM OLD.class_booking_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'ATTENDANCE_IDENTITY_OR_VERSION' USING ERRCODE='40001'; END IF;
 SELECT * INTO session FROM hon.class_sessions WHERE id=NEW.class_session_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT * INTO program FROM hon.programs WHERE id=session.program_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR SHARE;
 SELECT * INTO student FROM hon.student_profiles WHERE id=NEW.student_profile_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF session.status NOT IN('SCHEDULED','COMPLETED') OR program.status NOT IN('SCHEDULED','COMPLETED') OR student.status<>'ACTIVE' THEN RAISE EXCEPTION 'ATTENDANCE_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
 IF program.minimum_age_months IS NOT NULL OR program.maximum_age_months IS NOT NULL THEN
  IF student.birth_date IS NULL OR student.birth_date>session.starts_at::date THEN RAISE EXCEPTION 'AGE_EVIDENCE_REQUIRED' USING ERRCODE='22023'; END IF;
  months:=extract(year FROM age(session.starts_at::date,student.birth_date))::integer*12+extract(month FROM age(session.starts_at::date,student.birth_date))::integer;
  IF months<coalesce(program.minimum_age_months,0) OR months>coalesce(program.maximum_age_months,2147483647) THEN RAISE EXCEPTION 'PROGRAM_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT * INTO booking FROM hon.class_bookings WHERE class_session_id=session.id AND student_profile_id=student.id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR SHARE;
 IF NEW.class_booking_id IS NOT NULL AND NEW.class_booking_id IS DISTINCT FROM booking.id THEN RAISE EXCEPTION 'BOOKING_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
 required_kind:=CASE NEW.category WHEN 'TRIAL_STUDENT' THEN 'TRIAL' WHEN 'PRIVATE_LESSON' THEN 'PRIVATE_LESSON' WHEN 'SPECIAL_EVENT' THEN 'EVENT' WHEN 'MAKEUP_CLASS' THEN 'MAKEUP' WHEN 'REGULAR_PARTICIPANT' THEN 'REGULAR' END;
 IF NEW.category IN('TRIAL_STUDENT','PRIVATE_LESSON','SPECIAL_EVENT') OR session.booking_policy='REQUIRED_BOOKING' THEN
  IF booking.id IS NULL OR booking.status NOT IN('BOOKED','CHECKED_IN') OR (required_kind IS NOT NULL AND booking.booking_kind<>required_kind) THEN RAISE EXCEPTION 'BOOKING_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
 ELSIF NEW.category='MAKEUP_CLASS' AND NEW.status<>'MAKEUP' AND (booking.id IS NULL OR booking.booking_kind<>'MAKEUP' OR booking.status NOT IN('BOOKED','CHECKED_IN')) THEN RAISE EXCEPTION 'MAKEUP_EVIDENCE_REQUIRED' USING ERRCODE='22023'; END IF;
 SELECT version,categories INTO policy_version,rules FROM hon.attendance_progression_policies WHERE program_id=program.id AND organization_id=NEW.organization_id AND school_id=NEW.school_id ORDER BY version DESC LIMIT 1;
 rules:=coalesce(rules,hon.default_attendance_categories()); policy_version:=coalesce(policy_version,0);
 SELECT value INTO rule FROM jsonb_array_elements(rules) WHERE value->>'category'=NEW.category;
 IF rule IS NULL OR NOT (rule->>'operationalAllowed')::boolean THEN RAISE EXCEPTION 'CATEGORY_NOT_ELIGIBLE' USING ERRCODE='22023'; END IF;
 -- Revalidation is after all row-lock waits and before the authoritative write.
 actor:=hon.lock_attendance_actor(current_setting('app.hon_external_subject',true),'attendance.record');
 NEW.progression_policy_version:=policy_version; NEW.progression_enabled:=(rule->>'progressionEnabled')::boolean;
 NEW.progression_weight_milli:=(rule->>'weightMilli')::integer;
 NEW.progression_credit_milli:=CASE WHEN NEW.progression_enabled AND NEW.status IN('PRESENT','LATE','MAKEUP') THEN NEW.progression_weight_milli ELSE 0 END;
 NEW.recorded_by_principal_id:=actor;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_credit_snapshot BEFORE INSERT OR UPDATE ON hon.attendance_records FOR EACH ROW EXECUTE FUNCTION hon.snapshot_attendance_credit();

REVOKE ALL ON TABLE hon.attendance_progression_policies,hon.attendance_policy_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.default_attendance_categories(),hon.valid_attendance_categories(jsonb),hon.lock_attendance_actor(text,text),hon.read_attendance_policy(text,uuid),hon.configure_attendance_policy(text,uuid,jsonb,text,uuid,uuid),hon.snapshot_attendance_credit() FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.attendance_progression_policies,hon.attendance_policy_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.default_attendance_categories(),hon.valid_attendance_categories(jsonb),hon.lock_attendance_actor(text,text),hon.read_attendance_policy(text,uuid),hon.configure_attendance_policy(text,uuid,jsonb,text,uuid,uuid),hon.snapshot_attendance_credit() FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.lock_attendance_actor(text,text),hon.read_attendance_policy(text,uuid),hon.configure_attendance_policy(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
  REVOKE UPDATE ON hon.attendance_records FROM hon_runtime;
  GRANT UPDATE(status,category,note,recorded_by_principal_id,recorded_at,version,updated_at) ON hon.attendance_records TO hon_runtime;
 END IF;
END $$;
COMMIT;
