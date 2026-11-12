BEGIN;

-- B-TUI-1 record tuition payments received outside HON (0240, assigned by the coordinator 2026-11-09 under the
-- owner's delegation). Recommended rules put to the owner the same day:
--   T1  An authorized staff member records a payment the school received outside HON (cash, check, card terminal,
--       bank transfer, other) against one ISSUED invoice of the current school. HON moves no money: the record is
--       evidence only. New sensitive, staff-assignable permission billing.invoice.payment.record, initially granted to
--       system OWNER roles only.
--   T2  Partial payments are allowed. An invoice becomes PAID when its unvoided recorded payments reach its total; a
--       record above the remaining balance is refused (no overpayment, no credit).
--   T3  A payment recorded by mistake is voided with a reason, never deleted. Voiding a payment of a PAID invoice that
--       is then no longer covered returns the invoice to ISSUED. A void is not a refund.
--   T4  Staff with the record, issue or create invoice permission see the school's unpaid balances: issued invoices with
--       what is paid, what remains and whether the due time has passed.
-- Invoice status is now tied to the records: a trigger refuses any change into or out of PAID that the unvoided records
-- do not justify, and any change of amount, currency or payer of an invoice that has recorded payments, whoever writes.
-- The runtime gains no table privilege: every write goes through a direct-human SECURITY DEFINER command with live
-- school-scoped permission re-checks, exact-request idempotency, audit and an inert outbox event.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Tuition payment records require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Tuition payment records require a restricted runtime';
  END IF;
  IF to_regclass('hon.invoices') IS NULL OR to_regclass('hon.membership_refund_records') IS NULL
    OR to_regprocedure('hon.membership_school_today()') IS NULL OR to_regprocedure('hon.membership_pause_date(jsonb)') IS NULL
    OR to_regprocedure('hon.membership_pause_text_ok(jsonb,boolean)') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'Tuition payment records require 0002, 0049, 0077, 0177 and 0224';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='hon.invoices'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Tuition payment records expect no existing trigger on hon.invoices';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('billing.invoice.payment.record','Record or void a tuition payment the school received outside HON against an issued invoice (evidence only, no money movement)',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='billing.invoice.payment.record' AND is_sensitive AND is_staff_assignable) THEN
    RAISE EXCEPTION 'billing.invoice.payment.record already exists with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,'billing.invoice.payment.record' FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- T1/T3: one row per recorded payment. Immutable except a single void.
CREATE TABLE hon.invoice_payment_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  received_on date NOT NULL CHECK (received_on >= DATE '2000-01-01'),
  method text NOT NULL CHECK (method IN ('CASH','CHECK','CARD_TERMINAL','BANK_TRANSFER','OTHER')),
  reference text CHECK (reference IS NULL OR (length(reference) BETWEEN 1 AND 120 AND btrim(reference)=reference AND reference !~ '[\x01-\x1f\x7f]')),
  note text CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 1000 AND btrim(note)=note AND note !~ '[\x01-\x1f\x7f]')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_at timestamptz,
  voided_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  void_reason text CHECK (void_reason IS NULL OR (length(void_reason) BETWEEN 1 AND 1000 AND btrim(void_reason)=void_reason AND void_reason !~ '[\x01-\x1f\x7f]')),
  CHECK ((voided_at IS NULL)=(voided_by_principal_id IS NULL) AND (voided_at IS NULL)=(void_reason IS NULL)),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(invoice_id,organization_id,school_id) REFERENCES hon.invoices(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX invoice_payment_records_invoice_idx ON hon.invoice_payment_records(invoice_id,recorded_at);
ALTER TABLE hon.invoice_payment_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.invoice_payment_records FORCE ROW LEVEL SECURITY;
CREATE TRIGGER invoice_payment_records_no_truncate BEFORE TRUNCATE ON hon.invoice_payment_records
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- A record is written unvoided; afterwards only the three void columns may be set, exactly once. Never deleted.
CREATE FUNCTION hon.guard_invoice_payment_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INVOICE_PAYMENT_RECORD_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.voided_at IS NOT NULL THEN RAISE EXCEPTION 'INVOICE_PAYMENT_RECORD_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
    OR (to_jsonb(NEW)-ARRAY['voided_at','voided_by_principal_id','void_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['voided_at','voided_by_principal_id','void_reason']) THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_RECORD_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_payment_record_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.invoice_payment_records
  FOR EACH ROW EXECUTE FUNCTION hon.guard_invoice_payment_record();

-- T2/T3: invoice status follows the unvoided records, whoever writes the invoice row.
CREATE FUNCTION hon.guard_invoice_payment_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE paid bigint; recorded boolean;
BEGIN
  SELECT coalesce(sum(x.amount_minor) FILTER (WHERE x.voided_at IS NULL),0),count(*)>0 INTO paid,recorded
    FROM hon.invoice_payment_records x WHERE x.invoice_id=OLD.id;
  IF NEW.status='PAID' AND OLD.status<>'PAID' AND (OLD.status<>'ISSUED' OR paid<NEW.total_minor) THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_STATUS_GUARD' USING ERRCODE='55000'; END IF;
  IF OLD.status='PAID' AND NEW.status<>'PAID' AND (NEW.status<>'ISSUED' OR paid>=NEW.total_minor) THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_STATUS_GUARD' USING ERRCODE='55000'; END IF;
  IF recorded AND (NEW.id,NEW.organization_id,NEW.school_id,NEW.billing_account_id,NEW.membership_id,NEW.currency,NEW.subtotal_minor,NEW.discount_minor,NEW.total_minor)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.billing_account_id,OLD.membership_id,OLD.currency,OLD.subtotal_minor,OLD.discount_minor,OLD.total_minor) THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_STATUS_GUARD' USING ERRCODE='55000'; END IF;
  IF paid>0 AND NEW.status NOT IN ('ISSUED','PAID') THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_STATUS_GUARD' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_payment_status_guard BEFORE UPDATE ON hon.invoices
  FOR EACH ROW EXECUTE FUNCTION hon.guard_invoice_payment_status();

-- Live direct-human tuition authority at the current school, or a refusal. The identity rules are the 0224 ones.
CREATE FUNCTION hon.require_tuition_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  denial text:=CASE WHEN permission='billing.invoice.payment.record' THEN 'INVOICE_PAYMENT_RECORD_FORBIDDEN' ELSE 'TUITION_RECEIVABLES_FORBIDDEN' END;
BEGIN
  IF permission IS NULL OR permission NOT IN ('billing.invoice.payment.record','billing.invoice.issue','billing.invoice.create')
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
CREATE FUNCTION hon.require_tuition_reader(subject text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE permission text;
BEGIN
  FOREACH permission IN ARRAY ARRAY['billing.invoice.payment.record','billing.invoice.issue','billing.invoice.create'] LOOP
    BEGIN PERFORM hon.require_tuition_actor(subject,permission); RETURN permission;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  RAISE EXCEPTION 'TUITION_RECEIVABLES_FORBIDDEN' USING ERRCODE='42501';
END $$;

CREATE FUNCTION hon.invoice_payment_json(x hon.invoice_payment_records) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('paymentId',x.id,'invoiceId',x.invoice_id,'amountMinor',x.amount_minor,'currency',x.currency::text,
    'receivedOn',to_char(x.received_on,'YYYY-MM-DD'),'method',x.method,'reference',x.reference,'note',x.note,
    'recordedAt',to_char(x.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'void',CASE WHEN x.voided_at IS NULL THEN NULL ELSE jsonb_build_object('voidedAt',to_char(x.voided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reason',x.void_reason) END)
$$;

-- One invoice's balance view: amounts, status, version, due time and whether it has passed.
CREATE FUNCTION hon.invoice_balance_json(i hon.invoices) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('invoiceId',i.id,'billingAccountId',i.billing_account_id,'membershipId',i.membership_id,
    'payerName',(SELECT left(btrim(pp.given_name||' '||pp.family_name),200) FROM hon.billing_accounts b JOIN hon.people pp ON pp.id=b.responsible_person_id
      WHERE b.id=i.billing_account_id AND b.organization_id=i.organization_id AND b.school_id=i.school_id),
    'status',i.status::text,'version',i.version,'currency',i.currency::text,'totalMinor',i.total_minor,'paidMinor',paid.minor,
    'balanceMinor',CASE WHEN i.status='PAID' THEN 0 ELSE greatest(i.total_minor-paid.minor,0) END,
    'dueAt',CASE WHEN i.due_at IS NULL THEN NULL ELSE to_char(i.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'overdue',i.status='ISSUED' AND i.due_at IS NOT NULL AND i.due_at<clock_timestamp() AND i.total_minor>paid.minor)
  FROM (SELECT coalesce(sum(x.amount_minor),0)::bigint minor FROM hon.invoice_payment_records x WHERE x.invoice_id=i.id AND x.voided_at IS NULL) paid
$$;

-- Shared idempotency: reserve the key, take the IAM SHARE locks, re-check live authority, and return the stored
-- response on an exact replay (after one more authority check). NULL means: proceed with the write.
CREATE FUNCTION hon.tuition_command_begin(subject text,key text,fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  actor:=hon.require_tuition_actor(subject,'billing.invoice.payment.record');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_tuition_actor(subject,'billing.invoice.payment.record') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_RECORD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  -- A stored receipt is never returned after a live access loss.
  IF hon.require_tuition_actor(subject,'billing.invoice.payment.record') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_RECORD_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN prior.response_body;
END $$;

CREATE FUNCTION hon.tuition_command_finish(subject text,key text,actor uuid,result jsonb,action text,record uuid,
  prior_state jsonb,next_state jsonb,event text,invoice uuid,invoice_version integer,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,'INVOICE_PAYMENT_RECORD',record,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event,1,'INVOICE',invoice,invoice_version,correlation,request,next_state);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_tuition_actor(subject,'billing.invoice.payment.record') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'INVOICE_PAYMENT_RECORD_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

-- T1/T2: record one payment received outside HON against one ISSUED current-school invoice.
-- Canonical order: key reservation; IAM SHARE; invoices ROW EXCLUSIVE + the invoice row FOR UPDATE (serializes every
-- record and void of one invoice); then the record, the invoice version/status, audit and outbox.
CREATE FUNCTION hon.record_invoice_payment(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  i hon.invoices%ROWTYPE; rec hon.invoice_payment_records%ROWTYPE; received_on date; paid bigint; result jsonb; prior jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR NOT p ?& ARRAY['expectedInvoiceVersion','amountMinor','currency','receivedOn','method']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedInvoiceVersion','amountMinor','currency','receivedOn','method','reference','note'))
    OR jsonb_typeof(p->'expectedInvoiceVersion') IS DISTINCT FROM 'number' OR (p->'expectedInvoiceVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'amountMinor') IS DISTINCT FROM 'number' OR (p->'amountMinor')::text !~ '^[1-9][0-9]{0,8}$' OR (p->>'amountMinor')::bigint>100000000
    OR jsonb_typeof(p->'currency') IS DISTINCT FROM 'string' OR p->>'currency' !~ '^[A-Z]{3}$'
    OR jsonb_typeof(p->'method') IS DISTINCT FROM 'string' OR p->>'method' NOT IN ('CASH','CHECK','CARD_TERMINAL','BANK_TRANSFER','OTHER')
    OR (p ? 'reference' AND (NOT hon.membership_pause_text_ok(p->'reference',true) OR length(p->>'reference')>120))
    OR (p ? 'note' AND NOT hon.membership_pause_text_ok(p->'note',true)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  received_on:=hon.membership_pause_date(p->'receivedOn');
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','billing.invoice.payment.record','invoiceId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.tuition_command_begin(subject,key,fp);
  actor:=hon.require_tuition_actor(subject,'billing.invoice.payment.record');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  LOCK TABLE hon.invoices IN ROW EXCLUSIVE MODE;
  SELECT * INTO i FROM hon.invoices x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF i.version<>(p->>'expectedInvoiceVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF i.status<>'ISSUED' THEN RAISE EXCEPTION 'INVOICE_NOT_PAYABLE' USING ERRCODE='40001'; END IF;
  IF i.currency::text<>p->>'currency' THEN RAISE EXCEPTION 'INVOICE_CURRENCY_MISMATCH' USING ERRCODE='22023'; END IF;
  IF received_on>hon.membership_school_today() THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT coalesce(sum(x.amount_minor),0) INTO paid FROM hon.invoice_payment_records x WHERE x.invoice_id=i.id AND x.voided_at IS NULL;
  IF paid+(p->>'amountMinor')::bigint>i.total_minor THEN RAISE EXCEPTION 'INVOICE_PAYMENT_EXCEEDS_BALANCE' USING ERRCODE='22023'; END IF;
  prior:=hon.invoice_balance_json(i);
  INSERT INTO hon.invoice_payment_records(organization_id,school_id,invoice_id,amount_minor,currency,received_on,method,reference,note,actor_principal_id)
    VALUES(org,school,i.id,(p->>'amountMinor')::integer,p->>'currency',received_on,p->>'method',p->>'reference',p->>'note',actor) RETURNING * INTO rec;
  UPDATE hon.invoices SET version=version+1,
      status=CASE WHEN paid+rec.amount_minor>=total_minor THEN 'PAID'::hon.invoice_status ELSE status END
    WHERE id=i.id RETURNING * INTO i;
  result:=jsonb_build_object('payment',hon.invoice_payment_json(rec),'invoice',hon.invoice_balance_json(i));
  PERFORM hon.tuition_command_finish(subject,key,actor,result,'billing.invoice.payment.record',rec.id,prior,result,
    'billing.invoice.payment_recorded',i.id,i.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- T3: void one recorded payment of a current-school invoice, with a reason.
CREATE FUNCTION hon.void_invoice_payment(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  i hon.invoices%ROWTYPE; rec hon.invoice_payment_records%ROWTYPE; target uuid; paid bigint; result jsonb; prior jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR NOT p ?& ARRAY['expectedInvoiceVersion','reason']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedInvoiceVersion','reason'))
    OR jsonb_typeof(p->'expectedInvoiceVersion') IS DISTINCT FROM 'number' OR (p->'expectedInvoiceVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.membership_pause_text_ok(p->'reason',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','billing.invoice.payment.void','paymentId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.tuition_command_begin(subject,key,fp);
  actor:=hon.require_tuition_actor(subject,'billing.invoice.payment.record');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  SELECT x.invoice_id INTO target FROM hon.invoice_payment_records x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF target IS NULL THEN RAISE EXCEPTION 'INVOICE_PAYMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  LOCK TABLE hon.invoices IN ROW EXCLUSIVE MODE;
  SELECT * INTO i FROM hon.invoices x WHERE x.id=target AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_PAYMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF i.version<>(p->>'expectedInvoiceVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF i.status NOT IN ('ISSUED','PAID') THEN RAISE EXCEPTION 'INVOICE_NOT_PAYABLE' USING ERRCODE='40001'; END IF;
  SELECT * INTO rec FROM hon.invoice_payment_records x WHERE x.id=selected AND x.invoice_id=i.id;
  IF rec.voided_at IS NOT NULL THEN RAISE EXCEPTION 'INVOICE_PAYMENT_ALREADY_VOIDED' USING ERRCODE='40001'; END IF;
  prior:=hon.invoice_balance_json(i);
  UPDATE hon.invoice_payment_records SET voided_at=clock_timestamp(),voided_by_principal_id=actor,void_reason=p->>'reason'
    WHERE id=rec.id RETURNING * INTO rec;
  SELECT coalesce(sum(x.amount_minor),0) INTO paid FROM hon.invoice_payment_records x WHERE x.invoice_id=i.id AND x.voided_at IS NULL;
  UPDATE hon.invoices SET version=version+1,
      status=CASE WHEN status='PAID' AND paid<total_minor THEN 'ISSUED'::hon.invoice_status ELSE status END
    WHERE id=i.id RETURNING * INTO i;
  result:=jsonb_build_object('payment',hon.invoice_payment_json(rec),'invoice',hon.invoice_balance_json(i));
  PERFORM hon.tuition_command_finish(subject,key,actor,result,'billing.invoice.payment.void',rec.id,prior,result,
    'billing.invoice.payment_voided',i.id,i.version,request,correlation);
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- Read: one current-school invoice's balance and its recorded payments (newest first, at most 100).
CREATE FUNCTION hon.read_invoice_payments(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; i hon.invoices%ROWTYPE; result jsonb;
BEGIN
  used:=hon.require_tuition_reader(subject); actor:=hon.require_tuition_actor(subject,used);
  IF selected IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO i FROM hon.invoices x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND OR i.status='DRAFT' THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'canRecord',used='billing.invoice.payment.record','invoice',hon.invoice_balance_json(i),
    'payments',coalesce((SELECT jsonb_agg(hon.invoice_payment_json(x) ORDER BY x.recorded_at DESC,x.id)
      FROM (SELECT * FROM hon.invoice_payment_records y WHERE y.invoice_id=i.id AND y.organization_id=org AND y.school_id=school ORDER BY y.recorded_at DESC,y.id LIMIT 100) x),'[]'::jsonb));
  IF hon.require_tuition_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'TUITION_RECEIVABLES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- T4 read: the current school's unpaid balances. filter OPEN (every issued invoice with a balance) or OVERDUE (due time
-- passed); 50 per page by invoice id after an optional cursor; per-currency totals cover every matching invoice.
CREATE FUNCTION hon.read_school_receivables(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; filter text; after uuid; page jsonb; more boolean; totals jsonb; result jsonb;
BEGIN
  used:=hon.require_tuition_reader(subject); actor:=hon.require_tuition_actor(subject,used);
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ? 'filter' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('filter','after'))
    OR jsonb_typeof(p->'filter') IS DISTINCT FROM 'string' OR p->>'filter' NOT IN ('OPEN','OVERDUE')
    OR (p ? 'after' AND (jsonb_typeof(p->'after') IS DISTINCT FROM 'string' OR p->>'after' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  filter:=p->>'filter'; after:=nullif(p->>'after','')::uuid;
  WITH open_invoices AS (
    SELECT i.*,(SELECT coalesce(sum(x.amount_minor),0)::bigint FROM hon.invoice_payment_records x WHERE x.invoice_id=i.id AND x.voided_at IS NULL) paid
    FROM hon.invoices i WHERE i.organization_id=org AND i.school_id=school AND i.status='ISSUED'),
  matching AS (SELECT * FROM open_invoices o WHERE o.total_minor>o.paid
    AND (filter='OPEN' OR (o.due_at IS NOT NULL AND o.due_at<clock_timestamp())))
  SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('currency',t.currency,'count',t.n,'balanceMinor',t.balance) ORDER BY t.currency)
      FROM (SELECT m.currency::text currency,count(*) n,sum(m.total_minor-m.paid) balance FROM matching m GROUP BY m.currency) t),'[]'::jsonb)
  INTO totals;
  SELECT coalesce(jsonb_agg(hon.invoice_balance_json(i) ORDER BY i.id),'[]'::jsonb),count(*)>50 INTO page,more FROM (
    SELECT i.* FROM hon.invoices i WHERE i.organization_id=org AND i.school_id=school AND i.status='ISSUED' AND (after IS NULL OR i.id>after)
      AND i.total_minor>(SELECT coalesce(sum(x.amount_minor),0) FROM hon.invoice_payment_records x WHERE x.invoice_id=i.id AND x.voided_at IS NULL)
      AND (filter='OPEN' OR (i.due_at IS NOT NULL AND i.due_at<clock_timestamp()))
    ORDER BY i.id LIMIT 51) i;
  IF more THEN page:=page-50; END IF;
  result:=jsonb_build_object('localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),'filter',filter,
    'canRecord',used='billing.invoice.payment.record','totals',totals,'items',page,
    'nextAfter',CASE WHEN more THEN page->49->>'invoiceId' ELSE NULL END);
  IF hon.require_tuition_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'TUITION_RECEIVABLES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON TABLE hon.invoice_payment_records IS
'0240 evidence of tuition payments the school received outside HON against issued invoices (T1-T3): immutable except one void with a reason. HON moves no money. Private.';
COMMENT ON FUNCTION hon.record_invoice_payment(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI record of one payment received outside HON against one ISSUED current-school invoice (B-TUI-1). Partial payments allowed, overpayment refused; the invoice becomes PAID when covered. No provider, ledger, communication, AI or automation effect.';
COMMENT ON FUNCTION hon.void_invoice_payment(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI void of one recorded tuition payment with a reason (B-TUI-1 T3); a PAID invoice no longer covered returns to ISSUED. Not a refund.';
COMMENT ON FUNCTION hon.read_invoice_payments(text,uuid) IS
'Direct HUMAN_UI read-only balance and recorded payments of one issued current-school invoice. No DML.';
COMMENT ON FUNCTION hon.read_school_receivables(text,jsonb) IS
'Direct HUMAN_UI read-only unpaid balances of the current school (B-TUI-1 T4): issued invoices with a balance, open or overdue. No DML.';

DO $$ DECLARE r text; col text; BEGIN
  REVOKE ALL ON TABLE hon.invoice_payment_records FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.guard_invoice_payment_record(),hon.guard_invoice_payment_status(),hon.require_tuition_actor(text,text),
    hon.require_tuition_reader(text),hon.invoice_payment_json(hon.invoice_payment_records),hon.invoice_balance_json(hon.invoices),
    hon.tuition_command_begin(text,text,text),hon.tuition_command_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,uuid,integer,uuid,uuid),
    hon.record_invoice_payment(text,uuid,jsonb,text,uuid,uuid),hon.void_invoice_payment(text,uuid,jsonb,text,uuid,uuid),
    hon.read_invoice_payments(text,uuid),hon.read_school_receivables(text,jsonb) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.invoice_payment_records FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_invoice_payment_record(),hon.guard_invoice_payment_status(),hon.require_tuition_actor(text,text),
      hon.require_tuition_reader(text),hon.invoice_payment_json(hon.invoice_payment_records),hon.invoice_balance_json(hon.invoices),
      hon.tuition_command_begin(text,text,text),hon.tuition_command_finish(text,text,uuid,jsonb,text,uuid,jsonb,jsonb,text,uuid,integer,uuid,uuid),
      hon.record_invoice_payment(text,uuid,jsonb,text,uuid,uuid),hon.void_invoice_payment(text,uuid,jsonb,text,uuid,uuid),
      hon.read_invoice_payments(text,uuid),hon.read_school_receivables(text,jsonb) FROM %I',r);
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid='hon.invoice_payment_records'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.invoice_payment_records FROM PUBLIC',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.invoice_payment_records FROM %I',col,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.record_invoice_payment(text,uuid,jsonb,text,uuid,uuid),hon.void_invoice_payment(text,uuid,jsonb,text,uuid,uuid),
      hon.read_invoice_payments(text,uuid),hon.read_school_receivables(text,jsonb) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime')
    AND (has_table_privilege('hon_runtime','hon.invoice_payment_records','SELECT') OR has_any_column_privilege('hon_runtime','hon.invoice_payment_records','SELECT')
      OR has_table_privilege('hon_runtime','hon.invoice_payment_records','INSERT') OR has_table_privilege('hon_runtime','hon.invoices','DELETE')) THEN
    RAISE EXCEPTION 'Tuition payment records must not widen runtime privileges';
  END IF;
END $$;
COMMIT;
