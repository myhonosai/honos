BEGIN;

-- Simple invoices (SI1, 0558, assigned by the coordinator 2026-11-19). Spec: docs/architecture/SIMPLE_INVOICES.md.
-- Owner feedback: the staff invoice form should be payer, pay-to, items with prices, a total, the way to pay, and print,
-- email or text. This adds:
--   * hon.invoice_line_items and hon.invoice_details: the items and the pay-to / how-to-pay / note text of an invoice,
--     written only by the command below while the invoice is a DRAFT, then never changed (demo data removal may delete
--     demo rows, the 0459 line). Forced RLS; the runtime has no privilege on either table.
--   * hon.create_simple_invoice: one direct human command that makes the DRAFT invoice with its items (total = their
--     sum) and, when asked and allowed, issues it. Same authority, idempotency, audit and outbox shapes as the existing
--     invoice commands (0002 create/issue, 0240 idempotency).
--   * hon.read_school_invoice_detail: one invoice of the current school for the printable view (0280 readers).
-- No money moves: nothing here charges, sends, calls a provider, changes a membership or runs an automation.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Simple invoices require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Simple invoices require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.require_tuition_actor(text,text)') IS NULL OR to_regprocedure('hon.require_tuition_reader(text)') IS NULL
    OR to_regprocedure('hon.invoice_balance_json(hon.invoices)') IS NULL OR to_regprocedure('hon.read_school_invoices(text,jsonb)') IS NULL
    OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.membership_school_today()') IS NULL
    OR to_regprocedure('hon.demo_data_removal_allows(text,jsonb)') IS NULL OR to_regprocedure('hon.school_pay_once_provider(uuid,uuid)') IS NULL
    OR to_regclass('hon.school_locations') IS NULL THEN
    RAISE EXCEPTION 'Simple invoices require 0224, 0240, 0280, 0392, 0459 and 0529';
  END IF;
END $$;

CREATE TABLE hon.invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES hon.invoices(id) ON DELETE RESTRICT,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 30),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200 AND btrim(description)=description AND description !~ '[\x01-\x1f\x7f]'),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_amount_minor integer NOT NULL CHECK (unit_amount_minor BETWEEN 0 AND 100000000),
  amount_minor bigint NOT NULL CHECK (amount_minor=quantity::bigint*unit_amount_minor),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (invoice_id,position),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);

CREATE TABLE hon.invoice_details (
  invoice_id uuid PRIMARY KEY REFERENCES hon.invoices(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  pay_to_phone text CHECK (pay_to_phone IS NULL OR (pay_to_phone ~ '^[0-9+()\-. ]{3,40}$' AND pay_to_phone ~ '[0-9]' AND btrim(pay_to_phone)=pay_to_phone)),
  pay_to_email text CHECK (pay_to_email IS NULL OR (length(pay_to_email)<=200 AND pay_to_email ~ '^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$')),
  other_ways_to_pay text CHECK (other_ways_to_pay IS NULL OR (length(other_ways_to_pay) BETWEEN 1 AND 500
    AND btrim(other_ways_to_pay, E' \t\n\r')=other_ways_to_pay AND other_ways_to_pay !~ '[\x01-\x08\x0b-\x1f\x7f]')),
  note text CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 1000 AND btrim(note, E' \t\n\r')=note AND note !~ '[\x01-\x08\x0b-\x1f\x7f]')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);

ALTER TABLE hon.invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.invoice_line_items FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.invoice_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.invoice_details FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hon.invoice_line_items, hon.invoice_details FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON hon.invoice_line_items, hon.invoice_details FROM %I',r);
  END LOOP;
END $$;

-- Items and details are added only to a DRAFT invoice of the same school and are never changed afterwards. Demo data
-- removal may delete the demo rows it registered (the 0459 rule; written as its own line so the 42 guards 0459 patched
-- keep their exact count).
CREATE FUNCTION hon.guard_invoice_simple_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' AND hon.demo_data_removal_allows(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF; -- school demo data (0459 rule) may go
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVOICE_SIMPLE_ROWS_APPEND_ONLY' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.invoices i WHERE i.id=NEW.invoice_id AND i.organization_id=NEW.organization_id
      AND i.school_id=NEW.school_id AND i.status='DRAFT') THEN
    RAISE EXCEPTION 'INVOICE_SIMPLE_ROWS_APPEND_ONLY' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_items_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION hon.guard_invoice_simple_rows();
CREATE TRIGGER invoice_line_items_truncate_guard BEFORE TRUNCATE ON hon.invoice_line_items
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_invoice_simple_rows();
CREATE TRIGGER invoice_details_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.invoice_details
  FOR EACH ROW EXECUTE FUNCTION hon.guard_invoice_simple_rows();
CREATE TRIGGER invoice_details_truncate_guard BEFORE TRUNCATE ON hon.invoice_details
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_invoice_simple_rows();

-- Text the invoice shows: a trimmed single line (or, with multiline, tab/newline allowed), 1..max characters.
CREATE FUNCTION hon.simple_invoice_text_ok(value jsonb,max_len integer,multiline boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_typeof(value)='string' AND length(value#>>'{}') BETWEEN 1 AND max_len
    AND CASE WHEN multiline THEN btrim(value#>>'{}',E' \t\n\r')=value#>>'{}' AND value#>>'{}' !~ '[\x01-\x08\x0b-\x1f\x7f]'
      ELSE btrim(value#>>'{}')=value#>>'{}' AND value#>>'{}' !~ '[\x01-\x1f\x7f]' END
$$;

-- The printable view of one invoice of the current school (the caller has proved its authority).
CREATE FUNCTION hon.simple_invoice_detail_json(i hon.invoices,can_issue boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object(
    'invoice',hon.invoice_balance_json(i)||jsonb_build_object('createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'number',upper(left(i.id::text,8)),
    'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'timezone',s.timezone,
    'canIssue',can_issue,
    'items',coalesce((SELECT jsonb_agg(jsonb_build_object('position',x.position,'description',x.description,'quantity',x.quantity,
        'unitAmountMinor',x.unit_amount_minor,'amountMinor',x.amount_minor) ORDER BY x.position)
      FROM hon.invoice_line_items x WHERE x.invoice_id=i.id AND x.organization_id=i.organization_id AND x.school_id=i.school_id),'[]'::jsonb),
    'note',d.note,
    'billTo',jsonb_build_object('personId',p.id,'name',left(nullif(btrim(coalesce(p.given_name,'')||' '||coalesce(p.family_name,'')),''),200),
      'email',left(p.email::text,320),'phone',left(p.phone_e164,40)),
    'from',jsonb_build_object('schoolName',left(s.name,200),
      'addressLines',coalesce((SELECT jsonb_agg(line ORDER BY n) FROM (VALUES
          (1,l.address_line1),(2,l.address_line2),
          (3,nullif(concat_ws(' ',nullif(concat_ws(', ',l.city,l.region_code),''),l.postal_code),'')),
          (4,l.country_code)) v(n,line) WHERE line IS NOT NULL),'[]'::jsonb),
      'phone',d.pay_to_phone,'email',d.pay_to_email),
    'howToPay',jsonb_build_object('inApp',hon.school_pay_once_provider(i.organization_id,i.school_id) IS NOT NULL,
      'otherWays',d.other_ways_to_pay))
  FROM hon.schools s
  LEFT JOIN hon.school_locations l ON l.school_id=s.id AND l.organization_id=s.organization_id
  LEFT JOIN hon.invoice_details d ON d.invoice_id=i.id AND d.organization_id=i.organization_id AND d.school_id=i.school_id
  LEFT JOIN hon.billing_accounts b ON b.id=i.billing_account_id AND b.organization_id=i.organization_id AND b.school_id=i.school_id
  LEFT JOIN hon.people p ON p.id=b.responsible_person_id AND p.organization_id=i.organization_id AND p.school_id=i.school_id
  WHERE s.id=i.school_id AND s.organization_id=i.organization_id
$$;

-- Input p: {billingAccountId, dueDate 'YYYY-MM-DD', items:[{description, quantity, unitAmountMinor}] (1..30), issue,
-- payToPhone?, payToEmail?, otherWaysToPay?, note?}. Due at the end of that day in school time; the due day is from a
-- year before to a year after the school's today. Total = sum of quantity x price, 1..2147483647 minor units, in the
-- billing account's currency. Canonical order: key reservation; IAM SHARE; the account; the invoice and its rows; the
-- optional issue; audit and outbox; the receipt; authority decided again after the last write.
CREATE FUNCTION hon.create_simple_invoice(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; issuer uuid; fp text;
  reserved boolean; prior hon.idempotency_records%ROWTYPE; account hon.billing_accounts%ROWTYPE; due date; tz text; today date;
  item jsonb; n integer:=0; total bigint:=0; i hon.invoices%ROWTYPE; created jsonb; result jsonb; want_issue boolean;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR NOT p ?& ARRAY['billingAccountId','dueDate','items','issue']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('billingAccountId','dueDate','items','issue','payToPhone','payToEmail','otherWaysToPay','note'))
    OR jsonb_typeof(p->'billingAccountId') IS DISTINCT FROM 'string' OR p->>'billingAccountId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'issue') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'items') NOT BETWEEN 1 AND 30
    OR (p ? 'payToPhone' AND NOT (hon.simple_invoice_text_ok(p->'payToPhone',40,false) AND p->>'payToPhone' ~ '^[0-9+()\-. ]{3,40}$' AND p->>'payToPhone' ~ '[0-9]'))
    OR (p ? 'payToEmail' AND NOT (hon.simple_invoice_text_ok(p->'payToEmail',200,false) AND p->>'payToEmail' ~ '^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$'))
    OR (p ? 'otherWaysToPay' AND NOT hon.simple_invoice_text_ok(p->'otherWaysToPay',500,true))
    OR (p ? 'note' AND NOT hon.simple_invoice_text_ok(p->'note',1000,true)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'items') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT item ?& ARRAY['description','quantity','unitAmountMinor']
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) x WHERE x NOT IN ('description','quantity','unitAmountMinor'))
      OR NOT hon.simple_invoice_text_ok(item->'description',200,false)
      OR jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number' OR (item->'quantity')::text !~ '^[1-9][0-9]{0,3}$' OR (item->>'quantity')::integer>1000
      OR jsonb_typeof(item->'unitAmountMinor') IS DISTINCT FROM 'number' OR (item->'unitAmountMinor')::text !~ '^(0|[1-9][0-9]{0,8})$'
      OR (item->>'unitAmountMinor')::bigint>100000000 THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    total:=total+(item->>'quantity')::bigint*(item->>'unitAmountMinor')::bigint;
  END LOOP;
  IF total<1 OR total>2147483647 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  due:=hon.membership_pause_date(p->'dueDate');
  want_issue:=(p->>'issue')::boolean;

  fp:=encode(sha256(convert_to(jsonb_build_object('operation','billing.invoice.simple.create','input',p)::text,'UTF8')),'hex');
  actor:=hon.require_tuition_actor(subject,'billing.invoice.create');
  IF want_issue THEN issuer:=hon.require_tuition_actor(subject,'billing.invoice.issue'); END IF;
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,
    hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_tuition_actor(subject,'billing.invoice.create') IS DISTINCT FROM actor
    OR (want_issue AND hon.require_tuition_actor(subject,'billing.invoice.issue') IS DISTINCT FROM actor) THEN
    RAISE EXCEPTION 'TUITION_RECEIVABLES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT coalesce(reserved,false) THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    -- A stored receipt is never returned after a live access loss; the invoice is read again as it is now.
    SELECT * INTO i FROM hon.invoices x WHERE x.id=(prior.response_body->>'invoiceId')::uuid AND x.organization_id=org AND x.school_id=school;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    result:=hon.simple_invoice_detail_json(i,hon.simple_invoice_can_issue(subject));
    IF hon.require_tuition_actor(subject,'billing.invoice.create') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'TUITION_RECEIVABLES_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',result,'replayed',true);
  END IF;

  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  today:=hon.membership_school_today();
  IF due<today-365 OR due>today+366 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO account FROM hon.billing_accounts b WHERE b.id=(p->>'billingAccountId')::uuid AND b.organization_id=org AND b.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,discount_minor,total_minor,due_at)
    VALUES(org,school,account.id,NULL,'DRAFT',account.currency,total::integer,0,total::integer,
      ((due::timestamp+time '23:59:59') AT TIME ZONE tz)) RETURNING * INTO i;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'items') LOOP
    n:=n+1;
    INSERT INTO hon.invoice_line_items(organization_id,school_id,invoice_id,position,description,quantity,unit_amount_minor,amount_minor)
      VALUES(org,school,i.id,n,item->>'description',(item->>'quantity')::integer,(item->>'unitAmountMinor')::integer,
        (item->>'quantity')::bigint*(item->>'unitAmountMinor')::bigint);
  END LOOP;
  INSERT INTO hon.invoice_details(invoice_id,organization_id,school_id,pay_to_phone,pay_to_email,other_ways_to_pay,note)
    VALUES(i.id,org,school,p->>'payToPhone',p->>'payToEmail',p->>'otherWaysToPay',p->>'note');
  created:=jsonb_build_object('invoiceId',i.id,'billingAccountId',i.billing_account_id,'membershipId',NULL,'status','DRAFT',
    'currency',i.currency::text,'subtotalMinor',i.subtotal_minor,'discountMinor',0,'totalMinor',i.total_minor,
    'dueAt',to_char(i.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'version',i.version,'lineCount',n);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.invoice.create','INVOICE',i.id,NULL,created,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.invoice.created',1,'INVOICE',i.id,i.version,correlation,request,created);
  IF want_issue THEN
    UPDATE hon.invoices SET status='ISSUED',version=version+1 WHERE id=i.id AND status='DRAFT' AND version=1 RETURNING * INTO i;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(org,school,actor,'HUMAN_UI','billing.invoice.issue','INVOICE',i.id,jsonb_build_object('status','DRAFT','version',1),
        jsonb_build_object('invoiceId',i.id,'status','ISSUED','version',i.version),'SUCCEEDED',request,correlation);
    INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
      VALUES(org,school,'billing.invoice.issued',1,'INVOICE',i.id,i.version,correlation,request,
        jsonb_build_object('invoiceId',i.id,'status','ISSUED','version',i.version));
  END IF;
  result:=hon.simple_invoice_detail_json(i,hon.simple_invoice_can_issue(subject));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=201,response_body=jsonb_build_object('invoiceId',i.id)
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_tuition_actor(subject,'billing.invoice.create') IS DISTINCT FROM actor
    OR (want_issue AND hon.require_tuition_actor(subject,'billing.invoice.issue') IS DISTINCT FROM actor) THEN
    RAISE EXCEPTION 'TUITION_RECEIVABLES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- Whether the subject may also issue invoices here (live); never raises.
CREATE FUNCTION hon.simple_invoice_can_issue(subject text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_tuition_actor(subject,'billing.invoice.issue'); RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;

-- Read: one invoice of the current school for the printable view. Same readers as the 0280 list; another school's or an
-- unknown id is INVOICE_NOT_FOUND. Read-only.
CREATE FUNCTION hon.read_school_invoice_detail(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; i hon.invoices%ROWTYPE; result jsonb;
BEGIN
  used:=hon.require_tuition_reader(subject); actor:=hon.require_tuition_actor(subject,used);
  IF selected IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO i FROM hon.invoices x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=hon.simple_invoice_detail_json(i,hon.simple_invoice_can_issue(subject));
  IF hon.require_tuition_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'TUITION_RECEIVABLES_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON FUNCTION hon.create_simple_invoice(text,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI simple invoice (SI1 0558): DRAFT invoice with items (total = their sum), optionally issued. No money moves.';
COMMENT ON FUNCTION hon.read_school_invoice_detail(text,uuid) IS
'Direct HUMAN_UI read of one current-school invoice for the printable view (SI1 0558). No DML.';

DO $$ DECLARE f text; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.create_simple_invoice(text,jsonb,text,uuid,uuid)','hon.read_school_invoice_detail(text,uuid)',
      'hon.simple_invoice_detail_json(hon.invoices,boolean)','hon.simple_invoice_can_issue(text)','hon.simple_invoice_text_ok(jsonb,integer,boolean)',
      'hon.guard_invoice_simple_rows()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_simple_invoice(text,jsonb,text,uuid,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_school_invoice_detail(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
