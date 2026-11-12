BEGIN;

-- B-TUI-2 piece 4 (0322, assigned by the coordinator 2026-11-12): autopay plans and sibling discounts with the school's own
-- payment processor (TEST mode only). Spec: docs/architecture/TUITION_COLLECTION.md section 13.
--   A1  A payer (hon.billing_accounts) has at most one open autopay plan (ACTIVE or PAUSED). The plan names one of the
--       payer's ACTIVE saved methods (0321) on a CONNECTED_ACTIVE connection that allows off-session recurring charges, and
--       keeps the consent text version the payer agreed to. A cancelled plan never changes again.
--   A2  The school's sibling discount is one append-only rule version, set by the school owner: NONE (unset means NONE),
--       PERCENT (whole percent 0-100) or FIXED (minor units in one currency) for the 2nd student and for the 3rd and later
--       students of one payer. Students are ranked by their largest due amount (then membership creation, then id); every
--       due line of a student gets that student's rank. A discount never exceeds the line amount; a FIXED rule only applies
--       to lines in its currency.
--   A3  Preparing a cycle for a date collects every due line of the payer: an ACTIVE membership with an ACTIVE WEEKLY,
--       MONTHLY or ANNUAL payment schedule in the payer's currency whose next charge falls on or before that school-local
--       date (at most seven days ahead). Each line becomes one ISSUED invoice (subtotal, sibling discount, total) due at the
--       end of that day in the school's time zone, and its schedule moves to the next period (none past the term end). One
--       schedule period is billed at most once. The cycle groups the invoices for one combined charge, which piece 5 sends;
--       nothing here contacts a processor or moves money.
--   A4  New sensitive staff-assignable permissions school_pay.autopay.manage and school_pay.discount.manage (system OWNER
--       roles first); the reads also accept school_pay.read. HQ, family and parent-type principals are refused.
-- HON takes no fee. The runtime gains no table privilege: every write is a direct-human SECURITY DEFINER command with live
-- school-scoped permission re-checks, exact-request idempotency, an append-only history row, audit and an inert outbox event.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'School autopay requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'School autopay requires a restricted runtime';
  END IF;
  IF to_regclass('hon.school_pay_methods') IS NULL OR to_regclass('hon.membership_payment_schedules') IS NULL
    OR to_regprocedure('hon.school_pay_args_ok(text,uuid,jsonb,text,uuid,uuid,text[],text[])') IS NULL
    OR to_regprocedure('hon.school_pay_method_json(hon.school_pay_methods)') IS NULL OR to_regprocedure('hon.school_pay_instant(timestamptz)') IS NULL
    OR to_regprocedure('hon.school_pay_lock_payer(uuid)') IS NULL OR to_regprocedure('hon.membership_pause_text_ok(jsonb,boolean)') IS NULL
    OR to_regprocedure('hon.membership_pause_date(jsonb)') IS NULL OR to_regprocedure('hon.membership_local_day_start(date,text)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL THEN
    RAISE EXCEPTION 'School autopay requires 0014, 0177, 0224, 0258 and 0321';
  END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('school_pay.autopay.manage','Turn a payer''s autopay on, change its saved method, pause, resume or cancel it, and prepare its tuition cycle invoices (test mode only)',true,true),
  ('school_pay.discount.manage','Set the school''s sibling discount for the 2nd and later students of one payer',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('school_pay.autopay.manage','school_pay.discount.manage') AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'School autopay permissions already exist with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,x.code FROM hon.roles r CROSS JOIN (VALUES ('school_pay.autopay.manage'),('school_pay.discount.manage')) x(code)
WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- A2: append-only sibling discount rule versions.
CREATE TABLE hon.school_pay_discount_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>=1),
  kind text NOT NULL CHECK (kind IN ('NONE','PERCENT','FIXED')),
  second_value integer,
  later_value integer,
  currency char(3),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind='NONE')=(second_value IS NULL) AND (second_value IS NULL)=(later_value IS NULL)),
  CHECK ((kind='FIXED')=(currency IS NOT NULL) AND (currency IS NULL OR currency ~ '^[A-Z]{3}$')),
  CHECK (kind<>'PERCENT' OR (second_value BETWEEN 0 AND 100 AND later_value BETWEEN 0 AND 100 AND second_value+later_value>0)),
  CHECK (kind<>'FIXED' OR (second_value BETWEEN 0 AND 100000000 AND later_value BETWEEN 0 AND 100000000 AND second_value+later_value>0)),
  UNIQUE (organization_id,school_id,version),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_pay_discount_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_discount_rules FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_discount_rules_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_discount_rules
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_discount_rules_no_truncate BEFORE TRUNCATE ON hon.school_pay_discount_rules
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- A1: one open autopay plan per payer.
CREATE TABLE hon.school_pay_autopay_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  method_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','PAUSED','CANCELLED')),
  consent_text_version text NOT NULL CHECK (consent_text_version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  ended_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  end_reason text CHECK (end_reason IS NULL OR (length(end_reason) BETWEEN 1 AND 1000 AND btrim(end_reason)=end_reason AND end_reason !~ '[\x01-\x1f\x7f]')),
  CHECK ((state='CANCELLED')=(ended_at IS NOT NULL) AND (ended_at IS NULL)=(ended_by_principal_id IS NULL) AND (ended_at IS NULL)=(end_reason IS NULL)),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (method_id,organization_id,school_id) REFERENCES hon.school_pay_methods(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX school_pay_autopay_plans_one_open_idx ON hon.school_pay_autopay_plans(billing_account_id) WHERE state<>'CANCELLED';
CREATE INDEX school_pay_autopay_plans_payer_idx ON hon.school_pay_autopay_plans(organization_id,school_id,billing_account_id,created_at);
ALTER TABLE hon.school_pay_autopay_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_autopay_plans FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_autopay_plans_no_truncate BEFORE TRUNCATE ON hon.school_pay_autopay_plans
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- A3: prepared cycles and their lines (one ISSUED invoice per line). Immutable here; piece 5 adds the charge state.
CREATE TABLE hon.school_pay_autopay_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  billing_account_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  method_id uuid NOT NULL,
  cycle_date date NOT NULL CHECK (cycle_date BETWEEN date '2000-01-01' AND date '2100-12-31'),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor>0),
  discount_minor bigint NOT NULL CHECK (discount_minor>=0 AND discount_minor<=subtotal_minor),
  total_minor bigint NOT NULL CHECK (total_minor=subtotal_minor-discount_minor),
  discount_rule_version integer CHECK (discount_rule_version IS NULL OR discount_rule_version>=1),
  line_count integer NOT NULL CHECK (line_count BETWEEN 1 AND 50),
  state text NOT NULL DEFAULT 'READY' CHECK (state='READY'),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (plan_id,organization_id,school_id) REFERENCES hon.school_pay_autopay_plans(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (method_id,organization_id,school_id) REFERENCES hon.school_pay_methods(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (billing_account_id,organization_id,school_id) REFERENCES hon.billing_accounts(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX school_pay_autopay_cycles_payer_idx ON hon.school_pay_autopay_cycles(organization_id,school_id,billing_account_id,created_at);
ALTER TABLE hon.school_pay_autopay_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_autopay_cycles FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_autopay_cycles_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_autopay_cycles
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_autopay_cycles_no_truncate BEFORE TRUNCATE ON hon.school_pay_autopay_cycles
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

CREATE TABLE hon.school_pay_autopay_cycle_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  period_at timestamptz NOT NULL,
  student_rank integer NOT NULL CHECK (student_rank BETWEEN 1 AND 50),
  amount_minor integer NOT NULL CHECK (amount_minor>0),
  discount_minor integer NOT NULL CHECK (discount_minor BETWEEN 0 AND amount_minor),
  invoice_id uuid NOT NULL UNIQUE,
  UNIQUE (schedule_id,period_at),
  FOREIGN KEY (cycle_id,organization_id,school_id) REFERENCES hon.school_pay_autopay_cycles(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (invoice_id,organization_id,school_id) REFERENCES hon.invoices(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (schedule_id,organization_id,school_id) REFERENCES hon.membership_payment_schedules(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX school_pay_autopay_cycle_lines_cycle_idx ON hon.school_pay_autopay_cycle_lines(cycle_id);
ALTER TABLE hon.school_pay_autopay_cycle_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_autopay_cycle_lines FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_autopay_cycle_lines_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_autopay_cycle_lines
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_autopay_cycle_lines_no_truncate BEFORE TRUNCATE ON hon.school_pay_autopay_cycle_lines
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Append-only history of every plan, cycle and rule command.
CREATE TABLE hon.school_pay_autopay_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  billing_account_id uuid,
  entity_type text NOT NULL CHECK (entity_type IN ('PLAN','CYCLE','RULE')),
  entity_id uuid NOT NULL,
  entity_version integer NOT NULL CHECK (entity_version>=1),
  kind text NOT NULL CHECK (kind IN ('PLAN_ENROLLED','PLAN_METHOD_CHANGED','PLAN_PAUSED','PLAN_RESUMED','PLAN_CANCELLED','CYCLE_PREPARED','RULE_SET')),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((entity_type='RULE')=(billing_account_id IS NULL)),
  UNIQUE (entity_id,entity_version,kind),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.school_pay_autopay_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_pay_autopay_events FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_pay_autopay_events_immutable BEFORE UPDATE OR DELETE ON hon.school_pay_autopay_events
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_pay_autopay_events_no_truncate BEFORE TRUNCATE ON hon.school_pay_autopay_events
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Settings-free plan guard, whoever writes: no delete; scope, payer, consent and creation facts never change; a cancelled
-- plan never changes again; every update bumps the version.
CREATE FUNCTION hon.guard_school_pay_autopay_plan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'ACTIVE' OR NEW.version<>1 THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_IMMUTABLE' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='CANCELLED' OR NEW.version<>OLD.version+1
    OR (NEW.id,NEW.organization_id,NEW.school_id,NEW.billing_account_id,NEW.consent_text_version,NEW.created_by_principal_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.school_id,OLD.billing_account_id,OLD.consent_text_version,OLD.created_by_principal_id,OLD.created_at) THEN
    RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_pay_autopay_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.school_pay_autopay_plans
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_pay_autopay_plan();

-- Live direct-human authority at the current school for one of the three autopay permissions, or a refusal (0258 identity rules).
CREATE FUNCTION hon.require_school_pay_autopay_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  denial text:=CASE permission WHEN 'school_pay.autopay.manage' THEN 'SCHOOL_PAY_AUTOPAY_FORBIDDEN' WHEN 'school_pay.discount.manage' THEN 'SCHOOL_PAY_DISCOUNT_FORBIDDEN' ELSE 'SCHOOL_PAY_READ_FORBIDDEN' END;
BEGIN
  IF permission IS NULL OR permission NOT IN ('school_pay.autopay.manage','school_pay.discount.manage','school_pay.read')
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

-- The first permission among the given ones that the subject holds live, or a read refusal.
CREATE FUNCTION hon.require_school_pay_autopay_reader(subject text,permissions text[]) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE permission text;
BEGIN
  FOREACH permission IN ARRAY permissions LOOP
    BEGIN PERFORM hon.require_school_pay_autopay_actor(subject,permission); RETURN permission;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  RAISE EXCEPTION 'SCHOOL_PAY_READ_FORBIDDEN' USING ERRCODE='42501';
END $$;

-- The current school's IANA time zone, or a refusal.
CREATE FUNCTION hon.school_pay_school_zone() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE tz text;
BEGIN
  SELECT s.timezone INTO tz FROM hon.schools s JOIN pg_timezone_names z ON z.name=s.timezone
  WHERE s.id=hon.current_school_id() AND s.organization_id=hon.current_organization_id();
  IF tz IS NULL THEN RAISE EXCEPTION 'SCHOOL_PAY_SCHOOL_TIME_ZONE_INVALID' USING ERRCODE='22023'; END IF;
  RETURN tz;
END $$;

CREATE FUNCTION hon.school_pay_discount_rule_json(r hon.school_pay_discount_rules) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('version',r.version,'kind',r.kind,'secondValue',r.second_value,'laterValue',r.later_value,
    'currency',r.currency::text,'createdAt',hon.school_pay_instant(r.created_at))
$$;

CREATE FUNCTION hon.school_pay_autopay_plan_json(a hon.school_pay_autopay_plans) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('planId',a.id,'billingAccountId',a.billing_account_id,'methodId',a.method_id,'state',a.state,
    'consentTextVersion',a.consent_text_version,'version',a.version,'createdAt',hon.school_pay_instant(a.created_at),
    'updatedAt',hon.school_pay_instant(a.updated_at),'endedAt',hon.school_pay_instant(a.ended_at),'endReason',a.end_reason)
$$;

-- The school's current sibling discount rule (NULL row when none was ever set).
CREATE FUNCTION hon.school_pay_current_discount_rule() RETURNS hon.school_pay_discount_rules
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT * FROM hon.school_pay_discount_rules r WHERE r.organization_id=hon.current_organization_id() AND r.school_id=hon.current_school_id()
  ORDER BY r.version DESC LIMIT 1
$$;

-- A2: the discount for one line at a student rank under a rule (never more than the line).
CREATE FUNCTION hon.school_pay_sibling_discount(r hon.school_pay_discount_rules,student_rank integer,amount integer,line_currency text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE
    WHEN r.kind IS NULL OR r.kind='NONE' OR student_rank<2 THEN 0
    WHEN r.kind='PERCENT' THEN floor(amount::numeric*(CASE WHEN student_rank=2 THEN r.second_value ELSE r.later_value END)/100)::integer
    WHEN r.kind='FIXED' AND r.currency::text=line_currency THEN least(amount,CASE WHEN student_rank=2 THEN r.second_value ELSE r.later_value END)
    ELSE 0 END
$$;

-- A3: one schedule's next period in school-local time (same local day and time), or NULL past the membership term end.
CREATE FUNCTION hon.school_pay_next_period(at timestamptz,frequency text,tz text,term_end timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN n IS NULL OR (term_end IS NOT NULL AND n>=term_end) THEN NULL ELSE n END FROM (
    SELECT ((at AT TIME ZONE tz)+CASE frequency WHEN 'WEEKLY' THEN interval '7 days' WHEN 'MONTHLY' THEN interval '1 month' WHEN 'ANNUAL' THEN interval '1 year' END) AT TIME ZONE tz AS n) x
$$;

-- A2/A3: the payer's due lines on or before a school-local date, ranked by student, with the rule's discount.
CREATE FUNCTION hon.school_pay_autopay_due(payer uuid,cycle_date date,tz text,r hon.school_pay_discount_rules)
RETURNS TABLE(membership_id uuid,schedule_id uuid,participant_person_id uuid,plan_code text,frequency text,period_at timestamptz,
  student_rank integer,amount_minor integer,discount_minor integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH due AS (
    SELECT m.id AS membership_id,s.id AS schedule_id,m.participant_person_id,m.plan_code,s.frequency,s.next_charge_at AS period_at,s.amount_minor,
      s.currency::text AS currency,m.created_at AS membership_created_at
    FROM hon.memberships m
    JOIN hon.billing_accounts b ON b.id=m.billing_account_id AND b.organization_id=m.organization_id AND b.school_id=m.school_id
    JOIN hon.membership_payment_schedules s ON s.membership_id=m.id AND s.organization_id=m.organization_id AND s.school_id=m.school_id
    WHERE m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id() AND m.billing_account_id=payer
      AND m.state='ACTIVE' AND s.status='ACTIVE' AND s.frequency IN ('WEEKLY','MONTHLY','ANNUAL') AND s.currency=b.currency
      AND s.next_charge_at IS NOT NULL AND (s.next_charge_at AT TIME ZONE tz)::date<=cycle_date
      AND NOT EXISTS(SELECT 1 FROM hon.school_pay_autopay_cycle_lines l WHERE l.schedule_id=s.id AND l.period_at=s.next_charge_at)
  ), students AS (
    SELECT d.participant_person_id,row_number() OVER (ORDER BY max(d.amount_minor) DESC,min(d.membership_created_at),min(d.membership_id::text))::integer AS student_rank
    FROM due d GROUP BY d.participant_person_id
  )
  SELECT d.membership_id,d.schedule_id,d.participant_person_id,d.plan_code,d.frequency,d.period_at,st.student_rank,d.amount_minor,
    hon.school_pay_sibling_discount(r,st.student_rank,d.amount_minor,d.currency)
  FROM due d JOIN students st ON st.participant_person_id=d.participant_person_id
  ORDER BY st.student_rank,d.amount_minor DESC,d.membership_id
$$;

CREATE FUNCTION hon.school_pay_autopay_cycle_json(c hon.school_pay_autopay_cycles) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('cycleId',c.id,'billingAccountId',c.billing_account_id,'planId',c.plan_id,'methodId',c.method_id,
    'cycleDate',to_char(c.cycle_date,'YYYY-MM-DD'),'currency',c.currency::text,'subtotalMinor',c.subtotal_minor,'discountMinor',c.discount_minor,
    'totalMinor',c.total_minor,'discountRuleVersion',c.discount_rule_version,'state',c.state,'createdAt',hon.school_pay_instant(c.created_at),
    'lines',coalesce((SELECT jsonb_agg(jsonb_build_object('membershipId',l.membership_id,'scheduleId',l.schedule_id,'periodAt',hon.school_pay_instant(l.period_at),
        'studentRank',l.student_rank,'amountMinor',l.amount_minor,'discountMinor',l.discount_minor,'invoiceId',l.invoice_id) ORDER BY l.student_rank,l.amount_minor DESC,l.membership_id)
      FROM hon.school_pay_autopay_cycle_lines l WHERE l.cycle_id=c.id),'[]'::jsonb))
$$;

-- A1: a saved method the plan may use: ACTIVE, the payer's own, on a CONNECTED_ACTIVE connection with recurring charges.
CREATE FUNCTION hon.school_pay_autopay_method_usable(method uuid,payer uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.school_pay_methods m JOIN hon.school_pay_connections c ON c.id=m.connection_id AND c.organization_id=m.organization_id AND c.school_id=m.school_id
    WHERE m.id=method AND m.billing_account_id=payer AND m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id()
      AND m.status='ACTIVE' AND c.state='CONNECTED_ACTIVE' AND (c.capabilities->>'offSessionRecurring')::boolean)
$$;

-- Shared idempotency for the autopay commands: reserve the key, take the IAM SHARE locks, re-check live authority, and
-- return the stored response on an exact replay (after one more authority check). NULL means: proceed with the write.
CREATE FUNCTION hon.school_pay_autopay_begin(subject text,permission text,key text,fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  actor:=hon.require_school_pay_autopay_actor(subject,permission);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_school_pay_autopay_actor(subject,permission) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF hon.require_school_pay_autopay_actor(subject,permission) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN prior.response_body;
END $$;

-- One history row with its audit row and inert outbox event.
CREATE FUNCTION hon.school_pay_autopay_record(actor uuid,payer uuid,entity_type text,entity_id uuid,entity_version integer,kind text,action text,
  prior_state jsonb,next_state jsonb,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  INSERT INTO hon.school_pay_autopay_events(organization_id,school_id,billing_account_id,entity_type,entity_id,entity_version,kind,snapshot,actor_principal_id)
    VALUES(org,school,payer,entity_type,entity_id,entity_version,kind,next_state,actor);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,'SCHOOL_PAY_AUTOPAY_'||entity_type,entity_id,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'school_pay.autopay.'||lower(kind),1,'SCHOOL_PAY_AUTOPAY_'||entity_type,entity_id,entity_version,correlation,request,next_state);
END $$;

-- Idempotency completion and a final authority check.
CREATE FUNCTION hon.school_pay_autopay_complete(subject text,permission text,key text,actor uuid,result jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND principal_id=actor AND idempotency_key=key;
  IF hon.require_school_pay_autopay_actor(subject,permission) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- Lock and load one current-school plan (after its payer), checking the expected version.
CREATE FUNCTION hon.school_pay_lock_autopay_plan(selected uuid,expected integer) RETURNS hon.school_pay_autopay_plans
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE a hon.school_pay_autopay_plans%ROWTYPE; payer uuid;
BEGIN
  SELECT x.billing_account_id INTO payer FROM hon.school_pay_autopay_plans x WHERE x.id=selected AND x.organization_id=hon.current_organization_id() AND x.school_id=hon.current_school_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.school_pay_lock_payer(payer);
  SELECT * INTO a FROM hon.school_pay_autopay_plans x WHERE x.id=selected FOR UPDATE;
  IF a.version<>expected THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN a;
END $$;

-- Read one payer's autopay: the open plan, recent cancelled plans, the payer's active saved methods (with whether autopay
-- can use them), the school's sibling discount rule, the next cycle preview (on or after today) and the 12 latest cycles.
CREATE FUNCTION hon.read_school_pay_autopay(subject text,payer uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; result jsonb; tz text; today date;
  rule hon.school_pay_discount_rules%ROWTYPE; earliest date; preview_date date; currency text;
BEGIN
  IF payer IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  used:=hon.require_school_pay_autopay_reader(subject,ARRAY['school_pay.autopay.manage','school_pay.read']); actor:=hon.require_school_pay_autopay_actor(subject,used);
  SELECT b.currency::text INTO currency FROM hon.billing_accounts b WHERE b.id=payer AND b.organization_id=org AND b.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_PAY_PAYER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  tz:=hon.school_pay_school_zone(); today:=(clock_timestamp() AT TIME ZONE tz)::date;
  rule:=hon.school_pay_current_discount_rule();
  SELECT min((d.period_at AT TIME ZONE tz)::date) INTO earliest FROM hon.school_pay_autopay_due(payer,date '2100-12-31',tz,rule) d;
  preview_date:=CASE WHEN earliest IS NULL THEN NULL ELSE greatest(earliest,today) END;
  result:=jsonb_build_object('billingAccountId',payer,'canManage',used='school_pay.autopay.manage','platformFee','NONE','currency',currency,
    'schoolToday',to_char(today,'YYYY-MM-DD'),
    'payerName',(SELECT left(btrim(pp.given_name||' '||pp.family_name),200) FROM hon.billing_accounts b JOIN hon.people pp ON pp.id=b.responsible_person_id WHERE b.id=payer),
    'plan',(SELECT hon.school_pay_autopay_plan_json(a) FROM hon.school_pay_autopay_plans a WHERE a.organization_id=org AND a.school_id=school AND a.billing_account_id=payer AND a.state<>'CANCELLED'),
    'pastPlans',coalesce((SELECT jsonb_agg(hon.school_pay_autopay_plan_json(a) ORDER BY a.ended_at DESC,a.id) FROM (
      SELECT * FROM hon.school_pay_autopay_plans x WHERE x.organization_id=org AND x.school_id=school AND x.billing_account_id=payer AND x.state='CANCELLED'
      ORDER BY x.ended_at DESC,x.id LIMIT 5) a),'[]'::jsonb),
    'methods',coalesce((SELECT jsonb_agg(jsonb_build_object('method',hon.school_pay_method_json(m),'autopayUsable',hon.school_pay_autopay_method_usable(m.id,payer))
        ORDER BY m.is_default DESC,m.created_at DESC,m.id)
      FROM hon.school_pay_methods m WHERE m.organization_id=org AND m.school_id=school AND m.billing_account_id=payer AND m.status='ACTIVE'),'[]'::jsonb),
    'discountRule',CASE WHEN rule.id IS NULL THEN NULL ELSE hon.school_pay_discount_rule_json(rule) END,
    'preview',CASE WHEN preview_date IS NULL THEN NULL ELSE (
      SELECT jsonb_build_object('cycleDate',to_char(preview_date,'YYYY-MM-DD'),'currency',currency,
        'subtotalMinor',sum(d.amount_minor),'discountMinor',sum(d.discount_minor),'totalMinor',sum(d.amount_minor)-sum(d.discount_minor),
        'lines',jsonb_agg(jsonb_build_object('membershipId',d.membership_id,'scheduleId',d.schedule_id,'planCode',d.plan_code,'frequency',d.frequency,
          'participantName',(SELECT left(btrim(pp.given_name||' '||pp.family_name),200) FROM hon.people pp WHERE pp.id=d.participant_person_id),
          'periodAt',hon.school_pay_instant(d.period_at),'studentRank',d.student_rank,'amountMinor',d.amount_minor,'discountMinor',d.discount_minor)
          ORDER BY d.student_rank,d.amount_minor DESC,d.membership_id))
      FROM hon.school_pay_autopay_due(payer,preview_date,tz,rule) d) END,
    'cycles',coalesce((SELECT jsonb_agg(hon.school_pay_autopay_cycle_json(c) ORDER BY c.created_at DESC,c.id) FROM (
      SELECT * FROM hon.school_pay_autopay_cycles x WHERE x.organization_id=org AND x.school_id=school AND x.billing_account_id=payer
      ORDER BY x.created_at DESC,x.id LIMIT 12) c),'[]'::jsonb));
  IF hon.require_school_pay_autopay_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Read the school's sibling discount rule and its ten latest versions.
CREATE FUNCTION hon.read_school_pay_discount_rule(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); used text; actor uuid; result jsonb; rule hon.school_pay_discount_rules%ROWTYPE;
BEGIN
  used:=hon.require_school_pay_autopay_reader(subject,ARRAY['school_pay.discount.manage','school_pay.autopay.manage','school_pay.read']); actor:=hon.require_school_pay_autopay_actor(subject,used);
  rule:=hon.school_pay_current_discount_rule();
  result:=jsonb_build_object('canManage',used='school_pay.discount.manage','rule',CASE WHEN rule.id IS NULL THEN NULL ELSE hon.school_pay_discount_rule_json(rule) END,
    'history',coalesce((SELECT jsonb_agg(hon.school_pay_discount_rule_json(r) ORDER BY r.version DESC) FROM (
      SELECT * FROM hon.school_pay_discount_rules x WHERE x.organization_id=org AND x.school_id=school ORDER BY x.version DESC LIMIT 10) r),'[]'::jsonb));
  IF hon.require_school_pay_autopay_actor(subject,used) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SCHOOL_PAY_READ_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- A2: set the sibling discount. basedOnVersion is the version the owner saw (0 when none was set); a new version is added.
CREATE FUNCTION hon.set_school_pay_discount_rule(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; current_rule hon.school_pay_discount_rules%ROWTYPE; r hon.school_pay_discount_rules%ROWTYPE; kind text; result jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,NULL,p,key,request,correlation,ARRAY['basedOnVersion','kind'],ARRAY['basedOnVersion','kind','secondValue','laterValue','currency'])
    OR jsonb_typeof(p->'basedOnVersion') IS DISTINCT FROM 'number' OR (p->'basedOnVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p->'kind') IS DISTINCT FROM 'string' OR p->>'kind' NOT IN ('NONE','PERCENT','FIXED') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  kind:=p->>'kind';
  IF (kind='NONE' AND (p ? 'secondValue' OR p ? 'laterValue' OR p ? 'currency'))
    OR (kind<>'NONE' AND NOT (p ?& ARRAY['secondValue','laterValue']))
    OR (kind<>'NONE' AND (jsonb_typeof(p->'secondValue') IS DISTINCT FROM 'number' OR (p->'secondValue')::text !~ '^(0|[1-9][0-9]{0,8})$'
      OR jsonb_typeof(p->'laterValue') IS DISTINCT FROM 'number' OR (p->'laterValue')::text !~ '^(0|[1-9][0-9]{0,8})$'
      OR (p->>'secondValue')::bigint+(p->>'laterValue')::bigint=0))
    OR (kind='PERCENT' AND (p ? 'currency' OR (p->>'secondValue')::bigint>100 OR (p->>'laterValue')::bigint>100))
    OR (kind='FIXED' AND (jsonb_typeof(p->'currency') IS DISTINCT FROM 'string' OR p->>'currency' !~ '^[A-Z]{3}$'
      OR (p->>'secondValue')::bigint>100000000 OR (p->>'laterValue')::bigint>100000000)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.discount.set','input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_autopay_begin(subject,'school_pay.discount.manage',key,fp);
  actor:=hon.require_school_pay_autopay_actor(subject,'school_pay.discount.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  -- One rule writer at a time per school.
  PERFORM 1 FROM hon.schools s WHERE s.id=hon.current_school_id() AND s.organization_id=hon.current_organization_id() FOR NO KEY UPDATE;
  current_rule:=hon.school_pay_current_discount_rule();
  IF coalesce(current_rule.version,0)<>(p->>'basedOnVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF current_rule.id IS NULL AND kind='NONE' THEN RAISE EXCEPTION 'SCHOOL_PAY_DISCOUNT_UNCHANGED' USING ERRCODE='40001'; END IF;
  IF current_rule.id IS NOT NULL AND (current_rule.kind,current_rule.second_value,current_rule.later_value,current_rule.currency::text)
    IS NOT DISTINCT FROM (kind,(p->>'secondValue')::integer,(p->>'laterValue')::integer,p->>'currency') THEN
    RAISE EXCEPTION 'SCHOOL_PAY_DISCOUNT_UNCHANGED' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.school_pay_discount_rules(organization_id,school_id,version,kind,second_value,later_value,currency,created_by_principal_id)
    VALUES(hon.current_organization_id(),hon.current_school_id(),coalesce(current_rule.version,0)+1,kind,(p->>'secondValue')::integer,(p->>'laterValue')::integer,
      (p->>'currency')::char(3),actor) RETURNING * INTO r;
  PERFORM hon.school_pay_autopay_record(actor,NULL,'RULE',r.id,r.version,'RULE_SET','school_pay.discount.set',
    CASE WHEN current_rule.id IS NULL THEN NULL ELSE hon.school_pay_discount_rule_json(current_rule) END,hon.school_pay_discount_rule_json(r),request,correlation);
  result:=jsonb_build_object('rule',hon.school_pay_discount_rule_json(r));
  RETURN hon.school_pay_autopay_complete(subject,'school_pay.discount.manage',key,actor,result);
END $$;

-- A1: turn autopay on for one payer with one usable saved method and the payer's consent version.
CREATE FUNCTION hon.enroll_school_pay_autopay(subject text,payer uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; a hon.school_pay_autopay_plans%ROWTYPE; result jsonb;
BEGIN
  IF payer IS NULL OR NOT hon.school_pay_args_ok(subject,payer,p,key,request,correlation,ARRAY['methodId','consentTextVersion'],ARRAY['methodId','consentTextVersion'])
    OR jsonb_typeof(p->'methodId') IS DISTINCT FROM 'string' OR p->>'methodId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'consentTextVersion') IS DISTINCT FROM 'string' OR p->>'consentTextVersion' !~ '^[a-z0-9][a-z0-9._-]{0,39}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.autopay.enroll','billingAccountId',payer,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_autopay_begin(subject,'school_pay.autopay.manage',key,fp);
  actor:=hon.require_school_pay_autopay_actor(subject,'school_pay.autopay.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  PERFORM hon.school_pay_lock_payer(payer);
  IF EXISTS(SELECT 1 FROM hon.school_pay_autopay_plans x WHERE x.billing_account_id=payer AND x.state<>'CANCELLED') THEN
    RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_EXISTS' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM hon.school_pay_methods m WHERE m.id=(p->>'methodId')::uuid AND m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id() FOR SHARE;
  IF NOT hon.school_pay_autopay_method_usable((p->>'methodId')::uuid,payer) THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.school_pay_autopay_plans(organization_id,school_id,billing_account_id,method_id,consent_text_version,created_by_principal_id)
    VALUES(hon.current_organization_id(),hon.current_school_id(),payer,(p->>'methodId')::uuid,p->>'consentTextVersion',actor) RETURNING * INTO a;
  PERFORM hon.school_pay_autopay_record(actor,payer,'PLAN',a.id,a.version,'PLAN_ENROLLED','school_pay.autopay.enroll',NULL,hon.school_pay_autopay_plan_json(a),request,correlation);
  result:=jsonb_build_object('plan',hon.school_pay_autopay_plan_json(a));
  RETURN hon.school_pay_autopay_complete(subject,'school_pay.autopay.manage',key,actor,result);
END $$;

-- A1: change the plan's saved method, pause, resume or cancel it. One function per command keeps the API exact.
CREATE FUNCTION hon.change_school_pay_autopay_method(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; a hon.school_pay_autopay_plans%ROWTYPE; prior jsonb; result jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','methodId'],ARRAY['expectedVersion','methodId'])
    OR jsonb_typeof(p->'methodId') IS DISTINCT FROM 'string' OR p->>'methodId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.autopay.method','planId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_autopay_begin(subject,'school_pay.autopay.manage',key,fp);
  actor:=hon.require_school_pay_autopay_actor(subject,'school_pay.autopay.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  a:=hon.school_pay_lock_autopay_plan(selected,(p->>'expectedVersion')::integer);
  IF a.state='CANCELLED' OR a.method_id=(p->>'methodId')::uuid THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_STATE' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM hon.school_pay_methods m WHERE m.id=(p->>'methodId')::uuid AND m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id() FOR SHARE;
  IF NOT hon.school_pay_autopay_method_usable((p->>'methodId')::uuid,a.billing_account_id) THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE' USING ERRCODE='22023'; END IF;
  prior:=hon.school_pay_autopay_plan_json(a);
  UPDATE hon.school_pay_autopay_plans SET version=version+1,method_id=(p->>'methodId')::uuid,updated_at=clock_timestamp() WHERE id=a.id RETURNING * INTO a;
  PERFORM hon.school_pay_autopay_record(actor,a.billing_account_id,'PLAN',a.id,a.version,'PLAN_METHOD_CHANGED','school_pay.autopay.method',prior,hon.school_pay_autopay_plan_json(a),request,correlation);
  result:=jsonb_build_object('plan',hon.school_pay_autopay_plan_json(a));
  RETURN hon.school_pay_autopay_complete(subject,'school_pay.autopay.manage',key,actor,result);
END $$;

CREATE FUNCTION hon.set_school_pay_autopay_state(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; a hon.school_pay_autopay_plans%ROWTYPE; prior jsonb; result jsonb; target text;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','state'],ARRAY['expectedVersion','state'])
    OR jsonb_typeof(p->'state') IS DISTINCT FROM 'string' OR p->>'state' NOT IN ('ACTIVE','PAUSED') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=p->>'state';
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.autopay.state','planId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_autopay_begin(subject,'school_pay.autopay.manage',key,fp);
  actor:=hon.require_school_pay_autopay_actor(subject,'school_pay.autopay.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  a:=hon.school_pay_lock_autopay_plan(selected,(p->>'expectedVersion')::integer);
  IF a.state='CANCELLED' OR a.state=target THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_STATE' USING ERRCODE='40001'; END IF;
  IF target='ACTIVE' THEN
    PERFORM 1 FROM hon.school_pay_methods m WHERE m.id=a.method_id FOR SHARE;
    IF NOT hon.school_pay_autopay_method_usable(a.method_id,a.billing_account_id) THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE' USING ERRCODE='22023'; END IF;
  END IF;
  prior:=hon.school_pay_autopay_plan_json(a);
  UPDATE hon.school_pay_autopay_plans SET version=version+1,state=target,updated_at=clock_timestamp() WHERE id=a.id RETURNING * INTO a;
  PERFORM hon.school_pay_autopay_record(actor,a.billing_account_id,'PLAN',a.id,a.version,CASE target WHEN 'PAUSED' THEN 'PLAN_PAUSED' ELSE 'PLAN_RESUMED' END,
    CASE target WHEN 'PAUSED' THEN 'school_pay.autopay.pause' ELSE 'school_pay.autopay.resume' END,prior,hon.school_pay_autopay_plan_json(a),request,correlation);
  result:=jsonb_build_object('plan',hon.school_pay_autopay_plan_json(a));
  RETURN hon.school_pay_autopay_complete(subject,'school_pay.autopay.manage',key,actor,result);
END $$;

CREATE FUNCTION hon.cancel_school_pay_autopay(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; a hon.school_pay_autopay_plans%ROWTYPE; prior jsonb; result jsonb;
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','reason'],ARRAY['expectedVersion','reason'])
    OR NOT hon.membership_pause_text_ok(p->'reason',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.autopay.cancel','planId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_autopay_begin(subject,'school_pay.autopay.manage',key,fp);
  actor:=hon.require_school_pay_autopay_actor(subject,'school_pay.autopay.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  a:=hon.school_pay_lock_autopay_plan(selected,(p->>'expectedVersion')::integer);
  IF a.state='CANCELLED' THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_STATE' USING ERRCODE='40001'; END IF;
  prior:=hon.school_pay_autopay_plan_json(a);
  UPDATE hon.school_pay_autopay_plans SET version=version+1,state='CANCELLED',updated_at=clock_timestamp(),ended_at=clock_timestamp(),ended_by_principal_id=actor,end_reason=p->>'reason'
    WHERE id=a.id RETURNING * INTO a;
  PERFORM hon.school_pay_autopay_record(actor,a.billing_account_id,'PLAN',a.id,a.version,'PLAN_CANCELLED','school_pay.autopay.cancel',prior,hon.school_pay_autopay_plan_json(a),request,correlation);
  result:=jsonb_build_object('plan',hon.school_pay_autopay_plan_json(a));
  RETURN hon.school_pay_autopay_complete(subject,'school_pay.autopay.manage',key,actor,result);
END $$;

-- A3: prepare one cycle for an ACTIVE plan: one ISSUED invoice per due line with its sibling discount, schedules moved on.
CREATE FUNCTION hon.prepare_school_pay_autopay_cycle(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; fp text; replay jsonb; a hon.school_pay_autopay_plans%ROWTYPE; c hon.school_pay_autopay_cycles%ROWTYPE; rule hon.school_pay_discount_rules%ROWTYPE;
  tz text; today date; day date; due_at timestamptz; currency text; line record; invoice uuid; n integer:=0; sub bigint:=0; disc bigint:=0; result jsonb;
  org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF NOT hon.school_pay_args_ok(subject,selected,p,key,request,correlation,ARRAY['expectedVersion','cycleDate'],ARRAY['expectedVersion','cycleDate']) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  day:=hon.membership_pause_date(p->'cycleDate');
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','school_pay.autopay.cycle','planId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.school_pay_autopay_begin(subject,'school_pay.autopay.manage',key,fp);
  actor:=hon.require_school_pay_autopay_actor(subject,'school_pay.autopay.manage');
  IF replay IS NOT NULL THEN RETURN jsonb_build_object('receipt',replay,'replayed',true); END IF;
  tz:=hon.school_pay_school_zone(); today:=(clock_timestamp() AT TIME ZONE tz)::date;
  IF day>today+7 THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_TOO_EARLY' USING ERRCODE='22023'; END IF;
  a:=hon.school_pay_lock_autopay_plan(selected,(p->>'expectedVersion')::integer);
  IF a.state<>'ACTIVE' THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_STATE' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM hon.school_pay_methods m WHERE m.id=a.method_id FOR SHARE;
  IF NOT hon.school_pay_autopay_method_usable(a.method_id,a.billing_account_id) THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE' USING ERRCODE='22023'; END IF;
  -- The rule, the payer's memberships and their schedules are held for this command (the payer row is already locked).
  PERFORM 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org FOR SHARE;
  rule:=hon.school_pay_current_discount_rule();
  PERFORM 1 FROM hon.memberships m WHERE m.billing_account_id=a.billing_account_id AND m.organization_id=org AND m.school_id=school ORDER BY m.id FOR SHARE;
  PERFORM 1 FROM hon.membership_payment_schedules s JOIN hon.memberships m ON m.id=s.membership_id
    WHERE m.billing_account_id=a.billing_account_id AND s.organization_id=org AND s.school_id=school ORDER BY s.id FOR UPDATE OF s;
  SELECT b.currency::text INTO currency FROM hon.billing_accounts b WHERE b.id=a.billing_account_id;
  due_at:=hon.membership_local_day_start(day+1,tz)-interval '1 second';
  SELECT count(*),coalesce(sum(d.amount_minor),0),coalesce(sum(d.discount_minor),0) INTO n,sub,disc FROM hon.school_pay_autopay_due(a.billing_account_id,day,tz,rule) d;
  IF n=0 THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_NOTHING_DUE' USING ERRCODE='40001'; END IF;
  IF n>50 THEN RAISE EXCEPTION 'SCHOOL_PAY_AUTOPAY_TOO_MANY_LINES' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.school_pay_autopay_cycles(organization_id,school_id,billing_account_id,plan_id,method_id,cycle_date,currency,subtotal_minor,discount_minor,total_minor,
    discount_rule_version,line_count,created_by_principal_id)
    VALUES(org,school,a.billing_account_id,a.id,a.method_id,day,currency,sub,disc,sub-disc,
      CASE WHEN rule.id IS NULL OR rule.kind='NONE' THEN NULL ELSE rule.version END,n,actor) RETURNING * INTO c;
  FOR line IN SELECT d.*,m.term_ends_at FROM hon.school_pay_autopay_due(a.billing_account_id,day,tz,rule) d JOIN hon.memberships m ON m.id=d.membership_id LOOP
    INSERT INTO hon.invoices(organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,discount_minor,total_minor,due_at)
      VALUES(org,school,a.billing_account_id,line.membership_id,'ISSUED',currency,line.amount_minor,line.discount_minor,line.amount_minor-line.discount_minor,due_at)
      RETURNING id INTO invoice;
    INSERT INTO hon.school_pay_autopay_cycle_lines(organization_id,school_id,cycle_id,membership_id,schedule_id,period_at,student_rank,amount_minor,discount_minor,invoice_id)
      VALUES(org,school,c.id,line.membership_id,line.schedule_id,line.period_at,line.student_rank,line.amount_minor,line.discount_minor,invoice);
    UPDATE hon.membership_payment_schedules SET next_charge_at=hon.school_pay_next_period(line.period_at,line.frequency,tz,line.term_ends_at),updated_at=clock_timestamp()
      WHERE id=line.schedule_id;
    INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
      VALUES(org,school,actor,'HUMAN_UI','school_pay.autopay.invoice','INVOICE',invoice,NULL,
        jsonb_build_object('invoiceId',invoice,'cycleId',c.id,'membershipId',line.membership_id,'status','ISSUED','currency',currency,'subtotalMinor',line.amount_minor,
          'discountMinor',line.discount_minor,'totalMinor',line.amount_minor-line.discount_minor,'dueAt',hon.school_pay_instant(due_at)),'SUCCEEDED',request,correlation);
  END LOOP;
  PERFORM hon.school_pay_autopay_record(actor,a.billing_account_id,'CYCLE',c.id,1,'CYCLE_PREPARED','school_pay.autopay.cycle',NULL,hon.school_pay_autopay_cycle_json(c),request,correlation);
  result:=jsonb_build_object('cycle',hon.school_pay_autopay_cycle_json(c));
  RETURN hon.school_pay_autopay_complete(subject,'school_pay.autopay.manage',key,actor,result);
END $$;

COMMENT ON TABLE hon.school_pay_discount_rules IS
'0322 append-only sibling discount rule versions per school (NONE, PERCENT or FIXED for the 2nd and the 3rd+ student of one payer). Private.';
COMMENT ON TABLE hon.school_pay_autopay_plans IS
'0322 one open autopay plan per payer naming one usable saved method and the payer''s consent version; a cancelled plan is final. Private.';
COMMENT ON TABLE hon.school_pay_autopay_cycles IS
'0322 prepared autopay cycles: the payer''s due lines on one school day grouped for one combined charge (piece 5 sends it). Private.';
COMMENT ON TABLE hon.school_pay_autopay_cycle_lines IS
'0322 one cycle line per billed schedule period, with its student rank, sibling discount and ISSUED invoice. Private.';
COMMENT ON TABLE hon.school_pay_autopay_events IS
'0322 append-only history of every autopay plan, cycle and discount rule command. Private.';
COMMENT ON FUNCTION hon.read_school_pay_autopay(text,uuid) IS
'Direct HUMAN_UI read of one payer''s autopay plan, usable methods, sibling discount, next cycle preview and recent cycles. No DML.';
COMMENT ON FUNCTION hon.read_school_pay_discount_rule(text) IS
'Direct HUMAN_UI read of the school''s sibling discount rule and its latest versions. No DML.';
COMMENT ON FUNCTION hon.set_school_pay_discount_rule(text,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI new version of the school''s sibling discount rule (school_pay.discount.manage).';
COMMENT ON FUNCTION hon.enroll_school_pay_autopay(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI autopay enrollment of one payer with a usable saved method and consent version. No charge.';
COMMENT ON FUNCTION hon.change_school_pay_autopay_method(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI change of an open autopay plan''s saved method.';
COMMENT ON FUNCTION hon.set_school_pay_autopay_state(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI pause or resume of an open autopay plan.';
COMMENT ON FUNCTION hon.cancel_school_pay_autopay(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI cancellation of an autopay plan with a reason. Records are kept.';
COMMENT ON FUNCTION hon.prepare_school_pay_autopay_cycle(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI preparation of one autopay cycle: ISSUED invoices with sibling discounts and next schedule periods. No charge or message.';

DO $$ DECLARE r text; col text; t text;
  private_fns text:='hon.guard_school_pay_autopay_plan(),hon.require_school_pay_autopay_actor(text,text),hon.require_school_pay_autopay_reader(text,text[]),
    hon.school_pay_school_zone(),hon.school_pay_discount_rule_json(hon.school_pay_discount_rules),hon.school_pay_autopay_plan_json(hon.school_pay_autopay_plans),
    hon.school_pay_current_discount_rule(),hon.school_pay_sibling_discount(hon.school_pay_discount_rules,integer,integer,text),
    hon.school_pay_next_period(timestamptz,text,text,timestamptz),hon.school_pay_autopay_due(uuid,date,text,hon.school_pay_discount_rules),
    hon.school_pay_autopay_cycle_json(hon.school_pay_autopay_cycles),hon.school_pay_autopay_method_usable(uuid,uuid),hon.school_pay_autopay_begin(text,text,text,text),
    hon.school_pay_autopay_record(uuid,uuid,text,uuid,integer,text,text,jsonb,jsonb,uuid,uuid),hon.school_pay_autopay_complete(text,text,text,uuid,jsonb),
    hon.school_pay_lock_autopay_plan(uuid,integer)';
  entry_fns text:='hon.read_school_pay_autopay(text,uuid),hon.read_school_pay_discount_rule(text),hon.set_school_pay_discount_rule(text,jsonb,text,uuid,uuid),
    hon.enroll_school_pay_autopay(text,uuid,jsonb,text,uuid,uuid),hon.change_school_pay_autopay_method(text,uuid,jsonb,text,uuid,uuid),
    hon.set_school_pay_autopay_state(text,uuid,jsonb,text,uuid,uuid),hon.cancel_school_pay_autopay(text,uuid,jsonb,text,uuid,uuid),
    hon.prepare_school_pay_autopay_cycle(text,uuid,jsonb,text,uuid,uuid)';
  tables text[]:=ARRAY['school_pay_discount_rules','school_pay_autopay_plans','school_pay_autopay_cycles','school_pay_autopay_cycle_lines','school_pay_autopay_events'];
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
    FOREACH t IN ARRAY ARRAY['hon.school_pay_discount_rules','hon.school_pay_autopay_plans','hon.school_pay_autopay_cycles','hon.school_pay_autopay_cycle_lines','hon.school_pay_autopay_events'] LOOP
      IF has_table_privilege('hon_runtime',t,'SELECT') OR has_any_column_privilege('hon_runtime',t,'SELECT') OR has_table_privilege('hon_runtime',t,'INSERT')
        OR has_table_privilege('hon_runtime',t,'UPDATE') OR has_table_privilege('hon_runtime',t,'DELETE') THEN
        RAISE EXCEPTION 'School autopay must not widen runtime privileges';
      END IF;
    END LOOP;
  END IF;
END $$;
COMMIT;
