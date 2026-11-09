BEGIN;

-- 0209 (provisional; owner allocates the final number): creative-wallet eligibility for a school with no SaaS subscription.
--
-- Defect (Codex #146, 2026-11-05): an ACTIVE school with no HON OS subscription reading its own creative wallet got
-- 503 SAAS_UNAVAILABLE. hon.saas_creative_eligibility (0202) only assigns its `per` record inside the subscription
-- branch, but its reason CASE and window expression reference per.period_index / period_start / period_end, so
-- PL/pgSQL raised SQLSTATE 55000 ("record \"per\" is not assigned yet") before any reason was returned.
--
-- Correction: replace only this function, byte-identical to 0202 except for one statement that initializes `per`
-- with the same three typed columns hon.saas_allowance_period returns. Same signature, language, volatility,
-- search_path and invoker security; CREATE OR REPLACE keeps the owner and the existing (no runtime) EXECUTE grants.
-- Behaviour for every school that has a subscription is unchanged; a school without one now gets the reason the
-- CASE already intended (PROGRAM_INACTIVE while the program is off, otherwise PAID_ACCESS_REQUIRED /
-- ENTITLEMENT_NOT_IN_EFFECT / HON_OS_SUBSCRIPTION_REQUIRED). 0202 is not edited; no data is written.

CREATE OR REPLACE FUNCTION hon.saas_creative_eligibility(p_school uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE v_org uuid; school_active boolean; s hon.saas_subscriptions%ROWTYPE; st text; acc jsonb; pay jsonb; per record; reason text; paid_through timestamptz;
BEGIN
  -- 0209: give the period record its shape before any branch reads it. A school with no SaaS subscription never
  -- reaches the allowance-period SELECT, and reading per.* while unassigned raised SQLSTATE 55000.
  SELECT NULL::integer AS period_index, NULL::timestamptz AS period_start, NULL::timestamptz AS period_end INTO per;
  SELECT sc.organization_id, sc.status = 'ACTIVE' AND o.status = 'ACTIVE' INTO v_org, school_active
    FROM hon.schools sc JOIN hon.organizations o ON o.id = sc.organization_id WHERE sc.id = p_school;
  IF v_org IS NOT NULL THEN
    SELECT state INTO st FROM hon.saas_access_states WHERE organization_id = v_org;
    acc := hon.saas_organization_access(v_org);
    SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = v_org AND status <> 'VOIDED';
    IF s.id IS NOT NULL THEN
      pay := hon.saas_subscription_payment(s);
      SELECT * INTO per FROM hon.saas_allowance_period(s, p_at);
      paid_through := (pay->>'paidThroughAt')::timestamptz;
    END IF;
  END IF;
  reason := CASE
    WHEN NOT hon.saas_creative_program_active() THEN 'PROGRAM_INACTIVE'
    WHEN v_org IS NULL OR NOT school_active THEN 'SCHOOL_NOT_ACTIVE'
    WHEN st IS DISTINCT FROM 'PAYMENT_ACTIVE' THEN 'PAID_ACCESS_REQUIRED'
    WHEN NOT coalesce((acc#>>'{entitlement,inEffect}')::boolean, false) THEN 'ENTITLEMENT_NOT_IN_EFFECT'
    WHEN s.id IS NULL OR s.source <> 'HON_OS_OFFER' THEN 'HON_OS_SUBSCRIPTION_REQUIRED'
    WHEN s.status <> 'IN_SERVICE' THEN 'SUBSCRIPTION_NOT_IN_SERVICE'
    WHEN pay->>'paymentStatus' <> 'PAID' OR pay->>'paymentVerification' <> 'PROVIDER_VERIFIED' THEN 'VERIFIED_PAYMENT_REQUIRED'
    WHEN per.period_index IS NULL OR p_at < per.period_start OR p_at >= per.period_end THEN 'WINDOW_UNAVAILABLE'
    WHEN s.billing_interval IN ('MONTHLY','ANNUAL') AND (paid_through IS NULL OR per.period_start >= paid_through) THEN 'WINDOW_NOT_PAID'
    WHEN s.billing_interval = 'ANNUAL' AND per.period_start >= s.current_period_end THEN 'WINDOW_NOT_PAID' END;
  RETURN jsonb_build_object('eligible', reason IS NULL, 'reason', reason, 'subscriptionId', s.id,
    'window', CASE WHEN reason IS NULL THEN jsonb_build_object('index', per.period_index, 'startsAt', hon.saas_ts(per.period_start), 'endsAt', hon.saas_ts(per.period_end)) END);
END $$;

COMMIT;
