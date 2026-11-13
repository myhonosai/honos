BEGIN;

-- Onboarding B7 (0334, coordinator-allocated 2026-11-13): a school moving from another system stages a CSV of its
-- students' current memberships and what each family still owes, decides each row (IMPORT or SKIP), then finalizes.
-- Same staged and reviewed shape as the 0226 student import and the 0333 class and attendance import.
-- Owner decision D1 (2026-11-13, "Record, plus staff can charge"): imported memberships and balances are recorded, and
-- staff may start charging a family's saved card right away with the imported terms through the existing school-pay paths.
-- Each IMPORT row, for one existing student (matched by name, and birth date when given):
--   * the payer is a guardian of the student's family (or an adult student), and their one CANONICAL billing account
--     (0159) is used, or created in the row's currency;
--   * one membership is created and confirmed ACTIVE with its 0177 evidence (one activation decision with basis
--     STAFF_ACTIVATION_PRE_POLICY, source GENERIC_LEGACY, reason LEGACY_MEMBERSHIP, and the INITIAL effective period
--     from the imported dates), so every membership reader, the 0178 date revisions and the 0224 pause and cancel
--     commands treat it like any other confirmed membership;
--   * one ACTIVE payment schedule (0014) carries the imported amount, frequency and next charge date, which is exactly
--     what the 0322 autopay cycle bills once staff enroll the payer's saved method in autopay;
--   * an opening balance above zero becomes one ISSUED invoice on that account (the 0240 receivables and payment records
--     work on it as on any other).
-- Nothing here contacts a processor, moves money, enrolls autopay, sends a message or calls AI. Live payments stay off
-- until the owner separately approves them. The runtime role gets EXECUTE on five entry points and nothing on any table.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION '0334 requires a restricted runtime'; END IF;
  IF to_regclass('hon.membership_activation_decisions') IS NULL OR to_regclass('hon.membership_effective_periods') IS NULL
    OR to_regclass('hon.membership_payment_schedules') IS NULL OR to_regclass('hon.student_import_batches') IS NULL
    OR to_regclass('hon.school_pay_autopay_plans') IS NULL OR to_regclass('hon.invoice_payment_records') IS NULL
    OR to_regclass('hon.membership_plan_versions') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.membership_local_date(timestamptz,text)') IS NULL
    OR to_regprocedure('hon.membership_local_day_start(date,text)') IS NULL OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='hon.billing_accounts'::regclass AND attname='account_classification' AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='invoice_status' AND e.enumlabel='ISSUED')
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='students.import')
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='billing.membership.activate')
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='billing.invoice.issue') THEN
    RAISE EXCEPTION '0334 requires 0014, 0049, 0159, 0175, 0177, 0226, 0240 and 0322';
  END IF;
END $$;

CREATE TABLE hon.billing_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'MEMBERSHIPS' CHECK (kind='MEMBERSHIPS'),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  status text NOT NULL DEFAULT 'STAGED' CHECK (status IN ('STAGED','FINALIZED')),
  source_checksum text NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
  headers jsonb NOT NULL CHECK (jsonb_typeof(headers)='array'),
  mapping jsonb NOT NULL CHECK (jsonb_typeof(mapping)='object'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 1000),
  valid_count integer NOT NULL CHECK (valid_count BETWEEN 0 AND row_count),
  school_today date NOT NULL,
  school_timezone text NOT NULL CHECK (length(school_timezone) BETWEEN 1 AND 64),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_by_principal_id uuid REFERENCES hon.principals(id),
  finalized_at timestamptz,
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  UNIQUE (id,organization_id,school_id),
  CHECK ((status='FINALIZED')=(finalized_at IS NOT NULL) AND (finalized_at IS NULL)=(finalized_by_principal_id IS NULL))
);
CREATE INDEX billing_import_batches_scope_idx ON hon.billing_import_batches(organization_id,school_id,created_at DESC,id);

-- One staged row. The match (student and payer) is fixed at staging; the records it creates are written once.
CREATE TABLE hon.billing_import_rows (
  batch_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
  row_index integer NOT NULL CHECK (row_index BETWEEN 1 AND 1000),
  source_row jsonb NOT NULL CHECK (jsonb_typeof(source_row)='array'),
  normalized jsonb NOT NULL CHECK (jsonb_typeof(normalized)='object'),
  validation_errors jsonb NOT NULL CHECK (jsonb_typeof(validation_errors)='array'),
  choice text CHECK (choice IN ('IMPORT','SKIP')),
  matched_profile_id uuid,
  payer_person_id uuid,
  billing_account_id uuid,
  membership_id uuid UNIQUE, schedule_id uuid UNIQUE, invoice_id uuid UNIQUE,
  PRIMARY KEY (batch_id,row_index),
  FOREIGN KEY (batch_id,organization_id,school_id) REFERENCES hon.billing_import_batches(id,organization_id,school_id),
  FOREIGN KEY (matched_profile_id,organization_id,school_id) REFERENCES hon.student_profiles(id,organization_id,school_id),
  FOREIGN KEY (payer_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id),
  FOREIGN KEY (billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id),
  FOREIGN KEY (membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id),
  FOREIGN KEY (schedule_id,organization_id,school_id) REFERENCES hon.membership_payment_schedules(id,organization_id,school_id),
  FOREIGN KEY (invoice_id,organization_id,school_id) REFERENCES hon.invoices(id,organization_id,school_id),
  CHECK ((membership_id IS NULL)=(schedule_id IS NULL)),
  CHECK (invoice_id IS NULL OR membership_id IS NOT NULL),
  CHECK (membership_id IS NULL OR (choice='IMPORT' AND validation_errors='[]'::jsonb AND billing_account_id IS NOT NULL)),
  CHECK (validation_errors<>'[]'::jsonb OR (matched_profile_id IS NOT NULL AND payer_person_id IS NOT NULL))
);

CREATE TABLE hon.billing_import_requests (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('stage','decide','finalize')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);

ALTER TABLE hon.billing_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_import_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_import_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_import_requests FORCE ROW LEVEL SECURITY;

-- Evidence guard: nothing is deleted; a batch only advances its version (and finalizes once); a row keeps its staged
-- content and match, changes its choice only before it is applied, and records its created ids once; a request records
-- its response once.
CREATE FUNCTION hon.guard_billing_import() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE st text;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'BILLING_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='billing_import_requests' THEN
    IF OLD.response IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL OR (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'BILLING_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSIF TG_TABLE_NAME='billing_import_batches' THEN
    IF OLD.status='FINALIZED' OR NEW.version<>OLD.version+1
      OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.kind,NEW.source_checksum,NEW.headers,NEW.mapping,NEW.row_count,NEW.valid_count,NEW.school_today,NEW.school_timezone,NEW.created_by_principal_id,NEW.created_at)
        IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.kind,OLD.source_checksum,OLD.headers,OLD.mapping,OLD.row_count,OLD.valid_count,OLD.school_today,OLD.school_timezone,OLD.created_by_principal_id,OLD.created_at) THEN
      RAISE EXCEPTION 'BILLING_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT b.status INTO st FROM hon.billing_import_batches b WHERE b.id=OLD.batch_id;
    IF st IS DISTINCT FROM 'STAGED' OR OLD.membership_id IS NOT NULL
      OR (NEW.batch_id,NEW.organization_id,NEW.school_id,NEW.row_index,NEW.source_row,NEW.normalized,NEW.validation_errors,NEW.matched_profile_id,NEW.payer_person_id)
        IS DISTINCT FROM (OLD.batch_id,OLD.organization_id,OLD.school_id,OLD.row_index,OLD.source_row,OLD.normalized,OLD.validation_errors,OLD.matched_profile_id,OLD.payer_person_id)
      OR (NEW.billing_account_id IS DISTINCT FROM OLD.billing_account_id AND (OLD.billing_account_id IS NOT NULL OR NEW.membership_id IS NULL))
      OR (NEW.choice IS DISTINCT FROM OLD.choice AND NEW.membership_id IS NOT NULL)
      OR (NEW.choice IS NULL AND OLD.choice IS NOT NULL) THEN
      RAISE EXCEPTION 'BILLING_IMPORT_IMMUTABLE' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_import_batches_guard BEFORE UPDATE OR DELETE ON hon.billing_import_batches FOR EACH ROW EXECUTE FUNCTION hon.guard_billing_import();
CREATE TRIGGER billing_import_rows_guard BEFORE UPDATE OR DELETE ON hon.billing_import_rows FOR EACH ROW EXECUTE FUNCTION hon.guard_billing_import();
CREATE TRIGGER billing_import_requests_guard BEFORE UPDATE OR DELETE ON hon.billing_import_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_billing_import();
CREATE TRIGGER billing_import_batches_no_truncate BEFORE TRUNCATE ON hon.billing_import_batches FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_billing_import();
CREATE TRIGGER billing_import_rows_no_truncate BEFORE TRUNCATE ON hon.billing_import_rows FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_billing_import();
CREATE TRIGGER billing_import_requests_no_truncate BEFORE TRUNCATE ON hon.billing_import_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_billing_import();

-- Live direct-human staff authority at the session school, decided against clock_timestamp(), or an error. The import
-- needs all three permissions whose records it creates by hand elsewhere: students.import (0226), billing.membership.activate
-- (0177, confirming a membership) and billing.invoice.issue (0049, issuing an invoice).
CREATE FUNCTION hon.require_billing_import_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  need text[]:=ARRAY['students.import','billing.membership.activate','billing.invoice.issue'];
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN
    RAISE EXCEPTION 'BILLING_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    -- A family, HQ or system role anywhere disqualifies the person, as in the 0322 and 0330 actors.
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND (SELECT count(DISTINCT x.code) FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=ANY(need) AND x.is_staff_assignable)=cardinality(need)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'BILLING_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

CREATE FUNCTION hon.billing_import_fields() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['studentGivenName','studentFamilyName','birthDate','payerGivenName','payerFamilyName','planName','amount','currency',
    'frequency','startedOn','endsOn','nextChargeOn','balanceOwed','balanceDueOn']
$$;
CREATE FUNCTION hon.billing_import_required() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['studentGivenName','studentFamilyName','planName','amount','frequency','startedOn','nextChargeOn']
$$;

-- A strict calendar date, or NULL.
CREATE FUNCTION hon.billing_import_date(v text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE d date;
BEGIN
  IF v IS NULL OR v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
  BEGIN d:=to_date(v,'YYYY-MM-DD'); EXCEPTION WHEN OTHERS THEN RETURN NULL; END;
  RETURN CASE WHEN to_char(d,'YYYY-MM-DD')=v AND d>=date '2000-01-01' THEN d END;
END $$;

-- The currencies an import understands, with their minor units: two decimals, or whole units for JPY and KRW. Any other
-- code (VND, KWD, an unknown one) is refused as currency:UNSUPPORTED rather than stored at the wrong scale.
CREATE FUNCTION hon.billing_import_currency_supported(cur text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(cur IN ('USD','CAD','AUD','NZD','GBP','EUR','JPY','KRW'),false)
$$;

-- "149", "149.00", "$1,250.50" -> minor units of a two-decimal currency; whole units only for JPY and KRW. NULL when the
-- text is not a plain non-negative amount of at most 1,000,000 units, or the currency is not supported.
CREATE FUNCTION hon.billing_import_money(v text,cur text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE t text; m text[]; whole bigint; frac text;
BEGIN
  IF v IS NULL OR NOT hon.billing_import_currency_supported(cur) THEN RETURN NULL; END IF;
  t:=regexp_replace(btrim(v),'^[$€£¥₩]\s*','');
  IF t ~ '^[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?$' THEN t:=replace(t,',',''); END IF;
  m:=regexp_match(t,'^([0-9]{1,7})(?:\.([0-9]{1,2}))?$');
  IF m IS NULL THEN RETURN NULL; END IF;
  whole:=m[1]::bigint;
  IF whole>1000000 THEN RETURN NULL; END IF;
  IF cur IN ('JPY','KRW') THEN
    IF m[2] IS NOT NULL AND m[2] !~ '^0+$' THEN RETURN NULL; END IF;
    RETURN whole::integer;
  END IF;
  frac:=rpad(coalesce(m[2],'0'),2,'0');
  RETURN (whole*100+frac::bigint)::integer;
END $$;

-- "Monthly" / "month" / "per month" -> MONTHLY; weekly and yearly the same. NULL otherwise.
CREATE FUNCTION hon.billing_import_frequency(v text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE regexp_replace(lower(btrim(v)),'^(per|every|each)\s+','')
    WHEN 'weekly' THEN 'WEEKLY' WHEN 'week' THEN 'WEEKLY' WHEN 'wk' THEN 'WEEKLY'
    WHEN 'monthly' THEN 'MONTHLY' WHEN 'month' THEN 'MONTHLY' WHEN 'mo' THEN 'MONTHLY'
    WHEN 'annual' THEN 'ANNUAL' WHEN 'annually' THEN 'ANNUAL' WHEN 'yearly' THEN 'ANNUAL' WHEN 'year' THEN 'ANNUAL' WHEN 'yr' THEN 'ANNUAL' END
$$;

-- One raw row against the staged headers and mapping: every mapped cell is revalidated here, never trusted from the API.
-- Ignored columns are dropped from the stored row. Amounts are checked later, once the currency is known.
-- Returns {sourceRow, normalized, errors}.
CREATE FUNCTION hon.billing_import_check_row(p_headers jsonb,p_mapping jsonb,p_row jsonb,p_today date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
DECLARE n jsonb:='{}'; errors jsonb:='[]'; src jsonb:='[]'; field text; raw text; v text; i integer; d date; f text;
  s_on date; e_on date; c_on date;
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'array' OR jsonb_array_length(p_row)<>jsonb_array_length(p_headers) THEN
    RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  FOR i IN 0..jsonb_array_length(p_headers)-1 LOOP
    IF jsonb_typeof(p_row->i) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
    field:=p_mapping->>(p_headers->>i);
    IF field='ignore' THEN src:=src||jsonb_build_array(''); CONTINUE; END IF;
    raw:=p_row->>i; v:=btrim(raw); src:=src||jsonb_build_array(raw);
    IF length(v)>120 THEN errors:=errors||jsonb_build_array(field||':TOO_LONG'); END IF;
    IF raw ~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿�]' THEN errors:=errors||jsonb_build_array(field||':CONTROL_CHARACTER'); END IF;
    IF v ~ '^[=+@-]' THEN errors:=errors||jsonb_build_array(field||':FORMULA_INJECTION'); END IF;
    IF v<>'' THEN
      IF field IN ('birthDate','startedOn','endsOn','nextChargeOn','balanceDueOn') THEN
        d:=hon.billing_import_date(v);
        IF d IS NULL THEN errors:=errors||jsonb_build_array(field||':USE_YYYY_MM_DD');
        ELSIF field='birthDate' AND (d>p_today OR d<p_today-interval '120 years') THEN errors:=errors||jsonb_build_array('birthDate:OUT_OF_RANGE');
        ELSIF field='startedOn' AND d>p_today+365 THEN errors:=errors||jsonb_build_array('startedOn:OUT_OF_RANGE');
        -- A membership that already ended is not imported as a current one.
        ELSIF field='endsOn' AND d<p_today THEN errors:=errors||jsonb_build_array('endsOn:ALREADY_ENDED');
        ELSIF field='endsOn' AND d>p_today+3650 THEN errors:=errors||jsonb_build_array('endsOn:OUT_OF_RANGE');
        -- The next charge is today or later, at most about thirteen months ahead: no past period is billed on import.
        ELSIF field='nextChargeOn' AND (d<p_today OR d>p_today+400) THEN errors:=errors||jsonb_build_array('nextChargeOn:OUT_OF_RANGE');
        ELSIF field='balanceDueOn' AND (d<p_today-3650 OR d>p_today+365) THEN errors:=errors||jsonb_build_array('balanceDueOn:OUT_OF_RANGE'); END IF;
      ELSIF field='frequency' THEN
        f:=hon.billing_import_frequency(v);
        IF f IS NULL THEN errors:=errors||jsonb_build_array('frequency:USE_WEEKLY_MONTHLY_OR_ANNUAL'); ELSE v:=f; END IF;
      ELSIF field='currency' THEN
        v:=upper(v);
        IF v !~ '^[A-Z]{3}$' THEN errors:=errors||jsonb_build_array('currency:USE_THREE_LETTER_CODE'); v:='';
        ELSIF NOT hon.billing_import_currency_supported(v) THEN errors:=errors||jsonb_build_array('currency:UNSUPPORTED'); v:=''; END IF;
      END IF;
    END IF;
    n:=n||jsonb_build_object(field,v);
  END LOOP;
  FOREACH field IN ARRAY hon.billing_import_required() LOOP
    IF coalesce(n->>field,'')='' THEN errors:=errors||jsonb_build_array(field||':REQUIRED'); END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['birthDate','payerGivenName','payerFamilyName','currency','endsOn','balanceOwed','balanceDueOn'] LOOP
    n:=n||jsonb_build_object(field,coalesce(n->>field,''));
  END LOOP;
  IF (n->>'payerGivenName'='')<>(n->>'payerFamilyName'='') THEN errors:=errors||'["payer:GIVE_BOTH_NAMES"]'::jsonb; END IF;
  s_on:=hon.billing_import_date(n->>'startedOn'); e_on:=hon.billing_import_date(n->>'endsOn'); c_on:=hon.billing_import_date(n->>'nextChargeOn');
  IF e_on IS NOT NULL AND s_on IS NOT NULL AND e_on<s_on THEN errors:=errors||'["endsOn:BEFORE_START"]'::jsonb; END IF;
  IF c_on IS NOT NULL AND s_on IS NOT NULL AND c_on<s_on THEN errors:=errors||'["nextChargeOn:BEFORE_START"]'::jsonb; END IF;
  IF c_on IS NOT NULL AND e_on IS NOT NULL AND c_on>e_on THEN errors:=errors||'["nextChargeOn:AFTER_END"]'::jsonb; END IF;
  RETURN jsonb_build_object('sourceRow',src,'normalized',n,'errors',errors);
END $$;

-- The plan code an imported row carries: a school catalog plan (0175) whose code or current name matches, else a code made
-- from the name in the catalog's own code shape. Amount and frequency always come from the row (the imported terms).
CREATE FUNCTION hon.billing_import_plan_code(p_name text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE code text;
BEGIN
  SELECT h.plan_code INTO code FROM hon.membership_plans h JOIN hon.membership_plan_versions v ON v.plan_id=h.id AND v.version=h.current_version
    AND v.organization_id=h.organization_id AND v.school_id=h.school_id
  WHERE h.organization_id=hon.current_organization_id() AND h.school_id=hon.current_school_id()
    AND (h.plan_code=upper(btrim(p_name)) OR lower(v.display_name)=lower(btrim(p_name)))
  ORDER BY (h.plan_code=upper(btrim(p_name))) DESC,h.plan_code LIMIT 1;
  IF code IS NOT NULL THEN RETURN jsonb_build_object('planCode',code,'planMatched',true); END IF;
  code:=left(btrim(regexp_replace(upper(btrim(p_name)),'[^A-Z0-9]+','_','g'),'_'),40);
  code:=btrim(code,'_');
  IF code='' OR code !~ '^[A-Z0-9][A-Z0-9_-]{0,39}$' THEN code:='IMPORTED_PLAN'; END IF;
  RETURN jsonb_build_object('planCode',code,'planMatched',false);
END $$;

-- Students matched by exact names (case-insensitive) at this school, narrowed by birth date when the row gives one.
CREATE FUNCTION hon.billing_import_match_student(n jsonb,errs jsonb) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT array_agg(sp.id ORDER BY sp.id) FROM hon.student_profiles sp
    JOIN hon.people p ON p.id=sp.person_id AND p.organization_id=sp.organization_id AND p.school_id=sp.school_id
  WHERE sp.organization_id=hon.current_organization_id() AND sp.school_id=hon.current_school_id()
    AND lower(p.given_name)=lower(n->>'studentGivenName') AND lower(p.family_name)=lower(n->>'studentFamilyName')
    AND (n->>'birthDate'='' OR errs ? 'birthDate:USE_YYYY_MM_DD' OR errs ? 'birthDate:OUT_OF_RANGE' OR to_char(sp.birth_date,'YYYY-MM-DD')=n->>'birthDate')
$$;

-- The payer of one student: a guardian of the student's primary family named by the row, or the only guardian, or the
-- only billing-contact guardian; with no guardian (or when the row names the student) the student, unless a known minor.
-- Returns {payer} or {error}. Never a guess.
CREATE FUNCTION hon.billing_import_payer(p_profile uuid,n jsonb,p_today date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); sp hon.student_profiles%ROWTYPE; me hon.people%ROWTYPE;
  guardians uuid[]; contacts uuid[]; named uuid[]; minor boolean;
BEGIN
  SELECT * INTO sp FROM hon.student_profiles x WHERE x.id=p_profile AND x.organization_id=org AND x.school_id=school;
  SELECT * INTO me FROM hon.people x WHERE x.id=sp.person_id AND x.organization_id=org AND x.school_id=school;
  minor:=sp.birth_date IS NOT NULL AND sp.birth_date>p_today-interval '18 years';
  SELECT array_agg(fm.person_id ORDER BY fm.person_id),array_agg(fm.person_id ORDER BY fm.person_id) FILTER (WHERE fm.is_billing_contact)
    INTO guardians,contacts FROM hon.family_members fm
  WHERE sp.primary_family_id IS NOT NULL AND fm.family_id=sp.primary_family_id AND fm.organization_id=org AND fm.school_id=school
    AND fm.member_role='GUARDIAN' AND fm.person_id<>sp.person_id;
  IF n->>'payerGivenName'<>'' THEN
    IF lower(me.given_name)=lower(n->>'payerGivenName') AND lower(me.family_name)=lower(n->>'payerFamilyName') THEN
      IF minor THEN RETURN '{"error":"payer:MINOR_CANNOT_PAY"}'; END IF;
      RETURN jsonb_build_object('payer',me.id);
    END IF;
    SELECT array_agg(p.id ORDER BY p.id) INTO named FROM hon.people p
    WHERE p.id=ANY(coalesce(guardians,'{}')) AND p.organization_id=org AND p.school_id=school
      AND lower(p.given_name)=lower(n->>'payerGivenName') AND lower(p.family_name)=lower(n->>'payerFamilyName');
    IF named IS NULL THEN RETURN '{"error":"payer:NOT_IN_FAMILY"}'; END IF;
    IF cardinality(named)>1 THEN RETURN '{"error":"payer:AMBIGUOUS"}'; END IF;
    RETURN jsonb_build_object('payer',named[1]);
  END IF;
  IF guardians IS NULL THEN
    IF minor THEN RETURN '{"error":"payer:NO_GUARDIAN"}'; END IF;
    RETURN jsonb_build_object('payer',me.id);
  END IF;
  IF cardinality(guardians)=1 THEN RETURN jsonb_build_object('payer',guardians[1]); END IF;
  IF cardinality(coalesce(contacts,'{}'))=1 THEN RETURN jsonb_build_object('payer',contacts[1]); END IF;
  RETURN '{"error":"payer:CHOOSE_PAYER"}';
END $$;

-- A participant with a membership that has not ended cannot get a second one by import.
CREATE FUNCTION hon.billing_import_has_membership(p_profile uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.memberships m JOIN hon.student_profiles sp ON sp.person_id=m.participant_person_id
      AND sp.organization_id=m.organization_id AND sp.school_id=m.school_id
    WHERE sp.id=p_profile AND m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id()
      AND m.state IN ('DRAFT','ACTIVE','FROZEN','CANCELLATION_PENDING'))
$$;

CREATE FUNCTION hon.billing_import_summary(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',b.id,'kind',b.kind,'version',b.version,'status',b.status,'rowCount',b.row_count,'validCount',b.valid_count,
    'importCount',(SELECT count(*) FROM hon.billing_import_rows r WHERE r.batch_id=b.id AND r.choice='IMPORT'),
    'skipCount',(SELECT count(*) FROM hon.billing_import_rows r WHERE r.batch_id=b.id AND r.choice='SKIP'),
    'undecidedCount',(SELECT count(*) FROM hon.billing_import_rows r WHERE r.batch_id=b.id AND r.choice IS NULL),
    'importedCount',(SELECT count(*) FROM hon.billing_import_rows r WHERE r.batch_id=b.id AND r.membership_id IS NOT NULL),
    'balanceCount',(SELECT count(*) FROM hon.billing_import_rows r WHERE r.batch_id=b.id AND r.invoice_id IS NOT NULL),
    'checksum',b.source_checksum,'schoolToday',to_char(b.school_today,'YYYY-MM-DD'),'schoolTimezone',b.school_timezone,
    'createdAt',hon.saas_ts(b.created_at),'finalizedAt',hon.saas_ts(b.finalized_at))
  FROM hon.billing_import_batches b WHERE b.id=p_batch
$$;

CREATE FUNCTION hon.billing_import_detail(p_batch uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('batch',hon.billing_import_summary(b.id),'headers',b.headers,'mapping',b.mapping,
    'rows',(SELECT coalesce(jsonb_agg(jsonb_build_object('index',r.row_index,'raw',r.source_row,'normalized',r.normalized,
      'errors',r.validation_errors,'choice',r.choice,'matchedStudentProfileId',r.matched_profile_id,'payerPersonId',r.payer_person_id,
      'payerName',(SELECT left(p.given_name||' '||p.family_name,200) FROM hon.people p WHERE p.id=r.payer_person_id),
      'created',CASE WHEN r.membership_id IS NOT NULL THEN jsonb_build_object('billingAccountId',r.billing_account_id,'membershipId',r.membership_id,
        'scheduleId',r.schedule_id,'invoiceId',r.invoice_id) END)
      ORDER BY r.row_index),'[]'::jsonb) FROM hon.billing_import_rows r WHERE r.batch_id=b.id))
  FROM hon.billing_import_batches b WHERE b.id=p_batch
$$;

-- Common command prologue: authority -> key reservation -> exact replay only while authority is current. Returns the
-- stored response on replay, or NULL when the caller works.
CREATE FUNCTION hon.billing_import_begin(p_subject text,p_operation text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid,OUT actor uuid,OUT replay jsonb)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; prior hon.billing_import_requests%ROWTYPE;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('stage','decide','finalize') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_billing_import_actor(p_subject);
  fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');
  INSERT INTO hon.billing_import_requests(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(org,school,actor,p_key,p_operation,fp) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM hon.billing_import_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF prior.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.response IS NULL THEN RAISE EXCEPTION 'BILLING_IMPORT_BUSY' USING ERRCODE='55P03'; END IF;
    IF hon.require_billing_import_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'BILLING_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
    replay:=prior.response;
  END IF;
END $$;

CREATE FUNCTION hon.billing_import_finish(p_subject text,p_actor uuid,p_operation text,p_batch uuid,p_key text,p_request uuid,p_correlation uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); payload jsonb; v integer;
BEGIN
  SELECT version INTO v FROM hon.billing_import_batches WHERE id=p_batch;
  payload:=jsonb_build_object('batchId',p_batch,'operation',p_operation,'version',v,'internalOnly',true);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','billing.import.'||p_operation,'BILLING_IMPORT_BATCH',p_batch,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.import.'||p_operation,1,'BILLING_IMPORT_BATCH',p_batch,v,p_correlation,p_request,payload);
  UPDATE hon.billing_import_requests SET response=p_result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=p_actor AND idempotency_key=p_key;
  -- Final live authority after every write (a revocation during the command fails closed).
  IF hon.require_billing_import_actor(p_subject) IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'BILLING_IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',p_result,'replayed',false);
END $$;

-- The batch of a decide or finalize body, or an error. Import authority first, so a caller without it cannot learn whether
-- a batch exists.
CREATE FUNCTION hon.billing_import_batch_id(p_subject text,p_input jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_billing_import_actor(p_subject);
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR jsonb_typeof(p_input->'batchId') IS DISTINCT FROM 'string'
    OR (p_input->>'batchId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.billing_import_batches WHERE id=(p_input->>'batchId')::uuid AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN
    RAISE EXCEPTION 'BILLING_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN (p_input->>'batchId')::uuid;
END $$;

-- The payer's one CANONICAL billing account at this school (0159), or NULL.
CREATE FUNCTION hon.billing_import_payer_account(p_payer uuid) RETURNS hon.billing_accounts
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT a.* FROM hon.billing_accounts a WHERE a.organization_id=hon.current_organization_id() AND a.school_id=hon.current_school_id()
    AND a.responsible_person_id=p_payer AND a.account_classification='CANONICAL' ORDER BY a.created_at,a.id LIMIT 1
$$;

-- Input: exactly {csv, headers, mapping, rows}. The API parses the CSV; the database recomputes the checksum of the exact
-- text, revalidates every mapped cell, matches each row to one existing student and payer, resolves the currency and the
-- amounts, and flags repeats and students who already have a membership.
CREATE FUNCTION hon.stage_billing_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record;
  headers jsonb; mapping jsonb; rows jsonb; fields text[]; cell jsonb; item jsonb; checked jsonb; idx integer:=0; tz text; today date;
  b hon.billing_import_batches%ROWTYPE; n jsonb; errs jsonb; valid integer:=0; matches uuid[]; profile uuid; payer uuid; pr jsonb;
  acct hon.billing_accounts%ROWTYPE; cur text; amt integer; bal integer; seen jsonb:='{}'; payer_cur jsonb:='{}'; staged jsonb:='[]';
BEGIN
  SELECT * INTO s FROM hon.billing_import_begin(p_subject,'stage',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['csv','headers','mapping','rows']
    OR jsonb_typeof(p_input->'csv') IS DISTINCT FROM 'string' OR octet_length(p_input->>'csv') NOT BETWEEN 1 AND 262144 OR (p_input->>'csv') ~ '�'
    OR jsonb_typeof(p_input->'headers') IS DISTINCT FROM 'array' OR jsonb_typeof(p_input->'mapping') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_input->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  headers:=p_input->'headers'; mapping:=p_input->'mapping'; rows:=p_input->'rows';
  IF jsonb_array_length(headers) NOT BETWEEN 1 AND 24 OR jsonb_array_length(rows) NOT BETWEEN 1 AND 1000
    OR (SELECT count(DISTINCT h) FROM jsonb_array_elements_text(headers) h)<>jsonb_array_length(headers)
    OR (SELECT count(*) FROM jsonb_object_keys(mapping))<>jsonb_array_length(headers) THEN RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  FOR cell IN SELECT * FROM jsonb_array_elements(headers) LOOP
    IF jsonb_typeof(cell)<>'string' OR length(btrim(cell#>>'{}')) NOT BETWEEN 1 AND 80 OR (cell#>>'{}') ~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿]'
      OR (cell#>>'{}') ~ '^[[:space:]]*[=+@-]' OR NOT mapping ? (cell#>>'{}') OR jsonb_typeof(mapping->(cell#>>'{}'))<>'string' THEN
      RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT array_agg(v) INTO fields FROM jsonb_each_text(mapping) x(k,v) WHERE v<>'ignore';
  IF EXISTS(SELECT 1 FROM jsonb_each_text(mapping) x(k,v) WHERE v<>'ignore' AND v<>ALL(hon.billing_import_fields()))
    OR fields IS NULL OR cardinality(fields)<>(SELECT count(DISTINCT x) FROM unnest(fields) x)
    OR NOT hon.billing_import_required()<@fields THEN RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT timezone INTO tz FROM hon.schools WHERE id=school AND organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  today:=hon.membership_local_date(clock_timestamp(),tz);

  FOR item IN SELECT * FROM jsonb_array_elements(rows) LOOP
    idx:=idx+1; checked:=hon.billing_import_check_row(headers,mapping,item,today);
    n:=checked->'normalized'; errs:=checked->'errors'; profile:=NULL; payer:=NULL; acct:=NULL;
    IF coalesce(n->>'studentGivenName','')<>'' AND coalesce(n->>'studentFamilyName','')<>'' THEN
      matches:=hon.billing_import_match_student(n,errs);
      IF matches IS NULL THEN errs:=errs||'["student:NOT_FOUND"]'::jsonb;
      ELSIF cardinality(matches)>1 THEN errs:=errs||'["student:AMBIGUOUS"]'::jsonb;
      ELSE profile:=matches[1]; END IF;
    END IF;
    IF profile IS NOT NULL THEN
      IF seen ? profile::text THEN errs:=errs||'["row:REPEATED_IN_FILE"]'::jsonb; ELSE seen:=seen||jsonb_build_object(profile::text,idx); END IF;
      IF hon.billing_import_has_membership(profile) THEN errs:=errs||'["student:HAS_MEMBERSHIP"]'::jsonb; END IF;
      IF NOT errs ? 'payer:GIVE_BOTH_NAMES' THEN
        pr:=hon.billing_import_payer(profile,n,today);
        IF pr ? 'error' THEN errs:=errs||jsonb_build_array(pr->>'error'); ELSE payer:=(pr->>'payer')::uuid; END IF;
      END IF;
    END IF;
    -- Currency: the row's, else the payer's existing account's, else USD (shown on review). A payer keeps one currency.
    cur:=n->>'currency';
    IF payer IS NOT NULL THEN
      acct:=hon.billing_import_payer_account(payer);
      IF acct.id IS NOT NULL AND cur<>'' AND cur<>acct.currency::text THEN errs:=errs||'["currency:PAYER_CURRENCY_MISMATCH"]'::jsonb; END IF;
      IF cur='' THEN cur:=coalesce(acct.currency::text,'USD'); END IF;
      IF payer_cur ? payer::text AND payer_cur->>payer::text<>cur THEN errs:=errs||'["currency:PAYER_CURRENCY_MISMATCH"]'::jsonb;
      ELSE payer_cur:=payer_cur||jsonb_build_object(payer::text,cur); END IF;
    ELSIF cur='' THEN cur:='USD'; END IF;
    -- A defaulted currency (from an existing account) must be one the parser understands too.
    IF cur<>'' AND NOT hon.billing_import_currency_supported(cur) AND NOT errs ? 'currency:UNSUPPORTED' THEN
      errs:=errs||'["currency:UNSUPPORTED"]'::jsonb;
    END IF;
    IF cur<>'' AND NOT errs ?| ARRAY['currency:USE_THREE_LETTER_CODE','currency:UNSUPPORTED'] THEN
      amt:=hon.billing_import_money(n->>'amount',cur);
      IF coalesce(n->>'amount','')<>'' AND (amt IS NULL OR amt<=0) THEN errs:=errs||'["amount:USE_A_PRICE"]'::jsonb; END IF;
      bal:=CASE WHEN n->>'balanceOwed'='' THEN 0 ELSE hon.billing_import_money(n->>'balanceOwed',cur) END;
      IF bal IS NULL THEN errs:=errs||'["balanceOwed:USE_AN_AMOUNT"]'::jsonb; END IF;
      n:=n||jsonb_build_object('currency',cur,'amountMinor',coalesce(amt::text,''),'balanceMinor',coalesce(bal::text,''));
    ELSE
      n:=n||jsonb_build_object('amountMinor','','balanceMinor','');
    END IF;
    IF n->>'balanceDueOn'<>'' AND n->>'balanceMinor' IN ('','0') AND NOT errs ? 'balanceOwed:USE_AN_AMOUNT' THEN
      errs:=errs||'["balanceDueOn:NO_BALANCE"]'::jsonb; END IF;
    n:=n||jsonb_build_object('balanceDueOn',CASE WHEN n->>'balanceDueOn'='' THEN to_char(today,'YYYY-MM-DD') ELSE n->>'balanceDueOn' END);
    IF coalesce(n->>'planName','')<>'' THEN n:=n||hon.billing_import_plan_code(n->>'planName'); END IF;
    IF errs='[]'::jsonb THEN valid:=valid+1; END IF;
    staged:=staged||jsonb_build_array(jsonb_build_object('index',idx,'sourceRow',checked->'sourceRow','normalized',n,'errors',errs,
      'profile',profile,'payer',payer,'account',acct.id));
  END LOOP;
  INSERT INTO hon.billing_import_batches(organization_id,school_id,source_checksum,headers,mapping,row_count,valid_count,school_today,school_timezone,created_by_principal_id)
    VALUES(org,school,encode(sha256(convert_to(p_input->>'csv','UTF8')),'hex'),headers,mapping,jsonb_array_length(rows),valid,today,tz,s.actor) RETURNING * INTO b;
  INSERT INTO hon.billing_import_rows(batch_id,organization_id,school_id,row_index,source_row,normalized,validation_errors,matched_profile_id,payer_person_id,billing_account_id)
    SELECT b.id,org,school,(t->>'index')::integer,t->'sourceRow',t->'normalized',t->'errors',
      CASE WHEN t->'errors'='[]'::jsonb THEN (t->>'profile')::uuid END,CASE WHEN t->'errors'='[]'::jsonb THEN (t->>'payer')::uuid END,
      CASE WHEN t->'errors'='[]'::jsonb THEN (t->>'account')::uuid END
    FROM jsonb_array_elements(staged) t;
  RETURN hon.billing_import_finish(p_subject,s.actor,'stage',b.id,p_key,p_request,p_correlation,hon.billing_import_summary(b.id));
END $$;

-- Input: exactly {batchId, expectedVersion, decisions:[{index, choice}]}. IMPORT is accepted only for a row without errors.
CREATE FUNCTION hon.decide_billing_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record; batch uuid; b hon.billing_import_batches%ROWTYPE; item jsonb; v_choice text; idx integer;
BEGIN
  batch:=hon.billing_import_batch_id(p_subject,p_input);
  SELECT * INTO s FROM hon.billing_import_begin(p_subject,'decide',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['batchId','decisions','expectedVersion']
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'decisions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'decisions') NOT BETWEEN 1 AND 1000
    OR (SELECT count(DISTINCT d->>'index') FROM jsonb_array_elements(p_input->'decisions') d)<>jsonb_array_length(p_input->'decisions') THEN
    RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.billing_import_batches WHERE id=batch AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.status<>'STAGED' OR b.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_input->'decisions') LOOP
    IF jsonb_typeof(item)<>'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(item) x) IS DISTINCT FROM ARRAY['choice','index']
      OR jsonb_typeof(item->'index') IS DISTINCT FROM 'number' OR (item->>'index') !~ '^[1-9][0-9]{0,3}$' OR item->>'choice' IS NULL OR item->>'choice' NOT IN ('IMPORT','SKIP') THEN
      RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
    idx:=(item->>'index')::integer; v_choice:=item->>'choice';
    UPDATE hon.billing_import_rows SET choice=v_choice WHERE batch_id=b.id AND row_index=idx AND membership_id IS NULL
      AND (v_choice='SKIP' OR validation_errors='[]'::jsonb);
    IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_IMPORT_ROW_NOT_IMPORTABLE' USING ERRCODE='22023'; END IF;
  END LOOP;
  UPDATE hon.billing_import_batches SET version=version+1 WHERE id=b.id;
  RETURN hon.billing_import_finish(p_subject,s.actor,'decide',b.id,p_key,p_request,p_correlation,hon.billing_import_summary(b.id));
END $$;

-- One IMPORT row: the payer's account (reused or created), one DRAFT membership confirmed ACTIVE with its 0177 decision
-- and INITIAL effective period, one ACTIVE payment schedule, and an ISSUED opening-balance invoice when the balance is
-- above zero. Every match is re-checked first: anything that changed since staging stops the whole finalize as STALE.
CREATE FUNCTION hon.apply_billing_import_row(p_batch uuid,p_row integer,p_actor uuid,p_tz text,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); r hon.billing_import_rows%ROWTYPE; n jsonb;
  sp hon.student_profiles%ROWTYPE; acct hon.billing_accounts%ROWTYPE; m hon.memberships%ROWTYPE; updated hon.memberships%ROWTYPE; pr jsonb;
  s_on date; e_on date; start_at timestamptz; end_at timestamptz; decision uuid:=gen_random_uuid(); schedule uuid; invoice uuid;
  facts jsonb; receipt jsonb; instant timestamptz:=clock_timestamp(); payload jsonb;
BEGIN
  SELECT * INTO r FROM hon.billing_import_rows WHERE batch_id=p_batch AND row_index=p_row AND choice='IMPORT' AND validation_errors='[]'::jsonb
    AND membership_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_IMPORT_ROW_NOT_IMPORTABLE' USING ERRCODE='40001'; END IF;
  n:=r.normalized;
  SELECT * INTO sp FROM hon.student_profiles x WHERE x.id=r.matched_profile_id AND x.organization_id=org AND x.school_id=school FOR SHARE;
  IF NOT FOUND OR hon.billing_import_has_membership(sp.id) THEN RAISE EXCEPTION 'BILLING_IMPORT_STALE' USING ERRCODE='40001'; END IF;
  pr:=hon.billing_import_payer(sp.id,n,(SELECT b.school_today FROM hon.billing_import_batches b WHERE b.id=p_batch));
  IF pr->>'payer' IS DISTINCT FROM r.payer_person_id::text THEN RAISE EXCEPTION 'BILLING_IMPORT_STALE' USING ERRCODE='40001'; END IF;
  acct:=hon.billing_import_payer_account(r.payer_person_id);
  IF acct.id IS NOT NULL THEN
    -- The staged account must still be the canonical one (or none was staged and an earlier row of this batch made it).
    IF (r.billing_account_id IS NOT NULL AND acct.id<>r.billing_account_id) OR acct.currency::text<>n->>'currency' THEN
      RAISE EXCEPTION 'BILLING_IMPORT_STALE' USING ERRCODE='40001'; END IF;
    PERFORM 1 FROM hon.billing_accounts a WHERE a.id=acct.id FOR UPDATE;
  ELSE
    IF r.billing_account_id IS NOT NULL THEN RAISE EXCEPTION 'BILLING_IMPORT_STALE' USING ERRCODE='40001'; END IF;
    INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification)
      VALUES(org,school,r.payer_person_id,n->>'currency','CANONICAL') RETURNING * INTO acct;
  END IF;
  s_on:=hon.billing_import_date(n->>'startedOn'); e_on:=hon.billing_import_date(n->>'endsOn');
  start_at:=hon.membership_local_day_start(s_on,p_tz);
  end_at:=CASE WHEN e_on IS NULL THEN NULL ELSE hon.membership_local_day_start(e_on+1,p_tz) END;
  INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES(org,school,acct.id,sp.person_id,n->>'planCode','DRAFT',start_at,end_at) RETURNING * INTO m;
  -- 0177 evidence: identifiers, codes, dates and terms only (no names or free text).
  facts:=jsonb_build_object('source','GENERIC_LEGACY','origin','BILLING_IMPORT','batchId',p_batch,'rowIndex',p_row,
    'membershipId',m.id,'billingAccountId',acct.id,'participantPersonId',sp.person_id,'planCode',n->>'planCode','planMatched',(n->>'planMatched')::boolean,
    'importedTerms',jsonb_build_object('amountMinor',(n->>'amountMinor')::integer,'currency',n->>'currency','frequency',n->>'frequency',
      'nextChargeOn',n->>'nextChargeOn'),
    'suggestedDates',jsonb_build_object('startDate',n->>'startedOn','endDate',nullif(n->>'endsOn',''),'startBasis','IMPORTED',
      'endBasis',CASE WHEN e_on IS NULL THEN 'OPEN_ENDED' ELSE 'IMPORTED' END),
    'projection',jsonb_build_object('termStartedAt',hon.saas_ts(start_at),'termEndsAt',hon.saas_ts(end_at)),
    'requirementsNotEvaluated','["AGREEMENT","PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]'::jsonb);
  receipt:=jsonb_build_object('membershipId',m.id,'state','ACTIVE','version',2,'previousVersion',1,'decisionId',decision,
    'decisionBasis','STAFF_ACTIVATION_PRE_POLICY','membershipSource','GENERIC_LEGACY','origin','BILLING_IMPORT',
    'authorizingPermission','billing.membership.activate','overridePermission',NULL,
    'effectivePeriod',jsonb_build_object('periodVersion',1,'startDate',n->>'startedOn','endDate',nullif(n->>'endsOn',''),'endDateInclusive',true,
      'schoolTimezone',p_tz,'dateSource','SUGGESTED','termStartedAt',hon.saas_ts(start_at),'termEndsAt',hon.saas_ts(end_at)),
    'acknowledgedWarnings','[]'::jsonb,'overridesUsed','[]'::jsonb,'followUps','[]'::jsonb,'adultVerification',NULL,
    'reasonCode','LEGACY_MEMBERSHIP','requirementsNotEvaluated',facts->'requirementsNotEvaluated','recordedAt',hon.saas_ts(instant));
  INSERT INTO hon.membership_activation_decisions(id,organization_id,school_id,membership_id,prior_membership_version,next_membership_version,decision_basis,
      membership_source,actor_principal_id,authorizing_permission,override_permission,reason_code,reason_text,acknowledged_warnings,overrides,adult_verification,
      preview_digest,evaluated_facts,requirements_not_evaluated,idempotency_key,request_fingerprint,request_id,correlation_id,receipt,created_at)
    VALUES(decision,org,school,m.id,1,2,'STAFF_ACTIVATION_PRE_POLICY','GENERIC_LEGACY',p_actor,'billing.membership.activate',NULL,
      'LEGACY_MEMBERSHIP','Imported from the school''s previous system in a reviewed billing import.','[]'::jsonb,'[]'::jsonb,NULL,
      encode(sha256(convert_to(facts::text,'UTF8')),'hex'),facts,facts->'requirementsNotEvaluated',
      'billing-import:'||p_batch::text||':'||p_row::text,encode(sha256(convert_to(n::text,'UTF8')),'hex'),p_request,p_correlation,receipt,instant);
  INSERT INTO hon.membership_effective_periods(organization_id,school_id,membership_id,period_version,change_kind,start_date,end_date,school_timezone,
      term_started_at,term_ends_at,date_source,suggested_start_date,suggested_end_date,suggestion_basis,adjustment_reason,actor_principal_id,
      authorizing_permission,decision_id,created_at)
    VALUES(org,school,m.id,1,'INITIAL',s_on,e_on,p_tz,start_at,end_at,'SUGGESTED',s_on,e_on,
      jsonb_build_object('startBasis','IMPORTED','endBasis',CASE WHEN e_on IS NULL THEN 'OPEN_ENDED' ELSE 'IMPORTED' END),NULL,p_actor,
      'billing.membership.activate',decision,instant);
  UPDATE hon.memberships SET state='ACTIVE',version=version+1 WHERE id=m.id AND organization_id=org AND school_id=school AND state='DRAFT' AND version=1
    RETURNING * INTO updated;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,next_charge_at,auto_renew,status)
    VALUES(org,school,m.id,n->>'frequency',(n->>'amountMinor')::integer,n->>'currency',
      hon.membership_local_day_start(hon.billing_import_date(n->>'nextChargeOn'),p_tz),e_on IS NULL,'ACTIVE')
    RETURNING id INTO schedule;
  IF (n->>'balanceMinor')::integer>0 THEN
    INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,discount_minor,total_minor,due_at)
      VALUES(org,school,acct.id,m.id,'ISSUED',n->>'currency',(n->>'balanceMinor')::integer,0,(n->>'balanceMinor')::integer,
        hon.membership_local_day_start(hon.billing_import_date(n->>'balanceDueOn')+1,p_tz)-interval '1 second')
      RETURNING id INTO invoice;
  END IF;
  UPDATE hon.billing_import_rows SET billing_account_id=acct.id,membership_id=m.id,schedule_id=schedule,invoice_id=invoice WHERE batch_id=p_batch AND row_index=p_row;
  -- Identifiers only: never a name, plan name, amount or date in audit or outbox. Deliberately not the
  -- billing.membership.activated or invoice issued events, so no welcome, receipt or reminder automation reacts to an
  -- imported record as if it were new business.
  payload:=jsonb_build_object('batchId',p_batch,'rowIndex',p_row,'billingAccountId',acct.id,'membershipId',m.id,'decisionId',decision,
    'scheduleId',schedule,'invoiceId',invoice,'internalOnly',true);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','billing.import.row_applied','MEMBERSHIP',m.id,NULL,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.import.row_applied',1,'MEMBERSHIP',m.id,updated.version,p_correlation,p_request,payload);
END $$;

-- Input: exactly {batchId, expectedVersion, selectedIndices}. Every row must be decided, and the selection must equal
-- exactly the IMPORT rows, so nothing is imported that staff did not choose on this version.
CREATE FUNCTION hon.finalize_billing_import(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); s record; batch uuid; b hon.billing_import_batches%ROWTYPE; sel jsonb; expected jsonb; idx integer;
BEGIN
  batch:=hon.billing_import_batch_id(p_subject,p_input);
  SELECT * INTO s FROM hon.billing_import_begin(p_subject,'finalize',p_input,p_key,p_request,p_correlation);
  IF s.replay IS NOT NULL THEN RETURN jsonb_build_object('record',s.replay,'replayed',true); END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['batchId','expectedVersion','selectedIndices']
    OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p_input->'selectedIndices') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'selectedIndices')>1000
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'selectedIndices') x WHERE jsonb_typeof(x)<>'number' OR (x#>>'{}') !~ '^[1-9][0-9]{0,3}$')
    OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(p_input->'selectedIndices') x)<>jsonb_array_length(p_input->'selectedIndices') THEN
    RAISE EXCEPTION 'BILLING_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM hon.billing_import_batches WHERE id=batch AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF b.status<>'STAGED' OR b.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  SELECT coalesce(jsonb_agg(row_index ORDER BY row_index),'[]'::jsonb) INTO expected FROM hon.billing_import_rows WHERE batch_id=b.id AND choice='IMPORT';
  SELECT coalesce(jsonb_agg(x ORDER BY (x#>>'{}')::integer),'[]'::jsonb) INTO sel FROM jsonb_array_elements(p_input->'selectedIndices') x;
  IF sel<>expected OR EXISTS(SELECT 1 FROM hon.billing_import_rows WHERE batch_id=b.id AND choice IS NULL) THEN
    RAISE EXCEPTION 'BILLING_IMPORT_SELECTION_REQUIRED' USING ERRCODE='40001'; END IF;
  -- One billing finalize at a time per school, so two batches cannot both give one student a membership; each row is then
  -- re-checked against what is already there.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.billing_import:'||school::text,0));
  FOR idx IN SELECT row_index FROM hon.billing_import_rows WHERE batch_id=b.id AND choice='IMPORT' ORDER BY row_index LOOP
    PERFORM hon.apply_billing_import_row(b.id,idx,s.actor,b.school_timezone,p_request,p_correlation);
  END LOOP;
  UPDATE hon.billing_import_batches SET version=version+1,status='FINALIZED',finalized_at=clock_timestamp(),finalized_by_principal_id=s.actor WHERE id=b.id;
  RETURN hon.billing_import_finish(p_subject,s.actor,'finalize',b.id,p_key,p_request,p_correlation,hon.billing_import_summary(b.id));
END $$;

-- Reads need the same live import authority as the commands (rows hold names and amounts). The list carries the 25 most
-- recent batches and the field list; a detail read is one batch with its rows.
CREATE FUNCTION hon.read_billing_imports(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
  PERFORM hon.require_billing_import_actor(p_subject);
  SELECT jsonb_build_object('batches',coalesce(jsonb_agg(hon.billing_import_summary(x.id) ORDER BY x.created_at DESC,x.id),'[]'::jsonb),
    'fields',to_jsonb(hon.billing_import_fields()),'required',to_jsonb(hon.billing_import_required()),
    'maxBytes',262144,'maxRows',1000,'maxColumns',24) INTO result
  FROM (SELECT id,created_at FROM hon.billing_import_batches WHERE organization_id=org AND school_id=school ORDER BY created_at DESC,id LIMIT 25) x;
  RETURN result;
END $$;

CREATE FUNCTION hon.read_billing_import(p_subject text,p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_billing_import_actor(p_subject);
  IF p_batch IS NULL OR NOT EXISTS(SELECT 1 FROM hon.billing_import_batches WHERE id=p_batch AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()) THEN
    RAISE EXCEPTION 'BILLING_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.billing_import_detail(p_batch);
END $$;

COMMENT ON TABLE hon.billing_import_batches IS '0334 staged membership and balance imports (one CSV each). Private.';
COMMENT ON TABLE hon.billing_import_rows IS '0334 one staged row: matched student and payer, the staff choice, and the account, membership, schedule and invoice it created. Private.';
COMMENT ON TABLE hon.billing_import_requests IS '0334 exact-request idempotency for the billing import commands. Private.';
COMMENT ON FUNCTION hon.stage_billing_import(text,jsonb,text,uuid,uuid) IS 'Direct HUMAN_UI staging of a membership and balance CSV. Creates no membership, schedule or invoice.';
COMMENT ON FUNCTION hon.decide_billing_import(text,jsonb,text,uuid,uuid) IS 'Direct HUMAN_UI IMPORT or SKIP choice per staged row.';
COMMENT ON FUNCTION hon.finalize_billing_import(text,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI finalize: per IMPORT row an ACTIVE membership with 0177 evidence, an ACTIVE payment schedule and an optional ISSUED opening-balance invoice. No charge, processor call or message.';
COMMENT ON FUNCTION hon.read_billing_imports(text) IS 'Direct HUMAN_UI list of recent billing imports. No DML.';
COMMENT ON FUNCTION hon.read_billing_import(text,uuid) IS 'Direct HUMAN_UI read of one billing import with its rows. No DML.';

-- Deny first, then exactly the five entry points for the runtime role. No table privilege for any client role.
DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['billing_import_batches','billing_import_rows','billing_import_requests'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_billing_import()','hon.require_billing_import_actor(text)','hon.billing_import_fields()',
    'hon.billing_import_required()','hon.billing_import_date(text)','hon.billing_import_currency_supported(text)','hon.billing_import_money(text,text)','hon.billing_import_frequency(text)',
    'hon.billing_import_check_row(jsonb,jsonb,jsonb,date)','hon.billing_import_plan_code(text)','hon.billing_import_match_student(jsonb,jsonb)',
    'hon.billing_import_payer(uuid,jsonb,date)','hon.billing_import_has_membership(uuid)','hon.billing_import_summary(uuid)','hon.billing_import_detail(uuid)',
    'hon.billing_import_begin(text,text,jsonb,text,uuid,uuid)','hon.billing_import_finish(text,uuid,text,uuid,text,uuid,uuid,jsonb)',
    'hon.billing_import_batch_id(text,jsonb)','hon.billing_import_payer_account(uuid)',
    'hon.stage_billing_import(text,jsonb,text,uuid,uuid)','hon.decide_billing_import(text,jsonb,text,uuid,uuid)',
    'hon.apply_billing_import_row(uuid,integer,uuid,text,uuid,uuid)','hon.finalize_billing_import(text,jsonb,text,uuid,uuid)',
    'hon.read_billing_imports(text)','hon.read_billing_import(text,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.stage_billing_import(text,jsonb,text,uuid,uuid),hon.decide_billing_import(text,jsonb,text,uuid,uuid),
      hon.finalize_billing_import(text,jsonb,text,uuid,uuid),hon.read_billing_imports(text),hon.read_billing_import(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
