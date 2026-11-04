BEGIN;

-- Sprint 2 staff provisioning (provisional number 0204; the owner allocates the final number).
-- A school staff manager invites one email to one existing CUSTOM role at one school. Accepting
-- with a HON-verified OIDC email creates (or reuses a clean) identity and grants exactly that role,
-- but only while the issuer still holds the authority to grant it. No entitlement, billing or AI effect.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

CREATE TABLE hon.school_staff_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id),
  school_id uuid NOT NULL,
  role_id uuid NOT NULL,
  email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('PENDING','ACCEPTED','REVOKED')),
  accepted_subject text,
  role_grant_id uuid UNIQUE REFERENCES hon.principal_role_grants(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  FOREIGN KEY(role_id,organization_id) REFERENCES hon.roles(id,organization_id),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days'),
  CHECK((accepted_subject IS NULL AND role_grant_id IS NULL AND accepted_at IS NULL)
    OR (accepted_subject IS NOT NULL AND role_grant_id IS NOT NULL AND accepted_at IS NOT NULL)),
  -- An accepted invitation is final. Ending the resulting grant uses the existing iam.staff_role.revoke
  -- command, which keeps its final-owner-coverage and self-mutation protections.
  CHECK((status='PENDING' AND accepted_at IS NULL AND revoked_at IS NULL)
    OR (status='ACCEPTED' AND accepted_at IS NOT NULL AND revoked_at IS NULL)
    OR (status='REVOKED' AND revoked_at IS NOT NULL AND accepted_at IS NULL))
);
CREATE INDEX school_staff_invitations_school ON hon.school_staff_invitations(school_id,created_at DESC,id);

-- Private immutable audit + structurally inert outbox (never the claimable domain outbox).
-- Requests reuse hon.school_account_requests, so one (subject, key) is single-use across every account flow.
CREATE TABLE hon.school_staff_account_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES hon.school_staff_invitations(id),
  subject text NOT NULL,
  idempotency_key uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('INVITE','ACCEPT','REVOKE')),
  occurred_at timestamptz NOT NULL,
  receipt jsonb NOT NULL,
  execution_allowed boolean NOT NULL DEFAULT false CHECK(NOT execution_allowed),
  FOREIGN KEY(subject,idempotency_key) REFERENCES hon.school_account_requests(subject,idempotency_key),
  UNIQUE(subject,idempotency_key)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.school_staff_account_events FOR EACH ROW EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_staff_account_events FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();

CREATE FUNCTION hon.guard_school_staff_invitation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status='PENDING' AND NEW.status IN ('ACCEPTED','REVOKED')
    AND (to_jsonb(NEW)-ARRAY['status','accepted_subject','role_grant_id','accepted_at','revoked_at'])=
        (to_jsonb(OLD)-ARRAY['status','accepted_subject','role_grant_id','accepted_at','revoked_at'])
    THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ACCOUNT_EVIDENCE_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.school_staff_invitations FOR EACH ROW EXECUTE FUNCTION hon.guard_school_staff_invitation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_staff_invitations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_staff_invitation();

-- The live staff-manager principal for this exact school, or NULL. Same predicate as
-- iam.staff_role.grant (0059): both permissions at the exact school, active human, single principal.
-- Fail closed for paid access (B6A 0172 predicate): a suspended, lapsed or not-yet-started organization
-- cannot invite, revoke, list, or have an outstanding invitation accepted.
CREATE FUNCTION hon.school_staff_manager(p_subject text,p_school uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT s.principal_id FROM hon.resolve_authorized_scope(p_subject,p_school,'iam.staff_role.manage') s
  WHERE hon.principal_has_school_permission(s.principal_id,s.organization_id,p_school,'iam.staff_role.manage')
    AND hon.principal_has_school_permission(s.principal_id,s.organization_id,p_school,'iam.staff_role.grant')
    AND EXISTS(SELECT 1 FROM hon.principals p WHERE p.id=s.principal_id AND p.is_active AND p.principal_type='HUMAN_USER')
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=s.organization_id AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

-- The same role eligibility the existing grant command applies (0059): an organization role usable at
-- this school, never system/OWNER/HQ/platform, at least one permission, every permission staff-assignable
-- and currently held by the issuer at this school (no privilege escalation through an invitation).
CREATE FUNCTION hon.school_staff_role_grantable(p_actor uuid,p_org uuid,p_school uuid,p_role uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.roles r WHERE r.id=p_role AND r.organization_id=p_org
      AND (r.management_school_id IS NULL OR r.management_school_id=p_school)
      AND NOT r.is_system_role AND r.code !~ '^(OWNER|HON_|HQ|PLATFORM|SYSTEM)'
      AND EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=r.id))
    AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp JOIN hon.permissions d ON d.code=rp.permission_code
      WHERE rp.role_id=p_role AND (NOT d.is_staff_assignable OR rp.permission_code ~ '^(hq|platform|system)\.'
        OR NOT hon.principal_has_school_permission(p_actor,p_org,p_school,rp.permission_code)))
$$;

CREATE FUNCTION hon.school_staff_invitation_json(i hon.school_staff_invitations) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('invitationId',i.id,'schoolId',i.school_id,'roleId',i.role_id,
    'roleName',(SELECT r.name FROM hon.roles r WHERE r.id=i.role_id),
    'email',i.email,'expiresAt',hon.saas_ts(i.expires_at),
    'status',CASE WHEN i.status='PENDING' AND i.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE i.status END)
$$;
CREATE FUNCTION hon.school_staff_account_result(i hon.school_staff_invitations) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('invitationId',i.id,'schoolId',i.school_id,'roleId',i.role_id,
    'accountStatus','STAFF_ROLE_BOUND','accessGranted',false,'billingActivated',false,'aiCreditsGranted',false)
$$;
CREATE FUNCTION hon.school_staff_account_record(p_subject text,p_key uuid,p_fingerprint text,p_invitation uuid,p_action text,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  INSERT INTO hon.school_account_requests VALUES(p_subject,p_key,p_fingerprint,p_result);
  INSERT INTO hon.school_staff_account_events(invitation_id,subject,idempotency_key,action,occurred_at,receipt)
    VALUES(p_invitation,p_subject,p_key,p_action,clock_timestamp(),p_result);
  RETURN p_result;
END $$;

-- Who may accept. A new identity is created only when no existing user has this verified email
-- (never merge by email). An existing identity must be one clean human principal with that email,
-- no HQ grant, no family grant, no grant in another organization, no current grant at this school,
-- and must not be the issuer.
CREATE FUNCTION hon.school_staff_acceptor_conflict(p_subject text,p_verified_email text,i hon.school_staff_invitations) RETURNS boolean
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
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id=actor AND revoked_at IS NULL
      AND (effective_until IS NULL OR effective_until>clock_timestamp())
      AND (organization_id<>i.organization_id OR school_id=i.school_id));
END $$;

-- Low-volume IAM onboarding reuses the 0191 authority envelope: one advisory lock plus NOWAIT
-- SHARE ROW EXCLUSIVE on every IAM table, so authority read after the lock cannot change before commit.
CREATE FUNCTION hon.manage_school_staff_invitation(p_subject text,p_operation text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; i hon.school_staff_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE;
  fp text; at timestamptz; v_org uuid; v_school uuid; v_role uuid; v_ttl integer; result jsonb;
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR p_operation IS NULL OR p_operation NOT IN ('INVITE','REVOKE')
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid;
  IF hon.school_staff_manager(p_subject,v_school) IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM hon.lock_school_account_authority();
  actor:=hon.school_staff_manager(p_subject,v_school);
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO v_org FROM hon.schools WHERE id=v_school;
  fp:=encode(sha256(convert_to('STAFF:'||p_operation||':'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN prior.response;
  END IF;
  at:=clock_timestamp();
  IF p_operation='INVITE' THEN
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['email','roleId','schoolId','tokenHash','ttlHours']
      OR jsonb_typeof(p_input->'email') IS DISTINCT FROM 'string' OR p_input->>'email'<>lower(btrim(p_input->>'email'))
      OR length(p_input->>'email') NOT BETWEEN 3 AND 254 OR p_input->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      OR jsonb_typeof(p_input->'tokenHash') IS DISTINCT FROM 'string' OR p_input->>'tokenHash' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(p_input->'ttlHours') IS DISTINCT FROM 'number' OR p_input->>'ttlHours' !~ '^[0-9]{1,3}$'
      OR jsonb_typeof(p_input->'roleId') IS DISTINCT FROM 'string' OR p_input->>'roleId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    v_ttl:=(p_input->>'ttlHours')::integer; v_role:=(p_input->>'roleId')::uuid;
    IF v_ttl NOT BETWEEN 1 AND 168 THEN RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    IF NOT hon.school_staff_role_grantable(actor,v_org,v_school,v_role) THEN RAISE EXCEPTION 'ACCOUNT_ROLE_NOT_GRANTABLE' USING ERRCODE='42501'; END IF;
    IF EXISTS(SELECT 1 FROM hon.school_staff_invitations WHERE school_id=v_school AND email=p_input->>'email' AND status='PENDING' AND expires_at>at) THEN
      RAISE EXCEPTION 'ACCOUNT_INVITATION_EXISTS' USING ERRCODE='23505'; END IF;
    INSERT INTO hon.school_staff_invitations(organization_id,school_id,role_id,email,token_hash,created_by,created_at,expires_at,status)
      VALUES(v_org,v_school,v_role,p_input->>'email',p_input->>'tokenHash',actor,at,at+make_interval(hours=>v_ttl),'PENDING') RETURNING * INTO i;
  ELSE
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['invitationId','schoolId']
      OR jsonb_typeof(p_input->'invitationId') IS DISTINCT FROM 'string' OR p_input->>'invitationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
    -- Exact school only: an invitation id from another school is indistinguishable from a missing one.
    SELECT * INTO i FROM hon.school_staff_invitations WHERE id=(p_input->>'invitationId')::uuid AND school_id=v_school FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    IF i.status='ACCEPTED' THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_ACCEPTED' USING ERRCODE='23514'; END IF;
    IF i.status='PENDING' THEN
      UPDATE hon.school_staff_invitations SET status='REVOKED',revoked_at=at WHERE id=i.id RETURNING * INTO i;
    END IF;
  END IF;
  result:=hon.school_staff_account_record(p_subject,p_key,fp,i.id,p_operation,hon.school_staff_invitation_json(i));
  -- Decision point AFTER every durable write, including the evidence row: authority that expired at any
  -- instant up to here (grant window, paid-access window, all judged on clock_timestamp()) aborts the
  -- statement, so no invitation change, request or evidence row survives.
  IF hon.school_staff_manager(p_subject,v_school) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Email and subject originate ONLY in the HON-signed OIDC session, never in the request body.
CREATE FUNCTION hon.accept_school_staff_invitation(p_subject text,p_verified_email text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.school_staff_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE; fp text; at timestamptz;
  v_user uuid; actor uuid; v_grant uuid; issuer_subject text; result jsonb;
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR length(p_subject)>2048 OR p_subject NOT LIKE 'oidc:%'
    OR p_verified_email IS NULL OR p_verified_email<>lower(btrim(p_verified_email))
    OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['confirmation','invitationId','tokenHash']
    OR p_input->>'confirmation' IS DISTINCT FROM 'ACCEPT_SCHOOL_STAFF_INVITATION'
    OR jsonb_typeof(p_input->'invitationId') IS DISTINCT FROM 'string' OR p_input->>'invitationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'tokenHash') IS DISTINCT FROM 'string' OR p_input->>'tokenHash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  -- Cheap uniform pre-check before taking the global authority envelope.
  SELECT * INTO i FROM hon.school_staff_invitations WHERE id=(p_input->>'invitationId')::uuid;
  IF i.id IS NULL OR i.token_hash IS DISTINCT FROM p_input->>'tokenHash' OR i.email IS DISTINCT FROM p_verified_email OR i.status='REVOKED' THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM hon.lock_school_account_authority();
  SELECT * INTO i FROM hon.school_staff_invitations WHERE id=(p_input->>'invitationId')::uuid FOR UPDATE;
  -- Uniform failure: no invitation, wrong identity/email/token, revoked, or suspended school disclose nothing.
  IF i.id IS NULL OR i.token_hash IS DISTINCT FROM p_input->>'tokenHash' OR i.email IS DISTINCT FROM p_verified_email OR i.status='REVOKED'
    OR NOT EXISTS(SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id WHERE s.id=i.school_id AND s.organization_id=i.organization_id AND s.status='ACTIVE' AND o.status='ACTIVE') THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  fp:=encode(sha256(convert_to('STAFF:ACCEPT:'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    -- A replay never revives an ended grant.
    IF i.accepted_subject IS DISTINCT FROM p_subject OR NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id
      WHERE g.id=i.role_grant_id AND p.is_active AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())) THEN
      RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
    RETURN prior.response;
  END IF;
  IF i.status<>'PENDING' OR i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  -- The issuer's authority is re-proven NOW, under the IAM locks: a revoked/downgraded issuer, or a role
  -- that gained a permission the issuer lacks, makes the outstanding invitation unusable.
  SELECT u.external_subject INTO issuer_subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=i.created_by;
  IF hon.school_staff_manager(issuer_subject,i.school_id) IS DISTINCT FROM i.created_by
    OR NOT hon.school_staff_role_grantable(i.created_by,i.organization_id,i.school_id,i.role_id) THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  IF hon.school_staff_acceptor_conflict(p_subject,p_verified_email,i) THEN RAISE EXCEPTION 'ACCOUNT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT id INTO v_user FROM hon.users WHERE external_subject=p_subject;
  IF v_user IS NULL THEN
    INSERT INTO hon.users(external_subject,email,display_name) VALUES(p_subject,p_verified_email,'School staff') RETURNING id INTO v_user;
    INSERT INTO hon.principals(principal_type,user_id,display_name) VALUES('HUMAN_USER',v_user,'School staff') RETURNING id INTO actor;
  ELSE
    SELECT id INTO actor FROM hon.principals WHERE user_id=v_user AND is_active AND principal_type='HUMAN_USER';
  END IF;
  at:=clock_timestamp();
  IF i.expires_at<=at THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
    VALUES(i.organization_id,i.school_id,actor,i.role_id,i.created_by,at) RETURNING id INTO v_grant;
  UPDATE hon.school_staff_invitations SET status='ACCEPTED',accepted_subject=p_subject,role_grant_id=v_grant,accepted_at=at WHERE id=i.id RETURNING * INTO i;
  result:=hon.school_staff_account_record(p_subject,p_key,fp,i.id,'ACCEPT',hon.school_staff_account_result(i));
  -- Decision point AFTER the identity, role grant and evidence writes: the invitation window and the issuer's
  -- authority (grant window, paid access, role eligibility) must still hold now, or nothing survives.
  IF i.expires_at<=clock_timestamp() OR hon.school_staff_manager(issuer_subject,i.school_id) IS DISTINCT FROM i.created_by
    OR NOT hon.school_staff_role_grantable(i.created_by,i.organization_id,i.school_id,i.role_id) THEN
    RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

CREATE FUNCTION hon.read_school_staff_invitations(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
  IF p_subject IS NULL OR p_school IS NULL OR hon.school_staff_manager(p_subject,p_school) IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  result:=(SELECT coalesce(jsonb_agg(hon.school_staff_invitation_json(i) ORDER BY i.created_at DESC,i.id),'[]'::jsonb)
    FROM (SELECT * FROM hon.school_staff_invitations WHERE school_id=p_school ORDER BY created_at DESC,id LIMIT 50) i);
  IF hon.school_staff_manager(p_subject,p_school) IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

DO $$ DECLARE t text; r text; f text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_staff_invitations','school_staff_account_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_school_staff_invitation()','school_staff_manager(text,uuid)','school_staff_role_grantable(uuid,uuid,uuid,uuid)',
    'school_staff_invitation_json(hon.school_staff_invitations)','school_staff_account_result(hon.school_staff_invitations)',
    'school_staff_account_record(text,uuid,text,uuid,text,jsonb)','school_staff_acceptor_conflict(text,text,hon.school_staff_invitations)',
    'manage_school_staff_invitation(text,text,jsonb,uuid)','accept_school_staff_invitation(text,text,jsonb,uuid)','read_school_staff_invitations(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.manage_school_staff_invitation(text,text,jsonb,uuid),hon.accept_school_staff_invitation(text,text,jsonb,uuid),hon.read_school_staff_invitations(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
