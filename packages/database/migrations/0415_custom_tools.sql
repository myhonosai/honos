BEGIN;

-- AI Customizer CM-1 (0415, coordinator-allocated 2026-11-16; first drafted as 0362): the custom tool framework. A school builds its own tool
-- (for example a Demo Team or Leadership Points section) as a closed, versioned JSON definition: record types and their
-- fields, tables, forms and dashboards, the tool's own navigation, and access per school role. Fixed reviewed code runs
-- every definition; nothing here lets an AI model or a person write code, SQL, a policy or a permission.
-- - custom_tool.design (sensitive, OWNER backfill): create and change drafts, publish, discard, restore, archive.
-- - custom_tool.use (OWNER backfill): the base gate to read and work with published tools. Each tool's own access rules
--   then give a school role VIEW, CREATE, EDIT and ARCHIVE on that tool. Designers hold all four. A rule never grants a
--   platform permission, and parent, family, student, HQ and platform roles can never be named.
-- - Versions: a tool has at most one DRAFT and one PUBLISHED version; publishing supersedes the previous one, and a
--   published version never changes. Restore copies an earlier version into a new DRAFT.
-- - A field key keeps its type (and a record link its target) in every version of its tool, so every earlier version can
--   be restored without making a stored record invalid. A field taken out of a version is hidden, and its values are kept.
-- - Records are validated against the published definition on every write; links must point to this school's own
--   students, staff and records of the same tool. A DRAFT can hold preview records that are never mixed with live ones.
-- - Direct human from HUMAN_UI only, live organization, school and entitlement, authority checked again after writes.
--   Identifier-only audit; outbox custom_tool.* events (schema version 1) carry ids only, for Automation to subscribe to.
-- - Limits: 25 tools per school, 32 KB per definition, 8 KB per record, 50,000 live records per tool, 2,000 preview
--   records per draft.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.saas_ts(timestamp with time zone)') IS NULL
    OR to_regclass('hon.student_profiles') IS NULL THEN RAISE EXCEPTION '0415 requires 0023, 0059 and 0154'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('custom_tool.design','Design, publish and restore the school''s own custom tools',true,true),
  ('custom_tool.use','Use the school''s published custom tools, as each tool''s access rules allow',false,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,x FROM hon.roles r CROSS JOIN unnest(ARRAY['custom_tool.design','custom_tool.use']) x
  WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

CREATE TABLE hon.custom_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  tool_key text NOT NULL CHECK (tool_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  latest_version integer NOT NULL CHECK (latest_version BETWEEN 1 AND 100000),
  published_version integer CHECK (published_version IS NULL OR published_version BETWEEN 1 AND latest_version),
  draft_version integer CHECK (draft_version IS NULL OR draft_version=latest_version),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,school_id,tool_key), UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE TABLE hon.custom_tool_versions (
  tool_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no BETWEEN 1 AND 100000),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object' AND length(definition::text)<=32768),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED','DISCARDED')),
  origin text NOT NULL CHECK (origin IN ('NEW','EDIT','RESTORE')), restored_from integer,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by_principal_id uuid REFERENCES hon.principals(id), published_at timestamptz,
  PRIMARY KEY (tool_id,version_no),
  FOREIGN KEY (tool_id,organization_id,school_id) REFERENCES hon.custom_tools(id,organization_id,school_id),
  CHECK ((origin='RESTORE')=(restored_from IS NOT NULL) AND (restored_from IS NULL OR restored_from<version_no)),
  CHECK ((status IN ('PUBLISHED','SUPERSEDED'))=(published_at IS NOT NULL) AND (published_at IS NULL)=(published_by_principal_id IS NULL))
);
CREATE UNIQUE INDEX custom_tool_versions_one_draft ON hon.custom_tool_versions (tool_id) WHERE status='DRAFT';
CREATE UNIQUE INDEX custom_tool_versions_one_published ON hon.custom_tool_versions (tool_id) WHERE status='PUBLISHED';
CREATE TABLE hon.custom_tool_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL, tool_id uuid NOT NULL,
  entity_key text NOT NULL CHECK (entity_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  preview_version integer CHECK (preview_version IS NULL OR preview_version>=1),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object' AND length(data::text)<=8192),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  archived_at timestamptz,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id), updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tool_id,organization_id,school_id) REFERENCES hon.custom_tools(id,organization_id,school_id)
);
CREATE INDEX custom_tool_records_list_idx ON hon.custom_tool_records (tool_id,entity_key,preview_version,created_at DESC,id DESC);
CREATE TABLE hon.custom_tool_record_events (
  record_id uuid NOT NULL REFERENCES hon.custom_tool_records(id), seq integer NOT NULL CHECK (seq>=1),
  kind text NOT NULL CHECK (kind IN ('CREATED','UPDATED','ARCHIVED','RESTORED')),
  data jsonb NOT NULL, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (record_id,seq)
);
CREATE TABLE hon.custom_tool_commands (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('SAVE_DRAFT','CHANGE','WRITE_RECORD')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['custom_tools','custom_tool_versions','custom_tool_records','custom_tool_record_events','custom_tool_commands'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- Evidence guard. Tools and records change only in place (never deleted); a version's definition changes only while it is
-- a DRAFT, and a published version only becomes SUPERSEDED; record history and command receipts never change.
CREATE FUNCTION hon.guard_custom_tools() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME IN ('custom_tools','custom_tool_records') THEN
      IF (to_jsonb(NEW)-ARRAY['status','latest_version','published_version','draft_version','revision','updated_at','data','version','archived_at','updated_by_principal_id'])
        = (to_jsonb(OLD)-ARRAY['status','latest_version','published_version','draft_version','revision','updated_at','data','version','archived_at','updated_by_principal_id']) THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='custom_tool_versions' THEN
      IF OLD.status='DRAFT' AND (to_jsonb(NEW)-ARRAY['definition','status','updated_at','published_by_principal_id','published_at'])
          = (to_jsonb(OLD)-ARRAY['definition','status','updated_at','published_by_principal_id','published_at']) THEN RETURN NEW; END IF;
      IF OLD.status='PUBLISHED' AND NEW.status='SUPERSEDED' AND (to_jsonb(NEW)-'status')=(to_jsonb(OLD)-'status') THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='custom_tool_commands' THEN
      IF OLD.response IS NULL AND NEW.response IS NOT NULL AND (to_jsonb(NEW)-ARRAY['response','completed_at'])=(to_jsonb(OLD)-ARRAY['response','completed_at']) THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'CUSTOM_TOOL_IMMUTABLE' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['custom_tools','custom_tool_versions','custom_tool_records','custom_tool_record_events','custom_tool_commands'] LOOP
    EXECUTE format('CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_custom_tools()',t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_custom_tools()',t);
  END LOOP;
END $$;

-- Does this person hold this permission through a live staff role at this school?
CREATE FUNCTION hon.custom_tool_holds(p_actor uuid,p_org uuid,p_school uuid,p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
    WHERE g.principal_id=p_actor AND g.organization_id=p_org AND g.school_id=p_school AND g.revoked_at IS NULL
      AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
      AND (r.management_school_id IS NULL OR r.management_school_id=p_school)
      AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
      AND x.code=p_permission AND x.is_staff_assignable);
$$;

-- A role a tool's access rule may name: this organization's role, usable at this school, never a family/HQ/platform role.
CREATE FUNCTION hon.custom_tool_role_eligible(p_role uuid,p_org uuid,p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.roles r WHERE r.id=p_role AND r.organization_id=p_org
    AND (r.management_school_id IS NULL OR r.management_school_id=p_school) AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)');
$$;

-- The direct human with live p_permission at the session school, live organization, school and entitlement.
CREATE FUNCTION hon.require_custom_tool_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_permission NOT IN ('custom_tool.design','custom_tool.use')
    OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 2048 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'CUSTOM_TOOL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND hon.staff_member_eligible(p.id,org,school)
    AND hon.custom_tool_holds(p.id,org,school,p_permission)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'CUSTOM_TOOL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Definition validator (schema version 1). It mirrors validateCustomToolDefinition in @hon/contracts; the database is the
-- authority. A refusal names the first problem's path in HINT.
CREATE FUNCTION hon.custom_tool_invalid(p_path text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'CUSTOM_TOOL_DEFINITION_INVALID' USING ERRCODE='22023',HINT=left(p_path,200); END $$;

-- An object with every required key and nothing outside required + optional.
CREATE FUNCTION hon.custom_tool_shape(p jsonb,p_required text[],p_optional text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN coalesce(jsonb_typeof(p),'')<>'object' THEN false ELSE
    NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT (k=ANY(p_required||p_optional)))
    AND NOT EXISTS(SELECT 1 FROM unnest(p_required) r WHERE NOT p ? r) END;
$$;
CREATE FUNCTION hon.custom_tool_key_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(p),'')='string' AND (p#>>'{}') ~ '^[a-z][a-z0-9_]{0,39}$';
$$;
-- A label in English (required), Korean and Spanish: trimmed plain text, 1..p_max characters, no control characters.
CREATE FUNCTION hon.custom_tool_label_ok(p jsonb,p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN coalesce(jsonb_typeof(p),'')<>'object' OR NOT p ? 'en' THEN false ELSE NOT EXISTS(
    SELECT 1 FROM jsonb_each(p) e WHERE e.key NOT IN ('en','ko','es') OR jsonb_typeof(e.value)<>'string'
      OR length(e.value#>>'{}') NOT BETWEEN 1 AND p_max OR (e.value#>>'{}')<>btrim(e.value#>>'{}') OR (e.value#>>'{}') ~ '[[:cntrl:]]') END;
$$;
-- A whole number of at most 12 digits, or any number of at most 12 integer digits when p_integer is false.
CREATE FUNCTION hon.custom_tool_number_ok(p jsonb,p_integer boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(p),'')='number' AND abs((p#>>'{}')::numeric)<=1000000000000 AND (NOT p_integer OR (p#>>'{}')::numeric=trunc((p#>>'{}')::numeric));
$$;
CREATE FUNCTION hon.custom_tool_unique_keys(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT (SELECT count(*) FROM jsonb_array_elements(p))=(SELECT count(DISTINCT x) FROM jsonb_array_elements(p) x);
$$;
CREATE FUNCTION hon.custom_tool_field(p_def jsonb,p_entity text,p_field text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT f FROM jsonb_array_elements(p_def->'entities') e, jsonb_array_elements(e->'fields') f WHERE e->>'key'=p_entity AND f->>'key'=p_field LIMIT 1;
$$;

CREATE FUNCTION hon.custom_tool_check_definition(p_def jsonb,p_org uuid,p_school uuid,p_tool uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE e jsonb; f jsonb; v jsonb; c jsonb; a jsonb; x jsonb; i integer; j integer; path text; t text;
  ekeys text[]:='{}'; fkeys text[]; vkeys text[]:='{}'; ckeys text[]; tgt jsonb;
BEGIN
  IF p_def IS NULL OR length(p_def::text)>32768
    OR NOT hon.custom_tool_shape(p_def,ARRAY['schemaVersion','name','icon','entities','views','navigation','access'],ARRAY['description'])
    OR p_def->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN PERFORM hon.custom_tool_invalid('definition'); END IF;
  IF NOT hon.custom_tool_label_ok(p_def->'name',80) THEN PERFORM hon.custom_tool_invalid('name'); END IF;
  IF p_def ? 'description' AND NOT hon.custom_tool_label_ok(p_def->'description',400) THEN PERFORM hon.custom_tool_invalid('description'); END IF;
  IF jsonb_typeof(p_def->'icon') IS DISTINCT FROM 'string' OR (p_def->>'icon') NOT IN
    ('star','trophy','users','calendar','clipboard','chart','box','flag','heart','shield','bolt','book') THEN PERFORM hon.custom_tool_invalid('icon'); END IF;
  IF jsonb_typeof(p_def->'entities') IS DISTINCT FROM 'array' OR jsonb_array_length(p_def->'entities') NOT BETWEEN 1 AND 10 THEN PERFORM hon.custom_tool_invalid('entities'); END IF;
  FOR i IN 0..jsonb_array_length(p_def->'entities')-1 LOOP
    e:=p_def->'entities'->i; path:='entities['||i||']';
    IF NOT hon.custom_tool_shape(e,ARRAY['key','label','fields'],'{}') OR NOT hon.custom_tool_key_ok(e->'key') OR (e->>'key')=ANY(ekeys)
      OR NOT hon.custom_tool_label_ok(e->'label',80) OR jsonb_typeof(e->'fields') IS DISTINCT FROM 'array'
      OR jsonb_array_length(e->'fields') NOT BETWEEN 1 AND 40 THEN PERFORM hon.custom_tool_invalid(path); END IF;
    ekeys:=ekeys||(e->>'key');
  END LOOP;
  FOR i IN 0..jsonb_array_length(p_def->'entities')-1 LOOP
    e:=p_def->'entities'->i; fkeys:='{}';
    FOR j IN 0..jsonb_array_length(e->'fields')-1 LOOP
      f:=e->'fields'->j; path:='entities['||i||'].fields['||j||']'; t:=f->>'type';
      IF NOT hon.custom_tool_key_ok(f->'key') OR (f->>'key')=ANY(fkeys) OR NOT hon.custom_tool_label_ok(f->'label',80)
        OR jsonb_typeof(f->'type') IS DISTINCT FROM 'string'
        OR t NOT IN ('TEXT','LONG_TEXT','INTEGER','NUMBER','BOOLEAN','DATE','CHOICE','MULTI_CHOICE','STUDENT_REF','STAFF_REF','RECORD_REF')
        OR (f ? 'required' AND jsonb_typeof(f->'required')<>'boolean') THEN PERFORM hon.custom_tool_invalid(path); END IF;
      IF t IN ('TEXT','LONG_TEXT') THEN
        IF NOT hon.custom_tool_shape(f,ARRAY['key','label','type'],ARRAY['required','maxLength'])
          OR (f ? 'maxLength' AND NOT (hon.custom_tool_number_ok(f->'maxLength',true)
            AND (f->>'maxLength')::numeric BETWEEN 1 AND CASE t WHEN 'TEXT' THEN 500 ELSE 4000 END)) THEN PERFORM hon.custom_tool_invalid(path); END IF;
      ELSIF t IN ('INTEGER','NUMBER') THEN
        IF NOT hon.custom_tool_shape(f,ARRAY['key','label','type'],ARRAY['required','min','max'])
          OR (f ? 'min' AND NOT hon.custom_tool_number_ok(f->'min',t='INTEGER')) OR (f ? 'max' AND NOT hon.custom_tool_number_ok(f->'max',t='INTEGER'))
          OR (f ? 'min' AND f ? 'max' AND (f->>'min')::numeric>(f->>'max')::numeric) THEN PERFORM hon.custom_tool_invalid(path); END IF;
      ELSIF t IN ('CHOICE','MULTI_CHOICE') THEN
        IF NOT hon.custom_tool_shape(f,ARRAY['key','label','type','choices'],ARRAY['required'])
          OR jsonb_typeof(f->'choices') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'choices') NOT BETWEEN 1 AND 50 THEN PERFORM hon.custom_tool_invalid(path); END IF;
        ckeys:='{}';
        FOR x IN SELECT * FROM jsonb_array_elements(f->'choices') LOOP
          IF NOT hon.custom_tool_shape(x,ARRAY['key','label'],'{}') OR NOT hon.custom_tool_key_ok(x->'key') OR (x->>'key')=ANY(ckeys)
            OR NOT hon.custom_tool_label_ok(x->'label',80) THEN PERFORM hon.custom_tool_invalid(path||'.choices'); END IF;
          ckeys:=ckeys||(x->>'key');
        END LOOP;
      ELSIF t='RECORD_REF' THEN
        IF NOT hon.custom_tool_shape(f,ARRAY['key','label','type','entity'],ARRAY['required']) OR NOT hon.custom_tool_key_ok(f->'entity')
          OR NOT (f->>'entity')=ANY(ekeys) THEN PERFORM hon.custom_tool_invalid(path||'.entity'); END IF;
      ELSIF NOT hon.custom_tool_shape(f,ARRAY['key','label','type'],ARRAY['required']) THEN PERFORM hon.custom_tool_invalid(path);
      END IF;
      -- Stability: the same field in any other saved version of this tool has the same type and link target.
      IF p_tool IS NOT NULL AND EXISTS(SELECT 1 FROM hon.custom_tool_versions tv, jsonb_array_elements(tv.definition->'entities') pe,
          jsonb_array_elements(pe->'fields') pf
        WHERE tv.tool_id=p_tool AND tv.status<>'DRAFT' AND pe->>'key'=e->>'key' AND pf->>'key'=f->>'key'
          AND (pf->>'type' IS DISTINCT FROM t OR (t='RECORD_REF' AND pf->>'entity' IS DISTINCT FROM f->>'entity'))) THEN
        PERFORM hon.custom_tool_invalid(path||'.type: a field keeps its type in every version'); END IF;
      fkeys:=fkeys||(f->>'key');
    END LOOP;
  END LOOP;
  IF jsonb_typeof(p_def->'views') IS DISTINCT FROM 'array' OR jsonb_array_length(p_def->'views') NOT BETWEEN 1 AND 20 THEN PERFORM hon.custom_tool_invalid('views'); END IF;
  FOR i IN 0..jsonb_array_length(p_def->'views')-1 LOOP
    v:=p_def->'views'->i; path:='views['||i||']'; t:=v->>'type';
    IF NOT hon.custom_tool_key_ok(v->'key') OR (v->>'key')=ANY(vkeys) OR NOT hon.custom_tool_label_ok(v->'label',80)
      OR NOT hon.custom_tool_key_ok(v->'entity') OR NOT (v->>'entity')=ANY(ekeys) OR jsonb_typeof(v->'type') IS DISTINCT FROM 'string' THEN PERFORM hon.custom_tool_invalid(path); END IF;
    IF t='TABLE' THEN
      IF NOT hon.custom_tool_shape(v,ARRAY['key','label','type','entity','columns'],ARRAY['sort'])
        OR jsonb_typeof(v->'columns') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'columns') NOT BETWEEN 1 AND 12 OR NOT hon.custom_tool_unique_keys(v->'columns')
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'columns') k WHERE jsonb_typeof(k)<>'string' OR hon.custom_tool_field(p_def,v->>'entity',k#>>'{}') IS NULL)
        OR (v ? 'sort' AND NOT (hon.custom_tool_shape(v->'sort',ARRAY['field','direction'],'{}') AND jsonb_typeof(v->'sort'->'field')='string'
          AND hon.custom_tool_field(p_def,v->>'entity',v->'sort'->>'field') IS NOT NULL AND (v->'sort'->'direction') IN ('"ASC"'::jsonb,'"DESC"'::jsonb))) THEN
        PERFORM hon.custom_tool_invalid(path); END IF;
    ELSIF t='FORM' THEN
      IF NOT hon.custom_tool_shape(v,ARRAY['key','label','type','entity','fields'],'{}')
        OR jsonb_typeof(v->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'fields') NOT BETWEEN 1 AND 40 OR NOT hon.custom_tool_unique_keys(v->'fields')
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v->'fields') k WHERE jsonb_typeof(k)<>'string' OR hon.custom_tool_field(p_def,v->>'entity',k#>>'{}') IS NULL) THEN
        PERFORM hon.custom_tool_invalid(path); END IF;
    ELSIF t='DASHBOARD' THEN
      IF NOT hon.custom_tool_shape(v,ARRAY['key','label','type','entity','cards'],'{}')
        OR jsonb_typeof(v->'cards') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'cards') NOT BETWEEN 1 AND 12 THEN PERFORM hon.custom_tool_invalid(path); END IF;
      ckeys:='{}';
      FOR c IN SELECT * FROM jsonb_array_elements(v->'cards') LOOP
        IF NOT hon.custom_tool_key_ok(c->'key') OR (c->>'key')=ANY(ckeys) OR NOT hon.custom_tool_label_ok(c->'label',80) THEN PERFORM hon.custom_tool_invalid(path||'.cards'); END IF;
        tgt:=CASE WHEN jsonb_typeof(c->'field')='string' THEN hon.custom_tool_field(p_def,v->>'entity',c->>'field') END;
        IF NOT (CASE c->>'kind'
            WHEN 'COUNT' THEN hon.custom_tool_shape(c,ARRAY['key','label','kind'],'{}')
            WHEN 'SUM' THEN hon.custom_tool_shape(c,ARRAY['key','label','kind','field'],'{}') AND coalesce(tgt->>'type','') IN ('INTEGER','NUMBER')
            WHEN 'AVERAGE' THEN hon.custom_tool_shape(c,ARRAY['key','label','kind','field'],'{}') AND coalesce(tgt->>'type','') IN ('INTEGER','NUMBER')
            WHEN 'LEADERBOARD' THEN hon.custom_tool_shape(c,ARRAY['key','label','kind','field','groupBy'],'{}') AND coalesce(tgt->>'type','') IN ('INTEGER','NUMBER')
              AND jsonb_typeof(c->'groupBy')='string'
              AND coalesce(hon.custom_tool_field(p_def,v->>'entity',c->>'groupBy')->>'type','') IN ('STUDENT_REF','STAFF_REF','CHOICE','RECORD_REF')
            ELSE false END) THEN PERFORM hon.custom_tool_invalid(path||'.cards'); END IF;
        ckeys:=ckeys||(c->>'key');
      END LOOP;
    ELSE PERFORM hon.custom_tool_invalid(path||'.type');
    END IF;
    vkeys:=vkeys||(v->>'key');
  END LOOP;
  IF jsonb_typeof(p_def->'navigation') IS DISTINCT FROM 'array' OR jsonb_array_length(p_def->'navigation') NOT BETWEEN 1 AND 12
    OR NOT hon.custom_tool_unique_keys(p_def->'navigation')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_def->'navigation') k WHERE jsonb_typeof(k)<>'string' OR NOT (k#>>'{}')=ANY(vkeys)) THEN
    PERFORM hon.custom_tool_invalid('navigation'); END IF;
  IF jsonb_typeof(p_def->'access') IS DISTINCT FROM 'array' OR jsonb_array_length(p_def->'access')>20 THEN PERFORM hon.custom_tool_invalid('access'); END IF;
  ckeys:='{}';
  FOR a IN SELECT * FROM jsonb_array_elements(p_def->'access') LOOP
    IF NOT hon.custom_tool_shape(a,ARRAY['roleId','capabilities'],'{}') OR jsonb_typeof(a->'roleId') IS DISTINCT FROM 'string'
      OR (a->>'roleId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR (a->>'roleId')=ANY(ckeys)
      OR NOT hon.custom_tool_role_eligible((a->>'roleId')::uuid,p_org,p_school)
      OR jsonb_typeof(a->'capabilities') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'capabilities') NOT BETWEEN 1 AND 4
      OR NOT hon.custom_tool_unique_keys(a->'capabilities') OR NOT (a->'capabilities') @> '["VIEW"]'::jsonb
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'capabilities') k WHERE k NOT IN ('"VIEW"'::jsonb,'"CREATE"'::jsonb,'"EDIT"'::jsonb,'"ARCHIVE"'::jsonb)) THEN
      PERFORM hon.custom_tool_invalid('access'); END IF;
    ckeys:=ckeys||(a->>'roleId');
  END LOOP;
END $$;

-- What this person may do with records of a tool under p_def: designers everything, others what their live roles get.
CREATE FUNCTION hon.custom_tool_caps(p_actor uuid,p_org uuid,p_school uuid,p_def jsonb) RETURNS text[]
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN hon.custom_tool_holds(p_actor,p_org,p_school,'custom_tool.design') THEN ARRAY['VIEW','CREATE','EDIT','ARCHIVE']
    ELSE coalesce((SELECT array_agg(DISTINCT cap ORDER BY cap) FROM jsonb_array_elements(coalesce(p_def->'access','[]')) a,
      jsonb_array_elements_text(a->'capabilities') cap
      WHERE EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
        WHERE g.principal_id=p_actor AND g.organization_id=p_org AND g.school_id=p_school AND g.revoked_at IS NULL
          AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
          AND g.role_id::text=a->>'roleId' AND hon.custom_tool_role_eligible(r.id,p_org,p_school))),'{}') END;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Record values. p_data holds the record's fields under the current definition; hidden values of fields taken out of
-- the definition are carried over from p_prior. A link must point to this school's own student, staff member or a live
-- record of the same tool and preview scope.
CREATE FUNCTION hon.custom_tool_record_invalid(p_field text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'CUSTOM_TOOL_RECORD_INVALID' USING ERRCODE='22023',HINT=left(p_field,80); END $$;

CREATE FUNCTION hon.custom_tool_clean_data(p_def jsonb,p_entity text,p_data jsonb,p_prior jsonb,p_org uuid,p_school uuid,p_tool uuid,p_preview integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE fields jsonb; f jsonb; k text; val jsonb; t text; s text; out jsonb; d date;
BEGIN
  SELECT e->'fields' INTO fields FROM jsonb_array_elements(p_def->'entities') e WHERE e->>'key'=p_entity;
  IF fields IS NULL THEN RAISE EXCEPTION 'CUSTOM_TOOL_RECORD_INVALID' USING ERRCODE='22023',HINT='entity'; END IF;
  IF coalesce(jsonb_typeof(p_data),'')<>'object' THEN PERFORM hon.custom_tool_record_invalid('data'); END IF;
  FOR k IN SELECT jsonb_object_keys(p_data) LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) x WHERE x->>'key'=k) THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
  END LOOP;
  -- Hidden values of fields that are no longer in this definition stay with the record.
  SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO out FROM jsonb_each(coalesce(p_prior,'{}'))
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) x WHERE x->>'key'=key);
  FOR f IN SELECT * FROM jsonb_array_elements(fields) LOOP
    k:=f->>'key'; t:=f->>'type'; val:=p_data->k;
    IF val IS NULL OR val='null'::jsonb OR (jsonb_typeof(val)='string' AND (val#>>'{}')='') OR val='[]'::jsonb THEN
      IF coalesce((f->>'required')::boolean,false) THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
      CONTINUE;
    END IF;
    s:=CASE WHEN jsonb_typeof(val)='string' THEN val#>>'{}' END;
    IF t IN ('TEXT','LONG_TEXT') THEN
      IF s IS NULL OR s<>btrim(s) OR length(s)>coalesce((f->>'maxLength')::integer,CASE t WHEN 'TEXT' THEN 200 ELSE 2000 END)
        OR (t='TEXT' AND s ~ '[[:cntrl:]]') OR (t='LONG_TEXT' AND s ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]') THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
    ELSIF t IN ('INTEGER','NUMBER') THEN
      IF NOT hon.custom_tool_number_ok(val,t='INTEGER') OR (f ? 'min' AND (val#>>'{}')::numeric<(f->>'min')::numeric)
        OR (f ? 'max' AND (val#>>'{}')::numeric>(f->>'max')::numeric) THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
    ELSIF t='BOOLEAN' THEN
      IF jsonb_typeof(val)<>'boolean' THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
    ELSIF t='DATE' THEN
      IF s IS NULL OR s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
      BEGIN d:=s::date; EXCEPTION WHEN OTHERS THEN PERFORM hon.custom_tool_record_invalid(k); END;
      IF to_char(d,'YYYY-MM-DD')<>s THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
    ELSIF t='CHOICE' THEN
      IF s IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'choices') x WHERE x->>'key'=s) THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
    ELSIF t='MULTI_CHOICE' THEN
      IF jsonb_typeof(val)<>'array' OR jsonb_array_length(val)>50 OR NOT hon.custom_tool_unique_keys(val)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(val) y WHERE jsonb_typeof(y)<>'string'
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f->'choices') x WHERE x->>'key'=y#>>'{}')) THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
    ELSE
      IF s IS NULL OR s !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN PERFORM hon.custom_tool_record_invalid(k); END IF;
      IF t='STUDENT_REF' AND NOT EXISTS(SELECT 1 FROM hon.student_profiles sp WHERE sp.id=s::uuid AND sp.organization_id=p_org AND sp.school_id=p_school)
        OR t='STAFF_REF' AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id
          WHERE g.principal_id=s::uuid AND g.organization_id=p_org AND g.school_id=p_school AND g.revoked_at IS NULL AND p.is_active AND p.principal_type='HUMAN_USER'
            AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
            AND hon.custom_tool_role_eligible(g.role_id,p_org,p_school))
        OR t='RECORD_REF' AND NOT EXISTS(SELECT 1 FROM hon.custom_tool_records r WHERE r.id=s::uuid AND r.tool_id=p_tool
          AND r.organization_id=p_org AND r.school_id=p_school AND r.entity_key=f->>'entity' AND r.preview_version IS NOT DISTINCT FROM p_preview AND r.archived_at IS NULL) THEN
        PERFORM hon.custom_tool_record_invalid(k); END IF;
    END IF;
    out:=out||jsonb_build_object(k,val);
  END LOOP;
  IF length(out::text)>8192 THEN PERFORM hon.custom_tool_record_invalid('data'); END IF;
  RETURN out;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Projections.
CREATE FUNCTION hon.custom_tool_version_json(v hon.custom_tool_versions,p_with_definition boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('versionNo',v.version_no,'status',v.status,'origin',v.origin,'restoredFrom',v.restored_from,
    'createdAt',hon.saas_ts(v.created_at),'updatedAt',hon.saas_ts(v.updated_at),'publishedAt',hon.saas_ts(v.published_at))
    ||CASE WHEN p_with_definition THEN jsonb_build_object('definition',v.definition) ELSE '{}'::jsonb END;
$$;
-- The navigation entry of one tool for this person, or NULL when the person may not see it.
CREATE FUNCTION hon.custom_tool_summary_json(t hon.custom_tools,p_actor uuid,p_design boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE pub jsonb; shown jsonb; caps text[];
BEGIN
  SELECT definition INTO pub FROM hon.custom_tool_versions WHERE tool_id=t.id AND version_no=t.published_version;
  IF p_design THEN
    SELECT definition INTO shown FROM hon.custom_tool_versions WHERE tool_id=t.id AND version_no=coalesce(t.published_version,t.draft_version,t.latest_version);
    caps:=ARRAY['VIEW','CREATE','EDIT','ARCHIVE'];
  ELSE
    IF t.status<>'ACTIVE' OR pub IS NULL THEN RETURN NULL; END IF;
    caps:=hon.custom_tool_caps(p_actor,t.organization_id,t.school_id,pub);
    IF NOT 'VIEW'=ANY(caps) THEN RETURN NULL; END IF;
    shown:=pub;
  END IF;
  RETURN jsonb_build_object('toolId',t.id,'toolKey',t.tool_key,'status',t.status,'revision',t.revision,
    'latestVersion',t.latest_version,'publishedVersion',t.published_version,'draftVersion',CASE WHEN p_design THEN t.draft_version END,
    'name',shown->'name','icon',shown->'icon','capabilities',to_jsonb(caps),
    'navigation',CASE WHEN pub IS NULL THEN '[]'::jsonb ELSE (SELECT coalesce(jsonb_agg(jsonb_build_object('viewKey',v->>'key','label',v->'label','type',v->>'type') ORDER BY n.ord),'[]')
      FROM jsonb_array_elements_text(pub->'navigation') WITH ORDINALITY n(k,ord) JOIN jsonb_array_elements(pub->'views') v ON v->>'key'=n.k) END,
    'updatedAt',hon.saas_ts(t.updated_at));
END $$;
-- The whole tool as its designer sees it: one version with its definition, the version list and the roles to choose from.
CREATE FUNCTION hon.custom_tool_design_json(t hon.custom_tools,p_actor uuid,p_version integer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('tool',hon.custom_tool_summary_json(t,p_actor,true),
    'version',(SELECT hon.custom_tool_version_json(v,true) FROM hon.custom_tool_versions v WHERE v.tool_id=t.id AND v.version_no=p_version),
    'versions',(SELECT coalesce(jsonb_agg(hon.custom_tool_version_json(v,false) ORDER BY v.version_no DESC),'[]') FROM hon.custom_tool_versions v WHERE v.tool_id=t.id),
    'roles',(SELECT coalesce(jsonb_agg(jsonb_build_object('roleId',r.id,'name',left(r.name,120)) ORDER BY r.name,r.id),'[]') FROM hon.roles r
      WHERE r.organization_id=t.organization_id AND hon.custom_tool_role_eligible(r.id,t.organization_id,t.school_id)));
$$;
CREATE FUNCTION hon.custom_tool_record_json(r hon.custom_tool_records,p_def jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('recordId',r.id,'entity',r.entity_key,'version',r.version,'preview',r.preview_version IS NOT NULL,
    'data',(SELECT coalesce(jsonb_object_agg(d.key,d.value),'{}') FROM jsonb_each(r.data) d
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(p_def->'entities') e, jsonb_array_elements(e->'fields') f WHERE e->>'key'=r.entity_key AND f->>'key'=d.key)),
    'createdAt',hon.saas_ts(r.created_at),'updatedAt',hon.saas_ts(r.updated_at),'archivedAt',hon.saas_ts(r.archived_at));
$$;
-- A short name for a record: its first non-empty text field under p_def.
CREATE FUNCTION hon.custom_tool_record_label(r hon.custom_tool_records,p_def jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT left(r.data->>(f->>'key'),120) FROM jsonb_array_elements(p_def->'entities') e, jsonb_array_elements(e->'fields') WITH ORDINALITY x(f,ord)
    WHERE e->>'key'=r.entity_key AND f->>'type' IN ('TEXT','CHOICE') AND coalesce(r.data->>(f->>'key'),'')<>'' ORDER BY x.ord LIMIT 1),'Record');
$$;
-- Names of the students, staff and records the given records link to (this school only).
CREATE FUNCTION hon.custom_tool_refs_json(p_records jsonb,p_def jsonb,p_org uuid,p_school uuid,p_tool uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  WITH links AS (
    SELECT DISTINCT f->>'type' AS kind, rec->'data'->>(f->>'key') AS id FROM jsonb_array_elements(p_records) rec,
      jsonb_array_elements(p_def->'entities') e, jsonb_array_elements(e->'fields') f
    WHERE e->>'key'=rec->>'entity' AND f->>'type' IN ('STUDENT_REF','STAFF_REF','RECORD_REF') AND coalesce(rec->'data'->>(f->>'key'),'')<>'')
  SELECT jsonb_build_object(
    'students',(SELECT coalesce(jsonb_object_agg(sp.id,left(btrim(pe.given_name||' '||pe.family_name),120)),'{}') FROM links l
      JOIN hon.student_profiles sp ON sp.id::text=l.id AND sp.organization_id=p_org AND sp.school_id=p_school
      JOIN hon.people pe ON pe.id=sp.person_id WHERE l.kind='STUDENT_REF'),
    'staff',(SELECT coalesce(jsonb_object_agg(p.id,left(coalesce(nullif(btrim(u.display_name),''),'Staff member'),120)),'{}') FROM links l
      JOIN hon.principals p ON p.id::text=l.id JOIN hon.users u ON u.id=p.user_id
      WHERE l.kind='STAFF_REF' AND EXISTS(SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id=p.id AND g.organization_id=p_org AND g.school_id=p_school)),
    'records',(SELECT coalesce(jsonb_object_agg(r.id,hon.custom_tool_record_label(r,p_def)),'{}') FROM links l
      JOIN hon.custom_tool_records r ON r.id::text=l.id AND r.tool_id=p_tool WHERE l.kind='RECORD_REF'));
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Command plumbing (the 0335 pattern).
CREATE FUNCTION hon.custom_tool_claim(p_org uuid,p_school uuid,p_actor uuid,p_key text,p_operation text,p_fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE prior hon.custom_tool_commands%ROWTYPE;
BEGIN
  INSERT INTO hon.custom_tool_commands(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(p_org,p_school,p_actor,p_key,p_operation,p_fp) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.custom_tool_commands WHERE organization_id=p_org AND school_id=p_school AND principal_id=p_actor AND idempotency_key=p_key FOR UPDATE;
  IF prior.operation<>p_operation OR prior.fingerprint<>p_fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.response IS NULL THEN RAISE EXCEPTION 'CUSTOM_TOOL_BUSY' USING ERRCODE='55P03'; END IF;
  RETURN jsonb_build_object('record',prior.response,'replayed',true);
END $$;
CREATE FUNCTION hon.custom_tool_finish(p_org uuid,p_school uuid,p_actor uuid,p_key text,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
  UPDATE hon.custom_tool_commands SET response=p_result,completed_at=clock_timestamp()
    WHERE organization_id=p_org AND school_id=p_school AND principal_id=p_actor AND idempotency_key=p_key;
  RETURN jsonb_build_object('record',p_result,'replayed',false);
END $$;
CREATE FUNCTION hon.custom_tool_check_call(p_key text,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION hon.custom_tool_evidence(p_org uuid,p_school uuid,p_actor uuid,p_event text,p_entity_type text,p_entity uuid,p_version integer,p_state jsonb,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(p_org,p_school,p_actor,'HUMAN_UI',p_event,p_entity_type,p_entity,p_state,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(p_org,p_school,p_event,1,p_entity_type,p_entity,p_version,p_correlation,p_request,p_state);
$$;
CREATE FUNCTION hon.custom_tool_uuid(p jsonb) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'string' OR (p#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  RETURN (p#>>'{}')::uuid;
END $$;
CREATE FUNCTION hon.custom_tool_int(p jsonb,p_min integer,p_max integer) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'number' OR (p#>>'{}') !~ '^[0-9]{1,9}$' OR (p#>>'{}')::integer NOT BETWEEN p_min AND p_max THEN
    RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  RETURN (p#>>'{}')::integer;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Entry point 1: the tools this person may see (designers see every tool and its draft state).
CREATE FUNCTION hon.read_custom_tools(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; design boolean;
BEGIN
  actor:=hon.require_custom_tool_actor(p_subject,'custom_tool.use');
  design:=hon.custom_tool_holds(actor,org,school,'custom_tool.design');
  RETURN jsonb_build_object('canDesign',design,'tools',(SELECT coalesce(jsonb_agg(s ORDER BY t.tool_key),'[]') FROM hon.custom_tools t,
    LATERAL hon.custom_tool_summary_json(t,actor,design) s WHERE t.organization_id=org AND t.school_id=school AND s IS NOT NULL));
END $$;

-- Entry point 2: one tool. Designers read any version (default: the draft, else the published one) with the version list
-- and roles; other people read the published definition only.
CREATE FUNCTION hon.read_custom_tool(p_subject text,p_tool uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; t hon.custom_tools%ROWTYPE; s jsonb;
BEGIN
  actor:=hon.require_custom_tool_actor(p_subject,'custom_tool.use');
  SELECT * INTO t FROM hon.custom_tools WHERE id=p_tool AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF hon.custom_tool_holds(actor,org,school,'custom_tool.design') THEN
    IF p_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hon.custom_tool_versions WHERE tool_id=t.id AND version_no=p_version) THEN
      RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN hon.custom_tool_design_json(t,actor,coalesce(p_version,t.draft_version,t.published_version,t.latest_version));
  END IF;
  s:=hon.custom_tool_summary_json(t,actor,false);
  IF s IS NULL OR (p_version IS NOT NULL AND p_version IS DISTINCT FROM t.published_version) THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('tool',s,'version',(SELECT hon.custom_tool_version_json(v,true) FROM hon.custom_tool_versions v WHERE v.tool_id=t.id AND v.version_no=t.published_version),
    'versions','[]'::jsonb,'roles','[]'::jsonb);
END $$;

-- Entry point 3: save a draft. New tool {toolId:null, toolKey, expectedRevision:0, definition}; existing tool
-- {toolId, toolKey:null, expectedRevision, definition} replaces its open DRAFT or opens a new one.
CREATE FUNCTION hon.save_custom_tool_draft(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; fp text;
  t hon.custom_tools%ROWTYPE; tool uuid; rev integer; def jsonb; at timestamptz:=clock_timestamp(); result jsonb; vno integer;
BEGIN
  IF NOT hon.custom_tool_shape(p_input,ARRAY['toolId','toolKey','expectedRevision','definition'],'{}') THEN RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.custom_tool_check_call(p_key,p_request,p_correlation);
  tool:=CASE WHEN p_input->'toolId'='null'::jsonb THEN NULL ELSE hon.custom_tool_uuid(p_input->'toolId') END;
  rev:=hon.custom_tool_int(p_input->'expectedRevision',0,999999999); def:=p_input->'definition';
  IF (tool IS NULL)<>(rev=0) OR (tool IS NULL)<>(jsonb_typeof(p_input->'toolKey')='string')
    OR (tool IS NULL AND (p_input->>'toolKey') !~ '^[a-z][a-z0-9_]{1,39}$') OR (tool IS NOT NULL AND p_input->'toolKey'<>'null'::jsonb) THEN
    RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_custom_tool_actor(p_subject,'custom_tool.design');
  fp:=encode(sha256(convert_to('custom_tool.save_draft:'||p_input::text,'UTF8')),'hex');
  replay:=hon.custom_tool_claim(org,school,actor,p_key,'SAVE_DRAFT',fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF tool IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('custom-tools:'||school::text,0));
    IF (SELECT count(*) FROM hon.custom_tools WHERE organization_id=org AND school_id=school)>=25 THEN RAISE EXCEPTION 'CUSTOM_TOOL_LIMIT' USING ERRCODE='54000'; END IF;
    IF EXISTS(SELECT 1 FROM hon.custom_tools WHERE organization_id=org AND school_id=school AND tool_key=p_input->>'toolKey') THEN
      RAISE EXCEPTION 'CUSTOM_TOOL_KEY_TAKEN' USING ERRCODE='23505'; END IF;
    PERFORM hon.custom_tool_check_definition(def,org,school,NULL);
    INSERT INTO hon.custom_tools(organization_id,school_id,tool_key,latest_version,draft_version,created_by_principal_id,created_at,updated_at)
      VALUES(org,school,p_input->>'toolKey',1,1,actor,at,at) RETURNING * INTO t;
    INSERT INTO hon.custom_tool_versions(tool_id,organization_id,school_id,version_no,definition,status,origin,created_by_principal_id,created_at,updated_at)
      VALUES(t.id,org,school,1,def,'DRAFT','NEW',actor,at,at);
    vno:=1;
  ELSE
    SELECT * INTO t FROM hon.custom_tools WHERE id=tool AND organization_id=org AND school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF t.revision<>rev THEN RAISE EXCEPTION 'CUSTOM_TOOL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    PERFORM hon.custom_tool_check_definition(def,org,school,t.id);
    IF t.draft_version IS NOT NULL THEN
      UPDATE hon.custom_tool_versions SET definition=def,updated_at=at WHERE tool_id=t.id AND version_no=t.draft_version;
      vno:=t.draft_version;
      UPDATE hon.custom_tools SET revision=revision+1,updated_at=at WHERE id=t.id RETURNING * INTO t;
    ELSE
      vno:=t.latest_version+1;
      INSERT INTO hon.custom_tool_versions(tool_id,organization_id,school_id,version_no,definition,status,origin,created_by_principal_id,created_at,updated_at)
        VALUES(t.id,org,school,vno,def,'DRAFT','EDIT',actor,at,at);
      UPDATE hon.custom_tools SET latest_version=vno,draft_version=vno,revision=revision+1,updated_at=at WHERE id=t.id RETURNING * INTO t;
    END IF;
  END IF;
  result:=hon.custom_tool_design_json(t,actor,vno);
  PERFORM hon.custom_tool_evidence(org,school,actor,'custom_tool.draft.saved','CUSTOM_TOOL',t.id,t.revision,
    jsonb_build_object('toolId',t.id,'toolKey',t.tool_key,'versionNo',vno),p_request,p_correlation);
  IF hon.require_custom_tool_actor(p_subject,'custom_tool.design') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CUSTOM_TOOL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.custom_tool_finish(org,school,actor,p_key,result);
END $$;

-- Entry point 4: change a tool {operation, expectedRevision, version}.
-- PUBLISH version (the open DRAFT), DISCARD_DRAFT version (the open DRAFT), RESTORE version (an earlier non-draft version
-- into a new DRAFT; access rules whose role is no longer usable are dropped), ARCHIVE / UNARCHIVE (version null).
CREATE FUNCTION hon.change_custom_tool(p_subject text,p_tool uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; fp text; op text;
  t hon.custom_tools%ROWTYPE; rev integer; vno integer; src hon.custom_tool_versions%ROWTYPE; def jsonb; at timestamptz:=clock_timestamp(); result jsonb; shown integer;
BEGIN
  IF p_tool IS NULL OR NOT hon.custom_tool_shape(p_input,ARRAY['operation','expectedRevision','version'],'{}') OR jsonb_typeof(p_input->'operation') IS DISTINCT FROM 'string'
    OR (p_input->>'operation') NOT IN ('PUBLISH','DISCARD_DRAFT','RESTORE','ARCHIVE','UNARCHIVE') THEN RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.custom_tool_check_call(p_key,p_request,p_correlation);
  op:=p_input->>'operation'; rev:=hon.custom_tool_int(p_input->'expectedRevision',1,999999999);
  IF op IN ('ARCHIVE','UNARCHIVE') THEN
    IF p_input->'version'<>'null'::jsonb THEN RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  ELSE vno:=hon.custom_tool_int(p_input->'version',1,100000); END IF;
  actor:=hon.require_custom_tool_actor(p_subject,'custom_tool.design');
  fp:=encode(sha256(convert_to('custom_tool.change:'||p_tool::text||':'||p_input::text,'UTF8')),'hex');
  replay:=hon.custom_tool_claim(org,school,actor,p_key,'CHANGE',fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO t FROM hon.custom_tools WHERE id=p_tool AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF t.revision<>rev THEN RAISE EXCEPTION 'CUSTOM_TOOL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF op IN ('PUBLISH','DISCARD_DRAFT') THEN
    IF t.draft_version IS DISTINCT FROM vno THEN RAISE EXCEPTION 'CUSTOM_TOOL_STATE' USING ERRCODE='23514'; END IF;
    IF op='PUBLISH' THEN
      IF t.status<>'ACTIVE' THEN RAISE EXCEPTION 'CUSTOM_TOOL_STATE' USING ERRCODE='23514'; END IF;
      SELECT definition INTO def FROM hon.custom_tool_versions WHERE tool_id=t.id AND version_no=vno;
      -- Checked again: a role named in access may have been removed since the draft was saved.
      PERFORM hon.custom_tool_check_definition(def,org,school,t.id);
      UPDATE hon.custom_tool_versions SET status='SUPERSEDED' WHERE tool_id=t.id AND status='PUBLISHED';
      UPDATE hon.custom_tool_versions SET status='PUBLISHED',published_by_principal_id=actor,published_at=at,updated_at=at WHERE tool_id=t.id AND version_no=vno;
      UPDATE hon.custom_tools SET published_version=vno,draft_version=NULL,revision=revision+1,updated_at=at WHERE id=t.id RETURNING * INTO t;
    ELSE
      UPDATE hon.custom_tool_versions SET status='DISCARDED',updated_at=at WHERE tool_id=t.id AND version_no=vno;
      UPDATE hon.custom_tools SET draft_version=NULL,revision=revision+1,updated_at=at WHERE id=t.id RETURNING * INTO t;
    END IF;
    shown:=vno;
  ELSIF op='RESTORE' THEN
    IF t.draft_version IS NOT NULL THEN RAISE EXCEPTION 'CUSTOM_TOOL_DRAFT_OPEN' USING ERRCODE='23514'; END IF;
    SELECT * INTO src FROM hon.custom_tool_versions WHERE tool_id=t.id AND version_no=vno AND status<>'DRAFT';
    IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    def:=jsonb_set(src.definition,'{access}',(SELECT coalesce(jsonb_agg(a),'[]') FROM jsonb_array_elements(src.definition->'access') a
      WHERE hon.custom_tool_role_eligible((a->>'roleId')::uuid,org,school)));
    PERFORM hon.custom_tool_check_definition(def,org,school,t.id);
    shown:=t.latest_version+1;
    INSERT INTO hon.custom_tool_versions(tool_id,organization_id,school_id,version_no,definition,status,origin,restored_from,created_by_principal_id,created_at,updated_at)
      VALUES(t.id,org,school,shown,def,'DRAFT','RESTORE',vno,actor,at,at);
    UPDATE hon.custom_tools SET latest_version=shown,draft_version=shown,revision=revision+1,updated_at=at WHERE id=t.id RETURNING * INTO t;
  ELSE
    IF t.status=(CASE op WHEN 'ARCHIVE' THEN 'ARCHIVED' ELSE 'ACTIVE' END) THEN RAISE EXCEPTION 'CUSTOM_TOOL_STATE' USING ERRCODE='23514'; END IF;
    UPDATE hon.custom_tools SET status=CASE op WHEN 'ARCHIVE' THEN 'ARCHIVED' ELSE 'ACTIVE' END,revision=revision+1,updated_at=at WHERE id=t.id RETURNING * INTO t;
    shown:=coalesce(t.draft_version,t.published_version,t.latest_version);
  END IF;
  result:=hon.custom_tool_design_json(t,actor,shown);
  PERFORM hon.custom_tool_evidence(org,school,actor,'custom_tool.'||lower(op),'CUSTOM_TOOL',t.id,t.revision,
    jsonb_build_object('toolId',t.id,'toolKey',t.tool_key,'versionNo',shown,'publishedVersion',t.published_version),p_request,p_correlation);
  IF hon.require_custom_tool_actor(p_subject,'custom_tool.design') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CUSTOM_TOOL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.custom_tool_finish(org,school,actor,p_key,result);
END $$;

-- Which definition and preview scope a record call works in. Live work needs an ACTIVE published tool and the capability;
-- preview work is for designers and the tool's open DRAFT only.
CREATE FUNCTION hon.custom_tool_scope(p_actor uuid,t hon.custom_tools,p_preview boolean,p_cap text,OUT definition jsonb,OUT preview integer) RETURNS record
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_preview THEN
    IF NOT hon.custom_tool_holds(p_actor,t.organization_id,t.school_id,'custom_tool.design') OR t.draft_version IS NULL THEN
      RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    preview:=t.draft_version;
    SELECT v.definition INTO definition FROM hon.custom_tool_versions v WHERE v.tool_id=t.id AND v.version_no=t.draft_version;
  ELSE
    IF t.published_version IS NULL OR t.status<>'ACTIVE' THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    SELECT v.definition INTO definition FROM hon.custom_tool_versions v WHERE v.tool_id=t.id AND v.version_no=t.published_version;
    IF NOT 'VIEW'=ANY(hon.custom_tool_caps(p_actor,t.organization_id,t.school_id,definition)) THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  END IF;
  IF NOT p_cap=ANY(hon.custom_tool_caps(p_actor,t.organization_id,t.school_id,definition)) THEN RAISE EXCEPTION 'CUSTOM_TOOL_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

-- Entry point 5: records of one entity {entity, preview, archived, limit 1..200}, newest first, with the names they link to.
CREATE FUNCTION hon.read_custom_tool_records(p_subject text,p_tool uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; t hon.custom_tools%ROWTYPE; sc record; recs jsonb; total bigint;
BEGIN
  IF NOT hon.custom_tool_shape(p_input,ARRAY['entity','preview','archived','limit'],'{}') OR NOT hon.custom_tool_key_ok(p_input->'entity')
    OR jsonb_typeof(p_input->'preview') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'archived') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.custom_tool_int(p_input->'limit',1,200);
  actor:=hon.require_custom_tool_actor(p_subject,'custom_tool.use');
  SELECT * INTO t FROM hon.custom_tools WHERE id=p_tool AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO sc FROM hon.custom_tool_scope(actor,t,(p_input->>'preview')::boolean,'VIEW');
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sc.definition->'entities') e WHERE e->>'key'=p_input->>'entity') THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT coalesce(jsonb_agg(hon.custom_tool_record_json(r,sc.definition) ORDER BY r.created_at DESC,r.id DESC),'[]') INTO recs FROM (
    SELECT * FROM hon.custom_tool_records r WHERE r.tool_id=t.id AND r.entity_key=p_input->>'entity' AND r.preview_version IS NOT DISTINCT FROM sc.preview
      AND (r.archived_at IS NOT NULL)=(p_input->>'archived')::boolean ORDER BY r.created_at DESC,r.id DESC LIMIT (p_input->>'limit')::integer) r;
  SELECT count(*) INTO total FROM hon.custom_tool_records r WHERE r.tool_id=t.id AND r.entity_key=p_input->>'entity'
    AND r.preview_version IS NOT DISTINCT FROM sc.preview AND (r.archived_at IS NOT NULL)=(p_input->>'archived')::boolean;
  RETURN jsonb_build_object('records',recs,'total',total,'refs',hon.custom_tool_refs_json(recs,sc.definition,org,school,t.id),
    'capabilities',to_jsonb(hon.custom_tool_caps(actor,org,school,sc.definition)));
END $$;

-- Entry point 6: one DASHBOARD view's cards {view, preview}, computed from the entity's live (not archived) records.
CREATE FUNCTION hon.read_custom_tool_dashboard(p_subject text,p_tool uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; t hon.custom_tools%ROWTYPE; sc record; v jsonb; c jsonb;
  cards jsonb:='[]'; rows jsonb; num numeric; gtype text;
BEGIN
  IF NOT hon.custom_tool_shape(p_input,ARRAY['view','preview'],'{}') OR NOT hon.custom_tool_key_ok(p_input->'view')
    OR jsonb_typeof(p_input->'preview') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_custom_tool_actor(p_subject,'custom_tool.use');
  SELECT * INTO t FROM hon.custom_tools WHERE id=p_tool AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO sc FROM hon.custom_tool_scope(actor,t,(p_input->>'preview')::boolean,'VIEW');
  SELECT x INTO v FROM jsonb_array_elements(sc.definition->'views') x WHERE x->>'key'=p_input->>'view' AND x->>'type'='DASHBOARD';
  IF v IS NULL THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(v->'cards') LOOP
    rows:=NULL; num:=NULL;
    IF c->>'kind'='COUNT' THEN
      SELECT count(*) INTO num FROM hon.custom_tool_records r WHERE r.tool_id=t.id AND r.entity_key=v->>'entity' AND r.preview_version IS NOT DISTINCT FROM sc.preview AND r.archived_at IS NULL;
    ELSIF c->>'kind' IN ('SUM','AVERAGE') THEN
      SELECT CASE c->>'kind' WHEN 'SUM' THEN coalesce(sum((r.data->>(c->>'field'))::numeric),0) ELSE round(avg((r.data->>(c->>'field'))::numeric),2) END INTO num
      FROM hon.custom_tool_records r WHERE r.tool_id=t.id AND r.entity_key=v->>'entity' AND r.preview_version IS NOT DISTINCT FROM sc.preview AND r.archived_at IS NULL
        AND jsonb_typeof(r.data->(c->>'field'))='number';
    ELSE
      gtype:=hon.custom_tool_field(sc.definition,v->>'entity',c->>'groupBy')->>'type';
      SELECT coalesce(jsonb_agg(jsonb_build_object('key',g.k,'value',g.total) ORDER BY g.total DESC,g.k),'[]') INTO rows FROM (
        SELECT r.data->>(c->>'groupBy') k,sum((r.data->>(c->>'field'))::numeric) total FROM hon.custom_tool_records r
        WHERE r.tool_id=t.id AND r.entity_key=v->>'entity' AND r.preview_version IS NOT DISTINCT FROM sc.preview AND r.archived_at IS NULL
          AND jsonb_typeof(r.data->(c->>'field'))='number' AND coalesce(r.data->>(c->>'groupBy'),'')<>''
        GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 10) g;
      -- Labels for the leaderboard groups, from this school's own records only.
      rows:=(SELECT coalesce(jsonb_agg(x||jsonb_build_object('label',CASE gtype
          WHEN 'CHOICE' THEN (SELECT ch->'label' FROM jsonb_array_elements(hon.custom_tool_field(sc.definition,v->>'entity',c->>'groupBy')->'choices') ch WHERE ch->>'key'=x->>'key')
          ELSE to_jsonb((hon.custom_tool_refs_json(jsonb_build_array(jsonb_build_object('entity',v->>'entity','data',jsonb_build_object(c->>'groupBy',x->>'key'))),sc.definition,org,school,t.id)
            ->CASE gtype WHEN 'STUDENT_REF' THEN 'students' WHEN 'STAFF_REF' THEN 'staff' ELSE 'records' END)->>(x->>'key')) END) ORDER BY ord),'[]')
        FROM jsonb_array_elements(rows) WITH ORDINALITY q(x,ord));
    END IF;
    cards:=cards||jsonb_build_array(jsonb_build_object('key',c->>'key','label',c->'label','kind',c->>'kind','value',num,'rows',rows));
  END LOOP;
  RETURN jsonb_build_object('view',v->>'key','cards',cards);
END $$;

-- Entry point 7: write one record {operation CREATE|UPDATE|ARCHIVE|RESTORE, recordId, entity, expectedVersion, preview, data}.
CREATE FUNCTION hon.write_custom_tool_record(p_subject text,p_tool uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; fp text; op text;
  t hon.custom_tools%ROWTYPE; sc record; r hon.custom_tool_records%ROWTYPE; rid uuid; ent text; ev integer; prev boolean; clean jsonb;
  at timestamptz:=clock_timestamp(); result jsonb; kind text;
BEGIN
  IF p_tool IS NULL OR NOT hon.custom_tool_shape(p_input,ARRAY['operation','recordId','entity','expectedVersion','preview','data'],'{}')
    OR jsonb_typeof(p_input->'operation') IS DISTINCT FROM 'string' OR (p_input->>'operation') NOT IN ('CREATE','UPDATE','ARCHIVE','RESTORE')
    OR NOT hon.custom_tool_key_ok(p_input->'entity') OR jsonb_typeof(p_input->'preview') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.custom_tool_check_call(p_key,p_request,p_correlation);
  op:=p_input->>'operation'; ent:=p_input->>'entity'; prev:=(p_input->>'preview')::boolean;
  IF op='CREATE' THEN
    IF p_input->'recordId'<>'null'::jsonb OR p_input->'expectedVersion'<>'0'::jsonb THEN RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
    ev:=0;
  ELSE rid:=hon.custom_tool_uuid(p_input->'recordId'); ev:=hon.custom_tool_int(p_input->'expectedVersion',1,999999999); END IF;
  IF (op IN ('CREATE','UPDATE'))<>(jsonb_typeof(p_input->'data')='object') OR (op IN ('ARCHIVE','RESTORE') AND p_input->'data'<>'null'::jsonb) THEN
    RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_custom_tool_actor(p_subject,'custom_tool.use');
  fp:=encode(sha256(convert_to('custom_tool.write_record:'||p_tool::text||':'||p_input::text,'UTF8')),'hex');
  replay:=hon.custom_tool_claim(org,school,actor,p_key,'WRITE_RECORD',fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  -- FOR SHARE: a publish (FOR UPDATE) waits for record writes and the other way round, so a record always matches the
  -- definition that was current when it was written.
  SELECT * INTO t FROM hon.custom_tools WHERE id=p_tool AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO sc FROM hon.custom_tool_scope(actor,t,prev,CASE op WHEN 'CREATE' THEN 'CREATE' WHEN 'UPDATE' THEN 'EDIT' ELSE 'ARCHIVE' END);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sc.definition->'entities') e WHERE e->>'key'=ent) THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF op='CREATE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('custom-tool-records:'||t.id::text,0));
    IF (SELECT count(*) FROM hon.custom_tool_records x WHERE x.tool_id=t.id AND x.preview_version IS NOT DISTINCT FROM sc.preview)>=(CASE WHEN prev THEN 2000 ELSE 50000 END) THEN
      RAISE EXCEPTION 'CUSTOM_TOOL_LIMIT' USING ERRCODE='54000'; END IF;
    clean:=hon.custom_tool_clean_data(sc.definition,ent,p_input->'data','{}',org,school,t.id,sc.preview);
    INSERT INTO hon.custom_tool_records(organization_id,school_id,tool_id,entity_key,preview_version,data,created_by_principal_id,updated_by_principal_id,created_at,updated_at)
      VALUES(org,school,t.id,ent,sc.preview,clean,actor,actor,at,at) RETURNING * INTO r;
    kind:='CREATED';
  ELSE
    SELECT * INTO r FROM hon.custom_tool_records x WHERE x.id=rid AND x.tool_id=t.id AND x.organization_id=org AND x.school_id=school
      AND x.entity_key=ent AND x.preview_version IS NOT DISTINCT FROM sc.preview FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF r.version<>ev THEN RAISE EXCEPTION 'CUSTOM_TOOL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF op='UPDATE' THEN
      IF r.archived_at IS NOT NULL THEN RAISE EXCEPTION 'CUSTOM_TOOL_STATE' USING ERRCODE='23514'; END IF;
      clean:=hon.custom_tool_clean_data(sc.definition,ent,p_input->'data',r.data,org,school,t.id,sc.preview);
      UPDATE hon.custom_tool_records SET data=clean,version=version+1,updated_by_principal_id=actor,updated_at=at WHERE id=r.id RETURNING * INTO r;
      kind:='UPDATED';
    ELSE
      IF (r.archived_at IS NULL)<>(op='ARCHIVE') THEN RAISE EXCEPTION 'CUSTOM_TOOL_STATE' USING ERRCODE='23514'; END IF;
      UPDATE hon.custom_tool_records SET archived_at=CASE op WHEN 'ARCHIVE' THEN at END,version=version+1,updated_by_principal_id=actor,updated_at=at
        WHERE id=r.id RETURNING * INTO r;
      kind:=CASE op WHEN 'ARCHIVE' THEN 'ARCHIVED' ELSE 'RESTORED' END;
    END IF;
  END IF;
  INSERT INTO hon.custom_tool_record_events(record_id,seq,kind,data,actor_principal_id,occurred_at) VALUES(r.id,r.version,kind,r.data,actor,at);
  result:=hon.custom_tool_record_json(r,sc.definition);
  -- Preview work is a designer trying the draft: no audit noise and no events for Automation.
  IF NOT prev THEN
    PERFORM hon.custom_tool_evidence(org,school,actor,'custom_tool.record.'||lower(kind),'CUSTOM_TOOL_RECORD',r.id,r.version,
      jsonb_build_object('toolId',t.id,'toolKey',t.tool_key,'entity',ent,'recordId',r.id,'publishedVersion',t.published_version),p_request,p_correlation);
  END IF;
  IF hon.require_custom_tool_actor(p_subject,'custom_tool.use') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CUSTOM_TOOL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.custom_tool_finish(org,school,actor,p_key,result);
END $$;

-- Entry point 8: choices for a link field {kind STUDENT|STAFF|RECORD, entity (RECORD only, else null), search, preview},
-- for a person who may create or edit records; at most 50, this school only.
CREATE FUNCTION hon.read_custom_tool_link_options(p_subject text,p_tool uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; t hon.custom_tools%ROWTYPE; sc record; caps text[];
  kind text; s text; out jsonb;
BEGIN
  IF NOT hon.custom_tool_shape(p_input,ARRAY['kind','entity','search','preview'],'{}') OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string'
    OR (p_input->>'kind') NOT IN ('STUDENT','STAFF','RECORD') OR jsonb_typeof(p_input->'search') IS DISTINCT FROM 'string'
    OR length(p_input->>'search')>60 OR (p_input->>'search') ~ '[[:cntrl:]]' OR jsonb_typeof(p_input->'preview') IS DISTINCT FROM 'boolean'
    OR ((p_input->>'kind')='RECORD')<>hon.custom_tool_key_ok(p_input->'entity') OR ((p_input->>'kind')<>'RECORD' AND p_input->'entity'<>'null'::jsonb) THEN
    RAISE EXCEPTION 'CUSTOM_TOOL_INVALID' USING ERRCODE='22023'; END IF;
  kind:=p_input->>'kind'; s:=lower(btrim(p_input->>'search'));
  actor:=hon.require_custom_tool_actor(p_subject,'custom_tool.use');
  SELECT * INTO t FROM hon.custom_tools WHERE id=p_tool AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO sc FROM hon.custom_tool_scope(actor,t,(p_input->>'preview')::boolean,'VIEW');
  caps:=hon.custom_tool_caps(actor,org,school,sc.definition);
  IF NOT ('CREATE'=ANY(caps) OR 'EDIT'=ANY(caps)) THEN RAISE EXCEPTION 'CUSTOM_TOOL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF kind='STUDENT' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'label',x.label) ORDER BY x.label,x.id),'[]') INTO out FROM (
      SELECT sp.id,left(btrim(pe.given_name||' '||pe.family_name),120) label FROM hon.student_profiles sp JOIN hon.people pe ON pe.id=sp.person_id
      WHERE sp.organization_id=org AND sp.school_id=school AND (s='' OR position(s IN lower(pe.given_name||' '||pe.family_name))>0)
      ORDER BY 2,1 LIMIT 50) x;
  ELSIF kind='STAFF' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'label',x.label) ORDER BY x.label,x.id),'[]') INTO out FROM (
      SELECT DISTINCT p.id,left(coalesce(nullif(btrim(u.display_name),''),'Staff member'),120) label FROM hon.principal_role_grants g
        JOIN hon.principals p ON p.id=g.principal_id JOIN hon.users u ON u.id=p.user_id
      WHERE g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL AND p.is_active AND p.principal_type='HUMAN_USER'
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND hon.custom_tool_role_eligible(g.role_id,org,school) AND (s='' OR position(s IN lower(coalesce(u.display_name,'')))>0)
      ORDER BY 2,1 LIMIT 50) x;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sc.definition->'entities') e WHERE e->>'key'=p_input->>'entity') THEN RAISE EXCEPTION 'CUSTOM_TOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'label',x.label) ORDER BY x.label,x.id),'[]') INTO out FROM (
      SELECT r.id,hon.custom_tool_record_label(r,sc.definition) label FROM hon.custom_tool_records r
      WHERE r.tool_id=t.id AND r.entity_key=p_input->>'entity' AND r.preview_version IS NOT DISTINCT FROM sc.preview AND r.archived_at IS NULL
        AND (s='' OR position(s IN lower(hon.custom_tool_record_label(r,sc.definition)))>0)
      ORDER BY 2,1 LIMIT 50) x;
  END IF;
  RETURN jsonb_build_object('options',out);
END $$;

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['custom_tools','custom_tool_versions','custom_tool_records','custom_tool_record_events','custom_tool_commands'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='hon' AND (p.proname LIKE 'custom_tool%' OR p.proname IN ('guard_custom_tools','require_custom_tool_actor','read_custom_tools','read_custom_tool',
      'save_custom_tool_draft','change_custom_tool','read_custom_tool_records','read_custom_tool_dashboard','write_custom_tool_record','read_custom_tool_link_options')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_custom_tools(text),hon.read_custom_tool(text,uuid,integer),
      hon.save_custom_tool_draft(text,jsonb,text,uuid,uuid),hon.change_custom_tool(text,uuid,jsonb,text,uuid,uuid),
      hon.read_custom_tool_records(text,uuid,jsonb),hon.read_custom_tool_dashboard(text,uuid,jsonb),
      hon.write_custom_tool_record(text,uuid,jsonb,text,uuid,uuid),hon.read_custom_tool_link_options(text,uuid,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
