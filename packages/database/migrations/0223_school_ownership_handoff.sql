BEGIN;

-- B-ID-4 school ownership handoff (proposed number 0223; the owner allocates the final number).
-- Owner decisions 2026-11-08: H-4 and H-5 approved; H-1..H-3 were approved at 21:39Z and then replaced at 22:59Z by
-- "Keep HQ owner seats" (HQ needs access to every school and organization to fix or change things):
--   HQ seats kept: provisioning still grants the school OWNER role to the HQ person who provisions it (0208, unchanged
--       here), and accepting an owner invitation leaves every HQ-held OWNER grant alone. There is no HQ cleanup command.
--   H-4 A school may have several owners; one is the primary owner (billing contact and recovery). The first non-HQ owner
--       to accept becomes primary when no live primary exists; an HQ owner may designate another live non-HQ owner.
--   H-5 HQ may invite or add an owner where one already exists; the existing owners get an in-app notice (no consent
--       step, no email or other delivery).
-- HQ seats are shown to HQ (hqOwnerGrantIds) but are not listed as school owners and can never be primary.
-- Unchanged: invitation tables, tokens, TTLs, replay and fingerprint rules, receipts, NOWAIT authority envelope, D9
-- SUSPENDED placeholder entitlement, provisioning (0208) as a whole. No entitlement, billing, payment, AI credit or
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
  kind text NOT NULL CHECK (kind IN ('OWNER_INVITED','OWNER_ADDED','PRIMARY_OWNER_CHANGED')),
  invitation_id uuid REFERENCES hon.school_owner_invitations(id),
  invited_email text,
  owner_grant_id uuid REFERENCES hon.principal_role_grants(id),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id),
  CHECK ((kind = 'OWNER_INVITED' AND invitation_id IS NOT NULL AND invited_email IS NOT NULL AND owner_grant_id IS NULL)
    OR (kind = 'OWNER_ADDED' AND invitation_id IS NOT NULL AND invited_email IS NOT NULL AND owner_grant_id IS NOT NULL)
    OR (kind = 'PRIMARY_OWNER_CHANGED' AND invitation_id IS NULL AND invited_email IS NULL AND owner_grant_id IS NOT NULL))
);
CREATE INDEX school_ownership_notices_school_idx ON hon.school_ownership_notices (school_id, occurred_at DESC, id);
CREATE TABLE hon.school_ownership_requests (
  subject text NOT NULL,
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('SET_PRIMARY')),
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
      'invitedEmail', n.invited_email) ORDER BY n.occurred_at DESC, n.id), '[]'::jsonb)
  FROM (SELECT * FROM hon.school_ownership_notices WHERE school_id = p_school ORDER BY occurred_at DESC, id LIMIT 50) n
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Preflight race (found by the 0191 concurrent-acceptance proof once acceptance does more work): the lock-free preflight
-- runs several READ COMMITTED statements, so it can read the invitation as PENDING and then see the user row that a
-- concurrent acceptance of the same invitation just committed, and wrongly answer ACCOUNT_REVIEW_REQUIRED. Before that
-- answer, re-read the invitation: if it is no longer PENDING the facts moved underneath, so answer the recoverable
-- ACCOUNT_BUSY (an explicit same-key retry then replays). It and the acceptance also refuse an accepting identity with ANY
-- hq_operator_grants row (0191 refused only a current one), the staff_member_eligible rule: HQ people reach a school
-- through their HQ seat, never as an invited school owner. Otherwise identical to 0191.
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
-- H-4, H-5 at acceptance; HQ seats at the school are left alone. Otherwise identical to 0206 (same receipt).
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hon.accept_school_owner_invitation(p_subject text,p_verified_email text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.school_owner_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE; fp text; at timestamptz;
  v_user uuid; actor uuid; v_role uuid; v_grant uuid; issuer_subject text; result jsonb;
  had_owner boolean;
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
  result:=hon.school_account_record(p_subject,p_key,fp,i.id,'ACCEPT',hon.school_account_result(i));
  IF i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM hon.require_saas_hq_actor(issuer_subject,true);
  RETURN result;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- HQ-owner read and command (H-4). HQ owner only, the same authority as owner invitations.
-- ---------------------------------------------------------------------------------------------------------------------
-- One school's ownership: live non-HQ owners, primary, HQ-held OWNER grants (HQ seats, kept), recent notices.
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
    'notices',hon.school_ownership_notices_json(p_school),
    'asOf',hon.saas_ts(at));
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  RETURN result;
END $$;

-- SET_PRIMARY {schoolId, ownerGrantId}.
CREATE FUNCTION hon.manage_school_ownership(p_subject text,p_operation text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior hon.school_ownership_requests%ROWTYPE; fp text; at timestamptz; v_school uuid; v_org uuid;
  v_grant uuid; prim uuid; result jsonb; changed boolean;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR p_operation IS NULL
    OR p_operation NOT IN ('SET_PRIMARY') THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_operation='SET_PRIMARY' AND ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['ownerGrantId','schoolId']
      OR jsonb_typeof(p_input->'ownerGrantId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string') THEN
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
      'primaryOwnerGrantId',v_grant,'changed',changed);
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
-- Deny-first grants: only the three entry points reach hon_runtime.
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
    'school_set_primary_owner(uuid,uuid,uuid,text,uuid,timestamptz)',
    'school_ownership_owner_json(uuid,timestamptz,uuid)','school_ownership_notices_json(uuid)',
    'read_school_ownership_from_hq(text,uuid)','manage_school_ownership(text,text,jsonb,uuid)',
    'read_school_ownership(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_ownership_from_hq(text,uuid),
      hon.manage_school_ownership(text,text,jsonb,uuid),hon.read_school_ownership(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
