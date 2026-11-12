BEGIN;

-- B-SCH-3 part 3a (0268, reserved by the coordinator 2026-11-11): shared per-school branding for every public school page.
-- Owner request (David, 2026-11-11): "I need schedular and checkout pages customizable"; owner choice "Branded pages".
-- Spec: docs/architecture/SCHOOL_PAGE_BRANDING.md.
--   B1  One branding row per school: an optional logo image, an optional cover image, an optional accent color and an
--       optional one-line contact text. Images are https URLs only (no data:, javascript:, credentials, ports or quotes);
--       uploaded assets come later through the same field. No HTML anywhere.
--   B2  New staff-assignable permission school_branding.manage, initially granted to system OWNER roles only. HQ, family and
--       parent-type principals are refused (the 0258/0269 identity rules).
--   B3  Every save is a direct-human SECURITY DEFINER command with live permission re-checks, exact-request idempotency,
--       optimistic version, an append-only version snapshot, audit and an inert outbox event.
--   B4  read_public_school_branding(school) returns display fields only (school name, images, color, contact line) plus the
--       version and updatedAt, so a checkout receipt or booking can record which branding it showed. It answers only for an
--       ACTIVE school of an ACTIVE organization, and is otherwise null. It never returns ids, people, or settings history.
-- Nothing here takes a payment, sends a message, fetches an image or runs an automation.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School page branding requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School page branding requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'School page branding requires 0177 and 0224';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('school_branding.manage','See and change the school''s public page branding (logo, cover image, color, contact line)',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='school_branding.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'school_branding.manage already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'school_branding.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- B1: an image reference is null or a plain https URL: lower-case host, optional path and query of URL-safe characters only.
CREATE FUNCTION hon.school_branding_image_ok(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NULL OR (length(v) BETWEEN 12 AND 500
    AND v ~ '^https://[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(/[A-Za-z0-9._~%/+=&?-]*)?$')
$$;

-- B1: the closed branding shape the save takes and the read returns.
CREATE FUNCTION hon.school_branding_input_ok(b jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(b)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(b) k)=ARRAY['accentColor','contactLine','coverUrl','logoUrl']
    AND (jsonb_typeof(b->'logoUrl')='null' OR (jsonb_typeof(b->'logoUrl')='string' AND hon.school_branding_image_ok(b->>'logoUrl')))
    AND (jsonb_typeof(b->'coverUrl')='null' OR (jsonb_typeof(b->'coverUrl')='string' AND hon.school_branding_image_ok(b->>'coverUrl')))
    AND (jsonb_typeof(b->'accentColor')='null' OR (jsonb_typeof(b->'accentColor')='string' AND b->>'accentColor' ~ '^#[0-9a-f]{6}$'))
    AND (jsonb_typeof(b->'contactLine')='null' OR (jsonb_typeof(b->'contactLine')='string' AND length(b->>'contactLine') BETWEEN 1 AND 160
      AND btrim(b->>'contactLine')=b->>'contactLine' AND (b->>'contactLine') !~ '[<>[:cntrl:]]')),false)
$$;

CREATE TABLE hon.school_page_branding (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  logo_url text CHECK (hon.school_branding_image_ok(logo_url)),
  cover_url text CHECK (hon.school_branding_image_ok(cover_url)),
  accent_color text CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-f]{6}$'),
  contact_line text CHECK (contact_line IS NULL OR (length(contact_line) BETWEEN 1 AND 160 AND btrim(contact_line)=contact_line AND contact_line !~ '[<>[:cntrl:]]')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_page_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_page_branding FORCE ROW LEVEL SECURITY;

-- Append-only snapshot of every saved version.
CREATE TABLE hon.school_page_branding_versions (
  school_id uuid NOT NULL REFERENCES hon.school_page_branding(school_id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version>=1),
  organization_id uuid NOT NULL,
  branding jsonb NOT NULL CHECK (hon.school_branding_input_ok(branding)),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(school_id,version),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_page_branding_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_page_branding_versions FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_page_branding_versions_immutable BEFORE UPDATE OR DELETE ON hon.school_page_branding_versions
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_page_branding_versions_no_truncate BEFORE TRUNCATE ON hon.school_page_branding_versions
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_page_branding_no_truncate BEFORE TRUNCATE ON hon.school_page_branding
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Whoever writes: no delete; scope and creation facts never change; every update bumps the version by exactly one.
CREATE FUNCTION hon.guard_school_page_branding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'School page branding is never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'New school page branding starts at version 1' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.school_id<>OLD.school_id OR NEW.organization_id<>OLD.organization_id OR NEW.created_by_principal_id<>OLD.created_by_principal_id
    OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'School page branding scope and history are fixed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_page_branding_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_page_branding
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_page_branding();

-- B2: live direct-human authority at the current school, or a refusal. The identity rules are the 0258/0269 ones.
CREATE FUNCTION hon.require_school_branding_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SCHOOL_BRANDING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code='school_branding.manage' AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_BRANDING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The display fields only; an absent row is version 0 with every field null.
CREATE FUNCTION hon.school_page_branding_json(b hon.school_page_branding) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('logoUrl',b.logo_url,'coverUrl',b.cover_url,'accentColor',b.accent_color,'contactLine',b.contact_line,
    'version',coalesce(b.version,0),
    'updatedAt',CASE WHEN b.updated_at IS NULL THEN NULL ELSE to_char(b.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
$$;

-- Staff read of the current school's branding.
CREATE FUNCTION hon.read_school_page_branding(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; b hon.school_page_branding%ROWTYPE; result jsonb;
BEGIN
  actor:=hon.require_school_branding_actor(subject);
  SELECT * INTO b FROM hon.school_page_branding x WHERE x.organization_id=org AND x.school_id=school;
  result:=jsonb_build_object('branding',hon.school_page_branding_json(b));
  IF hon.require_school_branding_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BRANDING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Save: create (expectedVersion 0) or replace the current school's branding.
CREATE FUNCTION hon.save_school_page_branding(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; b hon.school_page_branding%ROWTYPE; before jsonb; next jsonb; result jsonb; expected integer; input jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['branding','expectedVersion']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT hon.school_branding_input_ok(p->'branding') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p->>'expectedVersion')::integer; input:=p->'branding';
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_branding.save','input',p)::text,'UTF8')),'hex');
  actor:=hon.require_school_branding_actor(subject);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_branding_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BRANDING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF hon.require_school_branding_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BRANDING_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior.response_body,'replayed',true);
  END IF;
  LOCK TABLE hon.school_page_branding IN ROW EXCLUSIVE MODE;
  PERFORM 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org FOR NO KEY UPDATE;
  SELECT * INTO b FROM hon.school_page_branding x WHERE x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF FOUND THEN
    IF b.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    before:=hon.school_page_branding_json(b);
    UPDATE hon.school_page_branding SET logo_url=input->>'logoUrl',cover_url=input->>'coverUrl',accent_color=input->>'accentColor',contact_line=input->>'contactLine',
      version=b.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE school_id=b.school_id RETURNING * INTO b;
  ELSE
    IF expected<>0 THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.school_page_branding(school_id,organization_id,logo_url,cover_url,accent_color,contact_line,created_by_principal_id,updated_by_principal_id)
      VALUES(school,org,input->>'logoUrl',input->>'coverUrl',input->>'accentColor',input->>'contactLine',actor,actor) RETURNING * INTO b;
  END IF;
  next:=hon.school_page_branding_json(b);
  INSERT INTO hon.school_page_branding_versions(school_id,version,organization_id,branding,actor_principal_id)
    VALUES(b.school_id,b.version,org,input,actor);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','school_branding.save','SCHOOL_PAGE_BRANDING',b.school_id,before,next,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'school_branding.saved',1,'SCHOOL_PAGE_BRANDING',b.school_id,b.version,correlation,request,jsonb_build_object('schoolId',b.school_id,'version',b.version));
  result:=jsonb_build_object('branding',next);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_branding_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_BRANDING_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- B4: public display branding of an ACTIVE school of an ACTIVE organization, or null. Callers are server code that already
-- resolved the school from a public link (a booking link or a checkout page); the answer carries no ids and no people.
CREATE FUNCTION hon.read_public_school_branding(selected uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.schools%ROWTYPE; b hon.school_page_branding%ROWTYPE;
BEGIN
  IF selected IS NULL THEN RETURN NULL; END IF;
  SELECT x.* INTO s FROM hon.schools x JOIN hon.organizations o ON o.id=x.organization_id AND o.status='ACTIVE' WHERE x.id=selected AND x.status='ACTIVE';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO b FROM hon.school_page_branding x WHERE x.school_id=s.id AND x.organization_id=s.organization_id;
  RETURN jsonb_build_object('schoolName',s.name) || hon.school_page_branding_json(b);
END $$;

DO $$ DECLARE r record; t text; col text;
  private_fns text:='hon.school_branding_image_ok(text),hon.school_branding_input_ok(jsonb),hon.guard_school_page_branding(),'
    'hon.require_school_branding_actor(text),hon.school_page_branding_json(hon.school_page_branding)';
  entry_fns text:='hon.read_school_page_branding(text),hon.save_school_page_branding(text,jsonb,text,uuid,uuid),hon.read_public_school_branding(uuid)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM PUBLIC',private_fns,entry_fns);
  FOREACH t IN ARRAY ARRAY['school_page_branding','school_page_branding_versions'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
    END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM %I',private_fns,entry_fns,r.rolname);
    FOREACH t IN ARRAY ARRAY['school_page_branding','school_page_branding_versions'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r.rolname);
      FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r.rolname);
      END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',entry_fns);
  END IF;
END $$;
DO $$ DECLARE t text; BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH t IN ARRAY ARRAY['hon.school_page_branding','hon.school_page_branding_versions'] LOOP
      IF has_table_privilege('hon_runtime',t,'SELECT') OR has_any_column_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
        OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
        RAISE EXCEPTION 'School page branding must not widen runtime privileges';
      END IF;
    END LOOP;
  END IF;
END $$;
COMMIT;
