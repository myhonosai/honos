BEGIN;

-- Parent invoice payment (0530, coordinator ledger 2026-11-18): a signed-in guardian pays the open balance of one of
-- their family's ISSUED invoices from the HON Family app on the school's own processor, through the shared one-time
-- payment (0529). TEST/SANDBOX mode only (0258 already refuses LIVE connections). HON adds no fee. Owner decision: David,
-- 2026-11-18 21:05Z, "Pay invoices via school's Stripe/Square"; live money needs a separate owner approval.
--   P1  Who and how much come only from the database. The parent scope is the 0102 billing path: one live family
--       (resolve_parent_journey_scopes), a GUARDIAN grant (never VIEWER), the invoice's membership participant a
--       current-family STUDENT and its billing account's responsible person a current-family GUARDIAN billing contact.
--       The amount is the invoice's open balance (total minus unvoided records), read under the invoice lock.
--   P2  A caller never names a payment. The API gets a payment id only from these functions for an invoice the parent
--       may act on (the 0529 caller rule); a foreign invoice, school or organization is refused before any payment read.
--   P3  The invoice is paid in the database, whatever path records the processor's SUCCEEDED (the parent's confirm, the
--       reconcile sweep): a trigger on the payment writes one PROVIDER invoice payment record and moves the invoice to
--       PAID. If the invoice can no longer take it, nothing is guessed: the success is kept and flagged for staff review.
--   P4  No double collection: while a family payment may still be paid (PROCESSING, or OPEN before its processor
--       session's end), the invoice takes no manual payment, no other status than PAID, and no autopay charge; an open
--       autopay charge (0337) blocks opening one.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Parent invoice payment requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Parent invoice payment requires a restricted runtime';
  END IF;
  IF to_regclass('hon.school_pay_once') IS NULL OR to_regprocedure('hon.school_pay_invoice_charge_open(uuid)') IS NULL
    OR to_regprocedure('hon.resolve_parent_journey_scopes(text)') IS NULL OR to_regclass('hon.invoice_payment_records') IS NULL
    OR to_regprocedure('hon.school_pay_school_zone()') IS NULL THEN
    RAISE EXCEPTION 'Parent invoice payment requires 0102, 0240, 0322, 0337 and 0529';
  END IF;
END $$;

-- Code-owned recorder of invoice payments taken through the app. No user, role, HQ, family or delegated authority.
INSERT INTO hon.principals(id,principal_type,display_name)
  VALUES('00000000-0000-4000-8000-000000000530','SYSTEM_SERVICE','Code-owned parent invoice payment recorder');

-- P1: the family invoice is a new caller of the shared one-time payment.
DO $$ DECLARE c text; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='hon.school_pay_once'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%CHECKOUT_PAGE%' LOOP
    EXECUTE format('ALTER TABLE hon.school_pay_once DROP CONSTRAINT %I',c);
  END LOOP;
END $$;
ALTER TABLE hon.school_pay_once ADD CONSTRAINT school_pay_once_source_check
  CHECK (source IN ('CHECKOUT_PAGE','WALKIN_VISIT','POS_SALE','FAMILY_INVOICE'));

-- The 0529 opener, with FAMILY_INVOICE added to its source list; nothing else changes.
CREATE OR REPLACE FUNCTION hon.school_pay_once_open(organization uuid,school uuid,source text,source_id uuid,amount_minor bigint,currency text,
  label jsonb,payer jsonb,expires_at timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE conn uuid; provider text; x hon.school_pay_once%ROWTYPE; name text; email text;
BEGIN
  IF jsonb_typeof(label) IS DISTINCT FROM 'object' OR jsonb_typeof(payer) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF organization IS NULL OR school IS NULL OR source_id IS NULL OR source IS NULL OR source NOT IN ('CHECKOUT_PAGE','WALKIN_VISIT','POS_SALE','FAMILY_INVOICE')
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

-- P4: whether a family payment for this invoice may still be paid: PROCESSING, or OPEN before its processor session
-- (or, never started, the payment itself) ends. A stale OPEN past both expiries can no longer be paid and holds nothing.
CREATE FUNCTION hon.parent_invoice_pay_open(invoice uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.school_pay_once p WHERE p.source='FAMILY_INVOICE' AND p.source_id=invoice
    AND (p.state='PROCESSING' OR (p.state='OPEN' AND greatest(p.expires_at,coalesce(p.provider_expires_at,p.expires_at))>clock_timestamp())))
$$;

-- P4, whoever writes: no manual payment record while a family payment is open (PROVIDER records come only from a
-- settled processor answer).
CREATE FUNCTION hon.guard_parent_invoice_pay_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.method<>'PROVIDER' AND hon.parent_invoice_pay_open(NEW.invoice_id) THEN
    RAISE EXCEPTION 'PARENT_INVOICE_PAY_IN_PROGRESS' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER parent_invoice_pay_record_guard BEFORE INSERT ON hon.invoice_payment_records
  FOR EACH ROW EXECUTE FUNCTION hon.guard_parent_invoice_pay_record();

-- P4, whoever writes: while a family payment is open, an invoice only moves to PAID.
CREATE FUNCTION hon.guard_parent_invoice_pay_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'PAID' AND hon.parent_invoice_pay_open(OLD.id) THEN
    RAISE EXCEPTION 'PARENT_INVOICE_PAY_IN_PROGRESS' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER parent_invoice_pay_invoice_guard BEFORE UPDATE ON hon.invoices
  FOR EACH ROW EXECUTE FUNCTION hon.guard_parent_invoice_pay_invoice();

-- P4, whoever writes: no autopay charge attempt (0337) for a cycle with an invoice whose family payment is open.
CREATE FUNCTION hon.guard_parent_invoice_pay_charge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM hon.school_pay_autopay_cycle_lines l WHERE l.cycle_id=NEW.cycle_id AND hon.parent_invoice_pay_open(l.invoice_id)) THEN
    RAISE EXCEPTION 'PARENT_INVOICE_PAY_IN_PROGRESS' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER parent_invoice_pay_charge_guard BEFORE INSERT ON hon.school_pay_charge_attempts
  FOR EACH ROW EXECUTE FUNCTION hon.guard_parent_invoice_pay_charge();

-- P1: the live guardian billing scope (as 0102): exactly one current family and a GUARDIAN grant.
CREATE FUNCTION hon.parent_invoice_pay_scope(subject text) RETURNS TABLE(organization_id uuid,school_id uuid,family_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; s record;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject THEN
    RAISE EXCEPTION 'PARENT_INVOICE_PAY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO n FROM hon.resolve_parent_journey_scopes(subject);
  IF n<>1 THEN RAISE EXCEPTION 'PARENT_INVOICE_PAY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO s FROM hon.resolve_parent_journey_scopes(subject);
  IF s.access_level NOT IN ('PRIMARY_GUARDIAN'::hon.family_access_level,'SECONDARY_GUARDIAN'::hon.family_access_level) THEN
    RAISE EXCEPTION 'PARENT_INVOICE_PAY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT s.organization_id,s.school_id,s.family_id;
END $$;

-- P1: the family's invoices on the 0102 path (participant a current-family STUDENT, payer a current-family GUARDIAN
-- billing contact), with the child's display name.
CREATE FUNCTION hon.parent_invoice_pay_invoices(org uuid,school uuid,family uuid)
  RETURNS TABLE(invoice_id uuid,participant_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT invoice.id,concat_ws(' ',person.given_name,person.family_name)
  FROM hon.invoices invoice
  JOIN hon.memberships membership ON membership.id=invoice.membership_id AND membership.organization_id=invoice.organization_id
    AND membership.school_id=invoice.school_id AND membership.billing_account_id=invoice.billing_account_id
  JOIN hon.billing_accounts account ON account.id=membership.billing_account_id AND account.organization_id=membership.organization_id
    AND account.school_id=membership.school_id
  JOIN hon.family_members participant ON participant.person_id=membership.participant_person_id AND participant.organization_id=membership.organization_id
    AND participant.school_id=membership.school_id AND participant.family_id=family AND participant.member_role='STUDENT'::hon.family_member_role
  JOIN hon.people person ON person.id=participant.person_id AND person.organization_id=participant.organization_id AND person.school_id=participant.school_id
  JOIN hon.family_members payer ON payer.person_id=account.responsible_person_id AND payer.organization_id=account.organization_id
    AND payer.school_id=account.school_id AND payer.family_id=family AND payer.member_role='GUARDIAN'::hon.family_member_role AND payer.is_billing_contact
  WHERE invoice.organization_id=org AND invoice.school_id=school
$$;

-- Open balance of an invoice: total minus unvoided records (0240).
CREATE FUNCTION hon.parent_invoice_pay_balance(invoice uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT greatest(i.total_minor-coalesce((SELECT sum(r.amount_minor) FROM hon.invoice_payment_records r WHERE r.invoice_id=i.id AND r.voided_at IS NULL),0),0)
  FROM hon.invoices i WHERE i.id=invoice
$$;

-- The latest family payment of an invoice (any state), or NULL.
CREATE FUNCTION hon.parent_invoice_pay_latest(invoice uuid) RETURNS hon.school_pay_once
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT p FROM hon.school_pay_once p WHERE p.source='FAMILY_INVOICE' AND p.source_id=invoice ORDER BY p.created_at DESC,p.id DESC LIMIT 1
$$;

-- API: the family's invoices a parent may pay, with what the API needs to decide whether to offer card payment. The
-- provider code reaches the API only (it never goes on to the app). No DML.
CREATE FUNCTION hon.read_parent_invoice_payments(subject text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; items jsonb;
BEGIN
  SELECT * INTO s FROM hon.parent_invoice_pay_scope(subject);
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.due NULLS LAST,x.id),'[]'::jsonb) INTO items FROM (
    SELECT i.id,i.due_at AS due,jsonb_build_object('invoiceId',i.id,'participantName',f.participant_name,'status',i.status::text,
      'currency',i.currency::text,'totalMinor',i.total_minor,'balanceMinor',hon.parent_invoice_pay_balance(i.id),
      'dueAt',CASE WHEN i.due_at IS NULL THEN NULL ELSE hon.school_pay_instant(i.due_at) END,
      'payState',CASE WHEN l.id IS NULL THEN 'NONE' WHEN l.state='PROCESSING' THEN 'PROCESSING'
        WHEN l.state='OPEN' AND hon.parent_invoice_pay_open(i.id) THEN 'OPEN' WHEN l.state='SUCCEEDED' THEN 'SUCCEEDED' ELSE 'NONE' END,
      'autopayInProgress',hon.school_pay_invoice_charge_open(i.id)) AS item
    FROM hon.parent_invoice_pay_invoices(s.organization_id,s.school_id,s.family_id) f
    JOIN hon.invoices i ON i.id=f.invoice_id
    LEFT JOIN LATERAL (SELECT (hon.parent_invoice_pay_latest(i.id)).*) l ON true
    WHERE i.status='ISSUED'
    ORDER BY i.due_at NULLS LAST,i.id LIMIT 50) x;
  RETURN jsonb_build_object('providerCode',hon.school_pay_once_provider(s.organization_id,s.school_id),'invoices',items);
END $$;

-- API: the payment id of an invoice the parent may act on (its latest family payment), for confirm and cancel. NULL
-- when it has none. A foreign invoice is PARENT_INVOICE_PAY_NOT_FOUND before any payment is read. No DML.
CREATE FUNCTION hon.read_parent_invoice_payment(subject text,invoice uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; x hon.school_pay_once;
BEGIN
  IF invoice IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.parent_invoice_pay_scope(subject);
  IF NOT EXISTS(SELECT 1 FROM hon.parent_invoice_pay_invoices(s.organization_id,s.school_id,s.family_id) f WHERE f.invoice_id=invoice) THEN
    RAISE EXCEPTION 'PARENT_INVOICE_PAY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  x:=hon.parent_invoice_pay_latest(invoice);
  RETURN jsonb_build_object('paymentId',x.id,'state',x.state);
END $$;

-- API P1/P2: open (or get back) the family payment of exactly the invoice's open balance. Lock order matches the
-- processor answer path (payment -> invoice): the invoice's live payment, then the invoice, then the 0529 opener.
CREATE FUNCTION hon.open_parent_invoice_payment(subject text,invoice uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; i hon.invoices%ROWTYPE; balance bigint; payment uuid; label text;
BEGIN
  IF invoice IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM hon.parent_invoice_pay_scope(subject);
  IF NOT EXISTS(SELECT 1 FROM hon.parent_invoice_pay_invoices(s.organization_id,s.school_id,s.family_id) f WHERE f.invoice_id=invoice) THEN
    RAISE EXCEPTION 'PARENT_INVOICE_PAY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM hon.school_pay_once p WHERE p.source='FAMILY_INVOICE' AND p.source_id=invoice AND p.state IN ('OPEN','PROCESSING','SUCCEEDED') FOR UPDATE;
  SELECT * INTO i FROM hon.invoices k WHERE k.id=invoice AND k.organization_id=s.organization_id AND k.school_id=s.school_id FOR UPDATE;
  -- The scope is read again after the locks, so a grant that ended meanwhile cannot open a payment.
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM hon.parent_invoice_pay_scope(subject) t
      WHERE (t.organization_id,t.school_id,t.family_id)=(s.organization_id,s.school_id,s.family_id))
    OR NOT EXISTS(SELECT 1 FROM hon.parent_invoice_pay_invoices(s.organization_id,s.school_id,s.family_id) f WHERE f.invoice_id=invoice) THEN
    RAISE EXCEPTION 'PARENT_INVOICE_PAY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  balance:=hon.parent_invoice_pay_balance(i.id);
  IF i.status<>'ISSUED' OR balance<1 THEN RAISE EXCEPTION 'PARENT_INVOICE_PAY_NOT_PAYABLE' USING ERRCODE='40001'; END IF;
  IF hon.school_pay_invoice_charge_open(i.id) THEN RAISE EXCEPTION 'PARENT_INVOICE_PAY_AUTOPAY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  label:=CASE WHEN i.due_at IS NULL THEN 'Tuition invoice'
    ELSE 'Tuition invoice due '||to_char((i.due_at AT TIME ZONE coalesce((SELECT z.name FROM hon.schools k JOIN pg_timezone_names z ON z.name=k.timezone
      WHERE k.id=i.school_id),'UTC'))::date,'YYYY-MM-DD') END;
  payment:=hon.school_pay_once_open(i.organization_id,i.school_id,'FAMILY_INVOICE',i.id,balance,i.currency::text,
    jsonb_build_object('name',label),'{}'::jsonb,clock_timestamp()+interval '30 minutes');
  RETURN jsonb_build_object('paymentId',payment,'amountMinor',balance,'currency',i.currency::text);
END $$;

-- P3: the processor's SUCCEEDED for a family invoice payment pays the invoice in the same transaction, whoever recorded
-- it. An invoice that can no longer take it (not ISSUED, or a different balance) is not changed: the success stays on
-- the payment and an audit row and outbox event ask staff to review it. Nothing is ever guessed or refunded here.
CREATE FUNCTION hon.settle_parent_invoice_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE svc constant uuid:='00000000-0000-4000-8000-000000000530'; request uuid:=gen_random_uuid(); i hon.invoices%ROWTYPE;
  rec hon.invoice_payment_records%ROWTYPE; tz text; today date;
BEGIN
  SELECT * INTO i FROM hon.invoices k WHERE k.id=NEW.source_id AND k.organization_id=NEW.organization_id AND k.school_id=NEW.school_id FOR UPDATE;
  IF NOT FOUND OR i.status<>'ISSUED' OR i.currency::text<>NEW.currency::text OR hon.parent_invoice_pay_balance(i.id)<>NEW.amount_minor THEN
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(NEW.organization_id,NEW.school_id,svc,'SYSTEM_SERVICE','parent_invoice_pay.review_needed','SCHOOL_PAY_ONCE',NEW.id,NULL,
        jsonb_build_object('paymentId',NEW.id,'invoiceId',NEW.source_id,'amountMinor',NEW.amount_minor,'currency',NEW.currency::text),'SUCCEEDED',request,NEW.id);
    INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(NEW.organization_id,NEW.school_id,'parent_invoice_pay.review_needed',1,'SCHOOL_PAY_ONCE',NEW.id,NEW.version,NEW.id,request,
        jsonb_build_object('paymentId',NEW.id,'invoiceId',NEW.source_id));
    RETURN NULL;
  END IF;
  SELECT z.name INTO tz FROM hon.schools k JOIN pg_timezone_names z ON z.name=k.timezone WHERE k.id=i.school_id AND k.organization_id=i.organization_id;
  today:=(clock_timestamp() AT TIME ZONE coalesce(tz,'UTC'))::date;
  INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,reference,note,actor_principal_id)
    VALUES(i.organization_id,i.school_id,i.id,NEW.amount_minor::integer,i.currency,today,'PROVIDER',NEW.provider_payment_ref,NULL,svc) RETURNING * INTO rec;
  UPDATE hon.invoices SET version=version+1,status='PAID'::hon.invoice_status WHERE id=i.id RETURNING * INTO i;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(i.organization_id,i.school_id,svc,'SYSTEM_SERVICE','parent_invoice_pay.invoice_paid','INVOICE',i.id,NULL,
      jsonb_build_object('invoiceId',i.id,'onceId',NEW.id,'paymentId',rec.id,'status','PAID','amountMinor',rec.amount_minor,'currency',rec.currency::text,
        'method','PROVIDER','receivedOn',to_char(today,'YYYY-MM-DD')),'SUCCEEDED',request,NEW.id);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(i.organization_id,i.school_id,'billing.invoice.payment_recorded',1,'INVOICE',i.id,i.version,NEW.id,request,
      jsonb_build_object('invoiceId',i.id,'paymentId',rec.id,'method','PROVIDER','status','PAID'));
  RETURN NULL;
END $$;
CREATE TRIGGER parent_invoice_pay_settle AFTER UPDATE ON hon.school_pay_once
  FOR EACH ROW WHEN (NEW.source='FAMILY_INVOICE' AND NEW.state='SUCCEEDED' AND OLD.state<>'SUCCEEDED')
  EXECUTE FUNCTION hon.settle_parent_invoice_payment();

COMMENT ON FUNCTION hon.read_parent_invoice_payments(text) IS
'0530 API-only: the signed-in guardian''s ISSUED family invoices with balance and family payment state, plus the school''s one-time processor (API only). No DML.';
COMMENT ON FUNCTION hon.read_parent_invoice_payment(text,uuid) IS
'0530 API-only: the latest family payment id of an invoice the guardian may act on (for confirm and cancel). No DML.';
COMMENT ON FUNCTION hon.open_parent_invoice_payment(text,uuid) IS
'0530 API-only: open or get back the family one-time payment of an invoice''s open balance, test mode only.';
COMMENT ON FUNCTION hon.settle_parent_invoice_payment() IS
'0530 trigger: a SUCCEEDED family invoice payment records one PROVIDER payment and marks the invoice PAID, or flags it for staff review.';

DO $$ DECLARE r text;
  private_fns text:='hon.parent_invoice_pay_open(uuid),hon.guard_parent_invoice_pay_record(),hon.guard_parent_invoice_pay_invoice(),
    hon.guard_parent_invoice_pay_charge(),hon.parent_invoice_pay_scope(text),hon.parent_invoice_pay_invoices(uuid,uuid,uuid),
    hon.parent_invoice_pay_balance(uuid),hon.parent_invoice_pay_latest(uuid),hon.settle_parent_invoice_payment(),
    hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)';
  entry_fns text:='hon.read_parent_invoice_payments(text),hon.read_parent_invoice_payment(text,uuid),hon.open_parent_invoice_payment(text,uuid)';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM PUBLIC',private_fns,entry_fns);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM %I',private_fns,entry_fns,r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',entry_fns);
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    IF has_function_privilege('hon_runtime','hon.school_pay_once_open(uuid,uuid,text,uuid,bigint,text,jsonb,jsonb,timestamptz)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.parent_invoice_pay_scope(text)','EXECUTE')
      OR has_table_privilege('hon_runtime','hon.school_pay_once','SELECT') OR has_table_privilege('hon_runtime','hon.invoice_payment_records','INSERT') THEN
      RAISE EXCEPTION 'Parent invoice payment must not widen runtime privileges';
    END IF;
  END IF;
END $$;
COMMIT;
