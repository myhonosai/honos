BEGIN;
-- Rank setup (0622, coordinator-allocated 2026-11-21; spec docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md).
-- Owner ask (2026-11-21): "where is rank setup?" Until now no screen could create a school's programs and belt ladder.
--   R1  hon.rank_setup_program: one program with its belts (order, safe color, students on it) and each belt's requirements.
--   R2  hon.read_staff_rank_setup: the staff page read (curriculum.manage); the student list only with curriculum.progress.record.
--   R3  hon.mutate_rank_setup: closed human commands PROGRAM_CREATE, PROGRAM_SETUP (quick setup: a program with all its belts in
--       one command), PROGRAM_RENAME, RANK_ADD, RANK_UPDATE, RANK_MOVE, RANK_REMOVE with the 0132 actor lock order, authority
--       recheck after locks, 0070 scoped idempotency receipts and one audit row per command.
--   R4  hon.rank_setup_rules: a belt's "classes" and "days at this belt" are stored as the 0116 promotionReadinessV1 policy, so
--       Tests > Who is ready works for belts made here. Requirement and document lists already on a policy are kept.
-- Requirements and placing a student on a belt stay on 0070 hon.mutate_curriculum_progress (history, audit, outbox, evidence).
-- Functions only: no table, grant or policy change on existing tables. No external I/O, AI, provider or outbox.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Rank setup requires trusted migration owner'; END IF;
 IF to_regprocedure('hon.lock_curriculum_resource_actor(text)') IS NULL OR to_regprocedure('hon.require_curriculum_actor(text,text)') IS NULL
  OR to_regprocedure('hon.curriculum_app_name_ok(text,integer)') IS NULL OR to_regclass('hon.curriculum_command_requests') IS NULL THEN RAISE EXCEPTION 'Apply 0070, 0132 and 0605 first'; END IF;
END $$;

-- R4: the 0116 policy for a belt. Both numbers zero and nothing else on the policy means "no rule" ({}), because 0116 treats
-- an all-empty policy as a configuration error. A policy that is not the 0116 shape is replaced only when a number is set.
CREATE FUNCTION hon.rank_setup_rules(p_existing jsonb,p_classes integer,p_days integer) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE policy jsonb:=p_existing->'promotionReadinessV1'; milli bigint:=p_classes::bigint*1000; days integer:=p_days;
BEGIN
 IF jsonb_typeof(p_existing) IS DISTINCT FROM 'object' OR jsonb_typeof(policy) IS DISTINCT FROM 'object'
  OR jsonb_typeof(policy->'requiredRequirementIds') IS DISTINCT FROM 'array' OR jsonb_typeof(policy->'instructorRecommendationRequirementIds') IS DISTINCT FROM 'array'
  OR jsonb_typeof(policy->'documentTemplateIds') IS DISTINCT FROM 'array' OR jsonb_typeof(policy->'requireOpenTestingWindow') IS DISTINCT FROM 'boolean' THEN
  -- A rule this page did not write (for example one saved through the older rank API) is left as it is until the school
  -- sets a number here.
  IF p_classes=0 AND p_days=0 THEN RETURN coalesce(p_existing,'{}'::jsonb); END IF;
  policy:=jsonb_build_object('requiredRequirementIds','[]'::jsonb,'instructorRecommendationRequirementIds','[]'::jsonb,'documentTemplateIds','[]'::jsonb,'requireOpenTestingWindow',false);
 ELSE
  -- A number the school did not change keeps its exact stored value (a part class such as 1500, or one above this page's cap).
  IF (policy->>'minAttendanceCreditMilli') ~ '^[0-9]{1,12}$' AND least((policy->>'minAttendanceCreditMilli')::bigint/1000,2000)=p_classes THEN milli:=(policy->>'minAttendanceCreditMilli')::bigint; END IF;
  IF (policy->>'minDaysInCurrentRank') ~ '^[0-9]{1,5}$' AND least((policy->>'minDaysInCurrentRank')::integer,3650)=p_days THEN days:=(policy->>'minDaysInCurrentRank')::integer; END IF;
 END IF;
 policy:=jsonb_build_object('minAttendanceCreditMilli',milli,'minDaysInCurrentRank',days,'requiredRequirementIds',policy->'requiredRequirementIds',
  'instructorRecommendationRequirementIds',policy->'instructorRecommendationRequirementIds','documentTemplateIds',policy->'documentTemplateIds',
  'documentAcknowledgementRule','CURRENT_CALLER_STAFF_CURRENT_PUBLICATION','requireOpenTestingWindow',policy->'requireOpenTestingWindow');
 IF milli=0 AND days=0 AND jsonb_array_length(policy->'requiredRequirementIds')=0 AND jsonb_array_length(policy->'instructorRecommendationRequirementIds')=0
  AND jsonb_array_length(policy->'documentTemplateIds')=0 AND NOT (policy->>'requireOpenTestingWindow')::boolean THEN RETURN '{}'::jsonb; END IF;
 RETURN jsonb_build_object('promotionReadinessV1',policy);
END $$;

-- R1: plain text only (control characters and angle brackets removed), safe #RRGGBB colors, at most 60 belts and 100
-- requirements a belt. "students" counts active enrollments of active students currently on the belt.
CREATE FUNCTION hon.rank_setup_program(p_curriculum uuid,p_org uuid,p_school uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',c.id,'name',left(regexp_replace(c.name,'[[:cntrl:]<>]','','g'),160),'version',c.version,
  'ranks',coalesce((SELECT jsonb_agg(jsonb_build_object('id',k.id,'name',left(regexp_replace(k.name,'[[:cntrl:]<>]','','g'),160),
    'color',CASE WHEN k.display_color ~ '^#[0-9A-Fa-f]{6}$' THEN k.display_color ELSE NULL END,'order',k.progression_order,'version',k.version,
    'classes',CASE WHEN (k.promotion_requirement#>>'{promotionReadinessV1,minAttendanceCreditMilli}') ~ '^[0-9]{1,12}$' THEN least((k.promotion_requirement#>>'{promotionReadinessV1,minAttendanceCreditMilli}')::bigint/1000,2000) ELSE 0 END,
    'days',CASE WHEN (k.promotion_requirement#>>'{promotionReadinessV1,minDaysInCurrentRank}') ~ '^[0-9]{1,5}$' THEN least((k.promotion_requirement#>>'{promotionReadinessV1,minDaysInCurrentRank}')::integer,3650) ELSE 0 END,
    'students',(SELECT count(*) FROM hon.student_curriculum_enrollments e JOIN hon.student_profiles s ON s.id=e.student_profile_id AND s.organization_id=e.organization_id AND s.school_id=e.school_id
      WHERE e.current_rank_id=k.id AND e.organization_id=p_org AND e.school_id=p_school AND e.status='ACTIVE' AND s.status='ACTIVE'),
    'requirements',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'code',r.requirement_code,'kind',r.requirement_kind,
      'label',left(regexp_replace(coalesce(r.definition->>'label',r.requirement_code),'[[:cntrl:]<>]','','g'),160),
      'description',left(regexp_replace(coalesce(r.definition->>'description',''),'[[:cntrl:]<>]',' ','g'),2000),
      'required',r.is_required,'version',r.version) ORDER BY r.created_at,r.id)
     FROM (SELECT * FROM hon.curriculum_requirements WHERE curriculum_rank_id=k.id AND organization_id=p_org AND school_id=p_school ORDER BY created_at,id LIMIT 100) r),'[]'::jsonb))
   ORDER BY k.progression_order,k.id)
   FROM (SELECT * FROM hon.curriculum_ranks WHERE curriculum_id=c.id AND organization_id=p_org AND school_id=p_school ORDER BY progression_order,id LIMIT 60) k),'[]'::jsonb))
 FROM hon.curricula c WHERE c.id=p_curriculum AND c.organization_id=p_org AND c.school_id=p_school;
$$;

-- R2: the staff read. Authority is checked before and after the read, like the 0071 staff progress read.
CREATE FUNCTION hon.read_staff_rank_setup(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; programs jsonb; students jsonb:=NULL;
BEGIN
 actor:=hon.require_curriculum_actor(p_subject,'curriculum.manage');
 SELECT coalesce(jsonb_agg(hon.rank_setup_program(c.id,org,school) ORDER BY c.name,c.id),'[]'::jsonb) INTO programs
  FROM (SELECT id,name FROM hon.curricula WHERE organization_id=org AND school_id=school AND lifecycle<>'ARCHIVED' ORDER BY name,id LIMIT 100) c;
 IF hon.principal_has_school_permission(actor,org,school,'curriculum.progress.record') THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('enrollmentId',x.id,'programId',x.curriculum_id,'studentProfileId',x.student_profile_id,
    'givenName',left(regexp_replace(x.given_name,'[[:cntrl:]<>]','','g'),120),'familyName',left(regexp_replace(x.family_name,'[[:cntrl:]<>]','','g'),120),
    'currentRankId',x.current_rank_id,'version',x.version) ORDER BY x.family_name,x.given_name,x.id),'[]'::jsonb) INTO students
   FROM (SELECT e.id,e.curriculum_id,e.student_profile_id,p.given_name,p.family_name,e.current_rank_id,e.version
     FROM hon.student_curriculum_enrollments e
     JOIN hon.curricula c ON c.id=e.curriculum_id AND c.organization_id=e.organization_id AND c.school_id=e.school_id AND c.lifecycle<>'ARCHIVED'
     JOIN hon.student_profiles s ON s.id=e.student_profile_id AND s.organization_id=e.organization_id AND s.school_id=e.school_id
     JOIN hon.people p ON p.id=s.person_id AND p.organization_id=s.organization_id AND p.school_id=s.school_id
    WHERE e.organization_id=org AND e.school_id=school AND e.status='ACTIVE' AND s.status='ACTIVE'
    ORDER BY p.family_name,p.given_name,e.id LIMIT 1000) x;
 END IF;
 PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');
 RETURN jsonb_build_object('programs',programs,'students',students);
END $$;

-- R3: closed human commands on a school's programs and belts.
CREATE FUNCTION hon.mutate_rank_setup(p_subject text,p_operation text,p_curriculum uuid,p_target uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; previous hon.curriculum_command_requests%ROWTYPE;
 c hon.curricula%ROWTYPE; k hon.curriculum_ranks%ROWTYPE; n hon.curriculum_ranks%ROWTYPE; allowed text[]; expected integer; color text; program uuid; result jsonb; prior jsonb; top integer; item jsonb; pos integer:=0; classes integer:=0; days integer:=0;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('PROGRAM_CREATE','PROGRAM_SETUP','PROGRAM_RENAME','RANK_ADD','RANK_UPDATE','RANK_MOVE','RANK_REMOVE') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  OR (p_curriculum IS NULL)<>(p_operation IN('PROGRAM_CREATE','PROGRAM_SETUP')) OR (p_target IS NULL)<>(p_operation NOT IN('RANK_UPDATE','RANK_MOVE','RANK_REMOVE'))
  OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 allowed:=CASE p_operation WHEN 'PROGRAM_CREATE' THEN ARRAY['name'] WHEN 'PROGRAM_SETUP' THEN ARRAY['name','ranks'] WHEN 'PROGRAM_RENAME' THEN ARRAY['expectedVersion','name']
  WHEN 'RANK_ADD' THEN ARRAY['classes','color','days','name'] WHEN 'RANK_UPDATE' THEN ARRAY['classes','color','days','expectedVersion','name']
  WHEN 'RANK_REMOVE' THEN ARRAY['expectedVersion'] ELSE ARRAY['direction','expectedVersion'] END;
 IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM allowed THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_input ? 'name' AND (jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR NOT hon.curriculum_app_name_ok(p_input->>'name',120)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_input ? 'color' THEN
  IF jsonb_typeof(p_input->'color') NOT IN('null','string') OR (jsonb_typeof(p_input->'color')='string' AND p_input->>'color' !~ '^#[0-9A-Fa-f]{6}$') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  color:=upper(p_input->>'color');
 END IF;
 IF p_input ? 'expectedVersion' THEN
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p_input->>'expectedVersion')::integer;
 END IF;
 IF p_input ? 'classes' THEN
  IF jsonb_typeof(p_input->'classes') IS DISTINCT FROM 'number' OR (p_input->>'classes') !~ '^(0|[1-9][0-9]{0,3})$' OR (p_input->>'classes')::integer>2000
   OR jsonb_typeof(p_input->'days') IS DISTINCT FROM 'number' OR (p_input->>'days') !~ '^(0|[1-9][0-9]{0,3})$' OR (p_input->>'days')::integer>3650 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  classes:=(p_input->>'classes')::integer; days:=(p_input->>'days')::integer;
 END IF;
 IF p_operation='PROGRAM_SETUP' THEN
  -- Quick setup: 1 to 60 belts in order, each a closed object, names unique within the program whatever the letter case.
  IF jsonb_typeof(p_input->'ranks') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'ranks') NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT x FROM jsonb_array_elements(p_input->'ranks') x LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(item) x) IS DISTINCT FROM ARRAY['classes','color','days','name']
    OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR NOT hon.curriculum_app_name_ok(item->>'name',120)
    OR jsonb_typeof(item->'color') NOT IN('null','string') OR (jsonb_typeof(item->'color')='string' AND item->>'color' !~ '^#[0-9A-Fa-f]{6}$')
    OR jsonb_typeof(item->'classes') IS DISTINCT FROM 'number' OR (item->>'classes') !~ '^(0|[1-9][0-9]{0,3})$' OR (item->>'classes')::integer>2000
    OR jsonb_typeof(item->'days') IS DISTINCT FROM 'number' OR (item->>'days') !~ '^(0|[1-9][0-9]{0,3})$' OR (item->>'days')::integer>3650 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT lower(x->>'name')) FROM jsonb_array_elements(p_input->'ranks') x)<>jsonb_array_length(p_input->'ranks') THEN RAISE EXCEPTION 'RANK_NAME_TAKEN' USING ERRCODE='23505'; END IF;
 END IF;
 IF p_input ? 'direction' AND (jsonb_typeof(p_input->'direction') IS DISTINCT FROM 'string' OR p_input->>'direction' NOT IN('UP','DOWN')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;

 actor:=hon.lock_curriculum_resource_actor(p_subject);
 fp:=encode(sha256(convert_to(jsonb_build_object('scope','rank_setup','operation',p_operation,'curriculumId',p_curriculum,'targetId',p_target,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.curriculum_command_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('record',previous.response,'replayed',true);
 END IF;

 IF p_operation IN('PROGRAM_CREATE','PROGRAM_SETUP') THEN
  -- The school row (locked by the actor lock) serializes creates, so the case-insensitive name check cannot race.
  IF (SELECT count(*) FROM hon.curricula WHERE organization_id=org AND school_id=school AND lifecycle<>'ARCHIVED')>=100 THEN RAISE EXCEPTION 'PROGRAM_LIMIT' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM hon.curricula WHERE organization_id=org AND school_id=school AND lower(name)=lower(p_input->>'name')) THEN RAISE EXCEPTION 'PROGRAM_NAME_TAKEN' USING ERRCODE='23505'; END IF;
  PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');
  INSERT INTO hon.curricula(organization_id,school_id,name,model_code,lifecycle) VALUES(org,school,p_input->>'name','LINEAR','PUBLISHED') RETURNING * INTO c;
  program:=c.id;
  IF p_operation='PROGRAM_SETUP' THEN
   FOR item IN SELECT x FROM jsonb_array_elements(p_input->'ranks') x LOOP
    pos:=pos+1;
    INSERT INTO hon.curriculum_ranks(organization_id,school_id,curriculum_id,name,display_color,progression_order,promotion_requirement)
     VALUES(org,school,c.id,item->>'name',upper(item->>'color'),pos,hon.rank_setup_rules('{}'::jsonb,(item->>'classes')::integer,(item->>'days')::integer));
   END LOOP;
  END IF;
 ELSE
  -- Lock order after the actor: the program, then its belts by id.
  SELECT * INTO c FROM hon.curricula WHERE id=p_curriculum AND organization_id=org AND school_id=school AND lifecycle<>'ARCHIVED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROGRAM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  program:=c.id;
  PERFORM 1 FROM hon.curriculum_ranks WHERE curriculum_id=c.id AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
  IF p_target IS NOT NULL THEN
   SELECT * INTO k FROM hon.curriculum_ranks WHERE id=p_target AND curriculum_id=c.id AND organization_id=org AND school_id=school;
   IF NOT FOUND THEN RAISE EXCEPTION 'RANK_NOT_FOUND' USING ERRCODE='P0002'; END IF;
   IF k.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  END IF;
  PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');
  IF p_operation='PROGRAM_RENAME' THEN
   IF c.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   IF EXISTS(SELECT 1 FROM hon.curricula WHERE organization_id=org AND school_id=school AND id<>c.id AND lower(name)=lower(p_input->>'name')) THEN RAISE EXCEPTION 'PROGRAM_NAME_TAKEN' USING ERRCODE='23505'; END IF;
   prior:=jsonb_build_object('version',c.version);
   UPDATE hon.curricula SET name=p_input->>'name',version=version+1,updated_at=clock_timestamp() WHERE id=c.id;
  ELSIF p_operation='RANK_ADD' THEN
   IF (SELECT count(*) FROM hon.curriculum_ranks WHERE curriculum_id=c.id)>=60 THEN RAISE EXCEPTION 'RANK_LIMIT' USING ERRCODE='22023'; END IF;
   IF EXISTS(SELECT 1 FROM hon.curriculum_ranks WHERE curriculum_id=c.id AND lower(name)=lower(p_input->>'name')) THEN RAISE EXCEPTION 'RANK_NAME_TAKEN' USING ERRCODE='23505'; END IF;
   INSERT INTO hon.curriculum_ranks(organization_id,school_id,curriculum_id,name,display_color,progression_order,promotion_requirement)
    VALUES(org,school,c.id,p_input->>'name',color,coalesce((SELECT max(progression_order) FROM hon.curriculum_ranks WHERE curriculum_id=c.id),0)+1,hon.rank_setup_rules('{}'::jsonb,classes,days)) RETURNING * INTO k;
  ELSIF p_operation='RANK_UPDATE' THEN
   IF EXISTS(SELECT 1 FROM hon.curriculum_ranks WHERE curriculum_id=c.id AND id<>k.id AND lower(name)=lower(p_input->>'name')) THEN RAISE EXCEPTION 'RANK_NAME_TAKEN' USING ERRCODE='23505'; END IF;
   prior:=jsonb_build_object('version',k.version);
   UPDATE hon.curriculum_ranks SET name=p_input->>'name',display_color=color,promotion_requirement=hon.rank_setup_rules(promotion_requirement,classes,days),version=version+1,updated_at=clock_timestamp() WHERE id=k.id;
  ELSIF p_operation='RANK_REMOVE' THEN
   -- Only a belt nothing depends on can go: nothing it needs (0070 keeps requirement history for good), no student on it
   -- or promoted through it, no test. Every table that points at the belt refuses the delete, reported as RANK_IN_USE.
   prior:=jsonb_build_object('version',k.version,'order',k.progression_order,'name',k.name);
   IF EXISTS(SELECT 1 FROM hon.curriculum_requirements WHERE curriculum_rank_id=k.id) THEN RAISE EXCEPTION 'RANK_IN_USE' USING ERRCODE='55000'; END IF;
   BEGIN
    DELETE FROM hon.curriculum_ranks WHERE id=k.id;
   EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN RAISE EXCEPTION 'RANK_IN_USE' USING ERRCODE='55000';
   END;
   FOR n IN SELECT * FROM hon.curriculum_ranks WHERE curriculum_id=c.id AND progression_order>k.progression_order ORDER BY progression_order LOOP
    UPDATE hon.curriculum_ranks SET progression_order=n.progression_order-1,version=version+1,updated_at=clock_timestamp() WHERE id=n.id;
   END LOOP;
  ELSE -- RANK_MOVE: swap order with the neighbouring belt; the first belt cannot move up nor the last down.
   IF p_input->>'direction'='UP' THEN
    SELECT * INTO n FROM hon.curriculum_ranks WHERE curriculum_id=c.id AND progression_order<k.progression_order ORDER BY progression_order DESC,id LIMIT 1;
   ELSE
    SELECT * INTO n FROM hon.curriculum_ranks WHERE curriculum_id=c.id AND progression_order>k.progression_order ORDER BY progression_order,id LIMIT 1;
   END IF;
   IF NOT FOUND THEN RAISE EXCEPTION 'RANK_AT_END' USING ERRCODE='55000'; END IF;
   prior:=jsonb_build_object('version',k.version,'order',k.progression_order,'neighbourId',n.id,'neighbourOrder',n.progression_order);
   SELECT max(progression_order)+1 INTO top FROM hon.curriculum_ranks WHERE curriculum_id=c.id;
   UPDATE hon.curriculum_ranks SET progression_order=top WHERE id=k.id;
   UPDATE hon.curriculum_ranks SET progression_order=k.progression_order,version=version+1,updated_at=clock_timestamp() WHERE id=n.id;
   UPDATE hon.curriculum_ranks SET progression_order=n.progression_order,version=version+1,updated_at=clock_timestamp() WHERE id=k.id;
  END IF;
 END IF;

 result:=hon.rank_setup_program(program,org,school);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','curriculum.rank_setup.'||lower(p_operation),CASE WHEN p_operation LIKE 'RANK_%' THEN 'CURRICULUM_RANK' ELSE 'CURRICULUM' END,
   CASE WHEN p_operation LIKE 'RANK_%' THEN k.id ELSE program END,prior,
   jsonb_build_object('programId',program,'rankId',k.id,'programVersion',(result->>'version')::integer,'internalOnly',true),'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.curriculum_command_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

REVOKE ALL ON FUNCTION hon.rank_setup_rules(jsonb,integer,integer),hon.rank_setup_program(uuid,uuid,uuid),hon.read_staff_rank_setup(text),hon.mutate_rank_setup(text,text,uuid,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.rank_setup_rules(jsonb,integer,integer),hon.rank_setup_program(uuid,uuid,uuid),hon.read_staff_rank_setup(text),hon.mutate_rank_setup(text,text,uuid,uuid,jsonb,text,uuid,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_staff_rank_setup(text),hon.mutate_rank_setup(text,text,uuid,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
