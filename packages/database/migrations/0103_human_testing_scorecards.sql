BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Testing scorecard migration requires a trusted migration owner';
  END IF;
END;
$$;

-- Scorecard evaluations are independently attributable internal observations. They
-- are deliberately not grades, decisions, readiness predictions, or a replacement
-- for the existing direct human candidate-grade and promotion commands.
INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable) VALUES
  ('testing.scorecard.read', 'Read a known current-school testing scorecard projection', true, true),
  ('testing.scorecard.record', 'Record a bounded independent evaluation on a known testing candidate and event', true, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, p.code
FROM hon.roles AS r
JOIN hon.permissions AS p ON p.code IN ('testing.scorecard.read', 'testing.scorecard.record')
WHERE r.is_system_role AND r.code = 'OWNER'
ON CONFLICT DO NOTHING;

-- A candidate belongs to exactly one testing event. The composite key prevents a
-- scorecard from joining a valid candidate to another same-school event.
ALTER TABLE hon.testing_candidates
  ADD CONSTRAINT testing_candidates_scorecard_identity_key
  UNIQUE (id, testing_event_id, organization_id, school_id);

CREATE FUNCTION hon.testing_scorecard_safe_criterion(p_value text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, hon
AS $$
  SELECT p_value IS NOT NULL
    AND length(p_value) BETWEEN 1 AND 64
    AND p_value = upper(p_value)
    AND p_value ~ '^[A-Z][A-Z0-9_.-]{0,63}$';
$$;

CREATE TABLE hon.testing_scorecards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  testing_candidate_id uuid NOT NULL,
  testing_event_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (testing_candidate_id, testing_event_id, organization_id, school_id)
    REFERENCES hon.testing_candidates(id, testing_event_id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id, testing_candidate_id, testing_event_id),
  UNIQUE (testing_candidate_id)
);

CREATE TABLE hon.testing_scorecard_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  testing_scorecard_id uuid NOT NULL,
  testing_candidate_id uuid NOT NULL,
  testing_event_id uuid NOT NULL,
  criterion_code text NOT NULL CHECK (hon.testing_scorecard_safe_criterion(criterion_code)),
  assessment text NOT NULL CHECK (assessment IN ('OBSERVED', 'NOT_OBSERVED', 'NEEDS_FOLLOW_UP')),
  evaluator_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  scorecard_version integer NOT NULL CHECK (scorecard_version BETWEEN 1 AND 999999999),
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (testing_scorecard_id, organization_id, school_id, testing_candidate_id, testing_event_id)
    REFERENCES hon.testing_scorecards(id, organization_id, school_id, testing_candidate_id, testing_event_id)
    ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  -- Different qualified examiners may independently record the same criterion.
  -- A single examiner never overwrites their own historical observation.
  UNIQUE (testing_scorecard_id, evaluator_principal_id, criterion_code)
);

CREATE TABLE hon.testing_scorecard_requests (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200 AND btrim(idempotency_key) = idempotency_key AND idempotency_key !~ '[[:cntrl:]]'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, school_id, principal_id, idempotency_key),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

-- The evidence row is intentionally separate from the dispatchable global outbox.
-- No consumer, provider, Action Engine task, notification, or parent mutation can
-- execute it; the constraint makes that posture durable in the database.
CREATE TABLE hon.testing_scorecard_outbox (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  testing_scorecard_evaluation_id uuid PRIMARY KEY,
  event_type text NOT NULL DEFAULT 'testing.scorecard.evaluation.recorded'
    CHECK (event_type = 'testing.scorecard.evaluation.recorded'),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  aggregate_version integer NOT NULL CHECK (aggregate_version BETWEEN 1 AND 999999999),
  status text NOT NULL DEFAULT 'INERT' CHECK (status = 'INERT'),
  execution_allowed boolean NOT NULL DEFAULT false CHECK (NOT execution_allowed),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (testing_scorecard_evaluation_id, organization_id, school_id)
    REFERENCES hon.testing_scorecard_evaluations(id, organization_id, school_id) ON DELETE RESTRICT
);

CREATE INDEX testing_scorecard_evaluations_scope_idx
  ON hon.testing_scorecard_evaluations(organization_id, school_id, testing_scorecard_id, recorded_at, id);

CREATE FUNCTION hon.testing_scorecard_permission(
  p_actor uuid,
  p_organization_id uuid,
  p_school_id uuid,
  p_permission text
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT p_permission IN ('testing.scorecard.read', 'testing.scorecard.record')
    AND EXISTS (
      SELECT 1
      FROM hon.principals AS p
      JOIN hon.users AS u ON u.id = p.user_id
      JOIN hon.principal_role_grants AS g ON g.principal_id = p.id
      JOIN hon.roles AS r ON r.id = g.role_id AND r.organization_id = g.organization_id
      JOIN hon.role_permissions AS rp ON rp.role_id = r.id AND rp.organization_id = r.organization_id
      JOIN hon.schools AS s ON s.id = g.school_id AND s.organization_id = g.organization_id
      JOIN hon.organizations AS o ON o.id = s.organization_id
      WHERE p.id = p_actor
        AND p.principal_type = 'HUMAN_USER'
        AND p.is_active
        AND (SELECT count(*) FROM hon.principals AS same_user
             WHERE same_user.user_id = u.id AND same_user.principal_type = 'HUMAN_USER' AND same_user.is_active) = 1
        AND g.organization_id = p_organization_id
        AND g.school_id = p_school_id
        AND g.revoked_at IS NULL
        AND g.effective_from <= clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND s.status = 'ACTIVE'
        AND o.status = 'ACTIVE'
        AND (r.management_school_id IS NULL OR r.management_school_id = s.id)
        AND r.code !~* '(^|_)(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON|PLATFORM|SYSTEM)(_|$)'
        AND rp.permission_code = p_permission
    )
    AND EXISTS (
      SELECT 1
      FROM hon.organization_entitlements AS e
      WHERE e.organization_id = p_organization_id
        AND e.tier IN ('ESSENTIAL', 'CORE', 'COMPLETE')
        AND e.status = 'ACTIVE'
        AND e.effective_from <= clock_timestamp()
        AND (e.effective_until IS NULL OR e.effective_until > clock_timestamp())
    );
$$;

CREATE FUNCTION hon.resolve_testing_scorecard_scope(
  p_external_subject text,
  p_school_id uuid
)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT DISTINCT p.id, g.organization_id, g.school_id
  FROM hon.users AS u
  JOIN hon.principals AS p ON p.user_id = u.id
  JOIN hon.principal_role_grants AS g ON g.principal_id = p.id AND g.school_id = p_school_id
  WHERE p_external_subject IS NOT NULL
    AND length(p_external_subject) BETWEEN 1 AND 200
    AND p.principal_type = 'HUMAN_USER'
    AND p.is_active
    AND (SELECT count(*) FROM hon.principals AS same_user
         WHERE same_user.user_id = u.id AND same_user.principal_type = 'HUMAN_USER' AND same_user.is_active) = 1
    AND u.external_subject = p_external_subject
    AND (
      hon.testing_scorecard_permission(p.id, g.organization_id, g.school_id, 'testing.scorecard.read')
      OR hon.testing_scorecard_permission(p.id, g.organization_id, g.school_id, 'testing.scorecard.record')
    );
$$;

CREATE FUNCTION hon.require_testing_scorecard_actor(
  p_external_subject text,
  p_permission text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid;
BEGIN
  IF p_external_subject IS NULL OR length(p_external_subject) NOT BETWEEN 1 AND 200
    OR p_permission NOT IN ('testing.scorecard.read', 'testing.scorecard.record')
    OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'HUMAN_SCORECARD_COMMAND_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT p.id INTO v_actor
  FROM hon.principals AS p
  JOIN hon.users AS u ON u.id = p.user_id
  WHERE u.external_subject = p_external_subject
    AND p.id::text = current_setting('app.hon_principal_id', true)
    AND p.principal_type = 'HUMAN_USER'
    AND p.is_active
    AND (SELECT count(*) FROM hon.principals AS same_user
         WHERE same_user.user_id = u.id AND same_user.principal_type = 'HUMAN_USER' AND same_user.is_active) = 1;

  IF v_actor IS NULL
    OR NOT hon.testing_scorecard_permission(v_actor, hon.current_organization_id(), hon.current_school_id(), p_permission) THEN
    RAISE EXCEPTION 'TESTING_SCORECARD_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_actor;
END;
$$;

CREATE FUNCTION hon.lock_testing_scorecard_actor(
  p_external_subject text,
  p_permission text,
  p_writing boolean
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid;
  v_organization_id uuid := hon.current_organization_id();
  v_school_id uuid := hon.current_school_id();
BEGIN
  IF p_writing THEN
    PERFORM 1 FROM hon.organizations WHERE id = v_organization_id AND status = 'ACTIVE' FOR UPDATE;
    PERFORM 1 FROM hon.schools WHERE id = v_school_id AND organization_id = v_organization_id AND status = 'ACTIVE' FOR UPDATE;
  ELSE
    PERFORM 1 FROM hon.organizations WHERE id = v_organization_id AND status = 'ACTIVE' FOR SHARE;
    PERFORM 1 FROM hon.schools WHERE id = v_school_id AND organization_id = v_organization_id AND status = 'ACTIVE' FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'TESTING_SCORECARD_FORBIDDEN' USING ERRCODE = '42501'; END IF;

  v_actor := hon.require_testing_scorecard_actor(p_external_subject, p_permission);
  IF p_writing THEN
    PERFORM 1 FROM hon.users WHERE id IN (SELECT user_id FROM hon.principals WHERE id = v_actor) FOR UPDATE;
    PERFORM 1 FROM hon.principals WHERE id = v_actor FOR UPDATE;
    PERFORM 1 FROM hon.principal_role_grants WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id ORDER BY id FOR UPDATE;
  ELSE
    PERFORM 1 FROM hon.users WHERE id IN (SELECT user_id FROM hon.principals WHERE id = v_actor) FOR SHARE;
    PERFORM 1 FROM hon.principals WHERE id = v_actor FOR SHARE;
    PERFORM 1 FROM hon.principal_role_grants WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id ORDER BY id FOR SHARE;
  END IF;
  PERFORM 1 FROM hon.roles WHERE id IN (
    SELECT role_id FROM hon.principal_role_grants
    WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id
  ) ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.role_permissions WHERE role_id IN (
    SELECT role_id FROM hon.principal_role_grants
    WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id
  ) ORDER BY role_id, permission_code FOR SHARE;
  PERFORM 1 FROM hon.organization_entitlements WHERE organization_id = v_organization_id FOR SHARE;

  RETURN hon.require_testing_scorecard_actor(p_external_subject, p_permission);
END;
$$;

CREATE FUNCTION hon.testing_scorecard_projection(
  p_testing_candidate_id uuid,
  p_testing_event_id uuid,
  p_actor uuid
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT jsonb_build_object(
    'testingCandidateId', c.id,
    'testingEventId', e.id,
    'candidateVersion', c.version,
    'testingEventVersion', e.version,
    'scorecardId', s.id,
    'scorecardVersion', coalesce(s.version, 0),
    'evaluations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', ev.id,
        'criterionCode', ev.criterion_code,
        'assessment', ev.assessment,
        'recordedAt', ev.recorded_at,
        'version', ev.version,
        'recordedByYou', ev.evaluator_principal_id = p_actor
      ) ORDER BY ev.recorded_at, ev.id)
      FROM (
        SELECT *
        FROM hon.testing_scorecard_evaluations AS bounded
        WHERE bounded.testing_scorecard_id = s.id
          AND bounded.organization_id = c.organization_id
          AND bounded.school_id = c.school_id
        ORDER BY bounded.recorded_at, bounded.id
        LIMIT 100
      ) AS ev
    ), '[]'::jsonb),
    'evaluationsLimited', EXISTS (
      SELECT 1
      FROM hon.testing_scorecard_evaluations AS overflow
      WHERE overflow.testing_scorecard_id = s.id
        AND overflow.organization_id = c.organization_id
        AND overflow.school_id = c.school_id
      OFFSET 100
    )
  )
  FROM hon.testing_candidates AS c
  JOIN hon.testing_events AS e
    ON e.id = c.testing_event_id
   AND e.organization_id = c.organization_id
   AND e.school_id = c.school_id
  LEFT JOIN hon.testing_scorecards AS s
    ON s.testing_candidate_id = c.id
   AND s.testing_event_id = e.id
   AND s.organization_id = c.organization_id
   AND s.school_id = c.school_id
  WHERE c.id = p_testing_candidate_id
    AND e.id = p_testing_event_id
    AND c.organization_id = hon.current_organization_id()
    AND c.school_id = hon.current_school_id();
$$;

CREATE FUNCTION hon.guard_testing_scorecard_root()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'IMMUTABLE_TESTING_SCORECARD_ROOT' USING ERRCODE = '42501';
  END IF;
  IF current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL
    OR NOT hon.testing_scorecard_permission(v_actor, NEW.organization_id, NEW.school_id, 'testing.scorecard.record') THEN
    RAISE EXCEPTION 'TESTING_SCORECARD_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.created_at IS NULL OR NEW.updated_at IS NULL THEN
      RAISE EXCEPTION 'INVALID_TESTING_SCORECARD_ROOT' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.id <> OLD.id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.school_id <> OLD.school_id
    OR NEW.testing_candidate_id <> OLD.testing_candidate_id
    OR NEW.testing_event_id <> OLD.testing_event_id
    OR NEW.created_at <> OLD.created_at
    OR NEW.version <> OLD.version + 1
    OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'IMMUTABLE_TESTING_SCORECARD_ROOT' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION hon.guard_testing_scorecard_evaluation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  v_scorecard hon.testing_scorecards%ROWTYPE;
BEGIN
  IF current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL
    OR NEW.evaluator_principal_id IS DISTINCT FROM v_actor
    OR NEW.version <> 1
    OR NOT hon.testing_scorecard_permission(v_actor, NEW.organization_id, NEW.school_id, 'testing.scorecard.record') THEN
    RAISE EXCEPTION 'TESTING_SCORECARD_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_scorecard
  FROM hon.testing_scorecards
  WHERE id = NEW.testing_scorecard_id
    AND organization_id = NEW.organization_id
    AND school_id = NEW.school_id
    AND testing_candidate_id = NEW.testing_candidate_id
    AND testing_event_id = NEW.testing_event_id
  FOR SHARE;
  IF v_scorecard.id IS NULL OR NEW.scorecard_version <> v_scorecard.version THEN
    RAISE EXCEPTION 'INVALID_TESTING_SCORECARD_EVALUATION' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION hon.guard_testing_scorecard_history()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, hon
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_TESTING_SCORECARD_HISTORY' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER testing_scorecard_root_guard
BEFORE INSERT OR UPDATE OR DELETE ON hon.testing_scorecards
FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_scorecard_root();
CREATE TRIGGER testing_scorecard_root_no_truncate
BEFORE TRUNCATE ON hon.testing_scorecards
FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_testing_scorecard_root();
CREATE TRIGGER testing_scorecard_evaluation_insert_guard
BEFORE INSERT ON hon.testing_scorecard_evaluations
FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_scorecard_evaluation();
CREATE TRIGGER testing_scorecard_evaluation_immutable
BEFORE UPDATE OR DELETE ON hon.testing_scorecard_evaluations
FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_scorecard_history();
CREATE TRIGGER testing_scorecard_evaluation_no_truncate
BEFORE TRUNCATE ON hon.testing_scorecard_evaluations
FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_testing_scorecard_history();
CREATE TRIGGER testing_scorecard_request_immutable
BEFORE UPDATE OR DELETE ON hon.testing_scorecard_requests
FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_scorecard_history();
CREATE TRIGGER testing_scorecard_request_no_truncate
BEFORE TRUNCATE ON hon.testing_scorecard_requests
FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_testing_scorecard_history();
CREATE TRIGGER testing_scorecard_outbox_immutable
BEFORE UPDATE OR DELETE ON hon.testing_scorecard_outbox
FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_scorecard_history();
CREATE TRIGGER testing_scorecard_outbox_no_truncate
BEFORE TRUNCATE ON hon.testing_scorecard_outbox
FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_testing_scorecard_history();

CREATE FUNCTION hon.read_testing_scorecard(
  p_external_subject text,
  p_testing_candidate_id uuid,
  p_testing_event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid;
  v_result jsonb;
BEGIN
  IF p_testing_candidate_id IS NULL OR p_testing_event_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;
  v_actor := hon.lock_testing_scorecard_actor(p_external_subject, 'testing.scorecard.read', false);
  v_result := hon.testing_scorecard_projection(p_testing_candidate_id, p_testing_event_id, v_actor);
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'TESTING_SCORECARD_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  PERFORM hon.require_testing_scorecard_actor(p_external_subject, 'testing.scorecard.read');
  RETURN v_result;
END;
$$;

CREATE FUNCTION hon.record_testing_scorecard_evaluation(
  p_external_subject text,
  p_testing_candidate_id uuid,
  p_testing_event_id uuid,
  p_input jsonb,
  p_idempotency_key text,
  p_request_id uuid,
  p_correlation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_organization_id uuid := hon.current_organization_id();
  v_school_id uuid := hon.current_school_id();
  v_actor uuid;
  v_candidate hon.testing_candidates%ROWTYPE;
  v_event hon.testing_events%ROWTYPE;
  v_scorecard hon.testing_scorecards%ROWTYPE;
  v_evaluation hon.testing_scorecard_evaluations%ROWTYPE;
  v_previous hon.testing_scorecard_requests%ROWTYPE;
  v_fingerprint text;
  v_response jsonb;
  v_expected_candidate_version integer;
  v_expected_event_version integer;
  v_expected_scorecard_version integer;
BEGIN
  IF p_testing_candidate_id IS NULL
    OR p_testing_event_id IS NULL
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_input)) <> 5
    OR NOT (p_input ?& ARRAY['criterionCode', 'assessment', 'expectedCandidateVersion', 'expectedTestingEventVersion', 'expectedScorecardVersion'])
    OR jsonb_typeof(p_input->'criterionCode') IS DISTINCT FROM 'string'
    OR NOT hon.testing_scorecard_safe_criterion(p_input->>'criterionCode')
    OR jsonb_typeof(p_input->'assessment') IS DISTINCT FROM 'string'
    OR p_input->>'assessment' NOT IN ('OBSERVED', 'NOT_OBSERVED', 'NEEDS_FOLLOW_UP')
    OR jsonb_typeof(p_input->'expectedCandidateVersion') IS DISTINCT FROM 'number'
    OR p_input->>'expectedCandidateVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'expectedTestingEventVersion') IS DISTINCT FROM 'number'
    OR p_input->>'expectedTestingEventVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'expectedScorecardVersion') IS DISTINCT FROM 'number'
    OR p_input->>'expectedScorecardVersion' !~ '^[0-9][0-9]{0,8}$'
    OR p_idempotency_key IS NULL
    OR length(p_idempotency_key) NOT BETWEEN 1 AND 200
    OR btrim(p_idempotency_key) <> p_idempotency_key
    OR p_idempotency_key ~ '[[:cntrl:]]'
    OR p_request_id IS NULL
    OR p_correlation_id IS NULL
    OR p_request_id::text IS DISTINCT FROM current_setting('app.hon_request_id', true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;

  v_expected_candidate_version := (p_input->>'expectedCandidateVersion')::integer;
  v_expected_event_version := (p_input->>'expectedTestingEventVersion')::integer;
  v_expected_scorecard_version := (p_input->>'expectedScorecardVersion')::integer;
  v_actor := hon.lock_testing_scorecard_actor(p_external_subject, 'testing.scorecard.record', true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_testing_candidate_id::text || ':' || p_testing_event_id::text, 0));

  SELECT * INTO v_candidate
  FROM hon.testing_candidates
  WHERE id = p_testing_candidate_id
    AND testing_event_id = p_testing_event_id
    AND organization_id = v_organization_id
    AND school_id = v_school_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TESTING_SCORECARD_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_event
  FROM hon.testing_events
  WHERE id = p_testing_event_id
    AND organization_id = v_organization_id
    AND school_id = v_school_id
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TESTING_SCORECARD_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'testingCandidateId', p_testing_candidate_id,
    'testingEventId', p_testing_event_id,
    'input', p_input
  )::text, 'UTF8')), 'hex');
  SELECT * INTO v_previous
  FROM hon.testing_scorecard_requests
  WHERE organization_id = v_organization_id
    AND school_id = v_school_id
    AND principal_id = v_actor
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_previous.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505';
    END IF;
    PERFORM hon.require_testing_scorecard_actor(p_external_subject, 'testing.scorecard.record');
    RETURN jsonb_build_object('record', v_previous.response, 'replayed', true);
  END IF;

  IF v_candidate.version <> v_expected_candidate_version
    OR v_event.version <> v_expected_event_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_scorecard
  FROM hon.testing_scorecards
  WHERE testing_candidate_id = p_testing_candidate_id
    AND testing_event_id = p_testing_event_id
    AND organization_id = v_organization_id
    AND school_id = v_school_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF v_expected_scorecard_version <> 0 THEN
      RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001';
    END IF;
    INSERT INTO hon.testing_scorecards(
      organization_id, school_id, testing_candidate_id, testing_event_id
    ) VALUES (
      v_organization_id, v_school_id, p_testing_candidate_id, p_testing_event_id
    ) RETURNING * INTO v_scorecard;
  ELSE
    IF v_scorecard.version <> v_expected_scorecard_version THEN
      RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001';
    END IF;
    UPDATE hon.testing_scorecards
    SET version = version + 1,
        updated_at = clock_timestamp()
    WHERE id = v_scorecard.id
      AND version = v_expected_scorecard_version
    RETURNING * INTO v_scorecard;
    IF NOT FOUND THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  END IF;

  -- Re-check after all locks and waits; neither an Action Engine proposal nor an
  -- automation/integration can convert historical idempotency into authority.
  v_actor := hon.lock_testing_scorecard_actor(p_external_subject, 'testing.scorecard.record', true);
  INSERT INTO hon.testing_scorecard_evaluations(
    organization_id, school_id, testing_scorecard_id, testing_candidate_id, testing_event_id,
    criterion_code, assessment, evaluator_principal_id, scorecard_version
  ) VALUES (
    v_organization_id, v_school_id, v_scorecard.id, p_testing_candidate_id, p_testing_event_id,
    p_input->>'criterionCode', p_input->>'assessment', v_actor, v_scorecard.version
  ) RETURNING * INTO v_evaluation;

  v_response := jsonb_build_object(
    'scorecardId', v_scorecard.id,
    'scorecardVersion', v_scorecard.version,
    'evaluation', jsonb_build_object(
      'id', v_evaluation.id,
      'criterionCode', v_evaluation.criterion_code,
      'assessment', v_evaluation.assessment,
      'recordedAt', v_evaluation.recorded_at,
      'version', v_evaluation.version,
      'recordedByYou', true
    )
  );
  INSERT INTO hon.audit_events(
    organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
  ) VALUES (
    v_organization_id, v_school_id, v_actor, 'HUMAN_UI', 'testing.scorecard.evaluation.record', 'TESTING_SCORECARD_EVALUATION', v_evaluation.id,
    jsonb_build_object('scorecardVersion', CASE WHEN v_scorecard.version = 1 THEN 0 ELSE v_scorecard.version - 1 END),
    jsonb_build_object('testingCandidateId', p_testing_candidate_id, 'testingEventId', p_testing_event_id,
      'scorecardVersion', v_scorecard.version, 'criterionCode', v_evaluation.criterion_code,
      'assessment', v_evaluation.assessment, 'evaluationVersion', v_evaluation.version),
    'SUCCEEDED', p_request_id, p_correlation_id, NULL, clock_timestamp()
  );
  INSERT INTO hon.testing_scorecard_outbox(
    organization_id, school_id, testing_scorecard_evaluation_id, aggregate_version
  ) VALUES (
    v_organization_id, v_school_id, v_evaluation.id, v_scorecard.version
  );
  INSERT INTO hon.testing_scorecard_requests(
    organization_id, school_id, principal_id, idempotency_key, fingerprint, response
  ) VALUES (
    v_organization_id, v_school_id, v_actor, p_idempotency_key, v_fingerprint, v_response
  );

  PERFORM hon.require_testing_scorecard_actor(p_external_subject, 'testing.scorecard.record');
  RETURN jsonb_build_object('record', v_response, 'replayed', false);
END;
$$;

COMMENT ON FUNCTION hon.record_testing_scorecard_evaluation(text, uuid, uuid, jsonb, text, uuid, uuid) IS
  'Human-only bounded internal testing observation. Requires current exact scorecard permission, Essential/Core/Complete entitlement, known matching candidate/event and expected versions; never grades, passes/fails, predicts readiness, promotes, changes rank/belt/certificate/eligibility, invokes Action Engine/AI/automation/provider, charges, messages, lists publicly, or mutates parent data.';

DO $$
DECLARE
  v_table text;
  v_role text;
  v_column text;
  v_function record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['testing_scorecards', 'testing_scorecard_evaluations', 'testing_scorecard_requests', 'testing_scorecard_outbox'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', v_table);
    FOR v_column IN SELECT attname FROM pg_attribute WHERE attrelid = format('hon.%I', v_table)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC', v_column, v_table);
    END LOOP;
  END LOOP;

  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'hon' AND p.proname LIKE '%testing_scorecard%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_function.signature);
  END LOOP;

  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    FOREACH v_table IN ARRAY ARRAY['testing_scorecards', 'testing_scorecard_evaluations', 'testing_scorecard_requests', 'testing_scorecard_outbox'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', v_table, v_role);
      FOR v_column IN SELECT attname FROM pg_attribute WHERE attrelid = format('hon.%I', v_table)::regclass AND attnum > 0 AND NOT attisdropped LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I', v_column, v_table, v_role);
      END LOOP;
    END LOOP;
    FOR v_function IN
      SELECT p.oid::regprocedure AS signature
      FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'hon' AND p.proname LIKE '%testing_scorecard%'
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_function.signature, v_role);
    END LOOP;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION
      hon.resolve_testing_scorecard_scope(text, uuid),
      hon.read_testing_scorecard(text, uuid, uuid),
      hon.record_testing_scorecard_evaluation(text, uuid, uuid, jsonb, text, uuid, uuid)
    TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
