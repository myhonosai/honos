BEGIN;

-- Membership pause, cancellation and manual refund records (0224, allocated by the owner 2026-11-08 21:45Z).
-- Owner policy, 2026-11-08 21:44Z:
--   P1  Only school staff pause a membership, on the member's request. No family or member self-service.
--   P2  Each school sets its own pause limits (maximum length of one pause, paused days per rolling 365 days) and an
--       optional hold fee. The hold fee is recorded policy only: nothing is charged, scheduled or invoiced.
--   P3  Cancellation takes effect immediately (the existing 0177 command), now also from a paused membership.
--   P4  No automatic refund. An authorized staff member records a refund the school made outside HON, with a reason.
--       HON moves no money: the record is evidence only.
-- A pause is ACTIVE -> FROZEN, a resume FROZEN -> ACTIVE, each bound by the 0177 transition trigger to one immutable
-- pause row. Term dates never change on pause or resume. A membership with an ACTIVE payment schedule cannot be paused
-- (the schedule would keep charging); that waits for the billing arrangement workflow. The runtime gains no table
-- privilege: every write goes through a direct-human SECURITY DEFINER command with live school-scoped permission
-- re-checks, exact-request idempotency, audit and an inert outbox event.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Membership pause and cancellation require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Membership pause and cancellation require a restricted runtime';
  END IF;
  IF to_regclass('hon.membership_date_revisions') IS NULL OR to_regclass('hon.membership_payment_schedules') IS NULL
    OR to_regprocedure('hon.membership_local_date(timestamptz,text)') IS NULL THEN
    RAISE EXCEPTION 'Membership pause and cancellation require 0014, 0177 and 0178';
  END IF;
  IF (SELECT array_agg(tgname::text) FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND NOT tgisinternal) IS DISTINCT FROM ARRAY['membership_state_transition_guard']
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND tgname='membership_state_transition_guard'
      AND tgfoid='hon.guard_membership_state_transition()'::regprocedure AND tgenabled='O') THEN
    RAISE EXCEPTION 'Membership pause expects exactly the enabled 0177 transition guard on hon.memberships';
  END IF;
  -- The four bodies this migration replaces must be exactly the reviewed 0177/0178 ones.
  IF EXISTS (SELECT 1 FROM (VALUES
      ('hon.guard_membership_state_transition()','fa56ec9b289b8cdba2d8700db672666afacb2d9a0a5294c60474384dbdaa06f2'),
      ('hon.membership_lifecycle_permission(uuid,uuid,uuid,text)','877c7aac877d73b1efa3aecb9f11c102042c1daa6f065cf62a204055d0029704'),
      ('hon.require_membership_lifecycle_actor(text,text)','8d7b4d4019d4fa4679148f0f9a53af9ed347d08f545c60fb8761240c3e3cf4a2'),
      ('hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid)','084582d01a38c7f8f5a9876bc338230eb07958c64342aa6d426a5b8b47861629')) e(signature,body_hash)
    WHERE encode(sha256(convert_to((SELECT prosrc FROM pg_proc WHERE oid=e.signature::regprocedure),'UTF8')),'hex') IS DISTINCT FROM e.body_hash) THEN
    RAISE EXCEPTION 'Membership pause and cancellation expect the reviewed 0177/0178 function bodies';
  END IF;
END $$;

-- Three sensitive, staff-assignable permissions, initially granted to system OWNER roles only.
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('billing.membership.pause','Pause (freeze) and resume a membership at one school on the member''s request, within the school pause policy',true,true),
  ('billing.membership.pause_policy.manage','Set the school''s membership pause limits and recorded hold fee',true,true),
  ('billing.membership.refund.record','Record a refund the school made outside HON for a cancelled membership (evidence only, no money movement)',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('billing.membership.pause','billing.membership.pause_policy.manage','billing.membership.refund.record')
      AND is_sensitive AND is_staff_assignable)<>3 THEN
    RAISE EXCEPTION 'Membership pause permissions already exist with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,granted.code FROM hon.roles r
CROSS JOIN (VALUES ('billing.membership.pause'),('billing.membership.pause_policy.manage'),('billing.membership.refund.record')) granted(code)
WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- P2: one immutable row per policy version per school. No row means pauses are not offered at that school yet.
CREATE TABLE hon.school_membership_pause_policies (
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>=1),
  pauses_allowed boolean NOT NULL,
  max_pause_days integer CHECK (max_pause_days BETWEEN 1 AND 365),
  max_paused_days_per_year integer CHECK (max_paused_days_per_year BETWEEN 1 AND 365),
  hold_fee_minor integer CHECK (hold_fee_minor BETWEEN 0 AND 100000000),
  hold_fee_currency char(3) CHECK (hold_fee_currency ~ '^[A-Z]{3}$'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(school_id,version),
  UNIQUE(organization_id,school_id,version),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  CHECK (pauses_allowed=(max_pause_days IS NOT NULL) AND pauses_allowed=(max_paused_days_per_year IS NOT NULL)),
  CHECK (max_pause_days IS NULL OR max_pause_days<=max_paused_days_per_year),
  CHECK ((hold_fee_minor IS NULL)=(hold_fee_currency IS NULL)),
  CHECK (pauses_allowed OR hold_fee_minor IS NULL)
);

-- P1: one row per pause. Written open with the pause; closed exactly once by a resume or by a cancellation.
CREATE TABLE hon.membership_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  policy_version integer NOT NULL,
  starts_on date NOT NULL,
  planned_resume_on date NOT NULL,
  pause_reason text NOT NULL CHECK (length(pause_reason) BETWEEN 1 AND 1000 AND btrim(pause_reason)=pause_reason AND pause_reason !~ '[\x01-\x1f\x7f]'),
  hold_fee_minor integer CHECK (hold_fee_minor BETWEEN 0 AND 100000000),
  hold_fee_currency char(3),
  paused_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  paused_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  pause_prior_version integer NOT NULL,
  pause_next_version integer NOT NULL,
  ended_kind text CHECK (ended_kind IN ('RESUMED','CANCELLED')),
  ended_on date,
  ended_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR (length(end_reason) BETWEEN 1 AND 1000 AND btrim(end_reason)=end_reason AND end_reason !~ '[\x01-\x1f\x7f]')),
  end_prior_version integer,
  end_next_version integer,
  UNIQUE(id,organization_id,school_id),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,school_id,policy_version) REFERENCES hon.school_membership_pause_policies(organization_id,school_id,version) ON DELETE RESTRICT,
  CHECK (planned_resume_on>starts_on),
  CHECK (pause_next_version=pause_prior_version+1),
  CHECK ((hold_fee_minor IS NULL)=(hold_fee_currency IS NULL)),
  CHECK ((ended_kind IS NULL)=(ended_on IS NULL) AND (ended_kind IS NULL)=(ended_by_principal_id IS NULL) AND (ended_kind IS NULL)=(ended_at IS NULL)
    AND (ended_kind IS NULL)=(end_prior_version IS NULL) AND (ended_kind IS NULL)=(end_next_version IS NULL)),
  CHECK (ended_kind IS NOT NULL OR end_reason IS NULL),
  CHECK (ended_on IS NULL OR ended_on>=starts_on),
  CHECK (end_prior_version IS NULL OR (end_prior_version=pause_next_version AND end_next_version=end_prior_version+1))
);
CREATE UNIQUE INDEX membership_pauses_one_open_idx ON hon.membership_pauses(membership_id) WHERE ended_kind IS NULL;
CREATE INDEX membership_pauses_membership_idx ON hon.membership_pauses(membership_id,starts_on);

-- P4: one immutable row per refund the school says it made outside HON.
CREATE TABLE hon.membership_refund_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000000),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  refunded_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('CASH','CHECK','CARD_TERMINAL','BANK_TRANSFER','OTHER')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000 AND btrim(reason)=reason AND reason !~ '[\x01-\x1f\x7f]'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX membership_refund_records_membership_idx ON hon.membership_refund_records(membership_id,recorded_at);

ALTER TABLE hon.school_membership_pause_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_membership_pause_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_pauses FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_refund_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_refund_records FORCE ROW LEVEL SECURITY;
CREATE TRIGGER school_membership_pause_policies_immutable BEFORE UPDATE OR DELETE ON hon.school_membership_pause_policies FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER school_membership_pause_policies_no_truncate BEFORE TRUNCATE ON hon.school_membership_pause_policies FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_refund_records_immutable BEFORE UPDATE OR DELETE ON hon.membership_refund_records FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_refund_records_no_truncate BEFORE TRUNCATE ON hon.membership_refund_records FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_pauses_no_truncate BEFORE TRUNCATE ON hon.membership_pauses FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- A policy version is the previous version + 1 at the same school.
CREATE FUNCTION hon.guard_school_membership_pause_policy_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.version IS DISTINCT FROM coalesce((SELECT max(x.version) FROM hon.school_membership_pause_policies x
      WHERE x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id),0)+1 THEN
    RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_PAUSE_POLICY' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_membership_pause_policy_insert_guard BEFORE INSERT ON hon.school_membership_pause_policies
  FOR EACH ROW EXECUTE FUNCTION hon.guard_school_membership_pause_policy_insert();

-- A pause row is written open against the ACTIVE membership it is about to freeze, and afterwards only its end
-- columns may be set, exactly once, while the membership is still FROZEN at the pause's version. Never deleted.
CREATE FUNCTION hon.guard_membership_pause() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE m hon.memberships%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_PAUSE' USING ERRCODE='42501'; END IF;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=NEW.membership_id AND x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id;
  IF TG_OP='INSERT' THEN
    IF NEW.ended_kind IS NOT NULL OR m.id IS NULL OR m.state<>'ACTIVE' OR m.version<>NEW.pause_prior_version THEN
      RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_PAUSE' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.ended_kind IS NOT NULL OR NEW.ended_kind IS NULL
    OR (to_jsonb(NEW)-ARRAY['ended_kind','ended_on','ended_by_principal_id','ended_at','end_reason','end_prior_version','end_next_version'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['ended_kind','ended_on','ended_by_principal_id','ended_at','end_reason','end_prior_version','end_next_version'])
    OR m.id IS NULL OR m.state<>'FROZEN' OR m.version<>NEW.end_prior_version THEN
    RAISE EXCEPTION 'IMMUTABLE_MEMBERSHIP_PAUSE' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_pause_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.membership_pauses
  FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_pause();

-- The 0178 trigger with three new branches, each bound to exactly one pause row. Every 0178 branch is unchanged.
CREATE OR REPLACE FUNCTION hon.guard_membership_state_transition() RETURNS trigger
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
    -- E1b (0178): the only in-place change of a confirmed membership is a date revision bound to its immutable
    -- evidence row. Only the projection and the version may change; every other column stays identical.
    IF OLD.state='ACTIVE' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      IF NEW.version IS DISTINCT FROM OLD.version+1
        OR (to_jsonb(NEW)-ARRAY['term_started_at','term_ends_at','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['term_started_at','term_ends_at','version'])
        OR NOT EXISTS(SELECT 1 FROM hon.membership_date_revisions r
          WHERE r.membership_id=NEW.id AND r.organization_id=NEW.organization_id AND r.school_id=NEW.school_id
            AND r.prior_membership_version=OLD.version AND r.next_membership_version=NEW.version
            AND r.prior_term_started_at IS NOT DISTINCT FROM OLD.term_started_at AND r.prior_term_ends_at IS NOT DISTINCT FROM OLD.term_ends_at
            AND r.term_started_at=NEW.term_started_at AND r.term_ends_at IS NOT DISTINCT FROM NEW.term_ends_at
            AND r.period_version=(SELECT max(x.period_version) FROM hon.membership_date_revisions x WHERE x.membership_id=NEW.id)) THEN
        RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501'; END IF;
      RETURN NEW;
    END IF;
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
  -- Pause, resume and cancellation never change the term dates.
  IF NEW.term_started_at IS DISTINCT FROM OLD.term_started_at OR NEW.term_ends_at IS DISTINCT FROM OLD.term_ends_at THEN
    RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501'; END IF;
  IF OLD.state='ACTIVE' AND NEW.state='CANCELLED' THEN
    RETURN NEW;
  END IF;
  -- 0224: ACTIVE -> FROZEN only with the open pause row written for exactly this version step.
  IF OLD.state='ACTIVE' AND NEW.state='FROZEN' THEN
    IF NOT EXISTS(SELECT 1 FROM hon.membership_pauses x WHERE x.membership_id=NEW.id AND x.organization_id=NEW.organization_id
        AND x.school_id=NEW.school_id AND x.ended_kind IS NULL AND x.pause_prior_version=OLD.version AND x.pause_next_version=NEW.version) THEN
      RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  -- 0224: FROZEN -> ACTIVE or CANCELLED only with the pause row closed by that same kind for exactly this version step.
  IF OLD.state='FROZEN' AND NEW.state IN ('ACTIVE','CANCELLED') THEN
    IF NOT EXISTS(SELECT 1 FROM hon.membership_pauses x WHERE x.membership_id=NEW.id AND x.organization_id=NEW.organization_id
        AND x.school_id=NEW.school_id AND x.ended_kind=CASE WHEN NEW.state='ACTIVE' THEN 'RESUMED' ELSE 'CANCELLED' END
        AND x.end_prior_version=OLD.version AND x.end_next_version=NEW.version) THEN
      RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501';
END $$;

-- 0178 authority helpers: identity rules unchanged; the allow-list gains the three 0224 permissions.
CREATE OR REPLACE FUNCTION hon.membership_lifecycle_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT COALESCE(permission IN ('billing.membership.activate','billing.membership.activation.override','billing.membership.cancel',
      'billing.membership.dates.revise','billing.membership.dates.retroactive','billing.membership.read','reporting.view',
      'billing.membership.pause','billing.membership.pause_policy.manage','billing.membership.refund.record')
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=permission AND x.is_staff_assignable),false)
$$;

CREATE OR REPLACE FUNCTION hon.require_membership_lifecycle_actor(subject text,permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
  denial text:=CASE WHEN permission='billing.membership.cancel' THEN 'MEMBERSHIP_CANCELLATION_FORBIDDEN'
    WHEN permission='billing.membership.activation.override' THEN 'ACTIVATION_OVERRIDE_FORBIDDEN'
    WHEN permission='billing.membership.dates.revise' THEN 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'
    WHEN permission='billing.membership.dates.retroactive' THEN 'MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN'
    WHEN permission='billing.membership.read' THEN 'MEMBERSHIP_DATE_HISTORY_FORBIDDEN'
    WHEN permission='reporting.view' THEN 'MEMBERSHIP_STATUS_SUMMARY_FORBIDDEN'
    WHEN permission='billing.membership.pause' THEN 'MEMBERSHIP_PAUSE_FORBIDDEN'
    WHEN permission='billing.membership.pause_policy.manage' THEN 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN'
    WHEN permission='billing.membership.refund.record' THEN 'MEMBERSHIP_REFUND_RECORD_FORBIDDEN'
    ELSE 'MEMBERSHIP_ACTIVATION_FORBIDDEN' END;
BEGIN
  IF permission IS NULL OR permission NOT IN ('billing.membership.activate','billing.membership.activation.override','billing.membership.cancel',
      'billing.membership.dates.revise','billing.membership.dates.retroactive','billing.membership.read','reporting.view',
      'billing.membership.pause','billing.membership.pause_policy.manage','billing.membership.refund.record')
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
    -- A retroactive date change is only ever exercised together with the date revision permission at the same school.
    AND (permission<>'billing.membership.dates.retroactive' OR hon.membership_lifecycle_permission(p.id,org,school,'billing.membership.dates.revise'))
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION '%',denial USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Private helpers.
CREATE FUNCTION hon.membership_pause_text_ok(value jsonb,required boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN value IS NULL THEN NOT required
    ELSE jsonb_typeof(value)='string' AND length(value#>>'{}') BETWEEN 1 AND 1000 AND btrim(value#>>'{}')=value#>>'{}' AND value#>>'{}' !~ '[\x01-\x1f\x7f]' END
$$;
CREATE FUNCTION hon.membership_pause_date(value jsonb) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' !~ '^(20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  BEGIN RETURN to_date(value#>>'{}','YYYY-MM-DD');
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END;
END $$;
CREATE FUNCTION hon.membership_school_today() RETURNS date
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE tz text;
BEGIN
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=hon.current_school_id() AND s.organization_id=hon.current_organization_id();
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  RETURN hon.membership_local_date(clock_timestamp(),tz);
END $$;
CREATE FUNCTION hon.membership_pause_policy_json(org uuid,school uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT (SELECT jsonb_build_object('version',x.version,'pausesAllowed',x.pauses_allowed,'maxPauseDays',x.max_pause_days,
      'maxPausedDaysPerYear',x.max_paused_days_per_year,
      'holdFee',CASE WHEN x.hold_fee_minor IS NULL THEN NULL ELSE jsonb_build_object('amountMinor',x.hold_fee_minor,'currency',x.hold_fee_currency::text) END,
      'createdAt',to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    FROM hon.school_membership_pause_policies x WHERE x.organization_id=org AND x.school_id=school ORDER BY x.version DESC LIMIT 1)
$$;
CREATE FUNCTION hon.membership_pause_json(x hon.membership_pauses) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('pauseId',x.id,'membershipId',x.membership_id,'policyVersion',x.policy_version,
    'startsOn',to_char(x.starts_on,'YYYY-MM-DD'),'plannedResumeOn',to_char(x.planned_resume_on,'YYYY-MM-DD'),'pauseReason',x.pause_reason,
    'holdFee',CASE WHEN x.hold_fee_minor IS NULL THEN NULL ELSE jsonb_build_object('amountMinor',x.hold_fee_minor,'currency',x.hold_fee_currency::text) END,
    'pausedAt',to_char(x.paused_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endedKind',x.ended_kind,'endedOn',to_char(x.ended_on,'YYYY-MM-DD'),'endReason',x.end_reason,
    'endedAt',CASE WHEN x.ended_at IS NULL THEN NULL ELSE to_char(x.ended_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
$$;
CREATE FUNCTION hon.membership_refund_json(x hon.membership_refund_records) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('refundId',x.id,'membershipId',x.membership_id,'amountMinor',x.amount_minor,'currency',x.currency::text,
    'refundedOn',to_char(x.refunded_on,'YYYY-MM-DD'),'method',x.method,'reason',x.reason,
    'recordedAt',to_char(x.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

-- Shared idempotency for the 0224 commands: reserve the key, take the IAM SHARE locks, re-check live authority, and
-- return the stored response on an exact replay (after one more authority check). NULL means: proceed with the write.
CREATE FUNCTION hon.membership_pause_begin(subject text,permission text,key text,fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; reserved boolean; prior hon.idempotency_records%ROWTYPE;
BEGIN
  actor:=hon.require_membership_lifecycle_actor(subject,permission);
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_membership_lifecycle_actor(subject,permission) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION '%',CASE permission WHEN 'billing.membership.pause' THEN 'MEMBERSHIP_PAUSE_FORBIDDEN'
      WHEN 'billing.membership.pause_policy.manage' THEN 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN' ELSE 'MEMBERSHIP_REFUND_RECORD_FORBIDDEN' END USING ERRCODE='42501'; END IF;
  IF coalesce(reserved,false) THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.status<>'COMPLETED' OR jsonb_typeof(prior.response_body) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
  RETURN prior.response_body;
END $$;

CREATE FUNCTION hon.membership_pause_finish(subject text,permission text,key text,actor uuid,result jsonb,action text,entity_type text,entity uuid,
  prior_state jsonb,next_state jsonb,event text,aggregate_type text,aggregate uuid,aggregate_version integer,request uuid,correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI',action,entity_type,entity,prior_state,next_state,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,event,1,aggregate_type,aggregate,aggregate_version,correlation,request,next_state);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  -- A receipt is never returned after a live access loss.
  IF hon.require_membership_lifecycle_actor(subject,permission) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION '%',CASE permission WHEN 'billing.membership.pause' THEN 'MEMBERSHIP_PAUSE_FORBIDDEN'
      WHEN 'billing.membership.pause_policy.manage' THEN 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN'
      WHEN 'billing.membership.cancel' THEN 'MEMBERSHIP_CANCELLATION_FORBIDDEN' ELSE 'MEMBERSHIP_REFUND_RECORD_FORBIDDEN' END USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION hon.membership_command_args_ok(subject text,key text,request uuid,correlation uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT key IS NOT NULL AND request IS NOT NULL AND correlation IS NOT NULL AND length(key) BETWEEN 1 AND 200 AND btrim(key)=key
    AND request::text IS NOT DISTINCT FROM current_setting('app.hon_request_id',true)
$$;

-- Read: the school's current pause policy (null when none). Pause staff, policy managers and membership readers.
CREATE FUNCTION hon.read_school_membership_pause_policy(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text; used text; result jsonb;
BEGIN
  FOREACH permission IN ARRAY ARRAY['billing.membership.pause','billing.membership.pause_policy.manage','billing.membership.read'] LOOP
    BEGIN actor:=hon.require_membership_lifecycle_actor(subject,permission); used:=permission; EXIT;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  IF actor IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  result:=jsonb_build_object('policy',hon.membership_pause_policy_json(org,school),'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'));
  IF hon.require_membership_lifecycle_actor(subject,used) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- P2: set a new version of the school's pause policy. expectedVersion is the current version (0 when none).
CREATE FUNCTION hon.set_school_membership_pause_policy(subject text,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb; current_version integer;
  allowed boolean; max_days integer; year_days integer; fee integer; fee_currency text; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR NOT p ?& ARRAY['expectedVersion','pausesAllowed','maxPauseDays','maxPausedDaysPerYear','holdFee']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedVersion','pausesAllowed','maxPauseDays','maxPausedDaysPerYear','holdFee'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^(0|[1-9][0-9]{0,8})$'
    OR jsonb_typeof(p->'pausesAllowed') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p->'maxPauseDays') NOT IN ('number','null') OR (jsonb_typeof(p->'maxPauseDays')='number' AND (p->'maxPauseDays')::text !~ '^[1-9][0-9]{0,2}$')
    OR jsonb_typeof(p->'maxPausedDaysPerYear') NOT IN ('number','null') OR (jsonb_typeof(p->'maxPausedDaysPerYear')='number' AND (p->'maxPausedDaysPerYear')::text !~ '^[1-9][0-9]{0,2}$')
    OR jsonb_typeof(p->'holdFee') NOT IN ('object','null')
    OR (jsonb_typeof(p->'holdFee')='object' AND (NOT (p->'holdFee') ?& ARRAY['amountMinor','currency']
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(p->'holdFee') x WHERE x NOT IN ('amountMinor','currency'))
      OR jsonb_typeof(p#>'{holdFee,amountMinor}') IS DISTINCT FROM 'number' OR (p#>'{holdFee,amountMinor}')::text !~ '^(0|[1-9][0-9]{0,8})$'
      OR jsonb_typeof(p#>'{holdFee,currency}') IS DISTINCT FROM 'string' OR p#>>'{holdFee,currency}' !~ '^[A-Z]{3}$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  allowed:=(p->>'pausesAllowed')::boolean;
  max_days:=(p->>'maxPauseDays')::integer; year_days:=(p->>'maxPausedDaysPerYear')::integer;
  fee:=(p#>>'{holdFee,amountMinor}')::integer; fee_currency:=p#>>'{holdFee,currency}';
  IF (allowed AND (max_days IS NULL OR year_days IS NULL OR max_days>365 OR year_days>365 OR max_days>year_days))
    OR (NOT allowed AND (max_days IS NOT NULL OR year_days IS NOT NULL OR fee IS NOT NULL)) OR fee>100000000 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','billing.membership.pause_policy.set','input',p)::text,'UTF8')),'hex');
  replay:=hon.membership_pause_begin(subject,'billing.membership.pause_policy.manage',key,fp);
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.pause_policy.manage');
  IF replay IS NOT NULL THEN
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.pause_policy.manage') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_PAUSE_POLICY_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('policy',replay,'replayed',true);
  END IF;
  LOCK TABLE hon.school_membership_pause_policies IN SHARE ROW EXCLUSIVE MODE;
  SELECT coalesce(max(x.version),0) INTO current_version FROM hon.school_membership_pause_policies x WHERE x.organization_id=org AND x.school_id=school;
  IF current_version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.school_membership_pause_policies(organization_id,school_id,version,pauses_allowed,max_pause_days,max_paused_days_per_year,hold_fee_minor,hold_fee_currency,actor_principal_id)
    VALUES(org,school,current_version+1,allowed,max_days,year_days,fee,fee_currency,actor);
  result:=hon.membership_pause_policy_json(org,school);
  PERFORM hon.membership_pause_finish(subject,'billing.membership.pause_policy.manage',key,actor,result,'billing.membership.pause_policy.set',
    'SCHOOL',school,jsonb_build_object('version',current_version),result,'billing.membership.pause_policy.set','SCHOOL',school,current_version+1,request,correlation);
  RETURN jsonb_build_object('policy',result,'replayed',false);
END $$;

-- P1/P2: pause one ACTIVE current-school membership from the school's local today until resumeOn (exclusive).
-- Canonical order (0169/0177): key reservation; IAM SHARE; memberships ROW EXCLUSIVE + the row FOR UPDATE; policy and
-- schedules SHARE; then pause row, membership, audit and outbox last. The membership row lock alone serializes every
-- pause, resume and cancellation of one membership, so the pause table takes no table lock.
CREATE FUNCTION hon.pause_school_membership(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  m hon.memberships%ROWTYPE; updated hon.memberships%ROWTYPE; policy hon.school_membership_pause_policies%ROWTYPE; pause hon.membership_pauses%ROWTYPE;
  today date; resume_on date; used_days integer; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR NOT p ?& ARRAY['expectedVersion','resumeOn','pauseReason']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedVersion','resumeOn','pauseReason'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.membership_pause_text_ok(p->'pauseReason',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  resume_on:=hon.membership_pause_date(p->'resumeOn');
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','billing.membership.pause','membershipId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.membership_pause_begin(subject,'billing.membership.pause',key,fp);
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.pause');
  IF replay IS NOT NULL THEN
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.pause') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_PAUSE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('pause',replay,'replayed',true);
  END IF;
  LOCK TABLE hon.memberships IN ROW EXCLUSIVE MODE;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  LOCK TABLE hon.school_membership_pause_policies,hon.membership_payment_schedules IN SHARE MODE;
  IF m.state<>'ACTIVE' THEN RAISE EXCEPTION 'MEMBERSHIP_NOT_ACTIVE' USING ERRCODE='40001'; END IF;
  IF m.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  SELECT * INTO policy FROM hon.school_membership_pause_policies x WHERE x.organization_id=org AND x.school_id=school ORDER BY x.version DESC LIMIT 1;
  IF NOT FOUND OR NOT policy.pauses_allowed THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_NOT_OFFERED' USING ERRCODE='40001'; END IF;
  today:=hon.membership_school_today();
  IF resume_on<=today OR resume_on-today>policy.max_pause_days THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_TOO_LONG' USING ERRCODE='22023'; END IF;
  -- Days already paused (closed pauses up to their end, at most today) whose pause began in the last 365 days, plus this one.
  SELECT coalesce(sum(least(x.ended_on,today)-x.starts_on),0) INTO used_days FROM hon.membership_pauses x
    WHERE x.membership_id=m.id AND x.organization_id=org AND x.school_id=school AND x.starts_on>today-365;
  IF used_days+(resume_on-today)>policy.max_paused_days_per_year THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_YEARLY_LIMIT' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM hon.membership_payment_schedules s WHERE s.membership_id=m.id AND s.organization_id=org AND s.school_id=school AND s.status='ACTIVE') THEN
    RAISE EXCEPTION 'MEMBERSHIP_PAUSE_REQUIRES_BILLING_ARRANGEMENT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.membership_pauses(organization_id,school_id,membership_id,policy_version,starts_on,planned_resume_on,pause_reason,
      hold_fee_minor,hold_fee_currency,paused_by_principal_id,pause_prior_version,pause_next_version)
    VALUES(org,school,m.id,policy.version,today,resume_on,p->>'pauseReason',policy.hold_fee_minor,policy.hold_fee_currency,actor,m.version,m.version+1)
    RETURNING * INTO pause;
  UPDATE hon.memberships SET state='FROZEN',version=version+1
    WHERE id=m.id AND organization_id=org AND school_id=school AND state='ACTIVE' AND version=m.version RETURNING * INTO updated;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  result:=hon.membership_pause_json(pause)||jsonb_build_object('membershipState','FROZEN','membershipVersion',updated.version);
  PERFORM hon.membership_pause_finish(subject,'billing.membership.pause',key,actor,result,'billing.membership.pause','MEMBERSHIP',m.id,
    jsonb_build_object('state','ACTIVE','version',m.version),result,'billing.membership.paused','MEMBERSHIP',m.id,updated.version,request,correlation);
  RETURN jsonb_build_object('pause',result,'replayed',false);
END $$;

-- P1: resume one FROZEN current-school membership today. Term dates are unchanged.
CREATE FUNCTION hon.resume_school_membership(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  m hon.memberships%ROWTYPE; updated hon.memberships%ROWTYPE; pause hon.membership_pauses%ROWTYPE; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR NOT p ? 'expectedVersion'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedVersion','resumeReason'))
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.membership_pause_text_ok(p->'resumeReason',false) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','billing.membership.resume','membershipId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.membership_pause_begin(subject,'billing.membership.pause',key,fp);
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.pause');
  IF replay IS NOT NULL THEN
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.pause') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_PAUSE_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('pause',replay,'replayed',true);
  END IF;
  LOCK TABLE hon.memberships IN ROW EXCLUSIVE MODE;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF m.state<>'FROZEN' THEN RAISE EXCEPTION 'MEMBERSHIP_NOT_PAUSED' USING ERRCODE='40001'; END IF;
  IF m.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  UPDATE hon.membership_pauses SET ended_kind='RESUMED',ended_on=greatest(hon.membership_school_today(),starts_on),ended_by_principal_id=actor,
      ended_at=clock_timestamp(),end_reason=p->>'resumeReason',end_prior_version=m.version,end_next_version=m.version+1
    WHERE membership_id=m.id AND organization_id=org AND school_id=school AND ended_kind IS NULL AND pause_next_version=m.version
    RETURNING * INTO pause;
  IF pause.id IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_EVIDENCE_MISSING' USING ERRCODE='40001'; END IF;
  UPDATE hon.memberships SET state='ACTIVE',version=version+1
    WHERE id=m.id AND organization_id=org AND school_id=school AND state='FROZEN' AND version=m.version RETURNING * INTO updated;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  result:=hon.membership_pause_json(pause)||jsonb_build_object('membershipState','ACTIVE','membershipVersion',updated.version);
  PERFORM hon.membership_pause_finish(subject,'billing.membership.pause',key,actor,result,'billing.membership.resume','MEMBERSHIP',m.id,
    jsonb_build_object('state','FROZEN','version',m.version),result,'billing.membership.resumed','MEMBERSHIP',m.id,updated.version,request,correlation);
  RETURN jsonb_build_object('pause',result,'replayed',false);
END $$;

-- P3: the 0177 cancellation with the unchanged public contract and fingerprint, now also from FROZEN (the open
-- pause is closed as CANCELLED in the same step). effectiveAt remains evidence only; nothing is refunded.
CREATE OR REPLACE FUNCTION hon.cancel_school_membership(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean; reason text; effective text;
  effective_at timestamptz; prior hon.idempotency_records%ROWTYPE; m hon.memberships%ROWTYPE; updated hon.memberships%ROWTYPE; result jsonb; payload jsonb;
  pause_id uuid;
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
  IF m.state NOT IN ('ACTIVE','FROZEN') THEN RAISE EXCEPTION 'MEMBERSHIP_NOT_ACTIVE' USING ERRCODE='40001'; END IF;
  IF m.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF m.state='FROZEN' THEN
    UPDATE hon.membership_pauses SET ended_kind='CANCELLED',ended_on=greatest(hon.membership_school_today(),starts_on),ended_by_principal_id=actor,
        ended_at=clock_timestamp(),end_reason=reason,end_prior_version=m.version,end_next_version=m.version+1
      WHERE membership_id=m.id AND organization_id=org AND school_id=school AND ended_kind IS NULL AND pause_next_version=m.version
      RETURNING id INTO pause_id;
    IF pause_id IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_EVIDENCE_MISSING' USING ERRCODE='40001'; END IF;
  END IF;
  UPDATE hon.memberships SET state='CANCELLED',version=version+1
    WHERE id=m.id AND organization_id=org AND school_id=school AND state=m.state AND version=m.version RETURNING * INTO updated;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  result:=jsonb_build_object('id',updated.id,'billingAccountId',updated.billing_account_id,'participantPersonId',updated.participant_person_id,
    'planCode',updated.plan_code,'state','CANCELLED','version',updated.version,'cancellationReason',reason,
    'createdAt',to_char(updated.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF effective IS NOT NULL THEN result:=result||jsonb_build_object('effectiveAt',effective); END IF;
  payload:=jsonb_build_object('membershipId',updated.id,'state','CANCELLED','version',updated.version,'cancellationReason',reason,'effectiveAt',effective);
  IF pause_id IS NOT NULL THEN payload:=payload||jsonb_build_object('endedPauseId',pause_id); END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership.cancel','MEMBERSHIP',updated.id,jsonb_build_object('state',m.state::text,'version',m.version),
      payload,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.cancelled',1,'MEMBERSHIP',updated.id,updated.version,correlation,request,payload);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.cancel') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_CANCELLATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('membership',result,'replayed',false);
END $$;

-- P4: record one refund the school made outside HON for a CANCELLED current-school membership. Evidence only.
CREATE FUNCTION hon.record_membership_refund(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; replay jsonb;
  m hon.memberships%ROWTYPE; refund hon.membership_refund_records%ROWTYPE; refunded_on date; result jsonb;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected IS NULL OR NOT hon.membership_command_args_ok(subject,key,request,correlation)
    OR NOT p ?& ARRAY['amountMinor','currency','refundedOn','method','reason']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('amountMinor','currency','refundedOn','method','reason'))
    OR jsonb_typeof(p->'amountMinor') IS DISTINCT FROM 'number' OR (p->'amountMinor')::text !~ '^[1-9][0-9]{0,8}$' OR (p->>'amountMinor')::bigint>100000000
    OR jsonb_typeof(p->'currency') IS DISTINCT FROM 'string' OR p->>'currency' !~ '^[A-Z]{3}$'
    OR jsonb_typeof(p->'method') IS DISTINCT FROM 'string' OR p->>'method' NOT IN ('CASH','CHECK','CARD_TERMINAL','BANK_TRANSFER','OTHER')
    OR NOT hon.membership_pause_text_ok(p->'reason',true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  refunded_on:=hon.membership_pause_date(p->'refundedOn');
  fp:=encode(sha256(convert_to(jsonb_build_object('operation','billing.membership.refund.record','membershipId',selected,'input',p)::text,'UTF8')),'hex');
  replay:=hon.membership_pause_begin(subject,'billing.membership.refund.record',key,fp);
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.refund.record');
  IF replay IS NOT NULL THEN
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.refund.record') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_REFUND_RECORD_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('refund',replay,'replayed',true);
  END IF;
  LOCK TABLE hon.memberships IN ROW EXCLUSIVE MODE;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF m.state<>'CANCELLED' THEN RAISE EXCEPTION 'MEMBERSHIP_NOT_CANCELLED' USING ERRCODE='40001'; END IF;
  IF refunded_on>hon.membership_school_today() OR refunded_on<hon.membership_local_date(m.created_at,(SELECT s.timezone FROM hon.schools s WHERE s.id=school)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.membership_refund_records(organization_id,school_id,membership_id,amount_minor,currency,refunded_on,method,reason,actor_principal_id)
    VALUES(org,school,m.id,(p->>'amountMinor')::integer,p->>'currency',refunded_on,p->>'method',p->>'reason',actor) RETURNING * INTO refund;
  result:=hon.membership_refund_json(refund);
  PERFORM hon.membership_pause_finish(subject,'billing.membership.refund.record',key,actor,result,'billing.membership.refund.record','MEMBERSHIP',m.id,
    jsonb_build_object('state',m.state::text,'version',m.version),result,'billing.membership.refund_recorded','MEMBERSHIP',m.id,m.version,request,correlation);
  RETURN jsonb_build_object('refund',result,'replayed',false);
END $$;

-- Read: one current-school membership's pauses (newest first) and recorded refunds (newest first), at most 100 each.
CREATE FUNCTION hon.read_membership_pauses_and_refunds(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text; used text; m hon.memberships%ROWTYPE; result jsonb;
BEGIN
  FOREACH permission IN ARRAY ARRAY['billing.membership.read','billing.membership.pause','billing.membership.refund.record'] LOOP
    BEGIN actor:=hon.require_membership_lifecycle_actor(subject,permission); used:=permission; EXIT;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END LOOP;
  IF actor IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_PAUSE_HISTORY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF selected IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=jsonb_build_object('membershipId',m.id,'state',m.state::text,'version',m.version,
    'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'pauses',coalesce((SELECT jsonb_agg(hon.membership_pause_json(x) ORDER BY x.paused_at DESC,x.id)
      FROM (SELECT * FROM hon.membership_pauses y WHERE y.membership_id=m.id AND y.organization_id=org AND y.school_id=school ORDER BY y.paused_at DESC,y.id LIMIT 100) x),'[]'::jsonb),
    'refunds',coalesce((SELECT jsonb_agg(hon.membership_refund_json(x) ORDER BY x.recorded_at DESC,x.id)
      FROM (SELECT * FROM hon.membership_refund_records y WHERE y.membership_id=m.id AND y.organization_id=org AND y.school_id=school ORDER BY y.recorded_at DESC,y.id LIMIT 100) x),'[]'::jsonb));
  IF hon.require_membership_lifecycle_actor(subject,used) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_PAUSE_HISTORY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON TABLE hon.school_membership_pause_policies IS
'0224 immutable per-school membership pause policy versions (owner P2): whether pauses are offered, maximum days per pause, maximum paused days per rolling 365 days, recorded hold fee (policy only, never charged). Private.';
COMMENT ON TABLE hon.membership_pauses IS
'0224 one row per membership pause (owner P1): written open with ACTIVE->FROZEN, closed once by a resume (FROZEN->ACTIVE) or a cancellation (FROZEN->CANCELLED). Term dates never change. Private.';
COMMENT ON TABLE hon.membership_refund_records IS
'0224 immutable evidence of a refund the school made outside HON for a cancelled membership (owner P4). HON moves no money. Private.';
COMMENT ON FUNCTION hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI pause of one ACTIVE current-school membership from the school-local today until resumeOn, within the school pause policy; refused while an ACTIVE payment schedule exists. No payment, schedule, invoice, provider, communication, AI or automation effect.';
COMMENT ON FUNCTION hon.resume_school_membership(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI resume of one FROZEN current-school membership today; term dates unchanged. No payment, schedule, invoice, provider, communication, AI or automation effect.';
COMMENT ON FUNCTION hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI immediate cancellation (owner P3) of one ACTIVE or FROZEN membership with the unchanged public contract, key-first canonical order and live billing.membership.cancel re-checks; a FROZEN membership''s open pause is closed as CANCELLED. effectiveAt is evidence only. No refund, credit, proration, payment, provider, communication, AI or automation effect.';
COMMENT ON FUNCTION hon.record_membership_refund(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI record of a refund the school made outside HON for one CANCELLED current-school membership (owner P4). Evidence only: no payment, provider, ledger, invoice or communication effect.';
COMMENT ON FUNCTION hon.set_school_membership_pause_policy(text,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI new version of the current school''s membership pause policy (owner P2). The hold fee is recorded policy only.';
COMMENT ON FUNCTION hon.read_school_membership_pause_policy(text) IS
'Direct HUMAN_UI read-only current-school membership pause policy and school-local today. No DML.';
COMMENT ON FUNCTION hon.read_membership_pauses_and_refunds(text,uuid) IS
'Direct HUMAN_UI read-only pauses and recorded refunds of one current-school membership. No DML.';

DO $$ DECLARE r text; col text; t text; BEGIN
  REVOKE ALL ON TABLE hon.school_membership_pause_policies,hon.membership_pauses,hon.membership_refund_records FROM PUBLIC;
  REVOKE ALL ON FUNCTION hon.guard_school_membership_pause_policy_insert(),hon.guard_membership_pause(),hon.guard_membership_state_transition(),
    hon.membership_lifecycle_permission(uuid,uuid,uuid,text),hon.require_membership_lifecycle_actor(text,text),
    hon.membership_pause_text_ok(jsonb,boolean),hon.membership_pause_date(jsonb),hon.membership_school_today(),hon.membership_pause_policy_json(uuid,uuid),
    hon.membership_pause_json(hon.membership_pauses),hon.membership_refund_json(hon.membership_refund_records),
    hon.membership_pause_begin(text,text,text,text),
    hon.membership_pause_finish(text,text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,text,uuid,integer,uuid,uuid),
    hon.membership_command_args_ok(text,text,uuid,uuid),hon.read_school_membership_pause_policy(text),
    hon.set_school_membership_pause_policy(text,jsonb,text,uuid,uuid),hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid),
    hon.resume_school_membership(text,uuid,jsonb,text,uuid,uuid),hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid),
    hon.record_membership_refund(text,uuid,jsonb,text,uuid,uuid),hon.read_membership_pauses_and_refunds(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.school_membership_pause_policies,hon.membership_pauses,hon.membership_refund_records FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_school_membership_pause_policy_insert(),hon.guard_membership_pause(),hon.guard_membership_state_transition(),
      hon.membership_lifecycle_permission(uuid,uuid,uuid,text),hon.require_membership_lifecycle_actor(text,text),
      hon.membership_pause_text_ok(jsonb,boolean),hon.membership_pause_date(jsonb),hon.membership_school_today(),hon.membership_pause_policy_json(uuid,uuid),
      hon.membership_pause_json(hon.membership_pauses),hon.membership_refund_json(hon.membership_refund_records),
      hon.membership_pause_begin(text,text,text,text),
      hon.membership_pause_finish(text,text,text,uuid,jsonb,text,text,uuid,jsonb,jsonb,text,text,uuid,integer,uuid,uuid),
      hon.membership_command_args_ok(text,text,uuid,uuid),hon.read_school_membership_pause_policy(text),
      hon.set_school_membership_pause_policy(text,jsonb,text,uuid,uuid),hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid),
      hon.resume_school_membership(text,uuid,jsonb,text,uuid,uuid),hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid),
      hon.record_membership_refund(text,uuid,jsonb,text,uuid,uuid),hon.read_membership_pauses_and_refunds(text,uuid) FROM %I',r);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['school_membership_pause_policies','membership_pauses','membership_refund_records'] LOOP
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_membership_pause_policy(text),hon.set_school_membership_pause_policy(text,jsonb,text,uuid,uuid),
      hon.pause_school_membership(text,uuid,jsonb,text,uuid,uuid),hon.resume_school_membership(text,uuid,jsonb,text,uuid,uuid),
      hon.cancel_school_membership(text,uuid,jsonb,text,uuid,uuid),hon.record_membership_refund(text,uuid,jsonb,text,uuid,uuid),
      hon.read_membership_pauses_and_refunds(text,uuid) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    IF has_any_column_privilege('hon_runtime','hon.memberships','UPDATE') OR has_table_privilege('hon_runtime','hon.memberships','DELETE')
      OR has_table_privilege('hon_runtime','hon.memberships','INSERT')
      OR has_table_privilege('hon_runtime','hon.membership_pauses','SELECT') OR has_table_privilege('hon_runtime','hon.membership_refund_records','SELECT')
      OR has_table_privilege('hon_runtime','hon.school_membership_pause_policies','SELECT') THEN
      RAISE EXCEPTION 'Membership pause and cancellation must not widen runtime privileges';
    END IF;
  END IF;
END $$;
COMMIT;
