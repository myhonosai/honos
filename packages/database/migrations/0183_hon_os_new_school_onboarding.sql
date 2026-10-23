BEGIN;

-- HON OS new-school onboarding (owner decision D7). A brand-new school, awaiting its first payment under B6A, buys one
-- HQ-published HON OS offer in TEST MODE and its verified payment activates the HON OS (COMPLETE) entitlement.
-- - Registration: hon.initialize_saas_hon_os_school_account (private, never runtime-executable) creates the organization,
--   school, OWNER role and the verified owner's grant, with the entitlement held SUSPENDED and the access state
--   AWAITING_FIRST_PAYMENT, in one transaction. The public sign-up that verifies the identity and records terms
--   acceptance must call it through a separately reviewed path; nothing here exposes it.
-- - Checkout: an organization awaiting its first payment (only while paid access is ACTIVE) may open a HON OS checkout
--   without an ACTIVE COMPLETE entitlement. Every other 0182 rule is unchanged: published and on sale, supported terms,
--   no live subscription or open checkout, eligibility, sale limit and the one founder pool under one lock.
-- - Activation: the verified payment records the subscription at the accepted offer and then runs the B6A first-payment
--   step in the same transaction (entitlement -> COMPLETE, ACTIVE; access state PAYMENT_ACTIVE). Any mismatch is held
--   for HQ review and never partially granted. A payment held only because paid access was inactive can be retried by
--   the HQ owner, re-checking expiry, stop-sales, the sale limit and the founder pool at the retry.
-- - No AI credits are opened at HON OS activation; credit grants stay with the INACTIVE credit program and its policy.
-- - INACTIVE: paid access stays pinned INACTIVE (0170 CHECK), so nothing here changes any real organization until a
--   reviewed activation migration. Legacy Core/Complete checkout and the B6A legacy path behave exactly as before.
-- Number: 0179 is reserved for E1b-2 and 0180 for E1c.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS new-school onboarding requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS new-school onboarding requires a restricted runtime';
  END IF;
END $$;

-- ---------- vocabularies ----------
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (action_code IN ('saas.catalog.draft','saas.catalog.publish',
  'saas.founder.reserve','saas.founder.release','saas.subscription.record','saas.subscription.command',
  'saas.invoice.draft','saas.invoice.command','saas.payment.evidence',
  'saas.credits.program','saas.credits.cost_evidence','saas.credits.pricing_draft','saas.credits.pricing_publish',
  'saas.credits.allowance','saas.credits.reserve','saas.credits.settle','saas.credits.resolve',
  'saas.refund.request','saas.refund.decide','saas.rewards.fulfillment','saas.rewards.apply','saas.rewards.credit_apply','saas.rewards.alert_resolve',
  'saas.payments.program','saas.checkout.create','saas.checkout.attach','saas.checkout.cancel','saas.checkout.sweep','saas.provider.event',
  'saas.access.await','saas.access.retry',
  'saas.offers.draft','saas.offers.revise','saas.offers.discard','saas.offers.publish','saas.offers.stop_sales',
  'saas.checkout.create_hon_os','saas.access.initialize'));
ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published',
  'saas.founder.reserved','saas.founder.released','saas.subscription.recorded','saas.subscription.changed',
  'saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded',
  'saas.credits.program_changed','saas.credits.cost_recorded','saas.credits.pricing_drafted','saas.credits.pricing_published',
  'saas.credits.allowance_changed','saas.credits.reserved','saas.credits.settled','saas.credits.resolved',
  'saas.refund.requested','saas.refund.decided','saas.rewards.fulfillment_changed','saas.rewards.applied','saas.rewards.credit_applied',
  'saas.rewards.alert_resolved','saas.payments.program_changed','saas.checkout.created','saas.checkout.changed','saas.checkouts.swept',
  'saas.provider.event_recorded','saas.access.awaiting','saas.access.retried',
  'saas.offers.drafted','saas.offers.revised','saas.offers.discarded','saas.offers.published','saas.offers.sales_stopped',
  'saas.access.initialized'));

-- A HON OS checkout of a school awaiting its first payment can be held because paid access became inactive before the
-- payment (ACCESS_PROGRAM_INACTIVE), exactly like a legacy one; the rest of the 0182 shape is unchanged.
ALTER TABLE hon.saas_checkout_sessions DROP CONSTRAINT saas_checkout_sessions_source_shape_check;
ALTER TABLE hon.saas_checkout_sessions ADD CONSTRAINT saas_checkout_sessions_source_shape_check CHECK (coalesce(CASE WHEN hon_os_offer_id IS NULL THEN
    catalog_id IS NOT NULL AND offer_id IS NOT NULL AND offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME')
    AND billing_interval = CASE WHEN offer_kind = 'FOUNDER_LIFETIME' THEN 'LIFETIME' ELSE 'MONTHLY' END
    AND offer_set_id IS NULL AND accepted_offer IS NULL AND accepted_offer_digest IS NULL AND provider_recurring IS NULL
  ELSE catalog_id IS NULL AND offer_id IS NULL AND offer_set_id IS NOT NULL AND plan_code = 'COMPLETE' AND requester_kind = 'SCHOOL_OWNER'
    AND billing_interval = hon.saas_hon_os_billing_interval(offer_kind)
    AND provider_recurring IS NOT NULL AND provider_recurring = CASE billing_interval WHEN 'MONTHLY' THEN 'MONTH' WHEN 'LIFETIME' THEN 'NONE' ELSE provider_recurring END
    AND (billing_interval <> 'ANNUAL' OR provider_recurring IN ('YEAR','NONE'))
    AND jsonb_typeof(accepted_offer) = 'object' AND accepted_offer->>'offerId' = hon_os_offer_id::text
    AND accepted_offer->>'offerSetId' = offer_set_id::text AND accepted_offer->>'offerKind' = offer_kind
    AND accepted_offer->'priceMinor' = to_jsonb(amount_minor) AND accepted_offer->>'recurringBilling' = provider_recurring
    AND accepted_offer_digest ~ '^[0-9a-f]{64}$' END, false));

-- ---------- registration (private) ----------
-- Billing-side initialization of a brand-new school for an owner identity the sign-up has already verified. Never
-- runtime-executable: the owner becomes the OWNER of exactly one new organization and school, which has no access
-- (entitlement held SUSPENDED) until a verified first payment activates it.
CREATE FUNCTION hon.initialize_saas_hon_os_school_account(p_owner_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE owner_id uuid; fp text; replay jsonb; at timestamptz := clock_timestamp(); v_org uuid; v_school uuid; v_role uuid; nxt jsonb;
  v_slug text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['displayName','legalName','schoolName','schoolSlug','timezone']
    OR EXISTS (SELECT 1 FROM jsonb_each(p) e WHERE jsonb_typeof(e.value) <> 'string' OR length(e.value #>> '{}') NOT BETWEEN 1 AND 120
      OR btrim(e.value #>> '{}') <> e.value #>> '{}')
    OR (p->>'schoolSlug') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(p->>'schoolSlug') > 63
    OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p->>'timezone') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p_owner_subject IS NULL OR length(p_owner_subject) NOT BETWEEN 1 AND 200 OR btrim(p_owner_subject) <> p_owner_subject THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Exactly one active human principal for the verified identity.
  SELECT p2.id INTO owner_id FROM hon.users u JOIN hon.principals p2 ON p2.user_id = u.id
    WHERE u.external_subject = p_owner_subject AND p2.is_active AND p2.principal_type = 'HUMAN_USER'
      AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  fp := hon.saas_fingerprint(ARRAY['access.initialize', p::text]);
  replay := hon.saas_claim_request(owner_id, p_key, 'saas.access.initialize', fp, p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT hon.saas_access_program_active() THEN RAISE EXCEPTION 'SAAS_ACCESS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  -- One registration per identity, even under concurrent requests with different keys.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.registration:' || owner_id::text, 0));
  -- The registering identity must not already hold any school, HQ or family access.
  IF EXISTS (SELECT 1 FROM hon.principal_role_grants g WHERE g.principal_id = owner_id AND g.revoked_at IS NULL
      AND (g.effective_until IS NULL OR g.effective_until > at))
    OR EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = owner_id)
    OR EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = owner_id AND (f.effective_until IS NULL OR f.effective_until > at)) THEN
    RAISE EXCEPTION 'SAAS_OWNER_NOT_ELIGIBLE' USING ERRCODE = '23514';
  END IF;
  v_slug := p->>'schoolSlug';
  INSERT INTO hon.organizations(legal_name, display_name, created_at, updated_at) VALUES (p->>'legalName', p->>'displayName', at, at) RETURNING id INTO v_org;
  -- No access before the first payment: the entitlement is held SUSPENDED (every status-gated function refuses it).
  -- The tier is the HON OS tier; the verified payment sets it again when it activates the entitlement.
  INSERT INTO hon.organization_entitlements(organization_id, tier, status, effective_from, updated_at) VALUES (v_org, 'COMPLETE', 'SUSPENDED', at, at);
  INSERT INTO hon.schools(organization_id, name, slug, timezone, created_at, updated_at) VALUES (v_org, p->>'schoolName', v_slug, p->>'timezone', at, at)
    RETURNING id INTO v_school;
  -- The same OWNER role HQ provisioning creates (0019/0022).
  INSERT INTO hon.roles(organization_id, code, name, is_system_role) VALUES (v_org, 'OWNER', 'School Owner', true) RETURNING id INTO v_role;
  INSERT INTO hon.role_permissions(role_id, organization_id, permission_code) SELECT v_role, v_org, perm.code FROM hon.permissions perm;
  INSERT INTO hon.principal_role_grants(organization_id, school_id, principal_id, role_id, granted_by_principal_id, effective_from)
    VALUES (v_org, v_school, owner_id, v_role, owner_id, at);
  nxt := hon.saas_entitlement_json(v_org);
  INSERT INTO hon.saas_access_states(organization_id, state, reason, version, changed_by_principal_id, created_at, updated_at)
    VALUES (v_org, 'AWAITING_FIRST_PAYMENT', 'AWAITING_INITIAL_PAYMENT', 1, owner_id, at, at);
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
    VALUES (v_org, 'AWAITING_FIRST_PAYMENT', 'APPLIED', 'NEW_SCHOOL_REGISTERED', NULL, nxt, owner_id, at);
  RETURN hon.saas_record(owner_id, p_key, 'saas.access.initialize', 'saas.access.initialized', 'ACCESS_STATE', v_org, v_org, NULL, nxt,
    jsonb_build_object('organizationId', v_org, 'schoolId', v_school, 'ownerRoleId', v_role, 'access', hon.saas_organization_access(v_org)), at);
END $$;

-- ---------- checkout: a school awaiting its first payment may buy HON OS ----------
CREATE OR REPLACE FUNCTION hon.saas_hon_os_refusal(p_org uuid, o hon.saas_offer_set_offers, p_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE ent hon.organization_entitlements%ROWTYPE; v_set hon.saas_offer_sets%ROWTYPE; used jsonb; awaiting boolean;
BEGIN
  SELECT * INTO v_set FROM hon.saas_offer_sets WHERE id = o.set_id;
  IF o.id IS NULL OR v_set.status IS DISTINCT FROM 'PUBLISHED' OR NOT hon.saas_hon_os_offer_on_sale(o, p_at) THEN RETURN 'SAAS_OFFER_NOT_AVAILABLE'; END IF;
  IF hon.saas_hon_os_recurring(o) IS NULL THEN RETURN 'SAAS_OFFER_TERMS_UNSUPPORTED'; END IF;
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = p_org;
  -- D7: awaiting its first payment (only while paid access is ACTIVE), the held entitlement is not required to be
  -- active; the verified payment activates it. Otherwise the 0182 rule: an ACTIVE COMPLETE entitlement in effect.
  awaiting := hon.saas_access_program_active() AND hon.saas_awaiting_first_payment(p_org);
  IF ent.organization_id IS NULL OR NOT awaiting AND (ent.status <> 'ACTIVE' OR ent.effective_from > p_at
      OR (ent.effective_until IS NOT NULL AND ent.effective_until <= p_at) OR hon.saas_awaiting_first_payment(p_org)) THEN
    RETURN 'SAAS_ENTITLEMENT_NOT_ACTIVE';
  END IF;
  IF NOT awaiting AND ent.tier::text <> 'COMPLETE' THEN RETURN 'SAAS_ENTITLEMENT_MISMATCH'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_subscriptions s WHERE s.organization_id = p_org AND s.status <> 'VOIDED') THEN RETURN 'SAAS_SUBSCRIPTION_EXISTS'; END IF;
  IF o.eligibility = 'NEW_ORGANIZATIONS_ONLY' AND EXISTS (SELECT 1 FROM hon.saas_payment_evidence e
      WHERE e.organization_id = p_org AND e.kind = 'PAYMENT_RECEIVED') THEN
    RETURN 'SAAS_OFFER_NOT_ELIGIBLE';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.organization_id = p_org AND c.status IN ('CREATED','OPEN') AND c.expires_at > p_at) THEN
    RETURN 'SAAS_CHECKOUT_OPEN';
  END IF;
  IF o.sale_limit IS NOT NULL AND hon.saas_hon_os_offer_usage(o.id, p_at, NULL) >= o.sale_limit THEN RETURN 'SAAS_OFFER_SOLD_OUT'; END IF;
  IF o.founder THEN
    used := hon.saas_hon_os_founder_usage(p_at, NULL);
    IF (used->>'allocated')::integer + (used->>'held')::integer >= coalesce(v_set.founder_total_limit, 0) THEN RETURN 'SAAS_FOUNDER_SOLD_OUT'; END IF;
  END IF;
  RETURN NULL;
END $$;

-- ---------- first-payment access: also for HON OS subscriptions ----------
CREATE OR REPLACE FUNCTION hon.saas_apply_first_payment_access(p_checkout uuid, p_subscription uuid, p_evidence uuid, p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); c hon.saas_checkout_sessions%ROWTYPE; s hon.saas_subscriptions%ROWTYPE;
  st hon.saas_access_states%ROWTYPE; ent hon.organization_entitlements%ROWTYPE; f record; prior jsonb; nxt jsonb; v_allow uuid;
BEGIN
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout;
  SELECT * INTO s FROM hon.saas_subscriptions WHERE id = p_subscription FOR SHARE;
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = c.organization_id FOR UPDATE;
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = c.organization_id FOR UPDATE;
  -- Every fact is re-derived on the server: the checkout's frozen offer (legacy catalog offer, or the HON OS accepted
  -- offer and its digest), the subscription it produced, and provider-verified evidence covering the invoice in full.
  IF NOT hon.saas_access_program_active() THEN RAISE EXCEPTION 'SAAS_ACCESS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF st.state IS DISTINCT FROM 'AWAITING_FIRST_PAYMENT' OR ent.organization_id IS NULL THEN RAISE EXCEPTION 'SAAS_ACCESS_STATE_CHANGED' USING ERRCODE = '23514'; END IF;
  IF s.id IS NULL OR s.organization_id <> c.organization_id OR s.status <> 'IN_SERVICE' OR s.plan_code <> c.plan_code
    OR s.offer_id IS DISTINCT FROM c.offer_id OR s.hon_os_offer_id IS DISTINCT FROM c.hon_os_offer_id
    OR s.accepted_offer_digest IS DISTINCT FROM c.accepted_offer_digest
    OR s.price_minor <> c.amount_minor OR c.status <> 'COMPLETED' OR c.subscription_id IS DISTINCT FROM s.id OR s.plan_code NOT IN ('CORE','COMPLETE') THEN
    RAISE EXCEPTION 'SAAS_ACCESS_INCONSISTENT' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO f FROM hon.saas_invoice_facts(c.organization_id, c.invoice_id);
  IF f.invoice_id IS NULL OR f.status <> 'ISSUED' OR f.verified_net_minor < f.total_minor
    OR NOT EXISTS (SELECT 1 FROM hon.saas_payment_evidence e WHERE e.id = p_evidence AND e.invoice_id = c.invoice_id AND e.source = 'PROVIDER_VERIFIED'
      AND e.kind = 'PAYMENT_RECEIVED') THEN
    RAISE EXCEPTION 'SAAS_ACCESS_PAYMENT_UNVERIFIED' USING ERRCODE = '23514';
  END IF;
  prior := hon.saas_entitlement_json(c.organization_id);
  UPDATE hon.organization_entitlements SET tier = s.plan_code::hon.plan_tier, status = 'ACTIVE', effective_from = least(s.service_started_at, p_at),
      effective_until = NULL, version = version + 1, updated_at = p_at
    WHERE organization_id = c.organization_id AND version = ent.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  nxt := hon.saas_entitlement_json(c.organization_id);
  UPDATE hon.saas_access_states SET state = 'PAYMENT_ACTIVE', reason = 'FIRST_PAYMENT_VERIFIED', version = version + 1, checkout_id = c.id,
      subscription_id = s.id, changed_by_principal_id = actor, updated_at = p_at
    WHERE organization_id = c.organization_id;
  -- Legacy plans: the period's full allowance, once (unique per period). HON OS: no AI credits are opened at activation;
  -- grants stay with the credit program and its approved policy (lifetime credits are not approved).
  IF hon.saas_credit_program_active() AND s.source = 'CATALOG_OFFER' THEN v_allow := hon.saas_current_allowance(s.id, actor, p_at); END IF;
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, checkout_id, subscription_id, evidence_id, allowance_id,
      provider_event_id, prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
    VALUES (c.organization_id, 'FIRST_PAYMENT_ACTIVATION', 'APPLIED', 'FIRST_PAYMENT_VERIFIED', c.id, s.id, p_evidence, v_allow,
      p_event->>'eventId', prior, nxt, actor, p_at);
  RETURN jsonb_build_object('outcome', 'APPLIED', 'entitlement', nxt, 'allowanceId', v_allow);
END $$;

-- ---------- activation ----------
-- Verified payment for a HON OS checkout. p_retry: an HQ-owner retry of a payment held only because paid access was
-- inactive (the original verified event is passed back; nothing from the caller).
CREATE FUNCTION hon.saas_activate_hon_os_checkout_core(p_checkout uuid, p_event jsonb, p_at timestamptz, p_retry boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); c hon.saas_checkout_sessions%ROWTYPE; o jsonb := p_event->'object';
  ent hon.organization_entitlements%ROWTYPE; v_offer hon.saas_offer_set_offers%ROWTYPE; v_limit integer; used jsonb;
  s hon.saas_subscriptions%ROWTYPE; ev uuid; v_reason text; prior record; occurred timestamptz; has_state boolean; awaiting boolean; access jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.hon_os.inventory', 0));
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || c.organization_id::text, 0));
  IF c.status = 'COMPLETED' THEN RETURN jsonb_build_object('outcome','ALREADY_APPLIED','detail','CHECKOUT_COMPLETED','subscriptionId',c.subscription_id); END IF;
  occurred := (p_event->>'createdAt')::timestamptz;
  has_state := hon.saas_awaiting_first_payment(c.organization_id);
  awaiting := has_state AND hon.saas_access_program_active();
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = c.organization_id FOR SHARE;
  SELECT * INTO v_offer FROM hon.saas_offer_set_offers WHERE id = c.hon_os_offer_id;
  SELECT founder_total_limit INTO v_limit FROM hon.saas_offer_sets WHERE id = c.offer_set_id;
  used := hon.saas_hon_os_founder_usage(p_at, c.id);
  v_reason := CASE
    WHEN c.status IN ('EXPIRED','CANCELLED','FAILED','PAID_NEEDS_REVIEW')
      AND NOT (p_retry AND awaiting AND c.status = 'PAID_NEEDS_REVIEW' AND c.status_reason = 'ACCESS_PROGRAM_INACTIVE') THEN 'PAID_AFTER_CLOSE'
    -- A checkout is valid only until it expires, even if the expiry sweep has not closed it yet (the original payment
    -- time on a retry).
    WHEN greatest(occurred, c.created_at) >= c.expires_at THEN 'PAID_AFTER_CLOSE'
    WHEN (o->>'amountTotal')::bigint IS DISTINCT FROM c.amount_minor OR o->>'currency' IS DISTINCT FROM 'usd' THEN 'AMOUNT_MISMATCH'
    -- One-time offers must never have created a provider subscription; recurring offers must have one.
    WHEN (c.provider_recurring = 'NONE') <> (o->>'subscriptionRef' IS NULL) THEN 'RECURRING_MISMATCH'
    -- Awaiting its first payment while paid access is inactive: held for an HQ-owner retry.
    WHEN has_state AND NOT awaiting THEN 'ACCESS_PROGRAM_INACTIVE'
    WHEN ent.organization_id IS NULL THEN 'ENTITLEMENT_CHANGED'
    WHEN NOT awaiting AND (ent.status <> 'ACTIVE' OR ent.tier::text <> 'COMPLETE' OR ent.effective_from > p_at
      OR (ent.effective_until IS NOT NULL AND ent.effective_until <= p_at)) THEN 'ENTITLEMENT_CHANGED'
    WHEN EXISTS (SELECT 1 FROM hon.saas_subscriptions x WHERE x.organization_id = c.organization_id AND x.status <> 'VOIDED') THEN 'SUBSCRIPTION_EXISTS'
    -- Owner decision D6: only an explicit HQ stop-sales on that offer, at or before the payment, blocks it.
    WHEN EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops x WHERE x.offer_id = c.hon_os_offer_id
      AND x.stopped_at <= least(greatest(occurred, c.created_at), p_at)) THEN 'OFFER_SALES_STOPPED'
    WHEN v_offer.sale_limit IS NOT NULL AND hon.saas_hon_os_offer_usage(v_offer.id, p_at, c.id) >= v_offer.sale_limit THEN 'SALE_LIMIT_REACHED'
    WHEN v_offer.founder AND (used->>'allocated')::integer + (used->>'held')::integer >= coalesce(v_limit, 0) THEN 'FOUNDER_UNAVAILABLE' END;
  IF v_reason IS NOT NULL THEN
    IF c.status <> 'PAID_NEEDS_REVIEW' THEN
      UPDATE hon.saas_checkout_sessions SET status = 'PAID_NEEDS_REVIEW', status_reason = v_reason, version = version + 1, updated_at = p_at,
          provider_customer_ref = coalesce(provider_customer_ref, o->>'customerRef')
        WHERE id = c.id;
    END IF;
    IF has_state AND NOT EXISTS (SELECT 1 FROM hon.saas_access_transitions t WHERE t.checkout_id = c.id AND t.reason = v_reason) THEN
      -- A school awaiting its first payment: the review is also recorded against its access.
      INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, checkout_id, provider_event_id, prior_entitlement,
          actor_principal_id, occurred_at)
        VALUES (c.organization_id, 'FIRST_PAYMENT_ACTIVATION', 'NEEDS_REVIEW', v_reason, c.id, p_event->>'eventId',
          hon.saas_entitlement_json(c.organization_id), actor, p_at);
    END IF;
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail',v_reason);
  END IF;
  INSERT INTO hon.saas_subscriptions(organization_id,source,catalog_id,offer_id,hon_os_offer_id,offer_set_id,accepted_offer,accepted_offer_digest,
      plan_code,entitlement_tier,offer_kind,billing_interval,price_minor,founder_reservation_id,entitlement_version_at_record,status,status_reason,version,
      created_by_principal_id,created_at,updated_at)
    VALUES (c.organization_id,'HON_OS_OFFER',NULL,NULL,c.hon_os_offer_id,c.offer_set_id,c.accepted_offer,c.accepted_offer_digest,
      'COMPLETE',CASE WHEN awaiting THEN 'COMPLETE'::hon.plan_tier ELSE ent.tier END,c.offer_kind,c.billing_interval,c.amount_minor,NULL,ent.version,
      'PENDING_ACTIVATION','RECORDED',1,actor,p_at,p_at)
    RETURNING * INTO s;
  INSERT INTO hon.saas_subscription_history(subscription_id,version,status,status_reason,actor_principal_id,occurred_at)
    VALUES (s.id,1,s.status,s.status_reason,actor,p_at);
  -- Service starts at the verified payment; monthly and annual periods are anchored to it.
  UPDATE hon.saas_subscriptions SET status = 'IN_SERVICE', status_reason = 'SERVICE_STARTED', version = version + 1, service_started_at = occurred,
      period_anchor_at = occurred, period_index = CASE WHEN billing_interval IN ('MONTHLY','ANNUAL') THEN 0 END, current_period_start = occurred,
      current_period_end = CASE billing_interval WHEN 'MONTHLY' THEN occurred + interval '1 month' WHEN 'ANNUAL' THEN occurred + interval '12 months' END,
      updated_at = p_at
    WHERE id = s.id RETURNING * INTO s;
  INSERT INTO hon.saas_subscription_history(subscription_id,version,status,status_reason,period_index,current_period_start,current_period_end,actor_principal_id,occurred_at)
    VALUES (s.id,s.version,s.status,s.status_reason,s.period_index,s.current_period_start,s.current_period_end,actor,p_at);
  ev := hon.saas_provider_invoice(s, CASE WHEN s.billing_interval IN ('MONTHLY','ANNUAL') THEN 0 END, c.amount_minor, occurred, o->>'sessionId', p_event, p_at);
  PERFORM hon.saas_link_payment_refs(p_event->>'provider', ARRAY[o->>'sessionId', o->>'paymentIntentRef', o->>'invoiceRef'], ev, p_at);
  -- A first subscription invoice reported before this activation is linked now.
  FOR prior IN SELECT normalized FROM hon.saas_provider_events WHERE provider = p_event->>'provider' AND event_type = 'invoice.paid'
      AND normalized#>>'{object,subscriptionRef}' = o->>'subscriptionRef' AND normalized#>>'{object,billingReason}' = 'subscription_create' LOOP
    PERFORM hon.saas_link_payment_refs(p_event->>'provider', ARRAY[prior.normalized#>>'{object,invoiceRef}', prior.normalized#>>'{object,paymentIntentRef}'], ev, p_at);
  END LOOP;
  UPDATE hon.saas_checkout_sessions SET status = 'COMPLETED', status_reason = 'PAYMENT_VERIFIED', version = version + 1, subscription_id = s.id,
      invoice_id = (SELECT invoice_id FROM hon.saas_payment_evidence WHERE id = ev), completed_at = p_at, updated_at = p_at,
      provider_customer_ref = coalesce(provider_customer_ref, o->>'customerRef'), provider_subscription_ref = o->>'subscriptionRef'
    WHERE id = c.id;
  IF awaiting THEN
    -- D7: the verified payment activates the HON OS entitlement, or is held for HQ review; never a partial grant.
    access := hon.saas_try_first_payment_access(c.id, s.id, ev, p_event, p_at);
    RETURN jsonb_build_object('outcome','APPLIED','detail',CASE WHEN access->>'outcome' = 'APPLIED' THEN 'ACCESS_ACTIVATED' ELSE 'ACCESS_ACTIVATION_NEEDS_REVIEW' END,
      'subscriptionId',s.id,'evidenceId',ev,'organizationId',c.organization_id);
  END IF;
  RETURN jsonb_build_object('outcome','APPLIED','detail','SUBSCRIPTION_ACTIVATED','subscriptionId',s.id,'evidenceId',ev);
END $$;

CREATE OR REPLACE FUNCTION hon.saas_activate_hon_os_checkout(p_checkout uuid, p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  RETURN hon.saas_activate_hon_os_checkout_core(p_checkout, p_event, p_at, false);
END $$;

-- ---------- HQ recovery: retry an activation held for review (HON OS checkouts included) ----------
CREATE OR REPLACE FUNCTION hon.retry_saas_first_payment_activation(p_subject text, p_checkout uuid, p_input jsonb, p_key uuid, p_request_id uuid,
  p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; fp text; replay jsonb; c hon.saas_checkout_sessions%ROWTYPE; evt jsonb; result jsonb; v_ev uuid; at timestamptz := clock_timestamp();
  expected integer;
BEGIN
  IF p_checkout IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> ARRAY['expectedCheckoutVersion']
    OR jsonb_typeof(p_input->'expectedCheckoutVersion') <> 'number' OR (p_input->>'expectedCheckoutVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  expected := (p_input->>'expectedCheckoutVersion')::integer;
  actor := hon.require_saas_hq_actor(p_subject, true);
  fp := hon.saas_fingerprint(ARRAY['access.retry', p_checkout::text, expected::text]);
  replay := hon.saas_claim_request(actor, p_key, 'saas.access.retry', fp, p_request_id, p_correlation_id);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT hon.saas_access_program_active() THEN RAISE EXCEPTION 'SAAS_ACCESS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  -- Lock order of the checkout's own activation path: the inventory lock (legacy founder or HON OS), then the checkout,
  -- then the organization.
  IF (SELECT hon_os_offer_id FROM hon.saas_checkout_sessions WHERE id = p_checkout) IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('saas.hon_os.inventory', 0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  END IF;
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || c.organization_id::text, 0));
  IF c.version <> expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF NOT hon.saas_awaiting_first_payment(c.organization_id) THEN RAISE EXCEPTION 'SAAS_ACCESS_STATE_CHANGED' USING ERRCODE = '23514'; END IF;
  -- The verified completion event this checkout was paid with (never anything the caller supplies).
  SELECT e.normalized INTO evt FROM hon.saas_provider_events e WHERE e.checkout_id = c.id
    AND e.event_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded') AND e.normalized#>>'{object,paymentStatus}' = 'paid'
    ORDER BY e.received_at DESC, e.id LIMIT 1;
  IF evt IS NULL THEN RAISE EXCEPTION 'SAAS_ACCESS_PAYMENT_UNVERIFIED' USING ERRCODE = '23514'; END IF;
  -- A refund or dispute already reported for that payment is never activated.
  IF EXISTS (SELECT 1 FROM hon.saas_provider_events r WHERE r.provider = c.provider AND r.event_type IN ('charge.refunded','charge.dispute.created')
      AND ((r.normalized#>>'{object,paymentIntentRef}' IS NOT NULL AND r.normalized#>>'{object,paymentIntentRef}' = evt#>>'{object,paymentIntentRef}')
        OR (r.normalized#>>'{object,invoiceRef}' IS NOT NULL AND r.normalized#>>'{object,invoiceRef}' = evt#>>'{object,invoiceRef}'))) THEN
    RAISE EXCEPTION 'SAAS_ACCESS_PAYMENT_REVERSED' USING ERRCODE = '23514';
  END IF;
  IF c.status = 'PAID_NEEDS_REVIEW' AND c.status_reason = 'ACCESS_PROGRAM_INACTIVE' THEN
    result := CASE WHEN c.hon_os_offer_id IS NOT NULL THEN hon.saas_activate_hon_os_checkout_core(c.id, evt, at, true)
      ELSE hon.saas_activate_checkout_core(c.id, evt, at, true) END;
  ELSIF c.status = 'COMPLETED' AND EXISTS (SELECT 1 FROM hon.saas_access_transitions t WHERE t.checkout_id = c.id AND t.outcome = 'NEEDS_REVIEW') THEN
    SELECT e.id INTO v_ev FROM hon.saas_payment_evidence e WHERE e.invoice_id = c.invoice_id AND e.kind = 'PAYMENT_RECEIVED' AND e.source = 'PROVIDER_VERIFIED'
      ORDER BY e.recorded_at, e.id LIMIT 1;
    result := hon.saas_try_first_payment_access(c.id, c.subscription_id, v_ev, evt, at);
    result := jsonb_build_object('outcome', CASE WHEN result->>'outcome' = 'APPLIED' THEN 'APPLIED' ELSE 'NEEDS_REVIEW' END,
      'detail', CASE WHEN result->>'outcome' = 'APPLIED' THEN 'ACCESS_ACTIVATED' ELSE coalesce(result->>'reason', 'ACTIVATION_FAILED') END);
  ELSE
    RAISE EXCEPTION 'SAAS_ACCESS_NOT_RETRYABLE' USING ERRCODE = '23514';
  END IF;
  RETURN hon.saas_record(actor, p_key, 'saas.access.retry', 'saas.access.retried', 'ACCESS_STATE', c.organization_id, c.organization_id, NULL,
    jsonb_build_object('outcome', result->>'outcome', 'detail', result->>'detail'),
    jsonb_build_object('outcome', result->>'outcome', 'detail', result->>'detail', 'checkoutId', c.id, 'access', hon.saas_organization_access(c.organization_id)), at);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.initialize_saas_hon_os_school_account(text,jsonb,uuid,uuid,uuid)',
      'hon.saas_activate_hon_os_checkout_core(uuid,jsonb,timestamp with time zone,boolean)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
END $$;

COMMIT;
