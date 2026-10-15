BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Trusted community migration owner required'; END IF;
END $$;
-- No self-attestation: a trusted administrator manually verifies an owner/operator.
-- Neither an OWNER role, organization opt-in nor HQ role is verification by itself.
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('community.participate','Verified human owner/operator closed community participation',true,false),
 ('community.organization.manage','Verified owner explicit organization community opt-in',true,false);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN('community.participate','community.organization.manage') ON CONFLICT DO NOTHING;
CREATE TABLE hon.community_verifications (
 principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 capacity text NOT NULL CHECK(capacity IN('OWNER','OPERATOR')), verified_at timestamptz NOT NULL, effective_until timestamptz, revoked_at timestamptz,
 PRIMARY KEY(principal_id,organization_id,school_id), FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 CHECK(effective_until IS NULL OR effective_until>verified_at)
);
CREATE TABLE hon.community_organizations (
 organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT, version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998),
 enabled boolean NOT NULL, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='HUMAN_UI'), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(organization_id,version)
);
CREATE TABLE hon.community_members (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 organization_id uuid NOT NULL, school_id uuid NOT NULL, UNIQUE(principal_id,organization_id,school_id),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE hon.community_profiles (
 member_id uuid NOT NULL REFERENCES hon.community_members(id) ON DELETE RESTRICT, version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 60), enabled boolean NOT NULL,
 source text NOT NULL CHECK(source='HUMAN_UI'), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(member_id,version)
);
CREATE TABLE hon.community_content (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES hon.community_members(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN('TOPIC','POST','COMMENT')), parent_id uuid REFERENCES hon.community_content(id) ON DELETE RESTRICT,
 CHECK((kind='TOPIC')=(parent_id IS NULL))
);
CREATE INDEX community_children ON hon.community_content(parent_id,id);
CREATE TABLE hon.community_versions (
 content_id uuid NOT NULL REFERENCES hon.community_content(id) ON DELETE RESTRICT, version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998),
 title text NOT NULL CHECK(length(title)<=120), body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
 status text NOT NULL CHECK(status IN('DRAFT','PUBLISHED','ARCHIVED')), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),
 source text NOT NULL CHECK(source='HUMAN_UI'), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(content_id,version)
);
CREATE TABLE hon.community_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 response jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE hon.community_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT, operation text NOT NULL CHECK(operation IN('PROFILE','CONSENT','CONTENT')),
 entity_id uuid NOT NULL, version integer NOT NULL, request_id uuid NOT NULL, source text NOT NULL CHECK(source='HUMAN_UI'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE FUNCTION hon.guard_community_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_COMMUNITY_HISTORY' USING ERRCODE='42501'; END $$;
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT unnest(ARRAY['community_verifications','community_organizations','community_members','community_profiles','community_content','community_versions','community_requests','community_events']) LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  IF t<>'community_verifications' THEN
   EXECUTE format('CREATE TRIGGER community_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_community_history()',t);
   EXECUTE format('CREATE TRIGGER community_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_community_history()',t);
  END IF;
 END LOOP;
END $$;
-- FORCE RLS with no policies. Runtime, browsers, parents, school staff and HQ have no direct row/column grants.
CREATE FUNCTION hon.community_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT permission IN('community.participate','community.organization.manage') AND hon.staff_member_eligible(actor,org,school)
 AND EXISTS(SELECT 1 FROM hon.community_verifications v WHERE v.principal_id=actor AND v.organization_id=org AND v.school_id=school
  AND v.revoked_at IS NULL AND v.verified_at<=clock_timestamp() AND (v.effective_until IS NULL OR v.effective_until>clock_timestamp())
  AND (permission<>'community.organization.manage' OR v.capacity='OWNER'))
 AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=permission
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=school) AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
 AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier IN('ESSENTIAL','CORE','COMPLETE') AND e.status='ACTIVE'
 AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;
CREATE FUNCTION hon.resolve_community_scope(subject text,p_school uuid) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT DISTINCT p.id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND g.school_id=p_school AND hon.community_permission(p.id,g.organization_id,g.school_id,'community.participate')
$$;
CREATE FUNCTION hon.community_member_active(member uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT EXISTS(SELECT 1 FROM hon.community_members m WHERE m.id=member AND hon.community_permission(m.principal_id,m.organization_id,m.school_id,'community.participate')
 AND coalesce((SELECT enabled FROM hon.community_organizations WHERE organization_id=m.organization_id ORDER BY version DESC LIMIT 1),false)
 AND coalesce((SELECT enabled FROM hon.community_profiles WHERE member_id=m.id ORDER BY version DESC LIMIT 1),false))
$$;
CREATE FUNCTION hon.require_community_actor(subject text,participating boolean) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; member uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=subject AND p.id::text=current_setting('app.hon_principal_id',true);
 IF actor IS NULL OR NOT hon.community_permission(actor,org,school,'community.participate') THEN RAISE EXCEPTION 'COMMUNITY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT id INTO member FROM hon.community_members WHERE principal_id=actor AND organization_id=org AND school_id=school;
 IF participating AND (member IS NULL OR NOT hon.community_member_active(member)) THEN RAISE EXCEPTION 'COMMUNITY_OPT_IN_REQUIRED' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_community_actor(subject text,participating boolean) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 -- Serialize community versions/consent/receipts; this is not a worker, trigger or moderation process.
 PERFORM pg_advisory_xact_lock(81810081);
 actor:=hon.require_community_actor(subject,participating);
 PERFORM 1 FROM hon.organizations WHERE id=org FOR SHARE;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org FOR SHARE;
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR SHARE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR SHARE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 PERFORM 1 FROM hon.community_verifications WHERE principal_id=actor AND organization_id=org AND school_id=school FOR SHARE;
 RETURN hon.require_community_actor(subject,participating);
END $$;
CREATE FUNCTION hon.community_text(v text,maximum integer,allow_empty boolean,multiline boolean) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT v IS NOT NULL AND length(v) BETWEEN (CASE WHEN allow_empty THEN 0 ELSE 1 END) AND maximum
 AND btrim(v,E' \t\n\r'||chr(11)||chr(12)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))=v
 AND (CASE WHEN multiline THEN replace(v,E'\n','') ELSE v END) !~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]'
 AND v !~* '[<>@\\]|[a-z][a-z0-9+.-]*:/|(?:https?|ftp|file|data|javascript|mailto|tel):|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\y|/)|\+?[0-9][0-9 ()-]{6,}[0-9]'
$$;
CREATE FUNCTION hon.validate_community_input(op text,p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE keys text[];
BEGIN
 keys:=CASE op WHEN 'CONTENT' THEN ARRAY['expectedVersion','kind','parentId','title','body','status','reason'] WHEN 'PROFILE' THEN ARRAY['expectedVersion','displayName','enabled'] WHEN 'CONSENT' THEN ARRAY['expectedVersion','enabled'] END;
 IF keys IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) OR NOT p ?& keys OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number'
 OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'expectedVersion')::numeric>999999997 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF op IN('PROFILE','CONSENT') THEN
  IF jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean' OR (op='PROFILE' AND (jsonb_typeof(p->'displayName') IS DISTINCT FROM 'string' OR NOT hon.community_text(p->>'displayName',60,false,false))) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 ELSE
  IF jsonb_typeof(p->'kind') IS DISTINCT FROM 'string' OR p->>'kind' NOT IN('TOPIC','POST','COMMENT') OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN('DRAFT','PUBLISHED','ARCHIVED')
  OR ((p->>'kind'='TOPIC')<>(p->'parentId'='null'::jsonb)) OR (p->'parentId'<>'null'::jsonb AND (jsonb_typeof(p->'parentId') IS DISTINCT FROM 'string' OR p->>'parentId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
  OR jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR NOT hon.community_text(p->>'title',120,p->>'kind'='COMMENT',false) OR (p->>'kind'='COMMENT' AND p->>'title'<>'')
  OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR NOT hon.community_text(p->>'body',4000,false,true)
  OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR NOT hon.community_text(p->>'reason',300,false,false)
  OR (p->>'expectedVersion'='0' AND p->>'status'<>'DRAFT') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
END $$;
CREATE FUNCTION hon.community_visible(p_id uuid,actor uuid,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.community_content%ROWTYPE; state text;
BEGIN
 IF depth>2 THEN RETURN false; END IF;
 SELECT * INTO c FROM hon.community_content WHERE id=p_id; IF NOT FOUND OR NOT hon.community_member_active(c.member_id) THEN RETURN false; END IF;
 SELECT status INTO state FROM hon.community_versions WHERE content_id=p_id ORDER BY version DESC LIMIT 1;
 IF depth>0 THEN
  IF state IS DISTINCT FROM 'PUBLISHED' THEN RETURN false; END IF;
 ELSIF state IS DISTINCT FROM 'PUBLISHED' AND NOT EXISTS(SELECT 1 FROM hon.community_members WHERE id=c.member_id AND principal_id=actor AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN RETURN false;
 END IF;
 IF c.parent_id IS NOT NULL AND NOT hon.community_visible(c.parent_id,actor,depth+1) THEN RETURN false; END IF;
 RETURN state IS NOT NULL;
END $$;
CREATE FUNCTION hon.community_projection(p_id uuid,actor uuid,p_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.community_content%ROWTYPE; v hon.community_versions%ROWTYPE; own boolean; display text;
BEGIN
 IF NOT hon.community_visible(p_id,actor) THEN RAISE EXCEPTION 'COMMUNITY_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 SELECT * INTO c FROM hon.community_content WHERE id=p_id;
 SELECT * INTO v FROM hon.community_versions WHERE content_id=p_id AND (p_version IS NULL OR version=p_version) ORDER BY version DESC LIMIT 1;
 own:=EXISTS(SELECT 1 FROM hon.community_members WHERE id=c.member_id AND principal_id=actor AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id());
 IF v.version IS NULL OR (p_version IS NOT NULL AND NOT own) THEN RAISE EXCEPTION 'COMMUNITY_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 SELECT display_name INTO display FROM hon.community_profiles WHERE member_id=c.member_id ORDER BY version DESC LIMIT 1;
 RETURN jsonb_build_object('id',c.id,'version',v.version,'kind',c.kind,'parentId',c.parent_id,'title',v.title,'body',v.body,'status',v.status,'displayName',display,'canEdit',own,'reason',CASE WHEN own THEN v.reason ELSE NULL END,'recordedAt',to_char(v.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;
CREATE FUNCTION hon.read_community_profile(subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; member uuid; p hon.community_profiles%ROWTYPE; o hon.community_organizations%ROWTYPE;
BEGIN
 actor:=hon.lock_community_actor(subject,false);
 SELECT id INTO member FROM hon.community_members WHERE principal_id=actor AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
 SELECT * INTO p FROM hon.community_profiles WHERE member_id=member ORDER BY version DESC LIMIT 1;
 SELECT * INTO o FROM hon.community_organizations WHERE organization_id=hon.current_organization_id() ORDER BY version DESC LIMIT 1;
 RETURN jsonb_build_object('version',coalesce(p.version,0),'displayName',coalesce(p.display_name,''),'enabled',coalesce(p.enabled,false),'organizationVersion',coalesce(o.version,0),'organizationEnabled',coalesce(o.enabled,false),'canManageOrganization',hon.community_permission(actor,hon.current_organization_id(),hon.current_school_id(),'community.organization.manage'),'humanOnly',true,'executionAllowed',false);
END $$;
CREATE FUNCTION hon.mutate_community(subject text,op text,p_id uuid,p jsonb,key text,request uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); member uuid; record_id uuid:=p_id; n integer;
 receipt hon.community_requests%ROWTYPE; fp text; result jsonb; c hon.community_content%ROWTYPE; prior hon.community_versions%ROWTYPE; parent_kind text;
BEGIN
 PERFORM hon.validate_community_input(op,p);
 IF key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key ~ '[[:cntrl:]]' OR request IS NULL OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
 OR (op<>'CONTENT' AND p_id IS NOT NULL) OR (op='CONTENT' AND ((p_id IS NULL)<>(p->>'expectedVersion'='0'))) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_community_actor(subject,op='CONTENT');
 IF op='CONSENT' AND NOT hon.community_permission(actor,org,school,'community.organization.manage') THEN RAISE EXCEPTION 'COMMUNITY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_object('op',op,'id',p_id,'input',p)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM hon.community_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
 IF FOUND THEN
  IF receipt.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF op='CONTENT' THEN
   record_id:=(receipt.response->>'id')::uuid;
   IF NOT hon.community_visible(record_id,actor) THEN RAISE EXCEPTION 'COMMUNITY_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
   result:=hon.community_projection(record_id,actor,(receipt.response->>'version')::integer);
  ELSE result:=hon.read_community_profile(subject); END IF;
  PERFORM hon.require_community_actor(subject,op='CONTENT');
  RETURN jsonb_build_object('result',result,'replayed',true);
 END IF;
 SELECT id INTO member FROM hon.community_members WHERE principal_id=actor AND organization_id=org AND school_id=school;
 IF op='CONSENT' THEN
  SELECT coalesce(max(version),0) INTO n FROM hon.community_organizations WHERE organization_id=org;
  IF n<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  n:=n+1; INSERT INTO hon.community_organizations(organization_id,version,enabled,actor_principal_id,source) VALUES(org,n,(p->>'enabled')::boolean,actor,'HUMAN_UI'); record_id:=org;
 ELSIF op='PROFILE' THEN
  IF member IS NULL THEN INSERT INTO hon.community_members(principal_id,organization_id,school_id) VALUES(actor,org,school) RETURNING id INTO member; END IF;
  SELECT coalesce(max(version),0) INTO n FROM hon.community_profiles WHERE member_id=member;
  IF n<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  n:=n+1; INSERT INTO hon.community_profiles(member_id,version,display_name,enabled,source) VALUES(member,n,p->>'displayName',(p->>'enabled')::boolean,'HUMAN_UI'); record_id:=member;
 ELSE
  IF p_id IS NOT NULL THEN
   SELECT * INTO c FROM hon.community_content WHERE id=p_id AND member_id=member;
   IF NOT FOUND OR NOT hon.community_visible(p_id,actor) THEN RAISE EXCEPTION 'COMMUNITY_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
   SELECT * INTO prior FROM hon.community_versions WHERE content_id=p_id ORDER BY version DESC LIMIT 1;
   IF c.kind<>p->>'kind' OR c.parent_id IS DISTINCT FROM (p->>'parentId')::uuid THEN RAISE EXCEPTION 'IMMUTABLE_LINK' USING ERRCODE='22023'; END IF;
   IF prior.status='ARCHIVED' OR (prior.status='PUBLISHED' AND p->>'status'='DRAFT') OR (p->>'status'='ARCHIVED' AND (prior.title<>p->>'title' OR prior.body<>p->>'body')) THEN RAISE EXCEPTION 'LIFECYCLE_CONFLICT' USING ERRCODE='40001'; END IF;
  END IF;
  IF p->'parentId'<>'null'::jsonb THEN
   SELECT kind INTO parent_kind FROM hon.community_content WHERE id=(p->>'parentId')::uuid;
   IF parent_kind IS DISTINCT FROM (CASE WHEN p->>'kind'='POST' THEN 'TOPIC' ELSE 'POST' END) OR NOT hon.community_visible((p->>'parentId')::uuid,actor,1) THEN RAISE EXCEPTION 'COMMUNITY_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  END IF;
  n:=coalesce(prior.version,0); IF n<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p_id IS NULL THEN INSERT INTO hon.community_content(member_id,kind,parent_id) VALUES(member,p->>'kind',(p->>'parentId')::uuid) RETURNING id INTO record_id; END IF;
  n:=n+1; INSERT INTO hon.community_versions(content_id,version,title,body,status,reason,source) VALUES(record_id,n,p->>'title',p->>'body',p->>'status',p->>'reason','HUMAN_UI');
 END IF;
 result:=CASE WHEN op='CONTENT' THEN hon.community_projection(record_id,actor) ELSE hon.read_community_profile(subject) END;
 -- Community-private redacted human audit only; no global school audit body, no outbox or consumer.
 INSERT INTO hon.community_events(organization_id,school_id,actor_principal_id,operation,entity_id,version,request_id,source) VALUES(org,school,actor,op,record_id,n,request,'HUMAN_UI');
 INSERT INTO hon.community_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,key,fp,CASE WHEN op='CONTENT' THEN jsonb_build_object('id',record_id,'version',n) ELSE jsonb_build_object('version',n) END);
 PERFORM hon.require_community_actor(subject,op='CONTENT');
 RETURN jsonb_build_object('result',result,'replayed',false);
END $$;
CREATE FUNCTION hon.read_community(subject text,p_kind text,p_parent uuid,p_id uuid,after_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; ids uuid[]; items jsonb; cursor uuid;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('TOPIC','POST','COMMENT') OR ((p_kind='TOPIC')<>(p_parent IS NULL)) OR (p_id IS NOT NULL AND after_id IS NOT NULL) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_community_actor(subject,true);
 IF p_parent IS NOT NULL AND NOT hon.community_visible(p_parent,actor,1) THEN RAISE EXCEPTION 'COMMUNITY_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF p_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM hon.community_content WHERE id=p_id AND kind=p_kind AND parent_id IS NOT DISTINCT FROM p_parent) THEN RAISE EXCEPTION 'COMMUNITY_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN hon.community_projection(p_id,actor);
 END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT c.id FROM hon.community_content c WHERE c.kind=p_kind AND c.parent_id IS NOT DISTINCT FROM p_parent AND (after_id IS NULL OR c.id>after_id) AND hon.community_visible(c.id,actor) ORDER BY c.id LIMIT 31) q;
 IF cardinality(ids)>30 THEN cursor:=ids[30]; ids:=ids[1:30]; END IF;
 SELECT coalesce(jsonb_agg(hon.community_projection(id,actor) ORDER BY id),'[]'::jsonb) INTO items FROM unnest(ids) id;
 PERFORM hon.require_community_actor(subject,true);
 RETURN jsonb_build_object('items',items,'nextAfter',cursor,'humanOnly',true,'executionAllowed',false);
END $$;
CREATE FUNCTION hon.read_community_history(subject text,p_id uuid,before_version integer) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; versions integer[]; items jsonb; cursor integer;
BEGIN
 IF p_id IS NULL OR (before_version IS NOT NULL AND before_version NOT BETWEEN 1 AND 999999998) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_community_actor(subject,true);
 IF NOT hon.community_visible(p_id,actor) OR NOT EXISTS(SELECT 1 FROM hon.community_content c JOIN hon.community_members m ON m.id=c.member_id WHERE c.id=p_id AND m.principal_id=actor AND m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'COMMUNITY_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 SELECT array_agg(version ORDER BY version DESC) INTO versions FROM (SELECT version FROM hon.community_versions WHERE content_id=p_id AND (before_version IS NULL OR version<before_version) ORDER BY version DESC LIMIT 31) q;
 IF cardinality(versions)>30 THEN cursor:=versions[30]; versions:=versions[1:30]; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'status',status,'recordedAt',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY version DESC),'[]'::jsonb) INTO items FROM hon.community_versions WHERE content_id=p_id AND version=ANY(versions);
 PERFORM hon.require_community_actor(subject,true);
 RETURN jsonb_build_object('id',p_id,'items',items,'nextBefore',cursor,'humanOnly',true,'executionAllowed',false);
END $$;
DO $$ DECLARE f record; t text; r text; BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='hon'::regnamespace AND (proname LIKE '%community%' OR proname='resolve_community_scope') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 FOR t IN SELECT unnest(ARRAY['community_verifications','community_organizations','community_members','community_profiles','community_content','community_versions','community_requests','community_events']) LOOP
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_community_scope(text,uuid),hon.read_community_profile(text),hon.mutate_community(text,text,uuid,jsonb,text,uuid),hon.read_community(text,text,uuid,uuid,uuid),hon.read_community_history(text,uuid,integer) TO hon_runtime;
 END IF;
END $$;
COMMIT;
