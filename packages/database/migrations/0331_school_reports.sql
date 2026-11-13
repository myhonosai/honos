BEGIN;

-- R1 (0331, assigned by the coordinator 2026-11-13): standard school reports. Owner (David): "Can we make progress to
-- finish the product?"; the coordinator's brief: attendance, retention, revenue and enrollment reports.
-- One read-only entry point, hon.read_school_reports(subject, input), for the session school only. It returns month by
-- month totals in the school's own time zone for the last 3 to 12 months (default 6; the current month is partial).
-- Counts and money totals only: no names, contact details, people, invoices or payment rows leave this function.
-- Authority: a direct human at the session school with the live school-scoped reporting.view permission (the Command
-- Center and operations report permission), an active school and organization, and an active HON entitlement. HQ,
-- family, student and automated callers are refused. The runtime gains EXECUTE on this one function and nothing else.
-- Definitions (also returned with the report so the page can say exactly what each number means):
--   attendance  classesHeld = sessions not cancelled that started in the month (up to now); checkIns = PRESENT, LATE or
--               MAKEUP records on those sessions; absences = excused or unexcused; studentsAttended = distinct students
--               with a check-in.
--   enrollment  newLeads = leads created; leadsWon = leads marked won; newMemberships = memberships (not drafts) whose
--               term started in the month.
--   retention   a membership counts as a member from its term start until the first of its term end or its recorded
--               cancellation (the 0177/0224 audit row). Paused memberships still count. activeAtStart / activeAtEnd are
--               members at the month's start and at its end (or now); ended = memberships that stopped in the month;
--               retainedFromStart = members at the start who were still members at the end. A cancelled membership
--               with no recorded cancellation time cannot be placed in a month: it is left out and counted once in
--               cancelledWithoutDate.
--   revenue     per currency: billed = invoices created in the month that are not draft or void; recordedPayments =
--               staff-recorded tuition payments (0240) received in the month and not voided; onlinePayments = payment
--               attempts that succeeded in the month; refunds = recorded membership refunds (0224) in the month.
--               Operational totals from HON records, not accounting or provider-settled figures.
-- Nothing is written, sent, charged or scheduled.

-- Cancellation times come from the one audit row each cancellation writes; this keeps the lookup per school bounded.
CREATE INDEX audit_events_membership_cancel_idx ON hon.audit_events (organization_id, school_id, entity_id, occurred_at)
  WHERE action_code = 'billing.membership.cancel' AND result = 'SUCCEEDED' AND entity_type = 'MEMBERSHIP';

-- Direct human at the session school with reporting.view, or an error.
CREATE FUNCTION hon.require_school_reports_actor(subject text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SCHOOL_REPORTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
        AND x.code='reporting.view')
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_REPORTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Month by month totals for one school (private; callers have already proven authority for org/school).
CREATE FUNCTION hon.school_report_periods(org uuid, school uuid, tz text, months integer, as_of timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH bounds AS (
    SELECT to_char(m,'YYYY-MM') AS month, m::date AS first_day, (m + interval '1 month')::date AS next_day,
      (m AT TIME ZONE tz) AS t_from, least(((m + interval '1 month') AT TIME ZONE tz), as_of) AS t_to,
      ((m + interval '1 month') AT TIME ZONE tz) > as_of AS partial
    FROM generate_series(date_trunc('month', as_of AT TIME ZONE tz) - make_interval(months => months - 1),
      date_trunc('month', as_of AT TIME ZONE tz), interval '1 month') m
  ),
  members AS MATERIALIZED (
    SELECT x.term_started_at AS started,
      CASE WHEN c.at IS NULL THEN x.term_ends_at WHEN x.term_ends_at IS NULL THEN c.at ELSE least(c.at, x.term_ends_at) END AS ended
    FROM hon.memberships x
    LEFT JOIN LATERAL (SELECT min(a.occurred_at) AS at FROM hon.audit_events a
      WHERE a.organization_id=org AND a.school_id=school AND a.entity_id=x.id AND a.action_code='billing.membership.cancel'
        AND a.result='SUCCEEDED' AND a.entity_type='MEMBERSHIP') c ON true
    WHERE x.organization_id=org AND x.school_id=school AND x.state<>'DRAFT' AND x.term_started_at IS NOT NULL
      AND NOT (x.state='CANCELLED' AND c.at IS NULL)
  ),
  sessions AS MATERIALIZED (
    SELECT s.id, s.starts_at FROM hon.class_sessions s
    WHERE s.organization_id=org AND s.school_id=school AND s.status<>'CANCELLED'
      AND s.starts_at >= (SELECT min(t_from) FROM bounds) AND s.starts_at < as_of
  ),
  money AS (
    SELECT b.month, z.currency, sum(z.billed) AS billed, sum(z.recorded) AS recorded, sum(z.online) AS online, sum(z.refunds) AS refunds
    FROM bounds b CROSS JOIN LATERAL (
      SELECT i.currency::text AS currency, i.total_minor::bigint AS billed, 0::bigint AS recorded, 0::bigint AS online, 0::bigint AS refunds
        FROM hon.invoices i WHERE i.organization_id=org AND i.school_id=school AND i.status NOT IN ('DRAFT','VOID')
          AND i.created_at >= b.t_from AND i.created_at < b.t_to
      UNION ALL
      SELECT r.currency::text, 0, r.amount_minor, 0, 0 FROM hon.invoice_payment_records r
        WHERE r.organization_id=org AND r.school_id=school AND r.voided_at IS NULL
          AND r.received_on >= b.first_day AND r.received_on < b.next_day AND r.received_on <= (as_of AT TIME ZONE tz)::date
      UNION ALL
      SELECT p.currency::text, 0, 0, p.amount_minor, 0 FROM hon.payment_attempts p
        WHERE p.organization_id=org AND p.school_id=school AND p.state='SUCCEEDED'
          AND coalesce(p.reconciled_at, p.initiated_at) >= b.t_from AND coalesce(p.reconciled_at, p.initiated_at) < b.t_to
      UNION ALL
      SELECT f.currency::text, 0, 0, 0, f.amount_minor FROM hon.membership_refund_records f
        WHERE f.organization_id=org AND f.school_id=school
          AND f.refunded_on >= b.first_day AND f.refunded_on < b.next_day AND f.refunded_on <= (as_of AT TIME ZONE tz)::date
    ) z
    GROUP BY b.month, z.currency
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'month', b.month, 'from', to_char(b.t_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'to', to_char(b.t_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'partial', b.partial,
    'attendance', (SELECT jsonb_build_object(
        'classesHeld', (SELECT count(*) FROM sessions s WHERE s.starts_at >= b.t_from AND s.starts_at < b.t_to),
        'checkIns', count(*) FILTER (WHERE a.status IN ('PRESENT','LATE','MAKEUP')),
        'absences', count(*) FILTER (WHERE a.status IN ('EXCUSED_ABSENCE','UNEXCUSED_ABSENCE')),
        'studentsAttended', count(DISTINCT a.student_profile_id) FILTER (WHERE a.status IN ('PRESENT','LATE','MAKEUP')))
      FROM sessions s JOIN hon.attendance_records a ON a.class_session_id=s.id AND a.organization_id=org AND a.school_id=school
      WHERE s.starts_at >= b.t_from AND s.starts_at < b.t_to),
    'enrollment', jsonb_build_object(
        'newLeads', (SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.created_at >= b.t_from AND l.created_at < b.t_to),
        'leadsWon', (SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.won_at >= b.t_from AND l.won_at < b.t_to),
        'newMemberships', (SELECT count(*) FROM members m WHERE m.started >= b.t_from AND m.started < b.t_to)),
    'retention', (SELECT jsonb_build_object(
        'activeAtStart', count(*) FILTER (WHERE m.started <= b.t_from AND (m.ended IS NULL OR m.ended > b.t_from)),
        'activeAtEnd', count(*) FILTER (WHERE m.started <= b.t_to AND (m.ended IS NULL OR m.ended > b.t_to)),
        'ended', count(*) FILTER (WHERE m.ended > b.t_from AND m.ended <= b.t_to AND m.started < m.ended),
        'retainedFromStart', count(*) FILTER (WHERE m.started <= b.t_from AND (m.ended IS NULL OR m.ended > b.t_to)))
      FROM members m),
    'revenue', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', y.currency, 'billedMinor', y.billed, 'recordedPaymentsMinor', y.recorded,
        'onlinePaymentsMinor', y.online, 'refundsMinor', y.refunds) ORDER BY y.currency) FROM money y WHERE y.month=b.month), '[]'::jsonb)
  ) ORDER BY b.month), '[]'::jsonb) FROM bounds b
$$;

-- The session school's report. Input: {} or { months: 3..12 }.
CREATE FUNCTION hon.read_school_reports(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); tz text; months integer:=6;
  as_of timestamptz:=statement_timestamp(); s hon.schools%ROWTYPE; undated bigint;
BEGIN
  PERFORM hon.require_school_reports_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k<>'months')
    OR (p_input ? 'months' AND (jsonb_typeof(p_input->'months')<>'number' OR (p_input->>'months') !~ '^(3|4|5|6|7|8|9|10|11|12)$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_input ? 'months' THEN months:=(p_input->>'months')::integer; END IF;
  SELECT * INTO s FROM hon.schools x WHERE x.id=school AND x.organization_id=org;
  SELECT n.name INTO tz FROM pg_timezone_names n WHERE n.name=s.timezone;
  IF tz IS NULL THEN RAISE EXCEPTION 'SCHOOL_TIMEZONE_INVALID' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO undated FROM hon.memberships x WHERE x.organization_id=org AND x.school_id=school AND x.state='CANCELLED'
    AND NOT EXISTS(SELECT 1 FROM hon.audit_events a WHERE a.organization_id=org AND a.school_id=school AND a.entity_id=x.id
      AND a.action_code='billing.membership.cancel' AND a.result='SUCCEEDED' AND a.entity_type='MEMBERSHIP');
  RETURN jsonb_build_object('schoolId', school, 'schoolName', s.name, 'timezone', tz, 'months', months,
    'generatedAt', to_char(as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cancelledWithoutDate', undated, 'periods', hon.school_report_periods(org, school, tz, months, as_of));
END $$;

REVOKE ALL ON FUNCTION hon.require_school_reports_actor(text), hon.school_report_periods(uuid,uuid,text,integer,timestamptz),
  hon.read_school_reports(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_reports(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
