BEGIN;
-- 0561 school calling, piece CL2 (allocated by the coordinator 2026-11-19; docs/architecture/SCHOOL_CALLING.md §4).
-- Browser calling needs, on each school's own Twilio subaccount (0351), one TwiML App (HON's fixed client-voice URL) and
-- one API key whose secret signs the school's short-lived browser phone tokens. This migration only records them: the API
-- worker creates them at Twilio only behind HON_VOICE_CALLS_APPROVED, and the key secret is sealed by the API (same vault
-- key as 0351, its own authenticated label) and opened only in API memory.
--   V1 The worker claims a school whose calling is on and whose ACTIVE sender is on an ACTIVE subaccount, then records the
--      app and key for its live claim only. A school on HON's parent account gets no voice app (calling stays unavailable).
--   V2 Staff with communication.call.use ask for a phone token: the runtime decides who they are and whether they may ring
--      now; the worker login reads the sealed key for that school only to sign it.
--   V3 Keys never change once recorded except by a new claim after HQ closes them; no row is deleted.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker')) THEN
    RAISE EXCEPTION 'School voice apps require a trusted migration owner';
  END IF;
  IF to_regclass('hon.school_calls') IS NULL OR to_regprocedure('hon.require_school_call_actor(text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'School voice apps require 0556';
  END IF;
END $$;

CREATE TABLE hon.school_voice_apps (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  account_sid text NOT NULL CHECK (account_sid ~ '^AC[0-9a-f]{32}$'),
  status text NOT NULL CHECK (status IN ('PENDING','ACTIVE','CLOSED')),
  twiml_app_sid text UNIQUE CHECK (twiml_app_sid ~ '^AP[0-9a-f]{32}$'),
  api_key_sid text UNIQUE CHECK (api_key_sid ~ '^SK[0-9a-f]{32}$'),
  sealed_api_secret text CHECK (sealed_api_secret ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$' AND length(sealed_api_secret) <= 1024),
  vault_key_id text CHECK (vault_key_id ~ '^[a-z0-9-]{1,40}$'),
  claim_token uuid,
  claim_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_sid, school_id) REFERENCES hon.school_twilio_accounts(account_sid, school_id) ON DELETE RESTRICT,
  CONSTRAINT school_voice_apps_shape CHECK (
    (status='PENDING' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND api_key_sid IS NULL AND sealed_api_secret IS NULL AND vault_key_id IS NULL)
    OR (status='ACTIVE' AND claim_token IS NULL AND claim_expires_at IS NULL AND twiml_app_sid IS NOT NULL AND api_key_sid IS NOT NULL
      AND sealed_api_secret IS NOT NULL AND vault_key_id IS NOT NULL)
    OR (status='CLOSED' AND claim_token IS NULL AND claim_expires_at IS NULL))
);
ALTER TABLE hon.school_voice_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_voice_apps FORCE ROW LEVEL SECURITY;
CREATE POLICY school_voice_apps_tenant_isolation ON hon.school_voice_apps
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- A voice app keeps its school, organization and subaccount; an ACTIVE row's app and key never change (a new key needs
-- CLOSED first, then a new claim); version always moves forward; nothing is deleted or truncated.
CREATE FUNCTION hon.guard_school_voice_app() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.school_id,NEW.organization_id,NEW.account_sid,NEW.created_at) IS NOT DISTINCT FROM (OLD.school_id,OLD.organization_id,OLD.account_sid,OLD.created_at)
    AND NEW.version > OLD.version
    AND (OLD.status<>'ACTIVE' OR NEW.status='CLOSED' OR (NEW.twiml_app_sid,NEW.api_key_sid,NEW.sealed_api_secret,NEW.vault_key_id)
      IS NOT DISTINCT FROM (OLD.twiml_app_sid,OLD.api_key_sid,OLD.sealed_api_secret,OLD.vault_key_id))
    AND (OLD.twiml_app_sid IS NULL OR NEW.twiml_app_sid IS NOT DISTINCT FROM OLD.twiml_app_sid) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SCHOOL_VOICE_APP_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_voice_apps FOR EACH ROW EXECUTE FUNCTION hon.guard_school_voice_app();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_voice_apps FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_voice_app();

-- V1 worker: schools that need a voice app now (calling on, ACTIVE sender on an ACTIVE subaccount, live school and
-- entitlement, no ACTIVE app and no live claim). At most p_limit.
CREATE FUNCTION hon.read_schools_needing_voice_app(p_limit integer)
RETURNS TABLE (school_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'HON voice app limit is invalid.' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT s.school_id FROM hon.school_calling_settings s
    JOIN hon.school_text_senders sender ON sender.school_id=s.school_id AND sender.status='ACTIVE'
    JOIN hon.school_twilio_accounts a ON a.account_sid=sender.twilio_account_sid AND a.school_id=sender.school_id AND a.status='ACTIVE'
    JOIN hon.schools sc ON sc.id=s.school_id AND sc.status='ACTIVE'
    JOIN hon.organizations o ON o.id=sc.organization_id AND o.status='ACTIVE'
    LEFT JOIN hon.school_voice_apps v ON v.school_id=s.school_id
    WHERE s.calling_on AND (v.school_id IS NULL OR (v.status='PENDING' AND v.claim_expires_at<=clock_timestamp()) OR v.status='CLOSED')
      AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=sc.organization_id AND e.status='ACTIVE'
        AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    ORDER BY s.updated_at, s.school_id LIMIT p_limit;
END $$;

-- V1 worker: claim one school's voice app. CLAIMED gives the subaccount (whose sealed token the worker already reads via
-- 0351) and any TwiML App recorded earlier (find before create); ACTIVE and BUSY claim nothing; INELIGIBLE when the
-- school no longer needs one.
CREATE FUNCTION hon.begin_school_voice_app(p_school uuid, p_lease_seconds integer)
RETURNS TABLE (state text, account_sid text, twiml_app_sid text, claim_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
#variable_conflict use_column
DECLARE v hon.school_voice_apps; v_account text; v_org uuid; token uuid:=gen_random_uuid();
BEGIN
  IF p_school IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'HON voice app claim is invalid.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.school_voice_apps:'||p_school::text,0));
  SELECT a.account_sid, sc.organization_id INTO v_account, v_org FROM hon.school_calling_settings s
    JOIN hon.school_text_senders sender ON sender.school_id=s.school_id AND sender.status='ACTIVE'
    JOIN hon.school_twilio_accounts a ON a.account_sid=sender.twilio_account_sid AND a.school_id=sender.school_id AND a.status='ACTIVE'
    JOIN hon.schools sc ON sc.id=s.school_id AND sc.status='ACTIVE' JOIN hon.organizations o ON o.id=sc.organization_id AND o.status='ACTIVE'
    WHERE s.school_id=p_school AND s.calling_on AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=sc.organization_id
      AND e.status='ACTIVE' AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp()
      AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF v_account IS NULL THEN state:='INELIGIBLE'; RETURN NEXT; RETURN; END IF;
  SELECT * INTO v FROM hon.school_voice_apps x WHERE x.school_id=p_school FOR UPDATE;
  IF v.status='ACTIVE' THEN state:='ACTIVE'; account_sid:=v.account_sid; twiml_app_sid:=v.twiml_app_sid; RETURN NEXT; RETURN; END IF;
  IF v.status='PENDING' AND v.claim_expires_at>clock_timestamp() THEN state:='BUSY'; RETURN NEXT; RETURN; END IF;
  IF v.school_id IS NULL THEN
    INSERT INTO hon.school_voice_apps(school_id,organization_id,account_sid,status,claim_token,claim_expires_at,attempts)
      VALUES(p_school,v_org,v_account,'PENDING',token,clock_timestamp()+make_interval(secs=>p_lease_seconds),1) RETURNING * INTO v;
  ELSE
    IF v.account_sid<>v_account THEN state:='INELIGIBLE'; RETURN NEXT; RETURN; END IF;
    UPDATE hon.school_voice_apps x SET status='PENDING',claim_token=token,claim_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      api_key_sid=NULL,sealed_api_secret=NULL,vault_key_id=NULL,attempts=least(x.attempts+1,1000),version=x.version+1,updated_at=clock_timestamp()
      WHERE x.school_id=p_school RETURNING * INTO v;
  END IF;
  state:='CLAIMED'; account_sid:=v.account_sid; twiml_app_sid:=v.twiml_app_sid; claim_token:=token; RETURN NEXT;
END $$;

-- V1 worker: the TwiML App found or created for a live claim (kept even if the key step fails, so it is never made twice).
CREATE FUNCTION hon.record_school_voice_app_twiml(p_school uuid, p_claim_token uuid, p_twiml_app_sid text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v hon.school_voice_apps;
BEGIN
  IF p_school IS NULL OR p_claim_token IS NULL OR p_twiml_app_sid IS NULL OR p_twiml_app_sid !~ '^AP[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'HON voice app input is invalid.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM hon.school_voice_apps x WHERE x.school_id=p_school FOR UPDATE;
  IF v.status IS DISTINCT FROM 'PENDING' OR v.claim_token IS DISTINCT FROM p_claim_token OR v.claim_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'VOICE_APP_CLAIM_LOST' USING ERRCODE='40001'; END IF;
  IF v.twiml_app_sid IS NOT NULL THEN RETURN v.twiml_app_sid=p_twiml_app_sid; END IF;
  UPDATE hon.school_voice_apps x SET twiml_app_sid=p_twiml_app_sid,version=x.version+1,updated_at=clock_timestamp() WHERE x.school_id=p_school;
  RETURN true;
END $$;

-- V1 worker: the sealed API key for a live claim; the app becomes ACTIVE.
CREATE FUNCTION hon.complete_school_voice_app(p_school uuid, p_claim_token uuid, p_api_key_sid text, p_sealed_api_secret text, p_vault_key_id text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v hon.school_voice_apps; req uuid:=gen_random_uuid();
BEGIN
  IF p_school IS NULL OR p_claim_token IS NULL OR p_api_key_sid IS NULL OR p_api_key_sid !~ '^SK[0-9a-f]{32}$'
    OR p_sealed_api_secret IS NULL OR p_vault_key_id IS NULL THEN RAISE EXCEPTION 'HON voice app input is invalid.' USING ERRCODE='22023'; END IF;
  SELECT * INTO v FROM hon.school_voice_apps x WHERE x.school_id=p_school FOR UPDATE;
  IF v.status IS DISTINCT FROM 'PENDING' OR v.claim_token IS DISTINCT FROM p_claim_token OR v.claim_expires_at<=clock_timestamp() OR v.twiml_app_sid IS NULL THEN
    RAISE EXCEPTION 'VOICE_APP_CLAIM_LOST' USING ERRCODE='40001'; END IF;
  UPDATE hon.school_voice_apps x SET status='ACTIVE',api_key_sid=p_api_key_sid,sealed_api_secret=p_sealed_api_secret,vault_key_id=p_vault_key_id,
    claim_token=NULL,claim_expires_at=NULL,version=x.version+1,updated_at=clock_timestamp() WHERE x.school_id=p_school RETURNING * INTO v;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(v.organization_id,v.school_id,'00000000-0000-4000-8000-00000000c547','INTEGRATION','communication.voice_app.created','SCHOOL_VOICE_APP',v.school_id,
      jsonb_build_object('status','PENDING'),jsonb_build_object('status',v.status,'twimlAppSid',v.twiml_app_sid,'apiKeySid',v.api_key_sid,'version',v.version),
      'SUCCEEDED',req,req);
  RETURN true;
END $$;

-- V2 runtime: may the signed-in staff member have a browser phone now? Decides the identity, whether incoming calls may
-- ring this phone, and whether the school's voice app is ready. Never returns a key or secret.
CREATE FUNCTION hon.authorize_school_phone_token(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; school uuid:=hon.current_school_id(); org uuid:=hon.current_organization_id(); v_ready boolean; v_ring boolean; v_on boolean;
BEGIN
  actor:=hon.require_school_call_actor(subject,false);
  v_on:=coalesce((SELECT s.calling_on FROM hon.school_calling_settings s WHERE s.school_id=school),false);
  v_ready:=v_on AND EXISTS(SELECT 1 FROM hon.school_voice_apps v JOIN hon.school_text_senders sender ON sender.school_id=v.school_id
      AND sender.status='ACTIVE' AND sender.twilio_account_sid=v.account_sid
    JOIN hon.school_twilio_accounts a ON a.account_sid=v.account_sid AND a.school_id=v.school_id AND a.status='ACTIVE'
    WHERE v.school_id=school AND v.status='ACTIVE');
  v_ring:=coalesce((SELECT k.ring_me FROM hon.school_call_staff k WHERE k.school_id=school AND k.principal_id=actor),false);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','communication.phone_token.issue','SCHOOL_VOICE_APP',school,NULL,
      jsonb_build_object('ready',v_ready,'incoming',v_ring),(CASE WHEN v_ready THEN 'SUCCEEDED' ELSE 'DENIED' END)::hon.audit_result,gen_random_uuid(),gen_random_uuid());
  RETURN jsonb_build_object('schoolId',school,'identity',hon.school_call_identity(actor),'ready',v_ready,'callingOn',v_on,'incoming',v_ring AND v_ready);
END $$;

-- V2 worker: the sealed key of the school's ACTIVE voice app, read only to sign a phone token the runtime authorized.
CREATE FUNCTION hon.read_school_voice_app(p_school uuid)
RETURNS TABLE (account_sid text, twiml_app_sid text, api_key_sid text, sealed_api_secret text, vault_key_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT v.account_sid, v.twiml_app_sid, v.api_key_sid, v.sealed_api_secret, v.vault_key_id FROM hon.school_voice_apps v
  JOIN hon.school_twilio_accounts a ON a.account_sid=v.account_sid AND a.school_id=v.school_id AND a.status='ACTIVE'
  WHERE v.school_id=p_school AND v.status='ACTIVE'
$$;

DO $$ DECLARE r text; f text;
  worker text[]:=ARRAY['hon.read_schools_needing_voice_app(integer)','hon.begin_school_voice_app(uuid,integer)',
    'hon.record_school_voice_app_twiml(uuid,uuid,text)','hon.complete_school_voice_app(uuid,uuid,text,text,text)','hon.read_school_voice_app(uuid)'];
  staff text[]:=ARRAY['hon.authorize_school_phone_token(text)'];
BEGIN
  FOREACH f IN ARRAY worker||staff||ARRAY['hon.guard_school_voice_app()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.school_voice_apps FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_voice_apps FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.authorize_school_phone_token(text) TO hon_runtime; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_communication_worker') THEN
    FOREACH f IN ARRAY worker LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_communication_worker',f); END LOOP;
  END IF;
END $$;
COMMIT;
