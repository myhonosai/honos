BEGIN;

-- 0714 One-click family app invitation by email (owner request 2026-11-28: "Email to verify/activate with one click
-- button. And sign in"). The 0205 invitation is unchanged: accepting still needs a HON-verified sign-in with the invited
-- email AND the private code. What is new is that HON may email that link for the school, so nobody copies an ID or code.
--
-- This migration adds one fixed entry point. It decides, in the database, whether an invitation email may be sent:
--   * the caller is the live family manager at the exact school (same predicate as INVITE, paid access included);
--   * the invitation is PENDING, not expired, belongs to that school, and the code the caller holds is its code;
--   * at most three emails per invitation, ever.
-- It records an immutable EMAIL event and returns the only address the API may send to (the invitation's own) with
-- the school and family names. The private code is never stored or returned: the API holds it for one send only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
END $$;

ALTER TABLE hon.school_family_account_events DROP CONSTRAINT school_family_account_events_action_check;
ALTER TABLE hon.school_family_account_events ADD CONSTRAINT school_family_account_events_action_check
  CHECK(action IN ('INVITE','ACCEPT','REVOKE','END','EMAIL'));
CREATE INDEX school_family_account_events_email ON hon.school_family_account_events(invitation_id) WHERE action='EMAIL';

CREATE FUNCTION hon.record_school_family_invitation_email(p_subject text,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; i hon.school_family_access_invitations%ROWTYPE; prior hon.school_account_requests%ROWTYPE;
  fp text; v_school uuid; v_sent integer; result jsonb;
BEGIN
  IF p_key IS NULL OR p_subject IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_input))<>3
    OR jsonb_typeof(p_input->'schoolId') IS DISTINCT FROM 'string' OR p_input->>'schoolId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'invitationId') IS DISTINCT FROM 'string' OR p_input->>'invitationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_input->'tokenHash') IS DISTINCT FROM 'string' OR p_input->>'tokenHash' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ACCOUNT_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  v_school:=(p_input->>'schoolId')::uuid;
  IF hon.school_family_access_manager(p_subject,v_school) IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM hon.lock_school_account_authority();
  actor:=hon.school_family_access_manager(p_subject,v_school);
  IF actor IS NULL THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  fp:=encode(sha256(convert_to('FAMILY:EMAIL:'||p_input::text,'UTF8')),'hex');
  SELECT * INTO prior FROM hon.school_account_requests WHERE subject=p_subject AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'ACCOUNT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    -- A repeat of the same request never sends a second email: the API sends only when replayed is false.
    RETURN prior.response||jsonb_build_object('replayed',true);
  END IF;
  SELECT * INTO i FROM hon.school_family_access_invitations WHERE id=(p_input->>'invitationId')::uuid AND school_id=v_school FOR UPDATE;
  -- One refusal for "not this school's", "not pending", "expired" and "not its code": nothing is learned from it.
  IF i.id IS NULL OR i.status<>'PENDING' OR i.expires_at<=clock_timestamp() OR i.token_hash IS DISTINCT FROM p_input->>'tokenHash'
    OR NOT EXISTS(SELECT 1 FROM hon.families f WHERE f.id=i.family_id AND f.school_id=i.school_id AND f.status='ACTIVE') THEN
    RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT count(*) INTO v_sent FROM hon.school_family_account_events WHERE invitation_id=i.id AND action='EMAIL';
  IF v_sent>=3 THEN RAISE EXCEPTION 'ACCOUNT_EMAIL_LIMIT' USING ERRCODE='54000'; END IF;
  result:=jsonb_build_object('invitationId',i.id,'organizationId',i.organization_id,'schoolId',i.school_id,'email',i.email,
    'schoolName',(SELECT s.name FROM hon.schools s WHERE s.id=i.school_id),
    'familyName',(SELECT f.display_name FROM hon.families f WHERE f.id=i.family_id),
    'expiresAt',hon.saas_ts(i.expires_at),'emailNumber',v_sent+1,'replayed',false);
  PERFORM hon.school_family_account_record(p_subject,p_key,fp,i.id,'EMAIL',result);
  -- Decision point after every durable write, as in 0205: authority that ended meanwhile aborts the statement.
  IF hon.school_family_access_manager(p_subject,v_school) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'ACCOUNT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.record_school_family_invitation_email(text,jsonb,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.record_school_family_invitation_email(text,jsonb,uuid) FROM '||quote_ident(r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.record_school_family_invitation_email(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
