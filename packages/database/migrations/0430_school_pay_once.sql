BEGIN;

-- B-TUI-2 shared one-time payment (0430, assigned by the coordinator 2026-11-17): one whole payment of a server-decided
-- amount on the school's own connected processor (Stripe Connect direct charge or Square), TEST/SANDBOX mode only, for
-- the family checkout page (CP3), the walk-in kiosk tablet (WK3) and the point of sale. Spec: TUITION_COLLECTION.md
-- section 22.
--   P1  A caller's own SECURITY DEFINER entry point opens a payment with hon.school_pay_once_open after it has decided who
--       may pay and how much. The opener is internal: the runtime can never create a payment or choose its amount. One
--       live payment (OPEN, PROCESSING or SUCCEEDED) per caller record; a payment expires at most 30 minutes after it opens.
--   P2  The API alone moves a payment: start (fixes the surface, return address and provider expiry once, before any
--       provider call, so a resend with the payment's idempotency key carries the same parameters), then record what the
--       processor itself answered on retrieval. SUCCEEDED needs the processor's payment id and the exact amount and
--       currency, and is final. Nothing is taken from a browser.
--   P3  Cancel cannot double charge: a payment that may exist at the processor (started) is cancelled only through the
--       API, which expires the provider session and records what the processor then says (CANCELED, or SUCCEEDED if it
--       was already paid). The internal cancel only ends payments that never reached the processor.
--   P4  Payments and their append-only history are private (forced RLS, no runtime table privilege). Provider references
--       and the payer email reach the API through one read and never a browser. HON takes no fee.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School one-time payments require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School one-time payments require a restricted runtime';
  END IF;
  IF to_regclass('hon.school_pay_connections') IS NULL OR to_regprocedure('hon.school_pay_instant(timestamptz)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'School one-time payments require 0258 and 0321';
  END IF;
END $$;

-- Code-owned recorder of provider answers. No user, role, HQ, family or delegated authority belongs to it.
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000430','SYSTEM_SERVICE','Code-owned school one-time payment recorder');

CREATE TABLE hon.school_pay_once (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('CHECKOUT_PAGE','WALKIN_VISIT','POS_SALE')),
  source_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_code text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 5000000000),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120 AND btrim(label)=label AND label !~ '[\x01-\x1f\x7f]'),
  payer_email text CHECK (payer_email IS NULL OR (length(payer_email) BETWEEN 3 AND 254 AND payer_email ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+\.[^@[:space:][:cntrl:]]+$')),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','PROCESSING','SUCCEEDED','FAILED','EXPIRED','CANCELED')),
  surface text CHECK (surface IN ('EMBEDDED','HOSTED')),
  return_url text CHECK (return_url IS NULL OR (length(return_url) BETWEEN 10 AND 2000 AND return_url ~ '^https?://[^[:space:][:cntrl:]]+$')),
  provider_expires_at timestamptz,
  provider_session_ref text CHECK (provider_session_ref IS NULL OR provider_session_ref ~ '^[A-Za-z0-9_:-]{3,100}$'),
  provider_payment_ref text CHECK (provider_payment_ref IS NULL OR provider_payment_ref ~ '^[A-Za-z0-9_:-]{3,100}$'),
  failure_class text CHECK (failure_class IN ('DECLINED','OTHER')),
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '30 minutes'),
  CHECK ((surface IS NULL)=(return_url IS NULL) AND (surface IS NULL)=(provider_expires_at IS NULL)),
  CHECK (provider_session_ref IS NULL OR surface IS NOT NULL),
  CHECK ((state='FAILED')=(failure_class IS NOT NULL)),
  CHECK (state NOT IN ('PROCESSING','SUCCEEDED') OR provider_session_ref IS NOT NULL),
  CHECK (state<>'SUCCEEDED' OR provider_payment_ref IS NOT NULL),
  CHECK ((state IN ('SUCCEEDED','FAILED','EXPIRED','CANCELED'))=(settled_at IS NOT NULL)),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.school_pay_connections(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
-- P1: one live payment per caller record (a FAILED, EXPIRED or CANCELED one allows a new one).
CREATE UNIQUE INDEX school_pay_once_one_live_idx ON hon.school_pay_once(organization_id,school_id,source,source_id) WHERE state IN ('OPEN','PROCESSING','SUCCEEDED');
CREATE UNIQUE INDEX school_pay_once_session_idx ON hon.school_pay_once(connection_id,provider_session_ref) WHERE provider_session_ref IS NOT NULL;
CREATE INDEX school_pay_once_due_idx ON hon.school_pay_once(expires_at) WHERE state IN ('OPEN','PROCESSING');
ALTER TABLE hon.school_pay_once ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_once FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_once_no_truncate BEFORE TRUNCATE ON hon.school_pay_once
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Settings-free guard, whoever writes: written OPEN at version 1 with nothing from the processor, never deleted; scope,
-- caller, amount, label, payer and expiry never change; the start facts and each provider reference are written once; a
-- settled payment never changes; PROCESSING only moves on to SUCCEEDED or FAILED; every update bumps the version.
CREATE FUNCTION hon.guard_school_pay_once() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'OPEN' OR NEW.version<>1 OR NEW.surface IS NOT NULL OR NEW.provider_session_ref IS NOT NULL OR NEW.provider_payment_ref IS NOT NULL
      OR NEW.settled_at IS NOT NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('SUCCEEDED','FAILED','EXPIRED','CANCELED') OR NEW.version<>OLD.version+1
    OR (OLD.state='PROCESSING' AND NEW.state NOT IN ('PROCESSING','SUCCEEDED','FAILED'))
    OR (OLD.surface IS NOT NULL AND (NEW.surface,NEW.return_url,NEW.provider_expires_at) IS DISTINCT FROM (OLD.surface,OLD.return_url,OLD.provider_expires_at))
    OR (OLD.provider_session_ref IS NOT NULL AND NEW.provider_session_ref IS DISTINCT FROM OLD.provider_session_ref)
    OR (OLD.provider_payment_ref IS NOT NULL AND NEW.provider_payment_ref IS DISTINCT FROM OLD.provider_payment_ref)
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.source,NEW.source_id,NEW.connection_id,NEW.provider_code,NEW.amount_minor,NEW.currency,NEW.label,
        NEW.payer_email,NEW.expires_at,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.source,OLD.source_id,OLD.connection_id,OLD.provider_code,OLD.amount_minor,OLD.currency,OLD.label,
        OLD.payer_email,OLD.expires_at,OLD.created_at) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_ONCE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_pay_once_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_pay_once
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_pay_once();

-- Append-only history of every payment change.
CREATE TABLE hon.school_pay_once_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  payment_version integer NOT NULL CHECK (payment_version>=1),
  kind text NOT NULL CHECK (kind IN ('OPENED','STARTED','SESSION_RECORDED','PROCESSING','SUCCEEDED','FAILED','EXPIRED','CANCELED')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (payment_id,payment_version),
  FOREIGN KEY (payment_id,organization_id,school_id) REFERENCES hon.school_pay_once(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_pay_once_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_once_events FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_once_events_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_once_events
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_once_events_no_truncate BEFORE TRUNCATE ON hon.school_pay_once_events
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- What callers and the API see of a payment: no provider reference, no payer email.
CREATE FUNCTION hon.school_pay_once_json(x hon.school_pay_once) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('paymentId',x.id,'source',x.source,'sourceId',x.source_id,'providerCode',x.provider_code,'amountMinor',x.amount_minor,
    'currency',x.currency::text,'label',x.label,'state',x.state,'surface',x.surface,'failureClass',x.failure_class,'platformFee','NONE','version',x.version,
    'expiresAt',hon.school_pay_instant(x.expires_at),'createdAt',hon.school_pay_instant(x.created_at),'updatedAt',hon.school_pay_instant(x.updated_at),
    'settledAt',CASE WHEN x.settled_at IS NULL THEN NULL ELSE hon.school_pay_instant(x.settled_at) END)
$$;

-- One history row with its audit row; a settled payment also gets its inert outbox event.
CREATE FUNCTION hon.school_pay_once_record(x hon.school_pay_once,kind text,prior jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE snapshot jsonb:=hon.school_pay_once_json(x); svc constant uuid:='00000000-0000-4000-8000-000000000430'; request uuid:=gen_random_uuid();
BEGIN
  INSERT INTO hon.school_pay_once_events(organization_id,school_id,payment_id,payment_version,kind,snapshot,actor_principal_id)
    VALUES(x.organization_id,x.school_id,x.id,x.version,kind,snapshot,svc);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(x.organization_id,x.school_id,svc,'SYSTEM_SERVICE','school_pay_once.'||lower(kind),'SCHOOL_PAY_ONCE',x.id,prior,snapshot,'SUCCEEDED',request,x.id);
  IF kind IN ('SUCCEEDED','FAILED','EXPIRED','CANCELED') THEN
    INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(x.organization_id,x.school_id,'school_pay_once.settled',1,'SCHOOL_PAY_ONCE',x.id,x.version,x.id,request,snapshot);
  END IF;
END $$;

-- The school's connection a one-time payment would use: its default, connected, charging, test-mode processor that can
-- take a one-time card. NULL when there is none.
CREATE FUNCTION hon.school_pay_once_connection(organization uuid,school uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT c.id FROM hon.school_pay_connections c WHERE c.organization_id=organization AND c.school_id=school AND c.is_default
    AND c.state='CONNECTED_ACTIVE' AND c.mode='TEST' AND c.charges_enabled AND c.provider_account_ref IS NOT NULL
    AND (c.capabilities->>'oneTimeCard')::boolean
$$;

-- INTERNAL (callers' definers only): the processor a one-time payment for this school would use now (STRIPE_CONNECT or
-- SQUARE), or NULL when none can be opened. The API says which surfaces each processor supports in this environment.
CREATE FUNCTION hon.school_pay_once_provider(organization uuid,school uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT c.provider_code FROM hon.school_pay_connections c WHERE c.id=hon.school_pay_once_connection(organization,school)
$$;

-- INTERNAL P1: open one payment for a caller record whose authority and amount the caller has already decided. The same
-- call while that record's payment is OPEN returns the same id; a different amount, currency or label, or a payment that
-- is PROCESSING or SUCCEEDED, is refused.
CREATE FUNCTION hon.school_pay_once_open(organization uuid,school uuid,source text,source_id uuid,amount_minor bigint,currency text,
  label jsonb,payer jsonb,expires_at timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE conn uuid; provider text; x hon.school_pay_once%ROWTYPE; name text; email text;
BEGIN
  IF jsonb_typeof(label) IS DISTINCT FROM 'object' OR jsonb_typeof(payer) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF organization IS NULL OR school IS NULL OR source_id IS NULL OR source IS NULL OR source NOT IN ('CHECKOUT_PAGE','WALKIN_VISIT','POS_SALE')
    OR amount_minor IS NULL OR amount_minor NOT BETWEEN 1 AND 5000000000 OR currency IS NULL OR currency !~ '^[A-Z]{3}$'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(label) k) IS DISTINCT FROM ARRAY['name']
    OR jsonb_typeof(label->'name')<>'string'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(payer) k WHERE k<>'email')
    OR (payer ? 'email' AND jsonb_typeof(payer->'email')<>'string')
    OR expires_at IS NULL OR expires_at<=clock_timestamp()+interval '1 minute' OR expires_at>clock_timestamp()+interval '30 minutes' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  name:=label->>'name'; email:=lower(payer->>'email');
  IF length(name) NOT BETWEEN 1 AND 120 OR btrim(name)<>name OR name ~ '[\x01-\x1f\x7f]'
    OR (email IS NOT NULL AND (length(email) NOT BETWEEN 3 AND 254 OR email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+\.[^@[:space:][:cntrl:]]+$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  -- Lock order: school -> connection -> payment.
  PERFORM 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=organization FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_AVAILABLE' USING ERRCODE='22023'; END IF;
  conn:=hon.school_pay_once_connection(organization,school);
  IF conn IS NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_AVAILABLE' USING ERRCODE='22023'; END IF;
  SELECT c.provider_code INTO provider FROM hon.school_pay_connections c WHERE c.id=conn FOR SHARE;
  IF hon.school_pay_once_connection(organization,school) IS DISTINCT FROM conn THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_AVAILABLE' USING ERRCODE='22023'; END IF;
  SELECT * INTO x FROM hon.school_pay_once p WHERE p.organization_id=organization AND p.school_id=school AND p.source=school_pay_once_open.source
    AND p.source_id=school_pay_once_open.source_id AND p.state IN ('OPEN','PROCESSING','SUCCEEDED') FOR UPDATE;
  IF FOUND THEN
    IF x.state<>'OPEN' THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_EXISTS' USING ERRCODE='40001'; END IF;
    IF x.amount_minor<>school_pay_once_open.amount_minor OR x.currency::text<>school_pay_once_open.currency OR x.label<>name THEN
      RAISE EXCEPTION 'SCHOOL_PAY_ONCE_AMOUNT_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN x.id;
  END IF;
  INSERT INTO hon.school_pay_once(organization_id,school_id,source,source_id,connection_id,provider_code,amount_minor,currency,label,payer_email,expires_at)
    VALUES(organization,school,school_pay_once_open.source,school_pay_once_open.source_id,conn,provider,school_pay_once_open.amount_minor,
      school_pay_once_open.currency,name,email,school_pay_once_open.expires_at) RETURNING * INTO x;
  PERFORM hon.school_pay_once_record(x,'OPENED',NULL);
  RETURN x.id;
END $$;

-- INTERNAL: one payment's state for a caller's definer, locked FOR UPDATE for the caller's transaction so no answer can be
-- recorded while the caller acts on it. `providerOpen`: the processor may still hold a payable session.
CREATE FUNCTION hon.school_pay_once_state(payment uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_pay_once%ROWTYPE;
BEGIN
  SELECT * INTO x FROM hon.school_pay_once p WHERE p.id=payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('paymentId',x.id,'organizationId',x.organization_id,'schoolId',x.school_id,'source',x.source,'sourceId',x.source_id,
    'state',x.state,'amountMinor',x.amount_minor,'currency',x.currency::text,'providerCode',x.provider_code,
    'providerOpen',x.state='OPEN' AND x.surface IS NOT NULL,
    'settledAt',CASE WHEN x.settled_at IS NULL THEN NULL ELSE hon.school_pay_instant(x.settled_at) END);
END $$;

-- INTERNAL P3: end a payment that never reached the processor. A started payment must be cancelled through the API
-- first (SCHOOL_PAY_ONCE_PROVIDER_OPEN); PROCESSING and SUCCEEDED are refused; an already ended one is returned as is.
CREATE FUNCTION hon.school_pay_once_cancel(payment uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_pay_once%ROWTYPE; prior jsonb;
BEGIN
  SELECT * INTO x FROM hon.school_pay_once p WHERE p.id=payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF x.state='PROCESSING' THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF x.state='SUCCEEDED' THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_PAID' USING ERRCODE='40001'; END IF;
  IF x.state='OPEN' THEN
    IF x.surface IS NOT NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_PROVIDER_OPEN' USING ERRCODE='40001'; END IF;
    prior:=hon.school_pay_once_json(x);
    UPDATE hon.school_pay_once SET version=version+1,state='CANCELED',updated_at=clock_timestamp(),settled_at=clock_timestamp() WHERE id=x.id RETURNING * INTO x;
    PERFORM hon.school_pay_once_record(x,'CANCELED',prior);
  END IF;
  RETURN hon.school_pay_once_state(x.id);
END $$;

-- API P4: one payment with what the API needs to call the processor (account, payer email, start facts, session). No DML.
CREATE FUNCTION hon.read_school_pay_once(payment uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_pay_once%ROWTYPE; c hon.school_pay_connections%ROWTYPE;
BEGIN
  IF payment IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO x FROM hon.school_pay_once p WHERE p.id=payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.school_pay_connections k WHERE k.id=x.connection_id;
  IF c.provider_account_ref IS NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('payment',hon.school_pay_once_json(x),
    'provider',jsonb_build_object('providerCode',c.provider_code,'accountRef',c.provider_account_ref,'connectionState',c.state),
    'payerEmail',x.payer_email,'returnUrl',x.return_url,'sessionRef',x.provider_session_ref,
    'providerExpiresAt',CASE WHEN x.provider_expires_at IS NULL THEN NULL ELSE hon.school_pay_instant(x.provider_expires_at) END);
END $$;

-- API P2: fix how an OPEN payment is presented before any provider call. The first start needs an unexpired payment and a
-- still usable connection; it sets the provider session expiry 31 minutes ahead (Stripe needs at least 30). A later start
-- must ask for the same surface and return address and gets the same facts back.
CREATE FUNCTION hon.start_school_pay_once(payment uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_pay_once%ROWTYPE; prior jsonb;
BEGIN
  IF payment IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['returnUrl','surface']
    OR jsonb_typeof(p->'surface')<>'string' OR p->>'surface' NOT IN ('EMBEDDED','HOSTED')
    OR jsonb_typeof(p->'returnUrl')<>'string' OR length(p->>'returnUrl') NOT BETWEEN 10 AND 2000 OR p->>'returnUrl' !~ '^https?://[^[:space:][:cntrl:]]+$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO x FROM hon.school_pay_once k WHERE k.id=payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM hon.school_pay_connections c WHERE c.id=x.connection_id FOR SHARE;
  SELECT * INTO x FROM hon.school_pay_once k WHERE k.id=payment FOR UPDATE;
  IF x.surface IS NOT NULL THEN
    IF x.surface<>p->>'surface' OR x.return_url<>p->>'returnUrl' THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_START_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN hon.read_school_pay_once(x.id);
  END IF;
  IF x.state<>'OPEN' THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_STATE' USING ERRCODE='40001'; END IF;
  IF clock_timestamp()>=x.expires_at THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_EXPIRED' USING ERRCODE='40001'; END IF;
  IF hon.school_pay_once_connection(x.organization_id,x.school_id) IS DISTINCT FROM x.connection_id THEN
    RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_AVAILABLE' USING ERRCODE='22023'; END IF;
  prior:=hon.school_pay_once_json(x);
  UPDATE hon.school_pay_once SET version=version+1,updated_at=clock_timestamp(),surface=p->>'surface',return_url=p->>'returnUrl',
      provider_expires_at=date_trunc('second',clock_timestamp())+interval '31 minutes'
    WHERE id=x.id RETURNING * INTO x;
  PERFORM hon.school_pay_once_record(x,'STARTED',prior);
  RETURN hon.read_school_pay_once(x.id);
END $$;

-- API P2/P3: record what the processor answered on retrieval for a started payment. The first answer records the
-- session. OPEN (still payable) changes nothing else; SUCCEEDED needs the payment id; EXPIRED and CANCELED are the
-- processor saying the session is closed unpaid. Without a session (never started, or the processor refused to create
-- one) only CANCELED, or EXPIRED once its own expiry has passed, is accepted. A settled payment returns as is for the
-- same answer and refuses any other.
CREATE FUNCTION hon.record_school_pay_once(payment uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE x hon.school_pay_once%ROWTYPE; prior jsonb; outcome text; ref text; paid text;
BEGIN
  IF payment IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('outcome','amountMinor','currency','sessionRef','paymentRef','failureClass'))
    OR jsonb_typeof(p->'outcome') IS DISTINCT FROM 'string' OR p->>'outcome' NOT IN ('OPEN','PROCESSING','SUCCEEDED','FAILED','EXPIRED','CANCELED')
    OR jsonb_typeof(p->'amountMinor') IS DISTINCT FROM 'number' OR (p->'amountMinor')::text !~ '^[1-9][0-9]{0,9}$'
    OR jsonb_typeof(p->'currency') IS DISTINCT FROM 'string' OR p->>'currency' !~ '^[A-Z]{3}$'
    OR (p ? 'sessionRef' AND (jsonb_typeof(p->'sessionRef')<>'string' OR p->>'sessionRef' !~ '^[A-Za-z0-9_:-]{3,100}$'))
    OR (p ? 'paymentRef' AND (jsonb_typeof(p->'paymentRef')<>'string' OR p->>'paymentRef' !~ '^[A-Za-z0-9_:-]{3,100}$'))
    OR ((p->>'outcome'='SUCCEEDED')<>(p ? 'paymentRef'))
    OR ((p->>'outcome'='FAILED')<>(p ? 'failureClass'))
    OR (p ? 'failureClass' AND (jsonb_typeof(p->'failureClass')<>'string' OR p->>'failureClass' NOT IN ('DECLINED','OTHER'))) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  outcome:=p->>'outcome'; ref:=p->>'sessionRef'; paid:=p->>'paymentRef';
  SELECT * INTO x FROM hon.school_pay_once k WHERE k.id=payment FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF x.amount_minor<>(p->>'amountMinor')::bigint OR x.currency::text<>p->>'currency' THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_AMOUNT_MISMATCH' USING ERRCODE='22023'; END IF;
  IF ref IS NULL THEN
    -- No session at the processor (never started, or the processor refused to create one): it can only end, unpaid, and
    -- only by its own expiry when it was never cancelled.
    IF x.provider_session_ref IS NOT NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_REF_MISMATCH' USING ERRCODE='22023'; END IF;
    IF outcome NOT IN ('EXPIRED','CANCELED') OR (outcome='EXPIRED' AND clock_timestamp()<x.expires_at) THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_STATE' USING ERRCODE='40001'; END IF;
  ELSIF x.surface IS NULL OR (x.provider_session_ref IS NOT NULL AND x.provider_session_ref<>ref) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_ONCE_REF_MISMATCH' USING ERRCODE='22023';
  END IF;
  IF x.state IN ('SUCCEEDED','FAILED','EXPIRED','CANCELED') THEN
    IF x.state<>outcome OR (paid IS NOT NULL AND paid IS DISTINCT FROM x.provider_payment_ref) THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_STATE' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('payment',hon.school_pay_once_json(x));
  END IF;
  IF x.state='PROCESSING' AND outcome NOT IN ('PROCESSING','SUCCEEDED','FAILED') THEN RAISE EXCEPTION 'SCHOOL_PAY_ONCE_STATE' USING ERRCODE='40001'; END IF;
  IF ref IS NOT NULL AND x.provider_session_ref IS NULL THEN
    prior:=hon.school_pay_once_json(x);
    UPDATE hon.school_pay_once SET version=version+1,updated_at=clock_timestamp(),provider_session_ref=ref WHERE id=x.id RETURNING * INTO x;
    PERFORM hon.school_pay_once_record(x,'SESSION_RECORDED',prior);
  END IF;
  IF outcome=x.state THEN RETURN jsonb_build_object('payment',hon.school_pay_once_json(x)); END IF;
  prior:=hon.school_pay_once_json(x);
  UPDATE hon.school_pay_once SET version=version+1,state=outcome,updated_at=clock_timestamp(),provider_payment_ref=coalesce(provider_payment_ref,paid),
      failure_class=CASE WHEN outcome='FAILED' THEN p->>'failureClass' ELSE NULL END,
      settled_at=CASE WHEN outcome IN ('SUCCEEDED','FAILED','EXPIRED','CANCELED') THEN clock_timestamp() ELSE NULL END
    WHERE id=x.id RETURNING * INTO x;
  PERFORM hon.school_pay_once_record(x,outcome,prior);
  RETURN jsonb_build_object('payment',hon.school_pay_once_json(x));
END $$;

-- API: payments past their own expiry that are still OPEN or PROCESSING, oldest first, for the reconcile sweep. No DML.
CREATE FUNCTION hon.list_due_school_pay_once(max_rows integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF max_rows IS NULL OR max_rows NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  RETURN coalesce((SELECT jsonb_agg(d.id ORDER BY d.expires_at,d.id) FROM (SELECT p.id,p.expires_at FROM hon.school_pay_once p
    WHERE p.state IN ('OPEN','PROCESSING') AND p.expires_at<=clock_timestamp() ORDER BY p.expires_at,p.id LIMIT max_rows) d),'[]'::jsonb);
END $$;

COMMENT ON TABLE hon.school_pay_once IS
'0430 one whole one-time payment on the school''s own processor (test mode) for a checkout page, a walk-in visit or a point-of-sale sale: OPEN, PROCESSING, SUCCEEDED, FAILED, EXPIRED or CANCELED. One live payment per caller record. Private.';
COMMENT ON TABLE hon.school_pay_once_events IS
'0430 append-only history of every one-time payment change. Private.';
COMMENT ON FUNCTION hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz) IS
'INTERNAL (callers'' SECURITY DEFINER functions only, never the runtime): open one payment for a caller record whose authority and amount the caller decided.';
COMMENT ON FUNCTION hon.school_pay_once_state(uuid) IS
'INTERNAL: one payment''s state, locked FOR UPDATE for the caller''s transaction.';
COMMENT ON FUNCTION hon.school_pay_once_cancel(uuid) IS
'INTERNAL: end a payment that never reached the processor; a started one must be cancelled through the API first.';
COMMENT ON FUNCTION hon.school_pay_once_provider(uuid,uuid) IS
'INTERNAL: the processor of the school''s default test-mode connection that can take a one-time card now, or NULL.';
COMMENT ON FUNCTION hon.read_school_pay_once(uuid) IS
'API-only read of one payment with its provider account, payer email and session; never forwarded to a browser. No DML.';
COMMENT ON FUNCTION hon.start_school_pay_once(uuid,jsonb) IS
'API-only: fix the surface, return address and provider expiry of an OPEN payment once, before any provider call.';
COMMENT ON FUNCTION hon.record_school_pay_once(uuid,jsonb) IS
'API-only: record the processor''s retrieved answer for a payment; SUCCEEDED is final and needs the processor payment id.';
COMMENT ON FUNCTION hon.list_due_school_pay_once(integer) IS
'API-only: ids of payments past their expiry that are still OPEN or PROCESSING, for reconcile. No DML.';

DO $$ DECLARE r text; col text; t text;
  private_fns text:='hon.guard_school_pay_once(),hon.school_pay_once_json(hon.school_pay_once),hon.school_pay_once_record(hon.school_pay_once,text,jsonb),
    hon.school_pay_once_connection(uuid,uuid),hon.school_pay_once_provider(uuid,uuid),
    hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz),hon.school_pay_once_state(uuid),hon.school_pay_once_cancel(uuid)';
  entry_fns text:='hon.read_school_pay_once(uuid),hon.start_school_pay_once(uuid,jsonb),hon.record_school_pay_once(uuid,jsonb),hon.list_due_school_pay_once(integer)';
  tables text[]:=ARRAY['school_pay_once','school_pay_once_events'];
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
    FOREACH t IN ARRAY ARRAY['hon.school_pay_once','hon.school_pay_once_events'] LOOP
      IF has_table_privilege('hon_runtime',t,'SELECT') OR has_any_column_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
        OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
        RAISE EXCEPTION 'School one-time payments must not widen runtime privileges';
      END IF;
    END LOOP;
    IF has_function_privilege('hon_runtime','hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.school_pay_once_cancel(uuid)','EXECUTE') OR has_function_privilege('hon_runtime','hon.school_pay_once_state(uuid)','EXECUTE') THEN
      RAISE EXCEPTION 'School one-time payment openers must stay internal';
    END IF;
  END IF;
END $$;
COMMIT;
