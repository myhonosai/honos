BEGIN;

-- B-TUI-2 piece 3 (0321; reserved as 0265 on 2026-11-11, renumbered to 0290 on 2026-11-12 and to 0321 on 2026-11-13 by the coordinator): payers and their saved payment methods with the school's
-- own payment processor (TEST mode only). Spec: docs/architecture/TUITION_COLLECTION.md section 11.
--   M1  The payer is an existing hon.billing_accounts row. A payer gets one provider customer per school connection; the
--       customer reference is set once and never changes.
--   M2  A card or US bank account is saved only through the provider's own hosted/tokenized setup (Stripe SetupIntent,
--       Square card on file). HON stores the provider's method reference, brand, last four digits and card expiry only:
--       never a card number, security code, bank number or token secret. The consent text version and the staff member
--       who recorded the payer's consent are kept with the method.
--   M3  A setup carries a one-time state (only its SHA-256 is stored) and expires after one hour; a newer setup for the
--       same payer and connection supersedes an older pending one. The saved method is derived from the provider
--       observation the API retrieved, never from the browser return.
--   M4  Only a CONNECTED_ACTIVE connection whose capabilities allow stored cards takes a new method, and a bank account
--       needs the bank-debit capability. One default method per payer; a removed method never comes back.
--   M5  New sensitive staff-assignable permission school_pay.method.manage (system OWNER roles first); the reads also accept
--       school_pay.read. HQ, family and parent-type principals are refused.
-- Nothing here charges, refunds, sends a message or runs an automation, and HON takes no fee. The runtime gains no table
-- privilege: every write is a direct-human SECURITY DEFINER command with live school-scoped permission re-checks,
-- exact-request idempotency, an append-only history row, audit and an inert outbox event.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School payer saved methods require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School payer saved methods require a restricted runtime';
  END IF;
  IF to_regclass('hon.school_pay_connections') IS NULL OR to_regprocedure('hon.school_pay_args_ok(text,uuid,jsonb,text,uuid,uuid,text[],text[])') IS NULL
    OR to_regprocedure('hon.membership_pause_text_ok(jsonb,boolean)') IS NULL OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'School payer saved methods require 0177, 0224 and 0258';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('school_pay.method.manage','Save, choose the default for, or remove a payer''s card or bank account with the school''s own payment processor (test mode only)',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='school_pay.method.manage' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'school_pay.method.manage already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'school_pay.method.manage' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- M1: one provider customer per payer and connection, set once.
CREATE TABLE hon.school_pay_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  provider_customer_ref text NOT NULL CHECK (provider_customer_ref ~ '^[A-Za-z0-9_:-]{3,100}$'),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connection_id,billing_account_id),
  UNIQUE (connection_id,provider_customer_ref),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.school_pay_connections(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_pay_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_customers FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_customers_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_customers
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_customers_no_truncate BEFORE TRUNCATE ON hon.school_pay_customers
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- M3: hosted setup sessions.
CREATE TABLE hon.school_pay_method_setups (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','COMPLETED','SUPERSEDED')),
  setup_state_hash text CHECK (setup_state_hash IS NULL OR setup_state_hash ~ '^[0-9a-f]{64}$'),
  provider_setup_ref text NOT NULL CHECK (provider_setup_ref ~ '^[A-Za-z0-9_:-]{3,100}$'),
  method_kinds text[] NOT NULL CHECK (cardinality(method_kinds) BETWEEN 1 AND 2 AND method_kinds <@ ARRAY['CARD','US_BANK_ACCOUNT']::text[]),
  consent_text_version text NOT NULL CHECK (consent_text_version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  expires_at timestamptz NOT NULL,
  method_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  ended_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  CHECK ((state='PENDING')=(ended_at IS NULL) AND (ended_at IS NULL)=(ended_by_principal_id IS NULL)),
  CHECK ((state='PENDING')=(setup_state_hash IS NOT NULL)),
  CHECK ((state='COMPLETED')=(method_id IS NOT NULL)),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '1 hour'),
  UNIQUE (connection_id,provider_setup_ref),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (customer_id,organization_id,school_id) REFERENCES hon.school_pay_customers(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.school_pay_connections(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX school_pay_method_setups_one_pending_idx ON hon.school_pay_method_setups(connection_id,billing_account_id) WHERE state='PENDING';
ALTER TABLE hon.school_pay_method_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_method_setups FORCE ROW LEVEL SECURITY;

-- M2/M4: saved methods.
CREATE TABLE hon.school_pay_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  setup_id uuid NOT NULL UNIQUE,
  provider_method_ref text NOT NULL CHECK (provider_method_ref ~ '^[A-Za-z0-9_:-]{3,100}$'),
  kind text NOT NULL CHECK (kind IN ('CARD','US_BANK_ACCOUNT')),
  brand text NOT NULL CHECK (brand IN ('VISA','MASTERCARD','AMEX','DISCOVER','JCB','DINERS','UNIONPAY','OTHER','BANK')),
  last4 text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  exp_month integer CHECK (exp_month BETWEEN 1 AND 12),
  exp_year integer CHECK (exp_year BETWEEN 2000 AND 2100),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REMOVED')),
  is_default boolean NOT NULL DEFAULT false,
  consent_text_version text NOT NULL CHECK (consent_text_version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz,
  removed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  remove_reason text CHECK (remove_reason IS NULL OR (length(remove_reason) BETWEEN 1 AND 1000 AND btrim(remove_reason)=remove_reason AND remove_reason !~ '[\x01-\x1f\x7f]')),
  CHECK ((kind='CARD')=(exp_month IS NOT NULL) AND (exp_month IS NULL)=(exp_year IS NULL)),
  CHECK ((kind='US_BANK_ACCOUNT')=(brand='BANK')),
  CHECK (NOT is_default OR status='ACTIVE'),
  CHECK ((status='REMOVED')=(removed_at IS NOT NULL) AND (removed_at IS NULL)=(removed_by_principal_id IS NULL) AND (removed_at IS NULL)=(remove_reason IS NULL)),
  UNIQUE (connection_id,provider_method_ref),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (setup_id,organization_id,school_id) REFERENCES hon.school_pay_method_setups(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id,organization_id,school_id) REFERENCES hon.school_pay_customers(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.school_pay_connections(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX school_pay_methods_one_default_idx ON hon.school_pay_methods(billing_account_id) WHERE is_default;
CREATE INDEX school_pay_methods_payer_idx ON hon.school_pay_methods(organization_id,school_id,billing_account_id,created_at);
CREATE INDEX school_pay_methods_expiry_idx ON hon.school_pay_methods(organization_id,school_id,exp_year,exp_month) WHERE status='ACTIVE' AND kind='CARD';
ALTER TABLE hon.school_pay_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_methods FORCE ROW LEVEL SECURITY;

-- Append-only history of every setup and method command.
CREATE TABLE hon.school_pay_method_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('SETUP','METHOD')),
  entity_id uuid NOT NULL,
  entity_version integer NOT NULL CHECK (entity_version>=1),
  kind text NOT NULL CHECK (kind IN ('SETUP_STARTED','SETUP_SUPERSEDED','SETUP_COMPLETED','METHOD_SAVED','DEFAULT_SET','DEFAULT_CLEARED','METHOD_REMOVED')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (entity_id,entity_version,kind),
  FOREIGN KEY (billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_pay_method_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_method_events FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_method_events_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_method_events
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_method_events_no_truncate BEFORE TRUNCATE ON hon.school_pay_method_events
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_method_setups_no_truncate BEFORE TRUNCATE ON hon.school_pay_method_setups
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_methods_no_truncate BEFORE TRUNCATE ON hon.school_pay_methods
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Settings-free guards, whoever writes: no delete; scope, payer, customer, connection, provider references, consent and
-- creation facts never change; a finished setup or a removed method never changes again; every update bumps the version.
CREATE FUNCTION hon.guard_school_pay_method_setup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_PAY_METHOD_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PENDING' OR NEW.version<>1 OR NEW.method_id IS NOT NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_METHOD_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state<>'PENDING' OR NEW.version<>OLD.version+1
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.connection_id,NEW.billing_account_id,NEW.customer_id,NEW.provider_setup_ref,NEW.method_kinds,
        NEW.consent_text_version,NEW.expires_at,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.connection_id,OLD.billing_account_id,OLD.customer_id,OLD.provider_setup_ref,OLD.method_kinds,
        OLD.consent_text_version,OLD.expires_at,OLD.created_by_principal_id,OLD.created_at) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_METHOD_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_pay_method_setup_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_pay_method_setups
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_pay_method_setup();

CREATE FUNCTION hon.guard_school_pay_method() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_PAY_METHOD_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'ACTIVE' OR NEW.version<>1 THEN RAISE EXCEPTION 'SCHOOL_PAY_METHOD_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status<>'ACTIVE' OR NEW.version<>OLD.version+1
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.connection_id,NEW.billing_account_id,NEW.customer_id,NEW.setup_id,NEW.provider_method_ref,
        NEW.kind,NEW.brand,NEW.last4,NEW.exp_month,NEW.exp_year,NEW.consent_text_version,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.connection_id,OLD.billing_account_id,OLD.customer_id,OLD.setup_id,OLD.provider_method_ref,
        OLD.kind,OLD.brand,OLD.last4,OLD.exp_month,OLD.exp_year,OLD.consent_text_version,OLD.created_by_principal_id,OLD.created_at) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_METHOD_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_pay_method_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_pay_methods
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_pay_method();

-- Live direct-human authority at the current school for one of the two method permissions, or a refusal (0258 identity rules).
CREATE FUNCTION hon.require_school_pay_method_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  denial text:=CASE WHEN permission='school_pay.method.manage' THEN 'SCHOOL_PAY_METHOD_FORBIDDEN' ELSE 'SCHOOL_PAY_READ_FORBIDDEN' END;
BEGIN
  IF permission IS NULL OR permission NOT IN ('school_pay.method.manage','school_pay.read')
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

-- The first method reader permission the subject holds live, or a refusal.
CREATE FUNCTION hon.require_school_pay_method_reader(subject text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE permission text;
BEGIN
  FOREACH permission IN ARRAY ARRAY['school_pay.method.manage','school_pay.read'] LOOP
    BEGIN PERFORM hon.require_school_pay_method_actor(subject,permission); RETURN permission;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  RAISE EXCEPTION 'SCHOOL_PAY_READ_FORBIDDEN' USING ERRCODE='42501';
END $$;

CREATE FUNCTION hon.school_pay_instant(t timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN t IS NULL THEN NULL ELSE to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;

CREATE FUNCTION hon.school_pay_method_json(m hon.school_pay_methods) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('methodId',m.id,'billingAccountId',m.billing_account_id,'connectionId',m.connection_id,'kind',m.kind,'brand',m.brand,
    'last4',m.last4,'expMonth',m.exp_month,'expYear',m.exp_year,'status',m.status,'isDefault',m.is_default,
    'consentTextVersion',m.consent_text_version,'version',m.version,'createdAt',hon.school_pay_instant(m.created_at),
    'removedAt',hon.school_pay_instant(m.removed_at),'removeReason',m.remove_reason)
$$;

CREATE FUNCTION hon.school_pay_setup_json(s hon.school_pay_method_setups) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('setupId',s.id,'billingAccountId',s.billing_account_id,'connectionId',s.connection_id,'state',s.state,
    'setupRef',s.provider_setup_ref,'methodKinds',to_jsonb(s.method_kinds),'consentTextVersion',s.consent_text_version,'expiresAt',hon.school_pay_instant(s.expires_at),
    'methodId',s.method_id,'version',s.version,'createdAt',hon.school_pay_instant(s.created_at))
$$;

-- Closed provider observation of one completed setup (M3): {customerRef, methodRef, kind, brand, last4, expMonth, expYear}.
CREATE FUNCTION hon.school_pay_method_observation_ok(o jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(o)='object'
    AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(o) k)=ARRAY['brand','customerRef','expMonth','expYear','kind','last4','methodRef']
    AND jsonb_typeof(o->'customerRef')='string' AND o->>'customerRef' ~ '^[A-Za-z0-9_:-]{3,100}$'
    AND jsonb_typeof(o->'methodRef')='string' AND o->>'methodRef' ~ '^[A-Za-z0-9_:-]{3,100}$'
    AND jsonb_typeof(o->'last4')='string' AND o->>'last4' ~ '^[0-9]{4}$'
    AND ((o->>'kind'='CARD' AND jsonb_typeof(o->'brand')='string' AND o->>'brand' IN ('VISA','MASTERCARD','AMEX','DISCOVER','JCB','DINERS','UNIONPAY','OTHER')
          AND jsonb_typeof(o->'expMonth')='number' AND (o->'expMonth')::text ~ '^([1-9]|1[0-2])$'
          AND jsonb_typeof(o->'expYear')='number' AND (o->'expYear')::text ~ '^20[0-9]{2}$')
      OR (o->>'kind'='US_BANK_ACCOUNT' AND o->>'brand'='BANK' AND jsonb_typeof(o->'expMonth')='null' AND jsonb_typeof(o->'expYear')='null')),false)
$$;

-- Shared idempotency for the method commands: reserve the key, take the IAM SHARE locks, re-check live authority, and return
-- the stored response on an exact replay (after one more authority check). NULL means: proceed with the write.
CREATE FUNCTION hon.school_pay_method_begin(subject text,key text,fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  actor:=hon.require_school_pay_method_actor(subject,'school_pay.method.manage');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_pay_method_actor(subject,'school_pay.method.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_METHOD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF hon.require_school_pay_method_actor(subject,'school_pay.method.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_METHOD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN prior.response_body;
END $$;

-- One history row with its audit row and inert outbox event.
CREATE FUNCTION hon.school_pay_method_record(actor uuid,payer uuid,entity_type text,entity_id uuid,entity_version integer,kind text,action text,
  prior_state jsonb,next_state jsonb,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  INSERT INTO hon.school_pay_method_events(organization_id,school_id,billing_account_id,entity_type,entity_id,entity_version,kind,snapshot,actor_principal_id)
    VALUES(org,school,payer,entity_type,entity_id,entity_version,kind,next_state,actor);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,'SCHOOL_PAY_'||entity_type,entity_id,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'school_pay.method.'||lower(kind),1,'SCHOOL_PAY_'||entity_type,entity_id,entity_version,correlation,request,next_state);
END $$;

-- Idempotency completion and a final authority check.
CREATE FUNCTION hon.school_pay_method_complete(subject text,key text,actor uuid,result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_pay_method_actor(subject,'school_pay.method.manage') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_PAY_METHOD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- One current-school payer, locked against concurrent changes for this command.
CREATE FUNCTION hon.school_pay_lock_payer(selected uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM 1 FROM hon.billing_accounts b WHERE b.id=selected AND b.organization_id=hon.current_organization_id() AND b.school_id=hon.current_school_id() FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_PAYER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
END $$;

-- Lock and load one current-school method, checking the expected version.
CREATE FUNCTION hon.school_pay_lock_method(selected uuid,expected integer) RETURNS hon.school_pay_methods
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE m hon.school_pay_methods%ROWTYPE; payer uuid;
BEGIN
  SELECT x.billing_account_id INTO payer FROM hon.school_pay_methods x WHERE x.id=selected AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_METHOD_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.school_pay_lock_payer(payer);
  SELECT * INTO m FROM hon.school_pay_methods x WHERE x.id=selected FOR UPDATE;
  IF m.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN m;
END $$;

-- Read one payer: the connections that can take a saved method (with this payer's customer reference, which only the API
-- needs), the payer's methods (active, then the 20 most recent removed), unexpired pending setups and setups completed in
-- the last hour.
CREATE FUNCTION hon.read_school_pay_payer_methods(subject text,payer uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; result jsonb;
BEGIN
  IF payer IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  used:=hon.require_school_pay_method_reader(subject); actor:=hon.require_school_pay_method_actor(subject,used);
  IF NOT EXISTS(SELECT 1 FROM hon.billing_accounts b WHERE b.id=payer AND b.organization_id=org AND b.school_id=school) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_PAYER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('billingAccountId',payer,'canManage',used='school_pay.method.manage','platformFee','NONE',
    'payerName',(SELECT left(btrim(pp.given_name||' '||pp.family_name),200) FROM hon.billing_accounts b JOIN hon.people pp ON pp.id=b.responsible_person_id WHERE b.id=payer),
    'connections',coalesce((SELECT jsonb_agg(jsonb_build_object('connectionId',c.id,'providerCode',c.provider_code,'displayName',v.display_name,'accountRef',c.provider_account_ref,
        'isDefault',c.is_default,'storedCard',(c.capabilities->>'storedCard')::boolean,'bankDebit',(c.capabilities->>'bankDebit')::boolean,
        'customerRef',(SELECT k.provider_customer_ref FROM hon.school_pay_customers k WHERE k.connection_id=c.id AND k.billing_account_id=payer)) ORDER BY c.is_default DESC,v.sort_order)
      FROM hon.school_pay_connections c JOIN hon.school_pay_providers v ON v.code=c.provider_code
      WHERE c.organization_id=org AND c.school_id=school AND c.state='CONNECTED_ACTIVE' AND (c.capabilities->>'storedCard')::boolean),'[]'::jsonb),
    'methods',coalesce((SELECT jsonb_agg(hon.school_pay_method_json(m) ORDER BY m.status='REMOVED',m.is_default DESC,m.created_at DESC,m.id) FROM (
      SELECT * FROM hon.school_pay_methods x WHERE x.organization_id=org AND x.school_id=school AND x.billing_account_id=payer AND x.status='ACTIVE'
      UNION ALL
      (SELECT * FROM hon.school_pay_methods x WHERE x.organization_id=org AND x.school_id=school AND x.billing_account_id=payer AND x.status='REMOVED' ORDER BY x.removed_at DESC,x.id LIMIT 20)) m),'[]'::jsonb),
    -- Recently completed setups stay listed for an hour so a retried finish finds its setup and replays the stored receipt.
    'setups',coalesce((SELECT jsonb_agg(hon.school_pay_setup_json(s) ORDER BY s.created_at DESC,s.id) FROM (
      SELECT * FROM hon.school_pay_method_setups x WHERE x.organization_id=org AND x.school_id=school AND x.billing_account_id=payer
        AND ((x.state='PENDING' AND x.expires_at>clock_timestamp()) OR (x.state='COMPLETED' AND x.ended_at>clock_timestamp()-interval '1 hour'))
      ORDER BY x.created_at DESC,x.id LIMIT 20) s),'[]'::jsonb));
  IF hon.require_school_pay_method_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- The card-expiry list: active saved cards that expired or expire this month or next, by the school's own calendar month.
CREATE FUNCTION hon.read_school_pay_expiring_methods(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; result jsonb; today date; month_index integer;
BEGIN
  used:=hon.require_school_pay_method_reader(subject); actor:=hon.require_school_pay_method_actor(subject,used);
  SELECT (clock_timestamp() AT TIME ZONE s.timezone)::date INTO today FROM hon.schools s JOIN pg_timezone_names tz ON tz.name=s.timezone WHERE s.id=school AND s.organization_id=org;
  IF today IS NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_SCHOOL_TIME_ZONE_INVALID' USING ERRCODE='22023'; END IF;
  month_index:=extract(year FROM today)::integer*12+extract(month FROM today)::integer;
  result:=jsonb_build_object('asOfMonth',to_char(today,'YYYY-MM'),
    'methods',coalesce((SELECT jsonb_agg(jsonb_build_object('methodId',e.id,'billingAccountId',e.billing_account_id,'payerName',e.payer_name,
        'connectionId',e.connection_id,'brand',e.brand,'last4',e.last4,'expMonth',e.exp_month,'expYear',e.exp_year,'isDefault',e.is_default,
        'expired',e.exp_year*12+e.exp_month<month_index) ORDER BY e.exp_year,e.exp_month,e.payer_name,e.id) FROM (
      SELECT m.*,left(btrim(pp.given_name||' '||pp.family_name),200) AS payer_name FROM hon.school_pay_methods m
        JOIN hon.billing_accounts b ON b.id=m.billing_account_id JOIN hon.people pp ON pp.id=b.responsible_person_id
      WHERE m.organization_id=org AND m.school_id=school AND m.status='ACTIVE' AND m.kind='CARD' AND m.exp_year*12+m.exp_month<=month_index+1
      ORDER BY m.exp_year,m.exp_month,m.id LIMIT 500) e),'[]'::jsonb));
  IF hon.require_school_pay_method_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Start a hosted setup (M3): {billingAccountId, connectionId, consentTextVersion, customerRef, methodKinds, setupId,
-- setupRef, setupStateHash}. The customer reference is recorded the first time and must match afterwards.
CREATE FUNCTION hon.start_school_pay_method_setup(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; payer uuid; conn uuid;
  c hon.school_pay_connections%ROWTYPE; k hon.school_pay_customers%ROWTYPE; s hon.school_pay_method_setups%ROWTYPE; old hon.school_pay_method_setups%ROWTYPE;
  prior jsonb; kinds text[]; result jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,NULL,p,key,request,correlation,
      ARRAY['billingAccountId','connectionId','consentTextVersion','customerRef','methodKinds','setupId','setupRef','setupStateHash'],
      ARRAY['billingAccountId','connectionId','consentTextVersion','customerRef','methodKinds','setupId','setupRef','setupStateHash'])
    OR jsonb_typeof(p->'billingAccountId') IS DISTINCT FROM 'string' OR p->>'billingAccountId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'connectionId') IS DISTINCT FROM 'string' OR p->>'connectionId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'setupId') IS DISTINCT FROM 'string' OR p->>'setupId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'consentTextVersion') IS DISTINCT FROM 'string' OR p->>'consentTextVersion' !~ '^[a-z0-9][a-z0-9._-]{0,39}$'
    OR jsonb_typeof(p->'customerRef') IS DISTINCT FROM 'string' OR p->>'customerRef' !~ '^[A-Za-z0-9_:-]{3,100}$'
    OR jsonb_typeof(p->'setupRef') IS DISTINCT FROM 'string' OR p->>'setupRef' !~ '^[A-Za-z0-9_:-]{3,100}$'
    OR jsonb_typeof(p->'setupStateHash') IS DISTINCT FROM 'string' OR p->>'setupStateHash' !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p->'methodKinds') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'methodKinds') NOT BETWEEN 1 AND 2
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'methodKinds') x WHERE jsonb_typeof(x)<>'string' OR x#>>'{}' NOT IN ('CARD','US_BANK_ACCOUNT'))
    OR (SELECT count(DISTINCT x#>>'{}') FROM jsonb_array_elements(p->'methodKinds') x)<>jsonb_array_length(p->'methodKinds') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  payer:=(p->>'billingAccountId')::uuid; conn:=(p->>'connectionId')::uuid;
  SELECT array_agg(x ORDER BY x) INTO kinds FROM jsonb_array_elements_text(p->'methodKinds') x;
  -- Each attempt carries a fresh state, setup id and provider setup, so the fingerprint is the request intent only: a retry
  -- with the same key returns the first stored receipt.
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.method.setup','billingAccountId',payer,'connectionId',conn,
    'consentTextVersion',p->'consentTextVersion','methodKinds',to_jsonb(kinds))::text,'UTF8')),'hex');
  replay:=hon.school_pay_method_begin(subject,key,fp);
  actor:=hon.require_school_pay_method_actor(subject,'school_pay.method.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  PERFORM hon.school_pay_lock_payer(payer);
  SELECT * INTO c FROM hon.school_pay_connections x WHERE x.id=conn AND x.organization_id=org AND x.school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CONNECTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF c.state<>'CONNECTED_ACTIVE' OR NOT (c.capabilities->>'storedCard')::boolean
    OR ('US_BANK_ACCOUNT'=ANY(kinds) AND NOT (c.capabilities->>'bankDebit')::boolean) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_METHODS_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  SELECT * INTO k FROM hon.school_pay_customers x WHERE x.connection_id=conn AND x.billing_account_id=payer;
  IF FOUND AND k.provider_customer_ref<>p->>'customerRef' THEN RAISE EXCEPTION 'SCHOOL_PAY_CUSTOMER_MISMATCH' USING ERRCODE='22023'; END IF;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM hon.school_pay_customers x WHERE x.connection_id=conn AND x.provider_customer_ref=p->>'customerRef') THEN
      RAISE EXCEPTION 'SCHOOL_PAY_CUSTOMER_MISMATCH' USING ERRCODE='22023'; END IF;
    INSERT INTO hon.school_pay_customers(organization_id,school_id,connection_id,billing_account_id,provider_customer_ref,created_by_principal_id)
      VALUES(org,school,conn,payer,p->>'customerRef',actor) RETURNING * INTO k;
  END IF;
  IF EXISTS(SELECT 1 FROM hon.school_pay_method_setups x WHERE x.id=(p->>'setupId')::uuid)
    OR EXISTS(SELECT 1 FROM hon.school_pay_method_setups x WHERE x.connection_id=conn AND x.provider_setup_ref=p->>'setupRef') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR old IN SELECT * FROM hon.school_pay_method_setups x WHERE x.connection_id=conn AND x.billing_account_id=payer AND x.state='PENDING' FOR UPDATE LOOP
    prior:=hon.school_pay_setup_json(old);
    UPDATE hon.school_pay_method_setups SET version=version+1,state='SUPERSEDED',setup_state_hash=NULL,ended_at=clock_timestamp(),ended_by_principal_id=actor
      WHERE id=old.id RETURNING * INTO old;
    PERFORM hon.school_pay_method_record(actor,payer,'SETUP',old.id,old.version,'SETUP_SUPERSEDED','school_pay.method.setup_superseded',prior,hon.school_pay_setup_json(old),request,correlation);
  END LOOP;
  INSERT INTO hon.school_pay_method_setups(id,organization_id,school_id,connection_id,billing_account_id,customer_id,setup_state_hash,provider_setup_ref,
      method_kinds,consent_text_version,expires_at,created_by_principal_id,created_at)
    VALUES((p->>'setupId')::uuid,org,school,conn,payer,k.id,p->>'setupStateHash',p->>'setupRef',kinds,p->>'consentTextVersion',
      clock_timestamp()+interval '1 hour',actor,clock_timestamp()) RETURNING * INTO s;
  PERFORM hon.school_pay_method_record(actor,payer,'SETUP',s.id,s.version,'SETUP_STARTED','school_pay.method.setup',NULL,hon.school_pay_setup_json(s),request,correlation);
  result:=jsonb_build_object('setup',hon.school_pay_setup_json(s));
  RETURN hon.school_pay_method_complete(subject,key,actor,result);
END $$;

-- Finish a setup from one provider observation the API retrieved (M3/M4): {expectedVersion, setupState, observation}.
-- The first active method of a payer becomes the payer's default.
CREATE FUNCTION hon.finish_school_pay_method_setup(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; s hon.school_pay_method_setups%ROWTYPE; c hon.school_pay_connections%ROWTYPE; m hon.school_pay_methods%ROWTYPE;
  o jsonb; payer uuid; prior jsonb; result jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','observation','setupState'],ARRAY['expectedVersion','observation','setupState'])
    OR jsonb_typeof(p->'setupState') IS DISTINCT FROM 'string' OR p->>'setupState' !~ '^[A-Za-z0-9_-]{32,128}$'
    OR NOT hon.school_pay_method_observation_ok(p->'observation') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  o:=p->'observation';
  -- The raw setup state never reaches the stored fingerprint.
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.method.finish','setupId',selected,
    'input',(p-'setupState')||jsonb_build_object('setupStateHash',encode(sha256(convert_to(p->>'setupState','UTF8')),'hex')))::text,'UTF8')),'hex');
  replay:=hon.school_pay_method_begin(subject,key,fp);
  actor:=hon.require_school_pay_method_actor(subject,'school_pay.method.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT x.billing_account_id INTO payer FROM hon.school_pay_method_setups x WHERE x.id=selected AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_SETUP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.school_pay_lock_payer(payer);
  SELECT * INTO s FROM hon.school_pay_method_setups x WHERE x.id=selected FOR UPDATE;
  IF s.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF s.state<>'PENDING' THEN RAISE EXCEPTION 'SCHOOL_PAY_SETUP_STATE' USING ERRCODE='40001'; END IF;
  IF encode(sha256(convert_to(p->>'setupState','UTF8')),'hex')<>s.setup_state_hash THEN RAISE EXCEPTION 'SCHOOL_PAY_SETUP_STATE_MISMATCH' USING ERRCODE='42501'; END IF;
  IF s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'SCHOOL_PAY_SETUP_EXPIRED' USING ERRCODE='22023'; END IF;
  IF NOT (o->>'kind'=ANY(s.method_kinds)) THEN RAISE EXCEPTION 'SCHOOL_PAY_METHODS_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  IF (SELECT k.provider_customer_ref FROM hon.school_pay_customers k WHERE k.id=s.customer_id)<>o->>'customerRef' THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CUSTOMER_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM hon.school_pay_connections x WHERE x.id=s.connection_id FOR SHARE;
  IF c.state<>'CONNECTED_ACTIVE' OR NOT (c.capabilities->>'storedCard')::boolean
    OR (o->>'kind'='US_BANK_ACCOUNT' AND NOT (c.capabilities->>'bankDebit')::boolean) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_METHODS_UNAVAILABLE' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM hon.school_pay_methods x WHERE x.connection_id=s.connection_id AND x.provider_method_ref=o->>'methodRef') THEN
    RAISE EXCEPTION 'SCHOOL_PAY_METHOD_EXISTS' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.school_pay_methods(organization_id,school_id,connection_id,billing_account_id,customer_id,setup_id,provider_method_ref,kind,brand,last4,
      exp_month,exp_year,is_default,consent_text_version,created_by_principal_id)
    VALUES(s.organization_id,s.school_id,s.connection_id,s.billing_account_id,s.customer_id,s.id,o->>'methodRef',o->>'kind',o->>'brand',o->>'last4',
      (o->>'expMonth')::integer,(o->>'expYear')::integer,
      NOT EXISTS(SELECT 1 FROM hon.school_pay_methods x WHERE x.billing_account_id=s.billing_account_id AND x.is_default),s.consent_text_version,actor)
    RETURNING * INTO m;
  prior:=hon.school_pay_setup_json(s);
  UPDATE hon.school_pay_method_setups SET version=version+1,state='COMPLETED',setup_state_hash=NULL,method_id=m.id,ended_at=clock_timestamp(),ended_by_principal_id=actor
    WHERE id=s.id RETURNING * INTO s;
  PERFORM hon.school_pay_method_record(actor,payer,'SETUP',s.id,s.version,'SETUP_COMPLETED','school_pay.method.setup_completed',prior,hon.school_pay_setup_json(s),request,correlation);
  PERFORM hon.school_pay_method_record(actor,payer,'METHOD',m.id,m.version,'METHOD_SAVED','school_pay.method.save',NULL,hon.school_pay_method_json(m),request,correlation);
  result:=jsonb_build_object('method',hon.school_pay_method_json(m));
  RETURN hon.school_pay_method_complete(subject,key,actor,result);
END $$;

-- Default: one ACTIVE method becomes the payer's default; any earlier default of the payer is cleared first.
CREATE FUNCTION hon.set_default_school_pay_method(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; m hon.school_pay_methods%ROWTYPE; old hon.school_pay_methods%ROWTYPE; prior jsonb; result jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion'],ARRAY['expectedVersion']) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.method.default','methodId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_method_begin(subject,key,fp);
  actor:=hon.require_school_pay_method_actor(subject,'school_pay.method.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  m:=hon.school_pay_lock_method(selected,(p->>'expectedVersion')::integer);
  IF m.status<>'ACTIVE' THEN RAISE EXCEPTION 'SCHOOL_PAY_METHOD_STATE' USING ERRCODE='40001'; END IF;
  IF m.is_default THEN RAISE EXCEPTION 'SCHOOL_PAY_METHOD_ALREADY_DEFAULT' USING ERRCODE='40001'; END IF;
  FOR old IN SELECT * FROM hon.school_pay_methods x WHERE x.billing_account_id=m.billing_account_id AND x.is_default AND x.id<>m.id FOR UPDATE LOOP
    prior:=hon.school_pay_method_json(old);
    UPDATE hon.school_pay_methods SET version=version+1,is_default=false WHERE id=old.id RETURNING * INTO old;
    PERFORM hon.school_pay_method_record(actor,old.billing_account_id,'METHOD',old.id,old.version,'DEFAULT_CLEARED','school_pay.method.default_cleared',prior,hon.school_pay_method_json(old),request,correlation);
  END LOOP;
  prior:=hon.school_pay_method_json(m);
  UPDATE hon.school_pay_methods SET version=version+1,is_default=true WHERE id=m.id RETURNING * INTO m;
  PERFORM hon.school_pay_method_record(actor,m.billing_account_id,'METHOD',m.id,m.version,'DEFAULT_SET','school_pay.method.default',prior,hon.school_pay_method_json(m),request,correlation);
  result:=jsonb_build_object('method',hon.school_pay_method_json(m));
  RETURN hon.school_pay_method_complete(subject,key,actor,result);
END $$;

-- Remove: an ACTIVE method ends with a reason and is never used again. The API then asks the provider to detach it.
CREATE FUNCTION hon.remove_school_pay_method(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; m hon.school_pay_methods%ROWTYPE; prior jsonb; result jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','reason'],ARRAY['expectedVersion','reason'])
    OR NOT hon.membership_pause_text_ok(p->'reason',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.method.remove','methodId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_method_begin(subject,key,fp);
  actor:=hon.require_school_pay_method_actor(subject,'school_pay.method.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  m:=hon.school_pay_lock_method(selected,(p->>'expectedVersion')::integer);
  IF m.status<>'ACTIVE' THEN RAISE EXCEPTION 'SCHOOL_PAY_METHOD_STATE' USING ERRCODE='40001'; END IF;
  prior:=hon.school_pay_method_json(m);
  UPDATE hon.school_pay_methods SET version=version+1,status='REMOVED',is_default=false,removed_at=clock_timestamp(),removed_by_principal_id=actor,remove_reason=p->>'reason'
    WHERE id=m.id RETURNING * INTO m;
  PERFORM hon.school_pay_method_record(actor,m.billing_account_id,'METHOD',m.id,m.version,'METHOD_REMOVED','school_pay.method.remove',prior,hon.school_pay_method_json(m),request,correlation);
  -- Only the API needs the provider references to detach the method; they are returned, never shown.
  result:=jsonb_build_object('method',hon.school_pay_method_json(m),'providerMethodRef',m.provider_method_ref,
    'connectionId',m.connection_id);
  RETURN hon.school_pay_method_complete(subject,key,actor,result);
END $$;

COMMENT ON TABLE hon.school_pay_customers IS
'0321 one provider customer per payer (billing account) and school connection; reference set once. Holds no card, token or secret. Private.';
COMMENT ON TABLE hon.school_pay_method_setups IS
'0321 hosted setup sessions for saving a payer''s card or bank account: one-time state hash, one hour lifetime, superseded by a newer one. Private.';
COMMENT ON TABLE hon.school_pay_methods IS
'0321 saved payer methods from provider observations: provider reference, brand, last four, card expiry and consent version only; never a card number or secret. Private.';
COMMENT ON TABLE hon.school_pay_method_events IS
'0321 append-only history of every saved-method command. Private.';
COMMENT ON FUNCTION hon.read_school_pay_payer_methods(text,uuid) IS
'Direct HUMAN_UI read of one payer''s saved methods, pending setups and the connections that can take one (school_pay.method.manage or school_pay.read). No DML.';
COMMENT ON FUNCTION hon.read_school_pay_expiring_methods(text) IS
'Direct HUMAN_UI card-expiry list: active saved cards expired or expiring this or next school month. No DML.';
COMMENT ON FUNCTION hon.start_school_pay_method_setup(text,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI start of a hosted card or bank setup for one payer with the payer''s consent version. No charge or message.';
COMMENT ON FUNCTION hon.finish_school_pay_method_setup(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI finish of a setup (with the one-time setup state) from one provider observation; saves the method.';
COMMENT ON FUNCTION hon.set_default_school_pay_method(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI choice of a payer''s default saved method.';
COMMENT ON FUNCTION hon.remove_school_pay_method(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI removal of one saved method with a reason. Records are kept.';

DO $$ DECLARE r text; col text; t text;
  private_fns text:='hon.guard_school_pay_method_setup(),hon.guard_school_pay_method(),hon.require_school_pay_method_actor(text,text),
    hon.require_school_pay_method_reader(text),hon.school_pay_instant(timestamptz),hon.school_pay_method_json(hon.school_pay_methods),
    hon.school_pay_setup_json(hon.school_pay_method_setups),hon.school_pay_method_observation_ok(jsonb),hon.school_pay_method_begin(text,text,text),
    hon.school_pay_method_record(uuid,uuid,text,uuid,integer,text,text,jsonb,jsonb,uuid,uuid),hon.school_pay_method_complete(text,text,uuid,jsonb),
    hon.school_pay_lock_payer(uuid),hon.school_pay_lock_method(uuid,integer)';
  entry_fns text:='hon.read_school_pay_payer_methods(text,uuid),hon.read_school_pay_expiring_methods(text),
    hon.start_school_pay_method_setup(text,jsonb,text,uuid,uuid),hon.finish_school_pay_method_setup(text,uuid,jsonb,text,uuid,uuid),
    hon.set_default_school_pay_method(text,uuid,jsonb,text,uuid,uuid),hon.remove_school_pay_method(text,uuid,jsonb,text,uuid,uuid)';
  tables text[]:=ARRAY['school_pay_customers','school_pay_method_setups','school_pay_methods','school_pay_method_events'];
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM PUBLIC',private_fns,entry_fns);
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
    END LOOP;
  END LOOP;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM %I',private_fns,entry_fns,r);
    FOREACH t IN ARRAY tables LOOP
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
    FOREACH t IN ARRAY ARRAY['hon.school_pay_customers','hon.school_pay_method_setups','hon.school_pay_methods','hon.school_pay_method_events'] LOOP
      IF has_table_privilege('hon_runtime',t,'SELECT') OR has_any_column_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
        OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
        RAISE EXCEPTION 'School payer saved methods must not widen runtime privileges';
      END IF;
    END LOOP;
  END IF;
END $$;
COMMIT;
