BEGIN;

-- P0-1 identity binding only. 0190 belongs to pending A2P PR #82. No entitlement or financial changes.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;
CREATE TABLE hon.school_owner_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id),
  school_id uuid NOT NULL,
  email text NOT NULL CHECK(email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('PENDING','ACCEPTED','REVOKED')),
  accepted_subject text,
  owner_grant_id uuid UNIQUE REFERENCES hon.principal_role_grants(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days'),
  CHECK((accepted_subject IS NULL AND owner_grant_id IS NULL AND accepted_at IS NULL)
    OR (accepted_subject IS NOT NULL AND owner_grant_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK((status='PENDING' AND accepted_at IS NULL AND revoked_at IS NULL)
    OR (status='ACCEPTED' AND accepted_at IS NOT NULL AND revoked_at IS NULL)
    OR (status='REVOKED' AND revoked_at IS NOT NULL))
);
CREATE TABLE hon.school_account_requests (
  subject text NOT NULL,
  idempotency_key uuid NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY(subject,idempotency_key)
);
-- Private immutable audit + structurally inert outbox. NOT the claimable domain outbox; no dispatcher grant.
CREATE TABLE hon.school_account_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES hon.school_owner_invitations(id),
  subject text NOT NULL,
  idempotency_key uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('INVITE','ACCEPT','REVOKE')),
  occurred_at timestamptz NOT NULL,
  receipt jsonb NOT NULL,
  execution_allowed boolean NOT NULL DEFAULT false CHECK(NOT execution_allowed),
  FOREIGN KEY(subject,idempotency_key) REFERENCES hon.school_account_requests(subject,idempotency_key),
  UNIQUE(subject,idempotency_key)
);
CREATE FUNCTION hon.guard_school_account_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'ACCOUNT_EVIDENCE_IMMUTABLE' USING ERRCODE='42501'; END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.school_account_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_account_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.school_account_events FOR EACH ROW EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_account_events FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_account_evidence();
CREATE FUNCTION hon.guard_school_owner_invitation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND ((OLD.status='PENDING' AND NEW.status IN ('ACCEPTED','REVOKED')) OR (OLD.status='ACCEPTED' AND NEW.status='REVOKED'))
    AND (to_jsonb(NEW)-ARRAY['status','accepted_subject','owner_grant_id','accepted_at','revoked_at'])=
        (to_jsonb(OLD)-ARRAY['status','accepted_subject','owner_grant_id','accepted_at','revoked_at'])
    AND (OLD.accepted_at IS NULL OR (NEW.accepted_subject=OLD.accepted_subject AND NEW.owner_grant_id=OLD.owner_grant_id AND NEW.accepted_at=OLD.accepted_at))
    THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ACCOUNT_EVIDENCE_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.school_owner_invitations FOR EACH ROW EXECUTE FUNCTION hon.guard_school_owner_invitation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_owner_invitations FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_owner_invitation();

-- Low-volume onboarding serializes its own writers. Never wait while holding an inverted IAM lock:
-- NOWAIT either obtains the complete authority envelope or aborts the entire request (safe explicit retry).
-- Existing IAM writers either precede us, or wait until commit. Final clock checks catch natural expiry.
CREATE FUNCTION hon.lock_school_account_authority() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.saas_refuse_context();
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hon.school-account.v1',0)) THEN
    RAISE EXCEPTION 'ACCOUNT_BUSY' USING ERRCODE='55P03'; END IF;
  LOCK TABLE hon.organizations,hon.schools,hon.users,hon.principals,hon.principal_role_grants,
    hon.hq_operator_grants,hon.family_access_grants,hon.roles,hon.role_permissions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
END $$;
CREATE FUNCTION hon.school_invitation_json(i hon.school_owner_invitations) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('invitationId',i.id,'organizationId',i.organization_id,'schoolId',i.school_id,
    'email',i.email,'expiresAt',hon.saas_ts(i.expires_at),'status',CASE WHEN i.status='PENDING' AND i.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE i.status END)
$$;
CREATE FUNCTION hon.school_account_result(i hon.school_owner_invitations) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('invitationId',i.id,'organizationId',i.organization_id,'schoolId',i.school_id,
    'accountStatus','OWNER_BOUND','accessGranted',false,'billingActivated',false,'aiCreditsGranted',false)
$$;
CREATE FUNCTION hon.school_account_record(p_subject text,p_key uuid,p_fingerprint text,p_invitation uuid,p_action text,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  INSERT INTO hon.school_account_requests VALUES(p_subject,p_key,p_fingerprint,p_result);
  INSERT INTO hon.school_account_events(invitation_id,subject,idempotency_key,action,occurred_at,receipt)
    VALUES(p_invitation,p_subject,p_key,p_action,clock_timestamp(),p_result);
  RETURN p_result;
END $$;

CREATE FUNCTION hon.manage_school_owner_invitation(p_subject text,p_operation text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; i hon.school_owner_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE;
  fp text; at timestamptz; v_org uuid; v_school uuid; v_ttl integer;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR p_operation IS NULL OR p_operation NOT IN ('INVITE','REVOKE') THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.lock_school_account_authority();
  actor:=hon.require_saas_hq_actor(p_subject,true);
  fp:=encode(sha256(convert_to(p_operation||':'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
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
    -- The browser supplies a school selector only. Derive its organization under the same
    -- live HQ-owner authority/table locks as the insertion; no directory expansion or second-read race.
    SELECT s.organization_id INTO v_org FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id
      WHERE s.id=v_school AND s.status='ACTIVE' AND o.status='ACTIVE';
    IF v_org IS NULL OR NOT EXISTS(SELECT 1 FROM hon.roles WHERE organization_id=v_org AND code='OWNER' AND is_system_role) THEN
      RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    IF EXISTS(SELECT 1 FROM hon.school_owner_invitations WHERE school_id=v_school AND email=p_input->>'email' AND status='PENDING' AND expires_at>at) THEN
      RAISE EXCEPTION 'ACCOUNT_INVITATION_EXISTS' USING ERRCODE='23505'; END IF;
    INSERT INTO hon.school_owner_invitations(organization_id,school_id,email,token_hash,created_by,created_at,expires_at,status)
      VALUES(v_org,v_school,p_input->>'email',p_input->>'tokenHash',actor,at,at+make_interval(hours=>v_ttl),'PENDING') RETURNING * INTO i;
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
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  RETURN hon.school_account_record(p_subject,p_key,fp,i.id,p_operation,hon.school_invitation_json(i));
END $$;

-- Email and subject originate ONLY in the HON-signed OIDC session, not in the acceptance request.
CREATE FUNCTION hon.accept_school_owner_invitation(p_subject text,p_verified_email text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.school_owner_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE; fp text; at timestamptz;
  v_user uuid; actor uuid; v_role uuid; v_grant uuid; issuer_subject text;
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR length(p_subject)>2048 OR p_subject NOT LIKE 'oidc:%'
    OR p_verified_email IS NULL OR p_verified_email<>lower(btrim(p_verified_email))
    OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['confirmation','invitationId','tokenHash']
    OR p_input->>'confirmation' IS DISTINCT FROM 'ACCEPT_SCHOOL_OWNER_INVITATION'
    OR jsonb_typeof(p_input->'invitationId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_input->'tokenHash') IS DISTINCT FROM 'string' OR p_input->>'tokenHash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.lock_school_account_authority();
  SELECT * INTO i FROM hon.school_owner_invitations WHERE id=(p_input->>'invitationId')::uuid FOR UPDATE;
  -- Uniform failure: no invitation, wrong identity/email/token, expired, revoked or suspended school disclose no facts.
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
    -- Never merge/link an existing identity just because its email matches. Changed provider subject requires review.
    IF EXISTS(SELECT 1 FROM hon.users WHERE lower(email::text)=p_verified_email) THEN RAISE EXCEPTION 'ACCOUNT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
    INSERT INTO hon.users(external_subject,email,display_name) VALUES(p_subject,p_verified_email,'School owner') RETURNING id INTO v_user;
    INSERT INTO hon.principals(principal_type,user_id,display_name) VALUES('HUMAN_USER',v_user,'School owner') RETURNING id INTO actor;
  ELSE
    SELECT id INTO actor FROM hon.principals WHERE user_id=v_user AND is_active AND principal_type='HUMAN_USER';
    IF actor IS NULL OR (SELECT count(*) FROM hon.principals WHERE user_id=v_user AND is_active)<>1
      OR NOT EXISTS(SELECT 1 FROM hon.users WHERE id=v_user AND lower(email::text)=p_verified_email) THEN
      RAISE EXCEPTION 'ACCOUNT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id=actor AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())
      AND (organization_id<>i.organization_id OR school_id=i.school_id)) THEN
    RAISE EXCEPTION 'ACCOUNT_REVIEW_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT id INTO v_role FROM hon.roles WHERE organization_id=i.organization_id AND code='OWNER' AND is_system_role;
  IF v_role IS NULL THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  at:=clock_timestamp();
  IF i.expires_at<=at THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from)
    VALUES(i.organization_id,i.school_id,actor,v_role,i.created_by,at) RETURNING id INTO v_grant;
  UPDATE hon.school_owner_invitations SET status='ACCEPTED',accepted_subject=p_subject,owner_grant_id=v_grant,accepted_at=at WHERE id=i.id RETURNING * INTO i;
  PERFORM hon.require_saas_hq_actor(issuer_subject,true);
  RETURN hon.school_account_record(p_subject,p_key,fp,i.id,'ACCEPT',hon.school_account_result(i));
END $$;

CREATE FUNCTION hon.read_school_owner_invitations(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.lock_school_account_authority();
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  IF NOT EXISTS(SELECT 1 FROM hon.schools WHERE id=p_school) THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(hon.school_invitation_json(i) ORDER BY i.created_at DESC,i.id),'[]'::jsonb)
    FROM (SELECT * FROM hon.school_owner_invitations WHERE school_id=p_school ORDER BY created_at DESC,id LIMIT 50) i);
END $$;

DO $$ DECLARE t text; r text; f text; c text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_owner_invitations','school_account_requests','school_account_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_school_account_evidence()','guard_school_owner_invitation()','lock_school_account_authority()',
    'school_invitation_json(hon.school_owner_invitations)','school_account_result(hon.school_owner_invitations)',
    'school_account_record(text,uuid,text,uuid,text,jsonb)','manage_school_owner_invitation(text,text,jsonb,uuid)',
    'accept_school_owner_invitation(text,text,jsonb,uuid)','read_school_owner_invitations(text,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.manage_school_owner_invitation(text,text,jsonb,uuid),hon.accept_school_owner_invitation(text,text,jsonb,uuid),hon.read_school_owner_invitations(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
