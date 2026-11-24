BEGIN;

-- HQ ad account connections (0677, coordinator-allocated 2026-11-24). Owner (David, 2026-11-24): "Yes, build it with
-- Zernio" (a Connect button for HON's own Google Ads and Meta in HQ > Marketing & Creative). Spec:
-- docs/architecture/HQ_AD_ACCOUNT_CONNECTIONS.md. The 0347 school flow, for HQ:
-- - One HQ Zernio profile, linked once and never moved. A single-use connect intent holds only the SHA-256 of the random
--   state, belongs to the person who started it and expires after 10 minutes. Accounts come from HON's own profile.
-- - Connect and disconnect: a current HON_HQ_OWNER only. Read: anyone who may read HQ marketing (0252 rules).
-- - A provider account is HON's or a school's, never both: an account any school holds is skipped and only counted.
-- - Records only. No account here can publish, run or pay for an ad; there is no switch for it. No token is held.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.hq_marketing_principal_eligible(uuid,boolean)') IS NULL OR to_regprocedure('hon.saas_refuse_context()') IS NULL
    OR to_regprocedure('hon.saas_fingerprint(text[])') IS NULL OR to_regclass('hon.school_social_accounts') IS NULL
    OR to_regclass('hon.school_social_profiles') IS NULL THEN RAISE EXCEPTION '0677 requires 0252, 0154 and 0347'; END IF;
END $$;

CREATE TABLE hon.hq_ad_profile (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  provider text NOT NULL DEFAULT 'ZERNIO' CHECK (provider='ZERNIO'),
  provider_profile_id text NOT NULL UNIQUE CHECK (provider_profile_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  linked_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE hon.hq_ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('GOOGLE_ADS','META_ADS')),
  provider_account_id text NOT NULL CHECK (provider_account_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120 AND display_name !~ '[[:cntrl:]]'),
  status text NOT NULL CHECK (status IN ('CONNECTED','DISCONNECTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  connected_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disconnected_at timestamptz,
  UNIQUE (provider,provider_account_id),
  CHECK ((status='DISCONNECTED')=(disconnected_at IS NOT NULL))
);

CREATE TABLE hon.hq_ad_connect_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('GOOGLE_ADS','META_ADS')),
  started_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  outcome text CHECK (outcome IN ('RECORDED','NOTHING_FOUND')),
  connected_count integer CHECK (connected_count BETWEEN 0 AND 25),
  conflict_count integer CHECK (conflict_count BETWEEN 0 AND 25),
  CHECK (expires_at=created_at+interval '10 minutes'),
  CHECK (outcome IS NULL OR consumed_at IS NOT NULL),
  CHECK ((outcome IS NULL)=(connected_count IS NULL) AND (outcome IS NULL)=(conflict_count IS NULL))
);
CREATE INDEX hq_ad_connect_intents_created_idx ON hon.hq_ad_connect_intents (created_at DESC);

CREATE TABLE hon.hq_ad_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('DISCONNECT')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES hon.hq_ad_accounts(id),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id,idempotency_key)
);

CREATE TABLE hon.hq_ad_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('CONNECT_STARTED','PROFILE_LINKED','ACCOUNT_CONNECTED','CONNECT_FINISHED','ACCOUNT_DISCONNECTED')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  intent_id uuid REFERENCES hon.hq_ad_connect_intents(id),
  account_id uuid REFERENCES hon.hq_ad_accounts(id),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The profile, events and requests never change. An account changes only by a version bump with its provider, provider
-- id and connector fixed. An intent is consumed once and records its outcome once. Nothing is deleted or truncated.
CREATE FUNCTION hon.guard_hq_ad() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='hq_ad_accounts' THEN
    IF (NEW.id,NEW.provider,NEW.provider_account_id,NEW.connected_by_principal_id) IS NOT DISTINCT FROM (OLD.id,OLD.provider,OLD.provider_account_id,OLD.connected_by_principal_id)
      AND NEW.version=OLD.version+1 AND NEW.updated_at>=OLD.updated_at THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='hq_ad_connect_intents' THEN
    IF (NEW.id,NEW.provider,NEW.started_by_principal_id,NEW.state_hash,NEW.created_at,NEW.expires_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.provider,OLD.started_by_principal_id,OLD.state_hash,OLD.created_at,OLD.expires_at)
      AND ((OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND NEW.outcome IS NULL)
        OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at=OLD.consumed_at AND OLD.outcome IS NULL AND NEW.outcome IS NOT NULL)) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'HQ_AD_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_ad_profile','hq_ad_accounts','hq_ad_connect_intents','hq_ad_requests','hq_ad_events'] LOOP
    EXECUTE format('CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_ad()',t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_ad()',t);
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
  END LOOP;
END $$;
DO $$ DECLARE r text; t text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    FOREACH t IN ARRAY ARRAY['hq_ad_profile','hq_ad_accounts','hq_ad_connect_intents','hq_ad_requests','hq_ad_events'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
END $$;

-- ---------- authority ----------
-- Connecting HON's own ad accounts: a current HQ owner, under the 0252 eligibility (active human, its user's only active
-- principal, no live family access). Reading: the 0252 HQ marketing read rule.
CREATE FUNCTION hon.hq_ad_owner_eligible(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.hq_marketing_principal_eligible(p_principal,true)
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id=p_principal AND g.hq_role='HON_HQ_OWNER'
      AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
$$;

CREATE FUNCTION hon.require_hq_ad_actor(p_subject text,p_connect boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject)<>p_subject THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject
    AND CASE WHEN p_connect THEN hon.hq_ad_owner_eligible(p.id) ELSE hon.hq_marketing_principal_eligible(p.id,false) END;
  IF actor IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- ---------- helpers ----------
CREATE FUNCTION hon.hq_ad_account_json(a hon.hq_ad_accounts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('accountId',a.id,'provider',a.provider,'displayName',a.display_name,'status',a.status,'version',a.version,
    'connectedBy',hon.hq_marketing_person_json(a.connected_by_principal_id),
    'connectedAt',hon.saas_ts(a.connected_at),'updatedAt',hon.saas_ts(a.updated_at),'disconnectedAt',hon.saas_ts(a.disconnected_at))
$$;

CREATE FUNCTION hon.hq_ad_accounts_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_agg(hon.hq_ad_account_json(a) ORDER BY a.status,a.provider,a.connected_at,a.id),'[]'::jsonb) FROM hon.hq_ad_accounts a
$$;

CREATE FUNCTION hon.hq_ad_event(p_kind text,p_actor uuid,p_intent uuid,p_account uuid,p_facts jsonb) RETURNS void
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  INSERT INTO hon.hq_ad_events(kind,actor_principal_id,intent_id,account_id,facts) VALUES(p_kind,p_actor,p_intent,p_account,p_facts)
$$;

-- The open (unused, unexpired) intent this person started.
CREATE FUNCTION hon.hq_ad_open_intent(p_actor uuid,p_intent uuid) RETURNS hon.hq_ad_connect_intents
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE i hon.hq_ad_connect_intents%ROWTYPE;
BEGIN
  SELECT * INTO i FROM hon.hq_ad_connect_intents WHERE id=p_intent FOR UPDATE;
  IF i.id IS NULL OR i.started_by_principal_id<>p_actor OR i.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'HQ_AD_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  IF i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'HQ_AD_CONNECT_STATE_EXPIRED' USING ERRCODE='22023'; END IF;
  RETURN i;
END $$;

-- ---------- read ----------
CREATE FUNCTION hon.read_hq_ad_accounts(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor:=hon.require_hq_ad_actor(p_subject,false);
  result:=jsonb_build_object('profileLinked',EXISTS(SELECT 1 FROM hon.hq_ad_profile),'accounts',hon.hq_ad_accounts_json(),
    'viewer',hon.hq_marketing_person_json(actor)||jsonb_build_object('canConnect',hon.hq_ad_owner_eligible(actor)),
    'checkedAt',hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_ad_actor(p_subject,false);
  RETURN result;
END $$;

-- ---------- connect ----------
-- START {provider}: a new single-use intent holding only the hash of the random state the API made. At most 10 per hour.
CREATE FUNCTION hon.start_hq_ad_connect(p_subject text,p_input jsonb,p_state_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; i hon.hq_ad_connect_intents%ROWTYPE; at timestamptz:=clock_timestamp();
BEGIN
  actor:=hon.require_hq_ad_actor(p_subject,true);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['provider']
    OR jsonb_typeof(p_input->'provider') IS DISTINCT FROM 'string' OR (p_input->>'provider') NOT IN ('GOOGLE_ADS','META_ADS')
    OR p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-ad-connect',0));
  IF (SELECT count(*) FROM hon.hq_ad_connect_intents WHERE created_at>at-interval '1 hour')>=10 THEN
    RAISE EXCEPTION 'HQ_AD_RATE_LIMITED' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.hq_ad_connect_intents(provider,started_by_principal_id,state_hash,created_at,expires_at)
    VALUES(p_input->>'provider',actor,p_state_hash,at,at+interval '10 minutes') RETURNING * INTO i;
  PERFORM hon.hq_ad_event('CONNECT_STARTED',actor,i.id,NULL,jsonb_build_object('provider',i.provider));
  PERFORM hon.require_hq_ad_actor(p_subject,true);
  RETURN jsonb_build_object('intentId',i.id,'provider',i.provider,'expiresAt',hon.saas_ts(i.expires_at),
    'providerProfileId',(SELECT provider_profile_id FROM hon.hq_ad_profile));
END $$;

-- PROFILE: links HQ's Zernio profile found or created by HON's own name. First writer wins; a different id, or an id
-- a school profile holds, is refused.
CREATE FUNCTION hon.record_hq_ad_profile(p_subject text,p_intent uuid,p_provider_profile_id text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; existing text;
BEGIN
  actor:=hon.require_hq_ad_actor(p_subject,true);
  IF p_intent IS NULL OR p_provider_profile_id IS NULL OR p_provider_profile_id !~ '^[0-9A-Za-z_-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-ad-connect',0));
  PERFORM hon.hq_ad_open_intent(actor,p_intent);
  SELECT provider_profile_id INTO existing FROM hon.hq_ad_profile;
  IF existing IS NOT NULL THEN
    IF existing<>p_provider_profile_id THEN RAISE EXCEPTION 'HQ_AD_PROFILE_CONFLICT' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('providerProfileId',existing,'linked',false);
  END IF;
  IF EXISTS(SELECT 1 FROM hon.school_social_profiles WHERE provider_profile_id=p_provider_profile_id) THEN
    RAISE EXCEPTION 'HQ_AD_PROFILE_CONFLICT' USING ERRCODE='23514'; END IF;
  INSERT INTO hon.hq_ad_profile(provider_profile_id,linked_by_principal_id) VALUES(p_provider_profile_id,actor);
  PERFORM hon.hq_ad_event('PROFILE_LINKED',actor,p_intent,NULL,'{}'::jsonb);
  PERFORM hon.require_hq_ad_actor(p_subject,true);
  RETURN jsonb_build_object('providerProfileId',p_provider_profile_id,'linked',true);
END $$;

-- CLAIM: the browser came back with the state. Same person, unexpired and unused; consumed now.
CREATE FUNCTION hon.claim_hq_ad_connect(p_subject text,p_state_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; i hon.hq_ad_connect_intents%ROWTYPE; profile text;
BEGIN
  actor:=hon.require_hq_ad_actor(p_subject,true);
  IF p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'HQ_AD_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT id INTO i.id FROM hon.hq_ad_connect_intents WHERE state_hash=p_state_hash;
  -- An unknown state reads the same as a used one.
  i:=hon.hq_ad_open_intent(actor,i.id);
  SELECT provider_profile_id INTO profile FROM hon.hq_ad_profile;
  IF profile IS NULL THEN RAISE EXCEPTION 'HQ_AD_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  UPDATE hon.hq_ad_connect_intents SET consumed_at=clock_timestamp() WHERE id=i.id;
  PERFORM hon.require_hq_ad_actor(p_subject,true);
  RETURN jsonb_build_object('intentId',i.id,'provider',i.provider,'providerProfileId',profile);
END $$;

-- RECORD: the accounts the API listed on HQ's own profile for the claimed intent's provider, once per intent.
-- p_accounts = [{providerAccountId, displayName}], at most 25. An account a school holds (Meta = the school's Facebook
-- account, Google Ads = its Google Ads account) is skipped and only counted.
CREATE FUNCTION hon.record_hq_ad_accounts(p_subject text,p_intent uuid,p_accounts jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; i hon.hq_ad_connect_intents%ROWTYPE; e jsonb; a hon.hq_ad_accounts%ROWTYPE; v_id text; v_name text;
  connected integer:=0; conflicts integer:=0; seen text[]:='{}'; school_platform text;
BEGIN
  actor:=hon.require_hq_ad_actor(p_subject,true);
  IF p_intent IS NULL OR p_accounts IS NULL OR jsonb_typeof(p_accounts)<>'array' OR jsonb_array_length(p_accounts)>25 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_accounts) LOOP
    IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['displayName','providerAccountId']
      OR jsonb_typeof(e->'providerAccountId') IS DISTINCT FROM 'string' OR (e->>'providerAccountId') !~ '^[0-9A-Za-z_-]{1,64}$'
      OR jsonb_typeof(e->'displayName') IS DISTINCT FROM 'string' OR length(e->>'displayName') NOT BETWEEN 1 AND 120 OR (e->>'displayName') ~ '[[:cntrl:]]'
      OR (e->>'providerAccountId')=ANY(seen) THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
    seen:=seen||(e->>'providerAccountId');
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended('hq-ad-connect',0));
  SELECT * INTO i FROM hon.hq_ad_connect_intents WHERE id=p_intent FOR UPDATE;
  IF i.id IS NULL OR i.started_by_principal_id<>actor OR i.consumed_at IS NULL OR i.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'HQ_AD_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  school_platform:=CASE i.provider WHEN 'GOOGLE_ADS' THEN 'GOOGLE_ADS' ELSE 'FACEBOOK' END;
  FOR e IN SELECT x FROM jsonb_array_elements(p_accounts) x ORDER BY x->>'providerAccountId' LOOP
    v_id:=e->>'providerAccountId'; v_name:=e->>'displayName';
    -- The same lock key the school flow takes for this platform account, so HQ and a school cannot both take it.
    PERFORM pg_advisory_xact_lock(hashtextextended('social-account:'||school_platform||':'||v_id,0));
    IF EXISTS(SELECT 1 FROM hon.school_social_accounts s WHERE s.platform=school_platform AND s.provider_account_id=v_id) THEN
      conflicts:=conflicts+1; CONTINUE; END IF;
    SELECT * INTO a FROM hon.hq_ad_accounts WHERE provider=i.provider AND provider_account_id=v_id FOR UPDATE;
    IF a.id IS NULL THEN
      INSERT INTO hon.hq_ad_accounts(provider,provider_account_id,display_name,status,connected_by_principal_id)
        VALUES(i.provider,v_id,v_name,'CONNECTED',actor) RETURNING * INTO a;
      PERFORM hon.hq_ad_event('ACCOUNT_CONNECTED',actor,i.id,a.id,jsonb_build_object('provider',a.provider));
    ELSE
      UPDATE hon.hq_ad_accounts SET status='CONNECTED',display_name=v_name,version=version+1,updated_at=greatest(clock_timestamp(),a.updated_at),
        connected_at=CASE WHEN a.status='DISCONNECTED' THEN clock_timestamp() ELSE connected_at END,disconnected_at=NULL
        WHERE id=a.id RETURNING * INTO a;
      PERFORM hon.hq_ad_event('ACCOUNT_CONNECTED',actor,i.id,a.id,jsonb_build_object('provider',a.provider,'reconnected',true));
    END IF;
    connected:=connected+1; a:=NULL;
  END LOOP;
  UPDATE hon.hq_ad_connect_intents SET outcome=CASE WHEN connected>0 THEN 'RECORDED' ELSE 'NOTHING_FOUND' END,
    connected_count=connected,conflict_count=conflicts WHERE id=i.id;
  PERFORM hon.hq_ad_event('CONNECT_FINISHED',actor,i.id,NULL,jsonb_build_object('provider',i.provider,'connected',connected,'conflicts',conflicts));
  PERFORM hon.require_hq_ad_actor(p_subject,true);
  RETURN jsonb_build_object('provider',i.provider,'connected',connected,'conflicts',conflicts,'accounts',hon.hq_ad_accounts_json());
END $$;

-- DISCONNECT {expectedVersion}: idempotent per person and uuid key. Returns the provider account id once, only so the
-- API can ask Zernio to remove it.
CREATE FUNCTION hon.disconnect_hq_ad_account(p_subject text,p_account uuid,p_input jsonb,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; fp text; a hon.hq_ad_accounts%ROWTYPE; result jsonb; at timestamptz;
BEGIN
  actor:=hon.require_hq_ad_actor(p_subject,true);
  IF p_account IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['expectedVersion']
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  fp:=hon.saas_fingerprint(ARRAY['hq.ad.disconnect',p_account::text,p_input::text]);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-ad:'||actor::text||':'||p_key::text,0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE='55P03'; END IF;
  SELECT response INTO replay FROM hon.hq_ad_requests WHERE actor_principal_id=actor AND idempotency_key=p_key
    AND operation='DISCONNECT' AND fingerprint=fp;
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_ad_actor(p_subject,true); RETURN jsonb_build_object('record',replay,'replayed',true); END IF;
  IF EXISTS(SELECT 1 FROM hon.hq_ad_requests WHERE actor_principal_id=actor AND idempotency_key=p_key) THEN
    RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE='23505'; END IF;
  SELECT * INTO a FROM hon.hq_ad_accounts WHERE id=p_account FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF a.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF a.status<>'CONNECTED' THEN RAISE EXCEPTION 'HQ_AD_ACCOUNT_DISCONNECTED' USING ERRCODE='23514'; END IF;
  at:=greatest(clock_timestamp(),a.updated_at);
  UPDATE hon.hq_ad_accounts SET status='DISCONNECTED',version=version+1,updated_at=at,disconnected_at=at WHERE id=a.id RETURNING * INTO a;
  PERFORM hon.hq_ad_event('ACCOUNT_DISCONNECTED',actor,NULL,a.id,jsonb_build_object('provider',a.provider));
  result:=hon.hq_ad_account_json(a)||jsonb_build_object('providerAccountId',a.provider_account_id);
  INSERT INTO hon.hq_ad_requests VALUES(actor,p_key,'DISCONNECT',fp,a.id,result,at);
  PERFORM hon.require_hq_ad_actor(p_subject,true);
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.guard_hq_ad()','hon.hq_ad_owner_eligible(uuid)','hon.require_hq_ad_actor(text,boolean)',
    'hon.hq_ad_account_json(hon.hq_ad_accounts)','hon.hq_ad_accounts_json()','hon.hq_ad_event(text,uuid,uuid,uuid,jsonb)',
    'hon.hq_ad_open_intent(uuid,uuid)','hon.read_hq_ad_accounts(text)','hon.start_hq_ad_connect(text,jsonb,text)',
    'hon.record_hq_ad_profile(text,uuid,text)','hon.claim_hq_ad_connect(text,text)','hon.record_hq_ad_accounts(text,uuid,jsonb)',
    'hon.disconnect_hq_ad_account(text,uuid,jsonb,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hq_ad_accounts(text),hon.start_hq_ad_connect(text,jsonb,text),hon.record_hq_ad_profile(text,uuid,text),
      hon.claim_hq_ad_connect(text,text),hon.record_hq_ad_accounts(text,uuid,jsonb),hon.disconnect_hq_ad_account(text,uuid,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
