BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Library requires trusted migration owner'; END IF;
END $$;

-- ASCII HTTPS DNS hostnames only. Deliberately no DNS lookup or network I/O.
CREATE FUNCTION hon.valid_curriculum_resource_url(v text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE host text; label text;
BEGIN
 IF v IS NULL OR length(v) NOT BETWEEN 12 AND 2048 OR v !~ '^https://[a-z0-9.-]+([/?][A-Za-z0-9/?=&._~!$''()*+;,@:-]*)?$' THEN RETURN false; END IF;
 host:=substring(v FROM '^https://([^/?]+)');
 IF length(host)>253 OR host !~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}$'
  OR host ~ '(^|\.)(localhost|local|internal|home|lan|test|invalid|onion|example|arpa)$' THEN RETURN false; END IF;
 FOREACH label IN ARRAY string_to_array(host,'.') LOOP
  IF length(label) NOT BETWEEN 1 AND 63 OR label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE TABLE hon.curriculum_resources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 curriculum_id uuid NOT NULL, rank_id uuid, kind text NOT NULL CHECK(kind IN('VIDEO','LINK')),
 url text NOT NULL CHECK(hon.valid_curriculum_resource_url(url)),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160 AND btrim(title)=title AND title !~ '[[:cntrl:]<>]'),
 description text NOT NULL CHECK(length(description)<=600 AND btrim(description)=description AND description !~ '[[:cntrl:]<>]'),
 audience text NOT NULL CHECK(audience IN('STAFF','PARENT')), status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','ARCHIVED')),
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 999999999), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,school_id),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
 FOREIGN KEY(curriculum_id,organization_id,school_id) REFERENCES hon.curricula(id,organization_id,school_id),
 FOREIGN KEY(rank_id,curriculum_id,organization_id,school_id) REFERENCES hon.curriculum_ranks(id,curriculum_id,organization_id,school_id)
);
CREATE INDEX curriculum_resources_scope_idx ON hon.curriculum_resources(organization_id,school_id,curriculum_id,rank_id) WHERE status='ACTIVE';
CREATE TABLE hon.curriculum_resource_versions (
 resource_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL, version integer NOT NULL,
 snapshot jsonb NOT NULL, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), request_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(resource_id,version),
 FOREIGN KEY(resource_id,organization_id,school_id) REFERENCES hon.curriculum_resources(id,organization_id,school_id)
);
CREATE TABLE hon.curriculum_resource_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
 idempotency_key text NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
-- NOT the general outbox. No consumer/worker/automation/delivery grant or route.
CREATE TABLE hon.curriculum_resource_facts (
 resource_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL, version integer NOT NULL,
 operation text NOT NULL CHECK(operation IN('CREATE','UPDATE','ARCHIVE')), state text NOT NULL DEFAULT 'INERT' CHECK(state='INERT'),
 internal_only boolean NOT NULL DEFAULT true CHECK(internal_only), request_id uuid NOT NULL,
 PRIMARY KEY(resource_id,version),
 FOREIGN KEY(resource_id,version) REFERENCES hon.curriculum_resource_versions(resource_id,version),
 FOREIGN KEY(resource_id,organization_id,school_id) REFERENCES hon.curriculum_resources(id,organization_id,school_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['curriculum_resources','curriculum_resource_versions','curriculum_resource_requests','curriculum_resource_facts'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
-- No policies: accidental raw grants still reveal zero rows.
CREATE FUNCTION hon.guard_curriculum_resource() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR OLD.status='ARCHIVED' THEN RAISE EXCEPTION 'IMMUTABLE_RESOURCE' USING ERRCODE='42501'; END IF;
 IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.curriculum_id,NEW.rank_id,NEW.kind,NEW.url,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.curriculum_id,OLD.rank_id,OLD.kind,OLD.url,OLD.created_at)
  OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'IMMUTABLE_RESOURCE_IDENTITY' USING ERRCODE='42501'; END IF;
 IF NEW.status='ARCHIVED' AND (NEW.title,NEW.description,NEW.audience) IS DISTINCT FROM (OLD.title,OLD.description,OLD.audience) THEN RAISE EXCEPTION 'ARCHIVE_ONLY' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER curriculum_resource_identity BEFORE UPDATE OR DELETE ON hon.curriculum_resources FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_resource();
CREATE TRIGGER curriculum_resource_no_truncate BEFORE TRUNCATE ON hon.curriculum_resources FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_resource();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['curriculum_resource_versions','curriculum_resource_requests','curriculum_resource_facts'] LOOP
  EXECUTE format('CREATE TRIGGER library_history_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_curriculum_history()',t);
  EXECUTE format('CREATE TRIGGER library_history_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_curriculum_history()',t);
 END LOOP;
END $$;

CREATE FUNCTION hon.lock_curriculum_resource_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'LIBRARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'LIBRARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_curriculum_actor(p_subject,'curriculum.manage');
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_curriculum_actor(p_subject,'curriculum.manage');
END $$;
CREATE FUNCTION hon.curriculum_resource_projection(r hon.curriculum_resources) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',r.id,'curriculumId',r.curriculum_id,'rankId',r.rank_id,'kind',r.kind,'url',r.url,'title',r.title,'description',r.description,'audience',r.audience,'status',r.status,'version',r.version);
$$;
CREATE FUNCTION hon.read_staff_curriculum_library(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
 PERFORM hon.lock_curriculum_resource_actor(p_subject);
 SELECT jsonb_build_object('resources',coalesce((SELECT jsonb_agg(hon.curriculum_resource_projection(r) ORDER BY r.title,r.id) FROM hon.curriculum_resources r WHERE r.organization_id=hon.current_organization_id() AND r.school_id=hon.current_school_id()),'[]'::jsonb),
 'curricula',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',left(regexp_replace(c.name,'[[:cntrl:]<>]','','g'),160),'ranks',coalesce((SELECT jsonb_agg(jsonb_build_object('id',k.id,'name',left(regexp_replace(k.name,'[[:cntrl:]<>]','','g'),160)) ORDER BY k.progression_order,k.id) FROM hon.curriculum_ranks k WHERE k.curriculum_id=c.id AND k.organization_id=c.organization_id AND k.school_id=c.school_id),'[]'::jsonb)) ORDER BY c.name,c.id) FROM hon.curricula c WHERE c.organization_id=hon.current_organization_id() AND c.school_id=hon.current_school_id()),'[]'::jsonb)) INTO result;
 PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');
 RETURN result;
END $$;

CREATE FUNCTION hon.mutate_curriculum_resource(p_subject text,p_operation text,p_resource uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; r hon.curriculum_resources%ROWTYPE;
 previous hon.curriculum_resource_requests%ROWTYPE; fp text; result jsonb; prior jsonb; curriculum uuid; rank uuid; expected integer;
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
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('expectedVersion','title','description','audience') AND (p_operation<>'CREATE' OR k NOT IN('curriculumId','rankId','kind','url')))
   OR jsonb_typeof(p_input->'title') IS DISTINCT FROM 'string' OR length(p_input->>'title') NOT BETWEEN 1 AND 160 OR btrim(p_input->>'title')<>p_input->>'title' OR p_input->>'title' ~ '[[:cntrl:]<>]'
   OR jsonb_typeof(p_input->'description') IS DISTINCT FROM 'string' OR length(p_input->>'description')>600 OR btrim(p_input->>'description')<>p_input->>'description' OR p_input->>'description' ~ '[[:cntrl:]<>]'
   OR jsonb_typeof(p_input->'audience') IS DISTINCT FROM 'string' OR p_input->>'audience' NOT IN('STAFF','PARENT') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_operation='CREATE' THEN
  IF p_resource IS NOT NULL OR expected<>0 OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string' OR p_input->>'kind' NOT IN('VIDEO','LINK')
   OR jsonb_typeof(p_input->'url') IS DISTINCT FROM 'string' OR NOT hon.valid_curriculum_resource_url(p_input->>'url')
   OR jsonb_typeof(p_input->'curriculumId') IS DISTINCT FROM 'string' OR NOT(p_input ? 'rankId') OR jsonb_typeof(p_input->'rankId') NOT IN('string','null') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  curriculum:=(p_input->>'curriculumId')::uuid; rank:=(p_input->>'rankId')::uuid;
  PERFORM 1 FROM hon.curricula WHERE id=curriculum AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CURRICULUM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF rank IS NOT NULL THEN
   PERFORM 1 FROM hon.curriculum_ranks WHERE id=rank AND curriculum_id=curriculum AND organization_id=org AND school_id=school FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_RANK_CURRICULUM' USING ERRCODE='22023'; END IF;
  END IF;
  PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');
  INSERT INTO hon.curriculum_resources(organization_id,school_id,curriculum_id,rank_id,kind,url,title,description,audience)
   VALUES(org,school,curriculum,rank,p_input->>'kind',p_input->>'url',p_input->>'title',p_input->>'description',p_input->>'audience') RETURNING * INTO r;
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

-- Caller family argument is server-derived only and must equal the ONE live
-- verified family for the external subject. Client has no selector endpoint.
CREATE FUNCTION hon.read_parent_curriculum_library(p_subject text,p_family uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
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
  LEFT JOIN hon.curriculum_ranks rank ON rank.id=r.rank_id AND rank.curriculum_id=e.curriculum_id AND rank.organization_id=e.organization_id AND rank.school_id=e.school_id
  WHERE member.family_id=p_family AND member.member_role='STUDENT' AND member.organization_id=scope.organization_id AND member.school_id=scope.school_id
 ) x;
 RETURN jsonb_build_object('resources',items);
END $$;
REVOKE ALL ON TABLE hon.curriculum_resources,hon.curriculum_resource_versions,hon.curriculum_resource_requests,hon.curriculum_resource_facts FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.valid_curriculum_resource_url(text),hon.guard_curriculum_resource(),hon.lock_curriculum_resource_actor(text),hon.curriculum_resource_projection(hon.curriculum_resources),hon.read_staff_curriculum_library(text),hon.mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid),hon.read_parent_curriculum_library(text,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.curriculum_resources,hon.curriculum_resource_versions,hon.curriculum_resource_requests,hon.curriculum_resource_facts FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.valid_curriculum_resource_url(text),hon.guard_curriculum_resource(),hon.lock_curriculum_resource_actor(text),hon.curriculum_resource_projection(hon.curriculum_resources),hon.read_staff_curriculum_library(text),hon.mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid),hon.read_parent_curriculum_library(text,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_staff_curriculum_library(text),hon.mutate_curriculum_resource(text,text,uuid,jsonb,text,uuid,uuid),hon.read_parent_curriculum_library(text,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
