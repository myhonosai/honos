BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Membership activation gate requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Membership activation gate requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.crm_adult_membership_draft_is_current(uuid)') IS NULL
    OR to_regprocedure('hon.crm_guardian_child_membership_draft_current(uuid)') IS NULL
    OR to_regprocedure('hon.membership_plan_version_summary(uuid,integer)') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regclass('hon.work_items') IS NULL OR to_regclass('hon.human_work_history') IS NULL THEN
    RAISE EXCEPTION 'Membership activation gate requires 0084, 0174, 0175 and 0176';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Membership activation gate expects hon.memberships to have no user triggers yet';
  END IF;
END $$;

-- E1a membership activation gate (owner decisions D3, D13, D29, D29a, D30, D30a, D37, D40, D40a, D41 option C).
-- Activation becomes a two-step, direct-human, school-scoped decision with immutable evidence:
--   server preview (read-only, digest of every evaluated fact)
--   -> explicit confirmation (exact dates, acknowledged warnings, documented overrides, reason, final confirmation)
--   -> one decision row + one initial effective-period row + the DRAFT->ACTIVE transition, all in one transaction.
-- The runtime loses every UPDATE on hon.memberships and may INSERT only the seven approved DRAFT columns (state and
-- version come from their defaults). A settings-free transition trigger allows a DRAFT->ACTIVE change only when the
-- matching decision and period rows already exist in the same transaction, so no session/transaction marker can
-- authorize a transition. Cancellation moves to a protected function with the unchanged public contract.
-- ACTIVE means "confirmed by staff", not "benefits available now": the effective status (SCHEDULED, IN_EFFECT, ENDED,
-- CANCELLED) is derived from the confirmed dates in the school timezone. The end date is inclusive (last day of
-- membership); its timestamp projection is the start of the next local day.
-- Nothing here creates or evaluates an agreement, consent, mandate, payer designation, payment, payment method,
-- schedule, invoice, refund, provider call, communication, SaaS billing or entitlement effect, or any Action
-- Engine/AI capability. Those requirements are recorded as not evaluated on every decision.

-- D30a: three new school-scoped permissions. They are initially assigned exactly to every role that already holds
-- billing.membership.activate (school owners and staff already authorized to activate) and to system OWNER roles;
-- never to other roles. Revocation is the existing staff-role grant revocation or role permission removal, which
-- every operation re-checks live under lock. rules.manage and change.approve are reserved for E1c and are not used
-- by any function in this migration.
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('billing.membership.activation.override','Human documented override of an overridable membership activation warning at one school',true,true),
  ('billing.membership.rules.manage','Human management of school membership activation rules (reserved for E1c, unused)',true,true),
  ('billing.membership.change.approve','Human approval of another staff member''s membership change (reserved for E1c, unused; requester must differ from approver)',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('billing.membership.activation.override','billing.membership.rules.manage','billing.membership.change.approve')
      AND is_sensitive AND is_staff_assignable)<>3 THEN
    RAISE EXCEPTION 'Membership activation permissions already exist with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT DISTINCT holder.role_id,holder.organization_id,granted.code
FROM (SELECT rp.role_id,rp.organization_id FROM hon.role_permissions rp WHERE rp.permission_code='billing.membership.activate'
      UNION SELECT r.id,r.organization_id FROM hon.roles r WHERE r.is_system_role AND r.code='OWNER') holder
CROSS JOIN (VALUES ('billing.membership.activation.override'),('billing.membership.rules.manage'),('billing.membership.change.approve')) granted(code)
ON CONFLICT DO NOTHING;

-- One immutable decision per activated membership. STAFF_ACTIVATION_PRE_POLICY is the only basis until E7 (D37)
-- retires it per school; reason text and the evaluated facts stay private (no runtime grant, forced RLS).
CREATE TABLE hon.membership_activation_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL UNIQUE,
  prior_membership_version integer NOT NULL CHECK (prior_membership_version>=1),
  next_membership_version integer NOT NULL,
  decision_basis text NOT NULL CHECK (decision_basis IN ('STAFF_ACTIVATION_PRE_POLICY')),
  membership_source text NOT NULL CHECK (membership_source IN ('GENERIC_LEGACY','OWNER_LAUNCH','CRM_ADULT_FREE_TEXT','CRM_ADULT_PLAN','CRM_GUARDIAN_CHILD_PLAN')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  authorizing_permission text NOT NULL CHECK (authorizing_permission='billing.membership.activate'),
  override_permission text CHECK (override_permission IS NULL OR override_permission='billing.membership.activation.override'),
  reason_code text NOT NULL CHECK (reason_code IN ('ROUTINE_ENROLLMENT','DOCUMENTS_PENDING','PAPER_RECORDS_HELD_BY_SCHOOL','PAYMENT_HANDLED_OUTSIDE_HON',
    'LEGACY_MEMBERSHIP','SCHOLARSHIP_OR_COMP','STAFF_FAMILY','OTHER')),
  reason_text text CHECK (reason_text IS NULL OR (length(reason_text) BETWEEN 1 AND 500 AND btrim(reason_text)=reason_text AND reason_text !~ '[[:cntrl:]]')),
  acknowledged_warnings jsonb NOT NULL CHECK (jsonb_typeof(acknowledged_warnings)='array'),
  overrides jsonb NOT NULL CHECK (jsonb_typeof(overrides)='array'),
  adult_verification jsonb CHECK (adult_verification IS NULL OR jsonb_typeof(adult_verification)='object'),
  preview_digest text NOT NULL CHECK (preview_digest ~ '^[a-f0-9]{64}$'),
  evaluated_facts jsonb NOT NULL CHECK (jsonb_typeof(evaluated_facts)='object'),
  requirements_not_evaluated jsonb NOT NULL CHECK (requirements_not_evaluated='["AGREEMENT","PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]'::jsonb),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200 AND btrim(idempotency_key)=idempotency_key),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (next_membership_version=prior_membership_version+1),
  CHECK ((override_permission IS NULL)=(overrides='[]'::jsonb)),
  CHECK (reason_code<>'OTHER' OR reason_text IS NOT NULL),
  UNIQUE(id,organization_id,school_id),
  UNIQUE(organization_id,school_id,actor_principal_id,idempotency_key),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT
);

-- Immutable effective-period evidence. E1a writes only the INITIAL period (version 1) at activation; E1b adds
-- revisions as new versions, never by changing a row. Dates are school-local calendar dates; end_date is the
-- inclusive last day and NULL means open-ended. term_started_at/term_ends_at are the exact projected instants.
CREATE TABLE hon.membership_effective_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  period_version integer NOT NULL CHECK (period_version>=1),
  change_kind text NOT NULL CHECK (change_kind IN ('INITIAL','CORRECTION','EXTENSION','EARLY_END')),
  start_date date NOT NULL CHECK (start_date>=date '2000-01-01'),
  end_date date,
  school_timezone text NOT NULL CHECK (length(school_timezone) BETWEEN 1 AND 64),
  term_started_at timestamptz NOT NULL,
  term_ends_at timestamptz,
  date_source text NOT NULL CHECK (date_source IN ('SUGGESTED','STAFF_ADJUSTED')),
  suggested_start_date date NOT NULL,
  suggested_end_date date,
  suggestion_basis jsonb NOT NULL CHECK (jsonb_typeof(suggestion_basis)='object'),
  adjustment_reason text CHECK (adjustment_reason IS NULL OR (length(adjustment_reason) BETWEEN 1 AND 500 AND btrim(adjustment_reason)=adjustment_reason AND adjustment_reason !~ '[[:cntrl:]]')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  authorizing_permission text NOT NULL CHECK (authorizing_permission='billing.membership.activate'),
  approval_reference uuid CHECK (approval_reference IS NULL),
  decision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((change_kind='INITIAL')=(period_version=1)),
  CHECK (end_date IS NULL OR end_date>=start_date),
  CHECK ((end_date IS NULL)=(term_ends_at IS NULL)),
  CHECK (term_ends_at IS NULL OR term_ends_at>term_started_at),
  CHECK ((date_source='STAFF_ADJUSTED')=(adjustment_reason IS NOT NULL)),
  UNIQUE(membership_id,period_version),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(decision_id,organization_id,school_id) REFERENCES hon.membership_activation_decisions(id,organization_id,school_id) ON DELETE RESTRICT
);

-- Staff follow-up work items created by an activation decision. BIRTH_DATE_MISSING (D3) and
-- IDENTITY_REVIEW_UNRESOLVED (D29a) are reminders only; nothing here resolves a review or supplies a birth date.
CREATE TABLE hon.membership_activation_follow_ups (
  decision_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('BIRTH_DATE_MISSING','IDENTITY_REVIEW_UNRESOLVED')),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  work_item_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(decision_id,kind),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(decision_id,organization_id,school_id) REFERENCES hon.membership_activation_decisions(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(work_item_id,organization_id,school_id) REFERENCES hon.work_items(id,organization_id,school_id) ON DELETE RESTRICT
);

ALTER TABLE hon.membership_activation_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_activation_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_effective_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_effective_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_activation_follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_activation_follow_ups FORCE ROW LEVEL SECURITY;

CREATE FUNCTION hon.guard_membership_activation_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE' USING ERRCODE='42501'; END $$;
CREATE TRIGGER membership_activation_decisions_immutable BEFORE UPDATE OR DELETE ON hon.membership_activation_decisions FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_activation_decisions_no_truncate BEFORE TRUNCATE ON hon.membership_activation_decisions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_effective_periods_immutable BEFORE UPDATE OR DELETE ON hon.membership_effective_periods FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_effective_periods_no_truncate BEFORE TRUNCATE ON hon.membership_effective_periods FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_activation_follow_ups_immutable BEFORE UPDATE OR DELETE ON hon.membership_activation_follow_ups FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_activation_follow_ups_no_truncate BEFORE TRUNCATE ON hon.membership_activation_follow_ups FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Settings-free lifecycle allow-list (D41). It reads no session or transaction setting, so nothing a caller can set
-- authorizes a transition: DRAFT->ACTIVE requires the decision and initial period rows (writable only by the
-- protected activation function) to already exist for exactly this version and projection.
CREATE FUNCTION hon.guard_membership_state_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state IS DISTINCT FROM 'DRAFT'::hon.membership_state OR NEW.version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.school_id IS DISTINCT FROM OLD.school_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501'; END IF;
  IF NEW.state=OLD.state THEN
    -- A DRAFT stays editable by trusted owners/definers; a confirmed or ended record is never rewritten in place.
    IF OLD.state<>'DRAFT' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.billing_account_id IS DISTINCT FROM OLD.billing_account_id OR NEW.participant_person_id IS DISTINCT FROM OLD.participant_person_id
    OR NEW.plan_code IS DISTINCT FROM OLD.plan_code OR NEW.version IS DISTINCT FROM OLD.version+1 THEN
    RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501'; END IF;
  IF OLD.state='DRAFT' AND NEW.state='ACTIVE' THEN
    IF NOT EXISTS(SELECT 1 FROM hon.membership_activation_decisions d JOIN hon.membership_effective_periods p
        ON p.decision_id=d.id AND p.membership_id=d.membership_id AND p.organization_id=d.organization_id AND p.school_id=d.school_id
      WHERE d.membership_id=NEW.id AND d.organization_id=NEW.organization_id AND d.school_id=NEW.school_id
        AND d.prior_membership_version=OLD.version AND d.next_membership_version=NEW.version
        AND p.period_version=1 AND p.change_kind='INITIAL'
        AND p.term_started_at=NEW.term_started_at AND p.term_ends_at IS NOT DISTINCT FROM NEW.term_ends_at) THEN
      RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='ACTIVE' AND NEW.state='CANCELLED' AND NEW.term_started_at IS NOT DISTINCT FROM OLD.term_started_at
    AND NEW.term_ends_at IS NOT DISTINCT FROM OLD.term_ends_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501';
END $$;
CREATE TRIGGER membership_state_transition_guard BEFORE INSERT OR UPDATE ON hon.memberships
FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_state_transition();

-- Private school-local calendar helpers (D40a). A local date is the calendar date of an instant in the school's
-- IANA timezone. The start of a local day is the earliest instant whose local date is that day, which handles days
-- of 23 or 25 hours and zones whose midnight is skipped or repeated (transitions fall on 15-minute boundaries).
CREATE FUNCTION hon.membership_local_date(instant timestamptz,tz text) RETURNS date
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT (instant AT TIME ZONE tz)::date $$;
CREATE FUNCTION hon.membership_local_day_start(day date,tz text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE t timestamptz;
BEGIN
  IF day IS NULL OR tz IS NULL THEN RETURN NULL; END IF;
  t:=(day::timestamp) AT TIME ZONE tz;
  WHILE (t AT TIME ZONE tz)::date<day LOOP t:=t+interval '15 minutes'; END LOOP;
  WHILE ((t-interval '15 minutes') AT TIME ZONE tz)::date>=day LOOP t:=t-interval '15 minutes'; END LOOP;
  RETURN t;
END $$;
-- Private derived effective status. ACTIVE is the confirmed lifecycle state; benefits are in effect only between
-- the projected start (inclusive) and end (exclusive). UNDATED marks pre-0177 ACTIVE rows without a start (E1b).
CREATE FUNCTION hon.membership_effective_status_at(lifecycle hon.membership_state,start_at timestamptz,end_at timestamptz,at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN lifecycle='CANCELLED' THEN 'CANCELLED' WHEN lifecycle<>'ACTIVE' THEN lifecycle::text
    WHEN start_at IS NULL THEN 'UNDATED' WHEN at<start_at THEN 'SCHEDULED' WHEN end_at IS NOT NULL AND at>=end_at THEN 'ENDED' ELSE 'IN_EFFECT' END
$$;
CREATE FUNCTION hon.membership_activation_text_ok(value text,max_length integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT value IS NOT NULL AND length(value) BETWEEN 1 AND max_length AND btrim(value,E' \t\n\r')=value
    AND value !~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿]'
$$;
CREATE FUNCTION hon.membership_activation_date(value jsonb) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE d date;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  BEGIN d:=(value#>>'{}')::date; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END;
  IF to_char(d,'YYYY-MM-DD')<>value#>>'{}' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  RETURN d;
END $$;

-- Private live authority predicate: the exact permission through a current, unrevoked staff grant at this
-- organization and school (no HQ, family, other-school or system role), never cached.
CREATE FUNCTION hon.membership_lifecycle_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT COALESCE(permission IN ('billing.membership.activate','billing.membership.activation.override','billing.membership.cancel')
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=permission AND x.is_staff_assignable),false)
$$;

-- Private direct-human actor proof (the 0162 identity rules) for one lifecycle permission at the current school.
CREATE FUNCTION hon.require_membership_lifecycle_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  denial text:=CASE WHEN permission='billing.membership.cancel' THEN 'MEMBERSHIP_CANCELLATION_FORBIDDEN'
    WHEN permission='billing.membership.activation.override' THEN 'ACTIVATION_OVERRIDE_FORBIDDEN' ELSE 'MEMBERSHIP_ACTIVATION_FORBIDDEN' END;
BEGIN
  IF permission IS NULL OR permission NOT IN ('billing.membership.activate','billing.membership.activation.override','billing.membership.cancel')
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
    AND hon.membership_lifecycle_permission(p.id,org,school,permission)
    -- An override is only ever exercised together with the activation permission at the same school.
    AND (permission<>'billing.membership.activation.override' OR hon.membership_lifecycle_permission(p.id,org,school,'billing.membership.activate'))
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION '%',denial USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Private, actor-independent, DML-free evaluation of one current-school membership against the E1a activation
-- rules, for either the suggested dates or one proposed date pair. Returns {facts, participantDisplayName}.
-- facts is the exact object digested by preview and re-derived by confirmation; it holds identifiers, codes,
-- dates and plan terms only (no names, birth dates or free text).
CREATE FUNCTION hon.evaluate_membership_activation(selected uuid,has_proposal boolean,proposed_start date,proposed_end date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
  m hon.memberships%ROWTYPE; selection hon.membership_plan_selections%ROWTYPE; terms hon.membership_plan_versions%ROWTYPE;
  gc hon.crm_guardian_child_membership_draft_sources%ROWTYPE; adult record;
  tz text; today date; source text:='GENERIC_LEGACY'; student uuid; receipt jsonb; plan_summary jsonb; plan jsonb;
  account_currency text; warnings jsonb:='[]'::jsonb; blocks jsonb:='[]'::jsonb; overridable jsonb:='[]'::jsonb;
  s_start date; s_end date; start_basis text; end_basis text; p_start date; p_end date; date_source text; plan_end date;
  youngest date; birth_known boolean; is_minor boolean:=false; identity_current boolean; label text;
  projected_start timestamptz; projected_end timestamptz; date_blocked boolean:=false; fixed_term boolean:=false; open_plan boolean:=false;
BEGIN
  IF selected IS NULL OR org IS NULL OR school IS NULL OR has_proposal IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  today:=hon.membership_local_date(clock_timestamp(),tz);
  IF m.state<>'DRAFT' THEN blocks:=blocks||jsonb_build_object('code','MEMBERSHIP_NOT_DRAFT'); END IF;

  -- Plan binding (0175) and the billing account currency it must match.
  SELECT a.currency::text INTO account_currency FROM hon.billing_accounts a WHERE a.id=m.billing_account_id AND a.organization_id=org AND a.school_id=school;
  SELECT * INTO selection FROM hon.membership_plan_selections x WHERE x.membership_id=m.id AND x.organization_id=org AND x.school_id=school;
  IF FOUND THEN
    SELECT * INTO terms FROM hon.membership_plan_versions v WHERE v.plan_id=selection.plan_id AND v.version=selection.plan_version AND v.organization_id=org AND v.school_id=school;
    plan_summary:=hon.membership_plan_version_summary(selection.plan_id,selection.plan_version);
    plan:=jsonb_build_object('membershipPlanId',selection.plan_id,'membershipPlanVersion',selection.plan_version,'terms',plan_summary);
    IF terms.plan_id IS NULL OR plan_summary IS NULL OR plan_summary->>'planCode' IS DISTINCT FROM m.plan_code THEN
      blocks:=blocks||jsonb_build_object('code','PLAN_BINDING_INVALID');
    ELSE
      fixed_term:=terms.term_kind='FIXED_MONTHS'; open_plan:=terms.term_kind='OPEN_ENDED';
      IF terms.currency::text IS DISTINCT FROM account_currency THEN blocks:=blocks||jsonb_build_object('code','PLAN_CURRENCY_MISMATCH'); END IF;
    END IF;
  ELSE
    warnings:=warnings||jsonb_build_object('code','LEGACY_FREE_TEXT_PLAN');
  END IF;

  -- DRAFT provenance. A changed CRM DRAFT is a block; a CRM relation that is merely no longer exactly current is the
  -- overridable identity-review warning (D29a). Nothing is merged, relinked or resolved here.
  SELECT * INTO gc FROM hon.crm_guardian_child_membership_draft_sources x WHERE x.membership_id=m.id AND x.organization_id=org AND x.school_id=school;
  IF FOUND THEN
    source:='CRM_GUARDIAN_CHILD_PLAN'; student:=gc.student_profile_id; receipt:=gc.receipt;
  ELSE
    SELECT x.receipt AS receipt,c.resulting_student_profile_id AS student INTO adult FROM hon.crm_adult_membership_draft_sources x
      JOIN hon.crm_lead_registration_conversions c ON c.id=x.conversion_id AND c.organization_id=x.organization_id AND c.school_id=x.school_id
      WHERE x.membership_id=m.id AND x.organization_id=org AND x.school_id=school;
    IF FOUND THEN
      source:=CASE WHEN selection.membership_id IS NULL THEN 'CRM_ADULT_FREE_TEXT' ELSE 'CRM_ADULT_PLAN' END; student:=adult.student; receipt:=adult.receipt;
    ELSIF EXISTS(SELECT 1 FROM hon.audit_events e WHERE e.organization_id=org AND e.school_id=school AND e.entity_type='MEMBERSHIP' AND e.entity_id=m.id
        AND e.action_code='billing.membership.create' AND e.next_state->>'operation'='OWNER_LAUNCH_MEMBERSHIP_DRAFT') THEN
      source:='OWNER_LAUNCH';
    END IF;
  END IF;
  IF receipt IS NOT NULL THEN
    IF receipt->>'membershipId' IS DISTINCT FROM m.id::text OR receipt->>'planCode' IS DISTINCT FROM m.plan_code
      OR receipt->'termStartedAt' IS DISTINCT FROM (CASE WHEN m.term_started_at IS NULL THEN 'null'::jsonb ELSE to_jsonb(to_char(m.term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)
      OR receipt->'termEndsAt' IS DISTINCT FROM (CASE WHEN m.term_ends_at IS NULL THEN 'null'::jsonb ELSE to_jsonb(to_char(m.term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END)
      OR m.version<>1 OR (source='CRM_GUARDIAN_CHILD_PLAN' AND selection.membership_id IS NULL) THEN
      blocks:=blocks||jsonb_build_object('code','CRM_DRAFT_CHANGED');
    ELSIF m.state='DRAFT' THEN
      BEGIN
        identity_current:=CASE WHEN source='CRM_GUARDIAN_CHILD_PLAN' THEN hon.crm_guardian_child_membership_draft_current(student) IS NOT NULL
          ELSE hon.crm_adult_membership_draft_is_current(student) END;
      EXCEPTION WHEN SQLSTATE 'P0002' OR SQLSTATE '22023' THEN identity_current:=false;
      END;
      IF identity_current IS DISTINCT FROM true THEN
        warnings:=warnings||jsonb_build_object('code','CRM_IDENTITY_REVIEW_PENDING');
        overridable:=overridable||to_jsonb('CRM_IDENTITY_REVIEW_PENDING'::text);
      END IF;
    END IF;
  END IF;

  -- D3: a missing birth date is a warning plus a staff reminder; a known minor keeps the guardian-of-record rule.
  SELECT max(sp.birth_date),coalesce(bool_or(sp.birth_date IS NOT NULL),false) INTO youngest,birth_known
    FROM hon.student_profiles sp WHERE sp.person_id=m.participant_person_id AND sp.organization_id=org AND sp.school_id=school;
  birth_known:=coalesce(birth_known,false);
  IF NOT birth_known THEN
    warnings:=warnings||jsonb_build_object('code','BIRTH_DATE_MISSING');
  ELSIF (youngest+interval '18 years')::date>today THEN
    is_minor:=true;
    IF NOT EXISTS(SELECT 1 FROM hon.family_members sm JOIN hon.families f ON f.id=sm.family_id AND f.organization_id=sm.organization_id AND f.school_id=sm.school_id
        JOIN hon.family_members gm ON gm.family_id=f.id AND gm.organization_id=f.organization_id AND gm.school_id=f.school_id
      WHERE sm.person_id=m.participant_person_id AND sm.organization_id=org AND sm.school_id=school AND sm.member_role='STUDENT'
        AND f.status='ACTIVE' AND gm.member_role='GUARDIAN' AND gm.person_id<>m.participant_person_id) THEN
      blocks:=blocks||jsonb_build_object('code','MINOR_GUARDIAN_OF_RECORD_REQUIRED');
    END IF;
  END IF;

  -- D40: HON suggests, staff confirm. Suggested start is the DRAFT's start in the school timezone, else today there.
  IF m.term_started_at IS NOT NULL THEN s_start:=hon.membership_local_date(m.term_started_at,tz); start_basis:='DRAFT_START_DATE';
  ELSE s_start:=today; start_basis:='TODAY_IN_SCHOOL_TIMEZONE'; END IF;
  IF fixed_term THEN s_end:=(s_start+make_interval(months=>terms.term_months))::date-1; end_basis:='PLAN_FIXED_TERM';
  ELSIF open_plan THEN s_end:=NULL; end_basis:='PLAN_OPEN_ENDED';
  ELSIF m.term_ends_at IS NOT NULL THEN s_end:=hon.membership_local_date(m.term_ends_at-interval '1 microsecond',tz); end_basis:='DRAFT_END_DATE';
  ELSE s_end:=NULL; end_basis:='NO_END_DATE'; END IF;
  IF has_proposal THEN p_start:=proposed_start; p_end:=proposed_end; ELSE p_start:=s_start; p_end:=s_end; END IF;
  date_source:=CASE WHEN p_start=s_start AND p_end IS NOT DISTINCT FROM s_end THEN 'SUGGESTED' ELSE 'STAFF_ADJUSTED' END;
  IF p_start IS NULL OR p_start<date '2000-01-01' OR p_start>today+730 THEN
    blocks:=blocks||jsonb_build_object('code','START_DATE_OUT_OF_RANGE'); date_blocked:=true; END IF;
  IF p_end IS NOT NULL AND p_start IS NOT NULL AND p_end<p_start THEN
    blocks:=blocks||jsonb_build_object('code','END_DATE_BEFORE_START'); date_blocked:=true;
  ELSIF p_end IS NOT NULL AND p_start IS NOT NULL AND p_end>p_start+3653 THEN
    blocks:=blocks||jsonb_build_object('code','END_DATE_OUT_OF_RANGE'); date_blocked:=true; END IF;
  IF fixed_term AND p_end IS NULL THEN blocks:=blocks||jsonb_build_object('code','FIXED_TERM_END_DATE_REQUIRED'); date_blocked:=true; END IF;
  IF NOT date_blocked THEN
    IF p_start<today THEN warnings:=warnings||jsonb_build_object('code','START_DATE_BACKDATED','days',today-p_start); END IF;
    IF p_start>today THEN warnings:=warnings||jsonb_build_object('code','START_DATE_IN_FUTURE','days',p_start-today); END IF;
    IF p_end IS NOT NULL AND p_end<today THEN warnings:=warnings||jsonb_build_object('code','END_DATE_PASSED'); END IF;
    IF fixed_term THEN
      plan_end:=(p_start+make_interval(months=>terms.term_months))::date-1;
      IF p_end<>plan_end THEN warnings:=warnings||jsonb_build_object('code','FIXED_TERM_DIFFERS_FROM_PLAN','planEndDate',plan_end); END IF;
    END IF;
    IF open_plan AND p_end IS NOT NULL THEN warnings:=warnings||jsonb_build_object('code','OPEN_ENDED_PLAN_HAS_END_DATE'); END IF;
    projected_start:=hon.membership_local_day_start(p_start,tz);
    projected_end:=CASE WHEN p_end IS NULL THEN NULL ELSE hon.membership_local_day_start(p_end+1,tz) END;
  END IF;
  -- Existing payment records are disclosed, never evaluated or changed (separation from SaaS and tuition money).
  IF EXISTS(SELECT 1 FROM hon.membership_payment_schedules x WHERE x.membership_id=m.id) THEN
    warnings:=warnings||jsonb_build_object('code','EXISTING_PAYMENT_SCHEDULE_NOT_EVALUATED'); END IF;
  IF EXISTS(SELECT 1 FROM hon.invoices x WHERE x.membership_id=m.id) THEN
    warnings:=warnings||jsonb_build_object('code','EXISTING_INVOICE_NOT_EVALUATED'); END IF;

  SELECT btrim(concat_ws(' ',p.given_name,p.family_name)) INTO label FROM hon.people p WHERE p.id=m.participant_person_id AND p.organization_id=org AND p.school_id=school;
  SELECT coalesce(jsonb_agg(w ORDER BY w->>'code'),'[]'::jsonb) INTO warnings FROM jsonb_array_elements(warnings) w;
  SELECT coalesce(jsonb_agg(b ORDER BY b->>'code'),'[]'::jsonb) INTO blocks FROM jsonb_array_elements(blocks) b;
  RETURN jsonb_build_object('participantDisplayName',label,'facts',jsonb_build_object(
    'membershipId',m.id,'state',m.state::text,'version',m.version,'billingAccountId',m.billing_account_id,'participantPersonId',m.participant_person_id,
    'planCode',m.plan_code,'source',source,'plan',plan,
    'existingTerm',jsonb_build_object(
      'termStartedAt',CASE WHEN m.term_started_at IS NULL THEN NULL ELSE to_char(m.term_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'termEndsAt',CASE WHEN m.term_ends_at IS NULL THEN NULL ELSE to_char(m.term_ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END),
    'schoolTimezone',tz,'localToday',today,'birthDateRecorded',birth_known,'knownMinor',is_minor,
    'suggestedDates',jsonb_build_object('startDate',s_start,'endDate',s_end,'startBasis',start_basis,'endBasis',end_basis),
    'proposedDates',jsonb_build_object('startDate',p_start,'endDate',p_end,'dateSource',date_source),
    'projection',CASE WHEN projected_start IS NULL THEN NULL ELSE jsonb_build_object(
      'termStartedAt',to_char(projected_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'termEndsAt',CASE WHEN projected_end IS NULL THEN NULL ELSE to_char(projected_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) END,
    'warnings',warnings,'overridableWarnings',overridable,'blocks',blocks,
    'requirementsNotEvaluated','["AGREEMENT","PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]'::jsonb));
END $$;

-- Direct HUMAN_UI read-only activation preview. No locks and no DML of any kind. The digest only binds a later
-- confirmation to exactly these facts; it is never proof of authorization.
CREATE FUNCTION hon.preview_school_membership_activation(subject text,selected uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; evaluation jsonb; facts jsonb;
  has_proposal boolean; s date; e date; can_override boolean; result jsonb; projection jsonb;
BEGIN
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.activate');
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('startDate','endDate'))
    OR (p ? 'startDate')<>(p ? 'endDate') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  has_proposal:=p ? 'startDate';
  IF has_proposal THEN
    s:=hon.membership_activation_date(p->'startDate');
    e:=CASE WHEN jsonb_typeof(p->'endDate')='null' THEN NULL ELSE hon.membership_activation_date(p->'endDate') END;
  END IF;
  evaluation:=hon.evaluate_membership_activation(selected,has_proposal,s,e);
  facts:=evaluation->'facts';
  can_override:=hon.membership_lifecycle_permission(actor,org,school,'billing.membership.activation.override');
  projection:=facts->'projection';
  result:=facts || jsonb_build_object(
    'participantDisplayName',evaluation->'participantDisplayName',
    'previewDigest',encode(sha256(convert_to(facts::text,'UTF8')),'hex'),
    'canConfirm',facts->'blocks'='[]'::jsonb AND (facts->'overridableWarnings'='[]'::jsonb OR can_override),
    'availableOverrides',CASE WHEN can_override THEN facts->'overridableWarnings' ELSE '[]'::jsonb END,
    'effectiveStatusIfConfirmedNow',CASE WHEN projection IS NULL OR jsonb_typeof(projection)='null' THEN NULL
      ELSE hon.membership_effective_status_at('ACTIVE',(projection->>'termStartedAt')::timestamptz,(projection->>'termEndsAt')::timestamptz,clock_timestamp()) END,
    'confirmation','I_CONFIRM_MEMBERSHIP_ACTIVATION_AND_DATES_NO_AGREEMENT_CONSENT_OR_PAYMENT_RECORDED');
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.activate') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_ACTIVATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Direct HUMAN_UI confirmation of one previewed DRAFT. Canonical order (0169): key reservation; IAM SHARE; the CRM
-- identity tables and billing accounts SHARE; memberships ROW EXCLUSIVE + the row FOR UPDATE; CRM DRAFT sources and
-- plan tables SHARE; then decision, period, membership, work items, follow-ups, audit and outbox last.
CREATE FUNCTION hon.activate_school_membership(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; decision hon.membership_activation_decisions%ROWTYPE; m hon.memberships%ROWTYPE; updated hon.memberships%ROWTYPE;
  period hon.membership_effective_periods%ROWTYPE; evaluation jsonb; facts jsonb; digest text; s date; e date; required_acks jsonb; given_acks jsonb;
  override_entry jsonb; overrides_used jsonb:='[]'::jsonb; adult_attestation jsonb; follow_ups jsonb:='[]'::jsonb; work hon.work_items%ROWTYPE;
  override_perm text; tz text; receipt jsonb; instant timestamptz; reason_text text; adjustment text; k text; decision_id uuid;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected IS NULL OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['expectedVersion','previewDigest','startDate','endDate','dateSource','acknowledgedWarnings','overrides','reasonCode','confirmation']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedVersion','previewDigest','startDate','endDate','dateSource','dateAdjustmentReason',
      'acknowledgedWarnings','overrides','adultVerification','reasonCode','reasonText','confirmation'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'previewDigest') IS DISTINCT FROM 'string' OR p->>'previewDigest' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p->'dateSource') IS DISTINCT FROM 'string' OR p->>'dateSource' NOT IN ('SUGGESTED','STAFF_ADJUSTED')
    OR (p->>'dateSource'='STAFF_ADJUSTED')<>(p ? 'dateAdjustmentReason')
    OR (p ? 'dateAdjustmentReason' AND (jsonb_typeof(p->'dateAdjustmentReason') IS DISTINCT FROM 'string' OR NOT hon.membership_activation_text_ok(p->>'dateAdjustmentReason',500)))
    OR jsonb_typeof(p->'acknowledgedWarnings') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'acknowledgedWarnings')>20
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'acknowledgedWarnings') w WHERE jsonb_typeof(w) IS DISTINCT FROM 'string' OR w#>>'{}' !~ '^[A-Z][A-Z_]{0,63}$')
    OR (SELECT count(DISTINCT w) FROM jsonb_array_elements(p->'acknowledgedWarnings') w)<>jsonb_array_length(p->'acknowledgedWarnings')
    OR jsonb_typeof(p->'overrides') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'overrides')>5
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'overrides') o WHERE jsonb_typeof(o) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(x ORDER BY x COLLATE "C") FROM jsonb_object_keys(o) x) IS DISTINCT FROM ARRAY['code','confirmation','reason']
      OR jsonb_typeof(o->'code') IS DISTINCT FROM 'string' OR o->>'code' !~ '^[A-Z][A-Z_]{0,63}$'
      OR jsonb_typeof(o->'reason') IS DISTINCT FROM 'string' OR NOT hon.membership_activation_text_ok(o->>'reason',500) OR length(o->>'reason')<10
      OR o->>'confirmation' IS DISTINCT FROM 'I_ACKNOWLEDGE_THE_REVIEW_REMAINS_UNRESOLVED')
    OR (SELECT count(DISTINCT o->>'code') FROM jsonb_array_elements(p->'overrides') o)<>jsonb_array_length(p->'overrides')
    OR (p ? 'adultVerification' AND (jsonb_typeof(p->'adultVerification') IS DISTINCT FROM 'object'
      OR (SELECT array_agg(x ORDER BY x COLLATE "C") FROM jsonb_object_keys(p->'adultVerification') x) IS DISTINCT FROM ARRAY['attestation','method']
      OR p->'adultVerification'->>'method' NOT IN ('ID_CHECKED_IN_PERSON','DOCUMENT_REVIEWED','SELF_DECLARED_TO_STAFF')
      OR jsonb_typeof(p->'adultVerification'->'method') IS DISTINCT FROM 'string'
      OR p->'adultVerification'->>'attestation' IS DISTINCT FROM 'I_ATTEST_STAFF_VERIFIED_THE_PARTICIPANT_IS_AN_ADULT'))
    OR jsonb_typeof(p->'reasonCode') IS DISTINCT FROM 'string' OR p->>'reasonCode' NOT IN ('ROUTINE_ENROLLMENT','DOCUMENTS_PENDING','PAPER_RECORDS_HELD_BY_SCHOOL',
      'PAYMENT_HANDLED_OUTSIDE_HON','LEGACY_MEMBERSHIP','SCHOLARSHIP_OR_COMP','STAFF_FAMILY','OTHER')
    OR (p ? 'reasonText' AND (jsonb_typeof(p->'reasonText') IS DISTINCT FROM 'string' OR NOT hon.membership_activation_text_ok(p->>'reasonText',500)))
    OR (p->>'reasonCode'='OTHER' AND NOT p ? 'reasonText')
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_MEMBERSHIP_ACTIVATION_AND_DATES_NO_AGREEMENT_CONSENT_OR_PAYMENT_RECORDED' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  s:=hon.membership_activation_date(p->'startDate');
  e:=CASE WHEN jsonb_typeof(p->'endDate')='null' THEN NULL ELSE hon.membership_activation_date(p->'endDate') END;
  reason_text:=p->>'reasonText'; adjustment:=p->>'dateAdjustmentReason';
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.activate');
  -- Exact request binding: any byte of difference under the same key is a different command.
  fp:=encode(sha256(convert_to(jsonb_build_object('command','billing.membership.activate','membershipId',selected,'input',p)::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.activate') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_ACTIVATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO decision FROM hon.membership_activation_decisions d WHERE d.organization_id=org AND d.school_id=school AND d.actor_principal_id=actor AND d.idempotency_key=key;
  IF NOT reserved OR decision.id IS NOT NULL THEN
    -- A reused key is refused before any membership fact is evaluated or disclosed. An exact replay returns the
    -- stored receipt only after live authority (including any override it used) is re-proven. The decision row is
    -- the lifetime record of the key, so an exact replay still works after the idempotency record expires.
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND OR prior.request_fingerprint<>fp OR (decision.id IS NOT NULL AND decision.request_fingerprint<>fp) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF decision.id IS NULL OR decision.membership_id<>selected
      OR (NOT reserved AND (prior.status<>'COMPLETED' OR prior.response_body IS DISTINCT FROM decision.receipt)) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF decision.override_permission IS NOT NULL
      AND hon.require_membership_lifecycle_actor(subject,'billing.membership.activation.override') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'ACTIVATION_OVERRIDE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    IF reserved THEN
      UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=decision.receipt
        WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
    END IF;
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.activate') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_ACTIVATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',decision.receipt,'replayed',true);
  END IF;
  LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.crm_lead_registration_conversions,hon.crm_leads,hon.billing_accounts IN SHARE MODE;
  LOCK TABLE hon.memberships IN ROW EXCLUSIVE MODE;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  LOCK TABLE hon.crm_adult_membership_draft_sources,hon.crm_guardian_child_enrolled_children,hon.crm_guardian_child_payer_designations,
    hon.crm_guardian_child_membership_draft_sources,hon.membership_plans,hon.membership_plan_versions,hon.membership_plan_selections IN SHARE MODE;
  IF m.state<>'DRAFT' THEN RAISE EXCEPTION 'MEMBERSHIP_NOT_DRAFT' USING ERRCODE='40001'; END IF;
  IF m.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  -- Everything the preview showed is re-derived under lock; any difference is a stale preview.
  evaluation:=hon.evaluate_membership_activation(selected,true,s,e);
  facts:=evaluation->'facts';
  digest:=encode(sha256(convert_to(facts::text,'UTF8')),'hex');
  IF digest<>p->>'previewDigest' THEN RAISE EXCEPTION 'ACTIVATION_PREVIEW_STALE' USING ERRCODE='40001'; END IF;
  IF facts->'blocks'<>'[]'::jsonb THEN RAISE EXCEPTION 'ACTIVATION_BLOCKED' USING ERRCODE='22023'; END IF;
  IF facts->'proposedDates'->>'dateSource' IS DISTINCT FROM p->>'dateSource' THEN RAISE EXCEPTION 'DATE_SOURCE_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(w->'code' ORDER BY w->>'code'),'[]'::jsonb) INTO required_acks FROM jsonb_array_elements(facts->'warnings') w;
  SELECT coalesce(jsonb_agg(w ORDER BY w#>>'{}'),'[]'::jsonb) INTO given_acks FROM jsonb_array_elements(p->'acknowledgedWarnings') w;
  IF required_acks<>given_acks THEN RAISE EXCEPTION 'ACTIVATION_ACKNOWLEDGEMENT_REQUIRED' USING ERRCODE='22023'; END IF;
  IF (SELECT coalesce(jsonb_agg(o->'code' ORDER BY o->>'code'),'[]'::jsonb) FROM jsonb_array_elements(p->'overrides') o)
      <>(SELECT coalesce(jsonb_agg(w ORDER BY w#>>'{}'),'[]'::jsonb) FROM jsonb_array_elements(facts->'overridableWarnings') w) THEN
    RAISE EXCEPTION 'ACTIVATION_OVERRIDE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p->'overrides')>0 THEN
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.activation.override') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'ACTIVATION_OVERRIDE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    override_perm:='billing.membership.activation.override';
    FOR override_entry IN SELECT o FROM jsonb_array_elements(p->'overrides') o ORDER BY o->>'code' LOOP
      overrides_used:=overrides_used||jsonb_build_object('code',override_entry->>'code','reason',override_entry->>'reason',
        'acknowledgedUnresolved',true,'resolved',false);
    END LOOP;
  END IF;
  IF p ? 'adultVerification' THEN
    IF NOT required_acks @> '["BIRTH_DATE_MISSING"]'::jsonb THEN RAISE EXCEPTION 'ADULT_VERIFICATION_NOT_APPLICABLE' USING ERRCODE='22023'; END IF;
    adult_attestation:=jsonb_build_object('kind','STAFF_ATTESTATION','method',p->'adultVerification'->>'method','attestedByPrincipalId',actor,
      'birthDateRecorded',false);
  END IF;
  IF required_acks @> '["START_DATE_BACKDATED"]'::jsonb AND reason_text IS NULL THEN
    RAISE EXCEPTION 'ACTIVATION_REASON_TEXT_REQUIRED' USING ERRCODE='22023'; END IF;

  tz:=facts->>'schoolTimezone';
  instant:=clock_timestamp();
  decision_id:=gen_random_uuid();
  -- Staff reminders (D3, D29a): internal human work only, no names, reasons or execution. A review is never resolved here.
  FOREACH k IN ARRAY ARRAY['BIRTH_DATE_MISSING','IDENTITY_REVIEW_UNRESOLVED'] LOOP
    CONTINUE WHEN k='BIRTH_DATE_MISSING' AND NOT required_acks @> '["BIRTH_DATE_MISSING"]'::jsonb;
    CONTINUE WHEN k='IDENTITY_REVIEW_UNRESOLVED' AND override_perm IS NULL;
    INSERT INTO hon.work_items(organization_id,school_id,work_origin,work_type,status,title,description,priority,created_by_principal_id,correlation_id)
      VALUES(org,school,'HUMAN_UI','HUMAN_TASK','READY',
        CASE WHEN k='BIRTH_DATE_MISSING' THEN 'Record birth date for an activated membership' ELSE 'Unresolved CRM identity review on an activated membership' END,
        CASE WHEN k='BIRTH_DATE_MISSING'
          THEN 'Membership '||m.id||' was activated without a recorded birth date. Record the participant''s birth date in their student profile. Activation did not assume, create or verify a birth date.'
          ELSE 'Membership '||m.id||' was activated with a documented override while its CRM identity review was still pending. The review remains unresolved. No records were merged, reassigned, deleted or overwritten.' END,
        CASE WHEN k='BIRTH_DATE_MISSING' THEN 'NORMAL' ELSE 'HIGH' END,actor,correlation)
      RETURNING * INTO work;
    INSERT INTO hon.human_work_history(work_item_id,organization_id,school_id,version,operation,status,title,description,priority,due_at,assignee_id,actor_id,request_id)
      VALUES(work.id,org,school,work.version,'CREATE',work.status,work.title,work.description,work.priority,NULL,NULL,actor,request);
    follow_ups:=follow_ups||jsonb_build_object('kind',k,'workItemId',work.id);
  END LOOP;
  receipt:=jsonb_build_object('membershipId',m.id,'state','ACTIVE','version',m.version+1,'previousVersion',m.version,
    'decisionId',decision_id,'decisionBasis','STAFF_ACTIVATION_PRE_POLICY','membershipSource',facts->>'source',
    'authorizingPermission','billing.membership.activate','overridePermission',override_perm,
    'effectivePeriod',jsonb_build_object('periodVersion',1,'startDate',s,'endDate',e,'endDateInclusive',true,'schoolTimezone',tz,'dateSource',p->>'dateSource',
      'termStartedAt',facts->'projection'->'termStartedAt','termEndsAt',facts->'projection'->'termEndsAt'),
    'effectiveStatusAtActivation',hon.membership_effective_status_at('ACTIVE',(facts->'projection'->>'termStartedAt')::timestamptz,
      (facts->'projection'->>'termEndsAt')::timestamptz,instant),
    'acknowledgedWarnings',given_acks,
    'overridesUsed',(SELECT coalesce(jsonb_agg(jsonb_build_object('code',o->>'code','resolved',false) ORDER BY o->>'code'),'[]'::jsonb) FROM jsonb_array_elements(overrides_used) o),
    'followUps',follow_ups,
    'adultVerification',CASE WHEN adult_attestation IS NULL THEN NULL ELSE jsonb_build_object('kind','STAFF_ATTESTATION','method',adult_attestation->>'method') END,
    'reasonCode',p->>'reasonCode','requirementsNotEvaluated',facts->'requirementsNotEvaluated',
    'recordedAt',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO hon.membership_activation_decisions(id,organization_id,school_id,membership_id,prior_membership_version,next_membership_version,decision_basis,
      membership_source,actor_principal_id,authorizing_permission,override_permission,reason_code,reason_text,acknowledged_warnings,overrides,adult_verification,
      preview_digest,evaluated_facts,requirements_not_evaluated,idempotency_key,request_fingerprint,request_id,correlation_id,receipt,created_at)
    VALUES(decision_id,org,school,m.id,m.version,m.version+1,'STAFF_ACTIVATION_PRE_POLICY',facts->>'source',actor,'billing.membership.activate',override_perm,
      p->>'reasonCode',reason_text,given_acks,overrides_used,adult_attestation,digest,facts,facts->'requirementsNotEvaluated',key,fp,request,correlation,receipt,instant);
  INSERT INTO hon.membership_effective_periods(organization_id,school_id,membership_id,period_version,change_kind,start_date,end_date,school_timezone,
      term_started_at,term_ends_at,date_source,suggested_start_date,suggested_end_date,suggestion_basis,adjustment_reason,actor_principal_id,
      authorizing_permission,decision_id,created_at)
    VALUES(org,school,m.id,1,'INITIAL',s,e,tz,(facts->'projection'->>'termStartedAt')::timestamptz,(facts->'projection'->>'termEndsAt')::timestamptz,
      p->>'dateSource',(facts->'suggestedDates'->>'startDate')::date,(facts->'suggestedDates'->>'endDate')::date,
      jsonb_build_object('startBasis',facts->'suggestedDates'->'startBasis','endBasis',facts->'suggestedDates'->'endBasis'),adjustment,actor,
      'billing.membership.activate',decision_id,instant)
    RETURNING * INTO period;
  UPDATE hon.memberships SET state='ACTIVE',version=version+1,term_started_at=period.term_started_at,term_ends_at=period.term_ends_at
    WHERE id=m.id AND organization_id=org AND school_id=school AND state='DRAFT' AND version=m.version RETURNING * INTO updated;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.membership_activation_follow_ups(decision_id,kind,organization_id,school_id,membership_id,work_item_id,created_at)
    SELECT decision_id,f->>'kind',org,school,m.id,(f->>'workItemId')::uuid,instant FROM jsonb_array_elements(follow_ups) f;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership.activate','MEMBERSHIP',m.id,
      jsonb_build_object('state','DRAFT','version',m.version,'termStartedAt',facts->'existingTerm'->'termStartedAt','termEndsAt',facts->'existingTerm'->'termEndsAt'),
      receipt,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.activated',2,'MEMBERSHIP',m.id,updated.version,correlation,request,
      receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=receipt
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  -- Final live authority after every write (revocation during the command fails closed).
  IF override_perm IS NOT NULL AND hon.require_membership_lifecycle_actor(subject,'billing.membership.activation.override') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'ACTIVATION_OVERRIDE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.activate') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_ACTIVATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',receipt,'replayed',false);
END $$;

-- Direct HUMAN_UI cancellation of one ACTIVE membership with the unchanged public contract and fingerprint
-- (byte-compatible with the pre-0177 API, so an in-flight retry keeps its key). New: key-first canonical order and
-- live billing.membership.cancel re-checks after every wait, on replay and before return. effectiveAt remains
-- evidence only; nothing is scheduled, refunded, credited, prorated or charged.
CREATE FUNCTION hon.cancel_school_membership(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean; reason text; effective text;
  effective_at timestamptz; prior hon.idempotency_records%ROWTYPE; m hon.memberships%ROWTYPE; updated hon.memberships%ROWTYPE; result jsonb; payload jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected IS NULL OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['expectedVersion','cancellationReason']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedVersion','cancellationReason','effectiveAt'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'cancellationReason') IS DISTINCT FROM 'string' OR length(p->>'cancellationReason') NOT BETWEEN 1 AND 1000
    OR btrim(p->>'cancellationReason')<>p->>'cancellationReason' OR p->>'cancellationReason' ~ '[\x01-\x1f\x7f]'
    OR (p ? 'effectiveAt' AND (jsonb_typeof(p->'effectiveAt') IS DISTINCT FROM 'string' OR length(p->>'effectiveAt')>40
      OR p->>'effectiveAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]{1,9})?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  reason:=p->>'cancellationReason'; effective:=p->>'effectiveAt';
  IF effective IS NOT NULL THEN
    BEGIN effective_at:=effective::timestamptz; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END;
    IF effective_at<clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END IF;
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.cancel');
  fp:=encode(sha256(convert_to('{"operation":"billing.membership.cancel","membershipId":'||to_json(selected::text)::text
    ||',"expectedVersion":'||(p->'expectedVersion')::text||',"cancellationReason":'||to_json(reason)::text
    ||',"effectiveAt":'||coalesce(to_json(effective)::text,'null')||'}','UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.cancel') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_CANCELLATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.cancel') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_CANCELLATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('membership',prior.response_body,'replayed',true);
  END IF;
  LOCK TABLE hon.memberships IN ROW EXCLUSIVE MODE;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF m.state<>'ACTIVE' THEN RAISE EXCEPTION 'MEMBERSHIP_NOT_ACTIVE' USING ERRCODE='40001'; END IF;
  IF m.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  UPDATE hon.memberships SET state='CANCELLED',version=version+1
    WHERE id=m.id AND organization_id=org AND school_id=school AND state='ACTIVE' AND version=m.version RETURNING * INTO updated;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  result:=jsonb_build_object('id',updated.id,'billingAccountId',updated.billing_account_id,'participantPersonId',updated.participant_person_id,
    'planCode',updated.plan_code,'state','CANCELLED','version',updated.version,'cancellationReason',reason,
    'createdAt',to_char(updated.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF effective IS NOT NULL THEN result:=result||jsonb_build_object('effectiveAt',effective); END IF;
  payload:=jsonb_build_object('membershipId',updated.id,'state','CANCELLED','version',updated.version,'cancellationReason',reason,'effectiveAt',effective);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership.cancel','MEMBERSHIP',updated.id,jsonb_build_object('state','ACTIVE','version',m.version),
      payload,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.cancelled',1,'MEMBERSHIP',updated.id,updated.version,correlation,request,payload);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.cancel') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_CANCELLATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('membership',result,'replayed',false);
END $$;

COMMENT ON TABLE hon.membership_activation_decisions IS
'E1a immutable activation decision evidence: one row per activated membership (actor, live permissions used, acknowledged warnings, documented overrides, staff attestation, preview digest, evaluated facts, requirements not evaluated). Private: forced RLS, no runtime grant.';
COMMENT ON TABLE hon.membership_effective_periods IS
'E1a immutable membership effective-period evidence in school-local dates (inclusive end; NULL = open-ended) with the exact projected instants. E1a writes only the INITIAL period; revisions are new versions (E1b). Private.';
COMMENT ON TABLE hon.membership_activation_follow_ups IS
'E1a links from an activation decision to the staff reminder work items it created (missing birth date, unresolved CRM identity review). Private.';
COMMENT ON FUNCTION hon.preview_school_membership_activation(text,uuid,jsonb) IS
'Direct HUMAN_UI read-only activation preview for one current-school membership: identity, version, plan, suggested and proposed dates with their basis, existing dates, warnings needing acknowledgement, available overrides, blocks, requirements not evaluated, school timezone and a digest of the evaluated facts. No DML, locks, audit, outbox or idempotency.';
COMMENT ON FUNCTION hon.activate_school_membership(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI two-step confirmation of one previewed DRAFT: live school-scoped billing.membership.activate (and billing.membership.activation.override when an override is documented), exact-request idempotency, re-derived facts under canonical locks, one decision and initial effective period, ACTIVE with projected dates, staff reminders, audit and inert outbox. No agreement, consent, payment, schedule, invoice, provider, SaaS billing, entitlement, communication, AI or automation effect.';
COMMENT ON FUNCTION hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI ACTIVE-to-CANCELLED transition with the unchanged public cancellation contract, key-first canonical order and live billing.membership.cancel re-checks. effectiveAt is evidence only. No refund, credit, proration, payment, provider, communication, AI or automation effect.';

-- D41 option C: the runtime can neither UPDATE nor DELETE memberships and may INSERT only the approved DRAFT columns.
REVOKE ALL ON TABLE hon.membership_activation_decisions,hon.membership_effective_periods,hon.membership_activation_follow_ups FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON TABLE hon.memberships FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_membership_activation_evidence(),hon.guard_membership_state_transition(),hon.membership_local_date(timestamptz,text),
  hon.membership_local_day_start(date,text),hon.membership_effective_status_at(hon.membership_state,timestamptz,timestamptz,timestamptz),
  hon.membership_activation_text_ok(text,integer),hon.membership_activation_date(jsonb),hon.membership_lifecycle_permission(uuid,uuid,uuid,text),
  hon.require_membership_lifecycle_actor(text,text),hon.evaluate_membership_activation(uuid,boolean,date,date),
  hon.preview_school_membership_activation(text,uuid,jsonb),hon.activate_school_membership(text,uuid,jsonb,text,uuid,uuid),
  hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; col text; t text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.membership_activation_decisions,hon.membership_effective_periods,hon.membership_activation_follow_ups FROM %I',r);
    EXECUTE format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON TABLE hon.memberships FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_membership_activation_evidence(),hon.guard_membership_state_transition(),hon.membership_local_date(timestamptz,text),
      hon.membership_local_day_start(date,text),hon.membership_effective_status_at(hon.membership_state,timestamptz,timestamptz,timestamptz),
      hon.membership_activation_text_ok(text,integer),hon.membership_activation_date(jsonb),hon.membership_lifecycle_permission(uuid,uuid,uuid,text),
      hon.require_membership_lifecycle_actor(text,text),hon.evaluate_membership_activation(uuid,boolean,date,date),
      hon.preview_school_membership_activation(text,uuid,jsonb),hon.activate_school_membership(text,uuid,jsonb,text,uuid,uuid),
      hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid) FROM %I',r);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['membership_activation_decisions','membership_effective_periods','membership_activation_follow_ups','memberships'] LOOP
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      IF t='memberships' THEN
        EXECUTE format('REVOKE INSERT (%I),UPDATE (%I) ON hon.%I FROM PUBLIC',col,col,t);
      ELSE
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      END IF;
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        IF t='memberships' THEN
          EXECUTE format('REVOKE INSERT (%I),UPDATE (%I) ON hon.%I FROM %I',col,col,t,r);
        ELSE
          EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT INSERT (organization_id,school_id,billing_account_id,participant_person_id,plan_code,term_started_at,term_ends_at) ON hon.memberships TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.preview_school_membership_activation(text,uuid,jsonb),hon.activate_school_membership(text,uuid,jsonb,text,uuid,uuid),
      hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema='hon' AND table_name='memberships' AND column_name='state') IS DISTINCT FROM '''DRAFT''::hon.membership_state'
    OR (SELECT column_default FROM information_schema.columns WHERE table_schema='hon' AND table_name='memberships' AND column_name='version') IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Membership DRAFT defaults changed; restricted runtime INSERT would not be DRAFT version 1';
  END IF;
END $$;
COMMIT;
