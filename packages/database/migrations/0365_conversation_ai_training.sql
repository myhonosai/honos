BEGIN;

-- 0365 Conversation AI piece CA2a (allocated by the coordinator 2026-11-15; docs/architecture/CONVERSATION_AI.md §7).
-- Train AI: the switches and the school's training material. Nothing here calls an AI provider or sends anything.
--   T1  One HQ program switch (OFF, TEST_MODE, LIVE), set only by a human HON HQ owner, audited. It starts OFF.
--       CA2b will refuse every Chad turn while it is OFF, and every real provider call or automatic send unless LIVE.
--   T2  Per-school settings, changed only by staff with conversation.ai.configure (OWNER by default): on/off, a mode per
--       channel (OFF, ASSIST, AUTOMATIC), hand-off words, an after-hours text, a length cap per channel, languages.
--       Turning it on records who did and when: the standing authority CA2b re-proves on every turn.
--   T3  The training library: FAQ, document, image, instruction and coaching items with owner-checked text, an on/off
--       switch (ACTIVE / PAUSED) and soft delete, versioned. Original files (1 MB at most; text, CSV, Markdown, PDF, Word,
--       PNG, JPEG, WebP) are kept privately so "Open original file" works; only text the owner checked is ever used.
--   T4  The knowledge pack: the school's customer-safe facts (name, tone, languages, ACTIVE training items and coaching,
--       approved parent-safe articles, available membership plans as recorded, active open booking types). Internal only;
--       staff with conversation.ai.configure can preview it.
--   T5  Forced deny-all RLS; SECURITY DEFINER entry points; idempotent by key, version-checked, audited, ids-only outbox;
--       authority decided again after the writes. The runtime gains no table privilege.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Conversation AI training requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.conversation_staff_has(uuid,uuid,uuid,text)') IS NULL OR to_regprocedure('hon.require_saas_hq_actor(text,boolean)') IS NULL
    OR to_regclass('hon.hon_school_tones') IS NULL OR to_regclass('hon.school_booking_types') IS NULL OR to_regclass('hon.membership_plan_versions') IS NULL
    OR to_regclass('hon.knowledge_articles') IS NULL THEN
    RAISE EXCEPTION 'Conversation AI training requires 0036, 0154, 0175, 0256, 0286 and 0364';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('conversation.ai.configure','Turn the school''s conversation AI on or off, choose its modes and manage what it is trained on',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code='conversation.ai.configure' AND is_sensitive AND is_staff_assignable)<>1 THEN
    RAISE EXCEPTION 'conversation.ai.configure already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'conversation.ai.configure' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- Plain text of 1..max characters, not blank, no control characters except line breaks and tabs.
CREATE FUNCTION hon.conversation_ai_text_ok(v text, max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND max IS NOT NULL AND length(v) BETWEEN 1 AND max AND btrim(v,E' \t\r\n')<>'' AND v !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'
$$;
-- Hand-off words: at most 20 distinct lower-case words or short phrases of 1-30 letters, digits, spaces or dashes.
CREATE FUNCTION hon.conversation_ai_words_ok(v text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND cardinality(v)<=20 AND array_position(v,NULL) IS NULL
    AND (SELECT count(DISTINCT t)=count(*) AND bool_and(t ~ '^[[:alnum:]][[:alnum:] -]{0,28}[[:alnum:]]$|^[[:alnum:]]$' AND t=lower(t)) FROM unnest(v) t) IS NOT FALSE
$$;

-- One to three distinct supported reply languages.
CREATE FUNCTION hon.conversation_ai_locales_ok(v text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND cardinality(v) BETWEEN 1 AND 3 AND v <@ ARRAY['en','ko','es']::text[] AND array_position(v,NULL) IS NULL
    AND (SELECT count(DISTINCT x)=count(*) FROM unnest(v) x)
$$;

-- T1 the HQ program switch: exactly one row.
CREATE TABLE hon.conversation_ai_program (
  program_id smallint PRIMARY KEY CHECK (program_id=1),
  status text NOT NULL DEFAULT 'OFF' CHECK (status IN ('OFF','TEST_MODE','LIVE')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  updated_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO hon.conversation_ai_program(program_id) VALUES (1);
-- Append-only history of every HQ change to the switch: the audit (who, when, from, to, why). HQ-wide, so no school row.
CREATE TABLE hon.conversation_ai_program_changes (
  command_key uuid PRIMARY KEY,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  prior_status text NOT NULL CHECK (prior_status IN ('OFF','TEST_MODE','LIVE')),
  next_status text NOT NULL CHECK (next_status IN ('OFF','TEST_MODE','LIVE') AND next_status<>prior_status),
  resulting_version integer NOT NULL UNIQUE CHECK (resulting_version>=2),
  reason text NOT NULL CHECK (reason=btrim(reason) AND length(reason) BETWEEN 10 AND 500 AND reason !~ '[[:cntrl:]]'),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION hon.guard_conversation_ai_program_changes() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'CONVERSATION_AI_PROGRAM_CHANGE_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER conversation_ai_program_changes_immutable BEFORE UPDATE OR DELETE ON hon.conversation_ai_program_changes
  FOR EACH ROW EXECUTE FUNCTION hon.guard_conversation_ai_program_changes();
CREATE TRIGGER conversation_ai_program_changes_no_truncate BEFORE TRUNCATE ON hon.conversation_ai_program_changes
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_conversation_ai_program_changes();

-- T2 per-school settings. No row means everything is off with the defaults below.
CREATE TABLE hon.school_conversation_ai_settings (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  sms_mode text NOT NULL DEFAULT 'OFF' CHECK (sms_mode IN ('OFF','ASSIST','AUTOMATIC')),
  web_chat_mode text NOT NULL DEFAULT 'OFF' CHECK (web_chat_mode IN ('OFF','ASSIST','AUTOMATIC')),
  email_mode text NOT NULL DEFAULT 'OFF' CHECK (email_mode IN ('OFF','ASSIST','AUTOMATIC')),
  handoff_words text[] NOT NULL DEFAULT ARRAY['human','manager','cancel','refund','billing']::text[] CHECK (hon.conversation_ai_words_ok(handoff_words)),
  after_hours_text text CHECK (after_hours_text IS NULL OR hon.conversation_ai_text_ok(after_hours_text,320)),
  sms_max_chars integer NOT NULL DEFAULT 500 CHECK (sms_max_chars BETWEEN 160 AND 1600),
  chat_max_chars integer NOT NULL DEFAULT 900 CHECK (chat_max_chars BETWEEN 160 AND 1600),
  languages text[] NOT NULL DEFAULT ARRAY['en']::text[] CHECK (hon.conversation_ai_locales_ok(languages)),
  enabled_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  enabled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  CHECK (NOT enabled OR (enabled_by_principal_id IS NOT NULL AND enabled_at IS NOT NULL))
);

-- T3 original files: private, immutable, one copy per school and content.
CREATE TABLE hon.school_ai_training_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200 AND btrim(file_name)=file_name AND file_name !~ '[[:cntrl:]/\\]'),
  media_type text NOT NULL CHECK (media_type IN ('text/plain','text/csv','text/markdown','application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg','image/webp')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL CHECK (octet_length(content)=byte_size),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (school_id,sha256),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  CHECK (encode(sha256(content),'hex')=sha256)
);

CREATE TABLE hon.school_ai_training_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FAQ','DOCUMENT','IMAGE','INSTRUCTION','COACHING')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120 AND btrim(title)=title AND title !~ '[[:cntrl:]]'),
  question text CHECK (question IS NULL OR hon.conversation_ai_text_ok(question,500)),
  body text NOT NULL CHECK (hon.conversation_ai_text_ok(body,8000)),
  staff_note text CHECK (staff_note IS NULL OR hon.conversation_ai_text_ok(staff_note,500)),
  summary text CHECK (summary IS NULL OR hon.conversation_ai_text_ok(summary,300)),
  file_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','DELETED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (file_id,organization_id,school_id) REFERENCES hon.school_ai_training_files(id,organization_id,school_id) ON DELETE RESTRICT,
  -- A FAQ and a coaching card are a question and its answer; only coaching carries a staff note; files only for documents and images.
  CHECK ((kind IN ('FAQ','COACHING'))=(question IS NOT NULL)),
  CHECK (kind='COACHING' OR staff_note IS NULL),
  CHECK (file_id IS NULL OR kind IN ('DOCUMENT','IMAGE'))
);
CREATE INDEX school_ai_training_items_school ON hon.school_ai_training_items(organization_id,school_id,status,updated_at DESC,id DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_ai_program','conversation_ai_program_changes','school_conversation_ai_settings','school_ai_training_files','school_ai_training_items'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

-- Files are immutable and never deleted; settings, items and the program move forward by one version, keep their scope,
-- and are never deleted (an item is soft-deleted and stays deleted).
CREATE TRIGGER school_ai_training_files_immutable BEFORE UPDATE OR DELETE ON hon.school_ai_training_files
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE FUNCTION hon.guard_conversation_ai_row() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Conversation AI records are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'A new conversation AI record starts at version 1' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Conversation AI records move forward one version at a time' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='school_ai_training_items' THEN
    IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.kind<>OLD.kind
      OR NEW.created_at<>OLD.created_at OR NEW.created_by_principal_id<>OLD.created_by_principal_id OR OLD.status='DELETED' THEN
      RAISE EXCEPTION 'A training item keeps its school and kind, and a deleted item stays deleted' USING ERRCODE='55000';
    END IF;
  ELSIF TG_TABLE_NAME='school_conversation_ai_settings' THEN
    IF NEW.school_id<>OLD.school_id OR NEW.organization_id<>OLD.organization_id THEN
      RAISE EXCEPTION 'Conversation AI settings keep their school' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversation_ai_program_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.conversation_ai_program
  FOR EACH ROW EXECUTE FUNCTION hon.guard_conversation_ai_row();
CREATE TRIGGER school_conversation_ai_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_conversation_ai_settings
  FOR EACH ROW EXECUTE FUNCTION hon.guard_conversation_ai_row();
CREATE TRIGGER school_ai_training_items_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_ai_training_items
  FOR EACH ROW EXECUTE FUNCTION hon.guard_conversation_ai_row();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_ai_program','school_conversation_ai_settings','school_ai_training_files','school_ai_training_items'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence()',t||'_no_truncate',t);
  END LOOP;
END $$;

-- The signed-in direct human at the session school with conversation.ai.configure (p_configure) or conversation.read.
CREATE FUNCTION hon.require_conversation_ai_actor(subject text, p_configure boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL OR p_configure IS NULL THEN RAISE EXCEPTION 'CONVERSATION_AI_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
  IF NOT hon.conversation_staff_has(actor,org,school,CASE WHEN p_configure THEN 'conversation.ai.configure' ELSE 'conversation.read' END) THEN
    RAISE EXCEPTION 'CONVERSATION_AI_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- Audit, outbox (ids only) and the recorded result of one staff command (idempotency reserved by conversation_command_begin).
CREATE FUNCTION hon.conversation_ai_finish(actor uuid, key text, entity_type text, entity_id uuid, version integer, action text, prior jsonb,
  next jsonb, event text, result jsonb, request uuid, correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,entity_type,entity_id,prior,next,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event,1,entity_type,entity_id,version,correlation,request,jsonb_build_object('id',entity_id,'version',version));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
END $$;

CREATE FUNCTION hon.conversation_ai_settings_json(s hon.school_conversation_ai_settings) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('enabled',s.enabled,'modes',jsonb_build_object('SMS',s.sms_mode,'WEB_CHAT',s.web_chat_mode,'EMAIL',s.email_mode),
    'handoffWords',to_jsonb(s.handoff_words),'afterHoursText',s.after_hours_text,'smsMaxChars',s.sms_max_chars,'chatMaxChars',s.chat_max_chars,
    'languages',to_jsonb(s.languages),'enabledAt',hon.conversation_time(s.enabled_at),
    'enabledBy',(SELECT p.display_name FROM hon.principals p WHERE p.id=s.enabled_by_principal_id),
    'version',CASE WHEN s.school_id IS NULL THEN 0 ELSE s.version END)
$$;

CREATE FUNCTION hon.conversation_ai_item_json(i hon.school_ai_training_items) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('itemId',i.id,'kind',i.kind,'title',i.title,'question',i.question,'body',i.body,'staffNote',i.staff_note,
    'summary',i.summary,'status',i.status,'version',i.version,'updatedAt',hon.conversation_time(i.updated_at),
    'updatedBy',(SELECT p.display_name FROM hon.principals p WHERE p.id=i.updated_by_principal_id),
    'file',(SELECT jsonb_build_object('fileId',f.id,'fileName',f.file_name,'mediaType',f.media_type,'byteSize',f.byte_size)
      FROM hon.school_ai_training_files f WHERE f.id=i.file_id))
$$;

-- T4 the knowledge pack of one school: customer-safe facts only, each with its source. Internal: never granted.
CREATE FUNCTION hon.school_ai_knowledge(p_org uuid, p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object(
    'school',(SELECT jsonb_build_object('name',s.name) FROM hon.schools s WHERE s.id=p_school AND s.organization_id=p_org),
    'tone',coalesce((SELECT t.tone FROM hon.hon_school_tones t WHERE t.organization_id=p_org AND t.school_id=p_school),'STANDARD'),
    'languages',coalesce((SELECT to_jsonb(x.languages) FROM hon.school_conversation_ai_settings x WHERE x.school_id=p_school AND x.organization_id=p_org),'["en"]'::jsonb),
    'instructions',coalesce((SELECT jsonb_agg(jsonb_build_object('source','TRAINING:'||i.id,'text',i.body) ORDER BY i.updated_at,i.id)
      FROM hon.school_ai_training_items i WHERE i.organization_id=p_org AND i.school_id=p_school AND i.status='ACTIVE' AND i.kind='INSTRUCTION'),'[]'),
    'faqs',coalesce((SELECT jsonb_agg(jsonb_build_object('source','TRAINING:'||i.id,'kind',i.kind,'question',i.question,'answer',i.body) ORDER BY i.updated_at,i.id)
      FROM hon.school_ai_training_items i WHERE i.organization_id=p_org AND i.school_id=p_school AND i.status='ACTIVE' AND i.kind IN ('FAQ','COACHING')),'[]'),
    'documents',coalesce((SELECT jsonb_agg(jsonb_build_object('source','TRAINING:'||i.id,'title',i.title,'text',i.body) ORDER BY i.updated_at,i.id)
      FROM hon.school_ai_training_items i WHERE i.organization_id=p_org AND i.school_id=p_school AND i.status='ACTIVE' AND i.kind IN ('DOCUMENT','IMAGE')),'[]'),
    'articles',coalesce((SELECT jsonb_agg(jsonb_build_object('source','ARTICLE:'||a.id,'title',a.title,'text',a.body) ORDER BY a.approved_at,a.id)
      FROM hon.knowledge_articles a WHERE a.organization_id=p_org AND a.school_id=p_school AND a.lifecycle='APPROVED' AND a.audience='PARENT_SAFE'
        AND a.effective_from<=clock_timestamp()),'[]'),
    'plans',coalesce((SELECT jsonb_agg(jsonb_build_object('source','PLAN:'||v.plan_id||':'||v.version,'name',v.display_name,'description',v.description,
        'currency',v.currency,'priceMinor',v.price_minor,'billing',v.billing_frequency,'termMonths',v.term_months) ORDER BY v.display_name,v.plan_id)
      FROM hon.membership_plans m JOIN hon.membership_plan_versions v ON v.plan_id=m.id AND v.version=m.current_version
      WHERE m.organization_id=p_org AND m.school_id=p_school AND v.availability='AVAILABLE'),'[]'),
    'bookingTypes',coalesce((SELECT jsonb_agg(jsonb_build_object('source','BOOKING_TYPE:'||b.id,'name',b.name,'description',b.description,
        'template',b.template,'durationMinutes',b.duration_minutes) ORDER BY b.name,b.id)
      FROM hon.school_booking_types b WHERE b.organization_id=p_org AND b.school_id=p_school AND b.status='ACTIVE' AND b.audience='OPEN'),'[]'))
$$;

-- Staff reads: settings, program state, the library (no file bytes) and what the staff member may do.
CREATE FUNCTION hon.read_school_conversation_ai(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.require_conversation_ai_actor(subject,false); org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  s hon.school_conversation_ai_settings; out jsonb;
BEGIN
  SELECT * INTO s FROM hon.school_conversation_ai_settings x WHERE x.school_id=school AND x.organization_id=org;
  IF NOT FOUND THEN s.enabled:=false; s.sms_mode:='OFF'; s.web_chat_mode:='OFF'; s.email_mode:='OFF';
    s.handoff_words:=ARRAY['human','manager','cancel','refund','billing']; s.sms_max_chars:=500; s.chat_max_chars:=900; s.languages:=ARRAY['en']; END IF;
  out:=jsonb_build_object('program',(SELECT p.status FROM hon.conversation_ai_program p WHERE p.program_id=1),
    'settings',hon.conversation_ai_settings_json(s),
    'items',coalesce((SELECT jsonb_agg(hon.conversation_ai_item_json(i) ORDER BY i.updated_at DESC,i.id DESC) FROM (SELECT * FROM hon.school_ai_training_items i
      WHERE i.organization_id=org AND i.school_id=school AND i.status<>'DELETED' ORDER BY i.updated_at DESC,i.id DESC LIMIT 200) i),'[]'),
    'canConfigure',hon.conversation_staff_has(actor,org,school,'conversation.ai.configure'));
  PERFORM hon.require_conversation_ai_actor(subject,false);
  RETURN out;
END $$;

-- What Chad would know right now (configure staff only).
CREATE FUNCTION hon.read_school_ai_knowledge(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE out jsonb;
BEGIN
  PERFORM hon.require_conversation_ai_actor(subject,true);
  out:=hon.school_ai_knowledge(hon.current_organization_id(),hon.current_school_id());
  PERFORM hon.require_conversation_ai_actor(subject,true);
  RETURN out;
END $$;

-- T2 settings change by version (0 when the school has none yet). Turning on records who and when.
CREATE FUNCTION hon.set_school_conversation_ai_settings(subject text, p jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.require_conversation_ai_actor(subject,true); org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  prior jsonb; s hon.school_conversation_ai_settings; found_row boolean; result jsonb; v_words text[]; v_langs text[]; mode text;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,p_key,p_request,p_correlation)
    -- expectedVersion may be 0 here (no settings yet), so it is checked on its own rather than by conversation_input_ok.
    OR NOT p ? 'expectedVersion' OR NOT hon.conversation_input_ok(p-'expectedVersion',ARRAY['enabled','modes','handoffWords','afterHoursText','smsMaxChars','chatMaxChars','languages'],ARRAY[]::text[])
    OR jsonb_typeof(p->'expectedVersion')<>'number' OR NOT (p->>'expectedVersion' ~ '^(0|[1-9][0-9]{0,8})$') OR jsonb_typeof(p->'enabled')<>'boolean'
    OR jsonb_typeof(p->'modes')<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p->'modes') k) IS DISTINCT FROM ARRAY['EMAIL','SMS','WEB_CHAT']
    OR jsonb_typeof(p->'handoffWords')<>'array' OR jsonb_typeof(p->'languages')<>'array'
    OR (jsonb_typeof(p->'afterHoursText')<>'null' AND jsonb_typeof(p->'afterHoursText')<>'string')
    OR jsonb_typeof(p->'smsMaxChars')<>'number' OR jsonb_typeof(p->'chatMaxChars')<>'number'
    OR p->>'smsMaxChars' !~ '^[0-9]{3,4}$' OR p->>'chatMaxChars' !~ '^[0-9]{3,4}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  FOREACH mode IN ARRAY ARRAY['SMS','WEB_CHAT','EMAIL'] LOOP
    IF jsonb_typeof(p->'modes'->mode)<>'string' OR p->'modes'->>mode NOT IN ('OFF','ASSIST','AUTOMATIC') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'handoffWords') w WHERE jsonb_typeof(w)<>'string')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'languages') w WHERE jsonb_typeof(w)<>'string') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  v_words:=ARRAY(SELECT jsonb_array_elements_text(p->'handoffWords')); v_langs:=ARRAY(SELECT jsonb_array_elements_text(p->'languages'));
  IF NOT hon.conversation_ai_words_ok(v_words) OR (jsonb_typeof(p->'afterHoursText')='string' AND NOT hon.conversation_ai_text_ok(p->>'afterHoursText',320)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  result:=hon.conversation_command_begin(actor,p_key,encode(sha256(convert_to('conversation.ai.settings:'||p::text,'UTF8')),'hex'));
  IF result IS NOT NULL THEN PERFORM hon.require_conversation_ai_actor(subject,true); RETURN jsonb_build_object('receipt',result,'replayed',true); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('conversation-ai-settings:'||school::text,0));
  SELECT * INTO s FROM hon.school_conversation_ai_settings x WHERE x.school_id=school AND x.organization_id=org FOR UPDATE;
  found_row:=FOUND;
  IF (CASE WHEN found_row THEN s.version ELSE 0 END)<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'CONVERSATION_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  prior:=CASE WHEN found_row THEN jsonb_build_object('enabled',s.enabled,'sms',s.sms_mode,'webChat',s.web_chat_mode,'email',s.email_mode,'version',s.version) END;
  BEGIN
    IF found_row THEN
      UPDATE hon.school_conversation_ai_settings x SET enabled=(p->>'enabled')::boolean,sms_mode=p->'modes'->>'SMS',web_chat_mode=p->'modes'->>'WEB_CHAT',
        email_mode=p->'modes'->>'EMAIL',handoff_words=v_words,after_hours_text=p->>'afterHoursText',sms_max_chars=(p->>'smsMaxChars')::integer,
        chat_max_chars=(p->>'chatMaxChars')::integer,languages=v_langs,
        enabled_by_principal_id=CASE WHEN (p->>'enabled')::boolean AND NOT x.enabled THEN actor WHEN (p->>'enabled')::boolean THEN x.enabled_by_principal_id END,
        enabled_at=CASE WHEN (p->>'enabled')::boolean AND NOT x.enabled THEN clock_timestamp() WHEN (p->>'enabled')::boolean THEN x.enabled_at END,
        version=x.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
        WHERE x.school_id=school RETURNING * INTO s;
    ELSE
      INSERT INTO hon.school_conversation_ai_settings(school_id,organization_id,enabled,sms_mode,web_chat_mode,email_mode,handoff_words,after_hours_text,
        sms_max_chars,chat_max_chars,languages,enabled_by_principal_id,enabled_at,updated_by_principal_id)
      VALUES(school,org,(p->>'enabled')::boolean,p->'modes'->>'SMS',p->'modes'->>'WEB_CHAT',p->'modes'->>'EMAIL',v_words,p->>'afterHoursText',
        (p->>'smsMaxChars')::integer,(p->>'chatMaxChars')::integer,v_langs,CASE WHEN (p->>'enabled')::boolean THEN actor END,
        CASE WHEN (p->>'enabled')::boolean THEN clock_timestamp() END,actor) RETURNING * INTO s;
    END IF;
  EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END;
  result:=jsonb_build_object('settings',hon.conversation_ai_settings_json(s));
  PERFORM hon.conversation_ai_finish(actor,p_key,'SCHOOL_CONVERSATION_AI_SETTINGS',school,s.version,'conversation.ai.settings.update',prior,
    jsonb_build_object('enabled',s.enabled,'sms',s.sms_mode,'webChat',s.web_chat_mode,'email',s.email_mode,'version',s.version),
    'conversation.ai.settings.updated',result,p_request,p_correlation);
  PERFORM hon.require_conversation_ai_actor(subject,true);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- T3 upload one original file (base64). Text, CSV and Markdown that are valid UTF-8 come back as extracted text for
-- the owner to check; other files come back without text (the owner types or pastes what Chad may use).
CREATE FUNCTION hon.upload_school_ai_training_file(subject text, p jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.require_conversation_ai_actor(subject,true); org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  bytes bytea; digest text; f hon.school_ai_training_files; result jsonb; extracted text;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,p_key,p_request,p_correlation) OR NOT hon.conversation_input_ok(p,ARRAY['fileName','mediaType','contentBase64'],ARRAY[]::text[])
    OR jsonb_typeof(p->'fileName')<>'string' OR jsonb_typeof(p->'mediaType')<>'string' OR jsonb_typeof(p->'contentBase64')<>'string'
    OR length(p->>'contentBase64') NOT BETWEEN 4 AND 1398104 OR p->>'contentBase64' !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  BEGIN bytes:=decode(p->>'contentBase64','base64'); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END;
  digest:=encode(sha256(bytes),'hex');
  -- The content must match the declared type (magic bytes for binary types, valid UTF-8 for text types).
  IF (p->>'mediaType'='application/pdf' AND substring(bytes from 1 for 5)<>'\x255044462d'::bytea)
    OR (p->>'mediaType'='application/vnd.openxmlformats-officedocument.wordprocessingml.document' AND substring(bytes from 1 for 4)<>'\x504b0304'::bytea)
    OR (p->>'mediaType'='image/png' AND substring(bytes from 1 for 8)<>'\x89504e470d0a1a0a'::bytea)
    OR (p->>'mediaType'='image/jpeg' AND substring(bytes from 1 for 3)<>'\xffd8ff'::bytea)
    OR (p->>'mediaType'='image/webp' AND (substring(bytes from 1 for 4)<>'\x52494646'::bytea OR substring(bytes from 9 for 4)<>'\x57454250'::bytea)) THEN
    RAISE EXCEPTION 'CONVERSATION_AI_FILE_TYPE_MISMATCH' USING ERRCODE='55000';
  END IF;
  IF p->>'mediaType' IN ('text/plain','text/csv','text/markdown') THEN
    BEGIN extracted:=convert_from(bytes,'UTF8'); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'CONVERSATION_AI_FILE_TYPE_MISMATCH' USING ERRCODE='55000'; END;
    extracted:=left(btrim(regexp_replace(extracted,E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]','','g'),E' \t\r\n'),8000);
    IF extracted='' THEN extracted:=NULL; END IF;
  END IF;
  result:=hon.conversation_command_begin(actor,p_key,encode(sha256(convert_to('conversation.ai.file:'||(p->>'fileName')||':'||(p->>'mediaType')||':'||digest,'UTF8')),'hex'));
  IF result IS NOT NULL THEN PERFORM hon.require_conversation_ai_actor(subject,true); RETURN jsonb_build_object('receipt',result,'replayed',true); END IF;
  SELECT * INTO f FROM hon.school_ai_training_files x WHERE x.school_id=school AND x.sha256=digest;
  IF NOT FOUND THEN
    BEGIN
      INSERT INTO hon.school_ai_training_files(organization_id,school_id,file_name,media_type,byte_size,sha256,content,created_by_principal_id)
        VALUES(org,school,p->>'fileName',p->>'mediaType',octet_length(bytes),digest,bytes,actor) RETURNING * INTO f;
    EXCEPTION WHEN check_violation THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
    END;
  END IF;
  result:=jsonb_build_object('file',jsonb_build_object('fileId',f.id,'fileName',f.file_name,'mediaType',f.media_type,'byteSize',f.byte_size),'extractedText',extracted);
  PERFORM hon.conversation_ai_finish(actor,p_key,'SCHOOL_AI_TRAINING_FILE',f.id,1,'conversation.ai.file.upload',NULL,
    jsonb_build_object('fileId',f.id,'byteSize',f.byte_size),'conversation.ai.file.uploaded',result,p_request,p_correlation);
  PERFORM hon.require_conversation_ai_actor(subject,true);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- "Open original file" (configure staff only).
CREATE FUNCTION hon.read_school_ai_training_file(subject text, p_file uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE f hon.school_ai_training_files;
BEGIN
  PERFORM hon.require_conversation_ai_actor(subject,true);
  SELECT * INTO f FROM hon.school_ai_training_files x WHERE x.id=p_file AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'CONVERSATION_AI_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.require_conversation_ai_actor(subject,true);
  RETURN jsonb_build_object('fileId',f.id,'fileName',f.file_name,'mediaType',f.media_type,'byteSize',f.byte_size,'contentBase64',encode(f.content,'base64'));
END $$;

-- T3 create (no itemId) or edit (itemId + expectedVersion) one training item. An edit keeps the kind.
CREATE FUNCTION hon.save_school_ai_training_item(subject text, p jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.require_conversation_ai_actor(subject,true); org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  i hon.school_ai_training_items; result jsonb; editing boolean:=p ? 'itemId'; v_file uuid;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,p_key,p_request,p_correlation)
    OR NOT hon.conversation_input_ok(p,ARRAY['kind','title','body'],ARRAY['itemId','expectedVersion','question','staffNote','summary','fileId'])
    OR editing<>(p ? 'expectedVersion') OR (editing AND NOT hon.conversation_uuid_ok(p->'itemId'))
    OR jsonb_typeof(p->'kind')<>'string' OR jsonb_typeof(p->'title')<>'string' OR jsonb_typeof(p->'body')<>'string'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['question','staffNote','summary']) k WHERE p ? k AND jsonb_typeof(p->k)<>'string')
    OR (p ? 'fileId' AND NOT hon.conversation_uuid_ok(p->'fileId')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  v_file:=(p->>'fileId')::uuid;
  IF v_file IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hon.school_ai_training_files f WHERE f.id=v_file AND f.organization_id=org AND f.school_id=school) THEN
    RAISE EXCEPTION 'CONVERSATION_AI_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=hon.conversation_command_begin(actor,p_key,encode(sha256(convert_to('conversation.ai.item.save:'||p::text,'UTF8')),'hex'));
  IF result IS NOT NULL THEN PERFORM hon.require_conversation_ai_actor(subject,true); RETURN jsonb_build_object('receipt',result,'replayed',true); END IF;
  BEGIN
    IF editing THEN
      SELECT * INTO i FROM hon.school_ai_training_items x WHERE x.id=(p->>'itemId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
      IF NOT FOUND OR i.status='DELETED' THEN RAISE EXCEPTION 'CONVERSATION_AI_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
      IF i.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'CONVERSATION_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
      IF i.kind<>p->>'kind' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
      UPDATE hon.school_ai_training_items x SET title=p->>'title',body=p->>'body',question=p->>'question',staff_note=p->>'staffNote',summary=p->>'summary',
        file_id=v_file,version=x.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp() WHERE x.id=i.id RETURNING * INTO i;
    ELSE
      IF (SELECT count(*) FROM hon.school_ai_training_items x WHERE x.organization_id=org AND x.school_id=school AND x.status<>'DELETED')>=200 THEN
        RAISE EXCEPTION 'CONVERSATION_AI_LIBRARY_FULL' USING ERRCODE='55000'; END IF;
      INSERT INTO hon.school_ai_training_items(organization_id,school_id,kind,title,question,body,staff_note,summary,file_id,created_by_principal_id,updated_by_principal_id)
        VALUES(org,school,p->>'kind',p->>'title',p->>'question',p->>'body',p->>'staffNote',p->>'summary',v_file,actor,actor) RETURNING * INTO i;
    END IF;
  EXCEPTION WHEN check_violation OR invalid_text_representation THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END;
  result:=jsonb_build_object('item',hon.conversation_ai_item_json(i));
  PERFORM hon.conversation_ai_finish(actor,p_key,'SCHOOL_AI_TRAINING_ITEM',i.id,i.version,
    CASE WHEN editing THEN 'conversation.ai.item.update' ELSE 'conversation.ai.item.create' END,NULL,
    jsonb_build_object('itemId',i.id,'kind',i.kind,'status',i.status,'version',i.version),'conversation.ai.item.saved',result,p_request,p_correlation);
  PERFORM hon.require_conversation_ai_actor(subject,true);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- T3 the on/off switch (ACTIVE, PAUSED) and soft delete (DELETED, final).
CREATE FUNCTION hon.set_school_ai_training_item_status(subject text, p jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.require_conversation_ai_actor(subject,true); org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  i hon.school_ai_training_items; result jsonb; prior text;
BEGIN
  IF NOT hon.membership_command_args_ok(subject,p_key,p_request,p_correlation) OR NOT hon.conversation_input_ok(p,ARRAY['itemId','expectedVersion','status'],ARRAY[]::text[])
    OR NOT hon.conversation_uuid_ok(p->'itemId') OR jsonb_typeof(p->'status')<>'string' OR p->>'status' NOT IN ('ACTIVE','PAUSED','DELETED') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  result:=hon.conversation_command_begin(actor,p_key,encode(sha256(convert_to('conversation.ai.item.status:'||p::text,'UTF8')),'hex'));
  IF result IS NOT NULL THEN PERFORM hon.require_conversation_ai_actor(subject,true); RETURN jsonb_build_object('receipt',result,'replayed',true); END IF;
  SELECT * INTO i FROM hon.school_ai_training_items x WHERE x.id=(p->>'itemId')::uuid AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND OR i.status='DELETED' THEN RAISE EXCEPTION 'CONVERSATION_AI_ITEM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF i.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'CONVERSATION_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  prior:=i.status;
  UPDATE hon.school_ai_training_items x SET status=p->>'status',version=x.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
    WHERE x.id=i.id RETURNING * INTO i;
  result:=jsonb_build_object('item',CASE WHEN i.status='DELETED' THEN jsonb_build_object('itemId',i.id,'status',i.status,'version',i.version) ELSE hon.conversation_ai_item_json(i) END);
  PERFORM hon.conversation_ai_finish(actor,p_key,'SCHOOL_AI_TRAINING_ITEM',i.id,i.version,'conversation.ai.item.status',jsonb_build_object('status',prior),
    jsonb_build_object('itemId',i.id,'status',i.status,'version',i.version),'conversation.ai.item.saved',result,p_request,p_correlation);
  PERFORM hon.require_conversation_ai_actor(subject,true);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- T1 HQ: read the program switch (HQ readers) and change it (a human HON HQ owner only), idempotent by key, version-checked,
-- with a reason; the change log is the audit. Authority is decided again after the locks, as in 0353.
CREATE FUNCTION hon.read_conversation_ai_program_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.require_saas_hq_actor(p_subject,false); out jsonb;
BEGIN
  SELECT jsonb_build_object('status',p.status,'version',p.version,'updatedAt',hon.conversation_time(p.updated_at),
    'updatedBy',(SELECT left(x.display_name,200) FROM hon.principals x WHERE x.id=p.updated_by_principal_id),
    'schoolsEnabled',(SELECT count(*) FROM hon.school_conversation_ai_settings s WHERE s.enabled),
    'recentChanges',coalesce((SELECT jsonb_agg(jsonb_build_object('from',c.prior_status,'to',c.next_status,'version',c.resulting_version,
        'reason',c.reason,'changedAt',hon.conversation_time(c.changed_at),
        'changedBy',(SELECT left(x.display_name,200) FROM hon.principals x WHERE x.id=c.actor_principal_id)) ORDER BY c.resulting_version DESC)
      FROM (SELECT * FROM hon.conversation_ai_program_changes ORDER BY resulting_version DESC LIMIT 10) c),'[]'::jsonb))
    INTO out FROM hon.conversation_ai_program p WHERE p.program_id=1;
  RETURN out;
END $$;
CREATE FUNCTION hon.command_conversation_ai_program(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; p hon.conversation_ai_program; cmd hon.conversation_ai_program_changes; fp text; v_status text; v_reason text; v_expected integer; prior text;
BEGIN
  actor:=hon.require_saas_hq_actor(p_subject,true);
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k),ARRAY[]::text[])<>ARRAY['expectedVersion','reason','status']
     OR jsonb_typeof(p_input->'status')<>'string' OR p_input->>'status' NOT IN ('OFF','TEST_MODE','LIVE')
     OR jsonb_typeof(p_input->'expectedVersion')<>'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
     OR jsonb_typeof(p_input->'reason')<>'string' OR (p_input->>'reason')<>btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500
     OR (p_input->>'reason') ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'INVALID_CONVERSATION_AI_PROGRAM' USING ERRCODE='22023';
  END IF;
  v_status:=p_input->>'status'; v_reason:=p_input->>'reason'; v_expected:=(p_input->>'expectedVersion')::integer;
  fp:=encode(sha256(convert_to(jsonb_build_object('s',v_status,'r',v_reason,'v',v_expected,'by',actor)::text,'UTF8')),'hex');
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject,true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('conversation-ai.program.key:'||p_key::text,0));
  SELECT * INTO p FROM hon.conversation_ai_program x WHERE x.program_id=1 FOR UPDATE;
  SELECT * INTO cmd FROM hon.conversation_ai_program_changes WHERE command_key=p_key;
  IF FOUND THEN
    IF cmd.fingerprint<>fp THEN RAISE EXCEPTION 'CONVERSATION_AI_PROGRAM_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('status',cmd.next_status,'version',cmd.resulting_version,'changedAt',hon.conversation_time(cmd.changed_at),'replayed',true);
  END IF;
  IF p.version<>v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p.status=v_status THEN RAISE EXCEPTION 'CONVERSATION_AI_PROGRAM_UNCHANGED' USING ERRCODE='23514'; END IF;
  prior:=p.status;
  UPDATE hon.conversation_ai_program x SET status=v_status,version=x.version+1,updated_by_principal_id=actor,updated_at=clock_timestamp()
    WHERE x.program_id=1 RETURNING * INTO p;
  INSERT INTO hon.conversation_ai_program_changes(command_key,fingerprint,actor_principal_id,prior_status,next_status,resulting_version,reason)
    VALUES (p_key,fp,actor,prior,p.status,p.version,v_reason) RETURNING * INTO cmd;
  RETURN jsonb_build_object('status',cmd.next_status,'version',cmd.resulting_version,'changedAt',hon.conversation_time(cmd.changed_at),'replayed',false);
END $$;

DO $$ DECLARE r text; f text; t text;
  entry text[]:=ARRAY['hon.read_school_conversation_ai(text)','hon.read_school_ai_knowledge(text)',
    'hon.set_school_conversation_ai_settings(text,jsonb,text,uuid,uuid)','hon.upload_school_ai_training_file(text,jsonb,text,uuid,uuid)',
    'hon.read_school_ai_training_file(text,uuid)','hon.save_school_ai_training_item(text,jsonb,text,uuid,uuid)',
    'hon.set_school_ai_training_item_status(text,jsonb,text,uuid,uuid)','hon.read_conversation_ai_program_from_hq(text)',
    'hon.command_conversation_ai_program(text,jsonb,uuid)'];
  fns text[]:=ARRAY['hon.conversation_ai_text_ok(text,integer)','hon.conversation_ai_words_ok(text[])','hon.conversation_ai_locales_ok(text[])','hon.guard_conversation_ai_row()',
    'hon.require_conversation_ai_actor(text,boolean)','hon.guard_conversation_ai_program_changes()','hon.conversation_ai_finish(uuid,text,text,uuid,integer,text,jsonb,jsonb,text,jsonb,uuid,uuid)',
    'hon.conversation_ai_settings_json(hon.school_conversation_ai_settings)','hon.conversation_ai_item_json(hon.school_ai_training_items)',
    'hon.school_ai_knowledge(uuid,uuid)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['conversation_ai_program','conversation_ai_program_changes','school_conversation_ai_settings','school_ai_training_files','school_ai_training_items'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
