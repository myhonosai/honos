BEGIN;

-- Optional conventional Teaching Studio. This migration never reads or mutates
-- attendance, curriculum progress observations, testing candidates/grades,
-- promotion decisions, memberships, billing, parent/family data, Action Engine,
-- AI/provider state, or external resources. A plan/assessment is authored human
-- metadata, not a completion, grade, result, readiness, or student-facing claim.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Teaching Studio requires a trusted migration owner';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('teaching.studio.read','Human staff read of bounded school Teaching Studio plans, resources, and known-student assessment history',true,true),
 ('teaching.lesson.manage','Human staff authored lesson plan draft, revision, publication, and archive metadata',true,true),
 ('teaching.resource.manage','Human staff authored bounded resource metadata revision and archive',true,true),
 ('teaching.assessment.record','Human instructor authored known-student non-progress instructional assessment record',true,true)
ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN
 ('teaching.studio.read','teaching.lesson.manage','teaching.resource.manage','teaching.assessment.record')
ON CONFLICT DO NOTHING;

CREATE FUNCTION hon.teaching_studio_text(v text, maximum integer, empty_allowed boolean DEFAULT false, assessment_safe boolean DEFAULT false)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT v IS NOT NULL AND length(v)<=maximum AND (empty_allowed OR length(v)>0) AND btrim(v)=v
   AND v !~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF<>\[\]{}=`$]'
   AND v !~* 'https?:|www\.|\y(javascript|eval|function|script|attachment|upload|iframe)\y'
   AND (NOT assessment_safe OR v !~* '\y(attendance|present|absent|late|makeup|grade|graded|pass|passed|fail|failed|promotion|promoted|testing result|test result|ready|readiness|complete|completed|automatic|auto)\y')
$$;

CREATE TABLE hon.teaching_lesson_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 UNIQUE(id,organization_id,school_id)
);
CREATE TABLE hon.teaching_lesson_plan_revisions (
 lesson_plan_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998), actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='HUMAN_UI'), request_id uuid NOT NULL,
 title text NOT NULL CHECK(hon.teaching_studio_text(title,140)), instructional_objective text NOT NULL CHECK(hon.teaching_studio_text(instructional_objective,700)),
 sections jsonb NOT NULL CHECK(jsonb_typeof(sections)='array'), duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 5 AND 480),
 status text NOT NULL CHECK(status IN('DRAFT','PUBLISHED','ARCHIVED')),
 target_curriculum_id uuid, target_rank_id uuid, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(lesson_plan_id,version), UNIQUE(lesson_plan_id,version,organization_id,school_id),
 FOREIGN KEY(lesson_plan_id,organization_id,school_id) REFERENCES hon.teaching_lesson_plans(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(target_curriculum_id,organization_id,school_id) REFERENCES hon.curricula(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(target_rank_id,organization_id,school_id) REFERENCES hon.curriculum_ranks(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.teaching_resources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 UNIQUE(id,organization_id,school_id)
);
CREATE TABLE hon.teaching_resource_revisions (
 resource_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998), actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='HUMAN_UI'), request_id uuid NOT NULL,
 title text NOT NULL CHECK(hon.teaching_studio_text(title,140)), resource_type text NOT NULL CHECK(resource_type IN('DRILL','HANDOUT','EQUIPMENT','SAFETY_GUIDE','REFERENCE')),
 description text NOT NULL CHECK(hon.teaching_studio_text(description,900,true)), status text NOT NULL CHECK(status IN('ACTIVE','ARCHIVED')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(resource_id,version), UNIQUE(resource_id,version,organization_id,school_id),
 FOREIGN KEY(resource_id,organization_id,school_id) REFERENCES hon.teaching_resources(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.instructor_assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 student_profile_id uuid NOT NULL, created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id) ON DELETE RESTRICT,
 UNIQUE(id,organization_id,school_id)
);
CREATE TABLE hon.instructor_assessment_revisions (
 assessment_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998), actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='HUMAN_UI'), request_id uuid NOT NULL,
 observation text NOT NULL CHECK(hon.teaching_studio_text(observation,700,false,true)), assessed_skills jsonb NOT NULL CHECK(jsonb_typeof(assessed_skills)='array'),
 instructor_note text CHECK(instructor_note IS NULL OR hon.teaching_studio_text(instructor_note,1000,true,true)), assessed_on date NOT NULL CHECK(assessed_on BETWEEN '2000-01-01'::date AND '2099-12-31'::date),
 status text NOT NULL CHECK(status IN('RECORDED','VOIDED')), target_curriculum_id uuid, target_rank_id uuid,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(assessment_id,version), UNIQUE(assessment_id,version,organization_id,school_id),
 FOREIGN KEY(assessment_id,organization_id,school_id) REFERENCES hon.instructor_assessments(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(target_curriculum_id,organization_id,school_id) REFERENCES hon.curricula(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(target_rank_id,organization_id,school_id) REFERENCES hon.curriculum_ranks(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX instructor_assessments_known_student_idx ON hon.instructor_assessments(organization_id,school_id,student_profile_id,id);
CREATE TABLE hon.teaching_studio_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 operation text NOT NULL CHECK(operation IN('LESSON','RESOURCE','ASSESSMENT')), entity_id uuid NOT NULL, version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);

CREATE FUNCTION hon.guard_teaching_studio_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_TEACHING_STUDIO_HISTORY' USING ERRCODE='42501'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['teaching_lesson_plans','teaching_lesson_plan_revisions','teaching_resources','teaching_resource_revisions','instructor_assessments','instructor_assessment_revisions','teaching_studio_requests'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER teaching_studio_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_teaching_studio_history()',t);
  EXECUTE format('CREATE TRIGGER teaching_studio_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_teaching_studio_history()',t);
 END LOOP;
END $$;

CREATE FUNCTION hon.teaching_studio_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT permission IN('teaching.studio.read','teaching.lesson.manage','teaching.resource.manage','teaching.assessment.record')
  AND hon.staff_member_eligible(actor,org,school) AND EXISTS(
   SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
   JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
   WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=permission
    AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
    AND (r.management_school_id IS NULL OR r.management_school_id=school)
    AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;
CREATE FUNCTION hon.resolve_teaching_studio_scope(subject text,p_school uuid) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT DISTINCT p.id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND g.school_id=p_school AND EXISTS(SELECT 1 FROM unnest(ARRAY['teaching.studio.read','teaching.lesson.manage','teaching.resource.manage','teaching.assessment.record']) code
  WHERE hon.teaching_studio_permission(p.id,g.organization_id,g.school_id,code))
$$;
CREATE FUNCTION hon.require_teaching_studio_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; active_tiers bigint;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=subject AND p.id::text=current_setting('app.hon_principal_id',true);
 SELECT count(*) INTO active_tiers FROM hon.organization_entitlements e WHERE e.organization_id=hon.current_organization_id() AND e.status='ACTIVE' AND e.tier IN('ESSENTIAL','CORE','COMPLETE')
  AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp());
 IF permission IS NULL OR actor IS NULL OR active_tiers<>1 OR NOT hon.teaching_studio_permission(actor,hon.current_organization_id(),hon.current_school_id(),permission) THEN
  RAISE EXCEPTION 'TEACHING_STUDIO_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_teaching_studio_actor(subject text,permission text,writing boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF writing THEN PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE; PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 ELSE PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR SHARE; PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR SHARE; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'TEACHING_STUDIO_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_teaching_studio_actor(subject,permission);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR SHARE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org ORDER BY id FOR SHARE;
 RETURN hon.require_teaching_studio_actor(subject,permission);
END $$;

CREATE FUNCTION hon.validate_teaching_studio_input(op text,p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE x jsonb; skill text; d text; keys text[];
BEGIN
 keys:=CASE op WHEN 'LESSON' THEN ARRAY['expectedVersion','title','instructionalObjective','sections','durationMinutes','status','targetCurriculumId','targetRankId']
  WHEN 'RESOURCE' THEN ARRAY['expectedVersion','title','resourceType','description','status']
  WHEN 'ASSESSMENT' THEN ARRAY['expectedVersion','observation','assessedSkills','instructorNote','assessedOn','status','targetCurriculumId','targetRankId'] END;
 IF keys IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) OR NOT p ?& keys
  OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'expectedVersion')::numeric>999999997 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF op='LESSON' THEN
  IF jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR NOT hon.teaching_studio_text(p->>'title',140)
   OR jsonb_typeof(p->'instructionalObjective') IS DISTINCT FROM 'string' OR NOT hon.teaching_studio_text(p->>'instructionalObjective',700)
   OR jsonb_typeof(p->'sections') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'sections') NOT BETWEEN 1 AND 12
   OR jsonb_typeof(p->'durationMinutes') IS DISTINCT FROM 'number' OR p->>'durationMinutes' !~ '^[0-9]{1,3}$' OR (p->>'durationMinutes')::integer NOT BETWEEN 5 AND 480
   OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN('DRAFT','PUBLISHED','ARCHIVED') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p->'sections') LOOP
   IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(x))<>2 OR NOT x ?& ARRAY['heading','content']
    OR jsonb_typeof(x->'heading') IS DISTINCT FROM 'string' OR NOT hon.teaching_studio_text(x->>'heading',120)
    OR jsonb_typeof(x->'content') IS DISTINCT FROM 'string' OR NOT hon.teaching_studio_text(x->>'content',1200) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
 ELSIF op='RESOURCE' THEN
  IF jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR NOT hon.teaching_studio_text(p->>'title',140)
   OR jsonb_typeof(p->'resourceType') IS DISTINCT FROM 'string' OR p->>'resourceType' NOT IN('DRILL','HANDOUT','EQUIPMENT','SAFETY_GUIDE','REFERENCE')
   OR jsonb_typeof(p->'description') IS DISTINCT FROM 'string' OR NOT hon.teaching_studio_text(p->>'description',900,true)
   OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN('ACTIVE','ARCHIVED') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 ELSE
  IF jsonb_typeof(p->'observation') IS DISTINCT FROM 'string' OR NOT hon.teaching_studio_text(p->>'observation',700,false,true)
   OR jsonb_typeof(p->'assessedSkills') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'assessedSkills')>20
   OR (p->'instructorNote'<>'null'::jsonb AND (jsonb_typeof(p->'instructorNote') IS DISTINCT FROM 'string' OR NOT hon.teaching_studio_text(p->>'instructorNote',1000,true,true)))
   OR jsonb_typeof(p->'assessedOn') IS DISTINCT FROM 'string' OR p->>'assessedOn' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
   OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN('RECORDED','VOIDED') OR (p->>'expectedVersion'='0' AND p->>'status'<>'RECORDED') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  d:=p->>'assessedOn'; IF to_char(d::date,'YYYY-MM-DD')<>d THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p->'assessedSkills') LOOP
   IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(x))<>2 OR NOT x ?& ARRAY['skill','status']
    OR jsonb_typeof(x->'skill') IS DISTINCT FROM 'string' OR NOT hon.teaching_studio_text(x->>'skill',120,false,true)
    OR jsonb_typeof(x->'status') IS DISTINCT FROM 'string' OR x->>'status' NOT IN('OBSERVED','NEEDS_PRACTICE','NOT_OBSERVED') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
 END IF;
 IF op IN('LESSON','ASSESSMENT') THEN
  IF (p->'targetCurriculumId'='null'::jsonb)<>(p->'targetRankId'='null'::jsonb) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR skill IN SELECT unnest(ARRAY['targetCurriculumId','targetRankId']) LOOP
   IF p->skill<>'null'::jsonb AND (jsonb_typeof(p->skill) IS DISTINCT FROM 'string' OR p->>skill !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
 END IF;
END $$;

CREATE FUNCTION hon.teaching_lesson_projection(p_id uuid,p_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',r.lesson_plan_id,'version',r.version,'title',r.title,'instructionalObjective',r.instructional_objective,'sections',r.sections,'durationMinutes',r.duration_minutes,'status',r.status,'targetCurriculumId',r.target_curriculum_id,'targetRankId',r.target_rank_id,'createdByPrincipalId',p.created_by_principal_id,'recordedByPrincipalId',r.actor_principal_id,'recordedAt',r.recorded_at,'humanAuthoredOnly',true)
 FROM hon.teaching_lesson_plan_revisions r JOIN hon.teaching_lesson_plans p ON p.id=r.lesson_plan_id AND p.organization_id=r.organization_id AND p.school_id=r.school_id
 WHERE r.lesson_plan_id=p_id AND r.organization_id=hon.current_organization_id() AND r.school_id=hon.current_school_id() AND (p_version IS NULL OR r.version=p_version) ORDER BY r.version DESC LIMIT 1
$$;
CREATE FUNCTION hon.teaching_resource_projection(p_id uuid,p_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',r.resource_id,'version',r.version,'title',r.title,'resourceType',r.resource_type,'description',r.description,'status',r.status,'createdByPrincipalId',p.created_by_principal_id,'recordedByPrincipalId',r.actor_principal_id,'recordedAt',r.recorded_at,'metadataOnly',true)
 FROM hon.teaching_resource_revisions r JOIN hon.teaching_resources p ON p.id=r.resource_id AND p.organization_id=r.organization_id AND p.school_id=r.school_id
 WHERE r.resource_id=p_id AND r.organization_id=hon.current_organization_id() AND r.school_id=hon.current_school_id() AND (p_version IS NULL OR r.version=p_version) ORDER BY r.version DESC LIMIT 1
$$;
CREATE FUNCTION hon.teaching_assessment_projection(p_id uuid,p_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',r.assessment_id,'version',r.version,'studentProfileId',a.student_profile_id,'observation',r.observation,'assessedSkills',r.assessed_skills,'instructorNote',r.instructor_note,'assessedOn',r.assessed_on,'status',r.status,'targetCurriculumId',r.target_curriculum_id,'targetRankId',r.target_rank_id,'createdByPrincipalId',a.created_by_principal_id,'recordedByPrincipalId',r.actor_principal_id,'recordedAt',r.recorded_at,'instructionalOnly',true)
 FROM hon.instructor_assessment_revisions r JOIN hon.instructor_assessments a ON a.id=r.assessment_id AND a.organization_id=r.organization_id AND a.school_id=r.school_id
 WHERE r.assessment_id=p_id AND r.organization_id=hon.current_organization_id() AND r.school_id=hon.current_school_id() AND (p_version IS NULL OR r.version=p_version) ORDER BY r.version DESC LIMIT 1
$$;

CREATE FUNCTION hon.read_teaching_studio(subject text,mode text,student uuid DEFAULT NULL,p_id uuid DEFAULT NULL,before_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb:='[]'; r record; n integer:=0; last_version integer; permission text:='teaching.studio.read';
BEGIN
 IF mode IS NULL OR mode NOT IN('ACCESS','LESSONS','LESSON_HISTORY','RESOURCES','RESOURCE_HISTORY','ASSESSMENTS','ASSESSMENT_HISTORY')
  OR ((mode IN('ASSESSMENTS','ASSESSMENT_HISTORY'))<>(student IS NOT NULL)) OR ((mode LIKE '%HISTORY')<>(p_id IS NOT NULL))
  OR (mode='ACCESS' AND (student IS NOT NULL OR p_id IS NOT NULL)) OR (before_version IS NOT NULL AND before_version NOT BETWEEN 1 AND 999999998) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_teaching_studio_actor(subject,permission,false);
 IF mode='ACCESS' THEN RETURN jsonb_build_object('canRead',true,'canManageLessons',hon.teaching_studio_permission(actor,hon.current_organization_id(),hon.current_school_id(),'teaching.lesson.manage'),'canManageResources',hon.teaching_studio_permission(actor,hon.current_organization_id(),hon.current_school_id(),'teaching.resource.manage'),'canRecordAssessments',hon.teaching_studio_permission(actor,hon.current_organization_id(),hon.current_school_id(),'teaching.assessment.record')); END IF;
 IF student IS NOT NULL THEN PERFORM 1 FROM hon.student_profiles WHERE id=student AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF; END IF;
 IF mode='LESSONS' THEN FOR r IN SELECT id FROM hon.teaching_lesson_plans WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY id LIMIT 30 LOOP result:=result||jsonb_build_array(hon.teaching_lesson_projection(r.id)); n:=n+1; END LOOP;
 ELSIF mode='RESOURCES' THEN FOR r IN SELECT id FROM hon.teaching_resources WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY id LIMIT 30 LOOP result:=result||jsonb_build_array(hon.teaching_resource_projection(r.id)); n:=n+1; END LOOP;
 ELSIF mode='ASSESSMENTS' THEN FOR r IN SELECT id FROM hon.instructor_assessments WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND student_profile_id=student ORDER BY id LIMIT 30 LOOP result:=result||jsonb_build_array(hon.teaching_assessment_projection(r.id)); n:=n+1; END LOOP;
 ELSIF mode='LESSON_HISTORY' THEN
  IF NOT EXISTS(SELECT 1 FROM hon.teaching_lesson_plans WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'TEACHING_STUDIO_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  FOR r IN SELECT version FROM hon.teaching_lesson_plan_revisions WHERE lesson_plan_id=p_id AND (before_version IS NULL OR version<before_version) ORDER BY version DESC LIMIT 30 LOOP result:=result||jsonb_build_array(hon.teaching_lesson_projection(p_id,r.version)); n:=n+1; last_version:=r.version; END LOOP;
 ELSIF mode='RESOURCE_HISTORY' THEN
  IF NOT EXISTS(SELECT 1 FROM hon.teaching_resources WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'TEACHING_STUDIO_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  FOR r IN SELECT version FROM hon.teaching_resource_revisions WHERE resource_id=p_id AND (before_version IS NULL OR version<before_version) ORDER BY version DESC LIMIT 30 LOOP result:=result||jsonb_build_array(hon.teaching_resource_projection(p_id,r.version)); n:=n+1; last_version:=r.version; END LOOP;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM hon.instructor_assessments WHERE id=p_id AND student_profile_id=student AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'TEACHING_STUDIO_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  FOR r IN SELECT version FROM hon.instructor_assessment_revisions WHERE assessment_id=p_id AND (before_version IS NULL OR version<before_version) ORDER BY version DESC LIMIT 30 LOOP result:=result||jsonb_build_array(hon.teaching_assessment_projection(p_id,r.version)); n:=n+1; last_version:=r.version; END LOOP;
 END IF;
 PERFORM hon.require_teaching_studio_actor(subject,permission);
 IF mode LIKE '%HISTORY' THEN RETURN jsonb_build_object('id',p_id,'items',result,'nextBefore',CASE WHEN n=30 THEN last_version ELSE NULL END); END IF;
 RETURN jsonb_build_object('items',result,'nextAfter',NULL);
END $$;

CREATE FUNCTION hon.mutate_teaching_studio(subject text,op text,student uuid,p_id uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text; fp text; receipt hon.teaching_studio_requests%ROWTYPE;
 prior jsonb; result jsonb; entity uuid:=p_id; n integer; action text; evidence jsonb; d date;
BEGIN
 PERFORM hon.validate_teaching_studio_input(op,p);
 IF key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key~'[[:cntrl:]]' OR request IS NULL OR correlation IS NULL OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
  OR ((op='ASSESSMENT')<>(student IS NOT NULL)) OR ((p_id IS NULL)<>(p->>'expectedVersion'='0')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 permission:=CASE op WHEN 'LESSON' THEN 'teaching.lesson.manage' WHEN 'RESOURCE' THEN 'teaching.resource.manage' WHEN 'ASSESSMENT' THEN 'teaching.assessment.record' END;
 IF permission IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_teaching_studio_actor(subject,permission,true);
 IF student IS NOT NULL THEN PERFORM 1 FROM hon.student_profiles WHERE id=student AND organization_id=org AND school_id=school AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF; END IF;
 IF op IN('LESSON','ASSESSMENT') AND p->'targetCurriculumId'<>'null'::jsonb THEN
  PERFORM 1 FROM hon.curriculum_ranks WHERE id=(p->>'targetRankId')::uuid AND curriculum_id=(p->>'targetCurriculumId')::uuid AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CURRICULUM_RANK_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 END IF;
 fp:=encode(sha256(convert_to(jsonb_build_object('op',op,'student',student,'id',p_id,'input',p)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM hon.teaching_studio_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
 IF FOUND THEN
  IF receipt.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  result:=CASE op WHEN 'LESSON' THEN hon.teaching_lesson_projection(receipt.entity_id,receipt.version) WHEN 'RESOURCE' THEN hon.teaching_resource_projection(receipt.entity_id,receipt.version) ELSE hon.teaching_assessment_projection(receipt.entity_id,receipt.version) END;
  PERFORM hon.require_teaching_studio_actor(subject,permission); RETURN jsonb_build_object('result',result,'replayed',true);
 END IF;
 prior:=CASE op WHEN 'LESSON' THEN hon.teaching_lesson_projection(p_id) WHEN 'RESOURCE' THEN hon.teaching_resource_projection(p_id) WHEN 'ASSESSMENT' THEN hon.teaching_assessment_projection(p_id) END;
 n:=coalesce((prior->>'version')::integer,0); IF n<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF p_id IS NOT NULL THEN
  IF (op='LESSON' AND NOT EXISTS(SELECT 1 FROM hon.teaching_lesson_plans WHERE id=p_id AND organization_id=org AND school_id=school)) OR (op='RESOURCE' AND NOT EXISTS(SELECT 1 FROM hon.teaching_resources WHERE id=p_id AND organization_id=org AND school_id=school)) OR (op='ASSESSMENT' AND NOT EXISTS(SELECT 1 FROM hon.instructor_assessments WHERE id=p_id AND student_profile_id=student AND organization_id=org AND school_id=school)) THEN RAISE EXCEPTION 'TEACHING_STUDIO_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 END IF;
 IF op='LESSON' THEN
  IF prior->>'status'='ARCHIVED' OR (p->>'status'='ARCHIVED' AND prior-ARRAY['id','version','status','createdByPrincipalId','recordedByPrincipalId','recordedAt','humanAuthoredOnly'] IS DISTINCT FROM p-ARRAY['expectedVersion','status']) THEN RAISE EXCEPTION 'LIFECYCLE_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p_id IS NULL THEN INSERT INTO hon.teaching_lesson_plans(organization_id,school_id,created_by_principal_id) VALUES(org,school,actor) RETURNING id INTO entity; END IF;
  INSERT INTO hon.teaching_lesson_plan_revisions(lesson_plan_id,organization_id,school_id,version,actor_principal_id,source,request_id,title,instructional_objective,sections,duration_minutes,status,target_curriculum_id,target_rank_id) VALUES(entity,org,school,n+1,actor,'HUMAN_UI',request,p->>'title',p->>'instructionalObjective',p->'sections',(p->>'durationMinutes')::integer,p->>'status',(p->>'targetCurriculumId')::uuid,(p->>'targetRankId')::uuid);
  result:=hon.teaching_lesson_projection(entity,n+1);
 ELSIF op='RESOURCE' THEN
  IF prior->>'status'='ARCHIVED' OR (p->>'status'='ARCHIVED' AND prior-ARRAY['id','version','status','createdByPrincipalId','recordedByPrincipalId','recordedAt','metadataOnly'] IS DISTINCT FROM p-ARRAY['expectedVersion','status']) THEN RAISE EXCEPTION 'LIFECYCLE_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p_id IS NULL THEN INSERT INTO hon.teaching_resources(organization_id,school_id,created_by_principal_id) VALUES(org,school,actor) RETURNING id INTO entity; END IF;
  INSERT INTO hon.teaching_resource_revisions(resource_id,organization_id,school_id,version,actor_principal_id,source,request_id,title,resource_type,description,status) VALUES(entity,org,school,n+1,actor,'HUMAN_UI',request,p->>'title',p->>'resourceType',p->>'description',p->>'status');
  result:=hon.teaching_resource_projection(entity,n+1);
 ELSE
  IF prior->>'status'='VOIDED' THEN RAISE EXCEPTION 'LIFECYCLE_CONFLICT' USING ERRCODE='40001'; END IF;
  d:=(p->>'assessedOn')::date; IF d>(clock_timestamp() AT TIME ZONE (SELECT timezone FROM hon.schools WHERE id=school AND organization_id=org))::date THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_id IS NULL THEN INSERT INTO hon.instructor_assessments(organization_id,school_id,student_profile_id,created_by_principal_id) VALUES(org,school,student,actor) RETURNING id INTO entity; END IF;
  INSERT INTO hon.instructor_assessment_revisions(assessment_id,organization_id,school_id,version,actor_principal_id,source,request_id,observation,assessed_skills,instructor_note,assessed_on,status,target_curriculum_id,target_rank_id) VALUES(entity,org,school,n+1,actor,'HUMAN_UI',request,p->>'observation',p->'assessedSkills',p->>'instructorNote',d,p->>'status',(p->>'targetCurriculumId')::uuid,(p->>'targetRankId')::uuid);
  result:=hon.teaching_assessment_projection(entity,n+1);
 END IF;
 action:=permission; evidence:=jsonb_build_object('id',entity,'version',n+1,'operation',op,'status',p->>'status','humanAuthoredOnly',true,'instructionalOnly',op='ASSESSMENT','noProgressTestingPromotionAttendanceMutation',true,'executionAllowed',false);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id) VALUES(org,school,actor,'HUMAN_UI',action,CASE op WHEN 'LESSON' THEN 'TEACHING_LESSON_PLAN' WHEN 'RESOURCE' THEN 'TEACHING_RESOURCE' ELSE 'INSTRUCTOR_ASSESSMENT' END,entity,CASE WHEN prior IS NULL THEN NULL ELSE jsonb_build_object('version',n) END,evidence,'SUCCEEDED',request,correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload) VALUES(org,school,'teaching.studio.human_recorded',1,CASE op WHEN 'LESSON' THEN 'TEACHING_LESSON_PLAN' WHEN 'RESOURCE' THEN 'TEACHING_RESOURCE' ELSE 'INSTRUCTOR_ASSESSMENT' END,entity,n+1,correlation,request,evidence);
 INSERT INTO hon.teaching_studio_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,operation,entity_id,version) VALUES(org,school,actor,key,fp,op,entity,n+1);
 PERFORM hon.require_teaching_studio_actor(subject,permission); RETURN jsonb_build_object('result',result,'replayed',false);
END $$;

DO $$ DECLARE r text; t text; f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%teaching_studio%' OR (n.nspname='hon' AND p.proname LIKE 'teaching_%') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
 FOREACH t IN ARRAY ARRAY['teaching_lesson_plans','teaching_lesson_plan_revisions','teaching_resources','teaching_resource_revisions','instructor_assessments','instructor_assessment_revisions','teaching_studio_requests'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%teaching_studio%' OR p.proname LIKE 'teaching_%') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_teaching_studio_scope(text,uuid),hon.read_teaching_studio(text,text,uuid,uuid,integer),hon.mutate_teaching_studio(text,text,uuid,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;

COMMIT;
