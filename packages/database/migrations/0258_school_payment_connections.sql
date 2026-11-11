BEGIN;

-- B-TUI-2 piece 1 (0258, assigned by the coordinator 2026-11-11): school payment processor connections and the provider
-- seam for collecting tuition. Owner decisions (David, 2026-11-11): Stripe (Connect direct charges on the school's own
-- account) and Square (the school's own seller account) first; the design must be ready for a HON-owned processor later;
-- HON takes NO fee on any payment a school collects. Spec: docs/architecture/TUITION_COLLECTION.md.
--   C1  hon.school_pay_providers is the provider registry. Every provider-specific row names a provider code from it;
--       a later provider (HON's own) is one new row and one API adapter, no table change. live_allowed is CHECKed false.
--   C2  A school connection is TEST mode only (CHECK). Going live is a separate owner-approved migration.
--   C3  The state is derived here from the provider observation the API retrieved, never from the browser or a return URL.
--       Finishing onboarding needs the one-time onboarding state whose SHA-256 was stored with the onboarding link.
--   C4  One open connection per school and provider; one default per school and only an ACTIVE connection can be the
--       default; a provider account, once set, never changes on its connection and links inside one organization only.
--   C5  New sensitive staff-assignable permissions school_pay.connection.manage and school_pay.read, initially granted to
--       system OWNER roles only. HQ, family and parent-type principals are refused (D33).
-- Nothing here charges, refunds, stores a card or token, sends a message or runs an automation. The runtime gains no
-- table privilege: every write is a direct-human SECURITY DEFINER command with live school-scoped permission re-checks,
-- exact-request idempotency, an append-only history row, audit and an inert outbox event.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School payment connections require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School payment connections require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.membership_pause_text_ok(jsonb,boolean)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL
    OR to_regprocedure('hon.require_tuition_actor(text,text)') IS NULL THEN
    RAISE EXCEPTION 'School payment connections require 0177, 0224 and 0240';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('school_pay.connection.manage','Connect, refresh, choose the default for, or disconnect the school''s own payment processor account (test mode only)',true,true),
  ('school_pay.read','See the school''s payment processor connections and their status',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('school_pay.connection.manage','school_pay.read') AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'school_pay permissions already exist with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,x.code FROM hon.roles r CROSS JOIN (VALUES ('school_pay.connection.manage'),('school_pay.read')) x(code)
WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- C1: the provider registry.
CREATE TABLE hon.school_pay_providers (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60 AND btrim(display_name)=display_name),
  test_supported boolean NOT NULL,
  live_allowed boolean NOT NULL DEFAULT false CHECK (NOT live_allowed),
  sort_order integer NOT NULL UNIQUE CHECK (sort_order BETWEEN 1 AND 1000)
);
INSERT INTO hon.school_pay_providers(code,display_name,test_supported,live_allowed,sort_order) VALUES
  ('STRIPE_CONNECT','Stripe',true,false,10),('SQUARE','Square',true,false,20);
ALTER TABLE hon.school_pay_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_providers FORCE ROW LEVEL SECURITY;

-- Exactly the five capability booleans (C1 static manifest narrowed by the provider).
CREATE FUNCTION hon.school_pay_capabilities_ok(c jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(c)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c) k)=ARRAY['bankDebit','offSessionRecurring','oneTimeCard','refunds','storedCard']
    AND (SELECT bool_and(jsonb_typeof(c->k)='boolean') FROM jsonb_object_keys(c) k),false)
$$;

-- C2-C4: one row per school connection.
CREATE TABLE hon.school_pay_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  provider_code text NOT NULL REFERENCES hon.school_pay_providers(code) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'TEST' CHECK (mode='TEST'),
  state text NOT NULL DEFAULT 'PENDING_ONBOARDING' CHECK (state IN ('PENDING_ONBOARDING','CONNECTED_RESTRICTED','CONNECTED_ACTIVE','REAUTHORIZATION_REQUIRED','DISCONNECTED','ABANDONED')),
  provider_account_ref text CHECK (provider_account_ref IS NULL OR provider_account_ref ~ '^[A-Za-z0-9_-]{3,100}$'),
  onboarding_state_hash text CHECK (onboarding_state_hash IS NULL OR onboarding_state_hash ~ '^[0-9a-f]{64}$'),
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  requirements_due boolean NOT NULL DEFAULT false,
  capabilities jsonb NOT NULL DEFAULT '{"oneTimeCard":false,"storedCard":false,"bankDebit":false,"offSessionRecurring":false,"refunds":false}'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  status_observed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  started_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  ended_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  end_reason text CHECK (end_reason IS NULL OR (length(end_reason) BETWEEN 1 AND 1000 AND btrim(end_reason)=end_reason AND end_reason !~ '[\x01-\x1f\x7f]')),
  CHECK (NOT is_default OR state='CONNECTED_ACTIVE'),
  CHECK ((state IN ('DISCONNECTED','ABANDONED'))=(ended_at IS NOT NULL) AND (ended_at IS NULL)=(ended_by_principal_id IS NULL) AND (ended_at IS NULL)=(end_reason IS NULL)),
  CHECK (state IN ('PENDING_ONBOARDING','ABANDONED') OR provider_account_ref IS NOT NULL),
  CHECK (state='PENDING_ONBOARDING' OR onboarding_state_hash IS NULL),
  CHECK (hon.school_pay_capabilities_ok(capabilities)),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX school_pay_connections_one_open_idx ON hon.school_pay_connections(school_id,provider_code)
  WHERE state NOT IN ('DISCONNECTED','ABANDONED');
CREATE UNIQUE INDEX school_pay_connections_one_default_idx ON hon.school_pay_connections(school_id) WHERE is_default;
CREATE INDEX school_pay_connections_account_idx ON hon.school_pay_connections(provider_code,mode,provider_account_ref)
  WHERE provider_account_ref IS NOT NULL AND state NOT IN ('DISCONNECTED','ABANDONED');
CREATE INDEX school_pay_connections_school_idx ON hon.school_pay_connections(organization_id,school_id,started_at);
ALTER TABLE hon.school_pay_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_connections FORCE ROW LEVEL SECURITY;

-- Append-only history of every command on a connection.
CREATE TABLE hon.school_pay_connection_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_version integer NOT NULL CHECK (connection_version>=1),
  kind text NOT NULL CHECK (kind IN ('STARTED','ONBOARDING_LINK','FINISHED','REFRESHED','DEFAULT_SET','DEFAULT_CLEARED','DISCONNECTED','ABANDONED')),
  state text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connection_id,connection_version,kind),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.school_pay_connections(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_pay_connection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_connection_events FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_connection_events_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_connection_events
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_connection_events_no_truncate BEFORE TRUNCATE ON hon.school_pay_connection_events
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_providers_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_providers
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_providers_no_truncate BEFORE TRUNCATE ON hon.school_pay_providers
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_connections_no_truncate BEFORE TRUNCATE ON hon.school_pay_connections
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Settings-free connection guard, whoever writes: no delete; scope, provider, mode, start facts and a set account never
-- change; an ended connection never changes again; every update bumps the version by exactly one.
CREATE FUNCTION hon.guard_school_pay_connection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PENDING_ONBOARDING' OR NEW.version<>1 OR NEW.provider_account_ref IS NOT NULL OR NEW.is_default OR NEW.charges_enabled
      OR NEW.payouts_enabled OR NEW.status_observed_at IS NOT NULL THEN
      RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('DISCONNECTED','ABANDONED') OR NEW.version<>OLD.version+1
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.provider_code,NEW.mode,NEW.started_by_principal_id,NEW.started_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.provider_code,OLD.mode,OLD.started_by_principal_id,OLD.started_at)
    OR (OLD.provider_account_ref IS NOT NULL AND NEW.provider_account_ref IS DISTINCT FROM OLD.provider_account_ref)
    OR (OLD.state<>'PENDING_ONBOARDING' AND NEW.state='PENDING_ONBOARDING') THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_pay_connection_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_pay_connections
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_pay_connection();

-- Live direct-human authority at the current school, or a refusal. The identity rules are the 0224/0240 ones.
CREATE FUNCTION hon.require_school_pay_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  denial text:=CASE WHEN permission='school_pay.connection.manage' THEN 'SCHOOL_PAY_MANAGE_FORBIDDEN' ELSE 'SCHOOL_PAY_READ_FORBIDDEN' END;
BEGIN
  IF permission IS NULL OR permission NOT IN ('school_pay.connection.manage','school_pay.read')
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION '%',denial USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
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
        AND x.code=permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION '%',denial USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The first reader permission the subject holds live, or a refusal.
CREATE FUNCTION hon.require_school_pay_reader(subject text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE permission text;
BEGIN
  FOREACH permission IN ARRAY ARRAY['school_pay.connection.manage','school_pay.read'] LOOP
    BEGIN PERFORM hon.require_school_pay_actor(subject,permission); RETURN permission;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  RAISE EXCEPTION 'SCHOOL_PAY_READ_FORBIDDEN' USING ERRCODE='42501';
END $$;

CREATE FUNCTION hon.school_pay_connection_json(c hon.school_pay_connections) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('connectionId',c.id,'providerCode',c.provider_code,'mode',c.mode,'state',c.state,
    'accountRef',c.provider_account_ref,'chargesEnabled',c.charges_enabled,'payoutsEnabled',c.payouts_enabled,
    'requirementsDue',c.requirements_due,'capabilities',c.capabilities,'isDefault',c.is_default,
    'onboardingPending',c.onboarding_state_hash IS NOT NULL,'version',c.version,
    'statusObservedAt',CASE WHEN c.status_observed_at IS NULL THEN NULL ELSE to_char(c.status_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'startedAt',to_char(c.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endedAt',CASE WHEN c.ended_at IS NULL THEN NULL ELSE to_char(c.ended_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'endReason',c.end_reason)
$$;

-- Closed provider observation (C3): {accountRef, chargesEnabled, payoutsEnabled, requirementsDue, reauthorizationRequired,
-- capabilities{five booleans}}. Returns true only for exactly that shape.
CREATE FUNCTION hon.school_pay_observation_ok(o jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(o)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(o) k)=ARRAY['accountRef','capabilities','chargesEnabled','payoutsEnabled','reauthorizationRequired','requirementsDue']
    AND jsonb_typeof(o->'accountRef')='string' AND o->>'accountRef' ~ '^[A-Za-z0-9_-]{3,100}$'
    AND jsonb_typeof(o->'chargesEnabled')='boolean' AND jsonb_typeof(o->'payoutsEnabled')='boolean'
    AND jsonb_typeof(o->'requirementsDue')='boolean' AND jsonb_typeof(o->'reauthorizationRequired')='boolean'
    AND hon.school_pay_capabilities_ok(o->'capabilities'),false)
$$;

-- Shared idempotency: reserve the key, take the IAM SHARE locks, re-check live authority, and return the stored response
-- on an exact replay (after one more authority check). NULL means: proceed with the write.
CREATE FUNCTION hon.school_pay_command_begin(subject text,key text,fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_pay_actor(subject,'school_pay.connection.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF hon.require_school_pay_actor(subject,'school_pay.connection.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN prior.response_body;
END $$;

-- History row, audit, inert outbox, idempotency completion and a final authority check.
CREATE FUNCTION hon.school_pay_command_finish(subject text,key text,actor uuid,c hon.school_pay_connections,kind text,action text,
  prior_state jsonb,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); next jsonb:=hon.school_pay_connection_json(c); result jsonb;
BEGIN
  INSERT INTO hon.school_pay_connection_events(organization_id,school_id,connection_id,connection_version,kind,state,snapshot,actor_principal_id)
    VALUES(org,school,c.id,c.version,kind,c.state,next,actor);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,'SCHOOL_PAY_CONNECTION',c.id,prior_state,next,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'school_pay.connection.'||lower(kind),1,'SCHOOL_PAY_CONNECTION',c.id,c.version,correlation,request,next);
  result:=jsonb_build_object('connection',next);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_pay_actor(subject,'school_pay.connection.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Common argument check for the commands on one existing connection: {expectedVersion, ...allowed}.
CREATE FUNCTION hon.school_pay_args_ok(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid,required text[],allowed text[]) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(p)='object' AND hon.membership_command_args_ok(subject,key,request,correlation)
    AND (selected IS NOT NULL OR NOT ('expectedVersion'=ANY(required)))
    AND p ?& required AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE NOT x=ANY(allowed))
    AND (NOT p ? 'expectedVersion' OR (jsonb_typeof(p->'expectedVersion')='number' AND (p->'expectedVersion')::text ~ '^[1-9][0-9]{0,8}$')),false)
$$;

-- Lock and load one current-school connection, checking the expected version.
CREATE FUNCTION hon.school_pay_lock_connection(selected uuid,expected integer) RETURNS hon.school_pay_connections
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.school_pay_connections%ROWTYPE;
BEGIN
  LOCK TABLE hon.school_pay_connections IN ROW EXCLUSIVE MODE;
  SELECT * INTO c FROM hon.school_pay_connections x WHERE x.id=selected AND x.organization_id=hon.current_organization_id()
    AND x.school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN c;
END $$;

-- Read: providers, this school's connections (open first, then the 20 most recent ended), and whether the reader manages.
CREATE FUNCTION hon.read_school_payment_processors(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; result jsonb;
BEGIN
  used:=hon.require_school_pay_reader(subject); actor:=hon.require_school_pay_actor(subject,used);
  result:=jsonb_build_object('canManage',used='school_pay.connection.manage','platformFee','NONE',
    'providers',(SELECT coalesce(jsonb_agg(jsonb_build_object('providerCode',v.code,'displayName',v.display_name,'testSupported',v.test_supported,'liveAllowed',v.live_allowed) ORDER BY v.sort_order),'[]'::jsonb)
      FROM hon.school_pay_providers v),
    'connections',coalesce((SELECT jsonb_agg(hon.school_pay_connection_json(c) ORDER BY c.ended_at IS NOT NULL,c.started_at DESC,c.id) FROM (
      SELECT * FROM hon.school_pay_connections x WHERE x.organization_id=org AND x.school_id=school AND x.ended_at IS NULL
      UNION ALL
      (SELECT * FROM hon.school_pay_connections x WHERE x.organization_id=org AND x.school_id=school AND x.ended_at IS NOT NULL ORDER BY x.ended_at DESC,x.id LIMIT 20)) c),'[]'::jsonb));
  IF hon.require_school_pay_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Start: a PENDING_ONBOARDING connection to one registered provider that supports test mode.
CREATE FUNCTION hon.start_school_payment_connection(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; c hon.school_pay_connections%ROWTYPE;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,NULL,p,key,request,correlation,ARRAY['providerCode'],ARRAY['providerCode'])
    OR jsonb_typeof(p->'providerCode') IS DISTINCT FROM 'string' OR p->>'providerCode' !~ '^[A-Z][A-Z0-9_]{1,39}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.connection.start','input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_command_begin(subject,key,fp);
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.school_pay_providers v WHERE v.code=p->>'providerCode' AND v.test_supported) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_PROVIDER_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  LOCK TABLE hon.school_pay_connections IN ROW EXCLUSIVE MODE;
  PERFORM 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org FOR NO KEY UPDATE;
  IF EXISTS(SELECT 1 FROM hon.school_pay_connections x WHERE x.school_id=school AND x.provider_code=p->>'providerCode' AND x.ended_at IS NULL) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_EXISTS' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.school_pay_connections(organization_id,school_id,provider_code,started_by_principal_id)
    VALUES(org,school,p->>'providerCode',actor) RETURNING * INTO c;
  RETURN jsonb_build_object('receipt',hon.school_pay_command_finish(subject,key,actor,c,'STARTED','school_pay.connection.start',NULL,request,correlation),'replayed',false);
END $$;

-- Onboarding link: store the SHA-256 of a fresh one-time onboarding state (replacing any earlier one) and, when the
-- provider created the account up front (Stripe), its account reference (set once).
CREATE FUNCTION hon.set_school_payment_onboarding_link(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; c hon.school_pay_connections%ROWTYPE; prior jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','onboardingStateHash'],ARRAY['expectedVersion','onboardingStateHash','accountRef'])
    OR jsonb_typeof(p->'onboardingStateHash') IS DISTINCT FROM 'string' OR p->>'onboardingStateHash' !~ '^[0-9a-f]{64}$'
    OR (p ? 'accountRef' AND (jsonb_typeof(p->'accountRef') IS DISTINCT FROM 'string' OR p->>'accountRef' !~ '^[A-Za-z0-9_-]{3,100}$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  -- Each attempt carries a fresh state (and Stripe may create a new account on a retry), so the fingerprint is the
  -- connection and version only: a retry with the same key returns the first stored receipt.
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.connection.onboarding_link','connectionId',selected,'expectedVersion',p->'expectedVersion')::text,'UTF8')),'hex');
  replay:=hon.school_pay_command_begin(subject,key,fp);
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  c:=hon.school_pay_lock_connection(selected,(p->>'expectedVersion')::integer);
  IF c.state<>'PENDING_ONBOARDING' THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_STATE' USING ERRCODE='40001'; END IF;
  IF p ? 'accountRef' AND c.provider_account_ref IS NOT NULL AND c.provider_account_ref<>p->>'accountRef' THEN
    RAISE EXCEPTION 'SCHOOL_PAY_ACCOUNT_MISMATCH' USING ERRCODE='22023'; END IF;
  IF p ? 'accountRef' THEN PERFORM hon.school_pay_account_free(c,p->>'accountRef'); END IF;
  prior:=hon.school_pay_connection_json(c);
  UPDATE hon.school_pay_connections SET version=version+1,onboarding_state_hash=p->>'onboardingStateHash',
      provider_account_ref=coalesce(provider_account_ref,p->>'accountRef')
    WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('receipt',hon.school_pay_command_finish(subject,key,actor,c,'ONBOARDING_LINK','school_pay.connection.onboarding_link',prior,request,correlation),'replayed',false);
END $$;

-- A provider account links inside one organization only (v3 correction 2); serialized per account reference.
CREATE FUNCTION hon.school_pay_account_free(c hon.school_pay_connections,account text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('school_pay_account:'||c.provider_code||':'||c.mode||':'||account,0));
  IF EXISTS(SELECT 1 FROM hon.school_pay_connections x WHERE x.provider_code=c.provider_code AND x.mode=c.mode AND x.provider_account_ref=account
      AND x.ended_at IS NULL AND x.organization_id<>c.organization_id) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_ACCOUNT_LINKED_ELSEWHERE' USING ERRCODE='40001'; END IF;
END $$;

-- Finish onboarding (C3) or refresh status: apply one provider observation the API retrieved. FINISH needs a
-- PENDING_ONBOARDING connection and the one-time onboarding state; REFRESH needs a connected or reauthorization state.
CREATE FUNCTION hon.record_school_payment_status(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; c hon.school_pay_connections%ROWTYPE; prior jsonb; o jsonb; kind text; next_state text; fp_input jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','kind','observation'],ARRAY['expectedVersion','kind','observation','onboardingState'])
    OR jsonb_typeof(p->'kind') IS DISTINCT FROM 'string' OR p->>'kind' NOT IN ('FINISH','REFRESH')
    OR ((p->>'kind'='FINISH')<>(p ? 'onboardingState'))
    OR (p ? 'onboardingState' AND (jsonb_typeof(p->'onboardingState') IS DISTINCT FROM 'string' OR p->>'onboardingState' !~ '^[A-Za-z0-9_-]{32,128}$'))
    OR NOT hon.school_pay_observation_ok(p->'observation') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  o:=p->'observation'; kind:=p->>'kind';
  -- The raw onboarding state never reaches the stored fingerprint.
  fp_input:=CASE WHEN p ? 'onboardingState' THEN (p-'onboardingState')||jsonb_build_object('onboardingStateHash',encode(sha256(convert_to(p->>'onboardingState','UTF8')),'hex')) ELSE p END;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.connection.status','connectionId',selected,'input',fp_input)::text,'UTF8')),'hex');
  replay:=hon.school_pay_command_begin(subject,key,fp);
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  c:=hon.school_pay_lock_connection(selected,(p->>'expectedVersion')::integer);
  IF kind='FINISH' THEN
    IF c.state<>'PENDING_ONBOARDING' OR c.onboarding_state_hash IS NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_STATE' USING ERRCODE='40001'; END IF;
    IF encode(sha256(convert_to(p->>'onboardingState','UTF8')),'hex')<>c.onboarding_state_hash THEN
      RAISE EXCEPTION 'SCHOOL_PAY_ONBOARDING_STATE_MISMATCH' USING ERRCODE='42501'; END IF;
  ELSIF c.state NOT IN ('CONNECTED_RESTRICTED','CONNECTED_ACTIVE','REAUTHORIZATION_REQUIRED') THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_STATE' USING ERRCODE='40001'; END IF;
  IF c.provider_account_ref IS NOT NULL AND c.provider_account_ref<>o->>'accountRef' THEN
    RAISE EXCEPTION 'SCHOOL_PAY_ACCOUNT_MISMATCH' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_pay_account_free(c,o->>'accountRef');
  next_state:=CASE WHEN (o->>'reauthorizationRequired')::boolean THEN 'REAUTHORIZATION_REQUIRED'
    WHEN (o->>'chargesEnabled')::boolean AND NOT (o->>'requirementsDue')::boolean THEN 'CONNECTED_ACTIVE' ELSE 'CONNECTED_RESTRICTED' END;
  prior:=hon.school_pay_connection_json(c);
  UPDATE hon.school_pay_connections SET version=version+1,state=next_state,provider_account_ref=o->>'accountRef',onboarding_state_hash=NULL,
      charges_enabled=(o->>'chargesEnabled')::boolean,payouts_enabled=(o->>'payoutsEnabled')::boolean,requirements_due=(o->>'requirementsDue')::boolean,
      capabilities=CASE WHEN next_state='CONNECTED_ACTIVE' THEN o->'capabilities'
        ELSE '{"oneTimeCard":false,"storedCard":false,"bankDebit":false,"offSessionRecurring":false,"refunds":false}'::jsonb END,
      is_default=is_default AND next_state='CONNECTED_ACTIVE',status_observed_at=clock_timestamp()
    WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('receipt',hon.school_pay_command_finish(subject,key,actor,c,CASE WHEN kind='FINISH' THEN 'FINISHED' ELSE 'REFRESHED' END,
    'school_pay.connection.'||lower(kind),prior,request,correlation),'replayed',false);
END $$;

-- Default: one CONNECTED_ACTIVE connection becomes the school's default; any earlier default is cleared first.
CREATE FUNCTION hon.set_default_school_payment_connection(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  c hon.school_pay_connections%ROWTYPE; old hon.school_pay_connections%ROWTYPE; prior jsonb; result jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion'],ARRAY['expectedVersion']) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.connection.default','connectionId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_command_begin(subject,key,fp);
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  PERFORM 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org FOR NO KEY UPDATE;
  c:=hon.school_pay_lock_connection(selected,(p->>'expectedVersion')::integer);
  IF c.state<>'CONNECTED_ACTIVE' THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_STATE' USING ERRCODE='40001'; END IF;
  IF c.is_default THEN RAISE EXCEPTION 'SCHOOL_PAY_ALREADY_DEFAULT' USING ERRCODE='40001'; END IF;
  FOR old IN SELECT * FROM hon.school_pay_connections x WHERE x.organization_id=org AND x.school_id=school AND x.is_default AND x.id<>c.id FOR UPDATE LOOP
    prior:=hon.school_pay_connection_json(old);
    UPDATE hon.school_pay_connections SET version=version+1,is_default=false WHERE id=old.id RETURNING * INTO old;
    INSERT INTO hon.school_pay_connection_events(organization_id,school_id,connection_id,connection_version,kind,state,snapshot,actor_principal_id)
      VALUES(org,school,old.id,old.version,'DEFAULT_CLEARED',old.state,hon.school_pay_connection_json(old),actor);
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(org,school,actor,'HUMAN_UI','school_pay.connection.default_cleared','SCHOOL_PAY_CONNECTION',old.id,prior,hon.school_pay_connection_json(old),'SUCCEEDED',request,correlation);
  END LOOP;
  prior:=hon.school_pay_connection_json(c);
  UPDATE hon.school_pay_connections SET version=version+1,is_default=true WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('receipt',hon.school_pay_command_finish(subject,key,actor,c,'DEFAULT_SET','school_pay.connection.default',prior,request,correlation),'replayed',false);
END $$;

-- Disconnect: any open connection ends with a reason. A connection that never got an account is ABANDONED. Provider
-- objects stay on the school's own account; HON keeps every record.
CREATE FUNCTION hon.disconnect_school_payment_connection(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; c hon.school_pay_connections%ROWTYPE; prior jsonb; ending text;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','reason'],ARRAY['expectedVersion','reason'])
    OR NOT hon.membership_pause_text_ok(p->'reason',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.connection.disconnect','connectionId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_command_begin(subject,key,fp);
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  c:=hon.school_pay_lock_connection(selected,(p->>'expectedVersion')::integer);
  IF c.ended_at IS NOT NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_STATE' USING ERRCODE='40001'; END IF;
  ending:=CASE WHEN c.provider_account_ref IS NULL THEN 'ABANDONED' ELSE 'DISCONNECTED' END;
  prior:=hon.school_pay_connection_json(c);
  UPDATE hon.school_pay_connections SET version=version+1,state=ending,is_default=false,onboarding_state_hash=NULL,
      capabilities='{"oneTimeCard":false,"storedCard":false,"bankDebit":false,"offSessionRecurring":false,"refunds":false}'::jsonb,
      ended_at=clock_timestamp(),ended_by_principal_id=actor,end_reason=p->>'reason'
    WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('receipt',hon.school_pay_command_finish(subject,key,actor,c,ending,'school_pay.connection.disconnect',prior,request,correlation),'replayed',false);
END $$;

COMMENT ON TABLE hon.school_pay_providers IS
'0258 registry of school payment providers (C1). A HON-owned processor is added later as one row; live_allowed is always false until an owner-approved migration. Private.';
COMMENT ON TABLE hon.school_pay_connections IS
'0258 one row per school payment processor connection (C2-C4): TEST mode only, state derived from provider observations, one open per school and provider, one ACTIVE default. Holds no secret, token or card. Private.';
COMMENT ON TABLE hon.school_pay_connection_events IS
'0258 append-only history of every school payment connection command. Private.';
COMMENT ON FUNCTION hon.read_school_payment_processors(text) IS
'Direct HUMAN_UI read-only providers and current-school payment connections (school_pay.read or manage). No DML.';
COMMENT ON FUNCTION hon.start_school_payment_connection(text,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI start of one TEST-mode connection to a registered provider. No provider call, charge or message.';
COMMENT ON FUNCTION hon.set_school_payment_onboarding_link(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI storage of a fresh one-time onboarding state hash (and a provider-created account reference, set once).';
COMMENT ON FUNCTION hon.record_school_payment_status(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI finish (with the one-time onboarding state) or refresh of a connection from one provider observation; the state is derived here.';
COMMENT ON FUNCTION hon.set_default_school_payment_connection(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI choice of the school''s default ACTIVE payment connection.';
COMMENT ON FUNCTION hon.disconnect_school_payment_connection(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI disconnect of one open payment connection with a reason. Records are kept.';

DO $$ DECLARE r text; col text; t text; private_fns text:='hon.school_pay_capabilities_ok(jsonb),hon.guard_school_pay_connection(),hon.require_school_pay_actor(text,text),hon.require_school_pay_reader(text),
    hon.school_pay_connection_json(hon.school_pay_connections),hon.school_pay_observation_ok(jsonb),hon.school_pay_command_begin(text,text,text),
    hon.school_pay_command_finish(text,text,uuid,hon.school_pay_connections,text,text,jsonb,uuid,uuid),
    hon.school_pay_args_ok(text,uuid,jsonb,text,uuid,uuid,text[],text[]),hon.school_pay_lock_connection(uuid,integer),
    hon.school_pay_account_free(hon.school_pay_connections,text)';
  entry_fns text:='hon.read_school_payment_processors(text),hon.start_school_payment_connection(text,jsonb,text,uuid,uuid),
    hon.set_school_payment_onboarding_link(text,uuid,jsonb,text,uuid,uuid),hon.record_school_payment_status(text,uuid,jsonb,text,uuid,uuid),
    hon.set_default_school_payment_connection(text,uuid,jsonb,text,uuid,uuid),hon.disconnect_school_payment_connection(text,uuid,jsonb,text,uuid,uuid)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM PUBLIC',private_fns,entry_fns);
  FOREACH t IN ARRAY ARRAY['school_pay_providers','school_pay_connections','school_pay_connection_events'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
    END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM %I',private_fns,entry_fns,r);
    FOREACH t IN ARRAY ARRAY['school_pay_providers','school_pay_connections','school_pay_connection_events'] LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
      FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',entry_fns);
  END IF;
END $$;
DO $$ DECLARE t text; BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH t IN ARRAY ARRAY['hon.school_pay_providers','hon.school_pay_connections','hon.school_pay_connection_events'] LOOP
      IF has_table_privilege('hon_runtime',t,'SELECT') OR has_any_column_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
        OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
        RAISE EXCEPTION 'School payment connections must not widen runtime privileges';
      END IF;
    END LOOP;
  END IF;
END $$;
COMMIT;
