BEGIN;

-- S1 (0347, coordinator-allocated 2026-11-14): each school connects its own Facebook Page and Instagram professional
-- account through Zernio (docs/architecture/SOCIAL_POSTING_INBOX_ADS.md §4). Owner (David, 2026-11-14): "i want our
-- platform to do ad and messanger and able to post as well". This piece only records connections; nothing is posted,
-- sent or spent, and the API calls Zernio only when HON_ZERNIO_CONNECT_APPROVED=true.
-- - One Zernio profile per school, created once and never moved. One provider account belongs to one school, ever
--   (the 0250 rule): a claim from another school is skipped as a conflict, never moved.
-- - A connect attempt is a single-use intent bound to the person, the session school and the platform, holding only the
--   SHA-256 of the random state; it expires after 10 minutes. Redirect query values are never trusted: the API lists the
--   accounts on the school's own profile from Zernio.
-- - Each account has three switches (publishing, inbox, ads), all off when connected and forced off on disconnect.
-- - Authority: a direct human at the session school with live marketing.social.manage (connect, switches, disconnect) or
--   marketing.social.read (see accounts), an active school and organization, and an active HON entitlement (the 0331
--   checks). HQ, family, student, delegated and agent callers are refused. Authority is re-checked after the writes.
-- - Identifier-only audit and inert outbox. No token is held by HON; Zernio keeps the platform tokens.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regclass('hon.organization_entitlements') IS NULL
    OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL THEN RAISE EXCEPTION '0347 requires the staff, entitlement and timestamp helpers'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('marketing.social.manage','Connect and disconnect the school''s Facebook and Instagram accounts and turn their publishing, inbox and ads switches on or off',true,true),
  ('marketing.social.read','See the school''s connected Facebook and Instagram accounts',false,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN (VALUES ('marketing.social.manage'),('marketing.social.read')) p(code)
  WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

CREATE TABLE hon.school_social_profiles (
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'ZERNIO' CHECK (provider='ZERNIO'),
  provider_profile_id text NOT NULL UNIQUE CHECK (provider_profile_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  linked_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);

CREATE TABLE hon.school_social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('FACEBOOK','INSTAGRAM')),
  provider_account_id text NOT NULL CHECK (provider_account_id ~ '^[0-9A-Za-z_-]{1,64}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120 AND display_name !~ '[[:cntrl:]]'),
  status text NOT NULL CHECK (status IN ('CONNECTED','DISCONNECTED')),
  publish_enabled boolean NOT NULL DEFAULT false,
  inbox_enabled boolean NOT NULL DEFAULT false,
  ads_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  connected_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disconnected_at timestamptz,
  FOREIGN KEY (organization_id,school_id) REFERENCES hon.school_social_profiles(organization_id,school_id),
  -- One school per platform account, ever.
  UNIQUE (platform,provider_account_id),
  CHECK (status='CONNECTED' OR NOT (publish_enabled OR inbox_enabled OR ads_enabled)),
  CHECK ((status='DISCONNECTED')=(disconnected_at IS NOT NULL))
);
CREATE INDEX school_social_accounts_school_idx ON hon.school_social_accounts (organization_id,school_id,platform,connected_at);

CREATE TABLE hon.school_social_connect_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('FACEBOOK','INSTAGRAM')),
  started_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  outcome text CHECK (outcome IN ('RECORDED','NOTHING_FOUND')),
  connected_count integer CHECK (connected_count BETWEEN 0 AND 25),
  conflict_count integer CHECK (conflict_count BETWEEN 0 AND 25),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK (expires_at=created_at+interval '10 minutes'),
  CHECK (outcome IS NULL OR consumed_at IS NOT NULL),
  CHECK ((outcome IS NULL)=(connected_count IS NULL) AND (outcome IS NULL)=(conflict_count IS NULL))
);
CREATE INDEX school_social_connect_intents_school_idx ON hon.school_social_connect_intents (organization_id,school_id,created_at DESC);

CREATE TABLE hon.school_social_commands (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('CHANGE')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

ALTER TABLE hon.school_social_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_connect_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_connect_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_social_commands FORCE ROW LEVEL SECURITY;

-- Profiles never change. An account never changes school, platform or provider id. An intent is consumed once and
-- records its outcome once. A command records its response once. Nothing is deleted or truncated.
CREATE FUNCTION hon.guard_school_social() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_accounts' THEN
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.platform,NEW.provider_account_id,NEW.connected_by_principal_id)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.platform,OLD.provider_account_id,OLD.connected_by_principal_id)
      AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_connect_intents' THEN
    IF (NEW.id,NEW.organization_id,NEW.school_id,NEW.platform,NEW.started_by_principal_id,NEW.state_hash,NEW.created_at,NEW.expires_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.platform,OLD.started_by_principal_id,OLD.state_hash,OLD.created_at,OLD.expires_at)
      AND ((OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND NEW.outcome IS NULL)
        OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at=OLD.consumed_at AND OLD.outcome IS NULL AND NEW.outcome IS NOT NULL)) THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' AND TG_TABLE_NAME='school_social_commands' THEN
    IF OLD.response IS NULL AND NEW.response IS NOT NULL
      AND (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
        IS NOT DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SOCIAL_RECORD_IMMUTABLE' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_profiles','school_social_accounts','school_social_connect_intents','school_social_commands'] LOOP
    EXECUTE format('CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_school_social()',t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_social()',t);
  END LOOP;
END $$;

-- The direct human at the session school with the live permission and an active HON entitlement (the 0331 checks).
CREATE FUNCTION hon.require_school_social_actor(p_subject text,p_permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_permission NOT IN ('marketing.social.manage','marketing.social.read')
    OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 2048 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=p_permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.school_social_check_call(p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
END $$;

CREATE FUNCTION hon.school_social_account_json(a hon.school_social_accounts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('accountId',a.id,'platform',a.platform,'displayName',a.display_name,'status',a.status,
    'publishEnabled',a.publish_enabled,'inboxEnabled',a.inbox_enabled,'adsEnabled',a.ads_enabled,'version',a.version,
    'connectedAt',hon.saas_ts(a.connected_at),'updatedAt',hon.saas_ts(a.updated_at),'disconnectedAt',hon.saas_ts(a.disconnected_at));
$$;

CREATE FUNCTION hon.school_social_evidence(p_org uuid,p_school uuid,p_actor uuid,p_action text,p_entity_type text,p_entity uuid,p_version integer,p_state jsonb,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(p_org,p_school,p_actor,'HUMAN_UI',p_action,p_entity_type,p_entity,p_state,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(p_org,p_school,p_action,1,p_entity_type,p_entity,p_version,p_correlation,p_request,p_state||jsonb_build_object('internalOnly',true));
END $$;

-- READ: the school's accounts (connected first, then disconnected), and whether a Zernio profile is linked.
CREATE FUNCTION hon.read_school_social_accounts(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  PERFORM hon.require_school_social_actor(p_subject,'marketing.social.read');
  RETURN jsonb_build_object(
    'profileLinked',EXISTS(SELECT 1 FROM hon.school_social_profiles WHERE organization_id=org AND school_id=school),
    'accounts',coalesce((SELECT jsonb_agg(hon.school_social_account_json(a) ORDER BY a.status,a.platform,a.connected_at,a.id)
      FROM hon.school_social_accounts a WHERE a.organization_id=org AND a.school_id=school),'[]'::jsonb),
    'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;

-- START {platform}: a new single-use intent holding only the hash of the random state the API made.
-- At most 10 attempts per school per hour. Returns the school's Zernio profile id if one is linked.
CREATE FUNCTION hon.start_school_social_connect(p_subject text,p_input jsonb,p_state_hash text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; i hon.school_social_connect_intents%ROWTYPE;
  at timestamptz:=clock_timestamp();
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['platform']
    OR jsonb_typeof(p_input->'platform') IS DISTINCT FROM 'string' OR (p_input->>'platform') NOT IN ('FACEBOOK','INSTAGRAM')
    OR p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.manage');
  PERFORM pg_advisory_xact_lock(hashtextextended('school-social:'||school::text,0));
  IF (SELECT count(*) FROM hon.school_social_connect_intents WHERE organization_id=org AND school_id=school AND created_at>at-interval '1 hour')>=10 THEN
    RAISE EXCEPTION 'SOCIAL_RATE_LIMITED' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.school_social_connect_intents(organization_id,school_id,platform,started_by_principal_id,state_hash,created_at,expires_at)
    VALUES(org,school,p_input->>'platform',actor,p_state_hash,at,at+interval '10 minutes') RETURNING * INTO i;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.connect.started','SCHOOL_SOCIAL_CONNECT',i.id,1,
    jsonb_build_object('platform',i.platform),p_request,p_correlation);
  IF hon.require_school_social_actor(p_subject,'marketing.social.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('intentId',i.id,'platform',i.platform,'expiresAt',hon.saas_ts(i.expires_at),
    'providerProfileId',(SELECT provider_profile_id FROM hon.school_social_profiles WHERE organization_id=org AND school_id=school));
END $$;

-- The open (unused, unexpired) intent this person started at this school.
CREATE FUNCTION hon.school_social_open_intent(p_org uuid,p_school uuid,p_actor uuid,p_intent uuid) RETURNS hon.school_social_connect_intents
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE i hon.school_social_connect_intents%ROWTYPE;
BEGIN
  SELECT * INTO i FROM hon.school_social_connect_intents WHERE id=p_intent AND organization_id=p_org AND school_id=p_school FOR UPDATE;
  IF i.id IS NULL OR i.started_by_principal_id<>p_actor OR i.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'SOCIAL_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  IF i.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'SOCIAL_CONNECT_STATE_EXPIRED' USING ERRCODE='22023'; END IF;
  RETURN i;
END $$;

-- PROFILE: links the school's Zernio profile the API found or created by HON's own name. First writer wins; a
-- different id for the same school, or an id another school already holds, is refused.
CREATE FUNCTION hon.record_school_social_profile(p_subject text,p_intent uuid,p_provider_profile_id text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; existing text;
BEGIN
  IF p_intent IS NULL OR p_provider_profile_id IS NULL OR p_provider_profile_id !~ '^[0-9A-Za-z_-]{1,64}$' THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.manage');
  PERFORM pg_advisory_xact_lock(hashtextextended('school-social:'||school::text,0));
  PERFORM hon.school_social_open_intent(org,school,actor,p_intent);
  SELECT provider_profile_id INTO existing FROM hon.school_social_profiles WHERE organization_id=org AND school_id=school;
  IF existing IS NOT NULL THEN
    IF existing<>p_provider_profile_id THEN RAISE EXCEPTION 'SOCIAL_PROFILE_CONFLICT' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('providerProfileId',existing,'linked',false);
  END IF;
  IF EXISTS(SELECT 1 FROM hon.school_social_profiles WHERE provider_profile_id=p_provider_profile_id) THEN
    RAISE EXCEPTION 'SOCIAL_PROFILE_CONFLICT' USING ERRCODE='23505'; END IF;
  INSERT INTO hon.school_social_profiles(organization_id,school_id,provider_profile_id,linked_by_principal_id) VALUES(org,school,p_provider_profile_id,actor);
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.profile.linked','SCHOOL_SOCIAL_CONNECT',p_intent,1,'{}'::jsonb,p_request,p_correlation);
  IF hon.require_school_social_actor(p_subject,'marketing.social.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('providerProfileId',p_provider_profile_id,'linked',true);
END $$;

-- CLAIM: the browser returned with the state. Same person, same session school, unexpired and unused; consumed now.
CREATE FUNCTION hon.claim_school_social_connect(p_subject text,p_state_hash text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; i hon.school_social_connect_intents%ROWTYPE; profile text;
BEGIN
  IF p_state_hash IS NULL OR p_state_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'SOCIAL_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.manage');
  SELECT id INTO i.id FROM hon.school_social_connect_intents WHERE state_hash=p_state_hash;
  -- An unknown state, or one from another school, reads the same as a used one.
  i:=hon.school_social_open_intent(org,school,actor,i.id);
  SELECT provider_profile_id INTO profile FROM hon.school_social_profiles WHERE organization_id=org AND school_id=school;
  IF profile IS NULL THEN RAISE EXCEPTION 'SOCIAL_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  UPDATE hon.school_social_connect_intents SET consumed_at=clock_timestamp() WHERE id=i.id;
  IF hon.require_school_social_actor(p_subject,'marketing.social.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('intentId',i.id,'platform',i.platform,'providerProfileId',profile);
END $$;

-- RECORD: the accounts the API listed on the school's own profile for the claimed intent's platform, once per intent.
-- p_accounts = [{providerAccountId, displayName}], at most 25. New accounts arrive with every switch off; accounts
-- already at this school are CONNECTED again (switches stay as they are when connected, off when coming back from
-- DISCONNECTED); accounts another school holds are skipped and only counted.
CREATE FUNCTION hon.record_school_social_accounts(p_subject text,p_intent uuid,p_accounts jsonb,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; i hon.school_social_connect_intents%ROWTYPE;
  e jsonb; a hon.school_social_accounts%ROWTYPE; v_id text; v_name text; connected integer:=0; conflicts integer:=0; seen text[]:='{}';
BEGIN
  IF p_intent IS NULL OR p_accounts IS NULL OR jsonb_typeof(p_accounts)<>'array' OR jsonb_array_length(p_accounts)>25 THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_accounts) LOOP
    IF jsonb_typeof(e)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['displayName','providerAccountId']
      OR jsonb_typeof(e->'providerAccountId') IS DISTINCT FROM 'string' OR (e->>'providerAccountId') !~ '^[0-9A-Za-z_-]{1,64}$'
      OR jsonb_typeof(e->'displayName') IS DISTINCT FROM 'string' OR length(e->>'displayName') NOT BETWEEN 1 AND 120 OR (e->>'displayName') ~ '[[:cntrl:]]'
      OR (e->>'providerAccountId')=ANY(seen) THEN RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
    seen:=seen||(e->>'providerAccountId');
  END LOOP;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.manage');
  PERFORM pg_advisory_xact_lock(hashtextextended('school-social:'||school::text,0));
  SELECT * INTO i FROM hon.school_social_connect_intents WHERE id=p_intent AND organization_id=org AND school_id=school FOR UPDATE;
  IF i.id IS NULL OR i.started_by_principal_id<>actor OR i.consumed_at IS NULL OR i.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'SOCIAL_CONNECT_STATE_INVALID' USING ERRCODE='22023'; END IF;
  -- Global order on the platform id, so two schools recording the same account cannot deadlock.
  FOR e IN SELECT x FROM jsonb_array_elements(p_accounts) x ORDER BY x->>'providerAccountId' LOOP
    v_id:=e->>'providerAccountId'; v_name:=e->>'displayName';
    PERFORM pg_advisory_xact_lock(hashtextextended('social-account:'||i.platform||':'||v_id,0));
    SELECT * INTO a FROM hon.school_social_accounts WHERE platform=i.platform AND provider_account_id=v_id FOR UPDATE;
    IF a.id IS NULL THEN
      INSERT INTO hon.school_social_accounts(organization_id,school_id,platform,provider_account_id,display_name,status,connected_by_principal_id)
        VALUES(org,school,i.platform,v_id,v_name,'CONNECTED',actor) RETURNING * INTO a;
      connected:=connected+1;
      PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.account.connected','SCHOOL_SOCIAL_ACCOUNT',a.id,a.version,
        jsonb_build_object('platform',a.platform,'intentId',i.id),p_request,p_correlation);
    ELSIF a.organization_id=org AND a.school_id=school THEN
      UPDATE hon.school_social_accounts SET status='CONNECTED',display_name=v_name,version=version+1,updated_at=clock_timestamp(),
        connected_at=CASE WHEN a.status='DISCONNECTED' THEN clock_timestamp() ELSE connected_at END,disconnected_at=NULL
        WHERE id=a.id RETURNING * INTO a;
      connected:=connected+1;
      PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.account.connected','SCHOOL_SOCIAL_ACCOUNT',a.id,a.version,
        jsonb_build_object('platform',a.platform,'intentId',i.id,'reconnected',true),p_request,p_correlation);
    ELSE
      conflicts:=conflicts+1;
    END IF;
    a:=NULL;
  END LOOP;
  UPDATE hon.school_social_connect_intents SET outcome=CASE WHEN connected>0 THEN 'RECORDED' ELSE 'NOTHING_FOUND' END,
    connected_count=connected,conflict_count=conflicts WHERE id=i.id;
  PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.connect.finished','SCHOOL_SOCIAL_CONNECT',i.id,2,
    jsonb_build_object('platform',i.platform,'connected',connected,'conflicts',conflicts),p_request,p_correlation);
  IF hon.require_school_social_actor(p_subject,'marketing.social.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('platform',i.platform,'connected',connected,'conflicts',conflicts,
    'accounts',coalesce((SELECT jsonb_agg(hon.school_social_account_json(x) ORDER BY x.status,x.platform,x.connected_at,x.id)
      FROM hon.school_social_accounts x WHERE x.organization_id=org AND x.school_id=school),'[]'::jsonb));
END $$;

-- CHANGE {expectedVersion, publishEnabled, inboxEnabled, adsEnabled} or {expectedVersion, disconnect: true}.
-- Switches change only on a CONNECTED account. Disconnect forces every switch off. Idempotent per person and key.
CREATE FUNCTION hon.change_school_social_account(p_subject text,p_account uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; prior hon.school_social_commands%ROWTYPE;
  fp text; a hon.school_social_accounts%ROWTYPE; keys text[]; result jsonb; disconnecting boolean;
BEGIN
  keys:=(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_input)='object' THEN p_input ELSE '{}'::jsonb END) k);
  disconnecting:=keys IS NOT DISTINCT FROM ARRAY['disconnect','expectedVersion'];
  IF p_account IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR NOT (disconnecting OR keys IS NOT DISTINCT FROM ARRAY['adsEnabled','expectedVersion','inboxEnabled','publishEnabled'])
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR (disconnecting AND (p_input->'disconnect') IS DISTINCT FROM 'true'::jsonb)
    OR (NOT disconnecting AND (jsonb_typeof(p_input->'publishEnabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_input->'inboxEnabled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(p_input->'adsEnabled') IS DISTINCT FROM 'boolean'))
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'SOCIAL_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_social_check_call(p_request,p_correlation);
  actor:=hon.require_school_social_actor(p_subject,'marketing.social.manage');
  fp:=encode(sha256(convert_to('marketing.social.account.change:'||p_account::text||':'||p_input::text,'UTF8')),'hex');
  INSERT INTO hon.school_social_commands(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,actor,p_key,'CHANGE',fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.school_social_commands WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'SOCIAL_BUSY' USING ERRCODE='55P03'; END IF;
    RETURN jsonb_build_object('record',prior.response,'replayed',true);
  END IF;
  SELECT * INTO a FROM hon.school_social_accounts WHERE id=p_account AND organization_id=org AND school_id=school FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF a.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SOCIAL_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF a.status<>'CONNECTED' THEN RAISE EXCEPTION 'SOCIAL_ACCOUNT_DISCONNECTED' USING ERRCODE='23514'; END IF;
  IF disconnecting THEN
    UPDATE hon.school_social_accounts SET status='DISCONNECTED',publish_enabled=false,inbox_enabled=false,ads_enabled=false,
      version=version+1,updated_at=clock_timestamp(),disconnected_at=clock_timestamp() WHERE id=a.id RETURNING * INTO a;
    PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.account.disconnected','SCHOOL_SOCIAL_ACCOUNT',a.id,a.version,
      jsonb_build_object('platform',a.platform),p_request,p_correlation);
  ELSE
    UPDATE hon.school_social_accounts SET publish_enabled=(p_input->>'publishEnabled')::boolean,inbox_enabled=(p_input->>'inboxEnabled')::boolean,
      ads_enabled=(p_input->>'adsEnabled')::boolean,version=version+1,updated_at=clock_timestamp() WHERE id=a.id RETURNING * INTO a;
    PERFORM hon.school_social_evidence(org,school,actor,'marketing.social.account.changed','SCHOOL_SOCIAL_ACCOUNT',a.id,a.version,
      jsonb_build_object('platform',a.platform,'publishEnabled',a.publish_enabled,'inboxEnabled',a.inbox_enabled,'adsEnabled',a.ads_enabled),p_request,p_correlation);
  END IF;
  -- The provider account id leaves the database only on disconnect, so the API can ask Zernio to remove it.
  result:=hon.school_social_account_json(a)||CASE WHEN disconnecting THEN jsonb_build_object('providerAccountId',a.provider_account_id) ELSE '{}'::jsonb END;
  UPDATE hon.school_social_commands SET response=result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
  IF hon.require_school_social_actor(p_subject,'marketing.social.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SOCIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['school_social_profiles','school_social_accounts','school_social_connect_intents','school_social_commands'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_school_social()','hon.require_school_social_actor(text,text)','hon.school_social_check_call(uuid,uuid)',
    'hon.school_social_account_json(hon.school_social_accounts)','hon.school_social_evidence(uuid,uuid,uuid,text,text,uuid,integer,jsonb,uuid,uuid)',
    'hon.read_school_social_accounts(text)','hon.start_school_social_connect(text,jsonb,text,uuid,uuid)',
    'hon.school_social_open_intent(uuid,uuid,uuid,uuid)','hon.record_school_social_profile(text,uuid,text,uuid,uuid)',
    'hon.claim_school_social_connect(text,text,uuid,uuid)','hon.record_school_social_accounts(text,uuid,jsonb,uuid,uuid)',
    'hon.change_school_social_account(text,uuid,jsonb,text,uuid,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_social_accounts(text),hon.start_school_social_connect(text,jsonb,text,uuid,uuid),
      hon.record_school_social_profile(text,uuid,text,uuid,uuid),hon.claim_school_social_connect(text,text,uuid,uuid),
      hon.record_school_social_accounts(text,uuid,jsonb,uuid,uuid),hon.change_school_social_account(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
