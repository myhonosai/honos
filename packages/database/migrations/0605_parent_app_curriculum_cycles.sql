BEGIN;
-- Parent app curriculum, piece 1 (0605, coordinator-allocated 2026-11-19; spec docs/architecture/PARENT_APP_CURRICULUM.md).
-- Each curriculum is shown in the parent app as RANK-based (material follows the child's current rank) or CYCLE-based
-- (ordered cycles; the current cycle rotates on a schedule or is picked by staff). Material stays in 0132
-- hon.curriculum_resources, which gains a DOCUMENT kind and an optional cycle (at most one of rank or cycle).
--   C1  hon.curriculum_cycles: ordered, renamed, archived (final); positions unique among active cycles.
--   C2  hon.curriculum_app_settings: one row per curriculum; no row = the 0132 behavior (rank material, shown).
--   C3  hon.curriculum_app_cycle_state: the current and next cycle, computed in the school's time zone.
--   C4  hon.mutate_parent_app_curriculum: closed staff commands (settings, cycles, order, switch now) with the 0132 lock
--       order, authority recheck after locks, scoped idempotency receipts, immutable history and audit.
--   C5  hon.read_staff_parent_app_curriculum: the staff page read.
--   C6  0132 functions replaced: identity guard covers cycle_id; projection adds cycleId; resource create takes DOCUMENT
--       and an active cycle of the same curriculum; the 0132 parent read leaves cycle material to the 0578 read.
-- No external I/O, AI, provider, storage or outbox. Links only (owner decision 2026-11-19); uploads are a later piece.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Parent app curriculum requires trusted migration owner'; END IF;
 IF to_regprocedure('hon.mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.lock_curriculum_resource_actor(text)') IS NULL THEN RAISE EXCEPTION 'Apply 0132 first'; END IF;
END $$;

CREATE FUNCTION hon.curriculum_app_name_ok(v text,maximum integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT v IS NOT NULL AND length(v) BETWEEN 1 AND maximum AND btrim(v)=v AND v !~ '[[:cntrl:]<>]';
$$;

CREATE TABLE hon.curriculum_cycles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL, curriculum_id uuid NOT NULL,
 name text NOT NULL CHECK(hon.curriculum_app_name_ok(name,80)),
 position integer NOT NULL CHECK(position BETWEEN 1 AND 2000),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','ARCHIVED')),
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 999999999),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,school_id), UNIQUE(id,curriculum_id,organization_id,school_id),
 FOREIGN KEY(curriculum_id,organization_id,school_id) REFERENCES hon.curricula(id,organization_id,school_id)
);
CREATE UNIQUE INDEX curriculum_cycles_active_position ON hon.curriculum_cycles(curriculum_id,position) WHERE status='ACTIVE';
CREATE UNIQUE INDEX curriculum_cycles_active_name ON hon.curriculum_cycles(curriculum_id,lower(name)) WHERE status='ACTIVE';

CREATE TABLE hon.curriculum_app_settings (
 curriculum_id uuid PRIMARY KEY, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 display_mode text NOT NULL CHECK(display_mode IN('RANK','CYCLE')),
 show_in_app boolean NOT NULL,
 rank_show_earlier boolean NOT NULL, rank_show_next boolean NOT NULL,
 cycle_rotation text NOT NULL CHECK(cycle_rotation IN('AUTO','STAFF_PICK')),
 cycle_anchor_date date CHECK(cycle_anchor_date BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'),
 cycle_length_weeks integer CHECK(cycle_length_weeks BETWEEN 1 AND 26),
 cycle_current_id uuid, cycle_current_since date CHECK(cycle_current_since BETWEEN DATE '2000-01-01' AND DATE '2099-12-31'),
 cycle_show_next boolean NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 999999999),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(cycle_rotation<>'AUTO' OR (cycle_anchor_date IS NOT NULL AND cycle_length_weeks IS NOT NULL)),
 CHECK((cycle_current_id IS NULL)=(cycle_current_since IS NULL)),
 FOREIGN KEY(curriculum_id,organization_id,school_id) REFERENCES hon.curricula(id,organization_id,school_id),
 FOREIGN KEY(cycle_current_id,curriculum_id,organization_id,school_id) REFERENCES hon.curriculum_cycles(id,curriculum_id,organization_id,school_id)
);

-- Immutable history of every command (snapshot of the curriculum's app state after it) and scoped idempotency receipts.
CREATE TABLE hon.curriculum_app_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL, curriculum_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN('SAVE_SETTINGS','CYCLE_CREATE','CYCLE_RENAME','CYCLE_ARCHIVE','CYCLE_ORDER','SWITCH_CYCLE')),
 target_id uuid, snapshot jsonb NOT NULL, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), request_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(curriculum_id,organization_id,school_id) REFERENCES hon.curricula(id,organization_id,school_id)
);
CREATE TABLE hon.curriculum_app_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
 idempotency_key text NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);

ALTER TABLE hon.curriculum_resources ADD COLUMN cycle_id uuid;
ALTER TABLE hon.curriculum_resources ADD CONSTRAINT curriculum_resources_cycle_fk FOREIGN KEY(cycle_id,curriculum_id,organization_id,school_id)
 REFERENCES hon.curriculum_cycles(id,curriculum_id,organization_id,school_id);
ALTER TABLE hon.curriculum_resources ADD CONSTRAINT curriculum_resources_rank_or_cycle CHECK(rank_id IS NULL OR cycle_id IS NULL);
ALTER TABLE hon.curriculum_resources DROP CONSTRAINT curriculum_resources_kind_check;
ALTER TABLE hon.curriculum_resources ADD CONSTRAINT curriculum_resources_kind_check CHECK(kind IN('VIDEO','LINK','DOCUMENT'));
CREATE INDEX curriculum_resources_cycle_idx ON hon.curriculum_resources(organization_id,school_id,curriculum_id,cycle_id) WHERE status='ACTIVE' AND cycle_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['curriculum_cycles','curriculum_app_settings','curriculum_app_events','curriculum_app_requests'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
-- No policies: accidental raw grants still reveal zero rows.

CREATE FUNCTION hon.guard_curriculum_cycle() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR OLD.status='ARCHIVED' THEN RAISE EXCEPTION 'IMMUTABLE_CYCLE' USING ERRCODE='42501'; END IF;
 IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.curriculum_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.curriculum_id,OLD.created_at)
  OR NEW.version NOT IN(OLD.version,OLD.version+1) THEN RAISE EXCEPTION 'IMMUTABLE_CYCLE_IDENTITY' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER curriculum_cycle_identity BEFORE UPDATE OR DELETE ON hon.curriculum_cycles FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_cycle();
CREATE TRIGGER curriculum_cycle_no_truncate BEFORE TRUNCATE ON hon.curriculum_cycles FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_cycle();
CREATE FUNCTION hon.guard_curriculum_app_settings() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'IMMUTABLE_APP_SETTINGS' USING ERRCODE='42501'; END IF;
 IF (NEW.curriculum_id,NEW.organization_id,NEW.school_id) IS DISTINCT FROM (OLD.curriculum_id,OLD.organization_id,OLD.school_id) OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'IMMUTABLE_APP_SETTINGS_IDENTITY' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER curriculum_app_settings_identity BEFORE UPDATE OR DELETE ON hon.curriculum_app_settings FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_app_settings();
CREATE TRIGGER curriculum_app_settings_no_truncate BEFORE TRUNCATE ON hon.curriculum_app_settings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_app_settings();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['curriculum_app_events','curriculum_app_requests'] LOOP
  EXECUTE format('CREATE TRIGGER curriculum_app_history_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_history()',t);
  EXECUTE format('CREATE TRIGGER curriculum_app_history_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_history()',t);
 END LOOP;
END $$;

-- C3: current and next cycle. AUTO: active cycles in position order rotate every 7*weeks days from the anchor date;
-- before the anchor nothing is current and the first cycle is next. STAFF_PICK: the picked cycle until changed.
CREATE FUNCTION hon.curriculum_app_cycle_state(p_curriculum uuid,p_organization uuid,p_school uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE s hon.curriculum_app_settings%ROWTYPE; today date; ids uuid[]; names text[]; n integer; len integer; k bigint; cur integer; nxt integer;
BEGIN
 SELECT (clock_timestamp() AT TIME ZONE sc.timezone)::date INTO today FROM hon.schools sc WHERE sc.id=p_school AND sc.organization_id=p_organization;
 SELECT coalesce(array_agg(c.id ORDER BY c.position,c.id),'{}'),coalesce(array_agg(c.name ORDER BY c.position,c.id),'{}') INTO ids,names
  FROM hon.curriculum_cycles c WHERE c.curriculum_id=p_curriculum AND c.organization_id=p_organization AND c.school_id=p_school AND c.status='ACTIVE';
 n:=coalesce(array_length(ids,1),0);
 SELECT * INTO s FROM hon.curriculum_app_settings WHERE curriculum_id=p_curriculum AND organization_id=p_organization AND school_id=p_school;
 IF n=0 OR NOT FOUND THEN RETURN jsonb_build_object('today',today,'current',NULL,'next',NULL); END IF;
 IF s.cycle_rotation='AUTO' THEN
  len:=7*s.cycle_length_weeks;
  IF today<s.cycle_anchor_date THEN
   RETURN jsonb_build_object('today',today,'current',NULL,'next',jsonb_build_object('id',ids[1],'name',names[1],'startsOn',s.cycle_anchor_date));
  END IF;
  k:=(today-s.cycle_anchor_date)/len; cur:=(k%n)::integer+1; nxt:=((k+1)%n)::integer+1;
  RETURN jsonb_build_object('today',today,
   'current',jsonb_build_object('id',ids[cur],'name',names[cur],'startsOn',s.cycle_anchor_date+(k*len)::integer,'endsOn',s.cycle_anchor_date+((k+1)*len)::integer-1),
   'next',jsonb_build_object('id',ids[nxt],'name',names[nxt],'startsOn',s.cycle_anchor_date+((k+1)*len)::integer));
 END IF;
 cur:=array_position(ids,s.cycle_current_id);
 IF cur IS NULL THEN RETURN jsonb_build_object('today',today,'current',NULL,'next',NULL); END IF;
 nxt:=cur%n+1;
 RETURN jsonb_build_object('today',today,'current',jsonb_build_object('id',ids[cur],'name',names[cur],'startsOn',s.cycle_current_since,'endsOn',NULL),
  'next',CASE WHEN n>1 THEN jsonb_build_object('id',ids[nxt],'name',names[nxt],'startsOn',NULL) ELSE NULL END);
END $$;

-- Staff projection of one curriculum's app state. A missing settings row shows the 0132 behavior (saved=false).
CREATE FUNCTION hon.curriculum_app_projection(p_curriculum uuid,p_organization uuid,p_school uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE s hon.curriculum_app_settings%ROWTYPE; model text; settings jsonb;
BEGIN
 SELECT model_code INTO model FROM hon.curricula WHERE id=p_curriculum AND organization_id=p_organization AND school_id=p_school;
 SELECT * INTO s FROM hon.curriculum_app_settings WHERE curriculum_id=p_curriculum AND organization_id=p_organization AND school_id=p_school;
 IF FOUND THEN
  settings:=jsonb_build_object('saved',true,'version',s.version,'displayMode',s.display_mode,'showInApp',s.show_in_app,'rankShowEarlier',s.rank_show_earlier,
   'rankShowNext',s.rank_show_next,'cycleRotation',s.cycle_rotation,'cycleAnchorDate',s.cycle_anchor_date,'cycleLengthWeeks',s.cycle_length_weeks,
   'cycleShowNext',s.cycle_show_next);
 ELSE
  settings:=jsonb_build_object('saved',false,'version',0,'displayMode',CASE WHEN model='ROTATIONAL' THEN 'CYCLE' ELSE 'RANK' END,'showInApp',true,
   'rankShowEarlier',false,'rankShowNext',false,'cycleRotation','STAFF_PICK','cycleAnchorDate',NULL,'cycleLengthWeeks',NULL,'cycleShowNext',true);
 END IF;
 RETURN jsonb_build_object('curriculumId',p_curriculum,'settings',settings,
  'cycles',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'position',c.position,'version',c.version) ORDER BY c.position,c.id)
   FROM hon.curriculum_cycles c WHERE c.curriculum_id=p_curriculum AND c.organization_id=p_organization AND c.school_id=p_school AND c.status='ACTIVE'),'[]'::jsonb),
  'cycleState',hon.curriculum_app_cycle_state(p_curriculum,p_organization,p_school));
END $$;

-- C6: 0132 bodies with the cycle column and DOCUMENT kind.
CREATE OR REPLACE FUNCTION hon.guard_curriculum_resource() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR OLD.status='ARCHIVED' THEN RAISE EXCEPTION 'IMMUTABLE_RESOURCE' USING ERRCODE='42501'; END IF;
 IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.curriculum_id,NEW.rank_id,NEW.cycle_id,NEW.kind,NEW.url,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.curriculum_id,OLD.rank_id,OLD.cycle_id,OLD.kind,OLD.url,OLD.created_at)
  OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'IMMUTABLE_RESOURCE_IDENTITY' USING ERRCODE='42501'; END IF;
 IF NEW.status='ARCHIVED' AND (NEW.title,NEW.description,NEW.audience) IS DISTINCT FROM (OLD.title,OLD.description,OLD.audience) THEN RAISE EXCEPTION 'ARCHIVE_ONLY' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION hon.curriculum_resource_projection(r hon.curriculum_resources) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',r.id,'curriculumId',r.curriculum_id,'rankId',r.rank_id,'cycleId',r.cycle_id,'kind',r.kind,'url',r.url,'title',r.title,'description',r.description,'audience',r.audience,'status',r.status,'version',r.version);
$$;
CREATE OR REPLACE FUNCTION hon.mutate_curriculum_resource(p_subject text,p_operation text,p_resource uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; r hon.curriculum_resources%ROWTYPE;
 previous hon.curriculum_resource_requests%ROWTYPE; fp text; result jsonb; prior jsonb; curriculum uuid; rank uuid; cycle uuid; expected integer;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('CREATE','UPDATE','ARCHIVE') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_curriculum_resource_actor(p_subject);
 fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'resourceId',p_resource,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.curriculum_resource_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('record',previous.response,'replayed',true);
 END IF;
 IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 expected:=(p_input->>'expectedVersion')::integer;
 IF p_operation='ARCHIVE' THEN
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k<>'expectedVersion') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('expectedVersion','title','description','audience') AND (p_operation<>'CREATE' OR k NOT IN('curriculumId','rankId','cycleId','kind','url')))
   OR jsonb_typeof(p_input->'title') IS DISTINCT FROM 'string' OR length(p_input->>'title') NOT BETWEEN 1 AND 160 OR btrim(p_input->>'title')<>p_input->>'title' OR p_input->>'title' ~ '[[:cntrl:]<>]'
   OR jsonb_typeof(p_input->'description') IS DISTINCT FROM 'string' OR length(p_input->>'description')>600 OR btrim(p_input->>'description')<>p_input->>'description' OR p_input->>'description' ~ '[[:cntrl:]<>]'
   OR jsonb_typeof(p_input->'audience') IS DISTINCT FROM 'string' OR p_input->>'audience' NOT IN('STAFF','PARENT') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_operation='CREATE' THEN
  IF p_resource IS NOT NULL OR expected<>0 OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string' OR p_input->>'kind' NOT IN('VIDEO','LINK','DOCUMENT')
   OR jsonb_typeof(p_input->'url') IS DISTINCT FROM 'string' OR NOT hon.valid_curriculum_resource_url(p_input->>'url')
   OR jsonb_typeof(p_input->'curriculumId') IS DISTINCT FROM 'string' OR NOT(p_input ? 'rankId') OR jsonb_typeof(p_input->'rankId') NOT IN('string','null')
   OR (p_input ? 'cycleId' AND jsonb_typeof(p_input->'cycleId') NOT IN('string','null'))
   OR (jsonb_typeof(p_input->'rankId')='string' AND jsonb_typeof(p_input->'cycleId')='string') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  curriculum:=(p_input->>'curriculumId')::uuid; rank:=(p_input->>'rankId')::uuid; cycle:=(p_input->>'cycleId')::uuid;
  PERFORM 1 FROM hon.curricula WHERE id=curriculum AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CURRICULUM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF rank IS NOT NULL THEN
   PERFORM 1 FROM hon.curriculum_ranks WHERE id=rank AND curriculum_id=curriculum AND organization_id=org AND school_id=school FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_RANK_CURRICULUM' USING ERRCODE='22023'; END IF;
  END IF;
  IF cycle IS NOT NULL THEN
   PERFORM 1 FROM hon.curriculum_cycles WHERE id=cycle AND curriculum_id=curriculum AND organization_id=org AND school_id=school AND status='ACTIVE' FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_CYCLE_CURRICULUM' USING ERRCODE='22023'; END IF;
  END IF;
  PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');
  INSERT INTO hon.curriculum_resources(organization_id,school_id,curriculum_id,rank_id,cycle_id,kind,url,title,description,audience)
   VALUES(org,school,curriculum,rank,cycle,p_input->>'kind',p_input->>'url',p_input->>'title',p_input->>'description',p_input->>'audience') RETURNING * INTO r;
 ELSE
  SELECT * INTO r FROM hon.curriculum_resources WHERE id=p_resource AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF r.version<>expected OR r.status<>'ACTIVE' THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  prior:=hon.curriculum_resource_projection(r);
  PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');
  IF p_operation='UPDATE' THEN
   UPDATE hon.curriculum_resources SET title=p_input->>'title',description=p_input->>'description',audience=p_input->>'audience',version=version+1 WHERE id=r.id RETURNING * INTO r;
  ELSE
   UPDATE hon.curriculum_resources SET status='ARCHIVED',version=version+1 WHERE id=r.id RETURNING * INTO r;
  END IF;
 END IF;
 result:=hon.curriculum_resource_projection(r);
 INSERT INTO hon.curriculum_resource_versions(resource_id,organization_id,school_id,version,snapshot,actor_principal_id,request_id) VALUES(r.id,org,school,r.version,result,actor,p_request);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','curriculum.library.'||lower(p_operation),'CURRICULUM_RESOURCE',r.id,CASE WHEN prior IS NULL THEN NULL ELSE jsonb_build_object('version',prior->'version') END,jsonb_build_object('version',r.version,'internalOnly',true),'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.curriculum_resource_facts(resource_id,organization_id,school_id,version,operation,request_id) VALUES(r.id,org,school,r.version,p_operation,p_request);
 INSERT INTO hon.curriculum_resource_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('record',result,'replayed',false);
END $$;
-- The 0132 parent read, unchanged except that cycle material and documents are left to the 0578 app read.
CREATE OR REPLACE FUNCTION hon.read_parent_curriculum_library(p_subject text,p_family uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE scope record; items jsonb;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
  OR (SELECT count(*) FROM hon.resolve_parent_journey_scopes(p_subject))<>1 THEN RAISE EXCEPTION 'FAMILY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO scope FROM hon.resolve_parent_journey_scopes(p_subject);
 IF scope.family_id IS DISTINCT FROM p_family OR scope.organization_id IS DISTINCT FROM hon.current_organization_id() OR scope.school_id IS DISTINCT FROM hon.current_school_id() OR scope.principal_id::text IS DISTINCT FROM current_setting('app.hon_principal_id',true) THEN RAISE EXCEPTION 'FAMILY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=scope.organization_id FOR SHARE;
 PERFORM 1 FROM hon.schools WHERE id=scope.school_id AND organization_id=scope.organization_id FOR SHARE;
 PERFORM 1 FROM hon.users WHERE external_subject=p_subject FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=scope.principal_id FOR SHARE;
 PERFORM 1 FROM hon.family_access_grants WHERE principal_id=scope.principal_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.families WHERE id=p_family AND organization_id=scope.organization_id AND school_id=scope.school_id FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=scope.organization_id FOR SHARE;
 PERFORM 1 FROM hon.family_members WHERE family_id=p_family AND organization_id=scope.organization_id AND school_id=scope.school_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.student_profiles WHERE primary_family_id=p_family AND organization_id=scope.organization_id AND school_id=scope.school_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.student_curriculum_enrollments WHERE student_profile_id IN(SELECT id FROM hon.student_profiles WHERE primary_family_id=p_family AND organization_id=scope.organization_id AND school_id=scope.school_id) ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM hon.resolve_parent_journey_scopes(p_subject))<>1 OR NOT EXISTS(SELECT 1 FROM hon.resolve_parent_journey_scopes(p_subject) s WHERE s.family_id=p_family AND s.organization_id=scope.organization_id AND s.school_id=scope.school_id AND s.principal_id=scope.principal_id)
  OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=scope.organization_id AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'FAMILY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(x.item ORDER BY x.title,x.resource_id,x.student_id),'[]'::jsonb) INTO items FROM (
  SELECT r.id resource_id,student.id student_id,r.title,jsonb_build_object('title',r.title,'description',r.description,'kind',r.kind,'url',r.url,
   'curriculumName',left(regexp_replace(c.name,'[[:cntrl:]<>]','','g'),160),'rankName',CASE WHEN rank.id IS NULL THEN NULL ELSE left(regexp_replace(rank.name,'[[:cntrl:]<>]','','g'),160) END,
   'childDisplayName',left(regexp_replace(concat_ws(' ',person.given_name,person.family_name),'[[:cntrl:]<>]','','g'),160)) item
  FROM hon.family_members member
  JOIN hon.student_profiles student ON student.person_id=member.person_id AND student.primary_family_id=p_family AND student.organization_id=member.organization_id AND student.school_id=member.school_id AND student.status='ACTIVE'
  JOIN hon.people person ON person.id=student.person_id AND person.organization_id=student.organization_id AND person.school_id=student.school_id
  JOIN hon.student_curriculum_enrollments e ON e.student_profile_id=student.id AND e.organization_id=student.organization_id AND e.school_id=student.school_id AND e.status='ACTIVE'
  JOIN hon.curricula c ON c.id=e.curriculum_id AND c.organization_id=e.organization_id AND c.school_id=e.school_id
  JOIN hon.curriculum_resources r ON r.curriculum_id=e.curriculum_id AND r.organization_id=e.organization_id AND r.school_id=e.school_id AND r.status='ACTIVE' AND r.audience='PARENT' AND (r.rank_id IS NULL OR r.rank_id=e.current_rank_id)
   AND r.cycle_id IS NULL AND r.kind IN('VIDEO','LINK')
  LEFT JOIN hon.curriculum_ranks rank ON rank.id=r.rank_id AND rank.curriculum_id=e.curriculum_id AND rank.organization_id=e.organization_id AND rank.school_id=e.school_id
  WHERE member.family_id=p_family AND member.member_role='STUDENT' AND member.organization_id=scope.organization_id AND member.school_id=scope.school_id
 ) x;
 RETURN jsonb_build_object('resources',items);
END $$;

-- C5: staff page read. Same authority as the library (curriculum.manage, 0132 lock order and recheck).
CREATE FUNCTION hon.read_staff_parent_app_curriculum(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
 PERFORM hon.lock_curriculum_resource_actor(p_subject);
 SELECT jsonb_build_object('timeZone',(SELECT timezone FROM hon.schools WHERE id=school AND organization_id=org),
  'curricula',coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',left(regexp_replace(c.name,'[[:cntrl:]<>]','','g'),160),'modelCode',c.model_code,'lifecycle',c.lifecycle,
   'ranks',coalesce((SELECT jsonb_agg(jsonb_build_object('id',k.id,'name',left(regexp_replace(k.name,'[[:cntrl:]<>]','','g'),160),
     'color',CASE WHEN k.display_color ~ '^#[0-9A-Fa-f]{6}$' THEN k.display_color ELSE NULL END,'order',k.progression_order) ORDER BY k.progression_order,k.id)
     FROM hon.curriculum_ranks k WHERE k.curriculum_id=c.id AND k.organization_id=org AND k.school_id=school),'[]'::jsonb),
   'app',hon.curriculum_app_projection(c.id,org,school),
   'resources',coalesce((SELECT jsonb_agg(hon.curriculum_resource_projection(r) ORDER BY r.title,r.id) FROM hon.curriculum_resources r
     WHERE r.curriculum_id=c.id AND r.organization_id=org AND r.school_id=school AND r.status='ACTIVE'),'[]'::jsonb))
   ORDER BY c.name,c.id),'[]'::jsonb)) INTO result
 FROM (SELECT * FROM hon.curricula WHERE organization_id=org AND school_id=school AND lifecycle<>'ARCHIVED' ORDER BY name,id LIMIT 100) c;
 PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');
 RETURN result;
END $$;

-- C4: closed staff commands for one curriculum.
CREATE FUNCTION hon.mutate_parent_app_curriculum(p_subject text,p_operation text,p_curriculum uuid,p_target uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; previous hon.curriculum_app_requests%ROWTYPE;
 s hon.curriculum_app_settings%ROWTYPE; had boolean; cy hon.curriculum_cycles%ROWTYPE; expected integer; today date; state jsonb; result jsonb;
 ids uuid[]; given uuid[]; idx integer; allowed text[]; anchor date; weeks integer; current_pick uuid; prior_version integer;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('SAVE_SETTINGS','CYCLE_CREATE','CYCLE_RENAME','CYCLE_ARCHIVE','CYCLE_ORDER','SWITCH_CYCLE')
  OR p_curriculum IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  OR (p_target IS NULL)<>(p_operation IN('SAVE_SETTINGS','CYCLE_CREATE','CYCLE_ORDER'))
  OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 allowed:=CASE p_operation
  WHEN 'SAVE_SETTINGS' THEN ARRAY['expectedVersion','displayMode','showInApp','rankShowEarlier','rankShowNext','cycleRotation','cycleAnchorDate','cycleLengthWeeks','cycleShowNext']
  WHEN 'CYCLE_CREATE' THEN ARRAY['name'] WHEN 'CYCLE_RENAME' THEN ARRAY['expectedVersion','name'] WHEN 'CYCLE_ARCHIVE' THEN ARRAY['expectedVersion']
  WHEN 'CYCLE_ORDER' THEN ARRAY['cycleIds'] ELSE ARRAY['expectedVersion'] END;
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM (SELECT array_agg(a ORDER BY a) FROM unnest(allowed) a) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_input ? 'expectedVersion' THEN
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p_input->>'expectedVersion')::integer;
 END IF;
 IF p_input ? 'name' AND (jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR NOT hon.curriculum_app_name_ok(p_input->>'name',80)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_operation='SAVE_SETTINGS' THEN
  IF jsonb_typeof(p_input->'displayMode') IS DISTINCT FROM 'string' OR p_input->>'displayMode' NOT IN('RANK','CYCLE')
   OR jsonb_typeof(p_input->'cycleRotation') IS DISTINCT FROM 'string' OR p_input->>'cycleRotation' NOT IN('AUTO','STAFF_PICK')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['showInApp','rankShowEarlier','rankShowNext','cycleShowNext']) b WHERE jsonb_typeof(p_input->b) IS DISTINCT FROM 'boolean')
   OR jsonb_typeof(p_input->'cycleAnchorDate') NOT IN('string','null') OR jsonb_typeof(p_input->'cycleLengthWeeks') NOT IN('number','null')
   OR (jsonb_typeof(p_input->'cycleAnchorDate')='string' AND (p_input->>'cycleAnchorDate' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' OR to_char(to_date(p_input->>'cycleAnchorDate','YYYY-MM-DD'),'YYYY-MM-DD')<>p_input->>'cycleAnchorDate'))
   OR (jsonb_typeof(p_input->'cycleLengthWeeks')='number' AND (p_input->>'cycleLengthWeeks' !~ '^[1-9][0-9]?$' OR (p_input->>'cycleLengthWeeks')::integer>26))
   OR (p_input->>'cycleRotation'='AUTO' AND (jsonb_typeof(p_input->'cycleAnchorDate')<>'string' OR jsonb_typeof(p_input->'cycleLengthWeeks')<>'number')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  anchor:=(p_input->>'cycleAnchorDate')::date; weeks:=(p_input->>'cycleLengthWeeks')::integer;
 ELSIF p_operation='CYCLE_ORDER' THEN
  IF jsonb_typeof(p_input->'cycleIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'cycleIds') NOT BETWEEN 1 AND 100
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'cycleIds') e WHERE jsonb_typeof(e)<>'string' OR e#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT array_agg((e#>>'{}')::uuid ORDER BY o) INTO given FROM jsonb_array_elements(p_input->'cycleIds') WITH ORDINALITY x(e,o);
  IF (SELECT count(DISTINCT g) FROM unnest(given) g)<>array_length(given,1) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;

 actor:=hon.lock_curriculum_resource_actor(p_subject);
 fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'curriculumId',p_curriculum,'targetId',p_target,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.curriculum_app_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('record',previous.response,'replayed',true);
 END IF;
 -- Lock order after the actor: curriculum, settings, cycles by id.
 PERFORM 1 FROM hon.curricula WHERE id=p_curriculum AND organization_id=org AND school_id=school AND lifecycle<>'ARCHIVED' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CURRICULUM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT * INTO s FROM hon.curriculum_app_settings WHERE curriculum_id=p_curriculum AND organization_id=org AND school_id=school FOR UPDATE;
 had:=FOUND; prior_version:=CASE WHEN had THEN s.version ELSE 0 END;
 PERFORM 1 FROM hon.curriculum_cycles WHERE curriculum_id=p_curriculum AND organization_id=org AND school_id=school AND status='ACTIVE' ORDER BY id FOR UPDATE;
 SELECT coalesce(array_agg(id ORDER BY position,id),'{}') INTO ids FROM hon.curriculum_cycles WHERE curriculum_id=p_curriculum AND organization_id=org AND school_id=school AND status='ACTIVE';
 IF p_target IS NOT NULL THEN
  SELECT * INTO cy FROM hon.curriculum_cycles WHERE id=p_target AND curriculum_id=p_curriculum AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CYCLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF cy.status<>'ACTIVE' THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 END IF;
 SELECT (clock_timestamp() AT TIME ZONE timezone)::date INTO today FROM hon.schools WHERE id=school AND organization_id=org;
 state:=hon.curriculum_app_cycle_state(p_curriculum,org,school);
 PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');

 IF p_operation='SAVE_SETTINGS' THEN
  IF expected<>prior_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  -- Leaving AUTO keeps the cycle families see today; a first STAFF_PICK save starts on the first cycle.
  current_pick:=CASE WHEN had AND s.cycle_rotation='STAFF_PICK' THEN s.cycle_current_id
   WHEN had AND s.cycle_rotation='AUTO' THEN (state#>>'{current,id}')::uuid ELSE ids[1] END;
  IF p_input->>'cycleRotation'='AUTO' THEN current_pick:=NULL; END IF;
  IF had THEN
   UPDATE hon.curriculum_app_settings SET display_mode=p_input->>'displayMode',show_in_app=(p_input->>'showInApp')::boolean,
    rank_show_earlier=(p_input->>'rankShowEarlier')::boolean,rank_show_next=(p_input->>'rankShowNext')::boolean,cycle_rotation=p_input->>'cycleRotation',
    cycle_anchor_date=anchor,cycle_length_weeks=weeks,cycle_show_next=(p_input->>'cycleShowNext')::boolean,
    cycle_current_since=CASE WHEN current_pick IS NULL THEN NULL WHEN current_pick IS NOT DISTINCT FROM s.cycle_current_id THEN s.cycle_current_since ELSE today END,
    cycle_current_id=current_pick,version=version+1,updated_at=clock_timestamp() WHERE curriculum_id=p_curriculum;
  ELSE
   INSERT INTO hon.curriculum_app_settings(curriculum_id,organization_id,school_id,display_mode,show_in_app,rank_show_earlier,rank_show_next,cycle_rotation,
    cycle_anchor_date,cycle_length_weeks,cycle_current_id,cycle_current_since,cycle_show_next)
   VALUES(p_curriculum,org,school,p_input->>'displayMode',(p_input->>'showInApp')::boolean,(p_input->>'rankShowEarlier')::boolean,(p_input->>'rankShowNext')::boolean,
    p_input->>'cycleRotation',anchor,weeks,current_pick,CASE WHEN current_pick IS NULL THEN NULL ELSE today END,(p_input->>'cycleShowNext')::boolean);
  END IF;
 ELSIF p_operation='CYCLE_CREATE' THEN
  IF coalesce(array_length(ids,1),0)>=100 THEN RAISE EXCEPTION 'CYCLE_LIMIT' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM hon.curriculum_cycles WHERE curriculum_id=p_curriculum AND status='ACTIVE' AND lower(name)=lower(p_input->>'name')) THEN RAISE EXCEPTION 'CYCLE_NAME_TAKEN' USING ERRCODE='23505'; END IF;
  INSERT INTO hon.curriculum_cycles(organization_id,school_id,curriculum_id,name,position)
   VALUES(org,school,p_curriculum,p_input->>'name',coalesce((SELECT max(position) FROM hon.curriculum_cycles WHERE curriculum_id=p_curriculum AND status='ACTIVE'),0)+1) RETURNING * INTO cy;
  -- A staff-picked curriculum with nothing current starts on its first cycle.
  IF had AND s.cycle_rotation='STAFF_PICK' AND s.cycle_current_id IS NULL THEN
   UPDATE hon.curriculum_app_settings SET cycle_current_id=cy.id,cycle_current_since=today,version=version+1,updated_at=clock_timestamp() WHERE curriculum_id=p_curriculum;
  END IF;
 ELSIF p_operation='CYCLE_RENAME' THEN
  IF cy.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM hon.curriculum_cycles WHERE curriculum_id=p_curriculum AND status='ACTIVE' AND id<>cy.id AND lower(name)=lower(p_input->>'name')) THEN RAISE EXCEPTION 'CYCLE_NAME_TAKEN' USING ERRCODE='23505'; END IF;
  UPDATE hon.curriculum_cycles SET name=p_input->>'name',version=version+1 WHERE id=cy.id;
 ELSIF p_operation='CYCLE_ARCHIVE' THEN
  IF cy.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF had AND s.cycle_rotation='STAFF_PICK' AND s.cycle_current_id=cy.id THEN RAISE EXCEPTION 'CYCLE_IS_CURRENT' USING ERRCODE='55000'; END IF;
  UPDATE hon.curriculum_cycles SET status='ARCHIVED',version=version+1 WHERE id=cy.id;
  -- Keep active positions 1..n (review P3): creates take n+1 and the order shift below stays inside the CHECK.
  UPDATE hon.curriculum_cycles SET position=position+1000 WHERE curriculum_id=p_curriculum AND status='ACTIVE';
  UPDATE hon.curriculum_cycles c SET position=x.o FROM (SELECT id,row_number() OVER (ORDER BY position,id) o FROM hon.curriculum_cycles
   WHERE curriculum_id=p_curriculum AND status='ACTIVE') x WHERE c.id=x.id;
 ELSIF p_operation='CYCLE_ORDER' THEN
  IF (SELECT array_agg(g ORDER BY g) FROM unnest(given) g) IS DISTINCT FROM (SELECT array_agg(i ORDER BY i) FROM unnest(ids) i) THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  UPDATE hon.curriculum_cycles SET position=position+1000 WHERE curriculum_id=p_curriculum AND status='ACTIVE';
  UPDATE hon.curriculum_cycles c SET position=x.o FROM unnest(given) WITH ORDINALITY x(id,o) WHERE c.id=x.id;
 ELSE -- SWITCH_CYCLE
  IF NOT had THEN RAISE EXCEPTION 'SETTINGS_REQUIRED' USING ERRCODE='55000'; END IF;
  IF s.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  idx:=array_position(ids,cy.id);
  IF s.cycle_rotation='AUTO' THEN
   -- Re-anchor so the picked cycle starts today and the rotation continues from it.
   anchor:=today-(idx-1)*7*s.cycle_length_weeks;
   IF anchor<DATE '2000-01-01' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   UPDATE hon.curriculum_app_settings SET cycle_anchor_date=anchor,version=version+1,updated_at=clock_timestamp() WHERE curriculum_id=p_curriculum;
  ELSE
   UPDATE hon.curriculum_app_settings SET cycle_current_id=cy.id,cycle_current_since=CASE WHEN s.cycle_current_id=cy.id THEN s.cycle_current_since ELSE today END,
    version=version+1,updated_at=clock_timestamp() WHERE curriculum_id=p_curriculum;
  END IF;
 END IF;

 result:=hon.curriculum_app_projection(p_curriculum,org,school);
 INSERT INTO hon.curriculum_app_events(organization_id,school_id,curriculum_id,operation,target_id,snapshot,actor_principal_id,request_id)
  VALUES(org,school,p_curriculum,p_operation,coalesce(p_target,cy.id),result,actor,p_request);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','curriculum.parent_app.'||lower(p_operation),'CURRICULUM',p_curriculum,jsonb_build_object('settingsVersion',prior_version),
   jsonb_build_object('settingsVersion',(result#>>'{settings,version}')::integer,'targetId',coalesce(p_target,cy.id),'internalOnly',true),'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.curriculum_app_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

REVOKE ALL ON TABLE hon.curriculum_cycles,hon.curriculum_app_settings,hon.curriculum_app_events,hon.curriculum_app_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.curriculum_app_name_ok(text,integer),hon.guard_curriculum_cycle(),hon.guard_curriculum_app_settings(),
 hon.curriculum_app_cycle_state(uuid,uuid,uuid),hon.curriculum_app_projection(uuid,uuid,uuid),hon.read_staff_parent_app_curriculum(text),
 hon.mutate_parent_app_curriculum(text,text,uuid,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.curriculum_cycles,hon.curriculum_app_settings,hon.curriculum_app_events,hon.curriculum_app_requests FROM %I',r);
  EXECUTE format('REVOKE ALL (cycle_id) ON hon.curriculum_resources FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.curriculum_app_name_ok(text,integer),hon.guard_curriculum_cycle(),hon.guard_curriculum_app_settings(),hon.curriculum_app_cycle_state(uuid,uuid,uuid),hon.curriculum_app_projection(uuid,uuid,uuid),hon.read_staff_parent_app_curriculum(text),hon.mutate_parent_app_curriculum(text,text,uuid,uuid,jsonb,text,uuid,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_staff_parent_app_curriculum(text),hon.mutate_parent_app_curriculum(text,text,uuid,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
