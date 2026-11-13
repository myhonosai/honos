BEGIN;

-- B-HQ-3 HQ business numbers (0326, allocated 2026-11-13). One read-only HQ read of HON's own business: contracted
-- recurring revenue at list price, paying schools, schools that started or stopped paying, new schools, public sign-ups
-- and trials, per UTC calendar month.
--
-- Honesty rules (the screen repeats them):
--   * Charges are not enabled. Every amount is a recorded list price (v1 subscription price or the locked price of a HON OS
--     schedule binding), never collected money.
--   * One school counts once. A school with an ACTIVE schedule binding is counted from the binding; otherwise from its
--     newest IN_SERVICE monthly v1 subscription. Annual prices count as price / 12 (rounded to the cent). Lifetime and
--     legacy unpriced records are counted, never added to MRR.
--   * "Stopped paying" is evidence only: a v1 subscription history step from IN_SERVICE to SUSPENDED or VOIDED. HON OS
--     schedule bindings have no recorded cancellation after payment yet, so no churn rate is computed; bindings held for
--     review are reported as a current count.
-- Who may read: an HQ owner, or an HQ operator with hq.billing.manage (the SaaS HQ reader rule), checked before and again
-- after the reads. Nothing is written. No school, person, email or provider reference is returned: counts and sums only.

CREATE FUNCTION hon.hq_business_monthly_minor(p_requirements jsonb) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN jsonb_typeof(p_requirements->'lockedPriceMinor') IS DISTINCT FROM 'number'
      OR (p_requirements->>'lockedPriceMinor') !~ '^[0-9]{1,12}$' THEN NULL
    WHEN p_requirements->>'billingInterval' = 'MONTHLY' THEN (p_requirements->>'lockedPriceMinor')::bigint
    WHEN p_requirements->>'billingInterval' = 'ANNUAL' THEN round((p_requirements->>'lockedPriceMinor')::numeric / 12)::bigint
    ELSE NULL END
$$;

CREATE FUNCTION hon.read_hq_business_numbers(p_subject text, p_months integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE at timestamptz := clock_timestamp(); this_month timestamptz; first_month timestamptz; current jsonb; months jsonb; result jsonb;
BEGIN
  IF p_months IS NULL OR p_months NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  this_month := date_trunc('month', at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  first_month := (date_trunc('month', at AT TIME ZONE 'UTC') - make_interval(months => p_months - 1)) AT TIME ZONE 'UTC';

  -- Current contracted recurring revenue, one record per school.
  WITH bound AS (
    SELECT DISTINCT ON (b.organization_id) b.organization_id AS org, b.requirements->>'billingInterval' AS iv,
      hon.hq_business_monthly_minor(b.requirements) AS eq
    FROM hon.saas_schedule_bindings b WHERE b.status = 'ACTIVE' ORDER BY b.organization_id, b.activated_at DESC, b.id
  ), v1 AS (
    SELECT DISTINCT ON (s.organization_id) s.organization_id AS org, 'MONTHLY'::text AS iv, s.price_minor::bigint AS eq
    FROM hon.saas_subscriptions s WHERE s.status = 'IN_SERVICE' AND s.billing_interval = 'MONTHLY'
      AND NOT EXISTS (SELECT 1 FROM bound WHERE bound.org = s.organization_id)
    ORDER BY s.organization_id, s.service_started_at DESC, s.id
  ), rec AS (SELECT org, iv, eq, 'SCHEDULE_BINDING'::text AS src FROM bound UNION ALL SELECT org, iv, eq, 'V1_SUBSCRIPTION' FROM v1),
  lifetime AS (
    SELECT DISTINCT s.organization_id AS org FROM hon.saas_subscriptions s
    WHERE s.status = 'IN_SERVICE' AND s.billing_interval = 'LIFETIME' AND NOT EXISTS (SELECT 1 FROM rec WHERE rec.org = s.organization_id)
  )
  SELECT jsonb_build_object(
      'mrrMinor', coalesce(sum(rec.eq), 0),
      'arrMinor', coalesce(sum(rec.eq), 0) * 12,
      'payingSchools', count(*) FILTER (WHERE rec.eq IS NOT NULL),
      'payingByInterval', jsonb_build_object('MONTHLY', count(*) FILTER (WHERE rec.eq IS NOT NULL AND rec.iv = 'MONTHLY'),
        'ANNUAL', count(*) FILTER (WHERE rec.eq IS NOT NULL AND rec.iv = 'ANNUAL')),
      'payingBySource', jsonb_build_object('SCHEDULE_BINDING', count(*) FILTER (WHERE rec.eq IS NOT NULL AND rec.src = 'SCHEDULE_BINDING'),
        'V1_SUBSCRIPTION', count(*) FILTER (WHERE rec.eq IS NOT NULL AND rec.src = 'V1_SUBSCRIPTION')),
      'unpricedActiveRecords', count(*) FILTER (WHERE rec.eq IS NULL),
      'lifetimeSchools', (SELECT count(*) FROM lifetime),
      'bindingsNeedingReview', (SELECT count(*) FROM hon.saas_schedule_bindings b WHERE b.status = 'NEEDS_REVIEW'),
      'suspendedSubscriptions', (SELECT count(*) FROM hon.saas_subscriptions s WHERE s.status = 'SUSPENDED'),
      'activeTrials', (SELECT count(*) FROM hon.hon_os_trial_enrollments t WHERE t.starts_at <= at AND t.ends_at > at))
    INTO current FROM rec;

  -- Monthly flows, oldest first; the newest month is month to date.
  WITH m AS (
    SELECT g AS starts, g + interval '1 month' AS ends FROM generate_series(first_month, this_month, interval '1 month') g
  ), paid_start AS (
    SELECT org, min(t) AS first_at FROM (
      SELECT b.organization_id AS org, b.activated_at AS t FROM hon.saas_schedule_bindings b WHERE b.activated_at IS NOT NULL
      UNION ALL
      SELECT s.organization_id, s.service_started_at FROM hon.saas_subscriptions s
      WHERE s.service_started_at IS NOT NULL AND s.billing_interval IN ('MONTHLY','LIFETIME')
      UNION ALL
      -- A voided subscription clears service_started_at; its IN_SERVICE history step still marks when paying began.
      SELECT s.organization_id, h.occurred_at FROM hon.saas_subscription_history h JOIN hon.saas_subscriptions s ON s.id = h.subscription_id
      WHERE h.status = 'IN_SERVICE' AND s.billing_interval IN ('MONTHLY','LIFETIME')) x
    GROUP BY org
  ), stops AS (
    SELECT DISTINCT s.organization_id AS org, h.occurred_at AS t FROM hon.saas_subscription_history h
    JOIN hon.saas_subscription_history prev ON prev.subscription_id = h.subscription_id AND prev.version = h.version - 1
    JOIN hon.saas_subscriptions s ON s.id = h.subscription_id
    WHERE prev.status = 'IN_SERVICE' AND h.status IN ('SUSPENDED','VOIDED') AND s.billing_interval IN ('MONTHLY','LIFETIME')
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(m.starts AT TIME ZONE 'UTC', 'YYYY-MM'),
      'monthToDate', m.starts = this_month,
      'newSchools', (SELECT count(*) FROM hon.organizations o WHERE o.created_at >= m.starts AND o.created_at < m.ends),
      'publicSignups', (SELECT count(*) FROM hon.hon_os_school_registrations r WHERE r.registered_at >= m.starts AND r.registered_at < m.ends),
      'trialsStarted', (SELECT count(*) FROM hon.hon_os_trial_enrollments t WHERE t.starts_at >= m.starts AND t.starts_at < m.ends),
      'newPayingSchools', (SELECT count(*) FROM paid_start p WHERE p.first_at >= m.starts AND p.first_at < m.ends),
      'trialConversions', (SELECT count(*) FROM paid_start p JOIN hon.hon_os_trial_enrollments t ON t.organization_id = p.org
        WHERE p.first_at >= m.starts AND p.first_at < m.ends AND p.first_at >= t.starts_at),
      'stoppedPayingSchools', (SELECT count(DISTINCT st.org) FROM stops st WHERE st.t >= m.starts AND st.t < m.ends))
    ORDER BY m.starts), '[]'::jsonb)
    INTO months FROM m;

  result := jsonb_build_object('current', current, 'months', months, 'monthsRequested', p_months, 'currency', 'USD',
    'chargesEnabled', false, 'churnRateAvailable', false, 'asOf', hon.saas_ts(at));
  -- 0206 rule: the reader must still hold authority after the reads.
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hq_business_monthly_minor(jsonb)','read_hq_business_numbers(text,integer)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_hq_business_numbers(text,integer) TO hon_runtime;
  END IF;
END $$;

COMMIT;
