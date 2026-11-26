BEGIN;

-- HQ school lifecycle (owner, 2026-11-24): pause, resume, archive ("Remove") and restore a
-- school from HQ, like agency sub-accounts. Archive records a 30-day erase date; NO erase runs
-- in this migration (a separate, reviewed job). Status only: no billing, provider, message,
-- entitlement or tenant-data effect. Existing school functions already require status='ACTIVE'.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ school lifecycle requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')) THEN
    RAISE EXCEPTION 'HQ school lifecycle requires a restricted runtime';
  END IF;
END $$;

CREATE TABLE hon.hq_school_lifecycle_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (actor_principal_id, idempotency_key),
  CHECK ((status = 'IN_PROGRESS' AND response_body IS NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND response_body IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE TABLE hon.hq_school_lifecycle_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL REFERENCES hon.schools(id) ON DELETE RESTRICT,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL, request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('PAUSE','RESUME','ARCHIVE','RESTORE')),
  prior_state jsonb NOT NULL, next_state jsonb NOT NULL,
  erase_after timestamptz,
  occurred_at timestamptz NOT NULL,
  CHECK ((action_code = 'ARCHIVE') = (erase_after IS NOT NULL)),
  FOREIGN KEY (actor_principal_id, idempotency_key) REFERENCES hon.hq_school_lifecycle_requests(actor_principal_id, idempotency_key) ON DELETE RESTRICT,
  UNIQUE (actor_principal_id, idempotency_key)
);
CREATE INDEX hq_school_lifecycle_audit_school_idx ON hon.hq_school_lifecycle_audit (school_id, occurred_at DESC);
CREATE TABLE hon.hq_school_lifecycle_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL UNIQUE REFERENCES hon.hq_school_lifecycle_audit(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type = 'hq.school.lifecycle.changed'),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  payload jsonb NOT NULL, occurred_at timestamptz NOT NULL
);

CREATE FUNCTION hon.guard_hq_school_lifecycle_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_TABLE_NAME = 'hq_school_lifecycle_requests' AND TG_OP = 'UPDATE' THEN
    IF OLD.status = 'IN_PROGRESS' AND NEW.status = 'COMPLETED'
    AND NEW.response_body IS NOT NULL AND NEW.completed_at IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY['status','response_body','completed_at']) = (to_jsonb(OLD) - ARRAY['status','response_body','completed_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_HQ_SCHOOL_LIFECYCLE_EVIDENCE' USING ERRCODE = '42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_school_lifecycle_requests','hq_school_lifecycle_audit','hq_school_lifecycle_outbox'] LOOP
    EXECUTE format('CREATE TRIGGER hq_school_lifecycle_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_school_lifecycle_evidence()', t);
    EXECUTE format('CREATE TRIGGER hq_school_lifecycle_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_school_lifecycle_evidence()', t);
  END LOOP;
END $$;

-- The API passes only the verified external subject; never an actor UUID. HQ owner, or an
-- HQ operator holding hq.onboarding.manage (the same authority that creates schools).
CREATE FUNCTION hon.require_hq_school_lifecycle_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['app.hon_organization_id','app.hon_school_id','app.hon_family_id',
      'app.hon_principal_id','app.hon_principal_type','app.hon_source','app.hon_action_request_id','app.hon_delegated_by_principal_id']) setting
      WHERE nullif(current_setting(setting, true), '') IS NOT NULL) THEN
    RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (g.hq_role = 'HON_HQ_OWNER' OR (g.hq_role = 'HON_HQ_OPERATOR' AND 'hq.onboarding.manage' = ANY(g.permission_codes))))
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.transition_school_lifecycle_from_hq(
  p_subject text, p_school_id uuid, p_action text, p_expected_status text, p_confirm_name text,
  p_key uuid, p_request_id uuid, p_correlation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; school hon.schools%ROWTYPE; org_prior hon.membership_status; org_next hon.membership_status;
  receipt hon.hq_school_lifecycle_requests%ROWTYPE; fingerprint text; target hon.membership_status;
  effective timestamptz; erase timestamptz; audit_id uuid; prior_fact jsonb; next_fact jsonb; result jsonb;
BEGIN
  IF p_school_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL
    OR p_action IS NULL OR p_action NOT IN ('PAUSE','RESUME','ARCHIVE','RESTORE')
    OR p_expected_status IS NULL OR p_expected_status NOT IN ('ACTIVE','SUSPENDED','ARCHIVED')
    OR (p_action = 'ARCHIVE') <> (p_confirm_name IS NOT NULL)
    OR (p_confirm_name IS NOT NULL AND length(p_confirm_name) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'INVALID_HQ_SCHOOL_LIFECYCLE_INPUT' USING ERRCODE = '22023';
  END IF;
  IF NOT ((p_action = 'PAUSE' AND p_expected_status = 'ACTIVE') OR (p_action = 'RESUME' AND p_expected_status = 'SUSPENDED')
    OR (p_action = 'ARCHIVE' AND p_expected_status IN ('ACTIVE','SUSPENDED')) OR (p_action = 'RESTORE' AND p_expected_status = 'ARCHIVED')) THEN
    RAISE EXCEPTION 'INVALID_HQ_SCHOOL_LIFECYCLE_TRANSITION' USING ERRCODE = '22023';
  END IF;
  target := CASE p_action WHEN 'PAUSE' THEN 'SUSPENDED' WHEN 'ARCHIVE' THEN 'ARCHIVED' ELSE 'ACTIVE' END::hon.membership_status;
  fingerprint := encode(sha256(convert_to(concat_ws(':', 'hq.school.lifecycle', p_school_id::text, p_action, p_expected_status, coalesce(p_confirm_name, '')), 'UTF8')), 'hex');
  actor := hon.require_hq_school_lifecycle_actor(p_subject);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_hq_school_lifecycle_actor(p_subject);
  IF NOT pg_try_advisory_xact_lock(hashtextextended(actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO receipt FROM hon.hq_school_lifecycle_requests r WHERE r.actor_principal_id = actor AND r.idempotency_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF receipt.request_fingerprint <> fingerprint THEN RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    IF receipt.status <> 'COMPLETED' THEN RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03'; END IF;
    RETURN receipt.response_body || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO school FROM hon.schools s WHERE s.id = p_school_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  -- Lock order: organization, then all its schools (stable id order).
  SELECT o.status INTO org_prior FROM hon.organizations o WHERE o.id = school.organization_id FOR UPDATE;
  PERFORM 1 FROM hon.schools s WHERE s.organization_id = school.organization_id ORDER BY s.id FOR UPDATE;
  SELECT * INTO school FROM hon.schools s WHERE s.id = p_school_id;
  IF school.status::text <> p_expected_status THEN
    RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_STATUS_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF p_action = 'ARCHIVE' AND p_confirm_name IS DISTINCT FROM school.name THEN
    RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_NAME_MISMATCH' USING ERRCODE = '22023';
  END IF;
  -- A school whose organization holds a paid, in-service HON subscription is not removed here.
  IF p_action = 'ARCHIVE' AND EXISTS (SELECT 1 FROM hon.saas_subscriptions sub WHERE sub.organization_id = school.organization_id
      AND sub.status IN ('PENDING_ACTIVATION','IN_SERVICE') AND sub.price_minor IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM hon.schools other WHERE other.organization_id = school.organization_id AND other.id <> school.id AND other.status <> 'ARCHIVED') THEN
    RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_BILLING_ACTIVE' USING ERRCODE = '40001';
  END IF;
  actor := hon.require_hq_school_lifecycle_actor(p_subject);
  effective := clock_timestamp();
  erase := CASE WHEN p_action = 'ARCHIVE' THEN effective + interval '30 days' END;
  INSERT INTO hon.hq_school_lifecycle_requests(actor_principal_id, idempotency_key, request_fingerprint, request_id, correlation_id, status)
    VALUES (actor, p_key, fingerprint, p_request_id, p_correlation_id, 'IN_PROGRESS');
  UPDATE hon.schools SET status = target, updated_at = effective WHERE id = p_school_id AND status = school.status;
  IF NOT FOUND THEN RAISE EXCEPTION 'HQ_SCHOOL_LIFECYCLE_STATUS_CONFLICT' USING ERRCODE = '40001'; END IF;
  -- The organization follows its most-open school: ACTIVE > SUSPENDED > ARCHIVED.
  SELECT CASE WHEN bool_or(s.status = 'ACTIVE') THEN 'ACTIVE' WHEN bool_or(s.status = 'SUSPENDED') THEN 'SUSPENDED' ELSE 'ARCHIVED' END::hon.membership_status
    INTO org_next FROM hon.schools s WHERE s.organization_id = school.organization_id;
  IF org_next IS DISTINCT FROM org_prior THEN
    UPDATE hon.organizations SET status = org_next, updated_at = effective WHERE id = school.organization_id;
  END IF;
  prior_fact := jsonb_build_object('schoolId', p_school_id, 'schoolStatus', school.status::text, 'organizationStatus', org_prior::text);
  next_fact := jsonb_build_object('schoolId', p_school_id, 'schoolStatus', target::text, 'organizationStatus', org_next::text);
  result := jsonb_build_object('schoolId', p_school_id, 'action', p_action, 'schoolStatus', target::text, 'organizationStatus', org_next::text,
    'eraseAfter', CASE WHEN erase IS NULL THEN NULL ELSE to_char(erase AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'replayed', false);
  INSERT INTO hon.hq_school_lifecycle_audit(organization_id, school_id, actor_principal_id, idempotency_key, request_id, correlation_id, action_code, prior_state, next_state, erase_after, occurred_at)
    VALUES (school.organization_id, p_school_id, actor, p_key, p_request_id, p_correlation_id, p_action, prior_fact, next_fact, erase, effective) RETURNING id INTO audit_id;
  INSERT INTO hon.hq_school_lifecycle_outbox(audit_id, event_type, request_id, correlation_id, payload, occurred_at)
    VALUES (audit_id, 'hq.school.lifecycle.changed', p_request_id, p_correlation_id,
      jsonb_build_object('action', p_action, 'prior', prior_fact, 'next', next_fact, 'internalOnly', true, 'executionAllowed', false), effective);
  UPDATE hon.hq_school_lifecycle_requests SET status = 'COMPLETED', response_body = result, completed_at = effective
    WHERE actor_principal_id = actor AND idempotency_key = p_key;
  RETURN result;
END $$;

-- Archived schools and their erase dates for the HQ list. Same viewers as the directory.
CREATE FUNCTION hon.read_hq_school_archive_dates(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_role text; v_rows jsonb;
BEGIN
  SELECT hq_role INTO v_role FROM hon.resolve_hq_operator_scope(p_subject, 'hq.dashboard.view')
    WHERE hq_role IN ('HON_HQ_OWNER', 'HON_HQ_OPERATOR') LIMIT 1;
  IF v_role IS NULL THEN RAISE EXCEPTION 'HQ school directory access denied' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'schoolId', s.id,
      'archivedAt', to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'eraseAfter', to_char(a.erase_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.id), '[]'::jsonb)
    INTO v_rows
  FROM hon.schools s
  JOIN LATERAL (SELECT la.occurred_at, la.erase_after, la.action_code FROM hon.hq_school_lifecycle_audit la
    WHERE la.school_id = s.id ORDER BY la.occurred_at DESC, la.id LIMIT 1) a ON a.action_code = 'ARCHIVE'
  WHERE s.status = 'ARCHIVED';
  RETURN jsonb_build_object('archives', v_rows);
END $$;

DO $$ DECLARE t text; r text; col text; f text;
  entry text[] := ARRAY['hon.transition_school_lifecycle_from_hq(text,uuid,text,text,text,uuid,uuid,uuid)', 'hon.read_hq_school_archive_dates(text)'];
BEGIN
  FOREACH t IN ARRAY ARRAY['hq_school_lifecycle_requests','hq_school_lifecycle_audit','hq_school_lifecycle_outbox'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE', t, r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_school_lifecycle_evidence()', 'hon.require_hq_school_lifecycle_actor(text)'] || entry LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime', f); END LOOP;
  END IF;
END $$;
COMMIT;
