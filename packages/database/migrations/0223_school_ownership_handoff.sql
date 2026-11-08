BEGIN;

-- B-ID-4 school ownership handoff (proposed number 0223; the owner allocates the final number).
-- Owner decisions 2026-11-08 (H-1..H-5, approved as recommended):
--   H-1 HQ provisioning no longer grants the school OWNER role to the HQ person who provisions the school. The system
--       OWNER role is still created so the first school owner can be bound by invitation (0191).
--   H-2 When a school owner accepts an invitation, every OWNER grant at that school held by an HQ principal (any
--       hq_operator_grants row, timed or not, the same exclusion as staff_member_eligible) ends in the same statement.
--   H-3 Schools provisioned earlier: an HQ-owner command ends those HQ-held OWNER grants one school at a time, only where
--       the school already has a live non-HQ owner, and only for the exact grant set the HQ-owner read showed (dry run).
--   H-4 A school may have several owners; one is the primary owner (billing contact and recovery). The first owner to
--       accept becomes primary when no live primary exists; an HQ owner may designate another live owner.
--   H-5 HQ may invite or add an owner where one already exists; the existing owners get an in-app notice (no consent
--       step, no email or other delivery).
-- Why it matters now: resolve_authorized_scope (0059) does not exclude HQ principals, so a provisioner's OWNER grant is
-- usable by paths built on it (for example the staff-invitation manager, 0204) once the school's entitlement is ACTIVE.
-- Unchanged: invitation tables, tokens, TTLs, replay and fingerprint rules, receipts, NOWAIT authority envelope, D9
-- SUSPENDED placeholder entitlement, audit/outbox shapes of provisioning. No entitlement, billing, payment, AI credit or
-- provider effect. Nothing here is deployed.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School ownership handoff requires a trusted migration owner';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables (private: forced deny-all RLS, no runtime table or column privilege; written only by the functions below,
-- always under the school-account advisory lock taken by hon.lock_school_account_authority()).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE hon.school_primary_owners (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id),
  owner_grant_id uuid NOT NULL REFERENCES hon.principal_role_grants(id),
  source text NOT NULL CHECK (source IN ('FIRST_OWNER','HQ_DESIGNATED')),
  designated_by uuid NOT NULL REFERENCES hon.principals(id),
  designated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id)
);
CREATE TABLE hon.school_ownership_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id),
  school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OWNER_INVITED','OWNER_ADDED','PRIMARY_OWNER_CHANGED','HQ_OWNER_ACCESS_ENDED')),
  invitation_id uuid REFERENCES hon.school_owner_invitations(id),
  invited_email text,
  owner_grant_id uuid REFERENCES hon.principal_role_grants(id),
  ended_grant_count integer,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  CHECK ((kind = 'OWNER_INVITED' AND invitation_id IS NOT NULL AND invited_email IS NOT NULL AND owner_grant_id IS NULL AND ended_grant_count IS NULL)
    OR (kind = 'OWNER_ADDED' AND invitation_id IS NOT NULL AND invited_email IS NOT NULL AND owner_grant_id IS NOT NULL AND ended_grant_count IS NULL)
    OR (kind = 'PRIMARY_OWNER_CHANGED' AND invitation_id IS NULL AND invited_email IS NULL AND owner_grant_id IS NOT NULL AND ended_grant_count IS NULL)
    OR (kind = 'HQ_OWNER_ACCESS_ENDED' AND invitation_id IS NULL AND invited_email IS NULL AND owner_grant_id IS NULL AND ended_grant_count > 0))
);
CREATE INDEX school_ownership_notices_school_idx ON hon.school_ownership_notices (school_id, occurred_at DESC, id);
CREATE TABLE hon.school_ownership_requests (
  subject text NOT NULL,
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('SET_PRIMARY','END_HQ_OWNER_GRANTS')),
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (subject, idempotency_key)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.school_ownership_notices FOR EACH ROW EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_ownership_notices FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.school_ownership_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_ownership_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE FUNCTION hon.guard_school_primary_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  -- Only the designation may change, with a version bump; the school never moves and the row is never deleted.
  IF TG_OP = 'UPDATE' AND NEW.school_id = OLD.school_id AND NEW.organization_id = OLD.organization_id
    AND NEW.version = OLD.version + 1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ACCOUNT_EVIDENCE_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_primary_owners FOR EACH ROW EXECUTE FUNCTION hon.guard_school_primary_owner();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_primary_owners FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();

-- ---------------------------------------------------------------------------------------------------------------------
-- Internal helpers (never granted).
-- ---------------------------------------------------------------------------------------------------------------------
-- Every OWNER (system role) grant at one school that is not ended at p_at, including grants that start later.
-- o_hq: the holder has ANY hq_operator_grants row (timed or not), the same exclusion staff_member_eligible uses.
-- o_live: started, holder is an active human principal with exactly one active principal, school and organization ACTIVE.
CREATE FUNCTION hon.school_owner_grant_rows(p_school uuid, p_at timestamptz)
RETURNS TABLE (o_grant uuid, o_org uuid, o_principal uuid, o_from timestamptz, o_hq boolean, o_live boolean)
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT g.id, g.organization_id, g.principal_id, g.effective_from,
    EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = g.principal_id),
    g.effective_from <= p_at AND p.is_active AND p.principal_type = 'HUMAN_USER'
      AND (SELECT count(*) FROM hon.principals x WHERE x.user_id = p.user_id AND x.is_active) = 1
      AND s.status = 'ACTIVE' AND o.status = 'ACTIVE'
  FROM hon.principal_role_grants g
  JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id AND r.code = 'OWNER' AND r.is_system_role
  JOIN hon.principals p ON p.id = g.principal_id
  JOIN hon.schools s ON s.id = g.school_id AND s.organization_id = g.organization_id
  JOIN hon.organizations o ON o.id = g.organization_id
  WHERE g.school_id = p_school AND g.revoked_at IS NULL AND (g.effective_until IS NULL OR g.effective_until > p_at)
$$;

-- The primary owner grant of a school while it is still a live non-HQ owner grant, else NULL.
CREATE FUNCTION hon.school_live_primary_grant(p_school uuid, p_at timestamptz) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT po.owner_grant_id FROM hon.school_primary_owners po
  WHERE po.school_id = p_school
    AND EXISTS (SELECT 1 FROM hon.school_owner_grant_rows(p_school, p_at) w WHERE w.o_grant = po.owner_grant_id AND w.o_live AND NOT w.o_hq)
$$;

-- Insert or move the primary designation. Caller holds the school-account lock and has checked the grant.
CREATE FUNCTION hon.school_set_primary_owner(p_org uuid, p_school uuid, p_grant uuid, p_source text, p_by uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  INSERT INTO hon.school_primary_owners (school_id, organization_id, owner_grant_id, source, designated_by, designated_at)
  VALUES (p_school, p_org, p_grant, p_source, p_by, p_at)
  ON CONFLICT (school_id) DO UPDATE SET owner_grant_id = EXCLUDED.owner_grant_id, source = EXCLUDED.source,
    designated_by = EXCLUDED.designated_by, designated_at = EXCLUDED.designated_at, version = hon.school_primary_owners.version + 1;
END $$;

-- End every HQ-held OWNER grant at one school (live or not yet started), the way 0059 revokes a staff grant: revoked_at and
-- revoked_by are set, so every resolver that honours revocation refuses it at once. A grant that has not started yet is also
-- closed one microsecond after its start (the table requires effective_until > effective_from). Writes one
-- audit row per ended grant. Returns the ended grant ids in id order. Caller holds the school-account lock.
CREATE FUNCTION hon.school_end_hq_owner_grants(p_school uuid, p_at timestamptz, p_actor uuid, p_source text, p_request uuid) RETURNS uuid[]
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE ended uuid[]; g record;
BEGIN
  ended := ARRAY[]::uuid[];
  FOR g IN
    UPDATE hon.principal_role_grants t
       SET effective_until = CASE WHEN t.effective_from < p_at THEN p_at ELSE t.effective_from + interval '1 microsecond' END,
           revoked_at = p_at, revoked_by_principal_id = p_actor,
           version = t.version + 1
     WHERE t.id IN (SELECT w.o_grant FROM hon.school_owner_grant_rows(p_school, p_at) w WHERE w.o_hq)
    RETURNING t.id, t.organization_id, t.school_id, t.principal_id, t.effective_until
  LOOP
    ended := array_append(ended, g.id);
    INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
      prior_state, next_state, result, request_id, correlation_id, occurred_at)
    VALUES (g.organization_id, g.school_id, p_actor, p_source, 'school.owner.hq_grant.end', 'PRINCIPAL_ROLE_GRANT', g.id,
      jsonb_build_object('holder', 'HQ_PRINCIPAL', 'role', 'OWNER', 'effectiveUntil', NULL),
      jsonb_build_object('holder', 'HQ_PRINCIPAL', 'role', 'OWNER', 'effectiveUntil', hon.saas_ts(g.effective_until)),
      'SUCCEEDED', p_request, p_request, p_at);
  END LOOP;
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::uuid[]) INTO ended FROM unnest(ended) x;
  RETURN ended;
END $$;

CREATE FUNCTION hon.school_ownership_owner_json(p_school uuid, p_at timestamptz, p_primary uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'ownerGrantId', w.o_grant,
      'displayName', left(coalesce(nullif(btrim(u.display_name), ''), 'School owner'), 120),
      'email', lower(u.email::text),
      'since', hon.saas_ts(w.o_from),
      'primary', w.o_grant IS NOT DISTINCT FROM p_primary,
      'viaInvitation', EXISTS (SELECT 1 FROM hon.school_owner_invitations i WHERE i.owner_grant_id = w.o_grant))
    ORDER BY w.o_from, w.o_grant), '[]'::jsonb)
  FROM hon.school_owner_grant_rows(p_school, p_at) w
  JOIN hon.principals p ON p.id = w.o_principal JOIN hon.users u ON u.id = p.user_id
  WHERE w.o_live AND NOT w.o_hq
$$;

CREATE FUNCTION hon.school_ownership_notices_json(p_school uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('noticeId', n.id, 'kind', n.kind, 'occurredAt', hon.saas_ts(n.occurred_at),
      'invitedEmail', n.invited_email, 'endedGrantCount', n.ended_grant_count) ORDER BY n.occurred_at DESC, n.id), '[]'::jsonb)
  FROM (SELECT * FROM hon.school_ownership_notices WHERE school_id = p_school ORDER BY occurred_at DESC, id LIMIT 50) n
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Preflight race (found by the 0191 concurrent-acceptance proof once acceptance does more work): the lock-free preflight
-- runs several READ COMMITTED statements, so it can read the invitation as PENDING and then see the user row that a
-- concurrent acceptance of the same invitation just committed, and wrongly answer ACCOUNT_REVIEW_REQUIRED. Before that
-- answer, re-read the invitation: if it is no longer PENDING the facts moved underneath, so answer the recoverable
-- ACCOUNT_BUSY (an explicit same-key retry then replays). It and the acceptance also refuse an accepting identity with ANY
-- hq_operator_grants row (0191 refused only a current one): H-2 would otherwise end that new owner's grant in the same
-- statement, consume the invitation and leave the school without an owner. Otherwise identical to 0191.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION hon.school_owner_review_or_busy(p_invitation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF (SELECT status FROM hon.school_owner_invitations WHERE id=p_invitation) IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'ACCOUNT_BUSY' USING ERRCODE='55P03'; END IF;
  RAISE EXCEPTION 'ACCOUNT_REVIEW_REQUIRED' USING ERRCODE='23514';
END $$;
CREATE OR REPLACE FUNCTION hon.check_school_owner_acceptance(p_subject text,p_verified_email text,p_input jsonb,p_key uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE i hon.school_owner_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE;
  issuer_subject text; v_user uuid; actor uuid; fp text;
BEGIN
  PERFORM hon.saas_refuse_context();
  SELECT * INTO i FROM hon.school_owner_invitations WHERE id=(p_input->>'invitationId')::uuid;
  IF i.id IS NULL OR i.token_hash IS DISTINCT FROM p_input->>'tokenHash' OR i.email IS DISTINCT FROM p_verified_email OR i.status='REVOKED'
    OR NOT EXISTS(SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id
      WHERE s.id=i.school_id AND s.organization_id=i.organization_id AND s.status='ACTIVE' AND o.status='ACTIVE') THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  IF i.status='ACCEPTED' THEN
    SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
    IF NOT FOUND OR i.accepted_subject IS DISTINCT FROM p_subject OR NOT EXISTS(
      SELECT 1 FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id
      WHERE g.id=i.owner_grant_id AND p.is_active AND g.effective_from<=clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN
      RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
    fp:=encode(sha256(convert_to('ACCEPT:'||p_input::text,'UTF8')),'hex');
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN;
  END IF;
  IF i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  SELECT u.external_subject INTO issuer_subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=i.created_by;
  PERFORM hon.require_saas_hq_actor(issuer_subject,true);
  SELECT id INTO v_user FROM hon.users WHERE external_subject=p_subject;
  IF v_user IS NULL THEN
    IF EXISTS(SELECT 1 FROM hon.users WHERE lower(email::text)=p_verified_email) THEN PERFORM hon.school_owner_review_or_busy(i.id); END IF;
  ELSE
    SELECT id INTO actor FROM hon.principals WHERE user_id=v_user AND is_active AND principal_type='HUMAN_USER';
    IF actor IS NULL OR (SELECT count(*) FROM hon.principals WHERE user_id=v_user AND is_active)<>1
      OR NOT EXISTS(SELECT 1 FROM hon.users WHERE id=v_user AND lower(email::text)=p_verified_email) THEN
      PERFORM hon.school_owner_review_or_busy(i.id); END IF;
    IF EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor) -- 0223: any HQ row, timed or not (staff_member_eligible rule)
      OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
      OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id=actor AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())
        AND (organization_id<>i.organization_id OR school_id=i.school_id)) THEN
      PERFORM hon.school_owner_review_or_busy(i.id); END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.roles WHERE organization_id=i.organization_id AND code='OWNER' AND is_system_role) THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
END $$;


-- ---------------------------------------------------------------------------------------------------------------------
-- H-1: provisioning creates the OWNER role but grants it to nobody. Otherwise identical to 0208.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hon.provision_school_from_hq(
  p_external_subject text,
  p_legal_name text,
  p_display_name text,
  p_school_name text,
  p_school_slug text,
  p_timezone text,
  p_initial_tier hon.plan_tier,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_request_id uuid,
  p_correlation_id uuid
)
RETURNS TABLE (
  organization_id uuid,
  school_id uuid,
  owner_role_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor_principal_id uuid;
  v_request_id uuid;
  v_prior_fingerprint text;
  v_prior_status text;
  v_prior_response jsonb;
  v_organization_id uuid;
  v_school_id uuid;
  v_owner_role_id uuid;
  v_response jsonb;
BEGIN
  IF btrim(p_legal_name) = '' OR btrim(p_display_name) = '' OR btrim(p_school_name) = ''
    OR btrim(p_school_slug) = '' OR btrim(p_timezone) = '' OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning requires non-blank organization, school, timezone, and idempotency fields.' USING ERRCODE = 'P0001';
  END IF;

  v_actor_principal_id := hon.hq_provisioning_actor(p_external_subject);
  IF v_actor_principal_id IS NULL THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning is not authorized for this account.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO hon.hq_onboarding_requests (actor_principal_id, idempotency_key, request_fingerprint, status)
  VALUES (v_actor_principal_id, p_idempotency_key, p_request_fingerprint, 'IN_PROGRESS')
  ON CONFLICT (actor_principal_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_request_id;
  IF v_request_id IS NULL THEN
    SELECT request_fingerprint, status, response_body INTO v_prior_fingerprint, v_prior_status, v_prior_response
    FROM hon.hq_onboarding_requests
    WHERE actor_principal_id = v_actor_principal_id AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF v_prior_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION 'HON HQ idempotency key was already used for a different tenant-provisioning request.' USING ERRCODE = '23505';
    END IF;
    IF v_prior_status = 'COMPLETED' AND v_prior_response IS NOT NULL THEN
      IF hon.hq_provisioning_actor(p_external_subject) IS DISTINCT FROM v_actor_principal_id THEN
        RAISE EXCEPTION 'HON HQ tenant provisioning is not authorized for this account.' USING ERRCODE = '42501';
      END IF;
      RETURN QUERY SELECT (v_prior_response->>'organizationId')::uuid, (v_prior_response->>'schoolId')::uuid, (v_prior_response->>'ownerRoleId')::uuid, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Matching HON HQ tenant-provisioning request is still in progress.' USING ERRCODE = '55P03';
  END IF;

  INSERT INTO hon.organizations (legal_name, display_name)
  VALUES (btrim(p_legal_name), btrim(p_display_name))
  RETURNING id INTO v_organization_id;
  -- D9: provisioning grants no operating access (SUSPENDED placeholder entitlement), unchanged from 0185.
  INSERT INTO hon.organization_entitlements (organization_id, tier, status)
  VALUES (v_organization_id, p_initial_tier, 'SUSPENDED');
  INSERT INTO hon.schools (organization_id, name, slug, timezone)
  VALUES (v_organization_id, btrim(p_school_name), lower(btrim(p_school_slug)), btrim(p_timezone))
  RETURNING id INTO v_school_id;
  INSERT INTO hon.roles (organization_id, code, name, is_system_role)
  VALUES (v_organization_id, 'OWNER', 'School Owner', true)
  RETURNING id INTO v_owner_role_id;
  INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
  SELECT v_owner_role_id, v_organization_id, permission.code FROM hon.permissions AS permission;
  -- H-1: no principal_role_grants row. The first school owner is bound by an HQ-owner invitation (0191).

  v_response := jsonb_build_object('organizationId', v_organization_id, 'schoolId', v_school_id, 'ownerRoleId', v_owner_role_id, 'tier', p_initial_tier::text,
    'entitlementStatus', 'SUSPENDED', 'access', 'NONE');
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (v_organization_id, v_school_id, v_actor_principal_id, 'HON_HQ', 'hq.organization.provision', 'ORGANIZATION', v_organization_id, NULL, v_response, 'SUCCEEDED', p_request_id, p_correlation_id, now());
  INSERT INTO hon.outbox_events (organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
  VALUES (v_organization_id, v_school_id, 'organization.provisioned', 1, 'ORGANIZATION', v_organization_id, 1, p_correlation_id, p_request_id, v_response);
  UPDATE hon.hq_onboarding_requests SET status = 'COMPLETED', response_body = v_response, completed_at = now() WHERE id = v_request_id;

  IF hon.hq_provisioning_actor(p_external_subject) IS DISTINCT FROM v_actor_principal_id THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning is not authorized for this account.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_organization_id, v_school_id, v_owner_role_id, false;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- H-5: an invitation to a school that already has a live non-HQ owner leaves a notice for those owners.
-- Otherwise identical to 0206.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hon.manage_school_owner_invitation(p_subject text,p_operation text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; i hon.school_owner_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE;
  fp text; at timestamptz; v_org uuid; v_school uuid; v_ttl integer; result jsonb;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR p_operation IS NULL OR p_operation NOT IN ('INVITE','REVOKE') THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  PERFORM hon.lock_school_account_authority();
  actor:=hon.require_saas_hq_actor(p_subject,true);
  fp:=encode(sha256(convert_to(p_operation||':'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    PERFORM hon.require_saas_hq_actor(p_subject,true);
    RETURN prior.response;
  END IF;
  at:=clock_timestamp();
  IF p_operation='INVITE' THEN
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['email','schoolId','tokenHash','ttlHours']
      OR jsonb_typeof(p_input->'email') IS DISTINCT FROM 'string' OR p_input->>'email'<>lower(btrim(p_input->>'email'))
      OR length(p_input->>'email') NOT BETWEEN 3 AND 254 OR p_input->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      OR jsonb_typeof(p_input->'tokenHash') IS DISTINCT FROM 'string' OR p_input->>'tokenHash' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(p_input->'ttlHours') IS DISTINCT FROM 'number' OR p_input->>'ttlHours' !~ '^[0-9]{1,3}$'
      OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    v_school:=(p_input->>'schoolId')::uuid; v_ttl:=(p_input->>'ttlHours')::integer;
    IF v_ttl NOT BETWEEN 1 AND 168 THEN RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    SELECT s.organization_id INTO v_org FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id
      WHERE s.id=v_school AND s.status='ACTIVE' AND o.status='ACTIVE';
    IF v_org IS NULL OR NOT EXISTS(SELECT 1 FROM hon.roles WHERE organization_id=v_org AND code='OWNER' AND is_system_role) THEN
      RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    IF EXISTS(SELECT 1 FROM hon.school_owner_invitations WHERE school_id=v_school AND email=p_input->>'email' AND status='PENDING' AND expires_at>at) THEN
      RAISE EXCEPTION 'ACCOUNT_INVITATION_EXISTS' USING ERRCODE='23505'; END IF;
    INSERT INTO hon.school_owner_invitations(organization_id,school_id,email,token_hash,created_by,created_at,expires_at,status)
      VALUES(v_org,v_school,p_input->>'email',p_input->>'tokenHash',actor,at,at+make_interval(hours=>v_ttl),'PENDING') RETURNING * INTO i;
    -- H-5: existing owners are told before the invitation can be accepted.
    IF EXISTS(SELECT 1 FROM hon.school_owner_grant_rows(v_school,at) w WHERE w.o_live AND NOT w.o_hq) THEN
      INSERT INTO hon.school_ownership_notices(organization_id,school_id,kind,invitation_id,invited_email,occurred_at)
        VALUES(v_org,v_school,'OWNER_INVITED',i.id,i.email,at);
    END IF;
  ELSE
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['invitationId']
      OR jsonb_typeof(p_input->'invitationId') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    SELECT * INTO i FROM hon.school_owner_invitations WHERE id=(p_input->>'invitationId')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    IF i.status<>'REVOKED' THEN
      IF i.owner_grant_id IS NOT NULL THEN
        UPDATE hon.principal_role_grants SET effective_until=at WHERE id=i.owner_grant_id AND (effective_until IS NULL OR effective_until>at);
      END IF;
      UPDATE hon.school_owner_invitations SET status='REVOKED',revoked_at=at WHERE id=i.id RETURNING * INTO i;
    END IF;
  END IF;
  result:=hon.school_account_record(p_subject,p_key,fp,i.id,p_operation,hon.school_invitation_json(i));
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  RETURN result;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- H-2, H-4, H-5 at acceptance. Otherwise identical to 0206 (same receipt).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hon.accept_school_owner_invitation(p_subject text,p_verified_email text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.school_owner_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE; fp text; at timestamptz;
  v_user uuid; actor uuid; v_role uuid; v_grant uuid; issuer_subject text; result jsonb;
  had_owner boolean; ended uuid[];
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR length(p_subject)>2048 OR p_subject NOT LIKE 'oidc:%'
    OR p_verified_email IS NULL OR p_verified_email<>lower(btrim(p_verified_email))
    OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['confirmation','invitationId','tokenHash']
    OR p_input->>'confirmation' IS DISTINCT FROM 'ACCEPT_SCHOOL_OWNER_INVITATION'
    OR jsonb_typeof(p_input->'invitationId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'tokenHash') IS DISTINCT FROM 'string' OR p_input->>'tokenHash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.check_school_owner_acceptance(p_subject,p_verified_email,p_input,p_key);
  PERFORM hon.lock_school_account_authority();
  SELECT * INTO i FROM hon.school_owner_invitations WHERE id=(p_input->>'invitationId')::uuid FOR UPDATE;
  PERFORM hon.check_school_owner_acceptance(p_subject,p_verified_email,p_input,p_key);
  IF i.id IS NULL OR i.token_hash IS DISTINCT FROM p_input->>'tokenHash' OR i.email IS DISTINCT FROM p_verified_email OR i.status='REVOKED'
    OR NOT EXISTS(SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id WHERE s.id=i.school_id AND s.organization_id=i.organization_id AND s.status='ACTIVE' AND o.status='ACTIVE') THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  fp:=encode(sha256(convert_to('ACCEPT:'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF i.accepted_subject IS DISTINCT FROM p_subject OR NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id
      WHERE g.id=i.owner_grant_id AND p.is_active AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN
      RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
    RETURN prior.response;
  END IF;
  IF i.status<>'PENDING' OR i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  SELECT u.external_subject INTO issuer_subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=i.created_by;
  PERFORM hon.require_saas_hq_actor(issuer_subject,true);
  SELECT id INTO v_user FROM hon.users WHERE external_subject=p_subject;
  IF v_user IS NULL THEN
    IF EXISTS(SELECT 1 FROM hon.users WHERE lower(email::text)=p_verified_email) THEN RAISE EXCEPTION 'ACCOUNT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
    INSERT INTO hon.users(external_subject,email,display_name) VALUES(p_subject,p_verified_email,'School owner') RETURNING id INTO v_user;
    INSERT INTO hon.principals(principal_type,user_id,display_name) VALUES('HUMAN_USER',v_user,'School owner') RETURNING id INTO actor;
  ELSE
    SELECT id INTO actor FROM hon.principals WHERE user_id=v_user AND is_active AND principal_type='HUMAN_USER';
    IF actor IS NULL OR (SELECT count(*) FROM hon.principals WHERE user_id=v_user AND is_active)<>1
      OR NOT EXISTS(SELECT 1 FROM hon.users WHERE id=v_user AND lower(email::text)=p_verified_email) THEN
      RAISE EXCEPTION 'ACCOUNT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor) -- 0223: any HQ row, timed or not (staff_member_eligible rule)
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id=actor AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())
      AND (organization_id<>i.organization_id OR school_id=i.school_id)) THEN
    RAISE EXCEPTION 'ACCOUNT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT id INTO v_role FROM hon.roles WHERE organization_id=i.organization_id AND code='OWNER' AND is_system_role;
  IF v_role IS NULL THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  at:=clock_timestamp();
  IF i.expires_at<=at THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  had_owner:=EXISTS(SELECT 1 FROM hon.school_owner_grant_rows(i.school_id,at) w WHERE w.o_live AND NOT w.o_hq);
  INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
    VALUES(i.organization_id,i.school_id,actor,v_role,i.created_by,at) RETURNING id INTO v_grant;
  UPDATE hon.school_owner_invitations SET status='ACCEPTED',accepted_subject=p_subject,owner_grant_id=v_grant,accepted_at=at WHERE id=i.id RETURNING * INTO i;
  -- H-5: the owners already there are told an owner was added.
  IF had_owner THEN
    INSERT INTO hon.school_ownership_notices(organization_id,school_id,kind,invitation_id,invited_email,owner_grant_id,occurred_at)
      VALUES(i.organization_id,i.school_id,'OWNER_ADDED',i.id,i.email,v_grant,at);
  END IF;
  -- H-4: the first owner (or the first after the primary owner's grant ended) becomes primary.
  IF hon.school_live_primary_grant(i.school_id,at) IS NULL THEN
    PERFORM hon.school_set_primary_owner(i.organization_id,i.school_id,v_grant,'FIRST_OWNER',actor,at);
  END IF;
  -- H-2: HQ-held OWNER grants at this school end now that the school has a real owner.
  ended:=hon.school_end_hq_owner_grants(i.school_id,at,actor,'HUMAN_UI',p_key);
  IF cardinality(ended)>0 THEN
    INSERT INTO hon.school_ownership_notices(organization_id,school_id,kind,ended_grant_count,occurred_at)
      VALUES(i.organization_id,i.school_id,'HQ_OWNER_ACCESS_ENDED',cardinality(ended),at);
  END IF;
  result:=hon.school_account_record(p_subject,p_key,fp,i.id,'ACCEPT',hon.school_account_result(i));
  IF i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM hon.require_saas_hq_actor(issuer_subject,true);
  RETURN result;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- HQ-owner reads and commands (H-3, H-4). HQ owner only, the same authority as owner invitations.
-- ---------------------------------------------------------------------------------------------------------------------
-- One school's ownership: live non-HQ owners, primary, HQ-held OWNER grants and the exact cleanup plan, recent notices.
CREATE FUNCTION hon.read_school_ownership_from_hq(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE at timestamptz; v_org uuid; prim uuid; hq_ids uuid[]; owners integer; result jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  IF p_school IS NULL THEN RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=p_school;
  IF v_org IS NULL THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  at:=clock_timestamp();
  prim:=hon.school_live_primary_grant(p_school,at);
  SELECT coalesce(array_agg(w.o_grant ORDER BY w.o_grant),ARRAY[]::uuid[]) INTO hq_ids FROM hon.school_owner_grant_rows(p_school,at) w WHERE w.o_hq;
  SELECT count(*) INTO owners FROM hon.school_owner_grant_rows(p_school,at) w WHERE w.o_live AND NOT w.o_hq;
  result:=jsonb_build_object('schoolId',p_school,'organizationId',v_org,
    'owners',hon.school_ownership_owner_json(p_school,at,prim),
    'primaryOwnerGrantId',prim,
    'primaryNeeded',owners>0 AND prim IS NULL,
    'hqOwnerGrantIds',to_jsonb(hq_ids),
    'hqOwnerCleanup',jsonb_build_object('eligible',owners>0 AND cardinality(hq_ids)>0,
      'blocker',CASE WHEN cardinality(hq_ids)=0 THEN 'NONE_TO_END' WHEN owners=0 THEN 'SCHOOL_OWNER_REQUIRED' END,
      'expectedGrantIds',to_jsonb(hq_ids)),
    'notices',hon.school_ownership_notices_json(p_school),
    'asOf',hon.saas_ts(at));
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  RETURN result;
END $$;

-- H-3 dry run: every school where an HQ principal still holds an OWNER grant, with whether it can be ended now.
CREATE FUNCTION hon.read_hq_owner_grant_cleanup(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE at timestamptz; rows jsonb; total integer; result jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  at:=clock_timestamp();
  WITH affected AS MATERIALIZED (
    SELECT DISTINCT g.school_id FROM hon.principal_role_grants g
    JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id AND r.code='OWNER' AND r.is_system_role
    WHERE g.revoked_at IS NULL AND (g.effective_until IS NULL OR g.effective_until>at)
      AND EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=g.principal_id)
  ), plan AS MATERIALIZED (
    SELECT s.id school_id, s.organization_id, s.created_at,
      left(s.name,300) school_name, left(o.display_name,300) organization_name,
      (SELECT coalesce(array_agg(w.o_grant ORDER BY w.o_grant),ARRAY[]::uuid[]) FROM hon.school_owner_grant_rows(s.id,at) w WHERE w.o_hq) hq_ids,
      (SELECT count(*) FROM hon.school_owner_grant_rows(s.id,at) w WHERE w.o_live AND NOT w.o_hq)::integer owners
    FROM affected a JOIN hon.schools s ON s.id=a.school_id JOIN hon.organizations o ON o.id=s.organization_id
  )
  SELECT count(*)::integer, coalesce(jsonb_agg(jsonb_build_object('schoolId',p.school_id,'organizationId',p.organization_id,
      'schoolDisplayName',p.school_name,'organizationDisplayName',p.organization_name,'schoolOwnerCount',p.owners,
      'hqOwnerGrantIds',to_jsonb(p.hq_ids),'eligible',p.owners>0,
      'blocker',CASE WHEN p.owners=0 THEN 'SCHOOL_OWNER_REQUIRED' END) ORDER BY p.created_at,p.school_id)
      FILTER (WHERE p.rn<=200),'[]'::jsonb)
  INTO total, rows
  FROM (SELECT plan.*, row_number() OVER (ORDER BY plan.created_at,plan.school_id) rn FROM plan) p;
  result:=jsonb_build_object('schools',rows,'total',total,'truncated',total>200,
    'summary',jsonb_build_object('eligible',(SELECT count(*) FROM jsonb_array_elements(rows) e WHERE (e->>'eligible')::boolean),
      'needsOwner',(SELECT count(*) FROM jsonb_array_elements(rows) e WHERE NOT (e->>'eligible')::boolean)),
    'asOf',hon.saas_ts(at));
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  RETURN result;
END $$;

-- SET_PRIMARY {schoolId, ownerGrantId} and END_HQ_OWNER_GRANTS {schoolId, expectedGrantIds}.
CREATE FUNCTION hon.manage_school_ownership(p_subject text,p_operation text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior hon.school_ownership_requests%ROWTYPE; fp text; at timestamptz; v_school uuid; v_org uuid;
  v_grant uuid; prim uuid; hq_ids uuid[]; expected uuid[]; owners integer; ended uuid[]; result jsonb; changed boolean;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR p_operation IS NULL
    OR p_operation NOT IN ('SET_PRIMARY','END_HQ_OWNER_GRANTS') THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_operation='SET_PRIMARY' AND ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['ownerGrantId','schoolId']
      OR jsonb_typeof(p_input->'ownerGrantId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_operation='END_HQ_OWNER_GRANTS' AND ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedGrantIds','schoolId']
      OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'expectedGrantIds') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_input->'expectedGrantIds') NOT BETWEEN 1 AND 50
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'expectedGrantIds') e WHERE jsonb_typeof(e)<>'string')) THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid;
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  PERFORM hon.lock_school_account_authority();
  actor:=hon.require_saas_hq_actor(p_subject,true);
  fp:=encode(sha256(convert_to(p_operation||':'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_ownership_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    PERFORM hon.require_saas_hq_actor(p_subject,true);
    RETURN prior.response;
  END IF;
  SELECT s.organization_id INTO v_org FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id
    WHERE s.id=v_school AND s.status='ACTIVE' AND o.status='ACTIVE';
  IF v_org IS NULL THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  at:=clock_timestamp();
  IF p_operation='SET_PRIMARY' THEN
    v_grant:=(p_input->>'ownerGrantId')::uuid;
    IF NOT EXISTS(SELECT 1 FROM hon.school_owner_grant_rows(v_school,at) w WHERE w.o_grant=v_grant AND w.o_live AND NOT w.o_hq) THEN
      RAISE EXCEPTION 'OWNERSHIP_OWNER_NOT_LIVE' USING ERRCODE='P0002'; END IF;
    prim:=hon.school_live_primary_grant(v_school,at);
    changed:=prim IS DISTINCT FROM v_grant;
    IF changed THEN
      PERFORM hon.school_set_primary_owner(v_org,v_school,v_grant,'HQ_DESIGNATED',actor,at);
      INSERT INTO hon.school_ownership_notices(organization_id,school_id,kind,owner_grant_id,occurred_at)
        VALUES(v_org,v_school,'PRIMARY_OWNER_CHANGED',v_grant,at);
      INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
        prior_state, next_state, result, request_id, correlation_id, occurred_at)
      VALUES (v_org, v_school, actor, 'HON_HQ', 'school.owner.primary.set', 'PRINCIPAL_ROLE_GRANT', v_grant,
        jsonb_build_object('primaryOwnerGrantId', prim), jsonb_build_object('primaryOwnerGrantId', v_grant), 'SUCCEEDED', p_key, p_key, at);
    END IF;
    result:=jsonb_build_object('operation','SET_PRIMARY','schoolId',v_school,'organizationId',v_org,
      'primaryOwnerGrantId',v_grant,'changed',changed,'endedGrantIds','[]'::jsonb);
  ELSE
    SELECT coalesce(array_agg(DISTINCT e::uuid ORDER BY e::uuid),ARRAY[]::uuid[]) INTO expected FROM jsonb_array_elements_text(p_input->'expectedGrantIds') e;
    IF cardinality(expected)<>jsonb_array_length(p_input->'expectedGrantIds') THEN RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    SELECT coalesce(array_agg(w.o_grant ORDER BY w.o_grant),ARRAY[]::uuid[]) INTO hq_ids FROM hon.school_owner_grant_rows(v_school,at) w WHERE w.o_hq;
    SELECT count(*) INTO owners FROM hon.school_owner_grant_rows(v_school,at) w WHERE w.o_live AND NOT w.o_hq;
    IF owners=0 THEN RAISE EXCEPTION 'OWNERSHIP_SCHOOL_OWNER_REQUIRED' USING ERRCODE='23514'; END IF;
    -- The command ends exactly the set the dry run showed; anything else changed since the read.
    IF hq_ids IS DISTINCT FROM expected THEN RAISE EXCEPTION 'OWNERSHIP_PLAN_CHANGED' USING ERRCODE='40001'; END IF;
    ended:=hon.school_end_hq_owner_grants(v_school,at,actor,'HON_HQ',p_key);
    IF ended IS DISTINCT FROM expected THEN RAISE EXCEPTION 'OWNERSHIP_PLAN_CHANGED' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.school_ownership_notices(organization_id,school_id,kind,ended_grant_count,occurred_at)
      VALUES(v_org,v_school,'HQ_OWNER_ACCESS_ENDED',cardinality(ended),at);
    result:=jsonb_build_object('operation','END_HQ_OWNER_GRANTS','schoolId',v_school,'organizationId',v_org,
      'primaryOwnerGrantId',hon.school_live_primary_grant(v_school,at),'changed',true,'endedGrantIds',to_jsonb(ended));
  END IF;
  INSERT INTO hon.school_ownership_requests(subject,idempotency_key,operation,fingerprint,response,occurred_at)
    VALUES(p_subject,p_key,p_operation,fp,result,at);
  -- Decide authority after the last durable write (0206 rule).
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  RETURN result;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- School-owner read (H-5 notices, H-4 primary). Only a live non-HQ OWNER of that exact school.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION hon.read_school_ownership(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE at timestamptz; me uuid; prim uuid; result jsonb;
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 2048 OR p_school IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  at:=clock_timestamp();
  SELECT w.o_grant INTO me FROM hon.school_owner_grant_rows(p_school,at) w
    JOIN hon.principals p ON p.id=w.o_principal JOIN hon.users u ON u.id=p.user_id
    WHERE u.external_subject=p_subject AND w.o_live AND NOT w.o_hq
    ORDER BY w.o_grant LIMIT 1;
  IF me IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  prim:=hon.school_live_primary_grant(p_school,at);
  result:=jsonb_build_object('schoolId',p_school,
    'owners',hon.school_ownership_owner_json(p_school,at,prim),
    'yourOwnerGrantId',me,
    'primaryOwnerGrantId',prim,
    'notices',hon.school_ownership_notices_json(p_school),
    'asOf',hon.saas_ts(at));
  -- The caller must still be a live non-HQ owner of this school after the read.
  IF NOT EXISTS(SELECT 1 FROM hon.school_owner_grant_rows(p_school,clock_timestamp()) w JOIN hon.principals p ON p.id=w.o_principal
      JOIN hon.users u ON u.id=p.user_id WHERE w.o_grant=me AND u.external_subject=p_subject AND w.o_live AND NOT w.o_hq) THEN
    RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Deny-first grants: only the four entry points reach hon_runtime.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$ DECLARE t text; r text; f text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_primary_owners','school_ownership_notices','school_ownership_requests'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['school_owner_review_or_busy(uuid)','guard_school_primary_owner()','school_owner_grant_rows(uuid,timestamptz)','school_live_primary_grant(uuid,timestamptz)',
    'school_set_primary_owner(uuid,uuid,uuid,text,uuid,timestamptz)','school_end_hq_owner_grants(uuid,timestamptz,uuid,text,uuid)',
    'school_ownership_owner_json(uuid,timestamptz,uuid)','school_ownership_notices_json(uuid)',
    'read_school_ownership_from_hq(text,uuid)','read_hq_owner_grant_cleanup(text)','manage_school_ownership(text,text,jsonb,uuid)',
    'read_school_ownership(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_ownership_from_hq(text,uuid),hon.read_hq_owner_grant_cleanup(text),
      hon.manage_school_ownership(text,text,jsonb,uuid),hon.read_school_ownership(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
