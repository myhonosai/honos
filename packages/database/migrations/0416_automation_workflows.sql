BEGIN;

-- AU-1 (0416; allocated as 0367 on 2026-11-15, renumbered 2026-11-16 to run after main's 0407): Automation Builder workflow definitions and contact tags.
-- Design: docs/superpowers/specs/2026-11-15-automation-builder-design.md.
-- - A workflow is a school's versioned definition: one trigger, entry rules, exit rules and a step graph, all from closed
--   catalogues validated here and, identically, in @hon/contracts (automation-workflows.ts). No expressions, code, SQL,
--   URLs or tool calls. Text is plain with a closed list of {{merge_fields}}.
-- - Versions are immutable. Saving appends a version; restore appends a copy of an older one. A school has at most
--   100 workflows that are not archived, a workflow at most 500 versions and 50 steps.
-- - This migration runs nothing. Status is DRAFT or ARCHIVED here; ACTIVE and PAUSED are reserved for the engine (AU-2),
--   which alone may set them. No event is consumed, no message, task or AI call is created.
-- - Contact tags (the one tags model, shared with the contact list): a person at one school carries up to 20 tags, a
--   school up to 200 distinct tags. Every add and remove is recorded in contact_tag_events. Staff add/remove through
--   commands here; the engine will use the private hon.contact_tag_apply with source AUTOMATION.
-- - Authority: a direct human with the exact permission live at the session school, an active organization and school
--   and an active COMPLETE entitlement (HON OS). Identifier-only audit; outbox events are recorded for later triggers.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL
    OR to_regclass('hon.people') IS NULL THEN RAISE EXCEPTION '0416 requires 0154 and 0204'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('automation.workflow.read','Read the school''s automation workflows and their versions',false,true),
  ('automation.workflow.manage','Create and edit automation workflow drafts, restore versions and archive drafts',true,true),
  ('automation.workflow.activate','Turn automation workflows on, pause them and resume them',true,true),
  ('contact.tag.read','See contact tags at the school',false,true),
  ('contact.tag.manage','Add and remove contact tags at the school',false,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
  WHERE r.code='OWNER' AND r.is_system_role AND p.code IN ('automation.workflow.read','automation.workflow.manage','automation.workflow.activate','contact.tag.read','contact.tag.manage')
  ON CONFLICT (role_id,permission_code) DO NOTHING;

CREATE TABLE hon.automation_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  trigger_kind text NOT NULL,
  latest_version integer NOT NULL CHECK (latest_version BETWEEN 1 AND 500),
  active_version integer CHECK (active_version IS NULL OR active_version BETWEEN 1 AND 500),
  activated_by_principal_id uuid REFERENCES hon.principals(id), activated_at timestamptz,
  paused_reason text CHECK (paused_reason IS NULL OR paused_reason ~ '^[A-Z_]{1,40}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK (active_version IS NULL OR active_version<=latest_version),
  CHECK ((status IN ('ACTIVE','PAUSED')) = (active_version IS NOT NULL AND activated_by_principal_id IS NOT NULL AND activated_at IS NOT NULL)),
  CHECK ((status='PAUSED') = (paused_reason IS NOT NULL))
);
CREATE INDEX automation_workflows_school_idx ON hon.automation_workflows (organization_id,school_id,status,updated_at DESC,id);
CREATE TABLE hon.automation_workflow_versions (
  workflow_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 500),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  definition jsonb NOT NULL,
  source text NOT NULL CHECK (source IN ('HUMAN_UI','HON_ASSIST','AI_AGENT')),
  restored_from_version integer CHECK (restored_from_version IS NULL OR restored_from_version BETWEEN 1 AND 499),
  author_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id,version),
  FOREIGN KEY (workflow_id,organization_id,school_id) REFERENCES hon.automation_workflows(id,organization_id,school_id),
  CHECK (restored_from_version IS NULL OR restored_from_version<version)
);
CREATE TABLE hon.automation_commands (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('WF_CREATE','WF_SAVE','WF_RESTORE','WF_ARCHIVE','TAG_ADD','TAG_REMOVE')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);
CREATE TABLE hon.contact_tags (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, person_id uuid NOT NULL,
  tag text NOT NULL CHECK (length(tag) BETWEEN 1 AND 40 AND tag=btrim(tag)),
  tag_key text NOT NULL CHECK (tag_key=lower(tag)),
  added_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  added_source text NOT NULL CHECK (added_source IN ('HUMAN_UI','AUTOMATION')),
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,school_id,person_id,tag_key),
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id)
);
CREATE INDEX contact_tags_filter_idx ON hon.contact_tags (organization_id,school_id,tag_key,person_id);
CREATE TABLE hon.contact_tag_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL, school_id uuid NOT NULL, person_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ADDED','REMOVED')),
  tag text NOT NULL CHECK (length(tag) BETWEEN 1 AND 40), tag_key text NOT NULL CHECK (tag_key=lower(tag)),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  source text NOT NULL CHECK (source IN ('HUMAN_UI','AUTOMATION')),
  automation_run_id uuid, request_id uuid, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id),
  CHECK ((source='AUTOMATION') = (automation_run_id IS NOT NULL))
);
CREATE INDEX contact_tag_events_person_idx ON hon.contact_tag_events (organization_id,school_id,person_id,id DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['automation_workflows','automation_workflow_versions','automation_commands','contact_tags','contact_tag_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- Versions and tag history never change; a command records its response once; workflows and current tags change only
-- through the functions below (deny-all RLS, no table grants).
CREATE FUNCTION hon.guard_automation_workflow_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='automation_commands' THEN
    IF OLD.response IS NULL AND NEW.response IS NOT NULL
      AND (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
        IS NOT DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'AUTOMATION_HISTORY_IMMUTABLE' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['automation_workflow_versions','automation_commands','contact_tag_events'] LOOP
    EXECUTE format('CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_workflow_history()',t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_automation_workflow_history()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['automation_workflows','contact_tags'] LOOP
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_automation_workflow_history()',t);
  END LOOP;
END $$;
-- A workflow is never deleted, and its school never changes.
CREATE FUNCTION hon.guard_automation_workflow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.organization_id,NEW.school_id,NEW.created_by_principal_id,NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.created_by_principal_id,OLD.created_at)
    AND NEW.revision=OLD.revision+1 AND NEW.latest_version>=OLD.latest_version AND OLD.status<>'ARCHIVED' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'AUTOMATION_HISTORY_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.automation_workflows FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_workflow();

-- The direct human with one of the five permissions live at the session school, with active COMPLETE access.
CREATE FUNCTION hon.require_automation_workflow_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_permission IS NULL OR p_permission NOT IN ('automation.workflow.read','automation.workflow.manage','automation.workflow.activate','contact.tag.read','contact.tag.manage')
    OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 2048 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=p_permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier='COMPLETE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Definition validator (schema version 1). Mirrors validateAutomationDefinition in @hon/contracts exactly.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION hon.automation_invalid(p_what text) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'AUTOMATION_INVALID' USING ERRCODE='22023', DETAIL=left(coalesce(p_what,''),120); END $$;

-- p has exactly these keys.
CREATE FUNCTION hon.automation_keys(p jsonb,p_keys text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN p IS NOT NULL AND jsonb_typeof(p)='object' THEN (SELECT coalesce(array_agg(k ORDER BY k),'{}') FROM jsonb_object_keys(p) k)
    = (SELECT coalesce(array_agg(k ORDER BY k),'{}') FROM unnest(p_keys) k) ELSE false END
$$;
CREATE FUNCTION hon.automation_int(p jsonb,p_min integer,p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='number' AND (p#>>'{}') ~ '^(0|-?[1-9][0-9]{0,8})$' AND (p#>>'{}')::integer BETWEEN p_min AND p_max
$$;
CREATE FUNCTION hon.automation_uuid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='string' AND (p#>>'{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$$;
CREATE FUNCTION hon.automation_enum(p jsonb,p_allowed text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='string' AND (p#>>'{}')=ANY(p_allowed)
$$;
-- Plain text: trimmed, min..max characters, no control characters except tab and line breaks, and every {{...}} is one
-- of the closed merge fields.
CREATE FUNCTION hon.automation_text(p jsonb,p_min integer,p_max integer,p_merge boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='string' AND (p#>>'{}')=btrim(p#>>'{}')
    AND length(p#>>'{}') BETWEEN p_min AND p_max AND (p#>>'{}') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
    AND (CASE WHEN p_merge THEN regexp_replace(p#>>'{}','\{\{(first_name|school_name|program_name|trial_time|booking_link|staff_name)\}\}','','g')
         ELSE p#>>'{}' END) !~ '(\{\{|\}\})'
$$;
CREATE FUNCTION hon.automation_tag_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='string' AND (p#>>'{}') ~ '^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,38}[A-Za-z0-9])?$'
$$;
CREATE FUNCTION hon.automation_tool_key_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='string' AND (p#>>'{}') ~ '^[a-z][a-z0-9_]{0,47}$'
$$;
CREATE FUNCTION hon.automation_local_time(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='string' AND (p#>>'{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
$$;
CREATE FUNCTION hon.automation_date(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN p IS NOT NULL AND jsonb_typeof(p)='string' AND (p#>>'{}') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
    AND to_char((p#>>'{}')::date,'YYYY-MM-DD')=(p#>>'{}');
EXCEPTION WHEN others THEN RETURN false;
END $$;
-- A JSON array of 0..p_max distinct items, each satisfying the named element check.
CREATE FUNCTION hon.automation_list(p jsonb,p_min integer,p_max integer,p_kind text,p_allowed text[] DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE e jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p) NOT BETWEEN p_min AND p_max
    OR (SELECT count(DISTINCT lower(x#>>'{}')) FROM jsonb_array_elements(p) x)<>jsonb_array_length(p) THEN RETURN false; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p) LOOP
    IF NOT (CASE p_kind WHEN 'tag' THEN hon.automation_tag_ok(e) WHEN 'uuid' THEN hon.automation_uuid(e)
      WHEN 'enum' THEN hon.automation_enum(e,p_allowed) WHEN 'weekday' THEN hon.automation_int(e,1,7) ELSE false END) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION hon.automation_condition_ok(c jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE k text;
BEGIN
  IF c IS NULL OR jsonb_typeof(c)<>'object' OR jsonb_typeof(c->'kind') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'negate') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  k:=c->>'kind';
  RETURN CASE k
    WHEN 'LEAD_IS_OPEN' THEN hon.automation_keys(c,ARRAY['kind','negate'])
    WHEN 'IS_ACTIVE_STUDENT' THEN hon.automation_keys(c,ARRAY['kind','negate'])
    WHEN 'TRIAL_BOOKED' THEN hon.automation_keys(c,ARRAY['kind','negate'])
    WHEN 'REPLIED' THEN hon.automation_keys(c,ARRAY['kind','negate'])
    WHEN 'LEAD_STAGE_IS' THEN hon.automation_keys(c,ARRAY['kind','negate','stageId']) AND hon.automation_uuid(c->'stageId')
    WHEN 'IN_PROGRAM' THEN hon.automation_keys(c,ARRAY['kind','negate','programId']) AND hon.automation_uuid(c->'programId')
    WHEN 'HAS_CONSENT' THEN hon.automation_keys(c,ARRAY['kind','negate','channel']) AND hon.automation_enum(c->'channel',ARRAY['SMS','EMAIL'])
    WHEN 'MEMBERSHIP_ENDS_WITHIN' THEN hon.automation_keys(c,ARRAY['kind','negate','days']) AND hon.automation_int(c->'days',1,365)
    WHEN 'HAS_TAG' THEN hon.automation_keys(c,ARRAY['kind','negate','tag']) AND hon.automation_tag_ok(c->'tag')
    WHEN 'ATTENDED_AT_LEAST' THEN hon.automation_keys(c,ARRAY['kind','negate','count','days']) AND hon.automation_int(c->'count',1,100) AND hon.automation_int(c->'days',1,365)
    WHEN 'CUSTOM_FIELD_EQUALS' THEN hon.automation_keys(c,ARRAY['kind','negate','toolKey','field','value']) AND hon.automation_tool_key_ok(c->'toolKey')
      AND hon.automation_tool_key_ok(c->'field') AND hon.automation_text(c->'value',1,200,false)
    ELSE false END;
END $$;

CREATE FUNCTION hon.automation_trigger_ok(t jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE k text; c jsonb;
BEGIN
  IF NOT hon.automation_keys(t,ARRAY['kind','config']) OR jsonb_typeof(t->'kind')<>'string' OR jsonb_typeof(t->'config')<>'object' THEN RETURN false; END IF;
  k:=t->>'kind'; c:=t->'config';
  IF k IN ('LEAD_CREATED','META_LEAD_RECEIVED','TRIAL_BOOKED','TRIAL_CANCELLED','TRIAL_ATTENDED','TRIAL_NO_SHOW','CLASS_BOOKING_CREATED',
    'EVENT_BOOKING_CREATED','EVENT_BOOKING_CANCELLED','MEMBERSHIP_ACTIVATED','MEMBERSHIP_CANCELLED','MISSED_CALL','CONVERSATION_MESSAGE_RECEIVED',
    'CONVERSATION_ESCALATED','TESTING_REGISTRATION_SUBMITTED','MEMBERSHIP_ANNIVERSARY','MANUAL') THEN RETURN c='{}'::jsonb; END IF;
  RETURN CASE k
    WHEN 'FORM_LEAD_RECEIVED' THEN hon.automation_keys(c,ARRAY['formId']) AND (c->'formId'='null'::jsonb OR hon.automation_uuid(c->'formId'))
    WHEN 'TAG_ADDED' THEN hon.automation_keys(c,ARRAY['tag']) AND hon.automation_tag_ok(c->'tag')
    WHEN 'CUSTOM_TOOL_RECORD' THEN hon.automation_keys(c,ARRAY['toolKey','change']) AND hon.automation_tool_key_ok(c->'toolKey')
      AND hon.automation_enum(c->'change',ARRAY['CREATED','UPDATED','ARCHIVED','RESTORED'])
    WHEN 'ABSENT_DAYS' THEN hon.automation_keys(c,ARRAY['days']) AND hon.automation_int(c->'days',3,365)
    WHEN 'MEMBERSHIP_ENDS_IN_DAYS' THEN hon.automation_keys(c,ARRAY['days']) AND hon.automation_int(c->'days',1,180)
    WHEN 'BIRTHDAY' THEN hon.automation_keys(c,ARRAY['daysBefore']) AND hon.automation_int(c->'daysBefore',0,30)
    WHEN 'SCHEDULE' THEN hon.automation_keys(c,ARRAY['mode','date','weekdays','localTime','audience']) AND hon.automation_local_time(c->'localTime')
      AND CASE c->>'mode'
        WHEN 'ONCE' THEN jsonb_typeof(c->'mode')='string' AND hon.automation_date(c->'date') AND c->'weekdays'='null'::jsonb
        WHEN 'WEEKLY' THEN jsonb_typeof(c->'mode')='string' AND c->'date'='null'::jsonb AND hon.automation_list(c->'weekdays',1,7,'weekday')
        ELSE false END
      AND hon.automation_keys(c->'audience',ARRAY['groups','tags','rankIds'])
      AND hon.automation_list(c->'audience'->'groups',1,5,'enum',ARRAY['ACTIVE_STUDENTS','ALL_CONTACTS','PROSPECTS','TRIAL','FORMER_STUDENTS'])
      AND hon.automation_list(c->'audience'->'tags',0,10,'tag') AND hon.automation_list(c->'audience'->'rankIds',0,20,'uuid')
    ELSE false END;
END $$;

-- One message body: fixed wording, or AI-written with fixed fallback wording (used when AI is unavailable).
CREATE FUNCTION hon.automation_content_ok(c jsonb,p_email boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE body_max integer:=CASE WHEN p_email THEN 4000 ELSE 1000 END;
BEGIN
  IF c IS NULL OR jsonb_typeof(c)<>'object' THEN RETURN false; END IF;
  RETURN CASE c->>'mode'
    WHEN 'FIXED' THEN jsonb_typeof(c->'mode')='string' AND CASE WHEN p_email
      THEN hon.automation_keys(c,ARRAY['mode','subject','text']) AND hon.automation_text(c->'subject',1,150,true)
      ELSE hon.automation_keys(c,ARRAY['mode','text']) END AND hon.automation_text(c->'text',1,body_max,true)
    WHEN 'AI' THEN jsonb_typeof(c->'mode')='string' AND CASE WHEN p_email
      THEN hon.automation_keys(c,ARRAY['mode','purpose','guidance','fallbackSubject','fallbackText']) AND hon.automation_text(c->'fallbackSubject',1,150,true)
      ELSE hon.automation_keys(c,ARRAY['mode','purpose','guidance','fallbackText']) END
      AND hon.automation_enum(c->'purpose',ARRAY['INTRODUCTION','CHECK_IN','TRIAL_REMINDER','REENGAGEMENT','BIRTHDAY','RENEWAL','THANK_YOU','REVIEW_REQUEST','OTHER'])
      AND (c->>'guidance'='' AND jsonb_typeof(c->'guidance')='string' OR hon.automation_text(c->'guidance',1,500,false))
      AND hon.automation_text(c->'fallbackText',1,body_max,true)
    ELSE false END;
END $$;

-- The outgoing edges of one step (next, or yes and no), or NULL when the step's shape is wrong.
CREATE FUNCTION hon.automation_step_edges(s jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE k text:=s->>'type'; ok boolean; edges jsonb[];
BEGIN
  IF s IS NULL OR jsonb_typeof(s)<>'object' OR jsonb_typeof(s->'type') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  ok:=CASE k
    WHEN 'SEND_SMS' THEN hon.automation_keys(s,ARRAY['id','type','content','next']) AND hon.automation_content_ok(s->'content',false)
    WHEN 'SEND_EMAIL' THEN hon.automation_keys(s,ARRAY['id','type','content','next']) AND hon.automation_content_ok(s->'content',true)
    WHEN 'CREATE_TASK' THEN hon.automation_keys(s,ARRAY['id','type','title','details','dueInHours','assignTo','next'])
      AND hon.automation_text(s->'title',1,120,true) AND (s->>'details'='' AND jsonb_typeof(s->'details')='string' OR hon.automation_text(s->'details',1,1000,true))
      AND hon.automation_int(s->'dueInHours',0,720) AND hon.automation_enum(s->'assignTo',ARRAY['SCHOOL_OWNERS','LEAD_ASSIGNEE'])
    WHEN 'NOTIFY_STAFF' THEN hon.automation_keys(s,ARRAY['id','type','to','text','next']) AND hon.automation_enum(s->'to',ARRAY['SCHOOL_OWNERS','LEAD_ASSIGNEE'])
      AND hon.automation_text(s->'text',1,500,true)
    WHEN 'ASSIGN_LEAD' THEN hon.automation_keys(s,ARRAY['id','type','staffPrincipalId','next']) AND hon.automation_uuid(s->'staffPrincipalId')
    WHEN 'ADD_TAG' THEN hon.automation_keys(s,ARRAY['id','type','tag','next']) AND hon.automation_tag_ok(s->'tag')
    WHEN 'REMOVE_TAG' THEN hon.automation_keys(s,ARRAY['id','type','tag','next']) AND hon.automation_tag_ok(s->'tag')
    WHEN 'MOVE_STAGE' THEN hon.automation_keys(s,ARRAY['id','type','stageId','next']) AND hon.automation_uuid(s->'stageId')
    WHEN 'START_WORKFLOW' THEN hon.automation_keys(s,ARRAY['id','type','workflowId','next']) AND hon.automation_uuid(s->'workflowId')
    WHEN 'WAIT' THEN hon.automation_keys(s,ARRAY['id','type','minutes','localTime','next'])
      AND ((hon.automation_int(s->'minutes',1,525600) AND s->'localTime'='null'::jsonb) OR (s->'minutes'='null'::jsonb AND hon.automation_local_time(s->'localTime')))
    WHEN 'WAIT_FOR' THEN hon.automation_keys(s,ARRAY['id','type','event','timeoutMinutes','yes','no'])
      AND hon.automation_enum(s->'event',ARRAY['TRIAL_BOOKED','REPLIED','ENROLLED']) AND hon.automation_int(s->'timeoutMinutes',1,43200)
    WHEN 'IF' THEN hon.automation_keys(s,ARRAY['id','type','condition','yes','no']) AND hon.automation_condition_ok(s->'condition')
    WHEN 'REQUEST_APPROVAL' THEN hon.automation_keys(s,ARRAY['id','type','question','yes','no']) AND hon.automation_text(s->'question',1,300,true)
    WHEN 'STOP' THEN hon.automation_keys(s,ARRAY['id','type'])
    ELSE false END;
  IF NOT coalesce(ok,false) THEN RETURN NULL; END IF;
  edges:=CASE WHEN k='STOP' THEN ARRAY[]::jsonb[] WHEN k IN ('WAIT_FOR','IF','REQUEST_APPROVAL') THEN ARRAY[s->'yes',s->'no'] ELSE ARRAY[s->'next'] END;
  IF EXISTS(SELECT 1 FROM unnest(edges) e WHERE e<>'null'::jsonb AND (jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[a-z][a-z0-9_]{0,31}$')) THEN RETURN NULL; END IF;
  RETURN coalesce((SELECT array_agg(e#>>'{}') FROM unnest(edges) e WHERE e<>'null'::jsonb),ARRAY[]::text[]);
END $$;

-- Raises AUTOMATION_INVALID unless d is a complete schema-version-1 definition; returns the trigger kind.
CREATE FUNCTION hon.validate_automation_definition(d jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE s jsonb; e jsonb; ids text[]:=ARRAY[]::text[]; edges text[]; n integer; i integer; t text;
  indeg jsonb:='{}'::jsonb; adj jsonb:='{}'::jsonb; queue text[]; cur text; seen integer:=0;
BEGIN
  IF d IS NULL OR NOT hon.automation_keys(d,ARRAY['schemaVersion','trigger','entry','exitWhen','steps']) OR d->'schemaVersion'<>'1'::jsonb
    OR octet_length(d::text)>65536 THEN PERFORM hon.automation_invalid('definition'); END IF;
  IF NOT hon.automation_trigger_ok(d->'trigger') THEN PERFORM hon.automation_invalid('trigger'); END IF;
  e:=d->'entry';
  IF NOT hon.automation_keys(e,ARRAY['reentry','reentryDays','conditions'])
    OR NOT (CASE e->>'reentry' WHEN 'ONCE_PER_PERIOD' THEN hon.automation_int(e->'reentryDays',1,365)
      WHEN 'ONCE_EVER' THEN e->'reentryDays'='null'::jsonb WHEN 'EVERY_TIME' THEN e->'reentryDays'='null'::jsonb ELSE false END)
    OR jsonb_typeof(e->'reentry')<>'string' OR jsonb_typeof(e->'conditions')<>'array' THEN PERFORM hon.automation_invalid('entry'); END IF;
  IF jsonb_array_length(e->'conditions')>10
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(e->'conditions') x WHERE NOT hon.automation_condition_ok(x)) THEN PERFORM hon.automation_invalid('entry'); END IF;
  IF NOT hon.automation_list(d->'exitWhen',0,5,'enum',ARRAY['TRIAL_BOOKED','REPLIED','ENROLLED','LEAD_CLOSED','OPTED_OUT']) THEN PERFORM hon.automation_invalid('exitWhen'); END IF;
  IF jsonb_typeof(d->'steps')<>'array' THEN PERFORM hon.automation_invalid('steps'); END IF;
  IF jsonb_array_length(d->'steps') NOT BETWEEN 1 AND 50 THEN PERFORM hon.automation_invalid('steps'); END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(d->'steps') LOOP
    IF jsonb_typeof(s->'id') IS DISTINCT FROM 'string' OR (s->>'id') !~ '^[a-z][a-z0-9_]{0,31}$' OR (s->>'id')=ANY(ids) THEN PERFORM hon.automation_invalid('step id'); END IF;
    ids:=ids||(s->>'id');
  END LOOP;
  FOR s IN SELECT * FROM jsonb_array_elements(d->'steps') LOOP
    edges:=hon.automation_step_edges(s);
    IF edges IS NULL THEN PERFORM hon.automation_invalid('step '||(s->>'id')); END IF;
    FOREACH t IN ARRAY edges LOOP
      IF NOT t=ANY(ids) OR t=(s->>'id') THEN PERFORM hon.automation_invalid('step '||(s->>'id')||' link'); END IF;
      indeg:=jsonb_set(indeg,ARRAY[t],to_jsonb(coalesce((indeg->>t)::integer,0)+1));
    END LOOP;
    adj:=jsonb_set(adj,ARRAY[s->>'id'],to_jsonb(edges));
  END LOOP;
  -- Every step is reached from the first step and no path loops: only the first step has no incoming link, and
  -- repeatedly removing steps with no remaining incoming link removes them all.
  n:=array_length(ids,1);
  IF coalesce((indeg->>ids[1])::integer,0)<>0 THEN PERFORM hon.automation_invalid('first step is linked to'); END IF;
  FOR i IN 2..n LOOP
    IF coalesce((indeg->>ids[i])::integer,0)=0 THEN PERFORM hon.automation_invalid('step '||ids[i]||' is never reached'); END IF;
  END LOOP;
  queue:=ARRAY[ids[1]];
  WHILE array_length(queue,1)>0 LOOP
    cur:=queue[1]; queue:=queue[2:]; seen:=seen+1;
    FOR t IN SELECT jsonb_array_elements_text(adj->cur) LOOP
      indeg:=jsonb_set(indeg,ARRAY[t],to_jsonb((indeg->>t)::integer-1));
      IF (indeg->>t)::integer=0 THEN queue:=queue||t; END IF;
    END LOOP;
  END LOOP;
  IF seen<>n THEN PERFORM hon.automation_invalid('steps loop'); END IF;
  RETURN d->'trigger'->>'kind';
END $$;

CREATE FUNCTION hon.automation_name(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT hon.automation_text(p,1,100,false) OR (p#>>'{}') ~ '[\t\n\r​-‏‪-‮⁠-⁯﻿]' THEN PERFORM hon.automation_invalid('name'); END IF;
  RETURN p#>>'{}';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Shared command plumbing
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION hon.automation_check_call(p_key text,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    PERFORM hon.automation_invalid('call'); END IF;
END $$;
CREATE FUNCTION hon.automation_claim(p_org uuid,p_school uuid,p_actor uuid,p_key text,p_operation text,p_fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE prior hon.automation_commands%ROWTYPE;
BEGIN
  INSERT INTO hon.automation_commands(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(p_org,p_school,p_actor,p_key,p_operation,p_fp) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.automation_commands WHERE organization_id=p_org AND school_id=p_school AND principal_id=p_actor AND idempotency_key=p_key FOR UPDATE;
  IF prior.operation<>p_operation OR prior.fingerprint<>p_fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.response IS NULL THEN RAISE EXCEPTION 'AUTOMATION_BUSY' USING ERRCODE='55P03'; END IF;
  RETURN jsonb_build_object('record',prior.response,'replayed',true);
END $$;
CREATE FUNCTION hon.automation_finish(p_org uuid,p_school uuid,p_actor uuid,p_key text,p_result jsonb) RETURNS void
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  UPDATE hon.automation_commands SET response=p_result,completed_at=clock_timestamp()
  WHERE organization_id=p_org AND school_id=p_school AND principal_id=p_actor AND idempotency_key=p_key;
$$;
CREATE FUNCTION hon.automation_fp(p_operation text,p_value text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$ SELECT encode(sha256(convert_to(p_operation||':'||p_value,'UTF8')),'hex') $$;

CREATE FUNCTION hon.automation_workflow_json(w hon.automation_workflows) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('workflowId',w.id,'name',w.name,'status',w.status,'revision',w.revision,'latestVersion',w.latest_version,
    'activeVersion',w.active_version,'triggerKind',w.trigger_kind,'pausedReason',w.paused_reason,
    'stepCount',(SELECT jsonb_array_length(v.definition->'steps') FROM hon.automation_workflow_versions v WHERE v.workflow_id=w.id AND v.version=w.latest_version),
    'activatedAt',hon.saas_ts(w.activated_at),'createdAt',hon.saas_ts(w.created_at),'updatedAt',hon.saas_ts(w.updated_at))
$$;
CREATE FUNCTION hon.automation_version_json(v hon.automation_workflow_versions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('workflowId',v.workflow_id,'version',v.version,'name',v.name,'source',v.source,'restoredFromVersion',v.restored_from_version,
    'definition',v.definition,'recordedAt',hon.saas_ts(v.recorded_at),
    'author',(SELECT left(coalesce(nullif(btrim(u.display_name),''),'School staff'),120) FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=v.author_principal_id))
$$;
CREATE FUNCTION hon.automation_detail_json(w hon.automation_workflows) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('workflow',hon.automation_workflow_json(w),
    'latest',(SELECT hon.automation_version_json(v) FROM hon.automation_workflow_versions v WHERE v.workflow_id=w.id AND v.version=w.latest_version),
    'versions',(SELECT coalesce(jsonb_agg(jsonb_build_object('version',v.version,'name',v.name,'source',v.source,'restoredFromVersion',v.restored_from_version,
        'recordedAt',hon.saas_ts(v.recorded_at)) ORDER BY v.version DESC),'[]'::jsonb) FROM hon.automation_workflow_versions v WHERE v.workflow_id=w.id))
$$;

CREATE FUNCTION hon.automation_evidence(p_org uuid,p_school uuid,p_actor uuid,p_code text,p_entity text,p_id uuid,p_version integer,p_state jsonb,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(p_org,p_school,p_actor,'HUMAN_UI',p_code,p_entity,p_id,p_state,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(p_org,p_school,p_code,1,p_entity,p_id,p_version,p_correlation,p_request,p_state);
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Workflow commands and reads
-- ---------------------------------------------------------------------------------------------------------------------
-- CREATE {name, definition}: a new DRAFT with version 1.
CREATE FUNCTION hon.create_automation_workflow(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; v_name text; v_kind text;
  w hon.automation_workflows%ROWTYPE; at timestamptz:=clock_timestamp(); result jsonb;
BEGIN
  IF NOT hon.automation_keys(p_input,ARRAY['name','definition']) THEN PERFORM hon.automation_invalid('input'); END IF;
  PERFORM hon.automation_check_call(p_key,p_request,p_correlation);
  v_name:=hon.automation_name(p_input->'name'); v_kind:=hon.validate_automation_definition(p_input->'definition');
  actor:=hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage');
  replay:=hon.automation_claim(org,school,actor,p_key,'WF_CREATE',hon.automation_fp('create',p_input::text));
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('automation-workflows:'||school::text,0));
  IF (SELECT count(*) FROM hon.automation_workflows WHERE organization_id=org AND school_id=school AND status<>'ARCHIVED')>=100 THEN
    RAISE EXCEPTION 'AUTOMATION_LIMIT_REACHED' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.automation_workflows(organization_id,school_id,name,status,trigger_kind,latest_version,created_by_principal_id,created_at,updated_at)
    VALUES(org,school,v_name,'DRAFT',v_kind,1,actor,at,at) RETURNING * INTO w;
  INSERT INTO hon.automation_workflow_versions(workflow_id,organization_id,school_id,version,name,definition,source,author_principal_id,request_id,recorded_at)
    VALUES(w.id,org,school,1,v_name,p_input->'definition','HUMAN_UI',actor,p_request,at);
  result:=hon.automation_detail_json(w);
  PERFORM hon.automation_evidence(org,school,actor,'automation.workflow.created','AUTOMATION_WORKFLOW',w.id,1,jsonb_build_object('version',1,'triggerKind',v_kind),p_request,p_correlation);
  PERFORM hon.automation_finish(org,school,actor,p_key,result);
  IF hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- Locks one of this school's workflows at the caller's expected revision.
CREATE FUNCTION hon.automation_lock_workflow(p_org uuid,p_school uuid,p_id uuid,p_expected jsonb) RETURNS hon.automation_workflows
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE w hon.automation_workflows%ROWTYPE;
BEGIN
  IF p_id IS NULL OR NOT hon.automation_int(p_expected,1,999999999) THEN PERFORM hon.automation_invalid('expectedRevision'); END IF;
  SELECT * INTO w FROM hon.automation_workflows WHERE id=p_id AND organization_id=p_org AND school_id=p_school FOR UPDATE;
  IF w.id IS NULL THEN RAISE EXCEPTION 'AUTOMATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF w.revision<>(p_expected#>>'{}')::integer THEN RAISE EXCEPTION 'AUTOMATION_STALE' USING ERRCODE='40001'; END IF;
  IF w.status='ARCHIVED' THEN RAISE EXCEPTION 'AUTOMATION_ARCHIVED' USING ERRCODE='23514'; END IF;
  RETURN w;
END $$;

-- Appends a version. A workflow that is on keeps running its active version until someone turns on the new one (AU-2).
CREATE FUNCTION hon.automation_append_version(w hon.automation_workflows,p_name text,p_definition jsonb,p_restored integer,p_actor uuid,p_request uuid) RETURNS hon.automation_workflows
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE v_kind text:=hon.validate_automation_definition(p_definition); at timestamptz:=clock_timestamp(); r hon.automation_workflows%ROWTYPE;
BEGIN
  IF w.latest_version>=500 THEN RAISE EXCEPTION 'AUTOMATION_LIMIT_REACHED' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.automation_workflow_versions(workflow_id,organization_id,school_id,version,name,definition,source,restored_from_version,author_principal_id,request_id,recorded_at)
    VALUES(w.id,w.organization_id,w.school_id,w.latest_version+1,p_name,p_definition,'HUMAN_UI',p_restored,p_actor,p_request,at);
  UPDATE hon.automation_workflows SET name=p_name,trigger_kind=v_kind,latest_version=w.latest_version+1,revision=w.revision+1,updated_at=at
    WHERE id=w.id RETURNING * INTO r;
  RETURN r;
END $$;

-- SAVE {expectedRevision, name, definition}
CREATE FUNCTION hon.save_automation_workflow_version(p_subject text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; v_name text;
  w hon.automation_workflows%ROWTYPE; result jsonb;
BEGIN
  IF p_id IS NULL OR NOT hon.automation_keys(p_input,ARRAY['expectedRevision','name','definition']) THEN PERFORM hon.automation_invalid('input'); END IF;
  PERFORM hon.automation_check_call(p_key,p_request,p_correlation);
  v_name:=hon.automation_name(p_input->'name'); PERFORM hon.validate_automation_definition(p_input->'definition');
  actor:=hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage');
  replay:=hon.automation_claim(org,school,actor,p_key,'WF_SAVE',hon.automation_fp('save:'||p_id::text,p_input::text));
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  w:=hon.automation_lock_workflow(org,school,p_id,p_input->'expectedRevision');
  w:=hon.automation_append_version(w,v_name,p_input->'definition',NULL,actor,p_request);
  result:=hon.automation_detail_json(w);
  PERFORM hon.automation_evidence(org,school,actor,'automation.workflow.version_saved','AUTOMATION_WORKFLOW',w.id,w.revision,jsonb_build_object('version',w.latest_version,'triggerKind',w.trigger_kind),p_request,p_correlation);
  PERFORM hon.automation_finish(org,school,actor,p_key,result);
  IF hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- RESTORE {expectedRevision, fromVersion}: appends a copy of an older version (name and definition).
CREATE FUNCTION hon.restore_automation_workflow_version(p_subject text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb;
  w hon.automation_workflows%ROWTYPE; old hon.automation_workflow_versions%ROWTYPE; result jsonb;
BEGIN
  IF p_id IS NULL OR NOT hon.automation_keys(p_input,ARRAY['expectedRevision','fromVersion']) OR NOT hon.automation_int(p_input->'fromVersion',1,500) THEN
    PERFORM hon.automation_invalid('input'); END IF;
  PERFORM hon.automation_check_call(p_key,p_request,p_correlation);
  actor:=hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage');
  replay:=hon.automation_claim(org,school,actor,p_key,'WF_RESTORE',hon.automation_fp('restore:'||p_id::text,p_input::text));
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  w:=hon.automation_lock_workflow(org,school,p_id,p_input->'expectedRevision');
  SELECT * INTO old FROM hon.automation_workflow_versions WHERE workflow_id=w.id AND version=(p_input->>'fromVersion')::integer;
  IF old.workflow_id IS NULL OR old.version=w.latest_version THEN RAISE EXCEPTION 'AUTOMATION_VERSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  w:=hon.automation_append_version(w,old.name,old.definition,old.version,actor,p_request);
  result:=hon.automation_detail_json(w);
  PERFORM hon.automation_evidence(org,school,actor,'automation.workflow.version_restored','AUTOMATION_WORKFLOW',w.id,w.revision,jsonb_build_object('version',w.latest_version,'fromVersion',old.version),p_request,p_correlation);
  PERFORM hon.automation_finish(org,school,actor,p_key,result);
  IF hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- ARCHIVE {expectedRevision}: only a DRAFT. A workflow that is on or paused is turned off first (AU-2). Final.
CREATE FUNCTION hon.archive_automation_workflow(p_subject text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb;
  w hon.automation_workflows%ROWTYPE; result jsonb;
BEGIN
  IF p_id IS NULL OR NOT hon.automation_keys(p_input,ARRAY['expectedRevision']) THEN PERFORM hon.automation_invalid('input'); END IF;
  PERFORM hon.automation_check_call(p_key,p_request,p_correlation);
  actor:=hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage');
  replay:=hon.automation_claim(org,school,actor,p_key,'WF_ARCHIVE',hon.automation_fp('archive:'||p_id::text,p_input::text));
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  w:=hon.automation_lock_workflow(org,school,p_id,p_input->'expectedRevision');
  IF w.status<>'DRAFT' THEN RAISE EXCEPTION 'AUTOMATION_NOT_DRAFT' USING ERRCODE='23514'; END IF;
  UPDATE hon.automation_workflows SET status='ARCHIVED',revision=w.revision+1,updated_at=clock_timestamp() WHERE id=w.id RETURNING * INTO w;
  result:=hon.automation_detail_json(w);
  PERFORM hon.automation_evidence(org,school,actor,'automation.workflow.archived','AUTOMATION_WORKFLOW',w.id,w.revision,jsonb_build_object('version',w.latest_version),p_request,p_correlation);
  PERFORM hon.automation_finish(org,school,actor,p_key,result);
  IF hon.require_automation_workflow_actor(p_subject,'automation.workflow.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- The school's workflows (at most 100 not archived plus the 100 most recently archived), newest change first.
CREATE FUNCTION hon.read_automation_workflows(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  PERFORM hon.require_automation_workflow_actor(p_subject,'automation.workflow.read');
  RETURN jsonb_build_object('workflows',coalesce((SELECT jsonb_agg(hon.automation_workflow_json(x) ORDER BY x.updated_at DESC,x.id) FROM hon.automation_workflows x
      WHERE x.id IN ((SELECT id FROM hon.automation_workflows WHERE organization_id=org AND school_id=school AND status<>'ARCHIVED' ORDER BY updated_at DESC,id LIMIT 100)
        UNION ALL (SELECT id FROM hon.automation_workflows WHERE organization_id=org AND school_id=school AND status='ARCHIVED' ORDER BY updated_at DESC,id LIMIT 100))),'[]'::jsonb),
    'limits',jsonb_build_object('workflows',100,'versions',500,'steps',50),'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;

CREATE FUNCTION hon.read_automation_workflow(p_subject text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); w hon.automation_workflows%ROWTYPE;
BEGIN
  PERFORM hon.require_automation_workflow_actor(p_subject,'automation.workflow.read');
  SELECT * INTO w FROM hon.automation_workflows WHERE id=p_id AND organization_id=org AND school_id=school;
  IF w.id IS NULL THEN RAISE EXCEPTION 'AUTOMATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.automation_detail_json(w);
END $$;

CREATE FUNCTION hon.read_automation_workflow_version(p_subject text,p_id uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); v hon.automation_workflow_versions%ROWTYPE;
BEGIN
  PERFORM hon.require_automation_workflow_actor(p_subject,'automation.workflow.read');
  SELECT * INTO v FROM hon.automation_workflow_versions WHERE workflow_id=p_id AND version=p_version AND organization_id=org AND school_id=school;
  IF v.workflow_id IS NULL THEN RAISE EXCEPTION 'AUTOMATION_VERSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.automation_version_json(v);
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Contact tags
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION hon.contact_tag_list_json(p_org uuid,p_school uuid,p_person uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('personId',p_person,'tags',coalesce((SELECT jsonb_agg(jsonb_build_object('tag',t.tag,'tagKey',t.tag_key,'addedSource',t.added_source,
      'addedAt',hon.saas_ts(t.added_at)) ORDER BY t.tag_key) FROM hon.contact_tags t WHERE t.organization_id=p_org AND t.school_id=p_school AND t.person_id=p_person),'[]'::jsonb))
$$;

-- Adds or removes one tag on one person at one school. Private: the staff commands below, and later the engine (source
-- AUTOMATION with its run id). Returns true when something changed; adding a present tag or removing an absent one is a
-- no-op. Limits: 20 tags per person, 200 distinct tags per school.
CREATE FUNCTION hon.contact_tag_apply(p_org uuid,p_school uuid,p_person uuid,p_tag text,p_add boolean,p_actor uuid,p_source text,p_run uuid,p_request uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE v_key text;
BEGIN
  IF NOT hon.automation_tag_ok(to_jsonb(p_tag)) THEN PERFORM hon.automation_invalid('tag'); END IF;
  v_key:=lower(p_tag);
  IF NOT EXISTS(SELECT 1 FROM hon.people WHERE id=p_person AND organization_id=p_org AND school_id=p_school) THEN
    RAISE EXCEPTION 'CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('contact-tags:'||p_school::text,0));
  IF p_add THEN
    IF EXISTS(SELECT 1 FROM hon.contact_tags WHERE organization_id=p_org AND school_id=p_school AND person_id=p_person AND tag_key=v_key) THEN RETURN false; END IF;
    IF (SELECT count(*) FROM hon.contact_tags WHERE organization_id=p_org AND school_id=p_school AND person_id=p_person)>=20
      OR (NOT EXISTS(SELECT 1 FROM hon.contact_tags WHERE organization_id=p_org AND school_id=p_school AND tag_key=v_key)
        AND (SELECT count(DISTINCT tag_key) FROM hon.contact_tags WHERE organization_id=p_org AND school_id=p_school)>=200) THEN
      RAISE EXCEPTION 'CONTACT_TAG_LIMIT_REACHED' USING ERRCODE='54000'; END IF;
    INSERT INTO hon.contact_tags(organization_id,school_id,person_id,tag,tag_key,added_by_principal_id,added_source)
      VALUES(p_org,p_school,p_person,p_tag,v_key,p_actor,p_source);
  ELSE
    DELETE FROM hon.contact_tags WHERE organization_id=p_org AND school_id=p_school AND person_id=p_person AND tag_key=v_key;
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;
  INSERT INTO hon.contact_tag_events(organization_id,school_id,person_id,kind,tag,tag_key,actor_principal_id,source,automation_run_id,request_id)
    VALUES(p_org,p_school,p_person,CASE WHEN p_add THEN 'ADDED' ELSE 'REMOVED' END,p_tag,v_key,p_actor,p_source,p_run,p_request);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(p_org,p_school,CASE WHEN p_add THEN 'contact.tag.added' ELSE 'contact.tag.removed' END,1,'PERSON',p_person,1,coalesce(p_request,gen_random_uuid()),p_request,
      jsonb_build_object('personId',p_person,'tagKey',v_key,'source',p_source,'automationRunId',p_run));
  RETURN true;
END $$;

CREATE FUNCTION hon.change_contact_tag(p_subject text,p_person uuid,p_input jsonb,p_add boolean,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; changed boolean; result jsonb;
BEGIN
  IF p_person IS NULL OR p_add IS NULL OR NOT hon.automation_keys(p_input,ARRAY['tag']) OR NOT hon.automation_tag_ok(p_input->'tag') THEN PERFORM hon.automation_invalid('tag'); END IF;
  PERFORM hon.automation_check_call(p_key,p_request,p_correlation);
  actor:=hon.require_automation_workflow_actor(p_subject,'contact.tag.manage');
  replay:=hon.automation_claim(org,school,actor,p_key,CASE WHEN p_add THEN 'TAG_ADD' ELSE 'TAG_REMOVE' END,
    hon.automation_fp(CASE WHEN p_add THEN 'tag.add:' ELSE 'tag.remove:' END||p_person::text,lower(p_input->>'tag')));
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  changed:=hon.contact_tag_apply(org,school,p_person,p_input->>'tag',p_add,actor,'HUMAN_UI',NULL,p_request);
  result:=hon.contact_tag_list_json(org,school,p_person)||jsonb_build_object('changed',changed);
  IF changed THEN
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
      VALUES(org,school,actor,'HUMAN_UI',CASE WHEN p_add THEN 'contact.tag.added' ELSE 'contact.tag.removed' END,'PERSON',p_person,
        jsonb_build_object('tagKey',lower(p_input->>'tag')),'SUCCEEDED',p_request,p_correlation);
  END IF;
  PERFORM hon.automation_finish(org,school,actor,p_key,result);
  IF hon.require_automation_workflow_actor(p_subject,'contact.tag.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'AUTOMATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;
CREATE FUNCTION hon.add_contact_tag(p_subject text,p_person uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$ SELECT hon.change_contact_tag(p_subject,p_person,p_input,true,p_key,p_request,p_correlation) $$;
CREATE FUNCTION hon.remove_contact_tag(p_subject text,p_person uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$ SELECT hon.change_contact_tag(p_subject,p_person,p_input,false,p_key,p_request,p_correlation) $$;

CREATE FUNCTION hon.read_school_contact_tags(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  PERFORM hon.require_automation_workflow_actor(p_subject,'contact.tag.read');
  RETURN jsonb_build_object('tags',coalesce((SELECT jsonb_agg(jsonb_build_object('tag',x.tag,'tagKey',x.tag_key,'count',x.n) ORDER BY x.tag_key) FROM (
      SELECT tag_key,min(tag) tag,count(*) n FROM hon.contact_tags WHERE organization_id=org AND school_id=school GROUP BY tag_key) x),'[]'::jsonb),
    'limits',jsonb_build_object('perPerson',20,'perSchool',200,'tagMax',40),'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;

CREATE FUNCTION hon.read_person_contact_tags(p_subject text,p_person uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  PERFORM hon.require_automation_workflow_actor(p_subject,'contact.tag.read');
  IF p_person IS NULL OR NOT EXISTS(SELECT 1 FROM hon.people WHERE id=p_person AND organization_id=org AND school_id=school) THEN
    RAISE EXCEPTION 'CONTACT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.contact_tag_list_json(org,school,p_person);
END $$;

-- LOOKUP {personIds: 1..200 distinct}: tags for each listed person of this school; people of other schools are left out.
CREATE FUNCTION hon.lookup_contact_tags(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF NOT hon.automation_keys(p_input,ARRAY['personIds']) OR NOT hon.automation_list(p_input->'personIds',1,200,'uuid') THEN PERFORM hon.automation_invalid('personIds'); END IF;
  PERFORM hon.require_automation_workflow_actor(p_subject,'contact.tag.read');
  RETURN jsonb_build_object('people',coalesce((SELECT jsonb_agg(jsonb_build_object('personId',p.id,'tags',coalesce((SELECT jsonb_agg(t.tag ORDER BY t.tag_key)
      FROM hon.contact_tags t WHERE t.organization_id=org AND t.school_id=school AND t.person_id=p.id),'[]'::jsonb)) ORDER BY p.id)
    FROM hon.people p WHERE p.organization_id=org AND p.school_id=school AND p.id IN (SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(p_input->'personIds') x)),'[]'::jsonb));
END $$;

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['automation_workflows','automation_workflow_versions','automation_commands','contact_tags','contact_tag_events'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  EXECUTE 'REVOKE ALL ON SEQUENCE hon.contact_tag_events_id_seq FROM PUBLIC';
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN (
    'guard_automation_workflow_history','guard_automation_workflow','require_automation_workflow_actor','automation_invalid','automation_keys','automation_int','automation_uuid',
    'automation_enum','automation_text','automation_tag_ok','automation_tool_key_ok','automation_local_time','automation_date','automation_list',
    'automation_condition_ok','automation_trigger_ok','automation_content_ok','automation_step_edges','validate_automation_definition','automation_name',
    'automation_check_call','automation_claim','automation_finish','automation_fp','automation_workflow_json','automation_version_json','automation_detail_json',
    'automation_evidence','create_automation_workflow','automation_lock_workflow','automation_append_version','save_automation_workflow_version',
    'restore_automation_workflow_version','archive_automation_workflow','read_automation_workflows','read_automation_workflow','read_automation_workflow_version',
    'contact_tag_list_json','contact_tag_apply','change_contact_tag','add_contact_tag','remove_contact_tag','read_school_contact_tags','read_person_contact_tags',
    'lookup_contact_tags') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_automation_workflow(text,jsonb,text,uuid,uuid),
      hon.save_automation_workflow_version(text,uuid,jsonb,text,uuid,uuid),hon.restore_automation_workflow_version(text,uuid,jsonb,text,uuid,uuid),
      hon.archive_automation_workflow(text,uuid,jsonb,text,uuid,uuid),hon.read_automation_workflows(text),hon.read_automation_workflow(text,uuid),
      hon.read_automation_workflow_version(text,uuid,integer),hon.add_contact_tag(text,uuid,jsonb,text,uuid,uuid),hon.remove_contact_tag(text,uuid,jsonb,text,uuid,uuid),
      hon.read_school_contact_tags(text),hon.read_person_contact_tags(text,uuid),hon.lookup_contact_tags(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
