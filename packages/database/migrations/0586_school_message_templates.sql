BEGIN;

-- 0586 Texts and Email pages piece TE2 (0543, then 0573, renumbered to 0586 by the ledger rule 2026-11-19 after #483 landed 0574; docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md §3).
-- Saved message templates for the Templates tab of the Texts and Email pages. Owner request (David, 2026-11-19): "text and
-- email should be separate page with different tab for history and template".
--   M1  communication.template.read (see the school's templates) and communication.template.manage (add, change, archive and
--       restore them). Both staff-assignable and given to OWNER by default; owners give them to other roles (0412).
--   M2  A template is one school, one channel (SMS or EMAIL), a name (1-80, unique per school and channel among active
--       templates, case-insensitive), an email subject (EMAIL only, 1-150) and a body (SMS 1-1,000, EMAIL 1-3,500 characters).
--       Merge tags are the closed blasts list: {{first_name}}, {{last_name}}, {{school_name}}, {{staff_name}}; any other
--       {{...}} is refused. At most 100 active templates per school and channel, 500 in all.
--   M3  Templates are never deleted. Each change is the next version under the exact expected version; archive and restore
--       are their own command; an archived template must be restored before it changes; the channel never changes. Every
--       command is idempotent (exact replay, key reuse refused), audited without the text, with an inert ids-only outbox event.
--   M4  Direct human only (HUMAN_USER, HUMAN_UI, no action request or delegation), live ESSENTIAL/CORE/COMPLETE access,
--       active school and organization (0364 hon.conversation_staff_has); the actor is proved again after the locks and
--       before returning. A template is text only: using one fills the composer, and sending still goes through 0047/0243.
--       Forced RLS with no policies; the runtime gains only EXECUTE on three entry points.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Message templates require a restricted runtime'; END IF;
  IF to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.conversation_staff_has(uuid,uuid,uuid,text)') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL OR to_regprocedure('hon.read_school_message_history(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '0586 requires 0154, 0224, 0364 and 0585'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('communication.template.read','See the school''s saved text and email templates',false,true),
  ('communication.template.manage','Add, change, archive and restore the school''s text and email templates',false,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('communication.template.read','communication.template.manage') AND NOT is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'message template permissions already exist with an unexpected definition'; END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN ('communication.template.read','communication.template.manage') ON CONFLICT DO NOTHING;

-- A one-line field (name, subject): trimmed, 1..max, no control or invisible direction characters.
CREATE FUNCTION hon.school_template_line_ok(v text,max_len integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(length(v) BETWEEN 1 AND max_len AND btrim(v)=v AND v !~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿]',false)
$$;
-- A body: 1..max, not only blank, new lines allowed, no other control or direction-override characters (emoji joiners allowed).
CREATE FUNCTION hon.school_template_body_ok(v text,max_len integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(length(v) BETWEEN 1 AND max_len AND btrim(v,E' \n')<>'' AND v !~ '[\x01-\x09\x0b-\x1f\x7f‎‏‪-‮⁦-⁩﻿]',false)
$$;
-- Every {{...}} is one of the closed blasts merge tags (whitespace inside the braces allowed, case exact).
CREATE FUNCTION hon.school_template_tags_ok(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS (SELECT 1 FROM regexp_matches(coalesce(v,''),'\{\{([^{}]*)\}\}','g') m
    WHERE btrim(m[1],E' \t\n') NOT IN ('first_name','last_name','school_name','staff_name'))
$$;

CREATE TABLE hon.school_message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('SMS','EMAIL')),
  name text NOT NULL,
  email_subject text,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  UNIQUE (id,organization_id,school_id),
  CHECK (hon.school_template_line_ok(name,80) AND hon.school_template_tags_ok(name)),
  CHECK ((channel='EMAIL') = (email_subject IS NOT NULL)),
  CHECK (email_subject IS NULL OR (hon.school_template_line_ok(email_subject,150) AND hon.school_template_tags_ok(email_subject))),
  CHECK (hon.school_template_body_ok(body,CASE channel WHEN 'SMS' THEN 1000 ELSE 3500 END) AND hon.school_template_tags_ok(body)),
  CHECK ((status='ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX school_message_templates_active_name ON hon.school_message_templates(organization_id,school_id,channel,lower(name)) WHERE status='ACTIVE';
ALTER TABLE hon.school_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_message_templates FORCE ROW LEVEL SECURITY;
-- No policies: reachable only through the fixed definer functions below.

-- Never deleted; scope, channel, creator and creation time never change; every update is the next version.
CREATE FUNCTION hon.guard_school_message_template() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('TRUNCATE','DELETE') THEN RAISE EXCEPTION 'MESSAGE_TEMPLATE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'ACTIVE' THEN RAISE EXCEPTION 'MESSAGE_TEMPLATE_IMMUTABLE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.channel,NEW.created_by_principal_id,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.channel,OLD.created_by_principal_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'MESSAGE_TEMPLATE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_message_templates FOR EACH ROW EXECUTE FUNCTION hon.guard_school_message_template();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_message_templates FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_message_template();

-- The staff actor of the session school holding p_permission, or MESSAGE_TEMPLATE_FORBIDDEN. Same session rules as 0364/0585.
CREATE FUNCTION hon.require_school_template_actor(subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL OR p_permission IS NULL OR p_permission NOT IN ('communication.template.read','communication.template.manage') THEN
    RAISE EXCEPTION 'MESSAGE_TEMPLATE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
  IF NOT hon.conversation_staff_has(actor,org,school,p_permission) THEN
    RAISE EXCEPTION 'MESSAGE_TEMPLATE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.school_message_template_json(t hon.school_message_templates) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('templateId',t.id,'channel',t.channel,'name',t.name,'subject',t.email_subject,'body',t.body,
    'status',t.status,'version',t.version,'createdAt',hon.saas_ts(t.created_at),'updatedAt',hon.saas_ts(t.updated_at))
$$;

-- The school's templates, by name. p: optional channel (SMS|EMAIL) and status (ACTIVE default, or ARCHIVED).
CREATE FUNCTION hon.read_school_message_templates(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid; v_channel text; v_status text; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('channel','status'))
    OR (p ? 'channel' AND (jsonb_typeof(p->'channel') IS DISTINCT FROM 'string' OR p->>'channel' NOT IN ('SMS','EMAIL')))
    OR (p ? 'status' AND (jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ACTIVE','ARCHIVED'))) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_template_actor(subject,'communication.template.read');
  org:=hon.current_organization_id(); school:=hon.current_school_id();
  v_channel:=p->>'channel'; v_status:=coalesce(p->>'status','ACTIVE');
  SELECT jsonb_build_object('templates',coalesce(jsonb_agg(hon.school_message_template_json(t) ORDER BY lower(t.name),t.channel,t.id),'[]'::jsonb)) INTO result
    FROM (SELECT * FROM hon.school_message_templates t WHERE t.organization_id=org AND t.school_id=school AND t.status=v_status
            AND (v_channel IS NULL OR t.channel=v_channel) ORDER BY lower(t.name),t.channel,t.id LIMIT 500) t;
  IF hon.require_school_template_actor(subject,'communication.template.read') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MESSAGE_TEMPLATE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Shared command start: argument shape, fingerprint, reservation, locks, actor re-proof and exact replay. Returns the prior
-- response for a replay, or null for a fresh command (the caller completes the reservation).
CREATE FUNCTION hon.school_template_command_begin(subject text,operation text,p jsonb,key text,request uuid,correlation uuid,OUT actor uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,key,request,correlation) OR operation NOT IN ('message_template.save','message_template.status') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',operation,'input',p)::text,'UTF8')),'hex');
  actor:=hon.require_school_template_actor(subject,'communication.template.manage');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_template_actor(subject,'communication.template.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MESSAGE_TEMPLATE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    replay:=prior.response_body; RETURN;
  END IF;
  -- One school's templates change one command at a time, so the name and count checks cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_message_templates:'||school::text,0));
END $$;

-- Name free and caps respected for an active template of this channel (p_self excluded).
CREATE FUNCTION hon.school_template_room_check(p_org uuid,p_school uuid,p_channel text,p_name text,p_self uuid,p_new boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM hon.school_message_templates t WHERE t.organization_id=p_org AND t.school_id=p_school AND t.channel=p_channel
      AND t.status='ACTIVE' AND lower(t.name)=lower(p_name) AND t.id IS DISTINCT FROM p_self) THEN
    RAISE EXCEPTION 'MESSAGE_TEMPLATE_NAME_TAKEN' USING ERRCODE='23505'; END IF;
  IF (SELECT count(*) FROM hon.school_message_templates t WHERE t.organization_id=p_org AND t.school_id=p_school AND t.channel=p_channel
      AND t.status='ACTIVE' AND t.id IS DISTINCT FROM p_self)>=100
    OR (p_new AND (SELECT count(*) FROM hon.school_message_templates t WHERE t.organization_id=p_org AND t.school_id=p_school)>=500) THEN
    RAISE EXCEPTION 'MESSAGE_TEMPLATE_LIMIT' USING ERRCODE='54000'; END IF;
END $$;

-- Ids-only audit (the name and text stay on the template) and an inert outbox event, then the reservation completes.
CREATE FUNCTION hon.school_template_command_finish(actor uuid,action text,t hon.school_message_templates,before jsonb,key text,request uuid,correlation uuid,result jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  shape jsonb:=jsonb_build_object('templateId',t.id,'channel',t.channel,'status',t.status,'version',t.version);
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,'MESSAGE_TEMPLATE',t.id,before,shape,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'message_template.saved',1,'MESSAGE_TEMPLATE',t.id,t.version,correlation,request,shape);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
END $$;

-- Add or change one template. p (all keys): {templateId|null, expectedVersion, channel, name, subject|null, body}.
-- A new template has templateId null and expectedVersion 0. A change keeps the channel and needs an active template.
CREATE FUNCTION hon.save_school_message_template(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb;
  t hon.school_message_templates%ROWTYPE; before jsonb; result jsonb; expected integer; ch text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['body','channel','expectedVersion','name','subject','templateId']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR NOT (jsonb_typeof(p->'templateId')='null' OR (jsonb_typeof(p->'templateId')='string' AND p->>'templateId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR jsonb_typeof(p->'channel') IS DISTINCT FROM 'string' OR p->>'channel' NOT IN ('SMS','EMAIL')
    OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR NOT hon.school_template_line_ok(p->>'name',80) OR NOT hon.school_template_tags_ok(p->>'name')
    OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string'
    OR NOT hon.school_template_body_ok(p->>'body',CASE p->>'channel' WHEN 'SMS' THEN 1000 ELSE 3500 END) OR NOT hon.school_template_tags_ok(p->>'body')
    OR (p->>'channel'='SMS' AND jsonb_typeof(p->'subject') IS DISTINCT FROM 'null')
    OR (p->>'channel'='EMAIL' AND (jsonb_typeof(p->'subject') IS DISTINCT FROM 'string' OR NOT hon.school_template_line_ok(p->>'subject',150)
      OR NOT hon.school_template_tags_ok(p->>'subject')))
    OR (jsonb_typeof(p->'templateId')='null') <> ((p->>'expectedVersion')::integer=0) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  expected:=(p->>'expectedVersion')::integer; ch:=p->>'channel';
  SELECT b.actor,b.replay INTO actor,replay FROM hon.school_template_command_begin(subject,'message_template.save',p,key,request,correlation) b;
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('template',replay,'replayed',true); END IF;
  IF jsonb_typeof(p->'templateId')='string' THEN
    SELECT * INTO t FROM hon.school_message_templates x WHERE x.id=(p->>'templateId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_TEMPLATE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF t.channel<>ch THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    IF t.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    IF t.status='ARCHIVED' THEN RAISE EXCEPTION 'MESSAGE_TEMPLATE_ARCHIVED' USING ERRCODE='55000'; END IF;
  END IF;
  PERFORM hon.school_template_room_check(org,school,ch,p->>'name',t.id,t.id IS NULL);
  IF t.id IS NULL THEN
    INSERT INTO hon.school_message_templates(organization_id,school_id,channel,name,email_subject,body,status,created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,ch,p->>'name',p->>'subject',p->>'body','ACTIVE',actor,actor) RETURNING * INTO t;
  ELSE
    before:=jsonb_build_object('templateId',t.id,'channel',t.channel,'status',t.status,'version',t.version);
    UPDATE hon.school_message_templates SET name=p->>'name',email_subject=p->>'subject',body=p->>'body',version=t.version+1,
        updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
  END IF;
  result:=hon.school_message_template_json(t);
  PERFORM hon.school_template_command_finish(actor,CASE WHEN before IS NULL THEN 'message_template.create' ELSE 'message_template.update' END,
    t,before,key,request,correlation,result);
  IF hon.require_school_template_actor(subject,'communication.template.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MESSAGE_TEMPLATE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('template',result,'replayed',false);
END $$;

-- Archive or restore one template. p (all keys): {templateId, expectedVersion, status ARCHIVED|ACTIVE}. Restoring needs the
-- name free and room under the cap.
CREATE FUNCTION hon.set_school_message_template_status(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb;
  t hon.school_message_templates%ROWTYPE; before jsonb; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion','status','templateId']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'templateId') IS DISTINCT FROM 'string' OR p->>'templateId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ACTIVE','ARCHIVED') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT b.actor,b.replay INTO actor,replay FROM hon.school_template_command_begin(subject,'message_template.status',p,key,request,correlation) b;
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('template',replay,'replayed',true); END IF;
  SELECT * INTO t FROM hon.school_message_templates x WHERE x.id=(p->>'templateId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_TEMPLATE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF t.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF t.status=p->>'status' THEN RAISE EXCEPTION 'MESSAGE_TEMPLATE_STATUS_UNCHANGED' USING ERRCODE='55000'; END IF;
  IF p->>'status'='ACTIVE' THEN PERFORM hon.school_template_room_check(org,school,t.channel,t.name,t.id,false); END IF;
  before:=jsonb_build_object('templateId',t.id,'channel',t.channel,'status',t.status,'version',t.version);
  UPDATE hon.school_message_templates SET status=p->>'status',archived_at=CASE WHEN p->>'status'='ARCHIVED' THEN clock_timestamp() END,
      version=t.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
  result:=hon.school_message_template_json(t);
  PERFORM hon.school_template_command_finish(actor,CASE t.status WHEN 'ARCHIVED' THEN 'message_template.archive' ELSE 'message_template.restore' END,
    t,before,key,request,correlation,result);
  IF hon.require_school_template_actor(subject,'communication.template.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MESSAGE_TEMPLATE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('template',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_school_message_templates(text,jsonb)','hon.save_school_message_template(text,jsonb,text,uuid,uuid)',
    'hon.set_school_message_template_status(text,jsonb,text,uuid,uuid)'];
  helpers text[]:=ARRAY['hon.school_template_line_ok(text,integer)','hon.school_template_body_ok(text,integer)','hon.school_template_tags_ok(text)',
    'hon.guard_school_message_template()','hon.require_school_template_actor(text,text)','hon.school_message_template_json(hon.school_message_templates)',
    'hon.school_template_command_begin(text,text,jsonb,text,uuid,uuid)','hon.school_template_room_check(uuid,uuid,text,text,uuid,boolean)',
    'hon.school_template_command_finish(uuid,text,hon.school_message_templates,jsonb,text,uuid,uuid,jsonb)'];
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE hon.school_message_templates FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_message_templates FROM %I',r); END LOOP;
  FOREACH f IN ARRAY helpers||entry LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;
COMMIT;
