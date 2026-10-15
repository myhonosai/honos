BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Trusted marketplace migration owner required'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('marketplace.asset.read','Verified human owner curated descriptive asset browsing',true,false),
 ('marketplace.asset.manage','Verified human creator descriptive asset lifecycle',true,false),
 ('marketplace.selection.save','Verified human owner disabled review selection',true,false);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN('marketplace.asset.read','marketplace.asset.manage','marketplace.selection.save') ON CONFLICT DO NOTHING;
CREATE TABLE hon.marketplace_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid NOT NULL REFERENCES hon.community_members(id) ON DELETE RESTRICT
);
CREATE TABLE hon.marketplace_versions (
 asset_id uuid NOT NULL REFERENCES hon.marketplace_assets(id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999998), title text NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
 category text NOT NULL CHECK(category IN('OPERATIONS','STAFFING','CURRICULUM')), asset_kind text NOT NULL CHECK(asset_kind IN('TEMPLATE','BLUEPRINT')),
 target_module text NOT NULL CHECK(target_module IN('WORK_ITEMS','STAFF_PLANNING','CURRICULUM')), required_permissions text[] NOT NULL,
 release_notes text NOT NULL CHECK(length(release_notes) BETWEEN 1 AND 400), preview_text text NOT NULL CHECK(length(preview_text) BETWEEN 1 AND 1600),
 status text NOT NULL CHECK(status IN('DRAFT','PUBLISHED','ARCHIVED')), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(asset_id,version)
);
-- Trusted manual platform curation, not an HQ API or creator privilege. Every release needs new approval.
CREATE TABLE hon.marketplace_curations (
 asset_id uuid NOT NULL, asset_version integer NOT NULL, review_version integer NOT NULL CHECK(review_version BETWEEN 1 AND 999999998),
 decision text NOT NULL CHECK(decision IN('APPROVED','REVOKED')), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(asset_id,asset_version,review_version), FOREIGN KEY(asset_id,asset_version) REFERENCES hon.marketplace_versions(asset_id,version) ON DELETE RESTRICT
);
CREATE TABLE hon.marketplace_selections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT, asset_id uuid NOT NULL, asset_version integer NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version=1), status text NOT NULL DEFAULT 'REQUIRES_REVIEW' CHECK(status='REQUIRES_REVIEW'),
 enabled boolean NOT NULL DEFAULT false CHECK(NOT enabled), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(asset_id,asset_version) REFERENCES hon.marketplace_versions(asset_id,version) ON DELETE RESTRICT,
 UNIQUE(organization_id,school_id,principal_id,asset_id,asset_version)
);
CREATE TABLE hon.marketplace_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 entity_id uuid NOT NULL, version integer NOT NULL, operation text NOT NULL CHECK(operation IN('ASSET','SAVE')),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key), FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE hon.marketplace_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT, operation text NOT NULL CHECK(operation IN('ASSET','SAVE')),
 entity_id uuid NOT NULL, version integer NOT NULL, request_id uuid NOT NULL, source text NOT NULL CHECK(source='HUMAN_UI'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
-- A private inert ledger, deliberately NOT hon.outbox_events: no delivery worker or consumer can read it.
CREATE TABLE hon.marketplace_outbox (
 event_id uuid PRIMARY KEY REFERENCES hon.marketplace_events(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'INERT' CHECK(status='INERT'), execution_allowed boolean NOT NULL DEFAULT false CHECK(NOT execution_allowed)
);
CREATE FUNCTION hon.guard_marketplace_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_MARKETPLACE_HISTORY' USING ERRCODE='42501'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['marketplace_assets','marketplace_versions','marketplace_curations','marketplace_selections','marketplace_requests','marketplace_events','marketplace_outbox'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER marketplace_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_marketplace_history()',t);
  EXECUTE format('CREATE TRIGGER marketplace_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_marketplace_history()',t);
 END LOOP;
END $$;
CREATE FUNCTION hon.marketplace_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT permission IN('marketplace.asset.read','marketplace.asset.manage','marketplace.selection.save')
 AND hon.community_permission(actor,org,school,'community.participate')
 AND (permission='marketplace.asset.manage' OR EXISTS(SELECT 1 FROM hon.community_verifications WHERE principal_id=actor AND organization_id=org AND school_id=school AND capacity='OWNER'))
 AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=permission
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=school) AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;
CREATE FUNCTION hon.resolve_marketplace_scope(subject text,p_school uuid) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT s.* FROM hon.resolve_community_scope(subject,p_school) s WHERE
 hon.marketplace_permission(s.principal_id,s.organization_id,s.school_id,'marketplace.asset.read') OR hon.marketplace_permission(s.principal_id,s.organization_id,s.school_id,'marketplace.asset.manage')
$$;
CREATE FUNCTION hon.require_marketplace_actor(subject text,permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
 actor:=hon.require_community_actor(subject,true);
 IF NOT hon.marketplace_permission(actor,hon.current_organization_id(),hon.current_school_id(),permission) THEN RAISE EXCEPTION 'MARKETPLACE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_marketplace_member(member uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE m hon.community_members%ROWTYPE;
BEGIN
 SELECT * INTO m FROM hon.community_members WHERE id=member;
 IF NOT FOUND THEN RAISE EXCEPTION 'MARKETPLACE_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=m.organization_id FOR SHARE;
 PERFORM 1 FROM hon.schools WHERE id=m.school_id AND organization_id=m.organization_id FOR SHARE;
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=m.principal_id) FOR SHARE;
 PERFORM 1 FROM hon.principals WHERE id=m.principal_id FOR SHARE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=m.principal_id AND organization_id=m.organization_id AND school_id=m.school_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=m.principal_id AND organization_id=m.organization_id AND school_id=m.school_id) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=m.principal_id AND organization_id=m.organization_id AND school_id=m.school_id) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=m.organization_id FOR SHARE;
 PERFORM 1 FROM hon.community_verifications WHERE principal_id=m.principal_id AND organization_id=m.organization_id AND school_id=m.school_id FOR SHARE;
END $$;
CREATE FUNCTION hon.lock_marketplace_actor(subject text,permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 PERFORM hon.lock_community_actor(subject,true);
 RETURN hon.require_marketplace_actor(subject,permission);
END $$;
CREATE FUNCTION hon.marketplace_text(v text,maximum integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT hon.community_text(v,maximum,false,false) AND v !~* '[{}\[\]`$=;]|\y(password|credential|secret|token|api[_ -]?key|bearer|ssh|select|insert|delete|script|javascript|python|curl|eval|function|import|require|https?)\y'
$$;
CREATE FUNCTION hon.validate_marketplace_input(op text,p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE keys text[]; allowed text[]; perms text[];
BEGIN
 keys:=CASE op WHEN 'ASSET' THEN ARRAY['expectedVersion','title','category','assetKind','targetModule','requiredPermissions','releaseNotes','previewText','status'] WHEN 'SAVE' THEN ARRAY['expectedVersion','assetVersion'] END;
 IF keys IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) OR NOT p ?& keys
 OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'expectedVersion')::numeric>999999997 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF op='SAVE' THEN
  IF p->>'expectedVersion'<>'0' OR jsonb_typeof(p->'assetVersion') IS DISTINCT FROM 'number' OR p->>'assetVersion' !~ '^[1-9][0-9]{0,8}$' OR (p->>'assetVersion')::numeric>999999998 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 ELSE
  IF jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR NOT hon.marketplace_text(p->>'title',100)
  OR jsonb_typeof(p->'releaseNotes') IS DISTINCT FROM 'string' OR NOT hon.marketplace_text(p->>'releaseNotes',400)
  OR jsonb_typeof(p->'previewText') IS DISTINCT FROM 'string' OR NOT hon.marketplace_text(p->>'previewText',1600)
  OR p->>'category' NOT IN('OPERATIONS','STAFFING','CURRICULUM') OR jsonb_typeof(p->'category') IS DISTINCT FROM 'string'
  OR p->>'assetKind' NOT IN('TEMPLATE','BLUEPRINT') OR jsonb_typeof(p->'assetKind') IS DISTINCT FROM 'string'
  OR p->>'targetModule' NOT IN('WORK_ITEMS','STAFF_PLANNING','CURRICULUM') OR jsonb_typeof(p->'targetModule') IS DISTINCT FROM 'string'
  OR p->>'status' NOT IN('DRAFT','PUBLISHED','ARCHIVED') OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string'
  OR (p->>'expectedVersion'='0' AND p->>'status'<>'DRAFT') OR jsonb_typeof(p->'requiredPermissions') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  allowed:=CASE p->>'targetModule' WHEN 'WORK_ITEMS' THEN ARRAY['work_item.read','work_item.manage'] WHEN 'STAFF_PLANNING' THEN ARRAY['staff.availability.manage'] ELSE ARRAY['curriculum.manage'] END;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'requiredPermissions') x WHERE jsonb_typeof(x)<>'string') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT array_agg(x) INTO perms FROM jsonb_array_elements_text(p->'requiredPermissions') x;
  IF cardinality(perms) IS NULL OR cardinality(perms) NOT BETWEEN 1 AND cardinality(allowed) OR NOT perms<@allowed OR perms IS DISTINCT FROM ARRAY(SELECT DISTINCT x FROM unnest(perms) x ORDER BY x) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
END $$;
CREATE FUNCTION hon.review_marketplace_asset(p_id uuid,p_version integer,decision text) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE n integer;
BEGIN
 -- SECURITY INVOKER and owner-only EXECUTE. No user-supplied review or automated moderation.
 PERFORM pg_advisory_xact_lock(81810081);
 IF decision NOT IN('APPROVED','REVOKED') OR decision IS NULL OR NOT EXISTS(SELECT 1 FROM hon.marketplace_versions WHERE asset_id=p_id AND version=p_version AND status='PUBLISHED')
 OR (decision='APPROVED' AND p_version<>(SELECT max(version) FROM hon.marketplace_versions WHERE asset_id=p_id)) THEN RAISE EXCEPTION 'CURATION_CONFLICT' USING ERRCODE='22023'; END IF;
 SELECT coalesce(max(review_version),0)+1 INTO n FROM hon.marketplace_curations WHERE asset_id=p_id AND asset_version=p_version;
 INSERT INTO hon.marketplace_curations(asset_id,asset_version,review_version,decision) VALUES(p_id,p_version,n,decision);
END $$;
CREATE FUNCTION hon.marketplace_visible(p_id uuid,p_version integer DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE m hon.community_members%ROWTYPE; v hon.marketplace_versions%ROWTYPE;
BEGIN
 SELECT cm.* INTO m FROM hon.marketplace_assets a JOIN hon.community_members cm ON cm.id=a.member_id WHERE a.id=p_id;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM hon.lock_marketplace_member(m.id);
 SELECT * INTO v FROM hon.marketplace_versions WHERE asset_id=p_id ORDER BY version DESC LIMIT 1;
 RETURN v.status='PUBLISHED' AND (p_version IS NULL OR v.version=p_version) AND hon.community_member_active(m.id)
 AND hon.marketplace_permission(m.principal_id,m.organization_id,m.school_id,'marketplace.asset.manage')
 AND coalesce((SELECT decision='APPROVED' FROM hon.marketplace_curations WHERE asset_id=p_id AND asset_version=v.version ORDER BY review_version DESC LIMIT 1),false);
END $$;
CREATE FUNCTION hon.marketplace_projection(p_id uuid,p_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',asset_id,'version',version,'title',title,'category',category,'assetKind',asset_kind,'targetModule',target_module,
 'requiredPermissions',required_permissions,'releaseNotes',release_notes,'previewText',preview_text,'status',status)
 FROM hon.marketplace_versions WHERE asset_id=p_id AND (p_version IS NULL OR version=p_version) ORDER BY version DESC LIMIT 1
$$;
CREATE FUNCTION hon.marketplace_selection_projection(p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.marketplace_selections%ROWTYPE;
BEGIN
 SELECT * INTO s FROM hon.marketplace_selections WHERE id=p_id;
 RETURN jsonb_build_object('id',s.id,'assetId',s.asset_id,'assetVersion',s.asset_version,'version',1,'status','REQUIRES_REVIEW','enabled',false,
 'asset',CASE WHEN hon.marketplace_permission(s.principal_id,s.organization_id,s.school_id,'marketplace.asset.read') AND hon.marketplace_visible(s.asset_id,s.asset_version) THEN hon.marketplace_projection(s.asset_id,s.asset_version) ELSE NULL END);
END $$;
CREATE FUNCTION hon.read_marketplace(subject text,mode text,p_id uuid DEFAULT NULL,after_id uuid DEFAULT NULL,before_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; member uuid; permission text; r record; result jsonb:='[]'; n integer:=0; last_id uuid; last_version integer;
BEGIN
 IF mode NOT IN('ACCESS','BROWSE','OWN','HISTORY','SAVED') OR mode IS NULL OR (p_id IS NOT NULL AND after_id IS NOT NULL)
 OR (mode IN('ACCESS','SAVED') AND p_id IS NOT NULL) OR (mode='ACCESS' AND after_id IS NOT NULL)
 OR (mode='HISTORY' AND (p_id IS NULL OR after_id IS NOT NULL)) OR (mode<>'HISTORY' AND before_version IS NOT NULL)
 OR (before_version IS NOT NULL AND before_version NOT BETWEEN 1 AND 999999998) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 permission:=CASE WHEN mode IN('OWN','HISTORY') THEN 'marketplace.asset.manage' WHEN mode='SAVED' THEN 'marketplace.selection.save' ELSE 'marketplace.asset.read' END;
 IF mode='ACCESS' THEN
  PERFORM hon.lock_community_actor(subject,true); actor:=hon.require_community_actor(subject,true);
  RETURN jsonb_build_object('canBrowse',hon.marketplace_permission(actor,hon.current_organization_id(),hon.current_school_id(),'marketplace.asset.read'),
   'canCreate',hon.marketplace_permission(actor,hon.current_organization_id(),hon.current_school_id(),'marketplace.asset.manage'),
   'canSave',hon.marketplace_permission(actor,hon.current_organization_id(),hon.current_school_id(),'marketplace.selection.save') AND hon.marketplace_permission(actor,hon.current_organization_id(),hon.current_school_id(),'marketplace.asset.read'),'executionAllowed',false);
 END IF;
 actor:=hon.lock_marketplace_actor(subject,permission);
 SELECT id INTO member FROM hon.community_members WHERE principal_id=actor AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
 IF mode='HISTORY' THEN
  IF NOT EXISTS(SELECT 1 FROM hon.marketplace_assets WHERE id=p_id AND member_id=member) THEN RAISE EXCEPTION 'MARKETPLACE_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  FOR r IN SELECT version,status FROM hon.marketplace_versions WHERE asset_id=p_id AND (before_version IS NULL OR version<before_version) ORDER BY version DESC LIMIT 30 LOOP
   n:=n+1; last_version:=r.version; result:=result||jsonb_build_array(jsonb_build_object('version',r.version,'status',r.status));
  END LOOP;
  PERFORM hon.require_marketplace_actor(subject,permission);
  RETURN jsonb_build_object('id',p_id,'items',result,'nextBefore',CASE WHEN n=30 THEN last_version ELSE NULL END,'executionAllowed',false);
 ELSIF mode='SAVED' THEN
  FOR r IN SELECT id FROM hon.marketplace_selections WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND principal_id=actor AND (after_id IS NULL OR id>after_id) ORDER BY id LIMIT 30 LOOP
   n:=n+1; last_id:=r.id; result:=result||jsonb_build_array(hon.marketplace_selection_projection(r.id));
  END LOOP;
 ELSE
  FOR r IN SELECT id FROM hon.marketplace_assets WHERE (p_id IS NULL OR id=p_id) AND (after_id IS NULL OR id>after_id)
   AND (CASE WHEN mode='OWN' THEN member_id=member ELSE hon.marketplace_visible(id) END) ORDER BY id LIMIT 30 LOOP
   n:=n+1; last_id:=r.id; result:=result||jsonb_build_array(hon.marketplace_projection(r.id));
  END LOOP;
 END IF;
 PERFORM hon.require_marketplace_actor(subject,permission);
 IF p_id IS NOT NULL THEN IF n=0 THEN RAISE EXCEPTION 'MARKETPLACE_UNAVAILABLE' USING ERRCODE='P0002'; END IF; RETURN result->0; END IF;
 RETURN jsonb_build_object('items',result,'nextAfter',CASE WHEN n=30 THEN last_id ELSE NULL END,'executionAllowed',false);
END $$;
CREATE FUNCTION hon.mutate_marketplace(subject text,op text,p_id uuid,p jsonb,key text,request uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; member uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); permission text;
 prior hon.marketplace_versions%ROWTYPE; receipt hon.marketplace_requests%ROWTYPE; fp text; result jsonb; record_id uuid:=p_id; n integer; event uuid;
BEGIN
 PERFORM hon.validate_marketplace_input(op,p);
 IF key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key ~ '[[:cntrl:]]' OR request IS NULL OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
 OR (op='SAVE' AND p_id IS NULL) OR (op='ASSET' AND ((p_id IS NULL)<>(p->>'expectedVersion'='0'))) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 permission:=CASE WHEN op='ASSET' THEN 'marketplace.asset.manage' ELSE 'marketplace.selection.save' END;
 actor:=hon.lock_marketplace_actor(subject,permission);
 SELECT id INTO member FROM hon.community_members WHERE principal_id=actor AND organization_id=org AND school_id=school;
 IF op='SAVE' THEN
  PERFORM hon.require_marketplace_actor(subject,'marketplace.asset.read');
  IF NOT hon.marketplace_visible(p_id,(p->>'assetVersion')::integer) THEN RAISE EXCEPTION 'MARKETPLACE_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 ELSIF p_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hon.marketplace_assets WHERE id=p_id AND member_id=member) THEN RAISE EXCEPTION 'MARKETPLACE_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_object('op',op,'id',p_id,'input',p)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM hon.marketplace_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
 IF FOUND THEN
  IF receipt.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  result:=CASE WHEN op='ASSET' THEN hon.marketplace_projection(receipt.entity_id,receipt.version) ELSE hon.marketplace_selection_projection(receipt.entity_id) END;
  PERFORM hon.require_marketplace_actor(subject,permission);
  RETURN jsonb_build_object('result',result,'replayed',true);
 END IF;
 IF op='ASSET' THEN
  SELECT * INTO prior FROM hon.marketplace_versions WHERE asset_id=p_id ORDER BY version DESC LIMIT 1;
  n:=coalesce(prior.version,0);
  IF n<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF prior.status='ARCHIVED' OR (prior.status='PUBLISHED' AND p->>'status'='DRAFT') OR
   (p->>'status'='ARCHIVED' AND hon.marketplace_projection(p_id)-ARRAY['id','version','status'] IS DISTINCT FROM p-ARRAY['expectedVersion','status']) THEN RAISE EXCEPTION 'LIFECYCLE_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p_id IS NULL THEN INSERT INTO hon.marketplace_assets(member_id) VALUES(member) RETURNING id INTO record_id; END IF;
  n:=n+1;
  INSERT INTO hon.marketplace_versions(asset_id,version,title,category,asset_kind,target_module,required_permissions,release_notes,preview_text,status)
  VALUES(record_id,n,p->>'title',p->>'category',p->>'assetKind',p->>'targetModule',ARRAY(SELECT jsonb_array_elements_text(p->'requiredPermissions')),p->>'releaseNotes',p->>'previewText',p->>'status');
  result:=hon.marketplace_projection(record_id,n);
 ELSE
  n:=1;
  INSERT INTO hon.marketplace_selections(organization_id,school_id,principal_id,asset_id,asset_version) VALUES(org,school,actor,p_id,(p->>'assetVersion')::integer)
   ON CONFLICT(organization_id,school_id,principal_id,asset_id,asset_version) DO NOTHING RETURNING id INTO record_id;
  IF record_id IS NULL THEN SELECT id INTO record_id FROM hon.marketplace_selections WHERE organization_id=org AND school_id=school AND principal_id=actor AND asset_id=p_id AND asset_version=(p->>'assetVersion')::integer; END IF;
  result:=hon.marketplace_selection_projection(record_id);
 END IF;
 INSERT INTO hon.marketplace_events(organization_id,school_id,actor_principal_id,operation,entity_id,version,request_id,source) VALUES(org,school,actor,op,record_id,n,request,'HUMAN_UI') RETURNING id INTO event;
 INSERT INTO hon.marketplace_outbox(event_id) VALUES(event);
 INSERT INTO hon.marketplace_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,entity_id,version,operation) VALUES(org,school,actor,key,fp,record_id,n,op);
 PERFORM hon.require_marketplace_actor(subject,permission);
 IF op='SAVE' THEN PERFORM hon.require_marketplace_actor(subject,'marketplace.asset.read'); IF NOT hon.marketplace_visible(p_id,(p->>'assetVersion')::integer) THEN RAISE EXCEPTION 'MARKETPLACE_UNAVAILABLE' USING ERRCODE='P0002'; END IF; END IF;
 RETURN jsonb_build_object('result',result,'replayed',false);
END $$;
-- Function ACLs and column revocations are deliberately closed even with inherited default ACLs.
DO $$ DECLARE r text; t text; a text; f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%marketplace%') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['marketplace_assets','marketplace_versions','marketplace_curations','marketplace_selections','marketplace_requests','marketplace_events','marketplace_outbox'] LOOP
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',a,t); END LOOP;
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOREACH t IN ARRAY ARRAY['marketplace_assets','marketplace_versions','marketplace_curations','marketplace_selections','marketplace_requests','marketplace_events','marketplace_outbox'] LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
   FOR a IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',a,t,r); END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%marketplace%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_marketplace_scope(text,uuid),hon.read_marketplace(text,text,uuid,uuid,integer),hon.mutate_marketplace(text,text,uuid,jsonb,text,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
