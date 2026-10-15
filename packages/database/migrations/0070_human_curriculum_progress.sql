BEGIN;

-- Trusted owner is required for the fixed, explicitly scoped private boundaries.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Curriculum progress requires a trusted migration owner'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
 VALUES('curriculum.progress.record','Explicit human curriculum enrollment, rank placement and requirement observations',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT id,organization_id,'curriculum.progress.record' FROM hon.roles WHERE is_system_role AND code='OWNER' ON CONFLICT DO NOTHING;

-- A rank must belong to the enrollment curriculum, not merely the same school.
ALTER TABLE hon.curriculum_ranks ADD UNIQUE(id,curriculum_id,organization_id,school_id);
ALTER TABLE hon.student_curriculum_enrollments ADD UNIQUE(id,curriculum_id,organization_id,school_id);
ALTER TABLE hon.student_curriculum_enrollments ADD CONSTRAINT enrollment_rank_curriculum_fk
 FOREIGN KEY(current_rank_id,curriculum_id,organization_id,school_id)
 REFERENCES hon.curriculum_ranks(id,curriculum_id,organization_id,school_id) ON DELETE RESTRICT;

CREATE TABLE hon.curriculum_requirement_versions (
 requirement_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 curriculum_rank_id uuid NOT NULL, version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 requirement_code text NOT NULL, requirement_kind text NOT NULL, definition jsonb NOT NULL,
 is_required boolean NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(requirement_id,version), UNIQUE(requirement_id,version,organization_id,school_id,curriculum_rank_id),
 FOREIGN KEY(requirement_id,organization_id,school_id) REFERENCES hon.curriculum_requirements(id,organization_id,school_id),
 FOREIGN KEY(curriculum_rank_id,organization_id,school_id) REFERENCES hon.curriculum_ranks(id,organization_id,school_id)
);
INSERT INTO hon.curriculum_requirement_versions(requirement_id,organization_id,school_id,curriculum_rank_id,version,requirement_code,requirement_kind,definition,is_required,recorded_at)
 SELECT id,organization_id,school_id,curriculum_rank_id,version,requirement_code,requirement_kind,definition,is_required,updated_at FROM hon.curriculum_requirements;
CREATE TABLE hon.curriculum_enrollment_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 enrollment_id uuid NOT NULL, curriculum_id uuid NOT NULL, current_rank_id uuid, enrollment_version integer NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), source text NOT NULL CHECK(source='HUMAN_UI'),
 operation text NOT NULL CHECK(operation IN('ENROLL','SET_RANK')), request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(enrollment_id,curriculum_id,organization_id,school_id) REFERENCES hon.student_curriculum_enrollments(id,curriculum_id,organization_id,school_id),
 FOREIGN KEY(current_rank_id,curriculum_id,organization_id,school_id) REFERENCES hon.curriculum_ranks(id,curriculum_id,organization_id,school_id),
 UNIQUE(enrollment_id,enrollment_version)
);
CREATE TABLE hon.curriculum_progress_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 enrollment_id uuid NOT NULL, curriculum_id uuid NOT NULL, curriculum_rank_id uuid NOT NULL,
 requirement_id uuid NOT NULL, requirement_version integer NOT NULL, enrollment_version integer NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 status text NOT NULL CHECK(status IN('NOT_STARTED','PRACTICING','DEMONSTRATED','MET','NOT_MET')),
 instructor_note text CHECK(length(instructor_note)<=2000), actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
 source text NOT NULL CHECK(source='HUMAN_UI'), request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(enrollment_id,curriculum_id,organization_id,school_id) REFERENCES hon.student_curriculum_enrollments(id,curriculum_id,organization_id,school_id),
 FOREIGN KEY(curriculum_rank_id,curriculum_id,organization_id,school_id) REFERENCES hon.curriculum_ranks(id,curriculum_id,organization_id,school_id),
 FOREIGN KEY(requirement_id,requirement_version,organization_id,school_id,curriculum_rank_id) REFERENCES hon.curriculum_requirement_versions(requirement_id,version,organization_id,school_id,curriculum_rank_id),
 UNIQUE(enrollment_id,requirement_id,version)
);
CREATE INDEX curriculum_progress_latest_idx ON hon.curriculum_progress_observations(enrollment_id,requirement_id,version DESC);
CREATE TABLE hon.curriculum_command_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
 idempotency_key text NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
ALTER TABLE hon.curriculum_requirement_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_requirement_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_enrollment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_enrollment_history FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_progress_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_progress_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_command_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_command_requests FORCE ROW LEVEL SECURITY;
-- Private history: no permissive policy, even with a mistakenly added table grant.

CREATE FUNCTION hon.guard_curriculum_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_CURRICULUM_HISTORY' USING ERRCODE='42501'; END $$;
CREATE TRIGGER requirement_versions_immutable BEFORE UPDATE OR DELETE ON hon.curriculum_requirement_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_history();
CREATE TRIGGER enrollment_history_immutable BEFORE UPDATE OR DELETE ON hon.curriculum_enrollment_history FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_history();
CREATE TRIGGER progress_observations_immutable BEFORE UPDATE OR DELETE ON hon.curriculum_progress_observations FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_history();
CREATE TRIGGER curriculum_requests_immutable BEFORE UPDATE OR DELETE ON hon.curriculum_command_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_history();
CREATE TRIGGER requirement_versions_no_truncate BEFORE TRUNCATE ON hon.curriculum_requirement_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_history();
CREATE TRIGGER enrollment_history_no_truncate BEFORE TRUNCATE ON hon.curriculum_enrollment_history FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_history();
CREATE TRIGGER observations_no_truncate BEFORE TRUNCATE ON hon.curriculum_progress_observations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_history();
CREATE TRIGGER requests_no_truncate BEFORE TRUNCATE ON hon.curriculum_command_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_history();
CREATE FUNCTION hon.guard_curriculum_requirement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_REQUIREMENT_IDENTITY' USING ERRCODE='42501'; END IF;
 IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.curriculum_rank_id<>OLD.curriculum_rank_id
  OR NEW.requirement_code<>OLD.requirement_code OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'IMMUTABLE_REQUIREMENT_IDENTITY' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER requirement_identity_immutable BEFORE UPDATE OR DELETE ON hon.curriculum_requirements FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_requirement();
CREATE FUNCTION hon.snapshot_curriculum_requirement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 INSERT INTO hon.curriculum_requirement_versions(requirement_id,organization_id,school_id,curriculum_rank_id,version,requirement_code,requirement_kind,definition,is_required)
 VALUES(NEW.id,NEW.organization_id,NEW.school_id,NEW.curriculum_rank_id,NEW.version,NEW.requirement_code,NEW.requirement_kind,NEW.definition,NEW.is_required);
 RETURN NEW;
END $$;
CREATE TRIGGER requirement_version_snapshot AFTER INSERT OR UPDATE ON hon.curriculum_requirements FOR EACH ROW EXECUTE FUNCTION hon.snapshot_curriculum_requirement();
CREATE FUNCTION hon.guard_curriculum_enrollment_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.student_profile_id<>OLD.student_profile_id OR NEW.curriculum_id<>OLD.curriculum_id THEN
  RAISE EXCEPTION 'IMMUTABLE_ENROLLMENT_IDENTITY' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER enrollment_identity_immutable BEFORE UPDATE ON hon.student_curriculum_enrollments FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_enrollment_identity();

CREATE FUNCTION hon.require_curriculum_actor(p_subject text,p_permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
 IF p_permission NOT IN('curriculum.manage','curriculum.progress.record') OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI' OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
 WHERE u.external_subject=p_subject AND p.principal_type='HUMAN_USER' AND p.is_active AND p.id::text=current_setting('app.hon_principal_id',true)
 AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active AND x.principal_type='HUMAN_USER')=1;
 IF actor IS NULL OR NOT EXISTS(
  SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
  JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
  JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id JOIN hon.organizations o ON o.id=s.organization_id
  WHERE g.principal_id=actor AND g.organization_id=hon.current_organization_id() AND g.school_id=hon.current_school_id()
   AND rp.permission_code=p_permission AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp()
   AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()) AND s.status='ACTIVE' AND o.status='ACTIVE'
   AND (r.management_school_id IS NULL OR r.management_school_id=s.id)
 ) THEN RAISE EXCEPTION 'CURRICULUM_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=hon.current_organization_id()
  AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp()
  AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'ENTITLEMENT_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;

-- Closed typed operations, not a generic SQL/table mutation endpoint.
CREATE FUNCTION hon.mutate_curriculum_progress(p_subject text,p_operation text,p_curriculum uuid,p_target uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text;
 req hon.curriculum_requirements%ROWTYPE; enrollment hon.student_curriculum_enrollments%ROWTYPE; observation hon.curriculum_progress_observations%ROWTYPE;
 previous hon.curriculum_command_requests%ROWTYPE; fp text; result jsonb; prior jsonb; payload jsonb; rank uuid; student uuid; progress_version integer; expected integer; action text; entity uuid; aggregate text;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('REQUIREMENT_CREATE','REQUIREMENT_UPDATE','ENROLL','SET_RANK','OBSERVE') OR p_curriculum IS NULL
  OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
  OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
  RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 permission:=CASE WHEN p_operation LIKE 'REQUIREMENT_%' THEN 'curriculum.manage' ELSE 'curriculum.progress.record' END;
 -- IAM serialization order; revalidate live authority after every wait, before replay.
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CURRICULUM_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CURRICULUM_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_curriculum_actor(p_subject,permission);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 -- organization_id is the entitlement primary key; no surrogate id exists.
 -- Lock the commercial row while live authority and expiry are rechecked.
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 actor:=hon.require_curriculum_actor(p_subject,permission);
 IF NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE'
  AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'ENTITLEMENT_REQUIRED' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.curricula WHERE id=p_curriculum AND organization_id=org AND school_id=school FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CURRICULUM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'curriculumId',p_curriculum,'targetId',p_target,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.curriculum_command_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('record',previous.response,'replayed',true);
 END IF;
 IF p_operation IN('REQUIREMENT_CREATE','REQUIREMENT_UPDATE') THEN
  IF p_target IS NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('code','kind','definition','required','expectedVersion'))
   OR jsonb_typeof(p_input->'code') IS DISTINCT FROM 'string' OR (p_input->>'code') !~ '^[A-Z][A-Z0-9_]{0,63}$'
   OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string' OR (p_input->>'kind') NOT IN('TECHNIQUE','KNOWLEDGE','CHARACTER','ATTENDANCE','PRACTICE','INSTRUCTOR_JUDGMENT','CUSTOM')
   OR jsonb_typeof(p_input->'required') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'definition') IS DISTINCT FROM 'object'
   OR octet_length((p_input->'definition')::text)>4000 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input->'definition') k WHERE k NOT IN('label','description'))
   OR jsonb_typeof(p_input->'definition'->'label') IS DISTINCT FROM 'string' OR length(btrim(p_input->'definition'->>'label')) NOT BETWEEN 1 AND 160
   OR p_input->'definition'->>'label' ~ '[[:cntrl:]]'
   OR (p_input->'definition' ? 'description' AND (jsonb_typeof(p_input->'definition'->'description') IS DISTINCT FROM 'string' OR length(p_input->'definition'->>'description')>2000)) THEN
   RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_operation='REQUIREMENT_CREATE' THEN
   IF p_input ? 'expectedVersion' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   rank:=p_target;
  ELSE
   SELECT * INTO req FROM hon.curriculum_requirements WHERE id=p_target AND organization_id=org AND school_id=school FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'REQUIREMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
   rank:=req.curriculum_rank_id; prior:=jsonb_build_object('version',req.version);
   IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   IF req.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   IF req.requirement_code<>p_input->>'code' THEN RAISE EXCEPTION 'IMMUTABLE_REQUIREMENT_CODE' USING ERRCODE='22023'; END IF;
  END IF;
  PERFORM 1 FROM hon.curriculum_ranks WHERE id=rank AND curriculum_id=p_curriculum AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_RANK_CURRICULUM' USING ERRCODE='22023'; END IF;
  actor:=hon.require_curriculum_actor(p_subject,permission);
  IF p_operation='REQUIREMENT_CREATE' THEN
   INSERT INTO hon.curriculum_requirements(organization_id,school_id,curriculum_rank_id,requirement_code,requirement_kind,definition,is_required)
   VALUES(org,school,rank,p_input->>'code',p_input->>'kind',p_input->'definition',(p_input->>'required')::boolean) RETURNING * INTO req;
  ELSE
   UPDATE hon.curriculum_requirements SET requirement_kind=p_input->>'kind',definition=p_input->'definition',is_required=(p_input->>'required')::boolean,version=version+1,updated_at=clock_timestamp()
   WHERE id=req.id RETURNING * INTO req;
  END IF;
  result:=jsonb_build_object('id',req.id,'rankId',rank,'code',req.requirement_code,'kind',req.requirement_kind,'definition',req.definition,'required',req.is_required,'version',req.version);
  entity:=req.id; aggregate:='CURRICULUM_REQUIREMENT'; action:='curriculum.requirement.'||CASE WHEN p_operation='REQUIREMENT_CREATE' THEN 'create' ELSE 'update' END;
 ELSE
  IF p_operation='ENROLL' THEN
   IF p_target IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('studentProfileId','currentRankId')) OR NOT(p_input ? 'currentRankId') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   IF jsonb_typeof(p_input->'studentProfileId') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   student:=(p_input->>'studentProfileId')::uuid;
   PERFORM 1 FROM hon.student_profiles WHERE id=student AND organization_id=org AND school_id=school AND status='ACTIVE' FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  ELSE
   SELECT * INTO enrollment FROM hon.student_curriculum_enrollments WHERE id=p_target AND curriculum_id=p_curriculum AND organization_id=org AND school_id=school FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'ENROLLMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
   PERFORM 1 FROM hon.student_profiles WHERE id=enrollment.student_profile_id AND organization_id=org AND school_id=school AND status='ACTIVE' FOR UPDATE;
   IF NOT FOUND OR enrollment.status<>'ACTIVE' THEN RAISE EXCEPTION 'INACTIVE_ENROLLMENT' USING ERRCODE='22023'; END IF;
   IF jsonb_typeof(p_input->'expectedEnrollmentVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedEnrollmentVersion') !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   IF enrollment.version<>(p_input->>'expectedEnrollmentVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  END IF;
  IF p_operation IN('ENROLL','SET_RANK') THEN
   IF p_operation='SET_RANK' AND (EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('currentRankId','expectedEnrollmentVersion')) OR NOT(p_input ? 'currentRankId')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   IF jsonb_typeof(p_input->'currentRankId') NOT IN('null','string') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   rank:=(p_input->>'currentRankId')::uuid;
   IF rank IS NOT NULL THEN
    PERFORM 1 FROM hon.curriculum_ranks WHERE id=rank AND curriculum_id=p_curriculum AND organization_id=org AND school_id=school FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_RANK_CURRICULUM' USING ERRCODE='22023'; END IF;
   END IF;
   prior:=CASE WHEN p_operation='SET_RANK' THEN jsonb_build_object('currentRankId',enrollment.current_rank_id,'version',enrollment.version) ELSE NULL END;
   actor:=hon.require_curriculum_actor(p_subject,permission);
   IF p_operation='ENROLL' THEN
    INSERT INTO hon.student_curriculum_enrollments(organization_id,school_id,student_profile_id,curriculum_id,current_rank_id)
    VALUES(org,school,student,p_curriculum,rank) RETURNING * INTO enrollment;
   ELSE
    UPDATE hon.student_curriculum_enrollments SET current_rank_id=rank,version=version+1,updated_at=clock_timestamp() WHERE id=enrollment.id RETURNING * INTO enrollment;
   END IF;
   INSERT INTO hon.curriculum_enrollment_history(organization_id,school_id,enrollment_id,curriculum_id,current_rank_id,enrollment_version,actor_principal_id,source,operation,request_id)
   VALUES(org,school,enrollment.id,p_curriculum,rank,enrollment.version,actor,'HUMAN_UI',p_operation,p_request);
   result:=jsonb_build_object('id',enrollment.id,'studentProfileId',enrollment.student_profile_id,'curriculumId',p_curriculum,'currentRankId',rank,'version',enrollment.version,'status',enrollment.status,'enrolledAt',enrollment.enrolled_at);
   entity:=enrollment.id; aggregate:='STUDENT_CURRICULUM_ENROLLMENT'; action:='curriculum.enrollment.'||CASE WHEN p_operation='ENROLL' THEN 'enroll' ELSE 'set_rank' END;
  ELSE
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('requirementId','expectedEnrollmentVersion','expectedRequirementVersion','expectedProgressVersion','status','instructorNote'))
    OR jsonb_typeof(p_input->'requirementId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR (p_input->>'status') NOT IN('NOT_STARTED','PRACTICING','DEMONSTRATED','MET','NOT_MET')
    OR jsonb_typeof(p_input->'expectedRequirementVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedRequirementVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'expectedProgressVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedProgressVersion') !~ '^(0|[1-9][0-9]{0,8})$'
    OR (p_input ? 'instructorNote' AND (jsonb_typeof(p_input->'instructorNote') IS DISTINCT FROM 'string' OR length(p_input->>'instructorNote')>2000)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   SELECT * INTO req FROM hon.curriculum_requirements WHERE id=(p_input->>'requirementId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
   IF NOT FOUND OR req.curriculum_rank_id IS DISTINCT FROM enrollment.current_rank_id THEN RAISE EXCEPTION 'INVALID_REQUIREMENT_ENROLLMENT' USING ERRCODE='22023'; END IF;
   PERFORM 1 FROM hon.curriculum_ranks WHERE id=req.curriculum_rank_id AND curriculum_id=p_curriculum AND organization_id=org AND school_id=school FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_RANK_CURRICULUM' USING ERRCODE='22023'; END IF;
   IF req.version<>(p_input->>'expectedRequirementVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   SELECT coalesce(max(version),0) INTO progress_version FROM hon.curriculum_progress_observations WHERE enrollment_id=enrollment.id AND requirement_id=req.id;
   IF progress_version<>(p_input->>'expectedProgressVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   prior:=jsonb_build_object('version',progress_version);
   INSERT INTO hon.curriculum_progress_observations(organization_id,school_id,enrollment_id,curriculum_id,curriculum_rank_id,requirement_id,requirement_version,enrollment_version,version,status,instructor_note,actor_principal_id,source,request_id)
   VALUES(org,school,enrollment.id,p_curriculum,req.curriculum_rank_id,req.id,req.version,enrollment.version,progress_version+1,p_input->>'status',p_input->>'instructorNote',actor,'HUMAN_UI',p_request) RETURNING * INTO observation;
   -- This branch NEVER updates enrollment, candidate, event, or promotion state.
   result:=jsonb_build_object('id',observation.id,'enrollmentId',enrollment.id,'requirementId',req.id,'requirementVersion',req.version,'enrollmentVersion',enrollment.version,'status',observation.status,'version',observation.version,'recordedAt',observation.recorded_at);
   entity:=observation.id; aggregate:='CURRICULUM_PROGRESS_OBSERVATION'; action:='curriculum.progress.record';
  END IF;
 END IF;
 payload:=jsonb_build_object('id',entity,'version',(result->>'version')::integer,'internalOnly',true);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI',action,aggregate,entity,prior,result,'SUCCEEDED',p_request,p_correlation);
 -- Distinct inert evidence namespace; no consumer, testing or promotion trigger.
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'curriculum.human_recorded',1,aggregate,entity,(result->>'version')::integer,p_correlation,p_request,payload);
 INSERT INTO hon.curriculum_command_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- Parent safe current projection. NULL means no current human observation, never
-- an inferred NOT_STARTED/MET, readiness guarantee, or promotion decision.
CREATE FUNCTION hon.read_parent_curriculum_progress(p_subject text,p_family uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR NOT EXISTS(
  SELECT 1 FROM hon.resolve_parent_family_scope(p_subject,hon.current_school_id()) s
  WHERE s.family_id=p_family AND s.organization_id=hon.current_organization_id() AND s.principal_id::text=current_setting('app.hon_principal_id',true)
 ) THEN RAISE EXCEPTION 'FAMILY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 -- Hold live identity/topology/grants through the parent transaction. Expiry
 -- still uses the clock after every wait and the service rechecks before return.
 PERFORM 1 FROM hon.organizations WHERE id=hon.current_organization_id() FOR SHARE;
 PERFORM 1 FROM hon.schools WHERE id=hon.current_school_id() AND organization_id=hon.current_organization_id() FOR SHARE;
 PERFORM 1 FROM hon.users WHERE external_subject=p_subject FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id::text=current_setting('app.hon_principal_id',true) FOR SHARE;
 PERFORM 1 FROM hon.family_access_grants WHERE family_id=p_family AND organization_id=hon.current_organization_id()
  AND school_id=hon.current_school_id() AND principal_id::text=current_setting('app.hon_principal_id',true) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.families WHERE id=p_family AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR SHARE;
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR NOT EXISTS(
  SELECT 1 FROM hon.resolve_parent_family_scope(p_subject,hon.current_school_id()) s
  WHERE s.family_id=p_family AND s.organization_id=hon.current_organization_id() AND s.principal_id::text=current_setting('app.hon_principal_id',true)
 ) THEN RAISE EXCEPTION 'FAMILY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(item ORDER BY enrollment_id,code),'[]') INTO result FROM (
  SELECT e.id enrollment_id,r.requirement_code code,jsonb_build_object('enrollmentId',e.id,'requirementId',r.id,
   'label',left(regexp_replace(CASE WHEN jsonb_typeof(r.definition->'label')='string' THEN coalesce(nullif(btrim(r.definition->>'label'),''),r.requirement_code) ELSE r.requirement_code END,'[[:cntrl:]]','','g'),160),'kind',r.requirement_kind,'required',r.is_required,
   'status',o.status,'recordedAt',o.recorded_at) item
  FROM hon.student_curriculum_enrollments e
  JOIN hon.student_profiles p ON p.id=e.student_profile_id AND p.organization_id=e.organization_id AND p.school_id=e.school_id AND p.primary_family_id=p_family
  JOIN hon.family_members m ON m.family_id=p_family AND m.person_id=p.person_id AND m.organization_id=p.organization_id AND m.school_id=p.school_id AND m.member_role='STUDENT'
  JOIN hon.curriculum_ranks rank ON rank.id=e.current_rank_id AND rank.curriculum_id=e.curriculum_id AND rank.organization_id=e.organization_id AND rank.school_id=e.school_id
  JOIN hon.curriculum_requirements r ON r.curriculum_rank_id=rank.id AND r.organization_id=e.organization_id AND r.school_id=e.school_id
  LEFT JOIN LATERAL(SELECT status,recorded_at FROM hon.curriculum_progress_observations
   WHERE enrollment_id=e.id AND requirement_id=r.id AND requirement_version=r.version AND enrollment_version=e.version
   ORDER BY version DESC LIMIT 1) o ON true
  WHERE e.organization_id=hon.current_organization_id() AND e.school_id=hon.current_school_id()
 ) safe;
 RETURN result;
END $$;
REVOKE ALL ON TABLE hon.curriculum_requirement_versions,hon.curriculum_enrollment_history,hon.curriculum_progress_observations,hon.curriculum_command_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_curriculum_history(),hon.guard_curriculum_requirement(),hon.snapshot_curriculum_requirement(),hon.guard_curriculum_enrollment_identity(),hon.require_curriculum_actor(text,text),
 hon.mutate_curriculum_progress(text,text,uuid,uuid,jsonb,text,uuid,uuid),hon.read_parent_curriculum_progress(text,uuid) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.curriculum_requirements,hon.curriculum_requirement_versions,hon.curriculum_enrollment_history,hon.curriculum_progress_observations,hon.curriculum_command_requests FROM %I',role_name);
  EXECUTE format('REVOKE INSERT,DELETE ON hon.student_curriculum_enrollments FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_curriculum_history(),hon.guard_curriculum_requirement(),hon.snapshot_curriculum_requirement(),hon.guard_curriculum_enrollment_identity(),hon.require_curriculum_actor(text,text),hon.mutate_curriculum_progress(text,text,uuid,uuid,jsonb,text,uuid,uuid),hon.read_parent_curriculum_progress(text,uuid) FROM %I',role_name);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.mutate_curriculum_progress(text,text,uuid,uuid,jsonb,text,uuid,uuid),hon.read_parent_curriculum_progress(text,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
