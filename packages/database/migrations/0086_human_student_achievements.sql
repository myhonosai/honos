BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Trusted achievement migration owner required'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('achievement.definition.read','Human exact school recognition definition read',true,true),
 ('achievement.definition.manage','Human exact school descriptive recognition definition lifecycle',true,true),
 ('achievement.award.read','Human exact known student recognition and private revision read',true,true),
 ('achievement.award.record','Explicit human exact known student recognition decision',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p WHERE r.is_system_role AND r.code='OWNER'
 AND p.code IN('achievement.definition.read','achievement.definition.manage','achievement.award.read','achievement.award.record') ON CONFLICT DO NOTHING;
CREATE FUNCTION hon.achievement_text(v text,maximum integer,empty_allowed boolean DEFAULT false) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT v IS NOT NULL AND length(v)<=maximum AND (empty_allowed OR length(v)>0) AND btrim(v)=v
 AND v !~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF<>\[\]{}=`$]'
 AND v !~* 'https?:|www\.|\y(javascript|eval|function|script|guaranteed|guarantee|score|scores|points|automatic|readiness)\y|\y(test|testing)[ -]ready\y|\yready for (testing|promotion)\y'
$$;
CREATE TABLE hon.achievement_definitions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 UNIQUE(id,organization_id,school_id)
);
CREATE TABLE hon.achievement_definition_versions (
 definition_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998), name text NOT NULL CHECK(hon.achievement_text(name,100)),
 description text NOT NULL CHECK(hon.achievement_text(description,600,true)),
 category text NOT NULL CHECK(category IN('EFFORT','PRACTICE','CHARACTER','TEAMWORK','LEARNING')),
 age_band text NOT NULL CHECK(age_band IN('EARLY_CHILDHOOD','CHILD','TEEN','ADULT')),
 visual_token text CHECK(visual_token IN('STAR','RIBBON','LEAF','BOOK','HANDSHAKE')), status text NOT NULL CHECK(status IN('ACTIVE','ARCHIVED')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(definition_id,version),
 UNIQUE(definition_id,version,organization_id,school_id),
 FOREIGN KEY(definition_id,organization_id,school_id) REFERENCES hon.achievement_definitions(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.achievement_awards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 student_profile_id uuid NOT NULL, definition_id uuid NOT NULL, definition_version integer NOT NULL, awarded_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 FOREIGN KEY(student_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id) ON DELETE RESTRICT,
 FOREIGN KEY(definition_id,definition_version,organization_id,school_id) REFERENCES hon.achievement_definition_versions(definition_id,version,organization_id,school_id) ON DELETE RESTRICT,
 UNIQUE(id,organization_id,school_id)
);
CREATE INDEX achievement_awards_student_idx ON hon.achievement_awards(organization_id,school_id,student_profile_id,id);
CREATE TABLE hon.achievement_award_versions (
 award_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='HUMAN_UI'), request_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998), reason text CHECK(reason IS NULL OR hon.achievement_text(reason,1000)),
 awarded_on date NOT NULL CHECK(awarded_on BETWEEN '2000-01-01'::date AND '2099-12-31'::date), visible_to_family boolean NOT NULL,
 status text NOT NULL CHECK(status IN('AWARDED','WITHDRAWN')), CHECK(status<>'WITHDRAWN' OR NOT visible_to_family),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(award_id,version),
 FOREIGN KEY(award_id,organization_id,school_id) REFERENCES hon.achievement_awards(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.achievement_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 operation text NOT NULL CHECK(operation IN('DEFINITION','AWARD')), entity_id uuid NOT NULL, version integer NOT NULL,
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
-- Private redacted audit. No staff reason or copied child identity in evidence.
CREATE TABLE hon.achievement_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 operation text NOT NULL CHECK(operation IN('DEFINITION','AWARD')), entity_id uuid NOT NULL, version integer NOT NULL,
 request_id uuid NOT NULL, correlation_id uuid NOT NULL, source text NOT NULL CHECK(source='HUMAN_UI'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(entity_id,version),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
-- Never global outbox_events: no provider/delivery/action/notification consumer.
CREATE TABLE hon.achievement_outbox (
 event_id uuid PRIMARY KEY REFERENCES hon.achievement_events(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'INERT' CHECK(status='INERT'), execution_allowed boolean NOT NULL DEFAULT false CHECK(NOT execution_allowed)
);
CREATE FUNCTION hon.guard_achievement_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_ACHIEVEMENT_HISTORY' USING ERRCODE='42501'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['achievement_definitions','achievement_definition_versions','achievement_awards','achievement_award_versions','achievement_requests','achievement_events','achievement_outbox'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER achievement_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_achievement_history()',t);
  EXECUTE format('CREATE TRIGGER achievement_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_achievement_history()',t);
 END LOOP;
END $$;
CREATE FUNCTION hon.achievement_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT permission IN('achievement.definition.read','achievement.definition.manage','achievement.award.read','achievement.award.record')
 AND hon.staff_member_eligible(actor,org,school) AND EXISTS(
 SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=permission
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=school) AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;
CREATE FUNCTION hon.resolve_achievement_scope(subject text,p_school uuid) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT DISTINCT p.id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND g.school_id=p_school AND EXISTS(SELECT 1 FROM unnest(ARRAY['achievement.definition.read','achievement.definition.manage','achievement.award.read','achievement.award.record']) code WHERE hon.achievement_permission(p.id,g.organization_id,g.school_id,code))
$$;
CREATE FUNCTION hon.require_achievement_actor(subject text,permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=subject AND p.id::text=current_setting('app.hon_principal_id',true);
 IF permission IS NULL OR actor IS NULL OR NOT hon.achievement_permission(actor,hon.current_organization_id(),hon.current_school_id(),permission) THEN RAISE EXCEPTION 'ACHIEVEMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_achievement_actor(subject text,permission text,writing boolean) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 -- Established topology → user → principal → grants → roles → permissions order.
 -- Topology write locks serialize receipts/version streams across human actors.
 IF writing THEN
  PERFORM 1 FROM hon.organizations WHERE id=org FOR UPDATE;
  PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org FOR UPDATE;
 ELSE
  PERFORM 1 FROM hon.organizations WHERE id=org FOR SHARE;
  PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org FOR SHARE;
 END IF;
 actor:=hon.require_achievement_actor(subject,permission);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR SHARE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 RETURN hon.require_achievement_actor(subject,permission);
END $$;
CREATE FUNCTION hon.lock_achievement_student(student uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 PERFORM 1 FROM hon.student_profiles WHERE id=student AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STUDENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM hon.people WHERE id IN(SELECT person_id FROM hon.student_profiles WHERE id=student) FOR SHARE;
END $$;
CREATE FUNCTION hon.validate_achievement_input(op text,p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE keys text[]; d text;
BEGIN
 keys:=CASE op WHEN 'DEFINITION' THEN ARRAY['expectedVersion','name','description','category','ageBand','visualToken','status'] WHEN 'AWARD' THEN ARRAY['expectedVersion','definitionId','definitionVersion','reason','awardedOn','visibleToFamily','status'] END;
 IF keys IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) OR NOT p ?& keys
 OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'expectedVersion')::numeric>999999997 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF op='DEFINITION' THEN
  IF jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR NOT hon.achievement_text(p->>'name',100)
  OR jsonb_typeof(p->'description') IS DISTINCT FROM 'string' OR NOT hon.achievement_text(p->>'description',600,true)
  OR jsonb_typeof(p->'category') IS DISTINCT FROM 'string' OR p->>'category' NOT IN('EFFORT','PRACTICE','CHARACTER','TEAMWORK','LEARNING')
  OR jsonb_typeof(p->'ageBand') IS DISTINCT FROM 'string' OR p->>'ageBand' NOT IN('EARLY_CHILDHOOD','CHILD','TEEN','ADULT')
  OR (p->'visualToken'<>'null'::jsonb AND (jsonb_typeof(p->'visualToken') IS DISTINCT FROM 'string' OR p->>'visualToken' NOT IN('STAR','RIBBON','LEAF','BOOK','HANDSHAKE')))
  OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN('ACTIVE','ARCHIVED') OR (p->>'expectedVersion'='0' AND p->>'status'<>'ACTIVE') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 ELSE
  IF jsonb_typeof(p->'definitionId') IS DISTINCT FROM 'string' OR p->>'definitionId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  OR jsonb_typeof(p->'definitionVersion') IS DISTINCT FROM 'number' OR p->>'definitionVersion' !~ '^[1-9][0-9]{0,8}$' OR (p->>'definitionVersion')::numeric>999999998
  OR (p->'reason'<>'null'::jsonb AND (jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR NOT hon.achievement_text(p->>'reason',1000)))
  OR jsonb_typeof(p->'awardedOn') IS DISTINCT FROM 'string' OR p->>'awardedOn' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
  OR jsonb_typeof(p->'visibleToFamily') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN('AWARDED','WITHDRAWN')
  OR (p->>'expectedVersion'='0' AND p->>'status'<>'AWARDED') OR (p->>'status'='WITHDRAWN' AND p->>'visibleToFamily'<>'false') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  d:=p->>'awardedOn'; IF to_char(d::date,'YYYY-MM-DD')<>d THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
END $$;
CREATE FUNCTION hon.achievement_definition_projection(p_id uuid,p_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',definition_id,'version',version,'name',name,'description',description,'category',category,'ageBand',age_band,'visualToken',visual_token,'status',status)
 FROM hon.achievement_definition_versions WHERE definition_id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND (p_version IS NULL OR version=p_version) ORDER BY version DESC LIMIT 1
$$;
CREATE FUNCTION hon.achievement_award_projection(p_id uuid,p_version integer DEFAULT NULL,parent_safe boolean DEFAULT false) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT CASE WHEN parent_safe THEN jsonb_build_object('id',a.id,'awardedOn',v.awarded_on,'definition',hon.achievement_definition_projection(a.definition_id,a.definition_version))
 ELSE jsonb_build_object('id',a.id,'version',v.version,'studentProfileId',a.student_profile_id,'definitionId',a.definition_id,'definitionVersion',a.definition_version,
 'awardedByPrincipalId',a.awarded_by_principal_id,'recordedByPrincipalId',v.actor_principal_id,'recordedAt',v.recorded_at,'reason',v.reason,'awardedOn',v.awarded_on,'visibleToFamily',v.visible_to_family,'status',v.status,'definition',hon.achievement_definition_projection(a.definition_id,a.definition_version)) END
 FROM hon.achievement_awards a JOIN hon.achievement_award_versions v ON v.award_id=a.id
 WHERE a.id=p_id AND a.organization_id=hon.current_organization_id() AND a.school_id=hon.current_school_id() AND (p_version IS NULL OR v.version=p_version) ORDER BY v.version DESC LIMIT 1
$$;
CREATE FUNCTION hon.read_achievements(subject text,mode text,student uuid DEFAULT NULL,p_id uuid DEFAULT NULL,after_id uuid DEFAULT NULL,before_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; permission text; r record; result jsonb:='[]'; n integer:=0; last_id uuid; last_version integer;
BEGIN
 IF mode IS NULL OR mode NOT IN('ACCESS','DEFINITIONS','DEFINITION_HISTORY','AWARDS','AWARD_HISTORY') OR ((mode IN('AWARDS','AWARD_HISTORY'))<>(student IS NOT NULL))
 OR ((mode LIKE '%HISTORY')<>(p_id IS NOT NULL)) OR (mode LIKE '%HISTORY' AND after_id IS NOT NULL) OR (mode NOT LIKE '%HISTORY' AND before_version IS NOT NULL)
 OR (mode='ACCESS' AND after_id IS NOT NULL) OR (before_version IS NOT NULL AND before_version NOT BETWEEN 1 AND 999999998) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 permission:=CASE WHEN mode LIKE 'AWARD%' THEN 'achievement.award.read' ELSE 'achievement.definition.read' END;
 IF mode='ACCESS' THEN
  SELECT code INTO permission FROM unnest(ARRAY['achievement.definition.read','achievement.definition.manage','achievement.award.read','achievement.award.record']) code
  WHERE hon.achievement_permission(nullif(current_setting('app.hon_principal_id',true),'')::uuid,hon.current_organization_id(),hon.current_school_id(),code) LIMIT 1;
 END IF;
 actor:=hon.lock_achievement_actor(subject,permission,false);
 IF mode='ACCESS' THEN RETURN jsonb_build_object('canReadDefinitions',hon.achievement_permission(actor,hon.current_organization_id(),hon.current_school_id(),'achievement.definition.read'),
  'canManageDefinitions',hon.achievement_permission(actor,hon.current_organization_id(),hon.current_school_id(),'achievement.definition.manage'),
  'canReadAwards',hon.achievement_permission(actor,hon.current_organization_id(),hon.current_school_id(),'achievement.award.read'),
  'canRecordAwards',hon.achievement_permission(actor,hon.current_organization_id(),hon.current_school_id(),'achievement.award.record')); END IF;
 IF student IS NOT NULL THEN PERFORM hon.lock_achievement_student(student); END IF;
 IF mode LIKE '%HISTORY' THEN
  IF mode='DEFINITION_HISTORY' THEN
   IF NOT EXISTS(SELECT 1 FROM hon.achievement_definitions WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'ACHIEVEMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
   FOR r IN SELECT version FROM hon.achievement_definition_versions WHERE definition_id=p_id AND (before_version IS NULL OR version<before_version) ORDER BY version DESC LIMIT 30 LOOP
    n:=n+1; last_version:=r.version; result:=result||jsonb_build_array(hon.achievement_definition_projection(p_id,r.version));
   END LOOP;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM hon.achievement_awards WHERE id=p_id AND student_profile_id=student AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'ACHIEVEMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
   FOR r IN SELECT version FROM hon.achievement_award_versions WHERE award_id=p_id AND (before_version IS NULL OR version<before_version) ORDER BY version DESC LIMIT 30 LOOP
    n:=n+1; last_version:=r.version; result:=result||jsonb_build_array(hon.achievement_award_projection(p_id,r.version,false));
   END LOOP;
  END IF;
 ELSE
  IF mode='DEFINITIONS' THEN
   FOR r IN SELECT id FROM hon.achievement_definitions WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND (after_id IS NULL OR id>after_id) ORDER BY id LIMIT 30 LOOP
    n:=n+1; last_id:=r.id; result:=result||jsonb_build_array(hon.achievement_definition_projection(r.id));
   END LOOP;
  ELSE
   FOR r IN SELECT id FROM hon.achievement_awards WHERE student_profile_id=student AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND (after_id IS NULL OR id>after_id) ORDER BY id LIMIT 30 LOOP
    n:=n+1; last_id:=r.id; result:=result||jsonb_build_array(hon.achievement_award_projection(r.id));
   END LOOP;
  END IF;
 END IF;
 PERFORM hon.require_achievement_actor(subject,permission);
 IF mode LIKE '%HISTORY' THEN RETURN jsonb_build_object('id',p_id,'items',result,'nextBefore',CASE WHEN n=30 THEN last_version ELSE NULL END); END IF;
 RETURN jsonb_build_object('items',result,'nextAfter',CASE WHEN n=30 THEN last_id ELSE NULL END);
END $$;
CREATE FUNCTION hon.mutate_achievements(subject text,op text,student uuid,p_id uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text; fp text;
 receipt hon.achievement_requests%ROWTYPE; prior jsonb; result jsonb; entity uuid:=p_id; n integer; event uuid;
 a hon.achievement_awards%ROWTYPE; d hon.achievement_definition_versions%ROWTYPE; birth date; years integer; award_date date;
BEGIN
 PERFORM hon.validate_achievement_input(op,p);
 IF key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key ~ '[[:cntrl:]]' OR request IS NULL OR correlation IS NULL
 OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) OR ((op='AWARD')<>(student IS NOT NULL)) OR ((p_id IS NULL)<>(p->>'expectedVersion'='0')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 permission:=CASE WHEN op='DEFINITION' THEN 'achievement.definition.manage' ELSE 'achievement.award.record' END;
 actor:=hon.lock_achievement_actor(subject,permission,true);
 IF student IS NOT NULL THEN PERFORM hon.lock_achievement_student(student); END IF;
 IF p_id IS NOT NULL THEN
  IF op='DEFINITION' THEN
   IF NOT EXISTS(SELECT 1 FROM hon.achievement_definitions WHERE id=p_id AND organization_id=org AND school_id=school) THEN RAISE EXCEPTION 'ACHIEVEMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  ELSE
   SELECT * INTO a FROM hon.achievement_awards WHERE id=p_id AND student_profile_id=student AND organization_id=org AND school_id=school;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACHIEVEMENT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  END IF;
 END IF;
 -- Reauthorize before looking at receipts; a stale resolved scope never revives a decision.
 fp:=encode(sha256(convert_to(jsonb_build_object('op',op,'student',student,'id',p_id,'input',p)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM hon.achievement_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
 IF FOUND THEN
  IF receipt.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  result:=CASE WHEN op='DEFINITION' THEN hon.achievement_definition_projection(receipt.entity_id,receipt.version) ELSE hon.achievement_award_projection(receipt.entity_id,receipt.version) END;
  PERFORM hon.require_achievement_actor(subject,permission);
  RETURN jsonb_build_object('result',result,'replayed',true);
 END IF;
 prior:=CASE WHEN op='DEFINITION' THEN hon.achievement_definition_projection(p_id) ELSE hon.achievement_award_projection(p_id) END;
 n:=coalesce((prior->>'version')::integer,0);
 IF n<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF op='DEFINITION' THEN
  IF prior->>'status'='ARCHIVED' OR (p->>'status'='ARCHIVED' AND prior-ARRAY['id','version','status'] IS DISTINCT FROM p-ARRAY['expectedVersion','status']) THEN RAISE EXCEPTION 'LIFECYCLE_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p_id IS NULL THEN INSERT INTO hon.achievement_definitions(organization_id,school_id) VALUES(org,school) RETURNING id INTO entity; END IF;
  INSERT INTO hon.achievement_definition_versions(definition_id,organization_id,school_id,version,name,description,category,age_band,visual_token,status)
  VALUES(entity,org,school,n+1,p->>'name',p->>'description',p->>'category',p->>'ageBand',p->>'visualToken',p->>'status');
  result:=hon.achievement_definition_projection(entity,n+1);
 ELSE
  IF prior->>'status'='WITHDRAWN' OR (p_id IS NOT NULL AND (a.definition_id<>(p->>'definitionId')::uuid OR a.definition_version<>(p->>'definitionVersion')::integer)) THEN RAISE EXCEPTION 'IMMUTABLE_AWARD_IDENTITY' USING ERRCODE='40001'; END IF;
  SELECT * INTO d FROM hon.achievement_definition_versions WHERE definition_id=(p->>'definitionId')::uuid AND organization_id=org AND school_id=school
  AND version=CASE WHEN p_id IS NULL THEN (SELECT max(version) FROM hon.achievement_definition_versions WHERE definition_id=(p->>'definitionId')::uuid) ELSE a.definition_version END;
  IF NOT FOUND OR d.status<>'ACTIVE' OR d.version<>(p->>'definitionVersion')::integer THEN RAISE EXCEPTION 'DEFINITION_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  award_date:=(p->>'awardedOn')::date;
  SELECT birth_date INTO birth FROM hon.student_profiles WHERE id=student;
  IF birth IS NULL OR birth>award_date OR award_date>(clock_timestamp() AT TIME ZONE (SELECT timezone FROM hon.schools WHERE id=school))::date THEN RAISE EXCEPTION 'KNOWN_AGE_AND_PAST_DATE_REQUIRED' USING ERRCODE='22023'; END IF;
  years:=extract(year FROM age(award_date,birth))::integer;
  IF NOT (CASE d.age_band WHEN 'EARLY_CHILDHOOD' THEN years BETWEEN 3 AND 5 WHEN 'CHILD' THEN years BETWEEN 6 AND 11 WHEN 'TEEN' THEN years BETWEEN 12 AND 17 ELSE years>=18 END) THEN RAISE EXCEPTION 'AGE_BAND_MISMATCH' USING ERRCODE='22023'; END IF;
  IF p_id IS NULL THEN INSERT INTO hon.achievement_awards(organization_id,school_id,student_profile_id,definition_id,definition_version,awarded_by_principal_id) VALUES(org,school,student,d.definition_id,d.version,actor) RETURNING id INTO entity; END IF;
  INSERT INTO hon.achievement_award_versions(award_id,organization_id,school_id,version,reason,awarded_on,visible_to_family,status,actor_principal_id,source,request_id)
  VALUES(entity,org,school,n+1,p->>'reason',award_date,(p->>'visibleToFamily')::boolean,p->>'status',actor,'HUMAN_UI',request);
  result:=hon.achievement_award_projection(entity,n+1);
 END IF;
 INSERT INTO hon.achievement_events(organization_id,school_id,actor_principal_id,operation,entity_id,version,request_id,correlation_id,source)
 VALUES(org,school,actor,op,entity,n+1,request,correlation,'HUMAN_UI') RETURNING id INTO event;
 INSERT INTO hon.achievement_outbox(event_id) VALUES(event);
 INSERT INTO hon.achievement_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,operation,entity_id,version) VALUES(org,school,actor,key,fp,op,entity,n+1);
 PERFORM hon.require_achievement_actor(subject,permission);
 RETURN jsonb_build_object('result',result,'replayed',false);
END $$;
CREATE FUNCTION hon.require_parent_achievement_actor(subject text,family uuid,student uuid) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT s.principal_id INTO actor FROM hon.resolve_parent_family_scope(subject,hon.current_school_id()) s
 WHERE s.family_id=family AND s.organization_id=hon.current_organization_id() AND s.principal_id::text=current_setting('app.hon_principal_id',true);
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM hon.student_profiles p JOIN hon.family_members m ON m.family_id=family AND m.person_id=p.person_id AND m.organization_id=p.organization_id AND m.school_id=p.school_id AND m.member_role='STUDENT'
 WHERE p.id=student AND p.primary_family_id=family AND p.organization_id=hon.current_organization_id() AND p.school_id=hon.current_school_id() AND p.status='ACTIVE') THEN RAISE EXCEPTION 'CHILD_SCOPE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.read_parent_achievements(subject text,family uuid,student uuid,after_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb:='[]'; r record; n integer:=0; last_id uuid;
BEGIN
 IF family IS NULL OR student IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=hon.current_organization_id() FOR SHARE;
 PERFORM 1 FROM hon.schools WHERE id=hon.current_school_id() AND organization_id=hon.current_organization_id() FOR SHARE;
 actor:=hon.require_parent_achievement_actor(subject,family,student);
 PERFORM 1 FROM hon.users WHERE external_subject=subject FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR SHARE;
 PERFORM 1 FROM hon.family_access_grants WHERE family_id=family AND principal_id=actor AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.families WHERE id=family AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR SHARE;
 PERFORM hon.lock_achievement_student(student);
 PERFORM 1 FROM hon.family_members WHERE family_id=family AND person_id IN(SELECT person_id FROM hon.student_profiles WHERE id=student) AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR SHARE;
 PERFORM hon.require_parent_achievement_actor(subject,family,student);
 FOR r IN SELECT a.id FROM hon.achievement_awards a JOIN LATERAL(SELECT status,visible_to_family FROM hon.achievement_award_versions WHERE award_id=a.id ORDER BY version DESC LIMIT 1) v ON true
 WHERE a.student_profile_id=student AND a.organization_id=hon.current_organization_id() AND a.school_id=hon.current_school_id() AND v.status='AWARDED' AND v.visible_to_family AND (after_id IS NULL OR a.id>after_id) ORDER BY a.id LIMIT 30 LOOP
  n:=n+1; last_id:=r.id; result:=result||jsonb_build_array(hon.achievement_award_projection(r.id,NULL,true));
 END LOOP;
 PERFORM hon.require_parent_achievement_actor(subject,family,student);
 RETURN jsonb_build_object('studentProfileId',student,'items',result,'nextAfter',CASE WHEN n=30 THEN last_id ELSE NULL END);
END $$;
-- Exact entrypoints only, including closed column ACLs under inherited defaults.
DO $$ DECLARE r text; t text; a text; f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%achievement%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature); END LOOP;
 FOREACH t IN ARRAY ARRAY['achievement_definitions','achievement_definition_versions','achievement_awards','achievement_award_versions','achievement_requests','achievement_events','achievement_outbox'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t); END LOOP;
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOREACH t IN ARRAY ARRAY['achievement_definitions','achievement_definition_versions','achievement_awards','achievement_award_versions','achievement_requests','achievement_events','achievement_outbox'] LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
   FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r); END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%achievement%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_achievement_scope(text,uuid),hon.read_achievements(text,text,uuid,uuid,uuid,integer),hon.mutate_achievements(text,text,uuid,uuid,jsonb,text,uuid,uuid),hon.read_parent_achievements(text,uuid,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
