BEGIN;

-- Owner-invitation authority decision point (provisional number 0206; the owner allocates the final number).
-- 0191 checked live HQ-owner authority, then wrote the request claim and immutable evidence. Every window is judged on
-- clock_timestamp(), so an HQ-owner grant (or, on acceptance, the invitation) that ended while the evidence row was being
-- written still produced a committed INVITE, REVOKE or ACCEPT. This replaces only the two command bodies so that the final
-- authority check runs after the last durable write; any failure raises and rolls back the whole statement.
-- Unchanged: signatures, SECURITY DEFINER, search_path, owner, ACL, lock order, NOWAIT busy behavior, input contracts,
-- replay rules, read function, helpers and tables. 0191 itself is not edited.

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
  -- Decide authority AFTER the last durable write: a grant that ends while the evidence is written fails the statement.
  result:=hon.school_account_record(p_subject,p_key,fp,i.id,p_operation,hon.school_invitation_json(i));
  PERFORM hon.require_saas_hq_actor(p_subject,true);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION hon.accept_school_owner_invitation(p_subject text,p_verified_email text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.school_owner_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE; fp text; at timestamptz;
  v_user uuid; actor uuid; v_role uuid; v_grant uuid; issuer_subject text; result jsonb;
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
  -- Decide authority AFTER the last durable write: issuer authority or invitation expiry that ends while the identity,
  -- grant, acceptance and evidence are written fails the whole statement.
  result:=hon.school_account_record(p_subject,p_key,fp,i.id,'ACCEPT',hon.school_account_result(i));
  IF i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ACCOUNT_INVITATION_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM hon.require_saas_hq_actor(issuer_subject,true);
  RETURN result;
END $$;

COMMIT;
