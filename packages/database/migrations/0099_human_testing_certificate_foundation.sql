BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Testing certificate migration requires a trusted migration owner';
  END IF;
END;
$$;

-- A school-issued certificate is an internal, immutable human record. It is not
-- a legal credential, provider document, delivery request, or rank/promotion command.
INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable) VALUES
  ('testing.certificate.read', 'Read a known current-school internal testing certificate projection', true, true),
  ('testing.certificate.issue', 'Deliberately issue a known eligible internal testing certificate', true, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, p.code
FROM hon.roles AS r
JOIN hon.permissions AS p ON p.code IN ('testing.certificate.read', 'testing.certificate.issue')
WHERE r.is_system_role AND r.code = 'OWNER'
ON CONFLICT DO NOTHING;

-- This exact identity key lets a certificate bind all candidate references in
-- one composite FK instead of trusting independently supplied identifiers.
ALTER TABLE hon.testing_candidates
  ADD CONSTRAINT testing_candidates_certificate_identity_key
  UNIQUE (id, student_curriculum_enrollment_id, target_rank_id, organization_id, school_id);

CREATE FUNCTION hon.testing_certificate_safe_text(p_value text, p_maximum integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, hon
AS $$
  SELECT p_value IS NOT NULL
    AND p_maximum BETWEEN 1 AND 200
    AND length(p_value) BETWEEN 1 AND p_maximum
    AND btrim(p_value) = p_value
    AND p_value !~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF<>\\[\\]{}=`$]'
    AND position('<' IN p_value) = 0 AND position('>' IN p_value) = 0
    AND position('[' IN p_value) = 0 AND position(']' IN p_value) = 0
    AND position('{' IN p_value) = 0 AND position('}' IN p_value) = 0
    AND position('=' IN p_value) = 0 AND position('`' IN p_value) = 0 AND position('$' IN p_value) = 0
    AND p_value !~* 'https?:|www\\.|\\y(javascript|eval|function|script|automatic|automated|guaranteed|guarantee|legal|credential|license|certified)\\y';
$$;

CREATE TABLE hon.testing_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  testing_candidate_id uuid NOT NULL,
  student_curriculum_enrollment_id uuid NOT NULL,
  curriculum_id uuid NOT NULL,
  target_rank_id uuid NOT NULL,
  -- Only a validated snapshot is ever returned as a rank name by this slice.
  target_rank_name text NOT NULL CHECK (hon.testing_certificate_safe_text(target_rank_name, 120)),
  title text NOT NULL CHECK (hon.testing_certificate_safe_text(title, 120)),
  issued_at timestamptz NOT NULL,
  issued_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status = 'ISSUED'),
  version integer NOT NULL DEFAULT 1 CHECK (version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (testing_candidate_id, student_curriculum_enrollment_id, target_rank_id, organization_id, school_id)
    REFERENCES hon.testing_candidates(id, student_curriculum_enrollment_id, target_rank_id, organization_id, school_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (student_curriculum_enrollment_id, curriculum_id, organization_id, school_id)
    REFERENCES hon.student_curriculum_enrollments(id, curriculum_id, organization_id, school_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (target_rank_id, curriculum_id, organization_id, school_id)
    REFERENCES hon.curriculum_ranks(id, curriculum_id, organization_id, school_id)
    ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (testing_candidate_id)
);

CREATE TABLE hon.testing_certificate_requests (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200 AND btrim(idempotency_key) = idempotency_key AND idempotency_key !~ '[[:cntrl:]]'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  certificate_id uuid NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, school_id, principal_id, idempotency_key),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (certificate_id, organization_id, school_id)
    REFERENCES hon.testing_certificates(id, organization_id, school_id) ON DELETE RESTRICT
);

-- Deliberately not hon.outbox_events: no dispatcher, provider, notification,
-- delivery, belt fulfillment, Action Engine, or automation consumer can claim it.
CREATE TABLE hon.testing_certificate_outbox (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  certificate_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'INERT' CHECK (status = 'INERT'),
  execution_allowed boolean NOT NULL DEFAULT false CHECK (NOT execution_allowed),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (certificate_id, organization_id, school_id)
    REFERENCES hon.testing_certificates(id, organization_id, school_id) ON DELETE RESTRICT
);

CREATE INDEX testing_certificates_scope_candidate_idx
  ON hon.testing_certificates(organization_id, school_id, testing_candidate_id);

CREATE FUNCTION hon.guard_testing_certificate_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, hon
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_TESTING_CERTIFICATE_HISTORY' USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION hon.testing_certificate_permission(
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
  SELECT p_permission IN ('testing.certificate.read', 'testing.certificate.issue')
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

CREATE FUNCTION hon.resolve_testing_certificate_scope(
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
      hon.testing_certificate_permission(p.id, g.organization_id, g.school_id, 'testing.certificate.read')
      OR hon.testing_certificate_permission(p.id, g.organization_id, g.school_id, 'testing.certificate.issue')
    );
$$;

CREATE FUNCTION hon.require_testing_certificate_actor(
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
    OR p_permission NOT IN ('testing.certificate.read', 'testing.certificate.issue')
    OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'HUMAN_CERTIFICATE_COMMAND_REQUIRED' USING ERRCODE = '42501';
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
    OR NOT hon.testing_certificate_permission(v_actor, hon.current_organization_id(), hon.current_school_id(), p_permission) THEN
    RAISE EXCEPTION 'TESTING_CERTIFICATE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN v_actor;
END;
$$;

CREATE FUNCTION hon.lock_testing_certificate_actor(
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
  IF NOT FOUND THEN RAISE EXCEPTION 'TESTING_CERTIFICATE_FORBIDDEN' USING ERRCODE = '42501'; END IF;

  v_actor := hon.require_testing_certificate_actor(p_external_subject, p_permission);
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

  RETURN hon.require_testing_certificate_actor(p_external_subject, p_permission);
END;
$$;

CREATE FUNCTION hon.testing_certificate_projection(p_testing_candidate_id uuid)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT jsonb_build_object(
    'testingCandidateId', c.id,
    'targetRankId', c.target_rank_id,
    'candidateVersion', c.version,
    'status', CASE WHEN certificate.id IS NULL THEN 'ELIGIBLE_TO_ISSUE' ELSE 'ISSUED' END,
    'certificate', CASE WHEN certificate.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', certificate.id,
      'targetRankId', certificate.target_rank_id,
      'targetRankName', certificate.target_rank_name,
      'title', certificate.title,
      'issuedAt', certificate.issued_at,
      'version', certificate.version,
      'status', certificate.status
    ) END
  )
  FROM hon.testing_candidates AS c
  JOIN hon.promotion_decisions AS d
    ON d.testing_candidate_id = c.id
   AND d.organization_id = c.organization_id
   AND d.school_id = c.school_id
   AND d.student_curriculum_enrollment_id = c.student_curriculum_enrollment_id
   AND d.target_rank_id = c.target_rank_id
   AND d.status = 'PROMOTED'
  LEFT JOIN hon.testing_certificates AS certificate
    ON certificate.testing_candidate_id = c.id
   AND certificate.organization_id = c.organization_id
   AND certificate.school_id = c.school_id
  WHERE c.id = p_testing_candidate_id
    AND c.organization_id = hon.current_organization_id()
    AND c.school_id = hon.current_school_id()
    AND c.result = 'PASSED';
$$;

CREATE FUNCTION hon.guard_testing_certificate_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
BEGIN
  IF NEW.status <> 'ISSUED' OR NEW.version <> 1
    OR NEW.issued_by_principal_id IS DISTINCT FROM v_actor
    OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL
    OR NOT hon.testing_certificate_permission(v_actor, NEW.organization_id, NEW.school_id, 'testing.certificate.issue')
    OR NOT EXISTS (
      SELECT 1
      FROM hon.testing_candidates AS c
      JOIN hon.promotion_decisions AS d
        ON d.testing_candidate_id = c.id
       AND d.organization_id = c.organization_id
       AND d.school_id = c.school_id
       AND d.student_curriculum_enrollment_id = c.student_curriculum_enrollment_id
       AND d.target_rank_id = c.target_rank_id
      WHERE c.id = NEW.testing_candidate_id
        AND c.organization_id = NEW.organization_id
        AND c.school_id = NEW.school_id
        AND c.student_curriculum_enrollment_id = NEW.student_curriculum_enrollment_id
        AND c.target_rank_id = NEW.target_rank_id
        AND c.result = 'PASSED'
        AND d.status = 'PROMOTED'
    ) THEN
    RAISE EXCEPTION 'TESTING_CERTIFICATE_PREREQUISITE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION hon.guard_testing_certificate_dependency()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_candidate_id uuid;
  v_candidate_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_TABLE_NAME = 'testing_candidates' THEN
    v_candidate_ids := ARRAY[OLD.id, NEW.id];
  ELSE
    v_candidate_ids := ARRAY[OLD.testing_candidate_id, NEW.testing_candidate_id];
  END IF;

  FOREACH v_candidate_id IN ARRAY v_candidate_ids LOOP
    IF v_candidate_id IS NULL THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM hon.testing_certificates WHERE testing_candidate_id = v_candidate_id)
      AND NOT EXISTS (
        SELECT 1
        FROM hon.testing_candidates AS c
        JOIN hon.promotion_decisions AS d
          ON d.testing_candidate_id = c.id
         AND d.organization_id = c.organization_id
         AND d.school_id = c.school_id
         AND d.student_curriculum_enrollment_id = c.student_curriculum_enrollment_id
         AND d.target_rank_id = c.target_rank_id
        WHERE c.id = v_candidate_id AND c.result = 'PASSED' AND d.status = 'PROMOTED'
      ) THEN
      RAISE EXCEPTION 'TESTING_CERTIFICATE_PREREQUISITE_REQUIRED' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION hon.guard_testing_certificate_promotion_delete()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hon.testing_certificates WHERE testing_candidate_id = OLD.testing_candidate_id) THEN
    RAISE EXCEPTION 'TESTING_CERTIFICATE_PREREQUISITE_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER testing_certificate_insert_guard
BEFORE INSERT ON hon.testing_certificates
FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_certificate_insert();
CREATE CONSTRAINT TRIGGER testing_certificate_candidate_dependency
AFTER UPDATE OF result, student_curriculum_enrollment_id, target_rank_id, organization_id, school_id ON hon.testing_candidates
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_certificate_dependency();
CREATE CONSTRAINT TRIGGER testing_certificate_promotion_dependency
AFTER UPDATE OF status, testing_candidate_id, student_curriculum_enrollment_id, target_rank_id, organization_id, school_id ON hon.promotion_decisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_certificate_dependency();
CREATE TRIGGER testing_certificate_promotion_delete_guard
BEFORE DELETE ON hon.promotion_decisions
FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_certificate_promotion_delete();

CREATE FUNCTION hon.read_testing_certificate(
  p_external_subject text,
  p_testing_candidate_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_testing_candidate_id IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023'; END IF;
  PERFORM hon.lock_testing_certificate_actor(p_external_subject, 'testing.certificate.read', false);
  v_result := hon.testing_certificate_projection(p_testing_candidate_id);
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'TESTING_CERTIFICATE_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  PERFORM hon.require_testing_certificate_actor(p_external_subject, 'testing.certificate.read');
  RETURN v_result;
END;
$$;

CREATE FUNCTION hon.issue_testing_certificate(
  p_external_subject text,
  p_testing_candidate_id uuid,
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
  v_enrollment hon.student_curriculum_enrollments%ROWTYPE;
  v_rank hon.curriculum_ranks%ROWTYPE;
  v_decision hon.promotion_decisions%ROWTYPE;
  v_certificate hon.testing_certificates%ROWTYPE;
  v_previous hon.testing_certificate_requests%ROWTYPE;
  v_fingerprint text;
  v_projection jsonb;
BEGIN
  IF p_testing_candidate_id IS NULL
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_input)) <> 3
    OR NOT (p_input ?& ARRAY['expectedCandidateVersion', 'expectedCertificateVersion', 'title'])
    OR jsonb_typeof(p_input->'expectedCandidateVersion') IS DISTINCT FROM 'number'
    OR p_input->>'expectedCandidateVersion' !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'expectedCertificateVersion') IS DISTINCT FROM 'number'
    OR p_input->>'expectedCertificateVersion' <> '0'
    OR jsonb_typeof(p_input->'title') IS DISTINCT FROM 'string'
    OR NOT hon.testing_certificate_safe_text(p_input->>'title', 120)
    OR p_idempotency_key IS NULL
    OR length(p_idempotency_key) NOT BETWEEN 1 AND 200
    OR btrim(p_idempotency_key) <> p_idempotency_key
    OR p_idempotency_key ~ '[[:cntrl:]]'
    OR p_request_id IS NULL
    OR p_correlation_id IS NULL
    OR p_request_id::text IS DISTINCT FROM current_setting('app.hon_request_id', true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;

  v_actor := hon.lock_testing_certificate_actor(p_external_subject, 'testing.certificate.issue', true);
  SELECT * INTO v_candidate
  FROM hon.testing_candidates
  WHERE id = p_testing_candidate_id AND organization_id = v_organization_id AND school_id = v_school_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TESTING_CERTIFICATE_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO v_enrollment
  FROM hon.student_curriculum_enrollments
  WHERE id = v_candidate.student_curriculum_enrollment_id
    AND organization_id = v_organization_id AND school_id = v_school_id
  FOR SHARE;
  SELECT * INTO v_rank
  FROM hon.curriculum_ranks
  WHERE id = v_candidate.target_rank_id AND curriculum_id = v_enrollment.curriculum_id
    AND organization_id = v_organization_id AND school_id = v_school_id
  FOR SHARE;
  SELECT * INTO v_decision
  FROM hon.promotion_decisions
  WHERE testing_candidate_id = v_candidate.id
    AND student_curriculum_enrollment_id = v_candidate.student_curriculum_enrollment_id
    AND target_rank_id = v_candidate.target_rank_id
    AND organization_id = v_organization_id AND school_id = v_school_id
  FOR SHARE;
  IF NOT FOUND OR v_candidate.result <> 'PASSED' OR v_decision.status <> 'PROMOTED'
    OR v_enrollment.id IS NULL OR v_rank.id IS NULL
    OR NOT hon.testing_certificate_safe_text(v_rank.name, 120) THEN
    RAISE EXCEPTION 'TESTING_CERTIFICATE_PREREQUISITE_REQUIRED' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'testingCandidateId', p_testing_candidate_id,
    'input', p_input
  )::text, 'UTF8')), 'hex');
  SELECT * INTO v_previous
  FROM hon.testing_certificate_requests
  WHERE organization_id = v_organization_id AND school_id = v_school_id
    AND principal_id = v_actor AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_previous.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505';
    END IF;
    v_projection := hon.testing_certificate_projection(p_testing_candidate_id);
    IF v_projection IS NULL OR v_projection->'certificate' IS NULL THEN
      RAISE EXCEPTION 'TESTING_CERTIFICATE_UNAVAILABLE' USING ERRCODE = 'P0002';
    END IF;
    PERFORM hon.require_testing_certificate_actor(p_external_subject, 'testing.certificate.issue');
    RETURN jsonb_build_object('certificate', v_projection->'certificate', 'replayed', true);
  END IF;

  IF v_candidate.version <> (p_input->>'expectedCandidateVersion')::integer THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_certificate
  FROM hon.testing_certificates
  WHERE testing_candidate_id = v_candidate.id
  FOR KEY SHARE;
  IF FOUND THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;

  INSERT INTO hon.testing_certificates(
    organization_id, school_id, testing_candidate_id, student_curriculum_enrollment_id,
    curriculum_id, target_rank_id, target_rank_name, title, issued_at, issued_by_principal_id
  ) VALUES (
    v_organization_id, v_school_id, v_candidate.id, v_candidate.student_curriculum_enrollment_id,
    v_enrollment.curriculum_id, v_candidate.target_rank_id, v_rank.name, p_input->>'title', clock_timestamp(), v_actor
  ) RETURNING * INTO v_certificate;

  v_projection := hon.testing_certificate_projection(v_candidate.id);
  INSERT INTO hon.audit_events(
    organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
    prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
  ) VALUES (
    v_organization_id, v_school_id, v_actor, 'HUMAN_UI', 'testing.certificate.issue', 'TESTING_CERTIFICATE', v_certificate.id,
    NULL, v_projection->'certificate', 'SUCCEEDED', p_request_id, p_correlation_id, NULL, clock_timestamp()
  );
  INSERT INTO hon.testing_certificate_outbox(organization_id, school_id, certificate_id)
  VALUES (v_organization_id, v_school_id, v_certificate.id);
  INSERT INTO hon.testing_certificate_requests(
    organization_id, school_id, principal_id, idempotency_key, fingerprint, certificate_id, request_id
  ) VALUES (
    v_organization_id, v_school_id, v_actor, p_idempotency_key, v_fingerprint, v_certificate.id, p_request_id
  );

  PERFORM hon.require_testing_certificate_actor(p_external_subject, 'testing.certificate.issue');
  RETURN jsonb_build_object('certificate', v_projection->'certificate', 'replayed', false);
END;
$$;

COMMENT ON FUNCTION hon.issue_testing_certificate(text, uuid, jsonb, text, uuid, uuid) IS
  'Deliberate internal school-issued certificate only: requires a current PASSED candidate and PROMOTED decision; never grades, promotes, changes rank, attendance or billing, invokes AI/automation/Action Engine/provider, or sends/delivers a document.';

DO $$
DECLARE
  v_table text;
  v_role text;
  v_column text;
  v_function record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['testing_certificates', 'testing_certificate_requests', 'testing_certificate_outbox'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', v_table);
    EXECUTE format('CREATE TRIGGER testing_certificate_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_testing_certificate_history()', v_table);
    EXECUTE format('CREATE TRIGGER testing_certificate_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_testing_certificate_history()', v_table);
    FOR v_column IN SELECT attname FROM pg_attribute WHERE attrelid = format('hon.%I', v_table)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC', v_column, v_table);
    END LOOP;
  END LOOP;

  FOR v_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'hon' AND p.proname LIKE '%testing_certificate%'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_function.signature);
  END LOOP;

  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime', 'anon', 'authenticated', 'service_role') LOOP
    FOREACH v_table IN ARRAY ARRAY['testing_certificates', 'testing_certificate_requests', 'testing_certificate_outbox'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', v_table, v_role);
      FOR v_column IN SELECT attname FROM pg_attribute WHERE attrelid = format('hon.%I', v_table)::regclass AND attnum > 0 AND NOT attisdropped LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I', v_column, v_table, v_role);
      END LOOP;
    END LOOP;
    FOR v_function IN
      SELECT p.oid::regprocedure AS signature
      FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'hon' AND p.proname LIKE '%testing_certificate%'
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_function.signature, v_role);
    END LOOP;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION
      hon.resolve_testing_certificate_scope(text, uuid),
      hon.read_testing_certificate(text, uuid),
      hon.issue_testing_certificate(text, uuid, jsonb, text, uuid, uuid)
    TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
