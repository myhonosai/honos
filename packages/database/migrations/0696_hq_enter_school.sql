BEGIN;

-- HQ goes inside a customer school (owner, 2026-11-25; like agency sub-account access).
-- David chose: "Full access anytime, logged"; "No, owner keeps money settings"; "Let HQ logins work in schools"; and
-- "No, owner keeps these" (card charges, saved payment methods and refunds); and "Block, lose store help" (POS refunds).
-- - "Go inside" gives the HQ person a 4-hour grant of the organization's system role SUPPORT_VISIT ("HON HQ support"):
--   the organization's OWNER permissions minus money (school_pay.connection.manage: the school's own payment processor,
--   payouts and credentials; billing.hon.purchase: the school's HON plan and top-ups; school_pay.autopay.manage and
--   billing.payment.initiate: charging families; school_pay.method.manage: saved cards and banks; billing.refund.create
--   and billing.membership.refund.record: refunds; pos.manage: POS refunds, which also covers products, stock and tax). Owner-only features
--   gated on role code OWNER stay with the owner (owner invitations and handoff, A2P registration, role administration
--   of OWNER-equivalent roles, suspended-owner reads).
-- - Until now about 60 school features refused ANY principal holding an hq_operator_grants row. Those checks now let an
--   HQ person through while that person has a live Go-inside visit; each feature still requires its own school
--   permission from a live role grant. With no live visit nothing changes. HQ-only, invitation, sign-up, service-
--   principal and support-ticket checks keep refusing HQ people (unchanged).
-- - Every entry, extension and exit is recorded (HQ requests/audit/outbox here, plus a school audit_events row the
--   school can see). Leave ends the grant at once; it also ends by itself after 4 hours.
-- Nothing here is deployed. No billing, provider, message or entitlement effect.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ school visits require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')) THEN
    RAISE EXCEPTION 'HQ school visits require a restricted runtime';
  END IF;
END $$;

CREATE TABLE hon.hq_school_visit_requests (
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
CREATE TABLE hon.hq_school_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  hq_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  role_grant_id uuid NOT NULL UNIQUE REFERENCES hon.principal_role_grants(id) ON DELETE RESTRICT,
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 300 AND reason !~ '[[:cntrl:]]')),
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  left_at timestamptz,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CHECK (ends_at > started_at),
  CHECK (left_at IS NULL OR left_at >= started_at)
);
CREATE UNIQUE INDEX hq_school_visits_one_open_idx ON hon.hq_school_visits (hq_principal_id, school_id) WHERE left_at IS NULL;
CREATE INDEX hq_school_visits_principal_idx ON hon.hq_school_visits (hq_principal_id, ends_at DESC);
CREATE TABLE hon.hq_school_visit_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id uuid NOT NULL REFERENCES hon.hq_school_visits(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL REFERENCES hon.schools(id) ON DELETE RESTRICT,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL, request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('ENTER','EXTEND','LEAVE')),
  reason text, ends_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (actor_principal_id, idempotency_key) REFERENCES hon.hq_school_visit_requests(actor_principal_id, idempotency_key) ON DELETE RESTRICT,
  UNIQUE (actor_principal_id, idempotency_key)
);
CREATE INDEX hq_school_visit_audit_school_idx ON hon.hq_school_visit_audit (school_id, occurred_at DESC);
CREATE TABLE hon.hq_school_visit_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL UNIQUE REFERENCES hon.hq_school_visit_audit(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type = 'hq.school.visit.changed'),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  payload jsonb NOT NULL, occurred_at timestamptz NOT NULL
);

-- Requests complete once; a visit may only move ends_at forward (EXTEND) or set left_at once (LEAVE); audit and
-- outbox never change.
CREATE FUNCTION hon.guard_hq_school_visit_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_TABLE_NAME = 'hq_school_visit_requests' AND TG_OP = 'UPDATE' THEN
    IF OLD.status = 'IN_PROGRESS' AND NEW.status = 'COMPLETED'
    AND NEW.response_body IS NOT NULL AND NEW.completed_at IS NOT NULL
    AND (to_jsonb(NEW) - ARRAY['status','response_body','completed_at']) = (to_jsonb(OLD) - ARRAY['status','response_body','completed_at']) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'hq_school_visits' AND TG_OP = 'UPDATE' THEN
    IF OLD.left_at IS NULL AND (to_jsonb(NEW) - ARRAY['ends_at','left_at']) = (to_jsonb(OLD) - ARRAY['ends_at','left_at'])
    AND ((NEW.left_at IS NULL AND NEW.ends_at > OLD.ends_at) OR (NEW.left_at IS NOT NULL AND NEW.ends_at = OLD.ends_at)) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_HQ_SCHOOL_VISIT_EVIDENCE' USING ERRCODE = '42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_school_visit_requests','hq_school_visits','hq_school_visit_audit','hq_school_visit_outbox'] LOOP
    EXECUTE format('CREATE TRIGGER hq_school_visit_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_school_visit_evidence()', t);
    EXECUTE format('CREATE TRIGGER hq_school_visit_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_school_visit_evidence()', t);
  END LOOP;
END $$;

-- True while this principal has a live Go-inside visit: not left, its grant not revoked and not ended.
CREATE FUNCTION hon.hq_visit_active(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT p_principal IS NOT NULL AND EXISTS (SELECT 1 FROM hon.hq_school_visits v
    JOIN hon.principal_role_grants g ON g.id = v.role_grant_id
    WHERE v.hq_principal_id = p_principal AND v.left_at IS NULL AND g.principal_id = p_principal
      AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp() AND g.effective_until > clock_timestamp())
    -- The visit ends as soon as the HQ authority that opened it ends (owner, or operator with hq.onboarding.manage).
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = p_principal
      AND h.effective_from <= clock_timestamp() AND (h.effective_until IS NULL OR h.effective_until > clock_timestamp())
      AND (h.hq_role = 'HON_HQ_OWNER' OR (h.hq_role = 'HON_HQ_OPERATOR' AND 'hq.onboarding.manage' = ANY(h.permission_codes))));
$$;

-- The organization's SUPPORT_VISIT system role, created on first use and re-synced on every entry so later features
-- reach HQ support while money settings never do. Staff role administration (0059) cannot grant, edit or revoke a
-- system role.
CREATE FUNCTION hon.ensure_hq_support_role(p_org uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_owner uuid; v_role uuid;
  -- Owner decisions 2026-11-25: money settings, card charges, saved payment methods and refunds (POS too) stay with the owner.
  excluded constant text[] := ARRAY['school_pay.connection.manage','billing.hon.purchase','school_pay.autopay.manage',
    'school_pay.method.manage','billing.payment.initiate','billing.refund.create','billing.membership.refund.record','pos.manage'];
BEGIN
  SELECT id INTO v_owner FROM hon.roles WHERE organization_id = p_org AND code = 'OWNER' AND is_system_role;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO hon.roles(organization_id, code, name, is_system_role) VALUES (p_org, 'SUPPORT_VISIT', 'HON HQ support', true)
    ON CONFLICT (organization_id, code) DO NOTHING;
  SELECT id INTO v_role FROM hon.roles WHERE organization_id = p_org AND code = 'SUPPORT_VISIT' AND is_system_role
    AND management_school_id IS NULL FOR UPDATE;
  IF v_role IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_ROLE_CONFLICT' USING ERRCODE = '42501'; END IF;
  DELETE FROM hon.role_permissions rp WHERE rp.role_id = v_role AND rp.organization_id = p_org
    AND (rp.permission_code = ANY (excluded)
      OR NOT EXISTS (SELECT 1 FROM hon.role_permissions o WHERE o.role_id = v_owner AND o.permission_code = rp.permission_code));
  INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
    SELECT v_role, p_org, o.permission_code FROM hon.role_permissions o
    WHERE o.role_id = v_owner AND o.organization_id = p_org AND o.permission_code <> ALL (excluded)
    ON CONFLICT DO NOTHING;
  RETURN v_role;
END $$;

-- The API passes only the verified external subject. HQ owner, or an HQ operator holding hq.onboarding.manage (the
-- same people who create, pause and remove schools). No school, family or delegated context may be set.
CREATE FUNCTION hon.require_hq_school_visit_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['app.hon_organization_id','app.hon_school_id','app.hon_family_id',
      'app.hon_principal_id','app.hon_principal_type','app.hon_source','app.hon_action_request_id','app.hon_delegated_by_principal_id']) setting
      WHERE nullif(current_setting(setting, true), '') IS NOT NULL) THEN
    RAISE EXCEPTION 'HQ_SCHOOL_VISIT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (g.hq_role = 'HON_HQ_OWNER' OR (g.hq_role = 'HON_HQ_OPERATOR' AND 'hq.onboarding.manage' = ANY(g.permission_codes))))
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.hq_school_visit_ts(p timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- Go inside (or stay longer): 4 hours from now. Replays return the stored receipt.
CREATE FUNCTION hon.enter_school_as_hq(p_subject text, p_school_id uuid, p_reason text, p_key uuid, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; receipt hon.hq_school_visit_requests%ROWTYPE; fingerprint text; school hon.schools%ROWTYPE;
  visit hon.hq_school_visits%ROWTYPE; v_role uuid; v_grant uuid; at timestamptz; until timestamptz; action text;
  reason text := nullif(btrim(p_reason), ''); audit_id uuid; result jsonb;
BEGIN
  IF p_school_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL
    OR (reason IS NOT NULL AND (length(reason) > 300 OR reason ~ '[[:cntrl:]]')) THEN
    RAISE EXCEPTION 'INVALID_HQ_SCHOOL_VISIT_INPUT' USING ERRCODE = '22023';
  END IF;
  fingerprint := encode(sha256(convert_to(concat_ws(':', 'hq.school.visit.enter', p_school_id::text, coalesce(reason, '')), 'UTF8')), 'hex');
  actor := hon.require_hq_school_visit_actor(p_subject);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_hq_school_visit_actor(p_subject);
  IF NOT pg_try_advisory_xact_lock(hashtextextended(actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'HQ_SCHOOL_VISIT_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO receipt FROM hon.hq_school_visit_requests r WHERE r.actor_principal_id = actor AND r.idempotency_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF receipt.request_fingerprint <> fingerprint THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    IF receipt.status <> 'COMPLETED' THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03'; END IF;
    RETURN receipt.response_body || jsonb_build_object('replayed', true);
  END IF;
  SELECT s.* INTO school FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
  WHERE s.id = p_school_id AND s.status = 'ACTIVE' AND o.status = 'ACTIVE' FOR SHARE OF s, o;
  IF NOT FOUND THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  -- One visit change at a time per HQ person and school.
  PERFORM pg_advisory_xact_lock(hashtextextended('hq.school.visit:' || actor::text || ':' || p_school_id::text, 0));
  at := clock_timestamp(); until := at + interval '4 hours';
  INSERT INTO hon.hq_school_visit_requests(actor_principal_id, idempotency_key, request_fingerprint, request_id, correlation_id, status)
    VALUES (actor, p_key, fingerprint, p_request_id, p_correlation_id, 'IN_PROGRESS');
  v_role := hon.ensure_hq_support_role(school.organization_id);
  SELECT v.* INTO visit FROM hon.hq_school_visits v JOIN hon.principal_role_grants g ON g.id = v.role_grant_id
  WHERE v.hq_principal_id = actor AND v.school_id = p_school_id AND v.left_at IS NULL FOR UPDATE OF v, g;
  IF FOUND AND EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.id = visit.role_grant_id
      AND g.revoked_at IS NULL AND g.effective_until > at) THEN
    action := 'EXTEND';
    UPDATE hon.principal_role_grants SET effective_until = until, version = version + 1 WHERE id = visit.role_grant_id;
    UPDATE hon.hq_school_visits SET ends_at = until WHERE id = visit.id RETURNING * INTO visit;
  ELSE
    IF FOUND THEN
      -- An expired, unclosed visit is closed at its end time before a new one starts.
      UPDATE hon.hq_school_visits SET left_at = greatest(least(visit.ends_at, at), visit.started_at) WHERE id = visit.id;
    END IF;
    action := 'ENTER';
    INSERT INTO hon.principal_role_grants(organization_id, school_id, principal_id, role_id, granted_by_principal_id, effective_from, effective_until)
      VALUES (school.organization_id, p_school_id, actor, v_role, actor, at, until) RETURNING id INTO v_grant;
    INSERT INTO hon.hq_school_visits(organization_id, school_id, hq_principal_id, role_grant_id, reason, started_at, ends_at)
      VALUES (school.organization_id, p_school_id, actor, v_grant, reason, at, until) RETURNING * INTO visit;
  END IF;
  result := jsonb_build_object('visitId', visit.id, 'organizationId', school.organization_id, 'schoolId', p_school_id,
    'action', action, 'startedAt', hon.hq_school_visit_ts(visit.started_at), 'endsAt', hon.hq_school_visit_ts(visit.ends_at), 'replayed', false);
  INSERT INTO hon.hq_school_visit_audit(visit_id, organization_id, school_id, actor_principal_id, idempotency_key, request_id, correlation_id, action_code, reason, ends_at, occurred_at)
    VALUES (visit.id, school.organization_id, p_school_id, actor, p_key, p_request_id, p_correlation_id, action, reason, visit.ends_at, at) RETURNING id INTO audit_id;
  INSERT INTO hon.hq_school_visit_outbox(audit_id, event_type, request_id, correlation_id, payload, occurred_at)
    VALUES (audit_id, 'hq.school.visit.changed', p_request_id, p_correlation_id,
      jsonb_build_object('action', action, 'visitId', visit.id, 'schoolId', p_school_id, 'internalOnly', true, 'executionAllowed', false), at);
  -- The school's own log shows HQ coming in.
  INSERT INTO hon.audit_events(organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (school.organization_id, p_school_id, actor, 'HON_HQ', CASE action WHEN 'ENTER' THEN 'hq.school.visit.entered' ELSE 'hq.school.visit.extended' END,
      'HQ_SCHOOL_VISIT', visit.id, NULL, jsonb_build_object('endsAt', hon.hq_school_visit_ts(visit.ends_at), 'reason', reason), 'SUCCEEDED', p_request_id, p_correlation_id, at);
  UPDATE hon.hq_school_visit_requests SET status = 'COMPLETED', response_body = result, completed_at = at
    WHERE actor_principal_id = actor AND idempotency_key = p_key;
  -- Final decision point: HQ authority that ended meanwhile rolls everything back.
  IF hon.require_hq_school_visit_actor(p_subject) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'HQ_SCHOOL_VISIT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN result;
END $$;

-- Leave: ends the grant now. Works for the visiting person even after their HQ authority ended.
CREATE FUNCTION hon.leave_school_as_hq(p_subject text, p_school_id uuid, p_key uuid, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; receipt hon.hq_school_visit_requests%ROWTYPE; fingerprint text; visit hon.hq_school_visits%ROWTYPE;
  at timestamptz; audit_id uuid; result jsonb;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject
    OR p_school_id IS NULL OR p_key IS NULL OR p_request_id IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_HQ_SCHOOL_VISIT_INPUT' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['app.hon_organization_id','app.hon_school_id','app.hon_family_id','app.hon_principal_id',
      'app.hon_principal_type','app.hon_source','app.hon_action_request_id','app.hon_delegated_by_principal_id']) setting
      WHERE nullif(current_setting(setting, true), '') IS NOT NULL) THEN
    RAISE EXCEPTION 'HQ_SCHOOL_VISIT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  fingerprint := encode(sha256(convert_to(concat_ws(':', 'hq.school.visit.leave', p_school_id::text), 'UTF8')), 'hex');
  IF NOT pg_try_advisory_xact_lock(hashtextextended(actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'HQ_SCHOOL_VISIT_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO receipt FROM hon.hq_school_visit_requests r WHERE r.actor_principal_id = actor AND r.idempotency_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF receipt.request_fingerprint <> fingerprint THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_KEY_REUSED' USING ERRCODE = '23505'; END IF;
    IF receipt.status <> 'COMPLETED' THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03'; END IF;
    RETURN receipt.response_body || jsonb_build_object('replayed', true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hq.school.visit:' || actor::text || ':' || p_school_id::text, 0));
  SELECT * INTO visit FROM hon.hq_school_visits v WHERE v.hq_principal_id = actor AND v.school_id = p_school_id AND v.left_at IS NULL FOR UPDATE;
  -- Nothing open: no write, nothing to record. Only HQ people (even after their HQ grant ended) get the answer; anyone
  -- else learns nothing about any school.
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = actor) THEN
      RAISE EXCEPTION 'HQ_SCHOOL_VISIT_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object('schoolId', p_school_id, 'left', false, 'replayed', false);
  END IF;
  at := clock_timestamp();
  INSERT INTO hon.hq_school_visit_requests(actor_principal_id, idempotency_key, request_fingerprint, request_id, correlation_id, status)
    VALUES (actor, p_key, fingerprint, p_request_id, p_correlation_id, 'IN_PROGRESS');
  UPDATE hon.principal_role_grants SET effective_until = greatest(least(effective_until, at), effective_from + interval '1 microsecond'),
      revoked_at = at, revoked_by_principal_id = actor, version = version + 1
    WHERE id = visit.role_grant_id AND revoked_at IS NULL;
  UPDATE hon.hq_school_visits SET left_at = at WHERE id = visit.id RETURNING * INTO visit;
  result := jsonb_build_object('visitId', visit.id, 'schoolId', p_school_id, 'left', true, 'leftAt', hon.hq_school_visit_ts(at), 'replayed', false);
  INSERT INTO hon.hq_school_visit_audit(visit_id, organization_id, school_id, actor_principal_id, idempotency_key, request_id, correlation_id, action_code, reason, ends_at, occurred_at)
    VALUES (visit.id, visit.organization_id, p_school_id, actor, p_key, p_request_id, p_correlation_id, 'LEAVE', NULL, visit.ends_at, at) RETURNING id INTO audit_id;
  INSERT INTO hon.hq_school_visit_outbox(audit_id, event_type, request_id, correlation_id, payload, occurred_at)
    VALUES (audit_id, 'hq.school.visit.changed', p_request_id, p_correlation_id,
      jsonb_build_object('action', 'LEAVE', 'visitId', visit.id, 'schoolId', p_school_id, 'internalOnly', true, 'executionAllowed', false), at);
  INSERT INTO hon.audit_events(organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (visit.organization_id, p_school_id, actor, 'HON_HQ', 'hq.school.visit.left', 'HQ_SCHOOL_VISIT', visit.id, NULL,
      jsonb_build_object('leftAt', hon.hq_school_visit_ts(at)), 'SUCCEEDED', p_request_id, p_correlation_id, at);
  UPDATE hon.hq_school_visit_requests SET status = 'COMPLETED', response_body = result, completed_at = at
    WHERE actor_principal_id = actor AND idempotency_key = p_key;
  RETURN result;
END $$;

-- The caller's own live visits (HQ list and the in-school banner). Only the visiting person's own rows.
CREATE FUNCTION hon.read_my_hq_school_visits(p_subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; rows jsonb;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject THEN
    RAISE EXCEPTION 'HQ_SCHOOL_VISIT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'HQ_SCHOOL_VISIT_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('visitId', v.id, 'organizationId', v.organization_id, 'schoolId', v.school_id,
      'schoolName', s.name, 'startedAt', hon.hq_school_visit_ts(v.started_at), 'endsAt', hon.hq_school_visit_ts(g.effective_until))
      ORDER BY v.started_at, v.id), '[]'::jsonb) INTO rows
  FROM hon.hq_school_visits v JOIN hon.principal_role_grants g ON g.id = v.role_grant_id JOIN hon.schools s ON s.id = v.school_id
  WHERE v.hq_principal_id = actor AND v.left_at IS NULL AND g.revoked_at IS NULL AND g.effective_until > clock_timestamp();
  RETURN jsonb_build_object('visits', rows);
END $$;

-- Let HQ logins work in schools while inside (David, 2026-11-25). Each listed check refused any principal with an
-- hq_operator_grants row; it now also passes while that principal has a live visit. Exact text, exact counts: any
-- drift in a function body fails this migration instead of being skipped.
CREATE TEMPORARY TABLE hq_visit_lift(sig text NOT NULL, old text NOT NULL, principal text NOT NULL, negated boolean NOT NULL, n integer NOT NULL) ON COMMIT DROP;
INSERT INTO hq_visit_lift(sig, old, principal, negated, n) VALUES
    ('hon.automation_activator_ok(uuid,uuid,uuid)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.conversation_staff_has(uuid,uuid,uuid,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p_principal)$q$, 'p_principal', true, 1),
    ('hon.human_action_reviewer()', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.lock_class_booking_session(text,uuid)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants hq WHERE hq.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.lock_classpass_actor(text,text)', $q$EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)$q$, 'actor', false, 1),
    ('hon.lock_kiosk_actor(text,text)', $q$EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)$q$, 'actor', false, 1),
    ('hon.marketing_owner(text)', $q$EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)$q$, 'actor', false, 1),
    ('hon.pos_actor(text,uuid,boolean)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.read_a2p_preparation_scope(text)', $q$NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = p.id)$q$, 'p.id', true, 1),
    ('hon.read_school_command_center(text,uuid,uuid)', $q$EXISTS (
    SELECT 1 FROM hon.hq_operator_grants WHERE principal_id = v_principal_id
  )$q$, 'v_principal_id', false, 1),
    ('hon.read_school_health_score(text,uuid,uuid)', $q$EXISTS (
    SELECT 1 FROM hon.hq_operator_grants WHERE principal_id = v_principal_id
  )$q$, 'v_principal_id', false, 1),
    ('hon.read_staff_reporting_schools(text)', $q$NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq
                      WHERE hq.principal_id = principal.id)$q$, 'principal.id', true, 1),
    ('hon.require_automation_workflow_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_billing_import_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_class_series_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_classpass_read_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_crm_adult_membership_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_crm_board_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_current_direct_human_billing_account_actor(uuid)', $q$NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = actor)$q$, 'actor', true, 1),
    ('hon.require_current_school_class_sessions_read_actor(text)', $q$NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = p.id)$q$, 'p.id', true, 1),
    ('hon.require_custom_tool_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_demo_data_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_family_messages_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_history_import_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_human_action_review(text,uuid)', $q$EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)$q$, 'actor', false, 1),
    ('hon.require_maya_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_membership_lifecycle_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_membership_plan_manager(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_onboarding_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_person_membership_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_retention_review_actor(text)', $q$EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = v_actor)$q$, 'v_actor', false, 1),
    ('hon.require_school_blast_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_branding_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_checkout_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_contact_admin(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_contacts_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_location_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_media_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_pay_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_pay_autopay_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_pay_method_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_referral_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_reports_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_sender_manager(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_social_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_school_website_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_staff_shift_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_staff_time_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_student_import_actor(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_teaching_assistant_actor(text,boolean)', $q$EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)$q$, 'actor', false, 1),
    ('hon.require_tuition_actor(text,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.require_voice_actor(text)', $q$EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)$q$, 'actor', false, 1),
    ('hon.resolve_chad_follow_up_scope(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.resolve_crm_lead_registration_scope(text,uuid)', $q$NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id AND h.effective_from<=clock_timestamp() AND (h.effective_until IS NULL OR h.effective_until>clock_timestamp()))$q$, 'p.id', true, 1),
    ('hon.resolve_current_staff_reporting_scope(text)', $q$NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq
                      WHERE hq.principal_id = principal.id)$q$, 'principal.id', true, 1),
    ('hon.resolve_owner_launch_scope(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id AND h.effective_from<=clock_timestamp() AND (h.effective_until IS NULL OR h.effective_until>clock_timestamp()))$q$, 'p.id', true, 1),
    ('hon.resolve_planned_absence_review_scope(text)', $q$NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = p.id)$q$, 'p.id', true, 1),
    ('hon.resolve_retention_review_scope(text,uuid)', $q$NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = human.id)$q$, 'human.id', true, 1),
    ('hon.resolve_teaching_assistant_scope(text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.save_approved_marketing_draft(text,uuid)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.save_approved_teaching_draft(text,uuid)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.staff_member_eligible(uuid,uuid,uuid)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1),
    ('hon.walkin_principal_holds(uuid,uuid,uuid,text)', $q$NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)$q$, 'p.id', true, 1)
;
DO $lift$
DECLARE fn text; r record; def text; n integer; done integer := 0;
BEGIN
  FOR fn IN SELECT DISTINCT sig FROM hq_visit_lift ORDER BY sig LOOP
    def := pg_get_functiondef(fn::regprocedure);
    FOR r IN SELECT * FROM hq_visit_lift WHERE sig = fn ORDER BY length(old) DESC, old LOOP
      n := (length(def) - length(replace(def, r.old, ''))) / length(r.old);
      IF n <> r.n THEN RAISE EXCEPTION 'HQ visit lift: % has % copies of a check (expected %)', fn, n, r.n; END IF;
      def := replace(def, r.old, CASE WHEN r.negated THEN '(' || r.old || ' OR hon.hq_visit_active(' || r.principal || '))'
        ELSE '(' || r.old || ' AND NOT hon.hq_visit_active(' || r.principal || '))' END);
    END LOOP;
    EXECUTE def;
    done := done + 1;
  END LOOP;
  IF done <> 63 THEN RAISE EXCEPTION 'HQ visit lift changed % functions (expected 63)', done; END IF;
END $lift$;

DO $$ DECLARE t text; r text; f text;
  entry text[] := ARRAY['hon.enter_school_as_hq(text,uuid,text,uuid,uuid,uuid)', 'hon.leave_school_as_hq(text,uuid,uuid,uuid,uuid)',
    'hon.read_my_hq_school_visits(text)'];
BEGIN
  FOREACH t IN ARRAY ARRAY['hq_school_visit_requests','hq_school_visits','hq_school_visit_audit','hq_school_visit_outbox'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE', t, r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_school_visit_evidence()', 'hon.hq_visit_active(uuid)', 'hon.ensure_hq_support_role(uuid)',
      'hon.require_hq_school_visit_actor(text)', 'hon.hq_school_visit_ts(timestamp with time zone)'] || entry LOOP
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
