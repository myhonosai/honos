BEGIN;

-- Sprint 2 parent/guardian account linking (provisional number 0205; the owner allocates the final number).
-- A school family manager invites one email to one EXISTING active family at one school with one access
-- level. Accepting with a HON-verified OIDC email creates (or reuses a clean) identity and inserts exactly
-- one family_access_grants row, but only while the issuer still holds the authority to link that family.
-- The manager can later end that access. No entitlement, billing, credit, AI, CRM or outbox effect.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

CREATE TABLE hon.school_family_access_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id),
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  access_level hon.family_access_level NOT NULL,
  email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('PENDING','ACCEPTED','REVOKED','ENDED')),
  accepted_subject text,
  access_grant_id uuid UNIQUE REFERENCES hon.family_access_grants(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  ended_at timestamptz,
  ended_by uuid REFERENCES hon.principals(id),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  FOREIGN KEY(family_id,organization_id,school_id) REFERENCES hon.families(id,organization_id,school_id),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days'),
  CHECK((accepted_subject IS NULL AND access_grant_id IS NULL AND accepted_at IS NULL)
    OR (accepted_subject IS NOT NULL AND access_grant_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK((ended_at IS NULL)=(ended_by IS NULL)),
  CHECK((status='PENDING' AND accepted_at IS NULL AND revoked_at IS NULL AND ended_at IS NULL)
    OR (status='ACCEPTED' AND accepted_at IS NOT NULL AND revoked_at IS NULL AND ended_at IS NULL)
    OR (status='REVOKED' AND revoked_at IS NOT NULL AND accepted_at IS NULL AND ended_at IS NULL)
    OR (status='ENDED' AND accepted_at IS NOT NULL AND ended_at IS NOT NULL AND revoked_at IS NULL))
);
CREATE INDEX school_family_access_invitations_school ON hon.school_family_access_invitations(school_id,created_at DESC,id);

-- Private immutable audit + structurally inert outbox (never the claimable domain outbox).
-- Requests reuse hon.school_account_requests, so one (subject, key) is single-use across every account flow.
CREATE TABLE hon.school_family_account_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES hon.school_family_access_invitations(id),
  subject text NOT NULL,
  idempotency_key uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('INVITE','ACCEPT','REVOKE','END')),
  occurred_at timestamptz NOT NULL,
  receipt jsonb NOT NULL,
  execution_allowed boolean NOT NULL DEFAULT false CHECK(NOT execution_allowed),
  FOREIGN KEY(subject,idempotency_key) REFERENCES hon.school_account_requests(subject,idempotency_key),
  UNIQUE(subject,idempotency_key)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.school_family_account_events FOR EACH ROW EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_family_account_events FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();

CREATE FUNCTION hon.guard_school_family_access_invitation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND ((OLD.status='PENDING' AND NEW.status IN ('ACCEPTED','REVOKED')) OR (OLD.status='ACCEPTED' AND NEW.status='ENDED'))
    AND (to_jsonb(NEW)-ARRAY['status','accepted_subject','access_grant_id','accepted_at','revoked_at','ended_at','ended_by'])=
        (to_jsonb(OLD)-ARRAY['status','accepted_subject','access_grant_id','accepted_at','revoked_at','ended_at','ended_by'])
    AND (OLD.status='PENDING' OR (NEW.accepted_subject,NEW.access_grant_id,NEW.accepted_at) IS NOT DISTINCT FROM (OLD.accepted_subject,OLD.access_grant_id,OLD.accepted_at))
    THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ACCOUNT_EVIDENCE_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.school_family_access_invitations FOR EACH ROW EXECUTE FUNCTION hon.guard_school_family_access_invitation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_family_access_invitations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_family_access_invitation();

-- The live family-manager principal for this exact school, or NULL: family.member.manage and family.read
-- at the exact school (0024), active human, single principal. Fail closed for paid access (B6A 0172
-- predicate): a suspended, lapsed or not-yet-started organization cannot invite, list,
-- or have an outstanding invitation accepted.
CREATE FUNCTION hon.school_family_access_manager(p_subject text,p_school uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT s.principal_id FROM hon.resolve_authorized_scope(p_subject,p_school,'family.member.manage') s
  WHERE hon.principal_has_school_permission(s.principal_id,s.organization_id,p_school,'family.member.manage')
    AND hon.principal_has_school_permission(s.principal_id,s.organization_id,p_school,'family.read')
    AND EXISTS(SELECT 1 FROM hon.principals p WHERE p.id=s.principal_id AND p.is_active AND p.principal_type='HUMAN_USER')
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=s.organization_id AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

-- Owner decision 2026-11-04 (security/custody): the same family manager may still REVOKE a pending invitation
-- or END existing guardian access while the organization's paid access is suspended, lapsed or not yet
-- started. This narrow exception never covers invite, list or accept.
CREATE FUNCTION hon.school_family_access_revoker(p_subject text,p_school uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT s.principal_id FROM hon.resolve_authorized_scope(p_subject,p_school,'family.member.manage') s
  WHERE hon.principal_has_school_permission(s.principal_id,s.organization_id,p_school,'family.member.manage')
    AND hon.principal_has_school_permission(s.principal_id,s.organization_id,p_school,'family.read')
    AND EXISTS(SELECT 1 FROM hon.principals p WHERE p.id=s.principal_id AND p.is_active AND p.principal_type='HUMAN_USER')
$$;
CREATE FUNCTION hon.school_family_access_actor(p_subject text,p_school uuid,p_operation text) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN p_operation IN ('REVOKE','END') THEN hon.school_family_access_revoker(p_subject,p_school)
    ELSE hon.school_family_access_manager(p_subject,p_school) END
$$;

CREATE FUNCTION hon.school_family_access_invitation_json(i hon.school_family_access_invitations) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('invitationId',i.id,'schoolId',i.school_id,'familyId',i.family_id,
    'familyName',(SELECT f.display_name FROM hon.families f WHERE f.id=i.family_id),
    'accessLevel',i.access_level::text,'email',i.email,'expiresAt',hon.saas_ts(i.expires_at),
    'status',CASE WHEN i.status='PENDING' AND i.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE i.status END)
$$;
CREATE FUNCTION hon.school_family_account_result(i hon.school_family_access_invitations) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('invitationId',i.id,'schoolId',i.school_id,'familyId',i.family_id,'accessLevel',i.access_level::text,
    'accountStatus','FAMILY_ACCESS_BOUND','accessGranted',false,'billingActivated',false,'aiCreditsGranted',false)
$$;
CREATE FUNCTION hon.school_family_account_record(p_subject text,p_key uuid,p_fingerprint text,p_invitation uuid,p_action text,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  INSERT INTO hon.school_account_requests VALUES(p_subject,p_key,p_fingerprint,p_result);
  INSERT INTO hon.school_family_account_events(invitation_id,subject,idempotency_key,action,occurred_at,receipt)
    VALUES(p_invitation,p_subject,p_key,p_action,clock_timestamp(),p_result);
  RETURN p_result;
END $$;

-- Who may accept. A new identity is created only when no existing user has this verified email (never
-- merge by email). An existing identity must be one clean human principal with that email, not the
-- issuer, with no HQ grant, no live staff role grant anywhere (mixed staff/parent identities are an
-- owner decision, so they fail closed), no live family grant in another organization and no live grant
-- to this family.
CREATE FUNCTION hon.school_family_acceptor_conflict(p_subject text,p_verified_email text,i hon.school_family_access_invitations) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE v_user uuid; actor uuid;
BEGIN
  SELECT id INTO v_user FROM hon.users WHERE external_subject=p_subject;
  IF v_user IS NULL THEN RETURN EXISTS(SELECT 1 FROM hon.users WHERE lower(email::text)=p_verified_email); END IF;
  SELECT id INTO actor FROM hon.principals WHERE user_id=v_user AND is_active AND principal_type='HUMAN_USER';
  RETURN actor IS NULL OR actor=i.created_by
    OR (SELECT count(*) FROM hon.principals WHERE user_id=v_user AND is_active)<>1
    OR NOT EXISTS(SELECT 1 FROM hon.users WHERE id=v_user AND lower(email::text)=p_verified_email)
    OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id=actor AND revoked_at IS NULL
      AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor
      AND (effective_until IS NULL OR effective_until>clock_timestamp())
      AND (organization_id<>i.organization_id OR family_id=i.family_id));
END $$;

-- Low-volume IAM onboarding reuses the 0191 authority envelope: one advisory lock plus NOWAIT
-- SHARE ROW EXCLUSIVE on every IAM table (family_access_grants included), so authority read after
-- the lock cannot change before commit. Operations: INVITE, REVOKE (pending only), END (accepted only).
-- INVITE needs live paid access; REVOKE and END stay available during a suspension (owner decision).
CREATE FUNCTION hon.manage_school_family_access_invitation(p_subject text,p_operation text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; i hon.school_family_access_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE;
  fp text; at timestamptz; v_org uuid; v_school uuid; v_family uuid; v_ttl integer; result jsonb;
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR p_operation IS NULL OR p_operation NOT IN ('INVITE','REVOKE','END')
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid;
  IF hon.school_family_access_actor(p_subject,v_school,p_operation) IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM hon.lock_school_account_authority();
  actor:=hon.school_family_access_actor(p_subject,v_school,p_operation);
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=v_school;
  fp:=encode(sha256(convert_to('FAMILY:'||p_operation||':'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN prior.response;
  END IF;
  at:=clock_timestamp();
  IF p_operation='INVITE' THEN
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['accessLevel','email','familyId','schoolId','tokenHash','ttlHours']
      OR jsonb_typeof(p_input->'email') IS DISTINCT FROM 'string' OR p_input->>'email'<>lower(btrim(p_input->>'email'))
      OR length(p_input->>'email') NOT BETWEEN 3 AND 254 OR p_input->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      OR jsonb_typeof(p_input->'tokenHash') IS DISTINCT FROM 'string' OR p_input->>'tokenHash' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(p_input->'ttlHours') IS DISTINCT FROM 'number' OR p_input->>'ttlHours' !~ '^[0-9]{1,3}$'
      OR jsonb_typeof(p_input->'accessLevel') IS DISTINCT FROM 'string' OR p_input->>'accessLevel' NOT IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN','VIEWER')
      OR jsonb_typeof(p_input->'familyId') IS DISTINCT FROM 'string' OR p_input->>'familyId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    v_ttl:=(p_input->>'ttlHours')::integer; v_family:=(p_input->>'familyId')::uuid;
    IF v_ttl NOT BETWEEN 1 AND 168 THEN RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    -- Exact school only: a family from another school is indistinguishable from a missing one.
    PERFORM 1 FROM hon.families WHERE id=v_family AND organization_id=v_org AND school_id=v_school AND status='ACTIVE' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    IF EXISTS(SELECT 1 FROM hon.school_family_access_invitations WHERE family_id=v_family AND email=p_input->>'email' AND status='PENDING' AND expires_at>at) THEN
      RAISE EXCEPTION 'ACCOUNT_INVITATION_EXISTS' USING ERRCODE='23505'; END IF;
    INSERT INTO hon.school_family_access_invitations(organization_id,school_id,family_id,access_level,email,token_hash,created_by,created_at,expires_at,status)
      VALUES(v_org,v_school,v_family,(p_input->>'accessLevel')::hon.family_access_level,p_input->>'email',p_input->>'tokenHash',actor,at,at+make_interval(hours=>v_ttl),'PENDING') RETURNING * INTO i;
  ELSE
    IF (p_operation='REVOKE' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['invitationId','schoolId'])
      OR (p_operation='END' AND ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['confirmation','invitationId','schoolId']
        OR p_input->>'confirmation' IS DISTINCT FROM 'END_FAMILY_ACCESS'))
      OR jsonb_typeof(p_input->'invitationId') IS DISTINCT FROM 'string' OR p_input->>'invitationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    -- Exact school only: an invitation id from another school is indistinguishable from a missing one.
    SELECT * INTO i FROM hon.school_family_access_invitations WHERE id=(p_input->>'invitationId')::uuid AND school_id=v_school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    IF p_operation='REVOKE' THEN
      -- An accepted invitation is not revoked: ending that access is the explicit END command.
      IF i.status IN ('ACCEPTED','ENDED') THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_ACCEPTED' USING ERRCODE='23514'; END IF;
      IF i.status='PENDING' THEN
        UPDATE hon.school_family_access_invitations SET status='REVOKED',revoked_at=at WHERE id=i.id RETURNING * INTO i;
      END IF;
    ELSE
      IF i.status IN ('PENDING','REVOKED') THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_NOT_ACCEPTED' USING ERRCODE='23514'; END IF;
      IF i.status='ACCEPTED' THEN
        -- Ends exactly the grant this invitation created; a grant already ended keeps its earlier end.
        UPDATE hon.family_access_grants SET effective_until=at
          WHERE id=i.access_grant_id AND (effective_until IS NULL OR effective_until>at) AND effective_from<at;
        UPDATE hon.school_family_access_invitations SET status='ENDED',ended_at=at,ended_by=actor WHERE id=i.id RETURNING * INTO i;
      END IF;
    END IF;
  END IF;
  result:=hon.school_family_account_record(p_subject,p_key,fp,i.id,p_operation,hon.school_family_access_invitation_json(i));
  -- Decision point AFTER every durable write, including the evidence row: authority that expired at any
  -- instant up to here (grant window, and paid access for INVITE, all judged on clock_timestamp()) aborts
  -- the statement, so no invitation, grant end, request or evidence row survives. REVOKE/END keep the
  -- owner-approved suspension exception: the revoker check needs no paid access, before or after.
  IF hon.school_family_access_actor(p_subject,v_school,p_operation) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Email and subject originate ONLY in the HON-signed OIDC session, never in the request body.
CREATE FUNCTION hon.accept_school_family_access_invitation(p_subject text,p_verified_email text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.school_family_access_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE; fp text; at timestamptz;
  v_user uuid; actor uuid; v_grant uuid; issuer_subject text; result jsonb;
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR length(p_subject)>2048 OR p_subject NOT LIKE 'oidc:%'
    OR p_verified_email IS NULL OR p_verified_email<>lower(btrim(p_verified_email))
    OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['confirmation','invitationId','tokenHash']
    OR p_input->>'confirmation' IS DISTINCT FROM 'ACCEPT_FAMILY_ACCESS_INVITATION'
    OR jsonb_typeof(p_input->'invitationId') IS DISTINCT FROM 'string' OR p_input->>'invitationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'tokenHash') IS DISTINCT FROM 'string' OR p_input->>'tokenHash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  -- Cheap uniform pre-check before taking the global authority envelope.
  SELECT * INTO i FROM hon.school_family_access_invitations WHERE id=(p_input->>'invitationId')::uuid;
  IF i.id IS NULL OR i.token_hash IS DISTINCT FROM p_input->>'tokenHash' OR i.email IS DISTINCT FROM p_verified_email OR i.status='REVOKED' THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM hon.lock_school_account_authority();
  SELECT * INTO i FROM hon.school_family_access_invitations WHERE id=(p_input->>'invitationId')::uuid FOR UPDATE;
  -- Uniform failure: no invitation, wrong identity/email/token, revoked, inactive school or family disclose nothing.
  IF i.id IS NULL OR i.token_hash IS DISTINCT FROM p_input->>'tokenHash' OR i.email IS DISTINCT FROM p_verified_email OR i.status='REVOKED'
    OR NOT EXISTS(SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id WHERE s.id=i.school_id AND s.organization_id=i.organization_id AND s.status='ACTIVE' AND o.status='ACTIVE') THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  fp:=encode(sha256(convert_to('FAMILY:ACCEPT:'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    -- A replay never revives ended access.
    IF i.status<>'ACCEPTED' OR i.accepted_subject IS DISTINCT FROM p_subject OR NOT EXISTS(SELECT 1 FROM hon.family_access_grants g JOIN hon.principals p ON p.id=g.principal_id
      WHERE g.id=i.access_grant_id AND p.is_active AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN
      RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
    RETURN prior.response;
  END IF;
  IF i.status<>'PENDING' OR i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  -- The family must still be active at the exact school; held FOR SHARE until commit.
  PERFORM 1 FROM hon.families WHERE id=i.family_id AND organization_id=i.organization_id AND school_id=i.school_id AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  -- The issuer's authority is re-proven NOW, under the IAM locks: a revoked/downgraded issuer, or a
  -- lapsed/suspended organization, makes the outstanding invitation unusable.
  SELECT u.external_subject INTO issuer_subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=i.created_by;
  IF hon.school_family_access_manager(issuer_subject,i.school_id) IS DISTINCT FROM i.created_by THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  IF hon.school_family_acceptor_conflict(p_subject,p_verified_email,i) THEN RAISE EXCEPTION 'ACCOUNT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT id INTO v_user FROM hon.users WHERE external_subject=p_subject;
  IF v_user IS NULL THEN
    INSERT INTO hon.users(external_subject,email,display_name) VALUES(p_subject,p_verified_email,'Family member') RETURNING id INTO v_user;
    INSERT INTO hon.principals(principal_type,user_id,display_name) VALUES('HUMAN_USER',v_user,'Family member') RETURNING id INTO actor;
  ELSE
    SELECT id INTO actor FROM hon.principals WHERE user_id=v_user AND is_active AND principal_type='HUMAN_USER';
  END IF;
  at:=clock_timestamp();
  IF i.expires_at<=at THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id,created_at)
    VALUES(i.organization_id,i.school_id,i.family_id,actor,i.access_level,at,i.created_by,at) RETURNING id INTO v_grant;
  UPDATE hon.school_family_access_invitations SET status='ACCEPTED',accepted_subject=p_subject,access_grant_id=v_grant,accepted_at=at WHERE id=i.id RETURNING * INTO i;
  result:=hon.school_family_account_record(p_subject,p_key,fp,i.id,'ACCEPT',hon.school_family_account_result(i));
  -- Decision point AFTER the identity, family grant and evidence writes: the invitation window and the
  -- issuer's authority (grant window, paid access) must still hold now, or nothing survives.
  IF i.expires_at<=clock_timestamp() OR hon.school_family_access_manager(issuer_subject,i.school_id) IS DISTINCT FROM i.created_by THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

CREATE FUNCTION hon.read_school_family_access_invitations(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL OR hon.school_family_access_manager(p_subject,p_school) IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  result:=(SELECT coalesce(jsonb_agg(hon.school_family_access_invitation_json(i) ORDER BY i.created_at DESC,i.id),'[]'::jsonb)
    FROM (SELECT * FROM hon.school_family_access_invitations WHERE school_id=p_school ORDER BY created_at DESC,id LIMIT 50) i);
  IF hon.school_family_access_manager(p_subject,p_school) IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

DO $$ DECLARE t text; r text; f text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_family_access_invitations','school_family_account_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_school_family_access_invitation()','school_family_access_manager(text,uuid)','school_family_access_revoker(text,uuid)','school_family_access_actor(text,uuid,text)',
    'school_family_access_invitation_json(hon.school_family_access_invitations)','school_family_account_result(hon.school_family_access_invitations)',
    'school_family_account_record(text,uuid,text,uuid,text,jsonb)','school_family_acceptor_conflict(text,text,hon.school_family_access_invitations)',
    'manage_school_family_access_invitation(text,text,jsonb,uuid)','accept_school_family_access_invitation(text,text,jsonb,uuid)','read_school_family_access_invitations(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.manage_school_family_access_invitation(text,text,jsonb,uuid),hon.accept_school_family_access_invitation(text,text,jsonb,uuid),hon.read_school_family_access_invitations(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
