BEGIN;

-- R3 (0520, allocated by the coordinator, renumbered 2026-11-18 above main 0519): the school reports dashboard. Owner (David), 2026-11-15 08:23Z, on
-- the Manus CRM ideas: "Apply all." Idea #6: range chips, KPI cards with a trend, an income chart, belt mix, open leads by
-- stage and won vs lost. One read-only entry point, hon.read_school_reports_dashboard(subject, input), for the session
-- school only, with the same authority as 0331 (hon.require_school_reports_actor: a direct human at the session school with
-- live reporting.view, an active school and organization and an active HON entitlement; HQ, family and automated callers
-- refused). Counts and money totals only: no names, contact details, people, invoices or payment rows leave this function.
-- Ranges, all in the school's own time zone:
--   THIS_MONTH  the first of this month to now; compared with last month from its first to the same point.
--   LAST_MONTH  all of last month; compared with the month before.
--   D30 / D90   today and the 29 / 89 days before it (to now); compared with the 30 / 90 days before that.
--   M12         this month and the 11 before it (to now); compared with the 12 months before that.
--   ALL         every record up to now; no comparison.
-- Definitions (the 0331 rules where they overlap):
--   activeStudents  people with a membership (not a draft) that counts at the range end: from its term start until the
--                   first of its term end or its recorded cancellation. Paused memberships still count. A cancelled
--                   membership with no recorded cancellation time is left out (as in 0331).
--   newStudents     people whose first membership (not a draft) started in the range.
--   appointments    CRM appointments not cancelled that started in the range.
--   leadsWon/Lost   leads marked won / lost in the range. Win rate = won / (won + lost), shown by the page.
--   income          per currency: staff-recorded payments not voided + successful online payments, and recorded refunds,
--                   in the range. Operational totals from HON records, not accounting or provider-settled figures.
--   series          income per day (THIS_MONTH, LAST_MONTH, D30), per 7 days (D90) or per month (M12, ALL: the last 36
--                   months at most, marked truncated when older income exists).
--   belts           now (a colour only when it is a #hex value): people counted in activeStudents at this moment, by the current rank of each active curriculum
--                   enrollment (a person in two curricula counts in each); people with no ranked active enrollment are
--                   counted once as unranked.
--   pipeline        now: open leads by pipeline stage.
-- Nothing is written, sent, charged or scheduled.

-- Members (the 0331 rule) for one school: one row per membership with the time it started and stopped counting.
CREATE FUNCTION hon.school_dashboard_members(org uuid, school uuid)
RETURNS TABLE(participant uuid, started timestamptz, ended timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT x.participant_person_id, x.term_started_at,
    CASE WHEN c.at IS NULL THEN x.term_ends_at WHEN x.term_ends_at IS NULL THEN c.at ELSE least(c.at, x.term_ends_at) END
  FROM hon.memberships x
  LEFT JOIN LATERAL (SELECT min(a.occurred_at) AS at FROM hon.audit_events a
    WHERE a.organization_id=org AND a.school_id=school AND a.entity_id=x.id AND a.action_code='billing.membership.cancel'
      AND a.result='SUCCEEDED' AND a.entity_type='MEMBERSHIP') c ON true
  WHERE x.organization_id=org AND x.school_id=school AND x.state<>'DRAFT' AND x.term_started_at IS NOT NULL
    AND NOT (x.state='CANCELLED' AND c.at IS NULL)
$$;

-- Income per currency in [f, t) (school time for the date-only records). f may be -infinity.
CREATE FUNCTION hon.school_dashboard_income(org uuid, school uuid, tz text, f timestamptz, t timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH d AS (
    SELECT (f AT TIME ZONE tz)::date AS d_from,
      -- The first school day not inside the range: the end day itself when the range ends at midnight, else the day after.
      CASE WHEN (t AT TIME ZONE tz) = date_trunc('day', t AT TIME ZONE tz) THEN (t AT TIME ZONE tz)::date ELSE (t AT TIME ZONE tz)::date + 1 END AS d_to
  ), z AS (
    SELECT r.currency::text AS currency, r.amount_minor::bigint AS paid, 0::bigint AS refunded FROM hon.invoice_payment_records r, d
      WHERE r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL AND r.received_on >= d.d_from AND r.received_on < d.d_to
    UNION ALL
    SELECT p.currency::text, p.amount_minor, 0 FROM hon.payment_attempts p
      WHERE p.organization_id=org AND p.school_id=school AND p.state='SUCCEEDED'
        AND coalesce(p.reconciled_at, p.initiated_at) >= f AND coalesce(p.reconciled_at, p.initiated_at) < t
    UNION ALL
    SELECT m.currency::text, 0, m.amount_minor FROM hon.membership_refund_records m, d
      WHERE m.organization_id=org AND m.school_id=school AND m.refunded_on >= d.d_from AND m.refunded_on < d.d_to
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'paymentsMinor', paid, 'refundsMinor', refunded) ORDER BY currency), '[]'::jsonb)
  FROM (SELECT currency, sum(paid) AS paid, sum(refunded) AS refunded FROM z GROUP BY currency) y
$$;

-- The KPI counts and income for [f, t).
CREATE FUNCTION hon.school_dashboard_kpis(org uuid, school uuid, tz text, f timestamptz, t timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object(
    'activeStudents', (SELECT count(DISTINCT m.participant) FROM hon.school_dashboard_members(org, school) m
      WHERE m.started <= t AND (m.ended IS NULL OR m.ended > t)),
    'newStudents', (SELECT count(*) FROM (SELECT x.participant_person_id, min(x.term_started_at) AS first_start FROM hon.memberships x
      WHERE x.organization_id=org AND x.school_id=school AND x.state<>'DRAFT' AND x.term_started_at IS NOT NULL
      GROUP BY x.participant_person_id) n WHERE n.first_start >= f AND n.first_start < t),
    'appointments', (SELECT count(*) FROM hon.crm_appointments a WHERE a.organization_id=org AND a.school_id=school
      AND a.status<>'CANCELLED' AND a.starts_at >= f AND a.starts_at < t),
    'leadsWon', (SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.won_at >= f AND l.won_at < t),
    'leadsLost', (SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.lost_at >= f AND l.lost_at < t),
    'income', hon.school_dashboard_income(org, school, tz, f, t))
$$;

-- The session school's dashboard. Input: {} or { range: THIS_MONTH | LAST_MONTH | D30 | D90 | M12 | ALL } (default THIS_MONTH).
CREATE FUNCTION hon.read_school_reports_dashboard(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); tz text; s hon.schools%ROWTYPE;
  rng text:='THIS_MONTH'; as_of timestamptz:=statement_timestamp(); local_now timestamp; month_start timestamp;
  f timestamptz; t timestamptz; pf timestamptz; pt timestamptz; bucket text; step interval; first_local timestamp; s_from timestamp;
  truncated boolean:=false; series jsonb; belts jsonb; pipeline jsonb;
  utc constant text:='YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
BEGIN
  PERFORM hon.require_school_reports_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k<>'range')
    OR (p_input ? 'range' AND (jsonb_typeof(p_input->'range')<>'string'
      OR (p_input->>'range') NOT IN ('THIS_MONTH','LAST_MONTH','D30','D90','M12','ALL'))) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_input ? 'range' THEN rng:=p_input->>'range'; END IF;
  SELECT * INTO s FROM hon.schools x WHERE x.id=school AND x.organization_id=org;
  SELECT n.name INTO tz FROM pg_timezone_names n WHERE n.name=s.timezone;
  IF tz IS NULL THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;

  local_now:=as_of AT TIME ZONE tz; month_start:=date_trunc('month', local_now);
  IF rng='THIS_MONTH' THEN
    f:=month_start AT TIME ZONE tz; t:=as_of; pf:=(month_start - interval '1 month') AT TIME ZONE tz;
    -- The same point of last month, never past its end (31 March compares with the whole of February).
    pt:=least(((month_start - interval '1 month') + (local_now - month_start)) AT TIME ZONE tz, f);
    bucket:='DAY'; step:=interval '1 day'; s_from:=month_start;
  ELSIF rng='LAST_MONTH' THEN
    f:=(month_start - interval '1 month') AT TIME ZONE tz; t:=month_start AT TIME ZONE tz;
    pf:=(month_start - interval '2 months') AT TIME ZONE tz; pt:=f; bucket:='DAY'; step:=interval '1 day'; s_from:=month_start - interval '1 month';
  ELSIF rng IN ('D30','D90') THEN
    s_from:=date_trunc('day', local_now) - CASE rng WHEN 'D30' THEN interval '29 days' ELSE interval '89 days' END;
    f:=s_from AT TIME ZONE tz; t:=as_of;
    pf:=(s_from - CASE rng WHEN 'D30' THEN interval '30 days' ELSE interval '90 days' END) AT TIME ZONE tz; pt:=f;
    bucket:=CASE rng WHEN 'D30' THEN 'DAY' ELSE 'WEEK' END; step:=CASE rng WHEN 'D30' THEN interval '1 day' ELSE interval '7 days' END;
  ELSIF rng='M12' THEN
    s_from:=month_start - interval '11 months'; f:=s_from AT TIME ZONE tz; t:=as_of;
    pf:=(s_from - interval '12 months') AT TIME ZONE tz; pt:=f; bucket:='MONTH'; step:=interval '1 month';
  ELSE
    f:='-infinity'; t:=as_of; pf:=NULL; pt:=NULL; bucket:='MONTH'; step:=interval '1 month';
    SELECT date_trunc('month', min(x)) INTO first_local FROM (
      SELECT min(r.received_on)::timestamp AS x FROM hon.invoice_payment_records r WHERE r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL
      UNION ALL SELECT min(coalesce(p.reconciled_at, p.initiated_at) AT TIME ZONE tz) FROM hon.payment_attempts p
        WHERE p.organization_id=org AND p.school_id=school AND p.state='SUCCEEDED'
      UNION ALL SELECT min(m.refunded_on)::timestamp FROM hon.membership_refund_records m WHERE m.organization_id=org AND m.school_id=school) e;
    s_from:=greatest(coalesce(first_local, month_start), month_start - interval '35 months');
    truncated:=first_local IS NOT NULL AND first_local < s_from;
  END IF;

  -- Income per bucket. Bucket starts come from a bounded 0..35 series (at most 36 months, 31 days or 13 weeks).
  SELECT coalesce(jsonb_agg(jsonb_build_object('start', to_char(b.b_from, 'YYYY-MM-DD'),
      'income', hon.school_dashboard_income(org, school, tz, b.b_from AT TIME ZONE tz, least((b.b_from + step) AT TIME ZONE tz, t))) ORDER BY b.b_from), '[]'::jsonb)
    INTO series
  FROM (SELECT s_from + step * g AS b_from FROM generate_series(0, 35) g) b
  WHERE b.b_from AT TIME ZONE tz < t;

  WITH active AS (SELECT DISTINCT m.participant FROM hon.school_dashboard_members(org, school) m
      WHERE m.started <= as_of AND (m.ended IS NULL OR m.ended > as_of)),
    ranked AS (SELECT a.participant, c.id AS curriculum_id, btrim(c.name) AS curriculum, r.id AS rank_id, btrim(r.name) AS rank,
        CASE WHEN r.display_color ~* '^#[0-9a-f]{3,8}$' THEN r.display_color END AS display_color, r.progression_order
      FROM active a JOIN hon.student_profiles p ON p.person_id=a.participant AND p.organization_id=org AND p.school_id=school
      JOIN hon.student_curriculum_enrollments e ON e.student_profile_id=p.id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE'
      JOIN hon.curriculum_ranks r ON r.id=e.current_rank_id AND r.organization_id=org AND r.school_id=school
      JOIN hon.curricula c ON c.id=e.curriculum_id AND c.organization_id=org AND c.school_id=school),
    groups AS (SELECT curriculum_id, curriculum, rank_id, rank, display_color, progression_order, count(DISTINCT participant) AS n
      FROM ranked GROUP BY curriculum_id, curriculum, rank_id, rank, display_color, progression_order
      ORDER BY curriculum, curriculum_id, progression_order LIMIT 100)
  SELECT jsonb_build_object('students', (SELECT count(*) FROM active),
      'unranked', (SELECT count(*) FROM active a WHERE NOT EXISTS(SELECT 1 FROM ranked r WHERE r.participant=a.participant)),
      'truncated', (SELECT count(*) FROM (SELECT 1 FROM ranked GROUP BY curriculum_id, rank_id) q) > 100,
      'ranks', coalesce((SELECT jsonb_agg(jsonb_build_object('curriculumId', g.curriculum_id, 'curriculum', g.curriculum, 'rankId', g.rank_id, 'rank', g.rank,
        'color', g.display_color, 'order', g.progression_order, 'students', g.n) ORDER BY g.curriculum, g.curriculum_id, g.progression_order) FROM groups g), '[]'::jsonb))
    INTO belts;

  WITH stages AS (SELECT p.id AS pipeline_id, btrim(p.name) AS pipeline, st.id AS stage_id, btrim(st.name) AS stage, st.position, count(*) AS n
      FROM hon.crm_leads l JOIN hon.crm_pipeline_stages st ON st.id=l.pipeline_stage_id AND st.organization_id=org AND st.school_id=school
      JOIN hon.crm_pipelines p ON p.id=st.pipeline_id AND p.organization_id=org AND p.school_id=school
      WHERE l.organization_id=org AND l.school_id=school AND l.status='OPEN'
      GROUP BY p.id, btrim(p.name), st.id, btrim(st.name), st.position ORDER BY 2, 1, st.position LIMIT 50)
  SELECT jsonb_build_object('open', (SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.status='OPEN'),
      'stages', coalesce((SELECT jsonb_agg(jsonb_build_object('pipelineId', x.pipeline_id, 'pipeline', x.pipeline, 'stageId', x.stage_id, 'stage', x.stage,
        'position', x.position, 'leads', x.n) ORDER BY x.pipeline, x.pipeline_id, x.position) FROM stages x), '[]'::jsonb))
    INTO pipeline;

  RETURN jsonb_build_object('schoolId', school, 'schoolName', s.name, 'timezone', tz, 'range', rng,
    'generatedAt', to_char(as_of AT TIME ZONE 'UTC', utc),
    'from', CASE WHEN f = '-infinity' THEN NULL ELSE to_char(f AT TIME ZONE 'UTC', utc) END, 'to', to_char(t AT TIME ZONE 'UTC', utc),
    'previous', CASE WHEN pf IS NULL THEN NULL ELSE jsonb_build_object('from', to_char(pf AT TIME ZONE 'UTC', utc), 'to', to_char(pt AT TIME ZONE 'UTC', utc),
      'kpis', hon.school_dashboard_kpis(org, school, tz, pf, pt)) END,
    'kpis', hon.school_dashboard_kpis(org, school, tz, f, t),
    'series', jsonb_build_object('bucket', bucket, 'truncated', truncated, 'points', series),
    'belts', belts, 'pipeline', pipeline);
END $$;

REVOKE ALL ON FUNCTION hon.school_dashboard_members(uuid,uuid), hon.school_dashboard_income(uuid,uuid,text,timestamptz,timestamptz),
  hon.school_dashboard_kpis(uuid,uuid,text,timestamptz,timestamptz), hon.read_school_reports_dashboard(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_reports_dashboard(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
