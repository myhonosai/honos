BEGIN;

-- 0264 HQ executives behind HQ HON (B2).
--
-- The six HQ executives of the locked HQ catalog (packages/contracts hq-overview.ts) answer read-only questions in the
-- HQ HON conversation (0263): Chase (growth), Mia (customer success), Ethan (product), Olivia (finance), Ryan (revenue)
-- and Sophia (operations). Each reads aggregate HQ facts under one HQ permission and is paid from the same HQ AI text
-- budget, through the same S4 path (pause gate, server-chosen route, fixed reservation, measured settlement, owner
-- review). Nothing here changes how a turn is asked, recorded, resolved or concealed: this migration only widens the two
-- turn checks and redefines the two plug-in points 0263 left for it.
--
-- Facts are counts and sums only. No organization, school, person, case subject, invoice number or note is ever read
-- into a prompt. Nothing reads or writes a school's AI budget, ai_usage_ledger, ai_invocation_plans or a school
-- conversation. Executives read and recommend only: they never send, change, approve, pause or charge anything.

ALTER TABLE hon.hq_hon_turns DROP CONSTRAINT hq_hon_turns_agent_key_check;
ALTER TABLE hon.hq_hon_turns ADD CONSTRAINT hq_hon_turns_agent_key_check
  CHECK (agent_key IN ('hon','chase','mia','ethan','olivia','ryan','sophia'));
ALTER TABLE hon.hq_hon_turns DROP CONSTRAINT hq_hon_turns_source_permissions_check;
ALTER TABLE hon.hq_hon_turns ADD CONSTRAINT hq_hon_turns_source_permissions_check
  CHECK (cardinality(source_permissions) BETWEEN 1 AND 5 AND array_position(source_permissions, NULL) IS NULL
    AND source_permissions <@ ARRAY['hq.dashboard.view','hq.marketing.read','hq.support.manage','hq.billing.manage','hq.onboarding.manage']::text[]);

-- An HQ operator who may manage HQ marketing may also read it (0252 rule), so hq.marketing.manage satisfies
-- hq.marketing.read here. Every other permission is held exactly. The HQ owner holds all of them; HQ support staff,
-- school roles, family access and lapsed grants hold none (unchanged from 0263).
CREATE OR REPLACE FUNCTION hon.hq_hon_permission_held(p_principal uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.principals p WHERE p.id = p_principal AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals o WHERE o.user_id = p.user_id AND o.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (g.hq_role = 'HON_HQ_OWNER' OR (g.hq_role = 'HON_HQ_OPERATOR' AND (p_permission = ANY(g.permission_codes)
        OR (p_permission = 'hq.marketing.read' AND 'hq.marketing.manage' = ANY(g.permission_codes))))))
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp())))
$$;

-- The one HQ permission each agent's facts need.
CREATE OR REPLACE FUNCTION hon.hq_hon_agent_permission(p_agent text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE p_agent
    WHEN 'hon' THEN 'hq.dashboard.view'
    WHEN 'chase' THEN 'hq.marketing.read'
    WHEN 'mia' THEN 'hq.support.manage'
    WHEN 'ethan' THEN 'hq.billing.manage'
    WHEN 'olivia' THEN 'hq.billing.manage'
    WHEN 'ryan' THEN 'hq.billing.manage'
    WHEN 'sophia' THEN 'hq.onboarding.manage' END
$$;

-- Counts of p_values keyed by each allowed value, zero-filled, so the shape never depends on which rows exist.
CREATE FUNCTION hon.hq_hon_counts(p_allowed text[], p_values text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_object_agg(a, (SELECT count(*) FROM unnest(coalesce(p_values, ARRAY[]::text[])) v WHERE v = a)), '{}'::jsonb)
  FROM unnest(p_allowed) a
$$;

-- The agent's facts, read with the asker's own authority: ask_hq_hon checked the agent's permission before this call and
-- checks it again after the turn is written. Aggregate counts and sums only.
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
      'hqAiTextBudget', hon.hq_hon_budget_json(hon.hq_hon_period(now_at)) - ARRAY['setBy','setAt','version'],
      'note', 'Payments are not collected by HON OS yet: invoices are records only and refunds are never executed here.');
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
          'currency', 'USD') FROM hon.saas_subscriptions s),
      'saasAccessStates', (SELECT hon.hq_hon_counts(ARRAY['AWAITING_FIRST_PAYMENT','PAYMENT_ACTIVE'], array_agg(a.state)) FROM hon.saas_access_states a),
      'note', 'Charges are not enabled: list prices are recorded plan prices, not collected revenue.');
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

-- The conversation read adds availableAgents: the agents this reader may ask now, in catalog order (HON always first).
-- The rest of the read is 0263's, unchanged.
CREATE OR REPLACE FUNCTION hon.read_hq_hon_conversation(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; owner boolean; result jsonb;
BEGIN
  actor := hon.require_hq_hon_actor(p_subject, false);
  owner := hon.hq_hon_owner_eligible(actor);
  result := jsonb_build_object('budget', hon.hq_hon_budget_json(hon.hq_hon_period(clock_timestamp())),
    'turns', (SELECT coalesce(jsonb_agg(hon.hq_hon_turn_json(t, actor) ORDER BY t.created_at DESC, t.id DESC), '[]'::jsonb)
      FROM (SELECT * FROM hon.hq_hon_turns WHERE asked_by = actor ORDER BY created_at DESC, id DESC LIMIT 50) t),
    'budgetHistory', CASE WHEN owner THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('periodStart', to_char(h.period_start, 'YYYY-MM-DD'),
        'version', h.version, 'creditCap', h.credit_cap, 'previousCap', h.previous_cap, 'reason', h.reason,
        'actor', hon.hq_marketing_person_json(h.actor_principal_id), 'recordedAt', hon.saas_ts(h.recorded_at))
        ORDER BY h.recorded_at DESC, h.period_start DESC, h.version DESC), '[]'::jsonb)
      FROM (SELECT * FROM hon.hq_hon_budget_changes ORDER BY recorded_at DESC, period_start DESC, version DESC LIMIT 12) h) ELSE '[]'::jsonb END,
    'underReview', CASE WHEN owner THEN (SELECT coalesce(jsonb_agg(hon.hq_hon_turn_json(t, actor) ORDER BY t.created_at DESC, t.id DESC), '[]'::jsonb)
      FROM (SELECT * FROM hon.hq_hon_turns WHERE status = 'UNDER_REVIEW'
        OR (status = 'ANSWERING' AND created_at <= clock_timestamp() - interval '120 seconds') ORDER BY created_at DESC, id DESC LIMIT 50) t) ELSE '[]'::jsonb END,
    'availableAgents', (SELECT coalesce(jsonb_agg(a.k ORDER BY a.n), '[]'::jsonb)
      FROM unnest(ARRAY['hon','chase','mia','ethan','olivia','ryan','sophia']) WITH ORDINALITY a(k, n)
      WHERE hon.hq_hon_permission_held(actor, hon.hq_hon_agent_permission(a.k))),
    'limit', 50, 'viewer', hon.hq_marketing_person_json(actor) || jsonb_build_object('isOwner', owner),
    'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_hon_actor(p_subject, false);
  RETURN result;
END $$;

DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hq_hon_permission_held(uuid,text)','hq_hon_agent_permission(text)','hq_hon_counts(text[],text[])',
    'hq_hon_agent_facts(text,text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
END $$;

COMMIT;
