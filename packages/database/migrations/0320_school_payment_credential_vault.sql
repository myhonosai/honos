BEGIN;

-- B-TUI-2 piece 2 (0320, assigned by the coordinator 2026-11-13): the credential vault for school payment connections.
-- Owner decisions (David): each school is the merchant of record; Stripe Connect accounts with the full Stripe Dashboard
-- and Stripe-hosted onboarding; Square through the school's own seller account; TEST/SANDBOX mode only; no platform fee.
-- Spec: docs/architecture/TUITION_COLLECTION.md section 11.
--   V1  hon.school_pay_provider_credentials registers which providers keep per-school credentials (Square: OAuth tokens).
--       Stripe keeps none (the platform key and the account id are enough). A later provider is one row.
--   V2  hon.school_pay_credentials holds one sealed credential per connection. The API seals it (AES-256-GCM, bound to
--       the connection, provider and account); this database never sees a token in clear and never decrypts.
--   V3  A token provider's credential is stored only in the same transaction as the FINISH or REFRESH status record that
--       the database accepted (record_school_payment_status_with_credential). A connected token-provider connection always
--       has a live credential (deferred check at commit). Ending a connection destroys its sealed credential at once.
--   V4  The onboarding state can be checked read-only before Square's one-time code is exchanged.
-- Nothing here charges, refunds, stores a card, sends a message or runs an automation. The runtime gains no table
-- privilege: every entry point is a direct-human SECURITY DEFINER function with live school_pay.connection.manage checks.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School payment credential vault requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School payment credential vault requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.record_school_payment_status(text,uuid,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.require_school_pay_actor(text,text)') IS NULL OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'School payment credential vault requires 0258';
  END IF;
END $$;

-- V1: providers that keep per-school credentials.
CREATE TABLE hon.school_pay_provider_credentials (
  provider_code text PRIMARY KEY REFERENCES hon.school_pay_providers(code) ON DELETE RESTRICT,
  credential_kind text NOT NULL CHECK (credential_kind IN ('OAUTH_TOKENS'))
);
INSERT INTO hon.school_pay_provider_credentials(provider_code,credential_kind) VALUES ('SQUARE','OAUTH_TOKENS');
ALTER TABLE hon.school_pay_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_provider_credentials FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_provider_credentials_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_provider_credentials_no_truncate BEFORE TRUNCATE ON hon.school_pay_provider_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- V2: one sealed credential per connection.
CREATE TABLE hon.school_pay_credentials (
  connection_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  provider_code text NOT NULL REFERENCES hon.school_pay_provider_credentials(provider_code) ON DELETE RESTRICT,
  key_id text NOT NULL CHECK (key_id ~ '^[a-z0-9-]{1,40}$'),
  sealed text CHECK (sealed IS NULL OR (length(sealed)<=8100 AND sealed ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$')),
  access_expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  stored_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rotated_at timestamptz,
  destroyed_at timestamptz,
  CHECK ((sealed IS NULL)=(destroyed_at IS NOT NULL)),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.school_pay_connections(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_pay_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_credentials FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_credentials_no_truncate BEFORE TRUNCATE ON hon.school_pay_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
COMMENT ON TABLE hon.school_pay_provider_credentials IS
'0320 which school payment providers keep per-school credentials (V1). Private.';
COMMENT ON TABLE hon.school_pay_credentials IS
'0320 one API-sealed (AES-256-GCM) provider credential per school payment connection (V2). Never plaintext; destroyed when the connection ends. Private.';

-- Settings-free credential guard, whoever writes: no delete; scope, provider and first-store facts never change; every
-- update bumps the version by exactly one; a destroyed credential never changes again.
CREATE FUNCTION hon.guard_school_pay_credential() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_PAY_CREDENTIAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.sealed IS NULL OR NEW.rotated_at IS NOT NULL OR NEW.destroyed_at IS NOT NULL THEN
      RAISE EXCEPTION 'SCHOOL_PAY_CREDENTIAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.destroyed_at IS NOT NULL OR NEW.version<>OLD.version+1
    OR (NEW.connection_id,NEW.organization_id,NEW.school_id,NEW.provider_code,NEW.stored_by_principal_id,NEW.stored_at)
      IS DISTINCT FROM (OLD.connection_id,OLD.organization_id,OLD.school_id,OLD.provider_code,OLD.stored_by_principal_id,OLD.stored_at) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CREDENTIAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_pay_credential_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_pay_credentials
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_pay_credential();

-- V3: ending a connection destroys its sealed credential in the same statement.
CREATE FUNCTION hon.destroy_school_pay_credential_on_end() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.state IN ('DISCONNECTED','ABANDONED') THEN
    UPDATE hon.school_pay_credentials SET version=version+1,sealed=NULL,destroyed_at=clock_timestamp()
      WHERE connection_id=NEW.id AND destroyed_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER school_pay_connection_credential_destroy AFTER UPDATE ON hon.school_pay_connections
  FOR EACH ROW EXECUTE FUNCTION hon.destroy_school_pay_credential_on_end();

-- V3: at commit, a connected connection of a token provider has a live credential, and an ended one has none.
CREATE FUNCTION hon.check_school_pay_connection_credential() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.school_pay_connections%ROWTYPE;
BEGIN
  SELECT * INTO c FROM hon.school_pay_connections WHERE id=NEW.id;
  IF EXISTS(SELECT 1 FROM hon.school_pay_provider_credentials r WHERE r.provider_code=c.provider_code)
    AND c.state IN ('CONNECTED_RESTRICTED','CONNECTED_ACTIVE','REAUTHORIZATION_REQUIRED')
    AND NOT EXISTS(SELECT 1 FROM hon.school_pay_credentials k WHERE k.connection_id=c.id AND k.destroyed_at IS NULL) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CREDENTIAL_REQUIRED' USING ERRCODE='23514'; END IF;
  IF c.state IN ('DISCONNECTED','ABANDONED') AND EXISTS(SELECT 1 FROM hon.school_pay_credentials k WHERE k.connection_id=c.id AND k.destroyed_at IS NULL) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CREDENTIAL_NOT_DESTROYED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER school_pay_connection_credential_check AFTER INSERT OR UPDATE ON hon.school_pay_connections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.check_school_pay_connection_credential();

-- Closed sealed-credential input: {keyId, sealed, accessExpiresAt (UTC ms), expectedCredentialVersion (0 = first store)}.
CREATE FUNCTION hon.school_pay_credential_input_ok(k jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(k)='object'
    AND (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(k) x)=ARRAY['accessExpiresAt','expectedCredentialVersion','keyId','sealed']
    AND jsonb_typeof(k->'keyId')='string' AND k->>'keyId' ~ '^[a-z0-9-]{1,40}$'
    AND jsonb_typeof(k->'sealed')='string' AND length(k->>'sealed')<=8100 AND k->>'sealed' ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    AND jsonb_typeof(k->'accessExpiresAt')='string' AND k->>'accessExpiresAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    AND jsonb_typeof(k->'expectedCredentialVersion')='number' AND (k->'expectedCredentialVersion')::text ~ '^(0|[1-9][0-9]{0,8})$',false)
$$;

-- V4: read-only check of the one-time onboarding state (before a one-time provider code is spent).
CREATE FUNCTION hon.check_school_payment_onboarding_state(subject text,selected uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.school_pay_connections%ROWTYPE;
BEGIN
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p) x) IS DISTINCT FROM ARRAY['expectedVersion','onboardingState']
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'onboardingState') IS DISTINCT FROM 'string' OR p->>'onboardingState' !~ '^[A-Za-z0-9_-]{32,128}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  SELECT * INTO c FROM hon.school_pay_connections x WHERE x.id=selected AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF c.state<>'PENDING_ONBOARDING' OR c.onboarding_state_hash IS NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_STATE' USING ERRCODE='40001'; END IF;
  IF encode(sha256(convert_to(p->>'onboardingState','UTF8')),'hex')<>c.onboarding_state_hash THEN
    RAISE EXCEPTION 'SCHOOL_PAY_ONBOARDING_STATE_MISMATCH' USING ERRCODE='42501'; END IF;
  IF hon.require_school_pay_actor(subject,'school_pay.connection.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('connectionId',c.id,'version',c.version,'matches',true);
END $$;

-- V3: FINISH or REFRESH with a sealed credential, in one transaction. The 0258 status command runs unchanged (its
-- fingerprint and idempotency never include the sealed value); an exact replay stores nothing.
CREATE FUNCTION hon.record_school_payment_status_with_credential(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; inner_result jsonb; k jsonb;
  c hon.school_pay_connections%ROWTYPE; prior hon.school_pay_credentials%ROWTYPE; expected integer; next hon.school_pay_credentials%ROWTYPE;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.school_pay_credential_input_ok(p->'credential') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  k:=p->'credential'; expected:=(k->>'expectedCredentialVersion')::integer;
  IF (p->>'kind'='FINISH')<>(expected=0) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  inner_result:=hon.record_school_payment_status(subject,selected,p-'credential',key,request,correlation);
  IF (inner_result->>'replayed')::boolean THEN RETURN inner_result; END IF;
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  SELECT * INTO c FROM hon.school_pay_connections x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND OR c.state NOT IN ('CONNECTED_RESTRICTED','CONNECTED_ACTIVE','REAUTHORIZATION_REQUIRED')
    OR NOT EXISTS(SELECT 1 FROM hon.school_pay_provider_credentials r WHERE r.provider_code=c.provider_code) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_STATE' USING ERRCODE='40001'; END IF;
  SELECT * INTO prior FROM hon.school_pay_credentials x WHERE x.connection_id=c.id FOR UPDATE;
  IF expected=0 THEN
    IF FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CREDENTIAL_CONFLICT' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.school_pay_credentials(connection_id,organization_id,school_id,provider_code,key_id,sealed,access_expires_at,stored_by_principal_id)
      VALUES(c.id,org,school,c.provider_code,k->>'keyId',k->>'sealed',(k->>'accessExpiresAt')::timestamptz,actor) RETURNING * INTO next;
  ELSE
    IF NOT FOUND OR prior.destroyed_at IS NOT NULL OR prior.version<>expected THEN RAISE EXCEPTION 'SCHOOL_PAY_CREDENTIAL_CONFLICT' USING ERRCODE='40001'; END IF;
    UPDATE hon.school_pay_credentials SET version=version+1,key_id=k->>'keyId',sealed=k->>'sealed',access_expires_at=(k->>'accessExpiresAt')::timestamptz,
        rotated_at=clock_timestamp()
      WHERE connection_id=c.id RETURNING * INTO next;
  END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',CASE WHEN expected=0 THEN 'school_pay.credential.store' ELSE 'school_pay.credential.rotate' END,'SCHOOL_PAY_CREDENTIAL',c.id,
      CASE WHEN expected=0 THEN NULL ELSE jsonb_build_object('credentialVersion',prior.version,'keyId',prior.key_id) END,
      jsonb_build_object('credentialVersion',next.version,'keyId',next.key_id,'accessExpiresAt',to_char(next.access_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'SUCCEEDED',request,correlation);
  IF hon.require_school_pay_actor(subject,'school_pay.connection.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN inner_result;
END $$;

-- The sealed credential of one connected current-school connection, for the API to open in memory.
CREATE FUNCTION hon.read_school_payment_credential(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.school_pay_connections%ROWTYPE; k hon.school_pay_credentials%ROWTYPE; result jsonb;
BEGIN
  IF selected IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  SELECT * INTO c FROM hon.school_pay_connections x WHERE x.id=selected AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id()
    AND x.state IN ('CONNECTED_RESTRICTED','CONNECTED_ACTIVE','REAUTHORIZATION_REQUIRED');
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO k FROM hon.school_pay_credentials x WHERE x.connection_id=c.id AND x.destroyed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CREDENTIAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('connectionId',c.id,'providerCode',c.provider_code,'accountRef',c.provider_account_ref,'connectionVersion',c.version,
    'keyId',k.key_id,'sealed',k.sealed,'credentialVersion',k.version,
    'accessExpiresAt',to_char(k.access_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF hon.require_school_pay_actor(subject,'school_pay.connection.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Whether a current-school connection's provider account is still open on any other connection (any school or
-- organization). A provider revoke works per account, so HON never revokes an account another connection still uses.
CREATE FUNCTION hon.read_school_payment_account_use(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; c hon.school_pay_connections%ROWTYPE; result jsonb;
BEGIN
  IF selected IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_pay_actor(subject,'school_pay.connection.manage');
  SELECT * INTO c FROM hon.school_pay_connections x WHERE x.id=selected AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('connectionId',c.id,'openElsewhere',c.provider_account_ref IS NOT NULL AND EXISTS(SELECT 1 FROM hon.school_pay_connections x
    WHERE x.id<>c.id AND x.provider_code=c.provider_code AND x.mode=c.mode AND x.provider_account_ref=c.provider_account_ref AND x.ended_at IS NULL));
  IF hon.require_school_pay_actor(subject,'school_pay.connection.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON FUNCTION hon.check_school_payment_onboarding_state(text,uuid,jsonb) IS
'Direct HUMAN_UI read-only check of a pending connection''s one-time onboarding state (before a provider code is exchanged). No DML.';
COMMENT ON FUNCTION hon.record_school_payment_status_with_credential(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI finish or refresh (0258 command) that also stores or rotates the API-sealed provider credential in the same transaction.';
COMMENT ON FUNCTION hon.read_school_payment_credential(text,uuid) IS
'Direct HUMAN_UI read of one connected connection''s sealed credential (school_pay.connection.manage). No DML.';
COMMENT ON FUNCTION hon.read_school_payment_account_use(text,uuid) IS
'Direct HUMAN_UI read of whether the connection''s provider account is still open elsewhere (before a provider revoke). No DML.';

DO $$ DECLARE r text; col text; t text; private_fns text:='hon.guard_school_pay_credential(),hon.destroy_school_pay_credential_on_end(),
    hon.check_school_pay_connection_credential(),hon.school_pay_credential_input_ok(jsonb)';
  entry_fns text:='hon.check_school_payment_onboarding_state(text,uuid,jsonb),hon.record_school_payment_status_with_credential(text,uuid,jsonb,text,uuid,uuid),
    hon.read_school_payment_credential(text,uuid),hon.read_school_payment_account_use(text,uuid)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM PUBLIC',private_fns,entry_fns);
  FOREACH t IN ARRAY ARRAY['school_pay_provider_credentials','school_pay_credentials'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
    END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM %I',private_fns,entry_fns,r);
    FOREACH t IN ARRAY ARRAY['school_pay_provider_credentials','school_pay_credentials'] LOOP
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
    FOREACH t IN ARRAY ARRAY['hon.school_pay_provider_credentials','hon.school_pay_credentials'] LOOP
      IF has_table_privilege('hon_runtime',t,'SELECT') OR has_any_column_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
        OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
        RAISE EXCEPTION 'School payment credential vault must not widen runtime privileges';
      END IF;
    END LOOP;
  END IF;
END $$;
COMMIT;
