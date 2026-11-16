BEGIN;

-- M-B (0398, allocated by the coordinator 2026-11-16): start a new membership, or renew one, from the contact card.
-- Owner (David), 2026-11-16 05:45Z: "Membership is tied to student ... we make new/renew/upgrade membership under each
-- student or member card". Owner decision 05:50Z: one membership per program. A student may hold memberships in different
-- programs, never two overlapping in the same program; plans without a program share one group.
--   start_person_membership (billing.membership.create): one DRAFT for an existing student of the session school, bound to
--     the exact current published plan version (0175 selection), with a staff-chosen start date in the school timezone and
--     the plan's term. Payer: the chosen guardian of the student's primary family or the student (never a known minor), or,
--     when none is chosen, the 0334 rule (the only guardian, the only billing-contact guardian, or the adult student).
--     The payer's CANONICAL account is used, or created in the plan currency. Refused while the student has another DRAFT in
--     the same program group, or a current membership (ACTIVE, FROZEN, CANCELLATION_PENDING) in that group overlapping the
--     new term. RENEW names the membership it follows: same student, same group, with an end date, and starting on or after it.
--   read_person_membership_start: who may pay, the student's memberships with their program group, and what blocks a start.
-- The DRAFT is then started with the unchanged 0177 preview and confirm (source GENERIC_LEGACY, as in 0334; the plan
-- selection means no free-text warning). A trigger refuses any later change (activation, date change, resume) that would make
-- a card-started membership overlap another current one in its group.
-- Nothing is charged, scheduled, invoiced or sent. Audit and outbox carry ids and codes only. The runtime gains no table
-- privilege: the two entry points are SECURITY DEFINER.

CREATE TABLE hon.person_membership_starts (
  membership_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  person_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('NEW','RENEW')),
  renews_membership_id uuid,
  program_id uuid,
  payer_person_id uuid NOT NULL,
  billing_account_id uuid NOT NULL REFERENCES hon.billing_accounts(id) ON DELETE RESTRICT,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (renews_membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (payer_person_id,organization_id,school_id) REFERENCES hon.people(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (program_id,organization_id,school_id) REFERENCES hon.programs(id,organization_id,school_id) ON DELETE RESTRICT,
  CHECK ((kind='RENEW')=(renews_membership_id IS NOT NULL) AND renews_membership_id IS DISTINCT FROM membership_id),
  UNIQUE (organization_id,school_id,actor_principal_id,idempotency_key)
);
CREATE INDEX person_membership_starts_person ON hon.person_membership_starts(organization_id,school_id,person_id);
CREATE INDEX person_membership_starts_renews ON hon.person_membership_starts(renews_membership_id) WHERE renews_membership_id IS NOT NULL;
ALTER TABLE hon.person_membership_starts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.person_membership_starts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION hon.guard_person_membership_start() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_PERSON_MEMBERSHIP_START' USING ERRCODE='42501'; END $$;
CREATE TRIGGER person_membership_starts_immutable BEFORE UPDATE OR DELETE ON hon.person_membership_starts
  FOR EACH ROW EXECUTE FUNCTION hon.guard_person_membership_start();
CREATE TRIGGER person_membership_starts_no_truncate BEFORE TRUNCATE ON hon.person_membership_starts
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_person_membership_start();

-- The program group of one membership: the program of its bound plan version, or NULL (no program, or no plan binding).
CREATE FUNCTION hon.membership_program_group(p_membership uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT v.program_id FROM hon.membership_plan_selections s
    JOIN hon.membership_plan_versions v ON v.plan_id=s.plan_id AND v.version=s.plan_version AND v.organization_id=s.organization_id AND v.school_id=s.school_id
  WHERE s.membership_id=p_membership
$$;

-- One per program: a card-started membership that is current never overlaps another current membership of the same student in
-- the same program group, and no current membership is moved onto a card-started one. Only rows that involve a card start are
-- checked, so memberships made before 0398 keep their existing behavior.
CREATE FUNCTION hon.guard_person_membership_overlap() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE grp uuid; card boolean;
BEGIN
  IF NEW.state NOT IN ('ACTIVE','FROZEN','CANCELLATION_PENDING') THEN RETURN NULL; END IF;
  -- One lock per student: two changes to this student's memberships (an activation and a date change, say) never check at once,
  -- and the check below runs after the earlier change committed (each statement reads afresh under READ COMMITTED).
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.membership_one_per_program:'||NEW.organization_id||':'||NEW.school_id||':'||NEW.participant_person_id,0));
  grp:=hon.membership_program_group(NEW.id);
  card:=EXISTS(SELECT 1 FROM hon.person_membership_starts s WHERE s.membership_id=NEW.id);
  IF EXISTS(SELECT 1 FROM hon.memberships o
    WHERE o.organization_id=NEW.organization_id AND o.school_id=NEW.school_id AND o.participant_person_id=NEW.participant_person_id
      AND o.id<>NEW.id AND o.state IN ('ACTIVE','FROZEN','CANCELLATION_PENDING')
      AND hon.membership_program_group(o.id) IS NOT DISTINCT FROM grp
      AND tstzrange(coalesce(o.term_started_at,'-infinity'),coalesce(o.term_ends_at,'infinity'),'[)')
        && tstzrange(coalesce(NEW.term_started_at,'-infinity'),coalesce(NEW.term_ends_at,'infinity'),'[)')
      AND (card OR EXISTS(SELECT 1 FROM hon.person_membership_starts s WHERE s.membership_id=o.id))) THEN
    RAISE EXCEPTION 'MEMBERSHIP_PROGRAM_OVERLAP' USING ERRCODE='23P01';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER memberships_one_per_program AFTER INSERT OR UPDATE OF state,term_started_at,term_ends_at ON hon.memberships
  FOR EACH ROW EXECUTE FUNCTION hon.guard_person_membership_overlap();

-- Live direct-human staff authority with billing.membership.create at the session school (the 0387 rules).
CREATE FUNCTION hon.require_person_membership_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'PERSON_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
        AND x.code='billing.membership.create' AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'PERSON_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- What the card needs to start a membership for one person (private; callers proved authority): the student record, who may
-- pay, the person's memberships with their program group, and the blockers that apply to every plan.
CREATE FUNCTION hon.person_membership_start_facts(pid uuid,today date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); me hon.people%ROWTYPE; sp hon.student_profiles%ROWTYPE;
  profiles integer; minor boolean:=false; payers jsonb:='[]'::jsonb; auto jsonb; blockers text[]:='{}';
BEGIN
  SELECT * INTO me FROM hon.people x WHERE x.id=pid AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERSON_MEMBERSHIP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT count(*) INTO profiles FROM hon.student_profiles x WHERE x.person_id=pid AND x.organization_id=org AND x.school_id=school;
  IF profiles=1 THEN
    SELECT * INTO sp FROM hon.student_profiles x WHERE x.person_id=pid AND x.organization_id=org AND x.school_id=school;
    minor:=sp.birth_date IS NOT NULL AND sp.birth_date>today-interval '18 years';
  ELSE blockers:=blockers||'NO_STUDENT_RECORD'::text; END IF;
  IF EXISTS(SELECT 1 FROM hon.school_contact_archives a WHERE a.person_id=pid AND a.organization_id=org AND a.school_id=school AND a.restored_at IS NULL) THEN
    blockers:=blockers||'CONTACT_ARCHIVED'::text; END IF;
  IF sp.id IS NOT NULL THEN
    IF NOT minor THEN
      payers:=payers||jsonb_build_object('personId',me.id,'givenName',left(me.given_name,200),'familyName',left(me.family_name,200),'relation','SELF','billingContact',false);
    END IF;
    payers:=payers||coalesce((SELECT jsonb_agg(jsonb_build_object('personId',p.id,'givenName',left(p.given_name,200),'familyName',left(p.family_name,200),
        'relation','GUARDIAN','billingContact',fm.is_billing_contact) ORDER BY p.family_name,p.given_name,p.id)
      FROM hon.family_members fm JOIN hon.people p ON p.id=fm.person_id AND p.organization_id=fm.organization_id AND p.school_id=fm.school_id
      WHERE sp.primary_family_id IS NOT NULL AND fm.family_id=sp.primary_family_id AND fm.organization_id=org AND fm.school_id=school
        AND fm.member_role='GUARDIAN' AND fm.person_id<>pid),'[]'::jsonb);
    auto:=hon.billing_import_payer(sp.id,'{}'::jsonb,today);
  END IF;
  RETURN jsonb_build_object('person',me,'profile',sp,'minor',minor,'blockers',to_jsonb(blockers),'payers',payers,
    'defaultPayerPersonId',auto->'payer','payerProblem',CASE WHEN auto ? 'error' THEN to_jsonb(replace(auto->>'error','payer:','')) ELSE 'null'::jsonb END);
END $$;

-- One membership as the card shows it: program group, dates in the school timezone (end inclusive), and whether it can be renewed.
CREATE FUNCTION hon.person_membership_start_item(m hon.memberships,tz text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('membershipId',m.id,'state',m.state::text,'planCode',m.plan_code,'programId',hon.membership_program_group(m.id),
    'startDate',CASE WHEN m.term_started_at IS NULL THEN NULL ELSE to_char(hon.membership_local_date(m.term_started_at,tz),'YYYY-MM-DD') END,
    'endDate',CASE WHEN m.term_ends_at IS NULL THEN NULL ELSE to_char(hon.membership_local_date(m.term_ends_at-interval '1 microsecond',tz),'YYYY-MM-DD') END,
    'renewable',m.state IN ('ACTIVE','FROZEN','CANCELLATION_PENDING','EXPIRED') AND m.term_ends_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM hon.person_membership_starts s JOIN hon.memberships r ON r.id=s.membership_id
        WHERE s.renews_membership_id=m.id AND r.state IN ('DRAFT','ACTIVE','FROZEN','CANCELLATION_PENDING')),
    'renewStartDate',CASE WHEN m.term_ends_at IS NULL THEN NULL ELSE to_char(hon.membership_local_date(m.term_ends_at,tz),'YYYY-MM-DD') END)
$$;

-- Input: exactly {personId}. Output: personId, schoolToday, schoolTimezone, minor, blockers, payers, defaultPayerPersonId,
-- payerProblem and memberships. Plans come from the 0175 plan-options read.
CREATE FUNCTION hon.read_person_membership_start(p_subject text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); pid uuid; tz text; today date; facts jsonb; result jsonb;
BEGIN
  PERFORM hon.require_person_membership_actor(p_subject);
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['personId']
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR (p_input->>'personId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  pid:=(p_input->>'personId')::uuid;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  today:=hon.membership_local_date(clock_timestamp(),tz);
  facts:=hon.person_membership_start_facts(pid,today);
  result:=jsonb_build_object('personId',pid,'schoolToday',to_char(today,'YYYY-MM-DD'),'schoolTimezone',tz,'minor',facts->'minor',
    'blockers',facts->'blockers','payers',facts->'payers','defaultPayerPersonId',facts->'defaultPayerPersonId','payerProblem',facts->'payerProblem',
    'memberships',coalesce((SELECT jsonb_agg(hon.person_membership_start_item(m,tz) ORDER BY m.term_started_at DESC NULLS FIRST,m.created_at DESC,m.id)
      FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school AND m.participant_person_id=pid),'[]'::jsonb));
  PERFORM hon.require_person_membership_actor(p_subject);
  RETURN result;
END $$;

-- Input: exactly {personId, membershipPlanId, membershipPlanVersion, kind, renewsMembershipId, startDate, payerPersonId,
-- confirmation}; renewsMembershipId and payerPersonId may be null. Returns {receipt, replayed}. A rule that refuses the start
-- raises PERSON_MEMBERSHIP_BLOCKED with the blocker codes as a JSON HINT.
CREATE FUNCTION hon.start_person_membership(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; fp text; reserved boolean;
  prior hon.idempotency_records%ROWTYPE; pid uuid; plan_id uuid; plan_version integer; kind text; renews uuid; chosen_payer uuid; payer uuid;
  s_on date; e_on date; start_at timestamptz; end_at timestamptz; tz text; today date; facts jsonb; blockers text[]:='{}';
  plan hon.membership_plans%ROWTYPE; terms hon.membership_plan_versions%ROWTYPE; prev hon.memberships%ROWTYPE; acct hon.billing_accounts%ROWTYPE;
  m hon.memberships%ROWTYPE; start_row hon.person_membership_starts%ROWTYPE; receipt jsonb; ids jsonb; instant timestamptz;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  actor:=hon.require_person_membership_actor(p_subject);
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM
      ARRAY['confirmation','kind','membershipPlanId','membershipPlanVersion','payerPersonId','personId','renewsMembershipId','startDate']
    OR jsonb_typeof(p_input->'personId') IS DISTINCT FROM 'string' OR (p_input->>'personId') !~ uuid_re
    OR jsonb_typeof(p_input->'membershipPlanId') IS DISTINCT FROM 'string' OR (p_input->>'membershipPlanId') !~ uuid_re
    OR jsonb_typeof(p_input->'membershipPlanVersion') IS DISTINCT FROM 'number' OR (p_input->'membershipPlanVersion')::text !~ '^[1-9][0-9]{0,5}$'
    OR p_input->>'kind' IS NULL OR p_input->>'kind' NOT IN ('NEW','RENEW') OR jsonb_typeof(p_input->'kind')<>'string'
    OR ((p_input->>'kind')='NEW') IS DISTINCT FROM (jsonb_typeof(p_input->'renewsMembershipId')='null')
    OR (jsonb_typeof(p_input->'renewsMembershipId')<>'null' AND (jsonb_typeof(p_input->'renewsMembershipId')<>'string' OR (p_input->>'renewsMembershipId') !~ uuid_re))
    OR (jsonb_typeof(p_input->'payerPersonId')<>'null' AND (jsonb_typeof(p_input->'payerPersonId')<>'string' OR (p_input->>'payerPersonId') !~ uuid_re))
    OR jsonb_typeof(p_input->'startDate') IS DISTINCT FROM 'string' OR (p_input->>'startDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR p_input->>'confirmation' IS DISTINCT FROM 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_FROM_PLAN' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  BEGIN s_on:=(p_input->>'startDate')::date; EXCEPTION WHEN others THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END;
  IF to_char(s_on,'YYYY-MM-DD')<>p_input->>'startDate' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  pid:=(p_input->>'personId')::uuid; plan_id:=(p_input->>'membershipPlanId')::uuid; plan_version:=(p_input->>'membershipPlanVersion')::integer;
  kind:=p_input->>'kind'; renews:=(p_input->>'renewsMembershipId')::uuid; chosen_payer:=(p_input->>'payerPersonId')::uuid;
  fp:=encode(sha256(convert_to(jsonb_build_object('command','billing.membership.start_from_plan','input',p_input)::text,'UTF8')),'hex');

  -- Key reservation; IAM SHARE; people ... memberships and card starts SHARE ROW EXCLUSIVE (the 0175 relative order, so a
  -- second start for the same student waits); plan head and versions SHARE; evidence last.
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(org,school,actor,p_key,fp,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING true INTO reserved;
  reserved:=coalesce(reserved,false);
  LOCK TABLE hon.users,hon.principals,hon.principal_role_grants,hon.roles,hon.role_permissions,hon.permissions,hon.family_access_grants,hon.hq_operator_grants,hon.organizations,hon.schools,hon.organization_entitlements IN SHARE MODE;
  LOCK TABLE hon.people,hon.student_profiles,hon.families,hon.family_members,hon.billing_accounts,hon.memberships,hon.person_membership_starts IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE hon.membership_plans,hon.membership_plan_versions IN SHARE MODE;
  -- The same per-student lock the one-per-program trigger takes, after the table locks (the trigger's callers hold theirs first).
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.membership_one_per_program:'||org||':'||school||':'||pid,0));
  IF hon.require_person_membership_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'PERSON_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF NOT reserved THEN
    SELECT * INTO prior FROM hon.idempotency_records WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key FOR UPDATE;
    IF NOT FOUND OR prior.status<>'COMPLETED' THEN RAISE EXCEPTION 'PERSON_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    IF prior.request_fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    SELECT * INTO start_row FROM hon.person_membership_starts s WHERE s.organization_id=org AND s.school_id=school AND s.actor_principal_id=actor AND s.idempotency_key=p_key;
    IF NOT FOUND OR start_row.request_fingerprint<>fp OR prior.response_body IS DISTINCT FROM start_row.receipt THEN
      RAISE EXCEPTION 'PERSON_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('receipt',start_row.receipt,'replayed',true);
  END IF;

  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;
  IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=tz) THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  today:=hon.membership_local_date(clock_timestamp(),tz);
  facts:=hon.person_membership_start_facts(pid,today);
  blockers:=ARRAY(SELECT jsonb_array_elements_text(facts->'blockers'));
  IF cardinality(blockers)>0 THEN RAISE EXCEPTION 'PERSON_MEMBERSHIP_BLOCKED' USING ERRCODE='55000',HINT=to_jsonb(blockers)::text; END IF;

  -- Server-verified plan: current school, exactly the current version, available, open program (the 0175 rules).
  SELECT * INTO plan FROM hon.membership_plans x WHERE x.id=plan_id AND x.organization_id=org AND x.school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERSON_MEMBERSHIP_BLOCKED' USING ERRCODE='55000',HINT='["PLAN_UNAVAILABLE"]'; END IF;
  IF plan.current_version<>plan_version THEN RAISE EXCEPTION 'MEMBERSHIP_PLAN_VERSION_STALE' USING ERRCODE='40001'; END IF;
  SELECT * INTO terms FROM hon.membership_plan_versions v WHERE v.plan_id=plan.id AND v.version=plan.current_version AND v.organization_id=org AND v.school_id=school;
  IF NOT FOUND OR terms.availability<>'AVAILABLE'
    OR (terms.program_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hon.programs g WHERE g.id=terms.program_id AND g.organization_id=org AND g.school_id=school AND g.status NOT IN ('CANCELLED','COMPLETED'))) THEN
    RAISE EXCEPTION 'PERSON_MEMBERSHIP_BLOCKED' USING ERRCODE='55000',HINT='["PLAN_UNAVAILABLE"]'; END IF;

  -- Dates: the start day in the school timezone; a fixed term ends after termMonths (end date inclusive), open-ended has none.
  IF s_on<date '2000-01-01' OR s_on>today+730 THEN blockers:=blockers||'START_DATE_OUT_OF_RANGE'::text; END IF;
  start_at:=hon.membership_local_day_start(s_on,tz);
  IF terms.term_kind='FIXED_MONTHS' THEN
    e_on:=(s_on+make_interval(months=>terms.term_months))::date-1; end_at:=hon.membership_local_day_start(e_on+1,tz);
  END IF;

  -- Payer.
  IF chosen_payer IS NULL THEN
    IF facts->'payerProblem'<>'null'::jsonb THEN blockers:=blockers||('PAYER_'||(facts->>'payerProblem'))::text;
    ELSE payer:=(facts->>'defaultPayerPersonId')::uuid; END IF;
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(facts->'payers') x WHERE x->>'personId'=chosen_payer::text) THEN payer:=chosen_payer;
  ELSE blockers:=blockers||'PAYER_NOT_ALLOWED'::text; END IF;
  IF payer IS NOT NULL THEN
    acct:=hon.billing_import_payer_account(payer);
    IF acct.id IS NOT NULL AND acct.currency::text IS DISTINCT FROM terms.currency::text THEN blockers:=blockers||'PLAN_CURRENCY_MISMATCH'::text; END IF;
  END IF;

  -- Renewal: the same student's membership in the same group, with an end, not already renewed, and the new start on or after it.
  IF kind='RENEW' THEN
    SELECT * INTO prev FROM hon.memberships x WHERE x.id=renews AND x.organization_id=org AND x.school_id=school AND x.participant_person_id=pid;
    IF NOT FOUND OR prev.state NOT IN ('ACTIVE','FROZEN','CANCELLATION_PENDING','EXPIRED') OR prev.term_ends_at IS NULL
      OR hon.membership_program_group(prev.id) IS DISTINCT FROM terms.program_id OR start_at<prev.term_ends_at
      OR EXISTS(SELECT 1 FROM hon.person_membership_starts s JOIN hon.memberships r ON r.id=s.membership_id
        WHERE s.renews_membership_id=prev.id AND r.state IN ('DRAFT','ACTIVE','FROZEN','CANCELLATION_PENDING')) THEN
      blockers:=blockers||'RENEWAL_NOT_ALLOWED'::text; END IF;
  END IF;

  -- One per program.
  IF EXISTS(SELECT 1 FROM hon.memberships o WHERE o.organization_id=org AND o.school_id=school AND o.participant_person_id=pid AND o.state='DRAFT'
      AND hon.membership_program_group(o.id) IS NOT DISTINCT FROM terms.program_id) THEN blockers:=blockers||'DRAFT_IN_PROGRAM'::text; END IF;
  IF EXISTS(SELECT 1 FROM hon.memberships o WHERE o.organization_id=org AND o.school_id=school AND o.participant_person_id=pid
      AND o.state IN ('ACTIVE','FROZEN','CANCELLATION_PENDING') AND hon.membership_program_group(o.id) IS NOT DISTINCT FROM terms.program_id
      AND tstzrange(coalesce(o.term_started_at,'-infinity'),coalesce(o.term_ends_at,'infinity'),'[)') && tstzrange(start_at,coalesce(end_at,'infinity'),'[)')) THEN
    blockers:=blockers||'OVERLAPS_CURRENT_MEMBERSHIP'::text; END IF;
  IF cardinality(blockers)>0 THEN RAISE EXCEPTION 'PERSON_MEMBERSHIP_BLOCKED' USING ERRCODE='55000',HINT=to_jsonb(blockers)::text; END IF;

  IF acct.id IS NULL THEN
    INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification)
      VALUES(org,school,payer,terms.currency,'CANONICAL') RETURNING * INTO acct;
  ELSE PERFORM 1 FROM hon.billing_accounts a WHERE a.id=acct.id FOR UPDATE; END IF;
  INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at)
    VALUES(org,school,acct.id,pid,plan.plan_code,'DRAFT',start_at,end_at) RETURNING * INTO m;
  instant:=clock_timestamp();
  receipt:=jsonb_build_object('membershipId',m.id,'state','DRAFT','personId',pid,'kind',kind,'renewsMembershipId',renews,
    'membershipPlanId',plan.id,'membershipPlanVersion',plan.current_version,'planCode',plan.plan_code,'programId',terms.program_id,
    'payerPersonId',payer,'billingAccountId',acct.id,'startDate',to_char(s_on,'YYYY-MM-DD'),'endDate',CASE WHEN e_on IS NULL THEN NULL ELSE to_char(e_on,'YYYY-MM-DD') END,
    'termStartedAt',hon.saas_ts(start_at),'termEndsAt',hon.saas_ts(end_at),'recordedAt',hon.saas_ts(instant));
  INSERT INTO hon.membership_plan_selections(membership_id,organization_id,school_id,plan_id,plan_version,actor_principal_id,created_at)
    VALUES(m.id,org,school,plan.id,plan.current_version,actor,instant);
  INSERT INTO hon.person_membership_starts(membership_id,organization_id,school_id,person_id,kind,renews_membership_id,program_id,payer_person_id,
      billing_account_id,actor_principal_id,idempotency_key,request_fingerprint,receipt,created_at)
    VALUES(m.id,org,school,pid,kind,renews,terms.program_id,payer,acct.id,actor,p_key,fp,receipt,instant);
  ids:=receipt-'recordedAt'||jsonb_build_object('operation','CARD_MEMBERSHIP_START');
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','billing.membership.create','MEMBERSHIP',m.id,NULL,ids,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'billing.membership.drafted',1,'MEMBERSHIP',m.id,m.version,p_correlation,p_request,ids||jsonb_build_object('executionAllowed',false,'humanOnly',true));
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=receipt
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
  -- Final rechecks after every write: the one DRAFT in its group, its exact terms, the plan still current, live authority.
  IF NOT EXISTS(SELECT 1 FROM hon.memberships x WHERE x.id=m.id AND x.state='DRAFT' AND x.version=1 AND x.billing_account_id=acct.id
      AND x.participant_person_id=pid AND x.plan_code=plan.plan_code AND x.term_started_at=start_at AND x.term_ends_at IS NOT DISTINCT FROM end_at)
    OR (SELECT count(*) FROM hon.memberships o WHERE o.organization_id=org AND o.school_id=school AND o.participant_person_id=pid AND o.state='DRAFT'
      AND hon.membership_program_group(o.id) IS NOT DISTINCT FROM terms.program_id)<>1
    OR NOT EXISTS(SELECT 1 FROM hon.membership_plans x WHERE x.id=plan.id AND x.current_version=plan_version)
    OR hon.membership_program_group(m.id) IS DISTINCT FROM terms.program_id THEN
    RAISE EXCEPTION 'PERSON_MEMBERSHIP_CONFLICT' USING ERRCODE='40001'; END IF;
  IF hon.require_person_membership_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'PERSON_MEMBERSHIP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',receipt,'replayed',false);
END $$;

COMMENT ON FUNCTION hon.start_person_membership(text,jsonb,text,uuid,uuid) IS
'Only a direct HUMAN_UI staff member with billing.membership.create: one DRAFT for an existing student of the session school from the exact current published plan version, one per program group. No schedule, invoice, payment, agreement, provider, communication, activation, automation, Action Engine or AI effect.';

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_person_membership_start(text,jsonb)','hon.start_person_membership(text,jsonb,text,uuid,uuid)'];
  fns text[]:=ARRAY['hon.guard_person_membership_start()','hon.membership_program_group(uuid)','hon.guard_person_membership_overlap()',
    'hon.require_person_membership_actor(text)','hon.person_membership_start_facts(uuid,date)','hon.person_membership_start_item(hon.memberships,text)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  EXECUTE 'REVOKE ALL ON TABLE hon.person_membership_starts FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.person_membership_starts FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
  END IF;
END $$;

COMMIT;
