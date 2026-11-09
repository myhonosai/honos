BEGIN;

-- B-HQ-2 HQ support records (number 0232 proposed; the owner allocates the final number). HQ-internal support cases per
-- customer organization (optionally one school), with an immutable history of notes, status, priority and assignment
-- changes. HQ only: an HQ owner, or an HQ operator or HQ support person holding hq.support.manage. No school, family or
-- runtime role can read or write these rows. Nothing here sends a message, opens school access, impersonates anyone or
-- touches billing, entitlements, payments or credits.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ support records require a trusted migration owner';
  END IF;
END $$;

CREATE TABLE hon.hq_support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id),
  school_id uuid,
  subject text NOT NULL CHECK (subject = btrim(subject) AND length(subject) BETWEEN 3 AND 200),
  category text NOT NULL CHECK (category IN ('ACCOUNT_ACCESS','BILLING','ONBOARDING','PRODUCT_ISSUE','DATA_REQUEST','FEEDBACK','OTHER')),
  priority text NOT NULL CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status text NOT NULL CHECK (status IN ('OPEN','WAITING_ON_SCHOOL','RESOLVED','CLOSED')),
  assignee_principal_id uuid REFERENCES hon.principals(id),
  opened_by uuid NOT NULL REFERENCES hon.principals(id),
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  CHECK (updated_at >= opened_at),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE INDEX hq_support_cases_opened_idx ON hon.hq_support_cases (opened_at DESC, id DESC);
CREATE INDEX hq_support_cases_org_idx ON hon.hq_support_cases (organization_id, opened_at DESC);

CREATE TABLE hon.hq_support_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES hon.hq_support_cases(id),
  seq integer NOT NULL CHECK (seq > 0),
  kind text NOT NULL CHECK (kind IN ('OPENED','NOTE','CHANGED')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  note text CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 4000)),
  status_from text, status_to text, priority_from text, priority_to text,
  assignee_changed boolean NOT NULL DEFAULT false, assignee_to uuid REFERENCES hon.principals(id),
  occurred_at timestamptz NOT NULL,
  UNIQUE (case_id, seq),
  CHECK (kind <> 'NOTE' OR note IS NOT NULL),
  CHECK (kind <> 'CHANGED' OR status_to IS NOT NULL OR priority_to IS NOT NULL OR assignee_changed),
  CHECK ((status_from IS NULL) = (status_to IS NULL) AND (priority_from IS NULL) = (priority_to IS NULL)),
  CHECK (assignee_changed OR assignee_to IS NULL)
);

CREATE TABLE hon.hq_support_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('OPEN','NOTE','CHANGE')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  case_id uuid NOT NULL REFERENCES hon.hq_support_cases(id),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);

-- Cases change only by a version bump of the mutable fields; history and requests never change.
CREATE FUNCTION hon.guard_hq_support_case() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1
    AND (to_jsonb(NEW) - ARRAY['status','priority','assignee_principal_id','updated_at','closed_at','version'])
      = (to_jsonb(OLD) - ARRAY['status','priority','assignee_principal_id','updated_at','closed_at','version'])
    AND OLD.status <> 'CLOSED' AND NEW.updated_at >= OLD.updated_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_SUPPORT_RECORD_IMMUTABLE' USING ERRCODE = '42501';
END $$;
CREATE FUNCTION hon.guard_hq_support_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN RAISE EXCEPTION 'HQ_SUPPORT_RECORD_IMMUTABLE' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_support_cases FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_support_case();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_support_cases FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_support_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_support_case_events FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_support_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_support_case_events FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_support_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.hq_support_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_support_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_support_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_support_evidence();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_support_cases','hq_support_case_events','hq_support_requests'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
  END LOOP;
END $$;
DO $$ DECLARE r text; t text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    FOREACH t IN ARRAY ARRAY['hq_support_cases','hq_support_case_events','hq_support_requests'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- ---------- authority ----------
-- Whether a principal may work support now: a current HQ owner, or a current HQ operator / HQ support grant holding
-- hq.support.manage; an active human, the only active principal of its user, with no live family access.
CREATE FUNCTION hon.hq_support_principal_eligible(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.principals p WHERE p.id = p_principal AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals o WHERE o.user_id = p.user_id AND o.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (g.hq_role = 'HON_HQ_OWNER' OR (g.hq_role IN ('HON_HQ_OPERATOR','HON_HQ_SUPPORT') AND 'hq.support.manage' = ANY(g.permission_codes))))
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp())))
$$;

CREATE FUNCTION hon.require_hq_support_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND hon.hq_support_principal_eligible(p.id);
  IF actor IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- ---------- projections ----------
CREATE FUNCTION hon.hq_support_person_json(p_principal uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN p_principal IS NULL THEN NULL ELSE (SELECT jsonb_build_object('principalId', p.id,
    'displayName', left(coalesce(nullif(btrim(u.display_name), ''), 'HQ team member'), 120))
    FROM hon.principals p JOIN hon.users u ON u.id = p.user_id WHERE p.id = p_principal) END
$$;

CREATE FUNCTION hon.hq_support_case_json(c hon.hq_support_cases) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('caseId', c.id, 'organizationId', c.organization_id,
    'organizationDisplayName', left((SELECT o.display_name FROM hon.organizations o WHERE o.id = c.organization_id), 300),
    'schoolId', c.school_id,
    'schoolDisplayName', CASE WHEN c.school_id IS NULL THEN NULL ELSE left((SELECT s.name FROM hon.schools s WHERE s.id = c.school_id), 300) END,
    'subject', c.subject, 'category', c.category, 'priority', c.priority, 'status', c.status,
    'assignee', hon.hq_support_person_json(c.assignee_principal_id), 'openedBy', hon.hq_support_person_json(c.opened_by),
    'openedAt', hon.saas_ts(c.opened_at), 'updatedAt', hon.saas_ts(c.updated_at), 'closedAt', hon.saas_ts(c.closed_at),
    'version', c.version,
    'noteCount', (SELECT count(*) FROM hon.hq_support_case_events e WHERE e.case_id = c.id AND e.note IS NOT NULL))
$$;

CREATE FUNCTION hon.hq_support_event_json(e hon.hq_support_case_events) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('seq', e.seq, 'kind', e.kind, 'actor', hon.hq_support_person_json(e.actor_principal_id),
    'note', e.note, 'statusFrom', e.status_from, 'statusTo', e.status_to, 'priorityFrom', e.priority_from, 'priorityTo', e.priority_to,
    'assigneeChanged', e.assignee_changed, 'assigneeTo', hon.hq_support_person_json(e.assignee_to), 'occurredAt', hon.saas_ts(e.occurred_at))
$$;

-- HQ people a case can be assigned to (the support team, never anyone else).
CREATE FUNCTION hon.hq_support_assignees_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(jsonb_agg(hon.hq_support_person_json(x.id) ORDER BY x.name, x.id), '[]'::jsonb)
  FROM (SELECT DISTINCT p.id, lower(coalesce(u.display_name, '')) AS name FROM hon.hq_operator_grants g
    JOIN hon.principals p ON p.id = g.principal_id JOIN hon.users u ON u.id = p.user_id
    WHERE hon.hq_support_principal_eligible(p.id)) x
$$;

-- Replays a completed request of this actor and key, refuses reuse with other content, or returns NULL to proceed.
CREATE FUNCTION hon.hq_support_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_support_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-support:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_support_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

CREATE FUNCTION hon.hq_support_text(p_input jsonb, p_key text, p_min integer, p_max integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF jsonb_typeof(p_input->p_key) IS DISTINCT FROM 'string' OR (p_input->>p_key) <> btrim(p_input->>p_key)
    OR length(p_input->>p_key) NOT BETWEEN p_min AND p_max OR (p_input->>p_key) ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN p_input->>p_key;
END $$;

-- ---------- commands ----------
-- OPEN: {organizationId, schoolId|null, subject, category, priority, note}
CREATE FUNCTION hon.open_hq_support_case(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; c hon.hq_support_cases%ROWTYPE; v_org uuid; v_school uuid; v_note text; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_support_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> ARRAY['category','note','organizationId','priority','schoolId','subject']
    OR jsonb_typeof(p_input->'organizationId') IS DISTINCT FROM 'string'
    OR (p_input->>'organizationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'schoolId') NOT IN ('string','null')
    OR (jsonb_typeof(p_input->'schoolId') = 'string' AND (p_input->>'schoolId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR jsonb_typeof(p_input->'category') IS DISTINCT FROM 'string'
    OR (p_input->>'category') NOT IN ('ACCOUNT_ACCESS','BILLING','ONBOARDING','PRODUCT_ISSUE','DATA_REQUEST','FEEDBACK','OTHER')
    OR jsonb_typeof(p_input->'priority') IS DISTINCT FROM 'string' OR (p_input->>'priority') NOT IN ('LOW','NORMAL','HIGH','URGENT') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.hq_support_text(p_input, 'subject', 3, 200);
  v_note := hon.hq_support_text(p_input, 'note', 1, 4000);
  v_org := (p_input->>'organizationId')::uuid; v_school := (p_input->>'schoolId')::uuid;
  replay := hon.hq_support_claim(actor, p_key, 'OPEN', hon.saas_fingerprint(ARRAY['hq.support.open', p_input::text]));
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_support_actor(p_subject); RETURN replay; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = v_org)
    OR (v_school IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hon.schools WHERE id = v_school AND organization_id = v_org)) THEN
    RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO hon.hq_support_cases (organization_id, school_id, subject, category, priority, status, opened_by, opened_at, updated_at)
  VALUES (v_org, v_school, p_input->>'subject', p_input->>'category', p_input->>'priority', 'OPEN', actor, at, at) RETURNING * INTO c;
  INSERT INTO hon.hq_support_case_events (case_id, seq, kind, actor_principal_id, note, occurred_at) VALUES (c.id, 1, 'OPENED', actor, v_note, at);
  result := jsonb_build_object('operation', 'OPEN', 'case', hon.hq_support_case_json(c));
  INSERT INTO hon.hq_support_requests VALUES (actor, p_key, 'OPEN', hon.saas_fingerprint(ARRAY['hq.support.open', p_input::text]), c.id, result, at);
  PERFORM hon.require_hq_support_actor(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- Locks the case and checks its version. Shared by NOTE and CHANGE.
CREATE FUNCTION hon.hq_support_lock_case(p_case uuid, p_expected integer) RETURNS hon.hq_support_cases
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE c hon.hq_support_cases%ROWTYPE;
BEGIN
  SELECT * INTO c FROM hon.hq_support_cases WHERE id = p_case FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF c.version <> p_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF c.status = 'CLOSED' THEN RAISE EXCEPTION 'SUPPORT_CASE_CLOSED' USING ERRCODE = '23514'; END IF;
  RETURN c;
END $$;

CREATE FUNCTION hon.hq_support_expected(p_input jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN (p_input->>'expectedVersion')::integer;
END $$;

-- NOTE: {expectedVersion, note}
CREATE FUNCTION hon.add_hq_support_note(p_subject text, p_case uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; c hon.hq_support_cases%ROWTYPE; v_note text; v_expected integer; at timestamptz; fp text; result jsonb;
BEGIN
  actor := hon.require_hq_support_actor(p_subject);
  IF p_case IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> ARRAY['expectedVersion','note'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := hon.hq_support_expected(p_input); v_note := hon.hq_support_text(p_input, 'note', 1, 4000);
  fp := hon.saas_fingerprint(ARRAY['hq.support.note', p_case::text, p_input::text]);
  replay := hon.hq_support_claim(actor, p_key, 'NOTE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_support_actor(p_subject); RETURN replay; END IF;
  c := hon.hq_support_lock_case(p_case, v_expected);
  at := greatest(clock_timestamp(), c.updated_at);
  INSERT INTO hon.hq_support_case_events (case_id, seq, kind, actor_principal_id, note, occurred_at)
  VALUES (c.id, (SELECT max(seq) + 1 FROM hon.hq_support_case_events WHERE case_id = c.id), 'NOTE', actor, v_note, at);
  UPDATE hon.hq_support_cases SET updated_at = at, version = version + 1 WHERE id = c.id RETURNING * INTO c;
  result := jsonb_build_object('operation', 'NOTE', 'case', hon.hq_support_case_json(c));
  INSERT INTO hon.hq_support_requests VALUES (actor, p_key, 'NOTE', fp, c.id, result, at);
  PERFORM hon.require_hq_support_actor(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- CHANGE: {expectedVersion, status?, priority?, assigneePrincipalId? (uuid or null), note?}; at least one real change.
CREATE FUNCTION hon.change_hq_support_case(p_subject text, p_case uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; c hon.hq_support_cases%ROWTYPE; v_expected integer; v_note text; at timestamptz; fp text; result jsonb;
  v_status text; v_priority text; v_assignee uuid; set_assignee boolean; s_from text; s_to text; p_from text; p_to text; a_changed boolean := false;
BEGIN
  actor := hon.require_hq_support_actor(p_subject);
  IF p_case IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR NOT (p_input ? 'expectedVersion')
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('expectedVersion','status','priority','assigneePrincipalId','note'))
    OR (p_input ? 'status' AND (jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR (p_input->>'status') NOT IN ('OPEN','WAITING_ON_SCHOOL','RESOLVED','CLOSED')))
    OR (p_input ? 'priority' AND (jsonb_typeof(p_input->'priority') IS DISTINCT FROM 'string' OR (p_input->>'priority') NOT IN ('LOW','NORMAL','HIGH','URGENT')))
    OR (p_input ? 'assigneePrincipalId' AND jsonb_typeof(p_input->'assigneePrincipalId') NOT IN ('string','null'))
    OR (jsonb_typeof(p_input->'assigneePrincipalId') = 'string'
      AND (p_input->>'assigneePrincipalId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := hon.hq_support_expected(p_input);
  IF p_input ? 'note' THEN v_note := hon.hq_support_text(p_input, 'note', 1, 4000); END IF;
  v_status := p_input->>'status'; v_priority := p_input->>'priority';
  set_assignee := p_input ? 'assigneePrincipalId'; v_assignee := (p_input->>'assigneePrincipalId')::uuid;
  fp := hon.saas_fingerprint(ARRAY['hq.support.change', p_case::text, p_input::text]);
  replay := hon.hq_support_claim(actor, p_key, 'CHANGE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_support_actor(p_subject); RETURN replay; END IF;
  c := hon.hq_support_lock_case(p_case, v_expected);
  IF v_status IS NOT NULL AND v_status <> c.status THEN s_from := c.status; s_to := v_status; END IF;
  IF v_priority IS NOT NULL AND v_priority <> c.priority THEN p_from := c.priority; p_to := v_priority; END IF;
  IF set_assignee AND v_assignee IS DISTINCT FROM c.assignee_principal_id THEN
    IF v_assignee IS NOT NULL AND NOT hon.hq_support_principal_eligible(v_assignee) THEN
      RAISE EXCEPTION 'SUPPORT_ASSIGNEE_NOT_ELIGIBLE' USING ERRCODE = '23514';
    END IF;
    a_changed := true;
  END IF;
  IF s_to IS NULL AND p_to IS NULL AND NOT a_changed THEN RAISE EXCEPTION 'SUPPORT_NO_CHANGE' USING ERRCODE = '23514'; END IF;
  at := greatest(clock_timestamp(), c.updated_at);
  INSERT INTO hon.hq_support_case_events (case_id, seq, kind, actor_principal_id, note, status_from, status_to, priority_from, priority_to,
    assignee_changed, assignee_to, occurred_at)
  VALUES (c.id, (SELECT max(seq) + 1 FROM hon.hq_support_case_events WHERE case_id = c.id), 'CHANGED', actor, v_note, s_from, s_to, p_from, p_to,
    a_changed, CASE WHEN a_changed THEN v_assignee END, at);
  UPDATE hon.hq_support_cases SET status = coalesce(s_to, status), priority = coalesce(p_to, priority),
    assignee_principal_id = CASE WHEN a_changed THEN v_assignee ELSE assignee_principal_id END,
    closed_at = CASE WHEN coalesce(s_to, status) = 'CLOSED' THEN at END, updated_at = at, version = version + 1
  WHERE id = c.id RETURNING * INTO c;
  result := jsonb_build_object('operation', 'CHANGE', 'case', hon.hq_support_case_json(c));
  INSERT INTO hon.hq_support_requests VALUES (actor, p_key, 'CHANGE', fp, c.id, result, at);
  PERFORM hon.require_hq_support_actor(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- reads ----------
-- List: p_status NULL (all), 'ACTIVE' (OPEN or WAITING_ON_SCHOOL) or one status; optional organization; keyset by (opened_at, id) DESC.
CREATE FUNCTION hon.read_hq_support_cases(p_subject text, p_status text, p_organization uuid, p_cursor_at timestamptz, p_cursor_id uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; v_rows jsonb; v_last hon.hq_support_cases%ROWTYPE; n integer; at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_support_actor(p_subject);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR (p_cursor_at IS NULL) <> (p_cursor_id IS NULL)
    OR (p_status IS NOT NULL AND p_status NOT IN ('ACTIVE','OPEN','WAITING_ON_SCHOOL','RESOLVED','CLOSED')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  WITH page AS (
    SELECT c AS r, c.opened_at, c.id FROM hon.hq_support_cases c
    WHERE (p_status IS NULL OR (p_status = 'ACTIVE' AND c.status IN ('OPEN','WAITING_ON_SCHOOL')) OR c.status = p_status)
      AND (p_organization IS NULL OR c.organization_id = p_organization)
      AND (p_cursor_at IS NULL OR (c.opened_at, c.id) < (p_cursor_at, p_cursor_id))
    ORDER BY c.opened_at DESC, c.id DESC LIMIT p_limit)
  SELECT coalesce(jsonb_agg(hon.hq_support_case_json(page.r) ORDER BY page.opened_at DESC, page.id DESC), '[]'::jsonb), count(*) INTO v_rows, n FROM page;
  IF n = p_limit THEN
    SELECT * INTO v_last FROM hon.hq_support_cases WHERE id = (v_rows->(n - 1)->>'caseId')::uuid;
  END IF;
  result := jsonb_build_object('cases', v_rows, 'limit', p_limit,
    'nextCursor', CASE WHEN n = p_limit THEN jsonb_build_object('openedAt', hon.saas_ts(v_last.opened_at), 'caseId', v_last.id) END,
    'summary', (SELECT jsonb_build_object(
      'OPEN', count(*) FILTER (WHERE status = 'OPEN'), 'WAITING_ON_SCHOOL', count(*) FILTER (WHERE status = 'WAITING_ON_SCHOOL'),
      'RESOLVED', count(*) FILTER (WHERE status = 'RESOLVED'), 'CLOSED', count(*) FILTER (WHERE status = 'CLOSED'),
      'urgentActive', count(*) FILTER (WHERE priority = 'URGENT' AND status IN ('OPEN','WAITING_ON_SCHOOL')),
      'unassignedActive', count(*) FILTER (WHERE assignee_principal_id IS NULL AND status IN ('OPEN','WAITING_ON_SCHOOL')))
      FROM hon.hq_support_cases WHERE p_organization IS NULL OR organization_id = p_organization),
    'viewer', hon.hq_support_person_json(actor), 'asOf', hon.saas_ts(at));
  PERFORM hon.require_hq_support_actor(p_subject);
  RETURN result;
END $$;

CREATE FUNCTION hon.read_hq_support_case(p_subject text, p_case uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; c hon.hq_support_cases%ROWTYPE; result jsonb;
BEGIN
  actor := hon.require_hq_support_actor(p_subject);
  IF p_case IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO c FROM hon.hq_support_cases WHERE id = p_case;
  IF c.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  result := jsonb_build_object('case', hon.hq_support_case_json(c),
    'events', (SELECT coalesce(jsonb_agg(hon.hq_support_event_json(e) ORDER BY e.seq), '[]'::jsonb) FROM hon.hq_support_case_events e WHERE e.case_id = c.id),
    'assignees', hon.hq_support_assignees_json(), 'viewer', hon.hq_support_person_json(actor), 'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_support_actor(p_subject);
  RETURN result;
END $$;

-- The customers a case can be opened for: every school with its organization (names and ids only), for the support team,
-- which may not hold the HQ school-directory permission. At most 2,000 schools; `truncated` says when more exist.
CREATE FUNCTION hon.read_hq_support_schools(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; result jsonb; total integer;
BEGIN
  actor := hon.require_hq_support_actor(p_subject);
  SELECT count(*) INTO total FROM hon.schools;
  SELECT jsonb_build_object('schools', coalesce(jsonb_agg(jsonb_build_object('schoolId', x.sid, 'schoolDisplayName', x.sname,
      'organizationId', x.oid, 'organizationDisplayName', x.oname) ORDER BY x.oname, x.oid, x.sname, x.sid), '[]'::jsonb),
    'truncated', total > 2000, 'asOf', hon.saas_ts(clock_timestamp()))
  INTO result
  FROM (SELECT s.id AS sid, left(s.name, 300) AS sname, o.id AS oid, left(o.display_name, 300) AS oname
    FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id ORDER BY o.display_name, o.id, s.name, s.id LIMIT 2000) x;
  PERFORM hon.require_hq_support_actor(p_subject);
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_hq_support_case()','guard_hq_support_evidence()','hq_support_principal_eligible(uuid)','require_hq_support_actor(text)',
    'hq_support_person_json(uuid)','hq_support_case_json(hon.hq_support_cases)','hq_support_event_json(hon.hq_support_case_events)','hq_support_assignees_json()',
    'hq_support_claim(uuid,uuid,text,text)','hq_support_text(jsonb,text,integer,integer)','hq_support_lock_case(uuid,integer)','hq_support_expected(jsonb)',
    'open_hq_support_case(text,jsonb,uuid)','add_hq_support_note(text,uuid,jsonb,uuid)','change_hq_support_case(text,uuid,jsonb,uuid)',
    'read_hq_support_cases(text,text,uuid,timestamptz,uuid,integer)','read_hq_support_case(text,uuid)','read_hq_support_schools(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.open_hq_support_case(text,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.add_hq_support_note(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.change_hq_support_case(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_support_cases(text,text,uuid,timestamptz,uuid,integer) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_support_case(text,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_support_schools(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
