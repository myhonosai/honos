BEGIN;

-- B-TUI-2 piece 5a (0337, assigned by the coordinator 2026-11-13): charging a prepared autopay cycle with the payer's saved
-- method at the school's own payment processor (TEST mode only). Spec: docs/architecture/TUITION_COLLECTION.md section 15.
--   P1  A staff member with school_pay.autopay.manage starts one charge attempt for one prepared cycle (0322), confirming its
--       total and currency. The plan must be ACTIVE and name a usable saved method; every cycle invoice must still be
--       ISSUED with nothing recorded against it. A cycle has at most one attempt that is not FAILED, so a cycle is charged
--       at most once; a FAILED attempt allows a new one.
--   P2  The API calls the processor between two database commands (begin, then finish), with the provider idempotency key
--       hon-school-pay-charge-<attemptId>. The outcome is recorded as SUCCEEDED, PROCESSING (a bank debit still clearing),
--       FAILED (with a failure class) or UNKNOWN (the processor may have charged). An attempt that is PENDING, PROCESSING
--       or UNKNOWN is open: it can only be settled from the processor's own answer (finish or reconcile), never guessed.
--   P3  SUCCEEDED writes one invoice payment record per cycle invoice (new method PROVIDER, reference = the processor's
--       charge id, received on the school's today) and marks each invoice PAID. While an attempt is open, the cycle's
--       invoices cannot get a manual payment or leave ISSUED other than to PAID; a PROVIDER record can never be voided by
--       hand (refunds are a later piece).
--   P4  Attempts and their append-only history are private (forced RLS, no runtime table privilege). Provider references
--       reach the API through one manage-only read and never reach the browser. HON takes no fee.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School autopay charges require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School autopay charges require a restricted runtime';
  END IF;
  IF to_regclass('hon.school_pay_autopay_cycles') IS NULL OR to_regclass('hon.invoice_payment_records') IS NULL
    OR to_regprocedure('hon.school_pay_autopay_begin(text,text,text,text)') IS NULL
    OR to_regprocedure('hon.school_pay_autopay_complete(text,text,text,uuid,jsonb)') IS NULL
    OR to_regprocedure('hon.require_school_pay_autopay_reader(text,text[])') IS NULL
    OR to_regprocedure('hon.school_pay_autopay_method_usable(uuid,uuid)') IS NULL OR to_regprocedure('hon.school_pay_school_zone()') IS NULL
    OR to_regprocedure('hon.school_pay_lock_payer(uuid)') IS NULL OR to_regprocedure('hon.school_pay_instant(timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'School autopay charges require 0240, 0258, 0321 and 0322';
  END IF;
END $$;

-- P3: the processor's own record of a charge is a payment method of its own; staff entry stays manual-only (0240 input check).
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='hon.invoice_payment_records'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%CARD_TERMINAL%' LOOP
    EXECUTE format('ALTER TABLE hon.invoice_payment_records DROP CONSTRAINT %I',c);
  END LOOP;
END $$;
ALTER TABLE hon.invoice_payment_records ADD CONSTRAINT invoice_payment_records_method_check
  CHECK (method IN ('CASH','CHECK','CARD_TERMINAL','BANK_TRANSFER','OTHER','PROVIDER'));
ALTER TABLE hon.invoice_payment_records ADD CONSTRAINT invoice_payment_records_provider_reference_check
  CHECK (method<>'PROVIDER' OR (reference IS NOT NULL AND reference ~ '^[A-Za-z0-9_:-]{3,100}$'));

-- P1/P2: one row per charge attempt.
CREATE TABLE hon.school_pay_charge_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  method_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_code text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 1 AND 5000000000),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','PROCESSING','SUCCEEDED','FAILED','UNKNOWN')),
  failure_class text CHECK (failure_class IN ('DECLINED','AUTHENTICATION_REQUIRED','INSUFFICIENT_FUNDS','EXPIRED_CARD','NOT_SENT','OTHER')),
  provider_charge_ref text CHECK (provider_charge_ref IS NULL OR provider_charge_ref ~ '^[A-Za-z0-9_:-]{3,100}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK ((state='FAILED')=(failure_class IS NOT NULL)),
  CHECK (state NOT IN ('SUCCEEDED','PROCESSING') OR provider_charge_ref IS NOT NULL),
  CHECK ((state IN ('SUCCEEDED','FAILED'))=(finished_at IS NOT NULL)),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (cycle_id,organization_id,school_id) REFERENCES hon.school_pay_autopay_cycles(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_id,organization_id,school_id) REFERENCES hon.school_pay_autopay_plans(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (method_id,organization_id,school_id) REFERENCES hon.school_pay_methods(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (connection_id,organization_id,school_id) REFERENCES hon.school_pay_connections(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id) ON DELETE RESTRICT
);
-- At most one attempt per cycle that is open or succeeded.
CREATE UNIQUE INDEX school_pay_charge_attempts_one_live_idx ON hon.school_pay_charge_attempts(cycle_id) WHERE state<>'FAILED';
CREATE UNIQUE INDEX school_pay_charge_attempts_ref_idx ON hon.school_pay_charge_attempts(connection_id,provider_charge_ref) WHERE provider_charge_ref IS NOT NULL;
CREATE INDEX school_pay_charge_attempts_payer_idx ON hon.school_pay_charge_attempts(organization_id,school_id,billing_account_id,created_at);
CREATE INDEX school_pay_charge_attempts_open_idx ON hon.school_pay_charge_attempts(organization_id,school_id,created_at) WHERE state IN ('PENDING','PROCESSING','UNKNOWN');
ALTER TABLE hon.school_pay_charge_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_charge_attempts FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_charge_attempts_no_truncate BEFORE TRUNCATE ON hon.school_pay_charge_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Settings-free attempt guard, whoever writes: written PENDING at version 1, never deleted; scope, cycle, method, amount
-- and creation facts never change; a SUCCEEDED or FAILED attempt never changes again; nothing returns to PENDING; a
-- recorded processor charge id never changes; every update bumps the version.
CREATE FUNCTION hon.guard_school_pay_charge_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PENDING' OR NEW.version<>1 OR NEW.provider_charge_ref IS NOT NULL OR NEW.finished_at IS NOT NULL THEN
      RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('SUCCEEDED','FAILED') OR NEW.state='PENDING' OR NEW.version<>OLD.version+1
    OR (OLD.provider_charge_ref IS NOT NULL AND NEW.provider_charge_ref IS DISTINCT FROM OLD.provider_charge_ref)
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.billing_account_id,NEW.cycle_id,NEW.plan_id,NEW.method_id,NEW.connection_id,NEW.provider_code,
        NEW.amount_minor,NEW.currency,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.billing_account_id,OLD.cycle_id,OLD.plan_id,OLD.method_id,OLD.connection_id,OLD.provider_code,
        OLD.amount_minor,OLD.currency,OLD.created_by_principal_id,OLD.created_at) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_pay_charge_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_pay_charge_attempts
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_pay_charge_attempt();

-- Append-only history of every attempt change.
CREATE TABLE hon.school_pay_charge_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  attempt_version integer NOT NULL CHECK (attempt_version>=1),
  kind text NOT NULL CHECK (kind IN ('CHARGE_STARTED','CHARGE_PROCESSING','CHARGE_SUCCEEDED','CHARGE_FAILED','CHARGE_UNKNOWN')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attempt_id,attempt_version),
  FOREIGN KEY (attempt_id,organization_id,school_id) REFERENCES hon.school_pay_charge_attempts(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_pay_charge_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_charge_events FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_charge_events_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_charge_events
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_charge_events_no_truncate BEFORE TRUNCATE ON hon.school_pay_charge_events
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Whether an invoice belongs to a cycle with an open charge attempt.
CREATE FUNCTION hon.school_pay_invoice_charge_open(invoice uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.school_pay_autopay_cycle_lines l JOIN hon.school_pay_charge_attempts a ON a.cycle_id=l.cycle_id
    WHERE l.invoice_id=invoice AND a.state IN ('PENDING','PROCESSING','UNKNOWN'))
$$;

-- P3, whoever writes: no manual payment on an invoice whose charge is open; a PROVIDER record is never voided by hand.
CREATE FUNCTION hon.guard_school_pay_charge_payment_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.method<>'PROVIDER' AND hon.school_pay_invoice_charge_open(NEW.invoice_id) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_IN_PROGRESS' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND OLD.method='PROVIDER' AND NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    RAISE EXCEPTION 'SCHOOL_PAY_PROVIDER_PAYMENT_LOCKED' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_pay_charge_payment_record_guard BEFORE INSERT OR UPDATE ON hon.invoice_payment_records
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_pay_charge_payment_record();

-- P3, whoever writes: while its charge is open, an ISSUED cycle invoice only moves to PAID.
CREATE FUNCTION hon.guard_school_pay_charge_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'PAID' AND hon.school_pay_invoice_charge_open(OLD.id) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_IN_PROGRESS' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_pay_charge_invoice_guard BEFORE UPDATE ON hon.invoices
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_pay_charge_invoice();

CREATE FUNCTION hon.school_pay_charge_json(a hon.school_pay_charge_attempts) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('attemptId',a.id,'cycleId',a.cycle_id,'billingAccountId',a.billing_account_id,'planId',a.plan_id,'methodId',a.method_id,
    'providerCode',a.provider_code,'amountMinor',a.amount_minor,'currency',a.currency::text,'state',a.state,'failureClass',a.failure_class,
    'platformFee','NONE','version',a.version,'createdAt',hon.school_pay_instant(a.created_at),'updatedAt',hon.school_pay_instant(a.updated_at),
    'finishedAt',CASE WHEN a.finished_at IS NULL THEN NULL ELSE hon.school_pay_instant(a.finished_at) END)
$$;

-- One history row with its audit row and inert outbox event.
CREATE FUNCTION hon.school_pay_charge_record(actor uuid,a hon.school_pay_charge_attempts,kind text,prior_state jsonb,source text,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE snapshot jsonb:=hon.school_pay_charge_json(a);
BEGIN
  INSERT INTO hon.school_pay_charge_events(organization_id,school_id,billing_account_id,attempt_id,attempt_version,kind,snapshot,actor_principal_id)
    VALUES(a.organization_id,a.school_id,a.billing_account_id,a.id,a.version,kind,snapshot,actor);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(a.organization_id,a.school_id,actor,source,'school_pay.charge.'||lower(substr(kind,8)),'SCHOOL_PAY_CHARGE',a.id,prior_state,snapshot,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(a.organization_id,a.school_id,'school_pay.charge.'||lower(substr(kind,8)),1,'SCHOOL_PAY_CHARGE',a.id,a.version,correlation,request,snapshot);
END $$;

-- Lock and load one current-school attempt (after its payer), checking the expected version.
CREATE FUNCTION hon.school_pay_lock_charge(selected uuid,expected integer) RETURNS hon.school_pay_charge_attempts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE a hon.school_pay_charge_attempts%ROWTYPE; payer uuid;
BEGIN
  SELECT x.billing_account_id INTO payer FROM hon.school_pay_charge_attempts x WHERE x.id=selected AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.school_pay_lock_payer(payer);
  SELECT * INTO a FROM hon.school_pay_charge_attempts x WHERE x.id=selected FOR UPDATE;
  IF a.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN a;
END $$;

-- Read one payer's charge attempts (latest 24) for staff. No provider reference. No DML.
CREATE FUNCTION hon.read_school_pay_autopay_charges(subject text,payer uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; result jsonb;
BEGIN
  IF payer IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  used:=hon.require_school_pay_autopay_reader(subject,ARRAY['school_pay.autopay.manage','school_pay.read']); actor:=hon.require_school_pay_autopay_actor(subject,used);
  PERFORM 1 FROM hon.billing_accounts b WHERE b.id=payer AND b.organization_id=org AND b.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_PAYER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('billingAccountId',payer,'canManage',used='school_pay.autopay.manage','platformFee','NONE',
    'attempts',coalesce((SELECT jsonb_agg(hon.school_pay_charge_json(a) ORDER BY a.created_at DESC,a.id) FROM (
      SELECT * FROM hon.school_pay_charge_attempts x WHERE x.organization_id=org AND x.school_id=school AND x.billing_account_id=payer
      ORDER BY x.created_at DESC,x.id LIMIT 24) a),'[]'::jsonb));
  IF hon.require_school_pay_autopay_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- P4: one attempt with the provider references the API needs to call the processor. Manage permission only; the API
-- never forwards the references to the browser. No DML.
CREATE FUNCTION hon.read_school_pay_charge_attempt(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; result jsonb; a hon.school_pay_charge_attempts%ROWTYPE;
BEGIN
  IF selected IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_school_pay_autopay_actor(subject,'school_pay.autopay.manage');
  SELECT * INTO a FROM hon.school_pay_charge_attempts x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT jsonb_build_object('attempt',hon.school_pay_charge_json(a),'provider',jsonb_build_object('providerCode',c.provider_code,'accountRef',c.provider_account_ref,
      'customerRef',k.provider_customer_ref,'methodRef',m.provider_method_ref,'methodKind',m.kind,'connectionState',c.state))
    INTO result
    FROM hon.school_pay_methods m JOIN hon.school_pay_customers k ON k.id=m.customer_id JOIN hon.school_pay_connections c ON c.id=a.connection_id
    WHERE m.id=a.method_id;
  IF result IS NULL OR result->'provider'->>'accountRef' IS NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF hon.require_school_pay_autopay_actor(subject,'school_pay.autopay.manage') IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- P1: start one charge attempt for a prepared cycle. Nothing is sent to the processor here.
CREATE FUNCTION hon.begin_school_pay_charge(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; c hon.school_pay_autopay_cycles%ROWTYPE; plan hon.school_pay_autopay_plans%ROWTYPE; a hon.school_pay_charge_attempts%ROWTYPE;
  conn uuid; provider text; bad integer; result jsonb; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['totalMinor','currency'],ARRAY['totalMinor','currency'])
    OR jsonb_typeof(p->'totalMinor')<>'number' OR (p->'totalMinor')::text !~ '^[1-9][0-9]{0,9}$'
    OR jsonb_typeof(p->'currency')<>'string' OR p->>'currency' !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.charge.begin','cycleId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_autopay_begin(subject,'school_pay.autopay.manage',key,fp);
  actor:=hon.require_school_pay_autopay_actor(subject,'school_pay.autopay.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT * INTO c FROM hon.school_pay_autopay_cycles x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_CYCLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.school_pay_lock_payer(c.billing_account_id);
  PERFORM 1 FROM hon.school_pay_autopay_cycles x WHERE x.id=c.id FOR UPDATE;
  IF c.total_minor<>(p->>'totalMinor')::bigint OR c.currency::text<>p->>'currency' THEN RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_AMOUNT_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT * INTO plan FROM hon.school_pay_autopay_plans x WHERE x.id=c.plan_id FOR SHARE;
  IF plan.state<>'ACTIVE' THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_STATE' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM hon.school_pay_methods m WHERE m.id=plan.method_id FOR SHARE;
  SELECT m.connection_id INTO conn FROM hon.school_pay_methods m WHERE m.id=plan.method_id;
  PERFORM 1 FROM hon.school_pay_connections x WHERE x.id=conn FOR SHARE;
  IF NOT hon.school_pay_autopay_method_usable(plan.method_id,c.billing_account_id) THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE' USING ERRCODE='22023'; END IF;
  -- Review P3: charge only under consent text HON knows it showed: the autopay agreement and the saved method's own
  -- card-on-file or bank-debit mandate for its kind. Any other recorded version is treated as an unusable method.
  IF plan.consent_text_version<>'autopay-v1' OR NOT EXISTS(SELECT 1 FROM hon.school_pay_methods m WHERE m.id=plan.method_id
      AND m.consent_text_version=CASE m.kind WHEN 'CARD' THEN 'card-on-file-v1' WHEN 'US_BANK_ACCOUNT' THEN 'ach-mandate-v1' END) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE' USING ERRCODE='22023'; END IF;
  SELECT x.provider_code INTO provider FROM hon.school_pay_connections x WHERE x.id=conn AND x.mode='TEST';
  IF provider IS NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE' USING ERRCODE='22023'; END IF;
  -- Review P3: a success must always be recordable, so the school time zone that finish needs is checked before sending.
  PERFORM hon.school_pay_school_zone();
  IF EXISTS(SELECT 1 FROM hon.school_pay_charge_attempts x WHERE x.cycle_id=c.id AND x.state<>'FAILED') THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_EXISTS' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM hon.invoices i JOIN hon.school_pay_autopay_cycle_lines l ON l.invoice_id=i.id WHERE l.cycle_id=c.id ORDER BY i.id FOR UPDATE OF i;
  SELECT count(*) INTO bad FROM hon.school_pay_autopay_cycle_lines l JOIN hon.invoices i ON i.id=l.invoice_id
    WHERE l.cycle_id=c.id AND (i.status<>'ISSUED' OR i.total_minor<>l.amount_minor-l.discount_minor OR i.currency<>c.currency
      OR EXISTS(SELECT 1 FROM hon.invoice_payment_records r WHERE r.invoice_id=i.id AND r.voided_at IS NULL));
  IF bad>0 OR (SELECT count(*) FROM hon.school_pay_autopay_cycle_lines l WHERE l.cycle_id=c.id)<>c.line_count THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_INVOICES_CHANGED' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.school_pay_charge_attempts(organization_id,school_id,billing_account_id,cycle_id,plan_id,method_id,connection_id,provider_code,amount_minor,currency,created_by_principal_id)
    VALUES(org,school,c.billing_account_id,c.id,plan.id,plan.method_id,conn,provider,c.total_minor,c.currency,actor) RETURNING * INTO a;
  PERFORM hon.school_pay_charge_record(actor,a,'CHARGE_STARTED',NULL,'HUMAN_UI',request,correlation);
  result:=jsonb_build_object('attempt',hon.school_pay_charge_json(a));
  RETURN hon.school_pay_autopay_complete(subject,'school_pay.autopay.manage',key,actor,result);
END $$;

-- P2: a processor answer as a command accepts it (success and processing carry the charge id; failure its class).
CREATE FUNCTION hon.school_pay_charge_outcome_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(jsonb_typeof(p)='object'
    AND jsonb_typeof(p->'outcome')='string' AND p->>'outcome' IN ('SUCCEEDED','PROCESSING','FAILED','UNKNOWN')
    AND jsonb_typeof(p->'amountMinor')='number' AND (p->'amountMinor')::text ~ '^[1-9][0-9]{0,9}$'
    AND jsonb_typeof(p->'currency')='string' AND p->>'currency' ~ '^[A-Z]{3}$'
    AND (NOT p ? 'chargeRef' OR (jsonb_typeof(p->'chargeRef')='string' AND p->>'chargeRef' ~ '^[A-Za-z0-9_:-]{3,100}$'))
    AND (p->>'outcome' NOT IN ('SUCCEEDED','PROCESSING') OR p ? 'chargeRef')
    AND ((p->>'outcome'='FAILED')=(p ? 'failureClass'))
    AND (NOT p ? 'failureClass' OR (jsonb_typeof(p->'failureClass')='string'
      AND p->>'failureClass' IN ('DECLINED','AUTHENTICATION_REQUIRED','INSUFFICIENT_FUNDS','EXPIRED_CARD','NOT_SENT','OTHER'))),false)
$$;

-- P2/P3: apply one processor answer to a locked open attempt (shared by the staff command and, later, verified provider
-- events). An answer that is not final leaves the attempt as it is; SUCCEEDED pays every cycle invoice.
CREATE FUNCTION hon.school_pay_charge_settle(a hon.school_pay_charge_attempts,p jsonb,actor uuid,source text,request uuid,correlation uuid) RETURNS hon.school_pay_charge_attempts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE prior jsonb; outcome text:=p->>'outcome'; ref text:=p->>'chargeRef'; tz text; today date; line record; rec hon.invoice_payment_records%ROWTYPE;
  inv hon.invoices%ROWTYPE; bad integer;
BEGIN
  IF NOT hon.school_pay_charge_outcome_ok(p) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF a.state NOT IN ('PENDING','PROCESSING','UNKNOWN') THEN RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_STATE' USING ERRCODE='40001'; END IF;
  IF a.amount_minor<>(p->>'amountMinor')::bigint OR a.currency::text<>p->>'currency' THEN RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_AMOUNT_MISMATCH' USING ERRCODE='22023'; END IF;
  IF a.provider_charge_ref IS NOT NULL AND ref IS DISTINCT FROM a.provider_charge_ref AND outcome<>'UNKNOWN' THEN
    RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_REF_MISMATCH' USING ERRCODE='22023'; END IF;
  -- An open attempt only stays where it is when the processor still gives no final answer; nothing is written then.
  IF outcome=a.state OR (outcome='UNKNOWN' AND a.state='PROCESSING') THEN RETURN a; END IF;
  prior:=hon.school_pay_charge_json(a);
  IF outcome='SUCCEEDED' THEN
    SELECT s.timezone INTO tz FROM hon.schools s JOIN pg_timezone_names z ON z.name=s.timezone WHERE s.id=a.school_id AND s.organization_id=a.organization_id;
    IF tz IS NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_SCHOOL_TIME_ZONE_INVALID' USING ERRCODE='22023'; END IF;
    today:=(clock_timestamp() AT TIME ZONE tz)::date;
    PERFORM 1 FROM hon.invoices i JOIN hon.school_pay_autopay_cycle_lines l ON l.invoice_id=i.id WHERE l.cycle_id=a.cycle_id ORDER BY i.id FOR UPDATE OF i;
    SELECT count(*) INTO bad FROM hon.school_pay_autopay_cycle_lines l JOIN hon.invoices i ON i.id=l.invoice_id
      WHERE l.cycle_id=a.cycle_id AND (i.status<>'ISSUED' OR EXISTS(SELECT 1 FROM hon.invoice_payment_records r WHERE r.invoice_id=i.id AND r.voided_at IS NULL));
    IF bad>0 OR (SELECT coalesce(sum(i.total_minor),0) FROM hon.school_pay_autopay_cycle_lines l JOIN hon.invoices i ON i.id=l.invoice_id WHERE l.cycle_id=a.cycle_id)<>a.amount_minor THEN
      RAISE EXCEPTION 'SCHOOL_PAY_CHARGE_INVOICES_CHANGED' USING ERRCODE='40001'; END IF;
  END IF;
  UPDATE hon.school_pay_charge_attempts SET version=version+1,state=outcome,updated_at=clock_timestamp(),
      provider_charge_ref=coalesce(provider_charge_ref,ref),
      failure_class=CASE WHEN outcome='FAILED' THEN p->>'failureClass' ELSE NULL END,
      finished_at=CASE WHEN outcome IN ('SUCCEEDED','FAILED') THEN clock_timestamp() ELSE NULL END
    WHERE id=a.id RETURNING * INTO a;
  IF outcome='SUCCEEDED' THEN
    FOR line IN SELECT l.invoice_id FROM hon.school_pay_autopay_cycle_lines l WHERE l.cycle_id=a.cycle_id ORDER BY l.student_rank,l.amount_minor DESC,l.membership_id LOOP
      SELECT * INTO inv FROM hon.invoices i WHERE i.id=line.invoice_id;
      INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,reference,note,actor_principal_id)
        VALUES(a.organization_id,a.school_id,inv.id,inv.total_minor::integer,inv.currency,today,'PROVIDER',a.provider_charge_ref,NULL,actor) RETURNING * INTO rec;
      UPDATE hon.invoices SET version=version+1,status='PAID'::hon.invoice_status WHERE id=inv.id RETURNING * INTO inv;
      INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
        VALUES(a.organization_id,a.school_id,actor,source,'school_pay.charge.invoice_paid','INVOICE',inv.id,NULL,
          jsonb_build_object('invoiceId',inv.id,'attemptId',a.id,'paymentId',rec.id,'status','PAID','amountMinor',rec.amount_minor,'currency',rec.currency::text,
            'method','PROVIDER','receivedOn',to_char(today,'YYYY-MM-DD')),'SUCCEEDED',request,correlation);
      INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
        VALUES(a.organization_id,a.school_id,'billing.invoice.payment_recorded',1,'INVOICE',inv.id,inv.version,correlation,request,
          jsonb_build_object('invoiceId',inv.id,'paymentId',rec.id,'method','PROVIDER','status','PAID'));
    END LOOP;
  END IF;
  PERFORM hon.school_pay_charge_record(actor,a,'CHARGE_'||outcome,prior,source,request,correlation);
  RETURN a;
END $$;

-- P2/P3: the staff command that records the processor's answer for an open attempt (after a charge call or a lookup).
CREATE FUNCTION hon.finish_school_pay_charge(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; a hon.school_pay_charge_attempts%ROWTYPE; result jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','outcome','amountMinor','currency'],
      ARRAY['expectedVersion','outcome','amountMinor','currency','chargeRef','failureClass']) OR NOT hon.school_pay_charge_outcome_ok(p - 'expectedVersion') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.charge.finish','attemptId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_autopay_begin(subject,'school_pay.autopay.manage',key,fp);
  actor:=hon.require_school_pay_autopay_actor(subject,'school_pay.autopay.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  a:=hon.school_pay_lock_charge(selected,(p->>'expectedVersion')::integer);
  a:=hon.school_pay_charge_settle(a,p - 'expectedVersion',actor,'HUMAN_UI',request,correlation);
  result:=jsonb_build_object('attempt',hon.school_pay_charge_json(a));
  RETURN hon.school_pay_autopay_complete(subject,'school_pay.autopay.manage',key,actor,result);
END $$;

COMMENT ON TABLE hon.school_pay_charge_attempts IS
'0337 one charge attempt per prepared autopay cycle at the school''s own processor (test mode): PENDING, PROCESSING, SUCCEEDED, FAILED or UNKNOWN. At most one non-failed attempt per cycle. Private.';
COMMENT ON TABLE hon.school_pay_charge_events IS
'0337 append-only history of every charge attempt change. Private.';
COMMENT ON FUNCTION hon.read_school_pay_autopay_charges(text,uuid) IS
'Direct HUMAN_UI read of one payer''s latest autopay charge attempts, without provider references. No DML.';
COMMENT ON FUNCTION hon.read_school_pay_charge_attempt(text,uuid) IS
'Direct HUMAN_UI manage-only read of one charge attempt with the provider references the API needs; never forwarded to a browser. No DML.';
COMMENT ON FUNCTION hon.begin_school_pay_charge(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI start of one charge attempt for a prepared autopay cycle (PENDING). Sends nothing.';
COMMENT ON FUNCTION hon.finish_school_pay_charge(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI record of the processor''s answer for an open charge attempt; SUCCEEDED records PROVIDER payments and marks the cycle invoices PAID.';

DO $$ DECLARE r text; col text; t text;
  private_fns text:='hon.guard_school_pay_charge_attempt(),hon.school_pay_invoice_charge_open(uuid),hon.guard_school_pay_charge_payment_record(),
    hon.guard_school_pay_charge_invoice(),hon.school_pay_charge_json(hon.school_pay_charge_attempts),
    hon.school_pay_charge_record(uuid,hon.school_pay_charge_attempts,text,jsonb,text,uuid,uuid),hon.school_pay_lock_charge(uuid,integer),
    hon.school_pay_charge_outcome_ok(jsonb),hon.school_pay_charge_settle(hon.school_pay_charge_attempts,jsonb,uuid,text,uuid,uuid)';
  entry_fns text:='hon.read_school_pay_autopay_charges(text,uuid),hon.read_school_pay_charge_attempt(text,uuid),
    hon.begin_school_pay_charge(text,uuid,jsonb,text,uuid,uuid),hon.finish_school_pay_charge(text,uuid,jsonb,text,uuid,uuid)';
  tables text[]:=ARRAY['school_pay_charge_attempts','school_pay_charge_events'];
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
    FOREACH t IN ARRAY ARRAY['hon.school_pay_charge_attempts','hon.school_pay_charge_events','hon.invoice_payment_records'] LOOP
      IF has_table_privilege('hon_runtime',t,'SELECT') OR has_any_column_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
        OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
        RAISE EXCEPTION 'School autopay charges must not widen runtime privileges';
      END IF;
    END LOOP;
  END IF;
END $$;
COMMIT;
