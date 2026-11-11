BEGIN;

-- 0257 (allocated by the coordinator 2026-11-11): HON weekly briefing, part 1. Spec: docs/architecture/HON_WEEKLY_BRIEFING.md.
-- Owner: "Instead of call let's do sms and email and its optional." Nothing in this migration sends anything.
-- 1. Settings per school: enabled (default off) and the Monday send hour (6-11 school time, default 8). Changed only by
--    a direct human with the owner-only ai.school_briefing.manage; idempotent by key under a per-school lock; audited
--    with values only; internal-only outbox; authority decided again at the end.
-- 2. "Email me" per staff member, for themselves only, to their own account email (never stored here). Turning it on
--    needs reporting.view, because the briefing shows Command Center numbers; turning it off never does. SMS is
--    reserved (CHECK false) until 0258 adds phone verification and the dispatcher.
-- 3. school_briefing_email is a pure fixed template over the Command Center metrics: counts only, never names; a metric
--    that is not available reads "not available yet". The preview builds the reader's own email with the reader's own
--    authority (read_school_command_center re-checks reporting.view and the school's entitlement). No AI, no provider.

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('ai.school_briefing.manage','Turn the HON weekly briefing on or off and choose its send hour for this school (owner only)',false,false)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='ai.school_briefing.manage' AND NOT is_sensitive AND NOT is_staff_assignable) THEN
    RAISE EXCEPTION 'ai.school_briefing.manage already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'ai.school_briefing.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

CREATE TABLE hon.school_briefing_settings (
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  enabled boolean NOT NULL,
  send_hour smallint NOT NULL CHECK (send_hour BETWEEN 6 AND 11),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL REFERENCES hon.principals(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE TABLE hon.school_briefing_subscriptions (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  email_enabled boolean NOT NULL,
  -- Reserved for 0258 (verified phone by code): no row may turn texting on before then.
  sms_enabled boolean NOT NULL DEFAULT false CHECK (NOT sms_enabled),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, school_id, principal_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE TABLE hon.school_briefing_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);
ALTER TABLE hon.school_briefing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_briefing_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_briefing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_briefing_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_briefing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_briefing_requests FORCE ROW LEVEL SECURITY;

-- Guard: never removed; a row keeps its school (and recipient); a request records its response once.
CREATE FUNCTION hon.guard_school_briefing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'SCHOOL_BRIEFING_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='school_briefing_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'SCHOOL_BRIEFING_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF TG_TABLE_NAME='school_briefing_subscriptions' THEN
    IF (NEW.organization_id,NEW.school_id,NEW.principal_id) IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id) THEN
      RAISE EXCEPTION 'SCHOOL_BRIEFING_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF (NEW.organization_id,NEW.school_id) IS DISTINCT FROM (OLD.organization_id,OLD.school_id) THEN
    RAISE EXCEPTION 'SCHOOL_BRIEFING_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_briefing_settings_guard BEFORE UPDATE OR DELETE ON hon.school_briefing_settings FOR EACH ROW EXECUTE FUNCTION hon.guard_school_briefing();
CREATE TRIGGER school_briefing_subscriptions_guard BEFORE UPDATE OR DELETE ON hon.school_briefing_subscriptions FOR EACH ROW EXECUTE FUNCTION hon.guard_school_briefing();
CREATE TRIGGER school_briefing_requests_guard BEFORE UPDATE OR DELETE ON hon.school_briefing_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_school_briefing();
CREATE TRIGGER school_briefing_settings_no_truncate BEFORE TRUNCATE ON hon.school_briefing_settings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_briefing();
CREATE TRIGGER school_briefing_subscriptions_no_truncate BEFORE TRUNCATE ON hon.school_briefing_subscriptions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_briefing();
CREATE TRIGGER school_briefing_requests_no_truncate BEFORE TRUNCATE ON hon.school_briefing_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_briefing();

-- Direct human at the session school, or an error. p_need: MANAGE (owner permission), REPORT (reporting.view, the
-- Command Center permission), READ (any of HON, reporting or manage).
CREATE FUNCTION hon.school_briefing_actor(p_subject text, p_need text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid; org uuid; school uuid; ok boolean;
BEGIN
  PERFORM hon.require_tenant_context();
  org := hon.current_organization_id(); school := hon.current_school_id();
  IF p_subject IS NULL OR p_need IS NULL OR NOT p_need = ANY (ARRAY['MANAGE','REPORT','READ'])
     OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
     OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
     OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
     OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
                    WHERE u.external_subject = p_subject AND p.id = actor AND p.is_active AND p.principal_type = 'HUMAN_USER') THEN
    RAISE EXCEPTION 'SCHOOL_BRIEFING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  ok := CASE p_need
    WHEN 'MANAGE' THEN hon.principal_has_school_permission(actor, org, school, 'ai.school_briefing.manage')
    WHEN 'REPORT' THEN hon.principal_has_school_permission(actor, org, school, 'reporting.view')
    ELSE hon.principal_has_school_permission(actor, org, school, 'ai.school_briefing.manage')
      OR hon.principal_has_school_permission(actor, org, school, 'reporting.view')
      OR hon.principal_has_school_permission(actor, org, school, 'ai.invocation.plan') END;
  IF NOT ok THEN RAISE EXCEPTION 'SCHOOL_BRIEFING_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- The reader's view (no address: the account email is used by 0258 at send time and never copied here).
CREATE FUNCTION hon.school_briefing_view(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
  s hon.school_briefing_settings%ROWTYPE; m hon.school_briefing_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM hon.school_briefing_settings WHERE organization_id = org AND school_id = school;
  SELECT * INTO m FROM hon.school_briefing_subscriptions WHERE organization_id = org AND school_id = school AND principal_id = p_actor;
  RETURN jsonb_build_object('enabled', coalesce(s.enabled, false), 'sendHour', coalesce(s.send_hour, 8),
    'canManage', hon.principal_has_school_permission(p_actor, org, school, 'ai.school_briefing.manage'),
    'me', jsonb_build_object('email', coalesce(m.email_enabled, false),
      'canSubscribe', hon.principal_has_school_permission(p_actor, org, school, 'reporting.view')));
END $$;

-- Pure fixed template over Command Center metrics (data only; never names, addresses or free text from records).
CREATE FUNCTION hon.school_briefing_email(p_metrics jsonb, p_school_name text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE sname text := left(btrim(regexp_replace(coalesce(p_school_name, ''), '[[:cntrl:]<>]+', ' ', 'g')), 120);
  lines text[] := ARRAY[]::text[]; item text[];
BEGIN
  IF sname = '' THEN sname := 'your school'; END IF;
  lines := lines || format('Here are this week''s numbers for %s, from the HON Command Center.', sname) || ''::text;
  FOREACH item SLICE 1 IN ARRAY ARRAY[
    ['newLeads24h', 'New leads in the last 24 hours'],
    ['upcomingTrials24h', 'Trial classes in the next 24 hours'],
    ['upcomingTestingEvents30d', 'Testing events in the next 30 days'],
    ['membershipTermsEnding30d', 'Memberships due for renewal in the next 30 days'],
    ['paidInvoicesCreated30d', 'Paid invoices in the last 30 days'],
    ['pendingActionApprovals', 'Actions waiting for approval'],
    ['outstandingWorkItems', 'Open HON work items'],
    ['unansweredInquiries', 'Unanswered inquiries'],
    ['attendanceDecline', 'Attendance trend'],
    ['revenue', 'Revenue']] LOOP
    lines := lines || (item[2] || ': ' || CASE
      WHEN p_metrics->item[1]->>'availability' = 'AVAILABLE' AND jsonb_typeof(p_metrics->item[1]->'count') = 'number'
        THEN (p_metrics->item[1]->>'count')
      ELSE 'not available yet' END);
  END LOOP;
  lines := lines || ''::text || 'Counts only: this email never includes a student, family or lead name.'::text
    || 'To stop these emails, open HON and turn off "Email me" under Weekly briefing.'::text;
  RETURN jsonb_build_object('subject', left('HON weekly briefing: ' || sname, 200), 'text', left(array_to_string(lines, E'\n'), 4000));
END $$;

CREATE FUNCTION hon.read_school_briefing(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN hon.school_briefing_view(hon.school_briefing_actor(p_subject, 'READ'));
END $$;

CREATE FUNCTION hon.read_school_briefing_preview(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.school_briefing_actor(p_subject, 'REPORT'); school_name text;
BEGIN
  SELECT s.name INTO STRICT school_name FROM hon.schools s WHERE s.id = hon.current_school_id() AND s.organization_id = hon.current_organization_id();
  RETURN hon.school_briefing_email(
    hon.read_school_command_center(p_subject, hon.current_organization_id(), hon.current_school_id())->'metrics', school_name);
END $$;

-- Shared command shape for the two writes: closed input checked first, actor, per-school lock, idempotent claim.
-- Returns the prior response (replay) or NULL when this request is new and claimed.
CREATE FUNCTION hon.school_briefing_claim(p_subject text, p_kind text, p_input jsonb, p_key text, p_request uuid, p_correlation uuid, p_need text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id(); actor uuid; fp text;
  prior hon.school_briefing_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key) <> p_key OR p_key ~ '[[:cntrl:]]'
     OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id', true) THEN
    RAISE EXCEPTION 'SCHOOL_BRIEFING_INVALID' USING ERRCODE = '22023';
  END IF;
  actor := hon.school_briefing_actor(p_subject, p_need);
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_briefing:' || school::text, 0));
  fp := encode(sha256(convert_to(p_kind || ':' || p_input::text, 'UTF8')), 'hex');
  INSERT INTO hon.school_briefing_requests(organization_id, school_id, principal_id, idempotency_key, fingerprint)
    VALUES (org, school, actor, p_key, fp) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.school_briefing_requests WHERE organization_id = org AND school_id = school AND principal_id = actor AND idempotency_key = p_key FOR UPDATE;
  IF prior.fingerprint <> fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  IF prior.response IS NULL THEN RAISE EXCEPTION 'SCHOOL_BRIEFING_BUSY' USING ERRCODE = '55P03'; END IF;
  PERFORM hon.school_briefing_actor(p_subject, p_need);
  RETURN jsonb_build_object('record', hon.school_briefing_view(actor), 'replayed', true);
END $$;

CREATE FUNCTION hon.school_briefing_finish(p_subject text, p_key text, p_need text, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb := jsonb_build_object('record', hon.school_briefing_view(p_actor));
BEGIN
  UPDATE hon.school_briefing_requests SET response = result, completed_at = clock_timestamp()
    WHERE organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND principal_id = p_actor AND idempotency_key = p_key;
  IF hon.school_briefing_actor(p_subject, p_need) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'SCHOOL_BRIEFING_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN result || jsonb_build_object('replayed', false);
END $$;

CREATE FUNCTION hon.set_school_briefing_settings(p_subject text, p_input jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id(); actor uuid; prior jsonb;
  hour numeric; previous hon.school_briefing_settings%ROWTYPE; saved hon.school_briefing_settings%ROWTYPE; values_ jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['enabled','sendHour']
     OR jsonb_typeof(p_input->'enabled') <> 'boolean' OR jsonb_typeof(p_input->'sendHour') <> 'number' THEN
    RAISE EXCEPTION 'SCHOOL_BRIEFING_INVALID' USING ERRCODE = '22023';
  END IF;
  hour := (p_input->>'sendHour')::numeric;
  IF hour <> trunc(hour) OR hour NOT BETWEEN 6 AND 11 THEN RAISE EXCEPTION 'SCHOOL_BRIEFING_INVALID' USING ERRCODE = '22023'; END IF;
  prior := hon.school_briefing_claim(p_subject, 'SETTINGS', p_input, p_key, p_request, p_correlation, 'MANAGE');
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  actor := hon.school_briefing_actor(p_subject, 'MANAGE');
  SELECT * INTO previous FROM hon.school_briefing_settings WHERE organization_id = org AND school_id = school FOR UPDATE;
  INSERT INTO hon.school_briefing_settings(organization_id, school_id, enabled, send_hour, updated_by)
    VALUES (org, school, (p_input->>'enabled')::boolean, hour::smallint, actor)
    ON CONFLICT (organization_id, school_id) DO UPDATE SET enabled = EXCLUDED.enabled, send_hour = EXCLUDED.send_hour,
      version = hon.school_briefing_settings.version + 1, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()
    RETURNING * INTO saved;
  values_ := jsonb_build_object('enabled', saved.enabled, 'sendHour', saved.send_hour,
    'previousEnabled', coalesce(previous.enabled, false), 'previousSendHour', coalesce(previous.send_hour, 8));
  INSERT INTO hon.audit_events(organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, next_state, result, request_id, correlation_id)
    VALUES (org, school, actor, 'HUMAN_UI', 'hon.school_briefing.settings', 'SCHOOL_BRIEFING_SETTINGS', school, values_, 'SUCCEEDED', p_request, p_correlation);
  INSERT INTO hon.outbox_events(organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
    VALUES (org, school, 'hon.school_briefing.settings', 1, 'SCHOOL_BRIEFING_SETTINGS', school, saved.version, p_correlation, p_request,
      values_ || jsonb_build_object('internalOnly', true));
  RETURN hon.school_briefing_finish(p_subject, p_key, 'MANAGE', actor);
END $$;

CREATE FUNCTION hon.set_my_school_briefing(p_subject text, p_input jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id(); actor uuid; prior jsonb; need text;
  saved hon.school_briefing_subscriptions%ROWTYPE; values_ jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['email']
     OR jsonb_typeof(p_input->'email') <> 'boolean' THEN
    RAISE EXCEPTION 'SCHOOL_BRIEFING_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Turning one's own email on needs the Command Center permission; turning it off never does.
  need := CASE WHEN (p_input->>'email')::boolean THEN 'REPORT' ELSE 'READ' END;
  prior := hon.school_briefing_claim(p_subject, 'ME', p_input, p_key, p_request, p_correlation, need);
  IF prior IS NOT NULL THEN RETURN prior; END IF;
  actor := hon.school_briefing_actor(p_subject, need);
  INSERT INTO hon.school_briefing_subscriptions(organization_id, school_id, principal_id, email_enabled)
    VALUES (org, school, actor, (p_input->>'email')::boolean)
    ON CONFLICT (organization_id, school_id, principal_id) DO UPDATE SET email_enabled = EXCLUDED.email_enabled,
      version = hon.school_briefing_subscriptions.version + 1, updated_at = clock_timestamp()
    RETURNING * INTO saved;
  values_ := jsonb_build_object('email', saved.email_enabled);
  INSERT INTO hon.audit_events(organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, next_state, result, request_id, correlation_id)
    VALUES (org, school, actor, 'HUMAN_UI', 'hon.school_briefing.me', 'SCHOOL_BRIEFING_SUBSCRIPTION', actor, values_, 'SUCCEEDED', p_request, p_correlation);
  INSERT INTO hon.outbox_events(organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
    VALUES (org, school, 'hon.school_briefing.me', 1, 'SCHOOL_BRIEFING_SUBSCRIPTION', actor, saved.version, p_correlation, p_request,
      values_ || jsonb_build_object('internalOnly', true));
  RETURN hon.school_briefing_finish(p_subject, p_key, need, actor);
END $$;

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['school_briefing_settings','school_briefing_subscriptions','school_briefing_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_school_briefing()','hon.school_briefing_actor(text,text)','hon.school_briefing_view(uuid)',
    'hon.school_briefing_email(jsonb,text)','hon.read_school_briefing(text)','hon.read_school_briefing_preview(text)',
    'hon.school_briefing_claim(text,text,jsonb,text,uuid,uuid,text)','hon.school_briefing_finish(text,text,text,uuid)',
    'hon.set_school_briefing_settings(text,jsonb,text,uuid,uuid)','hon.set_my_school_briefing(text,jsonb,text,uuid,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_briefing(text),hon.read_school_briefing_preview(text),
      hon.set_school_briefing_settings(text,jsonb,text,uuid,uuid),hon.set_my_school_briefing(text,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
