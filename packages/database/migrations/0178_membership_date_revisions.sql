BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Membership date revisions require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Membership date revisions require a restricted runtime';
  END IF;
  IF to_regclass('hon.membership_activation_decisions') IS NULL OR to_regclass('hon.membership_effective_periods') IS NULL
    OR to_regprocedure('hon.activate_school_membership(text,uuid,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.membership_local_day_start(date,text)') IS NULL
    OR to_regclass('hon.membership_renewal_reviews') IS NULL OR to_regclass('hon.membership_payment_schedules') IS NULL THEN
    RAISE EXCEPTION 'Membership date revisions require 0014, 0080 and 0177';
  END IF;
  -- The trigger function is replaced in place; the trigger itself must still be exactly the 0177 guard.
  IF (SELECT array_agg(tgname::text) FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND NOT tgisinternal) IS DISTINCT FROM ARRAY['membership_state_transition_guard']
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='hon.memberships'::regclass AND tgname='membership_state_transition_guard'
      AND tgfoid='hon.guard_membership_state_transition()'::regprocedure AND tgenabled='O') THEN
    RAISE EXCEPTION 'Membership date revisions expect exactly the enabled 0177 transition guard on hon.memberships';
  END IF;
  -- The three 0177 bodies this migration replaces must be exactly the reviewed ones.
  IF EXISTS (SELECT 1 FROM (VALUES
      ('hon.guard_membership_state_transition()','6d63f5d9b6f80ffec813f603358bc3d71595a6781c3bfdbe876d51fd79d214a8'),
      ('hon.membership_lifecycle_permission(uuid,uuid,uuid,text)','069bd081b7b5cc340268f1c0e5a183664046b6b7f8e027398d4288197c1efde0'),
      ('hon.require_membership_lifecycle_actor(text,text)','b7d183d8bdf941f49b13d717d43828ad0a24ca5aaa368ecd0be9171c0e87584c')) e(signature,body_hash)
    WHERE encode(sha256(convert_to((SELECT prosrc FROM pg_proc WHERE oid=e.signature::regprocedure),'UTF8')),'hex') IS DISTINCT FROM e.body_hash) THEN
    RAISE EXCEPTION 'Membership date revisions expect the reviewed 0177 function bodies';
  END IF;
END $$;

-- E1b-1 membership date management (owner decisions E1b-D1..D8). A confirmed (ACTIVE) membership's school-local
-- dates can be revised through a two-step, direct-human, school-scoped command that writes one immutable revision
-- row (the decision and the resulting effective period), then the projection and version. Kinds:
--   INITIAL_CONFIRMATION  first confirmed dates for an ACTIVE membership that has no confirmed period (pre-0177)
--   CORRECTION            the confirmed dates were recorded wrongly
--   EXTENSION             same start, later (or open) end
--   EARLY_END             same start, earlier end
-- The 0177 transition trigger gains exactly one ACTIVE->ACTIVE branch bound to the latest revision row; the runtime
-- gains no privilege on hon.memberships. Nothing here creates, changes or evaluates an agreement, consent, payer,
-- payment, payment method, schedule, invoice, refund, credit, price, provider call, communication, SaaS billing or
-- entitlement effect. A schedule or open invoice that would contradict the new dates refuses the revision (deferred
-- to the later arrangement workflow); other financial records are disclosed for acknowledgement and left unchanged.
-- E1b-D1: the two new permissions are initially granted to system OWNER roles only; owners delegate them per school.

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('billing.membership.dates.revise','Human two-step revision of a confirmed membership''s school-local dates at one school',true,true),
  ('billing.membership.dates.retroactive','Human revision of membership dates that changes whether a past school-local day was in effect (with dates.revise)',true,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code IN ('billing.membership.dates.revise','billing.membership.dates.retroactive')
      AND is_sensitive AND is_staff_assignable)<>2 THEN
    RAISE EXCEPTION 'Membership date permissions already exist with an unexpected definition';
  END IF;
END $$;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id,r.organization_id,granted.code FROM hon.roles r
CROSS JOIN (VALUES ('billing.membership.dates.revise'),('billing.membership.dates.retroactive')) granted(code)
WHERE r.is_system_role AND r.code='OWNER'
ON CONFLICT DO NOTHING;

-- One immutable row per revision: the decision and the resulting effective period. INITIAL_CONFIRMATION is period
-- version 1 of a membership that has no 0177 INITIAL period; every other kind is the previous period version + 1.
CREATE TABLE hon.membership_date_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  change_kind text NOT NULL CHECK (change_kind IN ('INITIAL_CONFIRMATION','CORRECTION','EXTENSION','EARLY_END')),
  period_version integer NOT NULL CHECK (period_version BETWEEN 1 AND 200),
  prior_period_version integer,
  prior_start_date date,
  prior_end_date date,
  prior_term_started_at timestamptz,
  prior_term_ends_at timestamptz,
  start_date date NOT NULL CHECK (start_date>=date '2000-01-01'),
  end_date date,
  school_timezone text NOT NULL CHECK (length(school_timezone) BETWEEN 1 AND 64),
  term_started_at timestamptz NOT NULL,
  term_ends_at timestamptz,
  date_source text NOT NULL CHECK (date_source IN ('SUGGESTED','STAFF_ADJUSTED','STAFF_ENTERED')),
  suggested_start_date date,
  suggested_end_date date,
  suggestion_basis jsonb CHECK (suggestion_basis IS NULL OR jsonb_typeof(suggestion_basis)='object'),
  adjustment_reason text CHECK (adjustment_reason IS NULL OR (length(adjustment_reason) BETWEEN 1 AND 500 AND btrim(adjustment_reason)=adjustment_reason AND adjustment_reason !~ '[[:cntrl:]]')),
  prior_membership_version integer NOT NULL CHECK (prior_membership_version>=1),
  next_membership_version integer NOT NULL,
  decision_basis text NOT NULL CHECK (decision_basis='STAFF_REVISION_PRE_POLICY'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  authorizing_permission text NOT NULL CHECK (authorizing_permission='billing.membership.dates.revise'),
  retroactive_permission text CHECK (retroactive_permission IS NULL OR retroactive_permission='billing.membership.dates.retroactive'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z_]{1,40}$'),
  reason_text text NOT NULL CHECK (length(reason_text) BETWEEN 10 AND 500 AND btrim(reason_text)=reason_text AND reason_text !~ '[[:cntrl:]]'),
  acknowledged_warnings jsonb NOT NULL CHECK (jsonb_typeof(acknowledged_warnings)='array'),
  retroactive_days jsonb NOT NULL CHECK (jsonb_typeof(retroactive_days)='object'),
  financial_facts jsonb NOT NULL CHECK (jsonb_typeof(financial_facts)='object'),
  financial_effects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (financial_effects='[]'::jsonb),
  requirements_not_evaluated jsonb NOT NULL CHECK (requirements_not_evaluated='["AGREEMENT","PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]'::jsonb),
  preview_digest text NOT NULL CHECK (preview_digest ~ '^[a-f0-9]{64}$'),
  evaluated_facts jsonb NOT NULL CHECK (jsonb_typeof(evaluated_facts)='object'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200 AND btrim(idempotency_key)=idempotency_key),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  approval_reference uuid CHECK (approval_reference IS NULL),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((change_kind='INITIAL_CONFIRMATION')=(period_version=1)),
  CHECK ((change_kind='INITIAL_CONFIRMATION')=(prior_period_version IS NULL)),
  CHECK (prior_period_version IS NULL OR period_version=prior_period_version+1),
  CHECK ((prior_period_version IS NULL) OR prior_start_date IS NOT NULL),
  CHECK ((prior_period_version IS NOT NULL) OR (prior_start_date IS NULL AND prior_end_date IS NULL)),
  CHECK (end_date IS NULL OR end_date>=start_date),
  CHECK ((end_date IS NULL)=(term_ends_at IS NULL)),
  CHECK (term_ends_at IS NULL OR term_ends_at>term_started_at),
  CHECK ((date_source='STAFF_ADJUSTED')=(adjustment_reason IS NOT NULL)),
  CHECK ((date_source='STAFF_ENTERED')=(suggested_start_date IS NULL)),
  CHECK (next_membership_version=prior_membership_version+1),
  CHECK ((retroactive_permission IS NULL)=(retroactive_days='{"added":0,"removed":0}'::jsonb)),
  UNIQUE(membership_id,period_version),
  UNIQUE(membership_id,next_membership_version),
  UNIQUE(id,organization_id,school_id),
  UNIQUE(organization_id,school_id,actor_principal_id,idempotency_key),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT
);

-- Billing-review reminders created by a revision whose financial disclosures were acknowledged. Reminders only.
CREATE TABLE hon.membership_date_revision_follow_ups (
  revision_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind='BILLING_REVIEW'),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  work_item_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(revision_id,kind),
  FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY(revision_id,organization_id,school_id) REFERENCES hon.membership_date_revisions(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY(work_item_id,organization_id,school_id) REFERENCES hon.work_items(id,organization_id,school_id) ON DELETE RESTRICT
);

ALTER TABLE hon.membership_date_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_date_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_date_revision_follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_date_revision_follow_ups FORCE ROW LEVEL SECURITY;
CREATE TRIGGER membership_date_revisions_immutable BEFORE UPDATE OR DELETE ON hon.membership_date_revisions FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_date_revisions_no_truncate BEFORE TRUNCATE ON hon.membership_date_revisions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_date_revision_follow_ups_immutable BEFORE UPDATE OR DELETE ON hon.membership_date_revision_follow_ups FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_activation_evidence();
CREATE TRIGGER membership_date_revision_follow_ups_no_truncate BEFORE TRUNCATE ON hon.membership_date_revision_follow_ups FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- Settings-free integrity of the history: a revision row must continue exactly the current period of the current
-- ACTIVE membership version. INITIAL_CONFIRMATION only when no period of any kind exists.
CREATE FUNCTION hon.guard_membership_date_revision_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE m hon.memberships%ROWTYPE; latest_version integer; latest_start date; latest_end date; found_latest boolean:=false;
BEGIN
  SELECT * INTO m FROM hon.memberships x WHERE x.id=NEW.membership_id AND x.organization_id=NEW.organization_id AND x.school_id=NEW.school_id;
  IF NOT FOUND OR m.state<>'ACTIVE' OR m.version IS DISTINCT FROM NEW.prior_membership_version
    OR m.term_started_at IS DISTINCT FROM NEW.prior_term_started_at OR m.term_ends_at IS DISTINCT FROM NEW.prior_term_ends_at THEN
    RAISE EXCEPTION 'MEMBERSHIP_DATE_REVISION_DENIED' USING ERRCODE='42501'; END IF;
  SELECT r.period_version,r.start_date,r.end_date,true INTO latest_version,latest_start,latest_end,found_latest
    FROM hon.membership_date_revisions r WHERE r.membership_id=NEW.membership_id ORDER BY r.period_version DESC LIMIT 1;
  IF NOT coalesce(found_latest,false) THEN
    SELECT p.period_version,p.start_date,p.end_date,true INTO latest_version,latest_start,latest_end,found_latest
      FROM hon.membership_effective_periods p WHERE p.membership_id=NEW.membership_id ORDER BY p.period_version DESC LIMIT 1;
  END IF;
  found_latest:=coalesce(found_latest,false);
  IF NEW.change_kind='INITIAL_CONFIRMATION' THEN
    IF found_latest THEN RAISE EXCEPTION 'MEMBERSHIP_DATE_REVISION_DENIED' USING ERRCODE='42501'; END IF;
  ELSIF NOT found_latest OR NEW.prior_period_version IS DISTINCT FROM latest_version
    OR NEW.prior_start_date IS DISTINCT FROM latest_start OR NEW.prior_end_date IS DISTINCT FROM latest_end THEN
    RAISE EXCEPTION 'MEMBERSHIP_DATE_REVISION_DENIED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_date_revision_insert_guard BEFORE INSERT ON hon.membership_date_revisions
FOR EACH ROW EXECUTE FUNCTION hon.guard_membership_date_revision_insert();

-- The 0177 settings-free lifecycle allow-list, verbatim, with one added branch: an ACTIVE membership may change only
-- its projection and version, and only to exactly the latest immutable revision row for this version pair.
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
  IF OLD.state='ACTIVE' AND NEW.state='CANCELLED' AND NEW.term_started_at IS NOT DISTINCT FROM OLD.term_started_at
    AND NEW.term_ends_at IS NOT DISTINCT FROM OLD.term_ends_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MEMBERSHIP_STATE_TRANSITION_DENIED' USING ERRCODE='42501';
END $$;

-- 0177 authority helpers: the identity rules are unchanged; the allow-list gains the date permissions, the membership
-- read permission (date history) and reporting.view (status summary). dates.retroactive is only ever exercised
-- together with dates.revise at the same school, exactly like the activation override.
CREATE OR REPLACE FUNCTION hon.membership_lifecycle_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT COALESCE(permission IN ('billing.membership.activate','billing.membership.activation.override','billing.membership.cancel',
      'billing.membership.dates.revise','billing.membership.dates.retroactive','billing.membership.read','reporting.view')
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
    ELSE 'MEMBERSHIP_ACTIVATION_FORBIDDEN' END;
BEGIN
  IF permission IS NULL OR permission NOT IN ('billing.membership.activate','billing.membership.activation.override','billing.membership.cancel',
      'billing.membership.dates.revise','billing.membership.dates.retroactive','billing.membership.read','reporting.view')
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

-- Private formatting and calendar helpers.
CREATE FUNCTION hon.membership_instant_text(instant timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN instant IS NULL THEN NULL ELSE to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;
-- k-th anchored fixed-term end: original start + k*N months (PostgreSQL month addition, as 0175/0177) - 1 day.
-- Returns the first anchored end strictly after `after` (NULL = the first term end).
CREATE FUNCTION hon.membership_next_anchored_term_end(start date,months integer,after date) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE e date;
BEGIN
  IF start IS NULL OR months IS NULL OR months<1 THEN RETURN NULL; END IF;
  FOR k IN 1..1300 LOOP
    e:=(start+make_interval(months=>months*k))::date-1;
    IF after IS NULL OR e>after THEN RETURN e; END IF;
  END LOOP;
  RETURN NULL;
END $$;
-- Past school-local days (< today) whose in-effect status differs between the old and new inclusive date ranges.
CREATE FUNCTION hon.membership_date_revision_retroactive_days(old_start date,old_end date,new_start date,new_end date,today date) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE y date:=today-1; oa date; ob date; na date; nb date; o integer:=0; n integer:=0; i integer:=0;
BEGIN
  IF old_start IS NOT NULL THEN oa:=old_start; ob:=least(coalesce(old_end,y),y); IF ob>=oa THEN o:=ob-oa+1; END IF; END IF;
  IF new_start IS NOT NULL THEN na:=new_start; nb:=least(coalesce(new_end,y),y); IF nb>=na THEN n:=nb-na+1; END IF; END IF;
  IF o>0 AND n>0 AND least(ob,nb)>=greatest(oa,na) THEN i:=least(ob,nb)-greatest(oa,na)+1; END IF;
  RETURN jsonb_build_object('added',n-i,'removed',o-i);
END $$;

-- The current confirmed effective period (the latest of the 0177 INITIAL period and the 0178 revisions), or NULL.
CREATE FUNCTION hon.membership_current_period(selected uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT x.period FROM (
    SELECT r.period_version v,jsonb_build_object('source','REVISION','periodVersion',r.period_version,'changeKind',r.change_kind,
      'startDate',r.start_date,'endDate',r.end_date,'endDateInclusive',true,'schoolTimezone',r.school_timezone,
      'termStartedAt',hon.membership_instant_text(r.term_started_at),'termEndsAt',hon.membership_instant_text(r.term_ends_at)) period
    FROM hon.membership_date_revisions r WHERE r.membership_id=selected
    UNION ALL
    SELECT p.period_version,jsonb_build_object('source','ACTIVATION','periodVersion',p.period_version,'changeKind',p.change_kind,
      'startDate',p.start_date,'endDate',p.end_date,'endDateInclusive',true,'schoolTimezone',p.school_timezone,
      'termStartedAt',hon.membership_instant_text(p.term_started_at),'termEndsAt',hon.membership_instant_text(p.term_ends_at))
    FROM hon.membership_effective_periods p WHERE p.membership_id=selected
  ) x ORDER BY x.v DESC LIMIT 1
$$;

-- Reporting status. ACTIVE is the confirmed lifecycle state, never "in effect now" by itself: a confirmed period
-- derives SCHEDULED/IN_EFFECT/ENDED from its projection; an ACTIVE row with no confirmed period is UNDATED even when
-- legacy instants are stored (they are hints, not confirmed dates). Other lifecycle states are returned as stored.
CREATE FUNCTION hon.membership_reporting_status(lifecycle hon.membership_state,start_at timestamptz,end_at timestamptz,confirmed boolean,at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN lifecycle<>'ACTIVE' THEN lifecycle::text WHEN NOT coalesce(confirmed,false) THEN 'UNDATED'
    ELSE hon.membership_effective_status_at(lifecycle,start_at,end_at,at) END
$$;

-- Private, actor-independent, DML-free evaluation of one current-school membership against the E1b revision rules for
-- one kind and either the suggested dates or one proposed date pair. Returns {facts, participantDisplayName}. facts
-- is the exact object digested by preview and re-derived by confirmation (identifiers, codes, dates only).
CREATE FUNCTION hon.evaluate_membership_date_revision(selected uuid,kind text,has_proposal boolean,proposed_start date,proposed_end date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); at timestamptz:=clock_timestamp();
  m hon.memberships%ROWTYPE; selection hon.membership_plan_selections%ROWTYPE; terms hon.membership_plan_versions%ROWTYPE;
  tz text; today date; cur jsonb; confirmed boolean; plan jsonb; plan_summary jsonb; fixed_term boolean:=false; open_plan boolean:=false;
  warnings jsonb:='[]'::jsonb; blocks jsonb:='[]'::jsonb; o_start date; o_end date; s_start date; s_end date; start_basis text; end_basis text;
  p_start date; p_end date; date_source text; date_blocked boolean:=false; projected_start timestamptz; projected_end timestamptz;
  retro jsonb:='{"added":0,"removed":0}'::jsonb; plan_end date; shortening boolean:=false; status_now text; status_next text;
  schedules jsonb; invoices jsonb; n_schedules integer; n_invoices integer; f record; label text; required jsonb;
  schedule_conflict boolean:=false; schedule_unchanged integer:=0; invoice_conflict boolean:=false; open_invoice boolean:=false;
  paid_invoice boolean:=false; draft_invoice boolean:=false; revisions integer;
BEGIN
  IF selected IS NULL OR org IS NULL OR school IS NULL OR has_proposal IS NULL
    OR kind IS NULL OR kind NOT IN ('INITIAL_CONFIRMATION','CORRECTION','EXTENSION','EARLY_END') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  today:=hon.membership_local_date(at,tz);
  -- E1b-D5: only confirmed (ACTIVE) memberships; DRAFT uses activation, CANCELLED and other states are never revised.
  IF m.state<>'ACTIVE' THEN blocks:=blocks||jsonb_build_object('code','MEMBERSHIP_NOT_ACTIVE'); END IF;
  cur:=hon.membership_current_period(m.id);
  confirmed:=cur IS NOT NULL;
  IF (kind='INITIAL_CONFIRMATION')=confirmed THEN blocks:=blocks||jsonb_build_object('code','CHANGE_KIND_NOT_APPLICABLE'); END IF;
  SELECT count(*) INTO revisions FROM hon.membership_date_revisions r WHERE r.membership_id=m.id;
  IF revisions>=199 THEN blocks:=blocks||jsonb_build_object('code','REVISION_LIMIT_REACHED'); END IF;

  -- Plan binding (0175): its term shapes suggestions and acknowledgements; nothing about the plan or price changes.
  SELECT * INTO selection FROM hon.membership_plan_selections x WHERE x.membership_id=m.id AND x.organization_id=org AND x.school_id=school;
  IF FOUND THEN
    SELECT * INTO terms FROM hon.membership_plan_versions v WHERE v.plan_id=selection.plan_id AND v.version=selection.plan_version AND v.organization_id=org AND v.school_id=school;
    plan_summary:=hon.membership_plan_version_summary(selection.plan_id,selection.plan_version);
    plan:=jsonb_build_object('membershipPlanId',selection.plan_id,'membershipPlanVersion',selection.plan_version,'terms',plan_summary);
    IF terms.plan_id IS NULL OR plan_summary IS NULL OR plan_summary->>'planCode' IS DISTINCT FROM m.plan_code THEN
      blocks:=blocks||jsonb_build_object('code','PLAN_BINDING_INVALID');
    ELSE
      fixed_term:=terms.term_kind='FIXED_MONTHS'; open_plan:=terms.term_kind='OPEN_ENDED';
    END IF;
  END IF;

  -- The dates being replaced: the current confirmed period, or (legacy) the local dates of the stored instants.
  IF confirmed THEN
    o_start:=(cur->>'startDate')::date; o_end:=(cur->>'endDate')::date;
  ELSIF m.term_started_at IS NOT NULL THEN
    o_start:=hon.membership_local_date(m.term_started_at,tz);
    o_end:=CASE WHEN m.term_ends_at IS NULL THEN NULL ELSE hon.membership_local_date(m.term_ends_at-interval '1 microsecond',tz) END;
    IF o_end IS NOT NULL AND o_end<o_start THEN o_end:=o_start; END IF;
  END IF;

  -- HON suggests; staff confirm. Suggestions exist only for INITIAL_CONFIRMATION with stored legacy instants and for
  -- fixed-term EXTENSION (anchored to the confirmed start, E1b-D4); otherwise staff enter the dates.
  IF kind='INITIAL_CONFIRMATION' AND m.term_started_at IS NOT NULL THEN
    s_start:=o_start; start_basis:='LEGACY_STORED_START';
    IF m.term_ends_at IS NOT NULL THEN s_end:=o_end; end_basis:='LEGACY_STORED_END';
    ELSIF fixed_term THEN s_end:=hon.membership_next_anchored_term_end(s_start,terms.term_months,NULL); end_basis:='PLAN_FIXED_TERM';
    ELSE s_end:=NULL; end_basis:='NO_END_DATE'; END IF;
  ELSIF kind='EXTENSION' AND confirmed AND fixed_term AND o_end IS NOT NULL THEN
    s_start:=o_start; start_basis:='CURRENT_START';
    s_end:=hon.membership_next_anchored_term_end(o_start,terms.term_months,o_end); end_basis:='PLAN_FIXED_TERM_ANCHORED';
  END IF;
  IF has_proposal THEN p_start:=proposed_start; p_end:=proposed_end;
  ELSIF s_start IS NOT NULL THEN p_start:=s_start; p_end:=s_end;
  ELSE RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  date_source:=CASE WHEN s_start IS NULL THEN 'STAFF_ENTERED' WHEN p_start=s_start AND p_end IS NOT DISTINCT FROM s_end THEN 'SUGGESTED' ELSE 'STAFF_ADJUSTED' END;

  -- E1a date windows and plan rules.
  IF p_start IS NULL OR p_start<date '2000-01-01' OR p_start>today+730 THEN
    blocks:=blocks||jsonb_build_object('code','START_DATE_OUT_OF_RANGE'); date_blocked:=true; END IF;
  IF p_end IS NOT NULL AND p_start IS NOT NULL AND p_end<p_start THEN
    blocks:=blocks||jsonb_build_object('code','END_DATE_BEFORE_START'); date_blocked:=true;
  ELSIF p_end IS NOT NULL AND p_start IS NOT NULL AND p_end>p_start+3653 THEN
    blocks:=blocks||jsonb_build_object('code','END_DATE_OUT_OF_RANGE'); date_blocked:=true; END IF;
  IF fixed_term AND p_end IS NULL THEN blocks:=blocks||jsonb_build_object('code','FIXED_TERM_END_DATE_REQUIRED'); date_blocked:=true; END IF;

  IF NOT date_blocked THEN
    projected_start:=hon.membership_local_day_start(p_start,tz);
    projected_end:=CASE WHEN p_end IS NULL THEN NULL ELSE hon.membership_local_day_start(p_end+1,tz) END;
    -- Kind shapes. A revision must change something; EXTENSION and EARLY_END keep the start.
    IF confirmed AND p_start=o_start AND p_end IS NOT DISTINCT FROM o_end AND tz=cur->>'schoolTimezone' THEN
      blocks:=blocks||jsonb_build_object('code','DATES_UNCHANGED');
    ELSIF kind='EXTENSION' AND confirmed AND NOT (p_start=o_start AND o_end IS NOT NULL AND (p_end IS NULL OR p_end>o_end)) THEN
      blocks:=blocks||jsonb_build_object('code','CHANGE_KIND_SHAPE_MISMATCH');
    ELSIF kind='EARLY_END' AND confirmed AND NOT (p_start=o_start AND p_end IS NOT NULL AND (o_end IS NULL OR p_end<o_end)) THEN
      blocks:=blocks||jsonb_build_object('code','CHANGE_KIND_SHAPE_MISMATCH');
    END IF;
    retro:=hon.membership_date_revision_retroactive_days(o_start,o_end,p_start,p_end,today);
    IF (retro->>'added')::integer>0 OR (retro->>'removed')::integer>0 THEN
      warnings:=warnings||jsonb_build_object('code','RETROACTIVE_CHANGE','added',(retro->>'added')::integer,'removed',(retro->>'removed')::integer); END IF;
    shortening:=o_start IS NOT NULL AND (p_start>o_start OR (o_end IS NULL AND p_end IS NOT NULL) OR (p_end IS NOT NULL AND o_end IS NOT NULL AND p_end<o_end));
    IF confirmed AND p_start<>o_start THEN warnings:=warnings||jsonb_build_object('code','START_DATE_CHANGED','fromDate',o_start,'toDate',p_start); END IF;
    IF p_start>today THEN warnings:=warnings||jsonb_build_object('code','START_DATE_IN_FUTURE','days',p_start-today); END IF;
    IF p_end IS NOT NULL AND p_end<today THEN warnings:=warnings||jsonb_build_object('code','END_DATE_PASSED'); END IF;
    IF kind='EXTENSION' AND confirmed AND o_end IS NOT NULL AND o_end<today THEN warnings:=warnings||jsonb_build_object('code','EXTENDS_ENDED_MEMBERSHIP'); END IF;
    IF fixed_term THEN
      plan_end:=hon.membership_next_anchored_term_end(p_start,terms.term_months,p_end-1);
      IF p_end IS DISTINCT FROM plan_end THEN warnings:=warnings||jsonb_build_object('code','FIXED_TERM_DIFFERS_FROM_PLAN','planEndDate',plan_end); END IF;
    END IF;
    IF open_plan AND p_end IS NOT NULL THEN warnings:=warnings||jsonb_build_object('code','OPEN_ENDED_PLAN_HAS_END_DATE'); END IF;
    IF confirmed AND tz<>cur->>'schoolTimezone' THEN warnings:=warnings||jsonb_build_object('code','SCHOOL_TIMEZONE_CHANGED','from',cur->>'schoolTimezone','to',tz); END IF;
    IF NOT confirmed THEN
      IF m.term_started_at IS NULL THEN warnings:=warnings||jsonb_build_object('code','LEGACY_TERM_NOT_STORED');
      ELSE warnings:=warnings||jsonb_build_object('code','LEGACY_TERM_INTERPRETATION'); END IF;
      IF m.term_started_at IS NOT NULL AND (projected_start IS DISTINCT FROM m.term_started_at OR projected_end IS DISTINCT FROM m.term_ends_at) THEN
        warnings:=warnings||jsonb_build_object('code','LEGACY_STORED_TERM_REPLACED','storedStart',hon.membership_instant_text(m.term_started_at),
          'storedEnd',hon.membership_instant_text(m.term_ends_at)); END IF;
    END IF;
    status_now:=hon.membership_reporting_status(m.state,m.term_started_at,m.term_ends_at,confirmed,at);
    status_next:=hon.membership_reporting_status(m.state,projected_start,projected_end,true,at);
    IF status_now IS DISTINCT FROM status_next THEN warnings:=warnings||jsonb_build_object('code','EFFECTIVE_STATUS_CHANGES','from',status_now,'to',status_next); END IF;
  END IF;

  -- Financial records are read, never changed. A contradiction refuses the revision (deferred to the arrangement
  -- workflow); anything else is disclosed for acknowledgement. More than 20 records fails closed.
  SELECT count(*) INTO n_schedules FROM hon.membership_payment_schedules x WHERE x.membership_id=m.id AND x.organization_id=org AND x.school_id=school;
  SELECT count(*) INTO n_invoices FROM hon.invoices x WHERE x.membership_id=m.id AND x.organization_id=org AND x.school_id=school;
  IF n_schedules>20 OR n_invoices>20 THEN blocks:=blocks||jsonb_build_object('code','FINANCIAL_FACTS_TOO_MANY_TO_EVALUATE'); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('scheduleId',x.id,'status',x.status,'frequency',x.frequency,
      'nextChargeDate',CASE WHEN x.next_charge_at IS NULL THEN NULL ELSE hon.membership_local_date(x.next_charge_at,tz) END,'autoRenew',x.auto_renew) ORDER BY x.id),'[]'::jsonb)
    INTO schedules FROM (SELECT * FROM hon.membership_payment_schedules s WHERE s.membership_id=m.id AND s.organization_id=org AND s.school_id=school ORDER BY s.id LIMIT 20) x;
  SELECT coalesce(jsonb_agg(jsonb_build_object('invoiceId',x.id,'status',x.status::text,
      'dueDate',CASE WHEN x.due_at IS NULL THEN NULL ELSE hon.membership_local_date(x.due_at,tz) END) ORDER BY x.id),'[]'::jsonb)
    INTO invoices FROM (SELECT * FROM hon.invoices i WHERE i.membership_id=m.id AND i.organization_id=org AND i.school_id=school ORDER BY i.id LIMIT 20) x;
  IF NOT date_blocked THEN
    FOR f IN SELECT s.status,s.next_charge_at FROM hon.membership_payment_schedules s WHERE s.membership_id=m.id AND s.organization_id=org AND s.school_id=school AND s.status IN ('ACTIVE','PAUSED') LOOP
      IF f.next_charge_at IS NOT NULL AND ((projected_end IS NOT NULL AND f.next_charge_at>=projected_end) OR f.next_charge_at<projected_start) THEN schedule_conflict:=true;
      ELSE schedule_unchanged:=schedule_unchanged+1; END IF;
    END LOOP;
    FOR f IN SELECT i.status::text status,i.due_at FROM hon.invoices i WHERE i.membership_id=m.id AND i.organization_id=org AND i.school_id=school LOOP
      IF f.status IN ('ISSUED','UNCOLLECTIBLE') THEN
        IF shortening AND (f.due_at IS NULL OR (projected_end IS NOT NULL AND f.due_at>=projected_end) OR f.due_at<projected_start) THEN invoice_conflict:=true;
        ELSE open_invoice:=true; END IF;
      ELSIF f.status='PAID' AND shortening THEN paid_invoice:=true;
      ELSIF f.status='DRAFT' THEN draft_invoice:=true; END IF;
    END LOOP;
  END IF;
  IF schedule_conflict THEN blocks:=blocks||jsonb_build_object('code','DATE_CHANGE_CONFLICTS_WITH_PAYMENT_SCHEDULE'); END IF;
  IF invoice_conflict THEN blocks:=blocks||jsonb_build_object('code','DATE_CHANGE_CONFLICTS_WITH_OPEN_INVOICE'); END IF;
  IF schedule_unchanged>0 THEN warnings:=warnings||jsonb_build_object('code','PAYMENT_SCHEDULE_UNCHANGED','count',schedule_unchanged); END IF;
  IF open_invoice THEN warnings:=warnings||jsonb_build_object('code','OPEN_INVOICE_UNCHANGED'); END IF;
  IF paid_invoice THEN warnings:=warnings||jsonb_build_object('code','PAID_INVOICE_NOT_REFUNDED_OR_CREDITED'); END IF;
  IF draft_invoice THEN warnings:=warnings||jsonb_build_object('code','DRAFT_INVOICE_UNCHANGED'); END IF;
  -- An open renewal review keeps its stored facts; it is disclosed, never changed.
  IF EXISTS(SELECT 1 FROM hon.membership_renewal_reviews rv WHERE rv.membership_id=m.id AND rv.organization_id=org AND rv.school_id=school
      AND (SELECT v.status FROM hon.membership_renewal_versions v WHERE v.renewal_id=rv.id AND v.organization_id=rv.organization_id AND v.school_id=rv.school_id
        ORDER BY v.version DESC LIMIT 1) IN ('OPEN','DEFERRED')) THEN
    warnings:=warnings||jsonb_build_object('code','RENEWAL_REVIEW_FACTS_OUTDATED'); END IF;

  required:=CASE WHEN (retro->>'added')::integer>0 OR (retro->>'removed')::integer>0
    THEN '["billing.membership.dates.revise","billing.membership.dates.retroactive"]'::jsonb ELSE '["billing.membership.dates.revise"]'::jsonb END;
  SELECT btrim(concat_ws(' ',p.given_name,p.family_name)) INTO label FROM hon.people p WHERE p.id=m.participant_person_id AND p.organization_id=org AND p.school_id=school;
  SELECT coalesce(jsonb_agg(w ORDER BY w->>'code'),'[]'::jsonb) INTO warnings FROM jsonb_array_elements(warnings) w;
  SELECT coalesce(jsonb_agg(b ORDER BY b->>'code'),'[]'::jsonb) INTO blocks FROM jsonb_array_elements(blocks) b;
  RETURN jsonb_build_object('participantDisplayName',label,'facts',jsonb_build_object(
    'membershipId',m.id,'state',m.state::text,'version',m.version,'participantPersonId',m.participant_person_id,'planCode',m.plan_code,'plan',plan,
    'schoolTimezone',tz,'localToday',today,'changeKind',kind,'currentPeriod',cur,
    'legacyStoredTerm',CASE WHEN confirmed THEN NULL ELSE jsonb_build_object('termStartedAt',hon.membership_instant_text(m.term_started_at),
      'termEndsAt',hon.membership_instant_text(m.term_ends_at)) END,
    'suggestedDates',CASE WHEN s_start IS NULL THEN NULL ELSE jsonb_build_object('startDate',s_start,'endDate',s_end,'startBasis',start_basis,'endBasis',end_basis) END,
    'proposedDates',jsonb_build_object('startDate',p_start,'endDate',p_end,'dateSource',date_source),
    'projection',CASE WHEN projected_start IS NULL THEN NULL ELSE jsonb_build_object('termStartedAt',hon.membership_instant_text(projected_start),
      'termEndsAt',hon.membership_instant_text(projected_end)) END,
    'effectiveStatusNow',hon.membership_reporting_status(m.state,m.term_started_at,m.term_ends_at,confirmed,at),
    'effectiveStatusIfConfirmedNow',CASE WHEN projected_start IS NULL OR m.state<>'ACTIVE' THEN NULL ELSE hon.membership_reporting_status(m.state,projected_start,projected_end,true,at) END,
    'retroactiveDays',retro,
    'financialFacts',jsonb_build_object('schedules',schedules,'schedulesTruncated',n_schedules>20,'invoices',invoices,'invoicesTruncated',n_invoices>20),
    'warnings',warnings,'blocks',blocks,'requiredPermissions',required,
    'requirementsNotEvaluated','["AGREEMENT","PAYMENT","RECURRING_PAYMENT_AUTHORIZATION","FINANCIAL_RESPONSIBILITY","SCHOOL_ACTIVATION_POLICY"]'::jsonb));
END $$;

-- Direct HUMAN_UI read-only date revision preview. No locks and no DML of any kind. The digest only binds a later
-- confirmation to exactly these facts; it is never proof of authorization.
CREATE FUNCTION hon.preview_membership_date_revision(subject text,selected uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; evaluation jsonb; facts jsonb;
  has_proposal boolean; s date; e date; can_retro boolean; result jsonb;
BEGIN
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.revise');
  IF selected IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('changeKind','startDate','endDate'))
    OR jsonb_typeof(p->'changeKind') IS DISTINCT FROM 'string' OR p->>'changeKind' NOT IN ('INITIAL_CONFIRMATION','CORRECTION','EXTENSION','EARLY_END')
    OR (p ? 'startDate')<>(p ? 'endDate') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  has_proposal:=p ? 'startDate';
  IF has_proposal THEN
    s:=hon.membership_activation_date(p->'startDate');
    e:=CASE WHEN jsonb_typeof(p->'endDate')='null' THEN NULL ELSE hon.membership_activation_date(p->'endDate') END;
  END IF;
  evaluation:=hon.evaluate_membership_date_revision(selected,p->>'changeKind',has_proposal,s,e);
  facts:=evaluation->'facts';
  can_retro:=hon.membership_lifecycle_permission(actor,org,school,'billing.membership.dates.retroactive');
  result:=facts || jsonb_build_object(
    'participantDisplayName',evaluation->'participantDisplayName',
    'previewDigest',encode(sha256(convert_to(facts::text,'UTF8')),'hex'),
    'canConfirm',facts->'blocks'='[]'::jsonb AND (jsonb_array_length(facts->'requiredPermissions')=1 OR can_retro),
    'confirmation','I_CONFIRM_MEMBERSHIP_DATE_CHANGE_NO_PAYMENT_INVOICE_REFUND_OR_AGREEMENT_CHANGE');
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.revise') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_DATE_REVISION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- Direct HUMAN_UI confirmation of one previewed date revision. Canonical order (0169/0177): key reservation; IAM SHARE;
-- billing accounts SHARE; memberships ROW EXCLUSIVE + the row FOR NO KEY UPDATE (an invoice insert's FK KEY SHARE
-- never waits on it, so the revision cannot deadlock with invoice creation); plan tables SHARE; schedules and invoices
-- SHARE; renewal reviews SHARE; then work item, revision, membership, follow-up, audit and outbox last.
CREATE FUNCTION hon.revise_membership_dates(subject text,selected uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; revision hon.membership_date_revisions%ROWTYPE; m hon.memberships%ROWTYPE; updated hon.memberships%ROWTYPE;
  evaluation jsonb; facts jsonb; digest text; s date; e date; required_acks jsonb; given_acks jsonb; retro_perm text; tz text; receipt jsonb;
  instant timestamptz; revision_id uuid; follow_ups jsonb:='[]'::jsonb; work hon.work_items%ROWTYPE; kind text; cur jsonb; period_version integer;
  allowed_reasons text[];
BEGIN
  kind:=p->>'changeKind';
  allowed_reasons:=CASE kind
    WHEN 'INITIAL_CONFIRMATION' THEN ARRAY['LEGACY_RECORDS_REVIEWED','PAPER_RECORDS_HELD_BY_SCHOOL','MEMBER_CONFIRMED_DATES','OTHER']
    WHEN 'CORRECTION' THEN ARRAY['DATA_ENTRY_ERROR','ACTUAL_START_DIFFERED','PLAN_TERM_MISAPPLIED','OTHER']
    WHEN 'EXTENSION' THEN ARRAY['MEMBER_REQUESTED','SCHOOL_COURTESY','SCHOOL_CLOSURE_MAKEUP','PERSONAL_CIRCUMSTANCES','OTHER']
    WHEN 'EARLY_END' THEN ARRAY['MEMBER_REQUESTED','MOVED_AWAY','PERSONAL_CIRCUMSTANCES','SCHOOL_DECISION','OTHER'] END;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR selected IS NULL OR key IS NULL OR request IS NULL OR correlation IS NULL
    OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key
    OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR NOT p ?& ARRAY['expectedVersion','expectedPeriodVersion','previewDigest','changeKind','startDate','endDate','dateSource','acknowledgedWarnings','reasonCode','reasonText','confirmation']
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('expectedVersion','expectedPeriodVersion','previewDigest','changeKind','startDate','endDate',
      'dateSource','dateAdjustmentReason','acknowledgedWarnings','reasonCode','reasonText','confirmation'))
    OR allowed_reasons IS NULL OR jsonb_typeof(p->'changeKind') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->'expectedVersion')::text !~ '^[1-9][0-9]{0,8}$'
    OR NOT (jsonb_typeof(p->'expectedPeriodVersion')='null' OR (jsonb_typeof(p->'expectedPeriodVersion')='number' AND (p->'expectedPeriodVersion')::text ~ '^[1-9][0-9]{0,2}$'))
    OR (kind='INITIAL_CONFIRMATION')<>(jsonb_typeof(p->'expectedPeriodVersion')='null')
    OR jsonb_typeof(p->'previewDigest') IS DISTINCT FROM 'string' OR p->>'previewDigest' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(p->'dateSource') IS DISTINCT FROM 'string' OR p->>'dateSource' NOT IN ('SUGGESTED','STAFF_ADJUSTED','STAFF_ENTERED')
    OR (p->>'dateSource'='STAFF_ADJUSTED')<>(p ? 'dateAdjustmentReason')
    OR (p ? 'dateAdjustmentReason' AND (jsonb_typeof(p->'dateAdjustmentReason') IS DISTINCT FROM 'string' OR NOT hon.membership_activation_text_ok(p->>'dateAdjustmentReason',500)))
    OR jsonb_typeof(p->'acknowledgedWarnings') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'acknowledgedWarnings')>30
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'acknowledgedWarnings') w WHERE jsonb_typeof(w) IS DISTINCT FROM 'string' OR w#>>'{}' !~ '^[A-Z][A-Z_]{0,63}$')
    OR (SELECT count(DISTINCT w) FROM jsonb_array_elements(p->'acknowledgedWarnings') w)<>jsonb_array_length(p->'acknowledgedWarnings')
    OR jsonb_typeof(p->'reasonCode') IS DISTINCT FROM 'string' OR NOT (p->>'reasonCode' = ANY(allowed_reasons))
    OR jsonb_typeof(p->'reasonText') IS DISTINCT FROM 'string' OR NOT hon.membership_activation_text_ok(p->>'reasonText',500) OR length(p->>'reasonText')<10
    OR p->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_MEMBERSHIP_DATE_CHANGE_NO_PAYMENT_INVOICE_REFUND_OR_AGREEMENT_CHANGE' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  s:=hon.membership_activation_date(p->'startDate');
  e:=CASE WHEN jsonb_typeof(p->'endDate')='null' THEN NULL ELSE hon.membership_activation_date(p->'endDate') END;
  IF e IS NOT NULL AND e<s THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.revise');
  -- Exact request binding: any byte of difference under the same key is a different command.
  fp:=encode(sha256(convert_to(jsonb_build_object('command','billing.membership.dates.revise','membershipId',selected,'input',p)::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.revise') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_DATE_REVISION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO revision FROM hon.membership_date_revisions r WHERE r.organization_id=org AND r.school_id=school AND r.actor_principal_id=actor AND r.idempotency_key=key;
  IF NOT reserved OR revision.id IS NOT NULL THEN
    -- A reused key is refused before any membership fact is evaluated or disclosed. An exact replay returns the
    -- stored receipt only after live authority (including the retroactive permission it used) is re-proven. The
    -- revision row is the lifetime record of the key.
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key FOR UPDATE;
    IF NOT FOUND OR prior.request_fingerprint<>fp OR (revision.id IS NOT NULL AND revision.request_fingerprint<>fp) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    IF revision.id IS NULL OR revision.membership_id<>selected
      OR (NOT reserved AND (prior.status<>'COMPLETED' OR prior.response_body IS DISTINCT FROM revision.receipt)) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='40001'; END IF;
    IF revision.retroactive_permission IS NOT NULL
      AND hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.retroactive') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    IF reserved THEN
      UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=revision.receipt
        WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
    END IF;
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.revise') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_DATE_REVISION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',revision.receipt,'replayed',true);
  END IF;
  LOCK TABLE hon.billing_accounts IN SHARE MODE;
  LOCK TABLE hon.memberships IN ROW EXCLUSIVE MODE;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  LOCK TABLE hon.membership_plans,hon.membership_plan_versions,hon.membership_plan_selections IN SHARE MODE;
  LOCK TABLE hon.membership_payment_schedules,hon.invoices IN SHARE MODE;
  LOCK TABLE hon.membership_renewal_reviews,hon.membership_renewal_versions IN SHARE MODE;
  IF m.state<>'ACTIVE' THEN RAISE EXCEPTION 'MEMBERSHIP_NOT_ACTIVE' USING ERRCODE='40001'; END IF;
  IF m.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  cur:=hon.membership_current_period(m.id);
  IF (cur->>'periodVersion')::integer IS DISTINCT FROM (CASE WHEN jsonb_typeof(p->'expectedPeriodVersion')='null' THEN NULL ELSE (p->>'expectedPeriodVersion')::integer END) THEN
    RAISE EXCEPTION 'PERIOD_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  -- Everything the preview showed is re-derived under lock; any difference is a stale preview.
  evaluation:=hon.evaluate_membership_date_revision(selected,kind,true,s,e);
  facts:=evaluation->'facts';
  digest:=encode(sha256(convert_to(facts::text,'UTF8')),'hex');
  IF digest<>p->>'previewDigest' THEN RAISE EXCEPTION 'DATE_REVISION_PREVIEW_STALE' USING ERRCODE='40001'; END IF;
  IF facts->'blocks'<>'[]'::jsonb THEN RAISE EXCEPTION 'DATE_REVISION_BLOCKED' USING ERRCODE='22023'; END IF;
  IF facts->'proposedDates'->>'dateSource' IS DISTINCT FROM p->>'dateSource' THEN RAISE EXCEPTION 'DATE_SOURCE_MISMATCH' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(w->'code' ORDER BY w->>'code'),'[]'::jsonb) INTO required_acks FROM jsonb_array_elements(facts->'warnings') w;
  SELECT coalesce(jsonb_agg(w ORDER BY w#>>'{}'),'[]'::jsonb) INTO given_acks FROM jsonb_array_elements(p->'acknowledgedWarnings') w;
  IF required_acks<>given_acks THEN RAISE EXCEPTION 'DATE_REVISION_ACKNOWLEDGEMENT_REQUIRED' USING ERRCODE='22023'; END IF;
  -- E1b-D2: a change to any past school-local day needs the retroactive permission as well, live.
  IF jsonb_array_length(facts->'requiredPermissions')>1 THEN
    IF hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.retroactive') IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN' USING ERRCODE='42501'; END IF;
    retro_perm:='billing.membership.dates.retroactive';
  END IF;

  tz:=facts->>'schoolTimezone';
  instant:=clock_timestamp();
  revision_id:=gen_random_uuid();
  period_version:=coalesce((cur->>'periodVersion')::integer,0)+1;
  -- E1b-D3: acknowledged financial disclosures create one billing-review reminder. No money, schedule or invoice changes.
  IF required_acks ?| ARRAY['PAID_INVOICE_NOT_REFUNDED_OR_CREDITED','OPEN_INVOICE_UNCHANGED','PAYMENT_SCHEDULE_UNCHANGED'] THEN
    INSERT INTO hon.work_items(organization_id,school_id,work_origin,work_type,status,title,description,priority,created_by_principal_id,correlation_id)
      VALUES(org,school,'HUMAN_UI','HUMAN_TASK','READY','Review billing after a membership date change',
        'Membership '||m.id||' had its dates changed (revision '||revision_id||') while a payment schedule or invoice exists. The date change did not create, change, refund, credit or cancel any payment, schedule or invoice. Review billing separately.',
        'NORMAL',actor,correlation)
      RETURNING * INTO work;
    INSERT INTO hon.human_work_history(work_item_id,organization_id,school_id,version,operation,status,title,description,priority,due_at,assignee_id,actor_id,request_id)
      VALUES(work.id,org,school,work.version,'CREATE',work.status,work.title,work.description,work.priority,NULL,NULL,actor,request);
    follow_ups:=jsonb_build_array(jsonb_build_object('kind','BILLING_REVIEW','workItemId',work.id));
  END IF;
  receipt:=jsonb_build_object('membershipId',m.id,'state','ACTIVE','version',m.version+1,'previousVersion',m.version,
    'revisionId',revision_id,'changeKind',kind,'decisionBasis','STAFF_REVISION_PRE_POLICY',
    'authorizingPermission','billing.membership.dates.revise','retroactivePermission',retro_perm,
    'previousPeriod',CASE WHEN cur IS NULL THEN jsonb_build_object('periodVersion',NULL,'startDate',NULL,'endDate',NULL,
        'legacyTermStartedAt',hon.membership_instant_text(m.term_started_at),'legacyTermEndsAt',hon.membership_instant_text(m.term_ends_at))
      ELSE jsonb_build_object('periodVersion',(cur->>'periodVersion')::integer,'startDate',cur->'startDate','endDate',cur->'endDate',
        'legacyTermStartedAt',NULL,'legacyTermEndsAt',NULL) END,
    'effectivePeriod',jsonb_build_object('periodVersion',period_version,'startDate',s,'endDate',e,'endDateInclusive',true,'schoolTimezone',tz,
      'dateSource',p->>'dateSource','termStartedAt',facts->'projection'->'termStartedAt','termEndsAt',facts->'projection'->'termEndsAt'),
    'effectiveStatusAtRevision',hon.membership_reporting_status('ACTIVE',(facts->'projection'->>'termStartedAt')::timestamptz,
      (facts->'projection'->>'termEndsAt')::timestamptz,true,instant),
    'retroactiveDays',facts->'retroactiveDays','acknowledgedWarnings',given_acks,'reasonCode',p->>'reasonCode',
    'financialEffects','[]'::jsonb,'followUps',follow_ups,'requirementsNotEvaluated',facts->'requirementsNotEvaluated','approval',NULL,
    'recordedAt',hon.membership_instant_text(instant));
  INSERT INTO hon.membership_date_revisions(id,organization_id,school_id,membership_id,change_kind,period_version,prior_period_version,prior_start_date,prior_end_date,
      prior_term_started_at,prior_term_ends_at,start_date,end_date,school_timezone,term_started_at,term_ends_at,date_source,suggested_start_date,suggested_end_date,
      suggestion_basis,adjustment_reason,prior_membership_version,next_membership_version,decision_basis,actor_principal_id,authorizing_permission,retroactive_permission,
      reason_code,reason_text,acknowledged_warnings,retroactive_days,financial_facts,requirements_not_evaluated,preview_digest,evaluated_facts,idempotency_key,
      request_fingerprint,request_id,correlation_id,receipt,created_at)
    VALUES(revision_id,org,school,m.id,kind,period_version,(cur->>'periodVersion')::integer,(cur->>'startDate')::date,(cur->>'endDate')::date,
      m.term_started_at,m.term_ends_at,s,e,tz,(facts->'projection'->>'termStartedAt')::timestamptz,(facts->'projection'->>'termEndsAt')::timestamptz,
      p->>'dateSource',(facts->'suggestedDates'->>'startDate')::date,(facts->'suggestedDates'->>'endDate')::date,
      CASE WHEN facts->'suggestedDates' IS NULL OR jsonb_typeof(facts->'suggestedDates')='null' THEN NULL
        ELSE jsonb_build_object('startBasis',facts->'suggestedDates'->'startBasis','endBasis',facts->'suggestedDates'->'endBasis') END,
      p->>'dateAdjustmentReason',m.version,m.version+1,'STAFF_REVISION_PRE_POLICY',actor,'billing.membership.dates.revise',retro_perm,
      p->>'reasonCode',p->>'reasonText',given_acks,facts->'retroactiveDays',facts->'financialFacts',facts->'requirementsNotEvaluated',digest,facts,key,fp,
      request,correlation,receipt,instant);
  UPDATE hon.memberships SET version=version+1,term_started_at=(facts->'projection'->>'termStartedAt')::timestamptz,
      term_ends_at=(facts->'projection'->>'termEndsAt')::timestamptz
    WHERE id=m.id AND organization_id=org AND school_id=school AND state='ACTIVE' AND version=m.version RETURNING * INTO updated;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.membership_date_revision_follow_ups(revision_id,kind,organization_id,school_id,membership_id,work_item_id,created_at)
    SELECT revision_id,f->>'kind',org,school,m.id,(f->>'workItemId')::uuid,instant FROM jsonb_array_elements(follow_ups) f;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership.dates.revise','MEMBERSHIP',m.id,
      jsonb_build_object('state','ACTIVE','version',m.version,'period',cur,'termStartedAt',hon.membership_instant_text(m.term_started_at),
        'termEndsAt',hon.membership_instant_text(m.term_ends_at)),
      receipt,'SUCCEEDED',request,correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.dates_revised',1,'MEMBERSHIP',m.id,updated.version,correlation,request,
      receipt || jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=receipt
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  -- Final live authority after every write (revocation during the command fails closed).
  IF retro_perm IS NOT NULL AND hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.retroactive') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.revise') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_DATE_REVISION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',receipt,'replayed',false);
END $$;

-- Read-only date history of one current-school membership for staff holding billing.membership.read,
-- billing.membership.activate or billing.membership.dates.revise at this school. Newest first.
CREATE FUNCTION hon.read_membership_date_history(subject text,selected uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text; used text;
  m hon.memberships%ROWTYPE; tz text; cur jsonb; versions jsonb; at timestamptz:=clock_timestamp();
BEGIN
  FOREACH permission IN ARRAY ARRAY['billing.membership.read','billing.membership.activate','billing.membership.dates.revise'] LOOP
    BEGIN actor:=hon.require_membership_lifecycle_actor(subject,permission); used:=permission; EXIT;
    EXCEPTION WHEN SQLSTATE '42501' THEN actor:=NULL; END;
  END LOOP;
  IF actor IS NULL THEN RAISE EXCEPTION 'MEMBERSHIP_DATE_HISTORY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF selected IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO m FROM hon.memberships x WHERE x.id=selected AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILLING_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  cur:=hon.membership_current_period(m.id);
  SELECT coalesce(jsonb_agg(v.item ORDER BY v.pv DESC),'[]'::jsonb) INTO versions FROM (
    SELECT r.period_version pv,jsonb_build_object('periodVersion',r.period_version,'changeKind',r.change_kind,'startDate',r.start_date,'endDate',r.end_date,
      'schoolTimezone',r.school_timezone,'dateSource',r.date_source,'reasonCode',r.reason_code,'reasonText',r.reason_text,
      'actorDisplayName',(SELECT pr.display_name FROM hon.principals pr WHERE pr.id=r.actor_principal_id),'recordedAt',hon.membership_instant_text(r.created_at),
      'retroactiveDays',r.retroactive_days,'acknowledgedWarnings',r.acknowledged_warnings) item
    FROM hon.membership_date_revisions r WHERE r.membership_id=m.id AND r.organization_id=org AND r.school_id=school
    UNION ALL
    SELECT p.period_version,jsonb_build_object('periodVersion',p.period_version,'changeKind',p.change_kind,'startDate',p.start_date,'endDate',p.end_date,
      'schoolTimezone',p.school_timezone,'dateSource',p.date_source,'reasonCode',d.reason_code,'reasonText',d.reason_text,
      'actorDisplayName',(SELECT pr.display_name FROM hon.principals pr WHERE pr.id=p.actor_principal_id),'recordedAt',hon.membership_instant_text(p.created_at),
      'retroactiveDays',NULL,'acknowledgedWarnings',d.acknowledged_warnings)
    FROM hon.membership_effective_periods p JOIN hon.membership_activation_decisions d ON d.id=p.decision_id
    WHERE p.membership_id=m.id AND p.organization_id=org AND p.school_id=school) v;
  IF hon.require_membership_lifecycle_actor(subject,used) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_DATE_HISTORY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('membershipId',m.id,'state',m.state::text,'version',m.version,'schoolTimezone',tz,'localToday',hon.membership_local_date(at,tz),
    'effectiveStatus',hon.membership_reporting_status(m.state,m.term_started_at,m.term_ends_at,cur IS NOT NULL,at),'datesConfirmed',cur IS NOT NULL,
    'currentPeriod',cur,
    'legacyStoredTerm',CASE WHEN cur IS NOT NULL THEN NULL ELSE jsonb_build_object('termStartedAt',hon.membership_instant_text(m.term_started_at),
      'termEndsAt',hon.membership_instant_text(m.term_ends_at)) END,
    'versions',versions);
END $$;

-- E1b-D7: ACTIVE memberships at this school with no confirmed period of any kind (pre-0177 rows), oldest first,
-- keyset-paginated. Staff confirm each one individually; nothing is fabricated or bulk-confirmed.
CREATE FUNCTION hon.read_membership_date_confirmation_queue(subject text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; lim integer:=50; after_id uuid;
  after_created timestamptz; items jsonb; more boolean;
BEGIN
  actor:=hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.revise');
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('after','limit'))
    OR (p ? 'limit' AND (jsonb_typeof(p->'limit') IS DISTINCT FROM 'number' OR (p->'limit')::text !~ '^[1-9][0-9]?$' OR (p->>'limit')::integer>50))
    OR (p ? 'after' AND (jsonb_typeof(p->'after') IS DISTINCT FROM 'string' OR p->>'after' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p ? 'limit' THEN lim:=(p->>'limit')::integer; END IF;
  IF p ? 'after' THEN
    after_id:=(p->>'after')::uuid;
    SELECT x.created_at INTO after_created FROM hon.memberships x WHERE x.id=after_id AND x.organization_id=org AND x.school_id=school;
    IF NOT FOUND THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END IF;
  WITH queue AS (
    SELECT m.id,m.plan_code,m.term_started_at,m.term_ends_at,m.created_at,m.participant_person_id FROM hon.memberships m
    WHERE m.organization_id=org AND m.school_id=school AND m.state='ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM hon.membership_effective_periods x WHERE x.membership_id=m.id)
      AND NOT EXISTS(SELECT 1 FROM hon.membership_date_revisions x WHERE x.membership_id=m.id)
      AND (after_id IS NULL OR (m.created_at,m.id)>(after_created,after_id))
    ORDER BY m.created_at,m.id LIMIT lim+1)
  SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',q.id,
      'participantDisplayName',(SELECT btrim(concat_ws(' ',pp.given_name,pp.family_name)) FROM hon.people pp WHERE pp.id=q.participant_person_id AND pp.organization_id=org AND pp.school_id=school),
      'planCode',q.plan_code,'legacyStoredTerm',jsonb_build_object('termStartedAt',hon.membership_instant_text(q.term_started_at),'termEndsAt',hon.membership_instant_text(q.term_ends_at)),
      'createdAt',hon.membership_instant_text(q.created_at)) ORDER BY q.created_at,q.id) FILTER (WHERE q.rn<=lim),'[]'::jsonb),count(*)>lim
    INTO items,more FROM (SELECT queue.*,row_number() OVER (ORDER BY created_at,id) rn FROM queue) q;
  IF hon.require_membership_lifecycle_actor(subject,'billing.membership.dates.revise') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_DATE_REVISION_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('items',items,'next',CASE WHEN more THEN items->(jsonb_array_length(items)-1)->'membershipId' ELSE NULL END);
END $$;

-- Read-only school membership status summary (reporting.view). Lifecycle totals are unchanged; lifecycle ACTIVE is
-- split by reporting status so no membership disappears: sum(activeByEffectiveStatus)=lifecycle.ACTIVE and
-- sum(undatedHints)=UNDATED. Legacy instants are hints only. No money, names or reasons.
CREATE FUNCTION hon.read_school_membership_status_summary(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; tz text; at timestamptz:=clock_timestamp();
  today date; horizon timestamptz; result jsonb;
BEGIN
  actor:=hon.require_membership_lifecycle_actor(subject,'reporting.view');
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN
    RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  today:=hon.membership_local_date(at,tz);
  horizon:=hon.membership_local_day_start(today+31,tz);
  WITH m AS MATERIALIZED (
    SELECT x.state,x.term_started_at s,x.term_ends_at e,
      (EXISTS(SELECT 1 FROM hon.membership_effective_periods p WHERE p.membership_id=x.id)
        OR EXISTS(SELECT 1 FROM hon.membership_date_revisions r WHERE r.membership_id=x.id)) confirmed
    FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school
  ), c AS MATERIALIZED (
    SELECT m.*,hon.membership_reporting_status(m.state,m.s,m.e,m.confirmed,at) rs FROM m
  )
  SELECT jsonb_build_object('organizationId',org,'schoolId',school,'generatedAt',hon.membership_instant_text(at),'schoolTimezone',tz,'localToday',today,
    'windowEndDate',today+30,
    'lifecycle',jsonb_build_object('DRAFT',count(*) FILTER (WHERE state='DRAFT'),'ACTIVE',count(*) FILTER (WHERE state='ACTIVE'),
      'FROZEN',count(*) FILTER (WHERE state='FROZEN'),'CANCELLATION_PENDING',count(*) FILTER (WHERE state='CANCELLATION_PENDING'),
      'CANCELLED',count(*) FILTER (WHERE state='CANCELLED'),'EXPIRED',count(*) FILTER (WHERE state='EXPIRED')),
    'activeByEffectiveStatus',jsonb_build_object('SCHEDULED',count(*) FILTER (WHERE state='ACTIVE' AND rs='SCHEDULED'),
      'IN_EFFECT',count(*) FILTER (WHERE state='ACTIVE' AND rs='IN_EFFECT'),'ENDED',count(*) FILTER (WHERE state='ACTIVE' AND rs='ENDED'),
      'UNDATED',count(*) FILTER (WHERE state='ACTIVE' AND rs='UNDATED')),
    'undatedHints',jsonb_build_object(
      'storedTermInEffect',count(*) FILTER (WHERE rs='UNDATED' AND s IS NOT NULL AND s<=at AND (e IS NULL OR e>at)),
      'storedTermEnded',count(*) FILTER (WHERE rs='UNDATED' AND s IS NOT NULL AND s<=at AND e IS NOT NULL AND e<=at),
      'storedTermFuture',count(*) FILTER (WHERE rs='UNDATED' AND s IS NOT NULL AND s>at),
      'noStoredStart',count(*) FILTER (WHERE rs='UNDATED' AND s IS NULL)),
    'confirmedStartingNext30Days',count(*) FILTER (WHERE rs='SCHEDULED' AND s<horizon),
    'confirmedEndingNext30Days',count(*) FILTER (WHERE rs IN ('SCHEDULED','IN_EFFECT') AND e IS NOT NULL AND e<=horizon))
  INTO result FROM c;
  IF hon.require_membership_lifecycle_actor(subject,'reporting.view') IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'MEMBERSHIP_STATUS_SUMMARY_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

COMMENT ON TABLE hon.membership_date_revisions IS
'E1b immutable membership date revisions: one row per revision (INITIAL_CONFIRMATION, CORRECTION, EXTENSION, EARLY_END) holding the decision (actor, live permissions, reason, acknowledged warnings, retroactive days, evaluated financial facts, preview digest) and the resulting school-local effective period with its exact projection. Financial effects are always none. Private: forced RLS, no runtime grant.';
COMMENT ON TABLE hon.membership_date_revision_follow_ups IS
'E1b links from a date revision to the billing-review reminder it created when financial records were disclosed. Reminders only. Private.';
COMMENT ON FUNCTION hon.preview_membership_date_revision(text,uuid,jsonb) IS
'Direct HUMAN_UI read-only membership date revision preview for one current-school membership: current period or legacy stored instants, suggested and proposed dates, projection, effective status now and if confirmed, retroactive past-day counts, financial facts, warnings, blocks, required permissions and a digest. No DML, locks, audit, outbox or idempotency.';
COMMENT ON FUNCTION hon.revise_membership_dates(text,uuid,jsonb,text,uuid,uuid) IS
'Direct HUMAN_UI two-step confirmation of one previewed membership date revision: live school-scoped billing.membership.dates.revise (and dates.retroactive when a past day changes), exact-request idempotency, re-derived facts under canonical locks, one immutable revision row and the evidence-bound projection update, optional billing-review reminder, audit and inert outbox. No payment, schedule, invoice, refund, credit, price, agreement, consent, payer, SaaS billing, entitlement, communication, AI or automation effect.';
COMMENT ON FUNCTION hon.read_membership_date_history(text,uuid) IS
'Direct HUMAN_UI read of one current-school membership''s confirmed date history (activation period and revisions), current period, reporting status and legacy stored instants.';
COMMENT ON FUNCTION hon.read_membership_date_confirmation_queue(text,jsonb) IS
'Direct HUMAN_UI keyset read of ACTIVE memberships at this school with no confirmed period (pre-0177), for individual staff date confirmation.';
COMMENT ON FUNCTION hon.read_school_membership_status_summary(text) IS
'Direct HUMAN_UI reporting.view read of one school''s membership lifecycle totals, lifecycle-ACTIVE split by SCHEDULED, IN_EFFECT, ENDED and UNDATED, legacy hints and confirmed starts/ends in the next 30 school-local days. No money, names or reasons.';

-- Privileges: the new evidence is private, helpers are private, five entry points are runtime-executable. The
-- runtime keeps exactly the 0177 D41 option C privileges on hon.memberships.
REVOKE ALL ON TABLE hon.membership_date_revisions,hon.membership_date_revision_follow_ups FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_membership_date_revision_insert(),hon.membership_instant_text(timestamptz),hon.membership_next_anchored_term_end(date,integer,date),
  hon.membership_date_revision_retroactive_days(date,date,date,date,date),hon.membership_current_period(uuid),
  hon.membership_reporting_status(hon.membership_state,timestamptz,timestamptz,boolean,timestamptz),
  hon.evaluate_membership_date_revision(uuid,text,boolean,date,date),hon.preview_membership_date_revision(text,uuid,jsonb),
  hon.revise_membership_dates(text,uuid,jsonb,text,uuid,uuid),hon.read_membership_date_history(text,uuid),
  hon.read_membership_date_confirmation_queue(text,jsonb),hon.read_school_membership_status_summary(text),
  hon.guard_membership_state_transition(),hon.membership_lifecycle_permission(uuid,uuid,uuid,text),hon.require_membership_lifecycle_actor(text,text) FROM PUBLIC;
DO $$ DECLARE r text; col text; t text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.membership_date_revisions,hon.membership_date_revision_follow_ups FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_membership_date_revision_insert(),hon.membership_instant_text(timestamptz),hon.membership_next_anchored_term_end(date,integer,date),
      hon.membership_date_revision_retroactive_days(date,date,date,date,date),hon.membership_current_period(uuid),
      hon.membership_reporting_status(hon.membership_state,timestamptz,timestamptz,boolean,timestamptz),
      hon.evaluate_membership_date_revision(uuid,text,boolean,date,date),hon.preview_membership_date_revision(text,uuid,jsonb),
      hon.revise_membership_dates(text,uuid,jsonb,text,uuid,uuid),hon.read_membership_date_history(text,uuid),
      hon.read_membership_date_confirmation_queue(text,jsonb),hon.read_school_membership_status_summary(text),
      hon.guard_membership_state_transition(),hon.membership_lifecycle_permission(uuid,uuid,uuid,text),hon.require_membership_lifecycle_actor(text,text) FROM %I',r);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['membership_date_revisions','membership_date_revision_follow_ups'] LOOP
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=('hon.'||t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.preview_membership_date_revision(text,uuid,jsonb),hon.revise_membership_dates(text,uuid,jsonb,text,uuid,uuid),
      hon.read_membership_date_history(text,uuid),hon.read_membership_date_confirmation_queue(text,jsonb),hon.read_school_membership_status_summary(text) TO hon_runtime;
  END IF;
END $$;
DO $$ BEGIN
  -- Environments without the runtime role (fixtures provision theirs after migrating) have nothing to widen.
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    IF has_any_column_privilege('hon_runtime','hon.memberships','UPDATE') OR has_table_privilege('hon_runtime','hon.memberships','DELETE')
      OR has_table_privilege('hon_runtime','hon.memberships','INSERT') OR has_table_privilege('hon_runtime','hon.membership_date_revisions','SELECT') THEN
      RAISE EXCEPTION 'Membership date revisions must not widen runtime privileges';
    END IF;
  END IF;
END $$;
COMMIT;
