BEGIN;

-- 0304 HQ executive facts: Ryan and Olivia also see HON OS schedule billing (review follow-up to 0264).
--
-- 0264 gave Ryan (revenue) and Olivia (finance) only the v1 records (saas_subscriptions, saas_invoices). HON OS schools
-- subscribe through the 0230 schedule binding with one locked MONTHLY or ANNUAL price, and their access comes from 0235
-- (activation_source SCHEDULE_BINDING), so those schools were missing and annual prices were never counted. This migration
-- redefines only hon.hq_hon_agent_facts, starting from the 0264 body: every other agent's facts are unchanged.
--   * Ryan adds saasScheduleBindings (counts by status, ACTIVE by interval, ACTIVE monthly and annual list totals kept
--     separate, activated this month), counts v1 LIFETIME subscriptions, and splits PAYMENT_ACTIVE access by source.
--   * Olivia adds saasSchedulePaidPeriods (verified test-mode paid periods recorded this month: count, by interval, sum).
-- Counts and sums only: no organization, school, binding, invoice or provider reference is read into a prompt. Nothing is
-- written; the permission mapping, ask path, budget and concealment are untouched.

CREATE OR REPLACE FUNCTION hon.hq_hon_agent_facts(p_subject text, p_agent text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE now_at timestamptz := clock_timestamp(); month_start timestamptz := date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  facts jsonb;
BEGIN
  IF hon.hq_hon_agent_permission(p_agent) IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF p_agent = 'hon' THEN
    RETURN jsonb_build_object('hqOverview', hon.read_hq_platform_overview(p_subject) - 'callerHqRole',
      'hqAiTextBudget', hon.hq_hon_budget_json(hon.hq_hon_period(now_at)) - ARRAY['setBy','setAt','version']);
  END IF;
  CASE p_agent
  WHEN 'chase' THEN
    SELECT jsonb_build_object('hqMarketingCampaigns', jsonb_build_object(
        'byStatus', hon.hq_hon_counts(ARRAY['DRAFT','ACTIVE','PAUSED','ARCHIVED'], array_agg(c.status)),
        'runningToday', count(*) FILTER (WHERE c.status = 'ACTIVE' AND c.starts_on <= (now_at AT TIME ZONE 'UTC')::date
          AND (c.ends_on IS NULL OR c.ends_on >= (now_at AT TIME ZONE 'UTC')::date)),
        'endingWithin14Days', count(*) FILTER (WHERE c.status = 'ACTIVE' AND c.ends_on BETWEEN (now_at AT TIME ZONE 'UTC')::date
          AND (now_at AT TIME ZONE 'UTC')::date + 14),
        'plannedBudgetActiveMinor', coalesce(sum(c.planned_budget_minor) FILTER (WHERE c.status = 'ACTIVE'), 0),
        'currency', 'USD'),
      'hqCreativeBudget', hon.hq_creative_budget_json(hon.hq_creative_period(now_at)) - ARRAY['setBy','setAt','version'])
    INTO facts FROM hon.hq_marketing_campaigns c;
  WHEN 'mia' THEN
    SELECT jsonb_build_object('hqSupportCases', jsonb_build_object(
        'byStatus', hon.hq_hon_counts(ARRAY['OPEN','WAITING_ON_SCHOOL','RESOLVED','CLOSED'], array_agg(s.status)),
        'openByPriority', hon.hq_hon_counts(ARRAY['LOW','NORMAL','HIGH','URGENT'],
          array_agg(s.priority) FILTER (WHERE s.status IN ('OPEN','WAITING_ON_SCHOOL'))),
        'openOlderThan7Days', count(*) FILTER (WHERE s.status IN ('OPEN','WAITING_ON_SCHOOL') AND s.opened_at < now_at - interval '7 days'),
        'openedThisMonth', count(*) FILTER (WHERE s.opened_at >= month_start),
        'closedThisMonth', count(*) FILTER (WHERE s.closed_at >= month_start)))
    INTO facts FROM hon.hq_support_cases s;
  WHEN 'ethan' THEN
    facts := jsonb_build_object('hqAiPlatform', jsonb_build_object(
        'providerConnections', (SELECT coalesce(jsonb_object_agg(p.provider_id, p.state), '{}'::jsonb) FROM hon.hq_ai_provider_connections p),
        'activeTextModels', (SELECT count(*) FROM hon.hq_ai_model_catalog c WHERE c.active AND 'TEXT' = ANY(c.capabilities)
          AND c.effective_from <= now_at AND (c.effective_until IS NULL OR now_at < c.effective_until)),
        'platformPausesActive', (SELECT hon.hq_hon_counts(ARRAY['AGENT_INFERENCE','CREATIVE_MEDIA','ALL'], array_agg(p.spend_class))
          FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND p.organization_id IS NULL),
        'schoolPausesActive', (SELECT count(*) FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND p.organization_id IS NOT NULL)),
      'hqAiTextBudget', hon.hq_hon_budget_json(hon.hq_hon_period(now_at)) - ARRAY['setBy','setAt','version'],
      'hqCreativeBudget', hon.hq_creative_budget_json(hon.hq_creative_period(now_at)) - ARRAY['setBy','setAt','version']);
  WHEN 'olivia' THEN
    facts := jsonb_build_object(
      'saasInvoices', (SELECT jsonb_build_object(
          'byStatus', hon.hq_hon_counts(ARRAY['DRAFT','ISSUED','VOID'], array_agg(i.status)),
          'issuedThisMonth', count(*) FILTER (WHERE i.status = 'ISSUED' AND i.issued_at >= month_start),
          'issuedTotalThisMonthMinor', coalesce(sum(i.total_minor) FILTER (WHERE i.status = 'ISSUED' AND i.issued_at >= month_start), 0),
          'currency', 'USD') FROM hon.saas_invoices i),
      'saasRefundRequests', (SELECT jsonb_build_object(
          'byStatus', hon.hq_hon_counts(ARRAY['REQUESTED','APPROVED','DENIED','REFUND_EVIDENCED'], array_agg(r.status)),
          'awaitingDecision', count(*) FILTER (WHERE r.status = 'REQUESTED'),
          'requestedOpenMinor', coalesce(sum(r.requested_amount_minor) FILTER (WHERE r.status = 'REQUESTED'), 0),
          'currency', 'USD') FROM hon.saas_refund_requests r),
      -- 0304: verified schedule payments (test-mode provider evidence) recorded this month, by the binding's interval.
      'saasSchedulePaidPeriods', (SELECT jsonb_build_object(
          'recordedThisMonth', count(*) FILTER (WHERE p.recorded_at >= month_start),
          'recordedThisMonthByInterval', hon.hq_hon_counts(ARRAY['MONTHLY','ANNUAL'],
            array_agg(b.requirements->>'billingInterval') FILTER (WHERE p.recorded_at >= month_start)),
          'recordedThisMonthMinor', coalesce(sum(p.amount_minor) FILTER (WHERE p.recorded_at >= month_start), 0),
          'currency', 'USD') FROM hon.saas_schedule_paid_periods p JOIN hon.saas_schedule_bindings b ON b.id = p.binding_id),
      'hqAiTextBudget', hon.hq_hon_budget_json(hon.hq_hon_period(now_at)) - ARRAY['setBy','setAt','version'],
      'note', 'Payments are not collected by HON OS yet: invoices and schedule paid periods are test-mode records only and refunds are never executed here.');
  WHEN 'ryan' THEN
    facts := jsonb_build_object(
      'saasSubscriptions', (SELECT jsonb_build_object(
          'byStatus', hon.hq_hon_counts(ARRAY['PENDING_ACTIVATION','IN_SERVICE','SUSPENDED','VOIDED'], array_agg(s.status)),
          'inServiceByPlan', coalesce((SELECT jsonb_object_agg(x.plan_code, x.n) FROM (SELECT plan_code, count(*) n FROM hon.saas_subscriptions
            WHERE status = 'IN_SERVICE' GROUP BY plan_code) x), '{}'::jsonb),
          'inServiceByOffer', coalesce((SELECT jsonb_object_agg(coalesce(x.offer_kind, 'NONE'), x.n) FROM (SELECT offer_kind, count(*) n
            FROM hon.saas_subscriptions WHERE status = 'IN_SERVICE' GROUP BY offer_kind) x), '{}'::jsonb),
          'recordedThisMonth', count(*) FILTER (WHERE s.created_at >= month_start),
          'inServiceMonthlyListMinor', coalesce(sum(s.price_minor) FILTER (WHERE s.status = 'IN_SERVICE' AND s.billing_interval = 'MONTHLY'), 0),
          'inServiceLifetime', count(*) FILTER (WHERE s.status = 'IN_SERVICE' AND s.billing_interval = 'LIFETIME'),
          'currency', 'USD') FROM hon.saas_subscriptions s),
      -- 0304: HON OS schools subscribe through the 0230 schedule binding (one locked price, MONTHLY or ANNUAL), not v1 rows.
      'saasScheduleBindings', (SELECT jsonb_build_object(
          'byStatus', hon.hq_hon_counts(ARRAY['PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW','EXPIRED_UNPAID',
            'VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT'], array_agg(b.status)),
          'activeByInterval', hon.hq_hon_counts(ARRAY['MONTHLY','ANNUAL'], array_agg(b.requirements->>'billingInterval') FILTER (WHERE b.status = 'ACTIVE')),
          'activeMonthlyListMinor', coalesce(sum((b.requirements->>'lockedPriceMinor')::bigint)
            FILTER (WHERE b.status = 'ACTIVE' AND b.requirements->>'billingInterval' = 'MONTHLY'), 0),
          'activeAnnualListMinor', coalesce(sum((b.requirements->>'lockedPriceMinor')::bigint)
            FILTER (WHERE b.status = 'ACTIVE' AND b.requirements->>'billingInterval' = 'ANNUAL'), 0),
          'activatedThisMonth', count(*) FILTER (WHERE b.activated_at >= month_start),
          'currency', 'USD') FROM hon.saas_schedule_bindings b),
      'saasAccessStates', (SELECT jsonb_build_object(
          'byState', hon.hq_hon_counts(ARRAY['AWAITING_FIRST_PAYMENT','PAYMENT_ACTIVE'], array_agg(a.state)),
          'paymentActiveBySource', hon.hq_hon_counts(ARRAY['V1_CHECKOUT','SCHEDULE_BINDING'],
            array_agg(coalesce(a.activation_source, 'V1_CHECKOUT')) FILTER (WHERE a.state = 'PAYMENT_ACTIVE'))) FROM hon.saas_access_states a),
      'note', 'Charges are not enabled: list prices are recorded plan prices, not collected revenue. Annual list prices are per year, not per month; v1 subscriptions and schedule bindings are separate records that may cover the same school, so never add their counts together.');
  WHEN 'sophia' THEN
    facts := jsonb_build_object(
      'organizations', (SELECT jsonb_build_object('total', count(*),
          'byStatus', coalesce((SELECT jsonb_object_agg(x.status, x.n) FROM (SELECT status::text status, count(*) n FROM hon.organizations GROUP BY 1) x), '{}'::jsonb),
          'createdThisMonth', count(*) FILTER (WHERE o.created_at >= month_start)) FROM hon.organizations o),
      'hqOnboardingRequests', (SELECT jsonb_build_object(
          'byStatus', hon.hq_hon_counts(ARRAY['IN_PROGRESS','COMPLETED'], array_agg(r.status)),
          'inProgressOlderThan1Day', count(*) FILTER (WHERE r.status = 'IN_PROGRESS' AND r.created_at < now_at - interval '1 day'),
          'completedThisMonth', count(*) FILTER (WHERE r.status = 'COMPLETED' AND r.completed_at >= month_start)) FROM hon.hq_onboarding_requests r),
      'saasAccessExceptions', (SELECT jsonb_build_object(
          'activeNow', count(*) FILTER (WHERE e.status = 'GRANTED' AND e.starts_at <= now_at AND e.expires_at > now_at),
          'scheduled', count(*) FILTER (WHERE e.status = 'GRANTED' AND e.starts_at > now_at),
          'expiringWithin14Days', count(*) FILTER (WHERE e.status = 'GRANTED' AND e.expires_at > now_at AND e.expires_at <= now_at + interval '14 days'))
        FROM hon.saas_access_exceptions e));
  END CASE;
  RETURN facts;
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.hq_hon_agent_facts(text,text) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.hq_hon_agent_facts(text,text) FROM '||quote_ident(r); END LOOP;
END $$;

COMMIT;
