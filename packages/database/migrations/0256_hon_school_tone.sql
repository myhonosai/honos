BEGIN;

-- 0256 (allocated by the coordinator 2026-11-11): HON tone per school. Spec: docs/architecture/HON_SCHOOL_TONE.md.
-- 1. One closed tone key per school (no row = STANDARD, today's wording). The prompt sentence is a fixed table in the
--    API keyed by this value, so a tone never carries text or instructions.
-- 2. Set: direct human staff with the owner-only ai.school_tone.manage at the session school; idempotent by key under a
--    per-school lock; audited with the previous and new key only; internal-only outbox; authority decided again at the end.
-- 3. Read: HON users (ai.invocation.plan), Kai users (teaching.assistant.use) or manage. hon_ai_tone() gives the session
--    school's key to the HON and Kai services inside their prepare transaction. Nothing here calls a provider or spends.

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('ai.school_tone.manage','Choose how HON and Kai word their answers for this school (owner only)',false,false)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='ai.school_tone.manage' AND NOT is_sensitive AND NOT is_staff_assignable) THEN
    RAISE EXCEPTION 'ai.school_tone.manage already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'ai.school_tone.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

CREATE FUNCTION hon.hon_ai_tones() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['STANDARD', 'FRIENDLY_COACH', 'STRAIGHT_TO_THE_POINT', 'FORMAL']::text[];
$$;

CREATE TABLE hon.hon_school_tones (
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  tone text NOT NULL CHECK (tone = ANY (hon.hon_ai_tones())),
  updated_by uuid NOT NULL REFERENCES hon.principals(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE TABLE hon.hon_school_tone_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);
ALTER TABLE hon.hon_school_tones ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hon_school_tones FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hon_school_tone_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hon_school_tone_requests FORCE ROW LEVEL SECURITY;

-- Guard: never removed; a tone row changes only its tone, author and time; a request records its response once.
CREATE FUNCTION hon.guard_hon_school_tones() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'HON_SCHOOL_TONE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='hon_school_tone_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'HON_SCHOOL_TONE_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF (NEW.organization_id,NEW.school_id) IS DISTINCT FROM (OLD.organization_id,OLD.school_id) THEN
    RAISE EXCEPTION 'HON_SCHOOL_TONE_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hon_school_tones_guard BEFORE UPDATE OR DELETE ON hon.hon_school_tones FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_school_tones();
CREATE TRIGGER hon_school_tone_requests_guard BEFORE UPDATE OR DELETE ON hon.hon_school_tone_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hon_school_tones();
CREATE TRIGGER hon_school_tones_no_truncate BEFORE TRUNCATE ON hon.hon_school_tones FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hon_school_tones();
CREATE TRIGGER hon_school_tone_requests_no_truncate BEFORE TRUNCATE ON hon.hon_school_tone_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hon_school_tones();

-- Direct human at the session school with manage (p_manage) or HON/Kai/manage (read) permission now, or an error.
CREATE FUNCTION hon.hon_school_tone_actor(p_subject text, p_manage boolean) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid; org uuid; school uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  org := hon.current_organization_id(); school := hon.current_school_id();
  IF p_subject IS NULL
     OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
     OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
     OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
     OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
                    WHERE u.external_subject = p_subject AND p.id = actor AND p.is_active AND p.principal_type = 'HUMAN_USER')
     OR NOT (hon.principal_has_school_permission(actor, org, school, 'ai.school_tone.manage')
             OR (NOT p_manage AND (hon.principal_has_school_permission(actor, org, school, 'ai.invocation.plan')
                                   OR hon.principal_has_school_permission(actor, org, school, 'teaching.assistant.use')))) THEN
    RAISE EXCEPTION 'HON_SCHOOL_TONE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END $$;

-- The session school's tone for the HON and Kai services (inside their own authorized prepare transaction).
CREATE FUNCTION hon.hon_ai_tone() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_tenant_context();
  RETURN coalesce((SELECT t.tone FROM hon.hon_school_tones t WHERE t.organization_id = hon.current_organization_id() AND t.school_id = hon.current_school_id()), 'STANDARD');
END $$;

CREATE FUNCTION hon.read_hon_school_tone(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_school_tone_actor(p_subject, false); t hon.hon_school_tones%ROWTYPE;
BEGIN
  SELECT * INTO t FROM hon.hon_school_tones WHERE organization_id = hon.current_organization_id() AND school_id = hon.current_school_id();
  RETURN jsonb_build_object('tone', coalesce(t.tone, 'STANDARD'),
    'canManage', hon.principal_has_school_permission(actor, hon.current_organization_id(), hon.current_school_id(), 'ai.school_tone.manage'),
    'updatedAt', CASE WHEN t.updated_at IS NULL THEN NULL ELSE to_jsonb(hon.saas_ts(t.updated_at)) END);
END $$;

CREATE FUNCTION hon.set_hon_school_tone(p_subject text, p_input jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id(); actor uuid; fp text;
  prior hon.hon_school_tone_requests%ROWTYPE; previous text; result jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key) <> p_key OR p_key ~ '[[:cntrl:]]'
     OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id', true)
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['tone']
     OR jsonb_typeof(p_input->'tone') <> 'string' OR NOT (p_input->>'tone') = ANY (hon.hon_ai_tones()) THEN
    RAISE EXCEPTION 'HON_SCHOOL_TONE_INVALID' USING ERRCODE = '22023';
  END IF;
  actor := hon.hon_school_tone_actor(p_subject, true);
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_tone:' || school::text, 0));
  fp := encode(sha256(convert_to(p_input::text, 'UTF8')), 'hex');
  INSERT INTO hon.hon_school_tone_requests(organization_id, school_id, principal_id, idempotency_key, fingerprint)
    VALUES (org, school, actor, p_key, fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.hon_school_tone_requests WHERE organization_id = org AND school_id = school AND principal_id = actor AND idempotency_key = p_key FOR UPDATE;
    IF prior.fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'HON_SCHOOL_TONE_BUSY' USING ERRCODE = '55P03'; END IF;
    PERFORM hon.hon_school_tone_actor(p_subject, true);
    RETURN prior.response || jsonb_build_object('replayed', true);
  END IF;
  SELECT tone INTO previous FROM hon.hon_school_tones WHERE organization_id = org AND school_id = school FOR UPDATE;
  previous := coalesce(previous, 'STANDARD');
  INSERT INTO hon.hon_school_tones(organization_id, school_id, tone, updated_by) VALUES (org, school, p_input->>'tone', actor)
    ON CONFLICT (organization_id, school_id) DO UPDATE SET tone = EXCLUDED.tone, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp();
  result := jsonb_build_object('tone', p_input->>'tone', 'previousTone', previous);
  INSERT INTO hon.audit_events(organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, next_state, result, request_id, correlation_id)
    VALUES (org, school, actor, 'HUMAN_UI', 'hon.school_tone.set', 'HON_SCHOOL_TONE', school, result, 'SUCCEEDED', p_request, p_correlation);
  INSERT INTO hon.outbox_events(organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
    VALUES (org, school, 'hon.school_tone.set', 1, 'HON_SCHOOL_TONE', school, 1, p_correlation, p_request,
      result || jsonb_build_object('internalOnly', true));
  UPDATE hon.hon_school_tone_requests SET response = result, completed_at = clock_timestamp()
    WHERE organization_id = org AND school_id = school AND principal_id = actor AND idempotency_key = p_key;
  IF hon.hon_school_tone_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'HON_SCHOOL_TONE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN result || jsonb_build_object('replayed', false);
END $$;

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['hon_school_tones','hon_school_tone_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.hon_ai_tones()','hon.guard_hon_school_tones()','hon.hon_school_tone_actor(text,boolean)','hon.hon_ai_tone()',
    'hon.read_hon_school_tone(text)','hon.set_hon_school_tone(text,jsonb,text,uuid,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hon_school_tone(text),hon.set_hon_school_tone(text,jsonb,text,uuid,uuid),hon.hon_ai_tone() TO hon_runtime;
  END IF;
END $$;

COMMIT;
