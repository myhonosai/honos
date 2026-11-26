BEGIN;

-- G1 (0686, renumbered from 0370 (then 0491) above the main ceiling 0496 on 2026-11-18; first assigned by the coordinator 2026-11-15): monthly goal planner, part 1. Owner (David, 2026-11-15): "Monthly
-- goal need to be more detailed with ai help. So it breaks down in not just monetary but how many appointment, lead,
-- renewal, upgrade needed". Doc: docs/architecture/MONTHLY_GOAL_PLANNER.md.
--
-- 1. hon.school_renewals_due(org, school, from, to, as_of): PRIVATE shared helper (no runtime grant; callers prove
--    authority first). One row per membership whose term end falls in [from, to), with whether it renewed. Also used by
--    the reports renewals forecast (0372).
--      due        a non-draft membership whose current term end, or whose term end before an EXTENSION date revision
--                 (0178 prior_term_ends_at), is in the window; due_at = the earliest. Open-ended terms never fall due.
--      RENEWED    EXTENSION: a revision moved that end later or made the term open-ended (renewed_at = its time);
--                 NEW_MEMBERSHIP: another non-draft membership of the same participant at the same school whose term
--                 started after this one's start and within 60 days either side of due_at, in the same program when
--                 both have one (earliest such start; renewed_at = its creation time).
--      CANCELLED  otherwise, state CANCELLED or CANCELLATION_PENDING; LAPSED otherwise when due_at <= as_of; else OPEN.
--      Plan facts come from the 0175 plan selection and are null when the membership has none.
-- 2. hon.read_monthly_goal_plan(subject, input): the single runtime entry point. Same authority as 0331 school reports
--    (hon.require_school_reports_actor: direct human, live reporting.view at the session school, active school,
--    organization and HON entitlement), proved before and after the read. Counts and money totals only: no names,
--    people, memberships, invoices or payments leave it. Nothing is written, sent, charged or scheduled; no AI is called.
--    Rates, sources and needed counts are defined in the doc and returned with their record counts.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Monthly goal plan requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.require_school_reports_actor(text)') IS NULL
    OR to_regprocedure('hon.school_report_periods(uuid,uuid,text,integer,timestamptz)') IS NULL
    OR to_regclass('hon.membership_date_revisions') IS NULL OR to_regclass('hon.membership_plan_selections') IS NULL THEN
    RAISE EXCEPTION 'Monthly goal plan requires 0175, 0178 and 0331';
  END IF;
END $$;

CREATE INDEX memberships_school_term_end_idx ON hon.memberships (organization_id, school_id, term_ends_at)
  WHERE state<>'DRAFT' AND term_ends_at IS NOT NULL;
CREATE INDEX membership_date_revisions_extension_idx ON hon.membership_date_revisions (organization_id, school_id, prior_term_ends_at)
  WHERE change_kind='EXTENSION';

CREATE FUNCTION hon.school_renewals_due(org uuid, school uuid, p_from timestamptz, p_to timestamptz, p_as_of timestamptz)
RETURNS TABLE(membership_id uuid, participant_person_id uuid, membership_state text, due_at timestamptz, outcome text,
  renewed_by text, successor_membership_id uuid, renewed_at timestamptz, plan_id uuid, plan_version integer, plan_code text,
  program_id uuid, currency text, price_minor integer, billing_frequency text, term_months integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH ends AS (
    SELECT m.id, m.term_ends_at AS at FROM hon.memberships m
    WHERE m.organization_id=org AND m.school_id=school AND m.state<>'DRAFT'
      AND m.term_ends_at >= p_from AND m.term_ends_at < p_to
    UNION ALL
    SELECT r.membership_id, r.prior_term_ends_at FROM hon.membership_date_revisions r
    JOIN hon.memberships m ON m.id=r.membership_id AND m.organization_id=org AND m.school_id=school AND m.state<>'DRAFT'
    WHERE r.organization_id=org AND r.school_id=school AND r.change_kind='EXTENSION'
      AND r.prior_term_ends_at >= p_from AND r.prior_term_ends_at < p_to
  ),
  due AS (
    SELECT e.id, min(e.at) AS due_at FROM ends e GROUP BY e.id
  ),
  facts AS (
    SELECT m.id, m.participant_person_id, m.state::text AS state, m.term_started_at, d.due_at, m.plan_code,
      sel.plan_id, sel.plan_version, v.program_id, v.currency::text AS currency, v.price_minor, v.billing_frequency, v.term_months
    FROM due d JOIN hon.memberships m ON m.id=d.id AND m.organization_id=org AND m.school_id=school
    LEFT JOIN hon.membership_plan_selections sel ON sel.membership_id=m.id AND sel.organization_id=org AND sel.school_id=school
    LEFT JOIN hon.membership_plan_versions v ON v.plan_id=sel.plan_id AND v.version=sel.plan_version
      AND v.organization_id=org AND v.school_id=school
  )
  SELECT f.id, f.participant_person_id, f.state, f.due_at,
    CASE WHEN x.at IS NOT NULL OR n.id IS NOT NULL THEN 'RENEWED'
      WHEN f.state IN ('CANCELLED','CANCELLATION_PENDING') THEN 'CANCELLED'
      WHEN f.due_at <= p_as_of THEN 'LAPSED' ELSE 'OPEN' END,
    CASE WHEN x.at IS NOT NULL THEN 'EXTENSION' WHEN n.id IS NOT NULL THEN 'NEW_MEMBERSHIP' END,
    CASE WHEN x.at IS NULL THEN n.id END,
    coalesce(x.at, n.created_at),
    f.plan_id, f.plan_version, f.plan_code, f.program_id, f.currency, f.price_minor, f.billing_frequency, f.term_months
  FROM facts f
  LEFT JOIN LATERAL (
    SELECT min(r.created_at) AS at FROM hon.membership_date_revisions r
    WHERE r.organization_id=org AND r.school_id=school AND r.membership_id=f.id AND r.change_kind='EXTENSION'
      AND r.prior_term_ends_at=f.due_at AND (r.term_ends_at IS NULL OR r.term_ends_at > r.prior_term_ends_at)
  ) x ON true
  LEFT JOIN LATERAL (
    SELECT o.id, o.created_at FROM hon.memberships o
    LEFT JOIN hon.membership_plan_selections os ON os.membership_id=o.id AND os.organization_id=org AND os.school_id=school
    LEFT JOIN hon.membership_plan_versions ov ON ov.plan_id=os.plan_id AND ov.version=os.plan_version
      AND ov.organization_id=org AND ov.school_id=school
    WHERE o.organization_id=org AND o.school_id=school AND o.id<>f.id AND o.state<>'DRAFT'
      AND o.participant_person_id=f.participant_person_id AND o.term_started_at IS NOT NULL
      AND o.term_started_at > f.term_started_at
      AND o.term_started_at >= f.due_at - interval '60 days' AND o.term_started_at <= f.due_at + interval '60 days'
      AND (f.program_id IS NULL OR ov.program_id IS NULL OR ov.program_id=f.program_id)
    ORDER BY o.term_started_at, o.id LIMIT 1
  ) n ON true
$$;

-- A rate with its record counts. Owner value wins; else records when the denominator reaches the minimum.
CREATE FUNCTION hon.monthly_goal_rate(numerator bigint, denominator bigint, minimum integer, owner_value numeric) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('numerator', numerator, 'denominator', denominator, 'minimumRecords', minimum,
    'recordValue', CASE WHEN denominator >= minimum AND denominator > 0 THEN round(numerator::numeric/denominator, 4) END,
    'value', CASE WHEN owner_value IS NOT NULL THEN owner_value
      WHEN denominator >= minimum AND denominator > 0 AND numerator > 0 THEN round(numerator::numeric/denominator, 4) END,
    'source', CASE WHEN owner_value IS NOT NULL THEN 'OWNER' WHEN denominator >= minimum AND denominator > 0 AND numerator > 0
      THEN 'RECORDS' ELSE 'INSUFFICIENT' END)
$$;

-- Pace line: actual so far against the needed count spread over the month.
CREATE FUNCTION hon.monthly_goal_pace(actual numeric, needed numeric, elapsed numeric, weeks_left integer) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('actual', actual, 'needed', needed,
    'expectedByNow', CASE WHEN needed IS NOT NULL THEN ceil(needed*elapsed) END,
    'remaining', CASE WHEN needed IS NOT NULL THEN greatest(needed-actual, 0) END,
    'perWeek', CASE WHEN needed IS NOT NULL AND weeks_left > 0 THEN ceil(greatest(needed-actual, 0)/weeks_left) END,
    'status', CASE WHEN needed IS NULL THEN 'UNKNOWN' WHEN actual >= needed THEN 'MET'
      WHEN actual >= ceil(needed*elapsed)*0.9 THEN 'ON_PACE' ELSE 'BEHIND' END)
$$;

-- Input: {} or any of month, goalMinor + currency, historyMonths, bookRate, showRate, closeRate, renewalRate,
-- avgNewMinor, plannedUpgrades, upgradeValueMinor.
CREATE FUNCTION hon.read_monthly_goal_plan(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; s hon.schools%ROWTYPE;
  tz text; as_of timestamptz:=statement_timestamp(); cur date; mon date; hist integer:=6; k text; v jsonb;
  m_from timestamptz; m_to timestamptz; h_from timestamptz; h_to timestamptz; elapsed numeric; weeks_left integer; started boolean;
  goal numeric; ccy text; up_n integer; up_v bigint; o_book numeric; o_show numeric; o_close numeric; o_renew numeric; o_avg bigint;
  periods jsonb; suggested jsonb; collected numeric; sched_n bigint; sched_v numeric;
  r_due bigint; r_renewed bigint; r_cancelled bigint; r_lapsed bigint; r_open bigint; r_open_priced bigint; r_open_value numeric;
  h_resolved bigint; h_renewed bigint; leads bigint; booked_leads bigint; shows bigint; no_shows bigint; shown_leads bigint; won_leads bigint;
  new_n bigint; new_sum numeric;
  rate_renew jsonb; rate_book jsonb; rate_show jsonb; rate_close jsonb; avg_new jsonb;
  exp_renewals numeric; exp_renewal_value numeric; up_value numeric; gap numeric; need_new numeric; need_shows numeric; need_appts numeric; need_leads numeric;
  need_renewals numeric; successors uuid[]; a_leads bigint; a_appts bigint; a_shows bigint; a_new bigint; result jsonb;
BEGIN
  actor:=hon.require_school_reports_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_input) LOOP
    IF k='month' THEN
      IF jsonb_typeof(v)<>'string' OR v#>>'{}' !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    ELSIF k='currency' THEN
      IF jsonb_typeof(v)<>'string' OR v#>>'{}' !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    ELSIF k='historyMonths' THEN
      IF jsonb_typeof(v)<>'number' OR v::text !~ '^(3|4|5|6|7|8|9|10|11|12)$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    ELSIF k IN ('goalMinor','avgNewMinor','upgradeValueMinor') THEN
      IF jsonb_typeof(v)<>'number' OR v::text !~ '^(0|[1-9][0-9]{0,10})$' OR v::text::numeric>10000000000
        OR (k<>'goalMinor' AND v::text::numeric<1) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    ELSIF k='plannedUpgrades' THEN
      IF jsonb_typeof(v)<>'number' OR v::text !~ '^(0|[1-9][0-9]{0,3})$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    ELSIF k IN ('bookRate','showRate','closeRate','renewalRate') THEN
      IF jsonb_typeof(v)<>'number' OR v::text !~ '^(1|0\.[0-9]{1,4}|1\.0{1,4})$' OR v::text::numeric<=0 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    ELSE RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (p_input ? 'goalMinor') <> (p_input ? 'currency') OR (p_input ? 'plannedUpgrades') <> (p_input ? 'upgradeValueMinor') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;

  SELECT * INTO s FROM hon.schools x WHERE x.id=school AND x.organization_id=org;
  SELECT n.name INTO tz FROM pg_timezone_names n WHERE n.name=s.timezone;
  IF tz IS NULL THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  cur:=date_trunc('month', as_of AT TIME ZONE tz)::date;
  mon:=coalesce(to_date(p_input->>'month','YYYY-MM'), cur);
  IF mon < cur - interval '11 months' OR mon > cur + interval '2 months' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_input ? 'historyMonths' THEN hist:=(p_input->>'historyMonths')::integer; END IF;
  goal:=(p_input->>'goalMinor')::numeric; ccy:=p_input->>'currency';
  up_n:=(p_input->>'plannedUpgrades')::integer; up_v:=(p_input->>'upgradeValueMinor')::bigint;
  o_book:=(p_input->>'bookRate')::numeric; o_show:=(p_input->>'showRate')::numeric; o_close:=(p_input->>'closeRate')::numeric;
  o_renew:=(p_input->>'renewalRate')::numeric; o_avg:=(p_input->>'avgNewMinor')::bigint;

  m_from:=mon::timestamp AT TIME ZONE tz; m_to:=(mon + interval '1 month')::timestamp AT TIME ZONE tz;
  h_to:=cur::timestamp AT TIME ZONE tz; h_from:=(cur - make_interval(months => hist))::timestamp AT TIME ZONE tz;
  started:=m_from <= as_of;
  elapsed:=CASE WHEN m_to <= as_of THEN 1 WHEN NOT started THEN 0
    ELSE round(extract(epoch FROM as_of - m_from)/extract(epoch FROM m_to - m_from), 4) END;
  weeks_left:=CASE WHEN m_to <= as_of THEN 0 ELSE ceil(extract(epoch FROM m_to - greatest(as_of, m_from))/604800)::integer END;

  -- Collected per currency for the last 3 complete months and the plan month, from the 0331 period builder.
  periods:=hon.school_report_periods(org, school, tz, 4, as_of);
  SELECT coalesce(jsonb_agg(jsonb_build_object('currency', c.currency, 'monthlyMinor', c.avg_minor, 'months', c.n) ORDER BY c.currency), '[]'::jsonb)
    INTO suggested FROM (
      -- A month with no records for a currency counts as zero.
      SELECT r->>'currency' AS currency, 3 AS n,
        round(sum((r->>'recordedPaymentsMinor')::numeric + (r->>'onlinePaymentsMinor')::numeric - (r->>'refundsMinor')::numeric)/300)*100 AS avg_minor
      FROM jsonb_array_elements(periods) p CROSS JOIN LATERAL jsonb_array_elements(p->'revenue') r
      WHERE NOT (p->>'partial')::boolean GROUP BY 1) c;

  IF ccy IS NOT NULL THEN
    SELECT coalesce(sum(z.amount), 0) INTO collected FROM (
      SELECT r.amount_minor::numeric AS amount FROM hon.invoice_payment_records r
        WHERE r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL AND r.currency::text=ccy
          AND r.received_on >= mon AND r.received_on < (mon + interval '1 month')::date AND r.received_on <= (as_of AT TIME ZONE tz)::date
      UNION ALL
      SELECT p.amount_minor FROM hon.payment_attempts p
        WHERE p.organization_id=org AND p.school_id=school AND p.state='SUCCEEDED' AND p.currency::text=ccy
          AND coalesce(p.reconciled_at, p.initiated_at) >= m_from AND coalesce(p.reconciled_at, p.initiated_at) < least(m_to, as_of)
      UNION ALL
      SELECT -f.amount_minor FROM hon.membership_refund_records f
        WHERE f.organization_id=org AND f.school_id=school AND f.currency::text=ccy
          AND f.refunded_on >= mon AND f.refunded_on < (mon + interval '1 month')::date AND f.refunded_on <= (as_of AT TIME ZONE tz)::date) z;

    -- Charges still to come in the month: weekly schedules once per remaining week, never past the term end.
    SELECT count(*) FILTER (WHERE c.n>0), coalesce(sum(c.n*c.amount), 0) INTO sched_n, sched_v FROM (
      SELECT sc.amount_minor::numeric AS amount,
        CASE WHEN sc.next_charge_at IS NULL OR sc.next_charge_at >= least(m_to, coalesce(ms.term_ends_at, m_to))
            OR sc.next_charge_at < greatest(as_of, m_from) THEN 0
          WHEN sc.frequency='WEEKLY' THEN floor(extract(epoch FROM least(m_to, coalesce(ms.term_ends_at, m_to)) - sc.next_charge_at - interval '1 second')/604800) + 1
          ELSE 1 END AS n
      FROM hon.membership_payment_schedules sc
      JOIN hon.memberships ms ON ms.id=sc.membership_id AND ms.organization_id=org AND ms.school_id=school AND ms.state='ACTIVE'
      WHERE sc.organization_id=org AND sc.school_id=school AND sc.status='ACTIVE' AND sc.currency::text=ccy) c;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE d.outcome='RENEWED'), count(*) FILTER (WHERE d.outcome='CANCELLED'),
      count(*) FILTER (WHERE d.outcome='LAPSED'), count(*) FILTER (WHERE d.outcome='OPEN'),
      count(*) FILTER (WHERE d.outcome='OPEN' AND d.currency=ccy AND d.price_minor IS NOT NULL),
      coalesce(sum(d.price_minor) FILTER (WHERE d.outcome='OPEN' AND d.currency=ccy), 0)
    INTO r_due, r_renewed, r_cancelled, r_lapsed, r_open, r_open_priced, r_open_value
    FROM hon.school_renewals_due(org, school, m_from, m_to, as_of) d;
  SELECT count(*) FILTER (WHERE d.outcome<>'OPEN'), count(*) FILTER (WHERE d.outcome='RENEWED')
    INTO h_resolved, h_renewed FROM hon.school_renewals_due(org, school, h_from, h_to, as_of) d;

  -- Memberships that renewed another one are renewals, not new enrollments.
  SELECT coalesce(array_agg(d.successor_membership_id) FILTER (WHERE d.successor_membership_id IS NOT NULL), '{}') INTO successors
    FROM hon.school_renewals_due(org, school, least(h_from, m_from) - interval '60 days', greatest(h_to, m_to) + interval '60 days', as_of) d;

  SELECT count(*), count(*) FILTER (WHERE EXISTS(SELECT 1 FROM hon.crm_appointments a WHERE a.organization_id=org AND a.school_id=school
      AND a.crm_lead_id=l.id AND a.status<>'CANCELLED'))
    INTO leads, booked_leads FROM hon.crm_leads l
    WHERE l.organization_id=org AND l.school_id=school AND l.created_at >= h_from AND l.created_at < h_to;
  SELECT count(*) FILTER (WHERE a.status='COMPLETED'), count(*) FILTER (WHERE a.status='NO_SHOW'),
      count(DISTINCT a.crm_lead_id) FILTER (WHERE a.status='COMPLETED'),
      count(DISTINCT a.crm_lead_id) FILTER (WHERE a.status='COMPLETED' AND l.won_at IS NOT NULL)
    INTO shows, no_shows, shown_leads, won_leads
    FROM hon.crm_appointments a JOIN hon.crm_leads l ON l.id=a.crm_lead_id AND l.organization_id=org AND l.school_id=school
    WHERE a.organization_id=org AND a.school_id=school AND a.starts_at >= h_from AND a.starts_at < h_to;
  IF ccy IS NOT NULL THEN
    SELECT count(*), coalesce(sum(v.price_minor), 0) INTO new_n, new_sum
    FROM hon.memberships ms
    JOIN hon.membership_plan_selections sel ON sel.membership_id=ms.id AND sel.organization_id=org AND sel.school_id=school
    JOIN hon.membership_plan_versions v ON v.plan_id=sel.plan_id AND v.version=sel.plan_version AND v.organization_id=org AND v.school_id=school
    WHERE ms.organization_id=org AND ms.school_id=school AND ms.state<>'DRAFT' AND v.currency::text=ccy AND v.price_minor>0
      AND ms.term_started_at >= h_from AND ms.term_started_at < h_to AND ms.id <> ALL(successors);
  END IF;

  rate_renew:=hon.monthly_goal_rate(h_renewed, h_resolved, 10, o_renew);
  rate_book:=hon.monthly_goal_rate(booked_leads, leads, 10, o_book);
  rate_show:=hon.monthly_goal_rate(shows, shows+no_shows, 10, o_show);
  rate_close:=hon.monthly_goal_rate(won_leads, shown_leads, 10, o_close);
  avg_new:=jsonb_build_object('records', coalesce(new_n, 0), 'minimumRecords', 5,
    'recordValueMinor', CASE WHEN new_n >= 5 THEN round(new_sum/new_n) END,
    'valueMinor', coalesce(o_avg::numeric, CASE WHEN new_n >= 5 THEN round(new_sum/new_n) END),
    'source', CASE WHEN o_avg IS NOT NULL THEN 'OWNER' WHEN new_n >= 5 THEN 'RECORDS' ELSE 'INSUFFICIENT' END);

  -- Renewals still open are expected at the renewal rate; renewals already done count toward the needed total.
  exp_renewals:=CASE WHEN rate_renew->'value' <> 'null' THEN round(r_open*(rate_renew->>'value')::numeric) END;
  exp_renewal_value:=CASE WHEN rate_renew->'value' <> 'null' THEN round(r_open_value*(rate_renew->>'value')::numeric) END;
  need_renewals:=CASE WHEN exp_renewals IS NOT NULL THEN r_renewed + exp_renewals END;
  up_value:=coalesce(up_n::numeric*up_v, 0);
  IF goal IS NOT NULL AND exp_renewal_value IS NOT NULL THEN
    gap:=greatest(goal - collected - sched_v - exp_renewal_value - up_value, 0);
    need_new:=CASE WHEN gap=0 THEN 0 WHEN avg_new->'valueMinor' <> 'null' THEN ceil(gap/(avg_new->>'valueMinor')::numeric) END;
    need_shows:=CASE WHEN need_new=0 THEN 0 WHEN rate_close->'value' <> 'null' THEN ceil(need_new/(rate_close->>'value')::numeric) END;
    need_appts:=CASE WHEN need_shows=0 THEN 0 WHEN rate_show->'value' <> 'null' THEN ceil(need_shows/(rate_show->>'value')::numeric) END;
    need_leads:=CASE WHEN need_appts=0 THEN 0 WHEN rate_book->'value' <> 'null' THEN ceil(need_appts/(rate_book->>'value')::numeric) END;
  END IF;

  IF started THEN
    SELECT count(*) INTO a_leads FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.created_at >= m_from AND l.created_at < least(m_to, as_of);
    SELECT count(*) FILTER (WHERE a.created_at >= m_from AND a.created_at < least(m_to, as_of) AND a.status<>'CANCELLED'),
        count(*) FILTER (WHERE a.starts_at >= m_from AND a.starts_at < least(m_to, as_of) AND a.status='COMPLETED')
      INTO a_appts, a_shows FROM hon.crm_appointments a
      WHERE a.organization_id=org AND a.school_id=school AND (a.created_at >= m_from OR a.starts_at >= m_from);
    SELECT count(*) INTO a_new FROM hon.memberships ms WHERE ms.organization_id=org AND ms.school_id=school AND ms.state<>'DRAFT'
      AND ms.term_started_at >= m_from AND ms.term_started_at < least(m_to, as_of)
      AND ms.id <> ALL(successors);
  END IF;

  result:=jsonb_build_object('schemaVersion','MONTHLY_GOAL_PLAN_V1','schoolId',school,'timezone',tz,
    'month',to_char(mon,'YYYY-MM'),'currentMonth',to_char(cur,'YYYY-MM'),
    'from',hon.saas_ts(m_from),'to',hon.saas_ts(m_to),'generatedAt',hon.saas_ts(as_of),
    'elapsedShare',elapsed,'weeksLeft',weeks_left,
    'history',jsonb_build_object('months',hist,'from',hon.saas_ts(h_from),'to',hon.saas_ts(h_to)),
    'suggestedGoals',suggested,
    'goal',CASE WHEN goal IS NULL THEN NULL ELSE jsonb_build_object('currency',ccy,'goalMinor',goal) END,
    'rates',jsonb_build_object('renewal',rate_renew,'book',rate_book,'show',rate_show,'close',rate_close),
    'renewals',jsonb_build_object('due',r_due,'renewed',r_renewed,'cancelled',r_cancelled,'lapsed',r_lapsed,'open',r_open,
      'openPriced',r_open_priced,'openValueMinor',CASE WHEN ccy IS NULL THEN NULL ELSE r_open_value END,
      'expectedRenewals',exp_renewals,'expectedValueMinor',CASE WHEN ccy IS NULL THEN NULL ELSE exp_renewal_value END),
    'averageNewMembership',CASE WHEN ccy IS NULL THEN NULL ELSE avg_new END,
    'sources',CASE WHEN ccy IS NULL THEN NULL ELSE jsonb_build_object('collectedMinor',collected,
      'scheduled',jsonb_build_object('schedules',sched_n,'valueMinor',sched_v),
      'renewalsMinor',exp_renewal_value,
      'upgrades',jsonb_build_object('planned',coalesce(up_n,0),'valueEachMinor',up_v,'valueMinor',up_value),
      'gapMinor',gap) END,
    'needed',CASE WHEN goal IS NULL THEN NULL ELSE jsonb_build_object('renewals',need_renewals,'upgrades',coalesce(up_n,0),
      'newEnrollments',need_new,'shows',need_shows,'appointments',need_appts,'leads',need_leads) END,
    'pace',CASE WHEN NOT started OR goal IS NULL THEN NULL ELSE jsonb_build_object(
      'collected',hon.monthly_goal_pace(collected, goal, elapsed, weeks_left),
      'renewals',hon.monthly_goal_pace(r_renewed, need_renewals, elapsed, weeks_left),
      'newEnrollments',hon.monthly_goal_pace(a_new, need_new, elapsed, weeks_left),
      'shows',hon.monthly_goal_pace(a_shows, need_shows, elapsed, weeks_left),
      'appointments',hon.monthly_goal_pace(a_appts, need_appts, elapsed, weeks_left),
      'leads',hon.monthly_goal_pace(a_leads, need_leads, elapsed, weeks_left)) END);
  -- Authority is proved again after the read; a lapse during the read returns nothing.
  IF hon.require_school_reports_actor(p_subject) IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SCHOOL_REPORTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;
COMMENT ON FUNCTION hon.read_monthly_goal_plan(text,jsonb) IS
'Direct HUMAN_UI read-only monthly goal plan (G1, 0686): goal sources, school rates with record counts, activity counts needed and pace. Counts and totals only. No DML, no AI.';

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.school_renewals_due(uuid,uuid,timestamptz,timestamptz,timestamptz)',
    'hon.monthly_goal_rate(bigint,bigint,integer,numeric)','hon.monthly_goal_pace(numeric,numeric,numeric,integer)',
    'hon.read_monthly_goal_plan(text,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_monthly_goal_plan(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
