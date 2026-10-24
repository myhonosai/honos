BEGIN;

-- HON OS-only new-customer sales (owner decision D8, 2026-10-23). HON OS is the only product sold to new customers; legacy
-- Core/Complete (and Essential) stay supported for the customers who already have them.
-- - Who is a legacy customer: an organization with a legacy subscription record (source CATALOG_OFFER or LEGACY_ENTITLEMENT)
--   that HQ recorded or a provider-verified payment created before this closure. Their subscriptions, renewals, invoices,
--   payment evidence, refunds, disputes, allowances, founder slots and lifetime rights are unchanged. Every other
--   organization (HQ-provisioned without a subscription, or registered awaiting a first payment) is a new customer and can
--   only buy an HQ-published HON OS offer (0182/0183).
-- - The closure is a pinned policy row (hon.saas_new_sales_policy, CHECK legacy_new_sales = 'CLOSED'), like the paid-access
--   program: reopening legacy sales needs a reviewed migration, never a runtime switch.
-- - Every path that could create a new legacy sale refuses it with SAAS_LEGACY_SALES_CLOSED: school and HQ legacy
--   checkout (before the request is claimed, so a replayed pre-closure key never reaches the provider), opening a provider
--   session for a pre-closure checkout, HQ recording a CATALOG_OFFER or LEGACY_ENTITLEMENT subscription, and HQ legacy
--   founder reservations. A BEFORE INSERT/UPDATE trigger on the three legacy sale tables refuses anything else.
-- - A verified payment on a pre-closure legacy checkout (a stale link, or one held while paid access was inactive and
--   later retried) is held PAID_NEEDS_REVIEW with reason LEGACY_SALES_CLOSED: no subscription, entitlement or credit.
-- - The school legacy plan read (GET /hon-plan) lists no legacy offers; its subscription and checkout history stay.
-- - Paid access and AI credits stay INACTIVE; nothing here touches a real organization's access.
-- Number: 0179 is reserved for E1b-2 and 0180 for E1c.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS-only new sales requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS-only new sales requires a restricted runtime';
  END IF;
END $$;

-- ---------- vocabularies ----------
ALTER TABLE hon.saas_checkout_sessions DROP CONSTRAINT saas_checkout_sessions_status_reason_check;
ALTER TABLE hon.saas_checkout_sessions ADD CONSTRAINT saas_checkout_sessions_status_reason_check CHECK (status_reason IN ('CREATED',
  'PROVIDER_SESSION_OPENED','PROVIDER_CREATE_FAILED','PAYMENT_VERIFIED','PROVIDER_EXPIRED','LOCAL_EXPIRED','CANCELLED_BY_REQUESTER','CANCELLED_BY_HQ',
  'ASYNC_PAYMENT_FAILED','PAID_AFTER_CLOSE','AMOUNT_MISMATCH','FOUNDER_UNAVAILABLE','ENTITLEMENT_CHANGED','SUBSCRIPTION_EXISTS',
  'ACCESS_PROGRAM_INACTIVE','OFFER_SALES_STOPPED','SALE_LIMIT_REACHED','RECURRING_MISMATCH','LEGACY_SALES_CLOSED'));

-- ---------- the pinned new-sales policy ----------
CREATE TABLE hon.saas_new_sales_policy (
  policy_id smallint PRIMARY KEY CHECK (policy_id = 1),
  new_sale_product text NOT NULL CHECK (new_sale_product = 'HON_OS'),
  -- Reopening legacy sales is a reviewed migration after owner approval, never a runtime switch.
  legacy_new_sales text NOT NULL CONSTRAINT saas_new_sales_policy_legacy_check CHECK (legacy_new_sales = 'CLOSED'),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL
);
INSERT INTO hon.saas_new_sales_policy(policy_id, new_sale_product, legacy_new_sales, source_reference, recorded_at)
  VALUES (1, 'HON_OS', 'CLOSED', 'OWNER_DIRECTION_2026_10_23_D8', clock_timestamp());
ALTER TABLE hon.saas_new_sales_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.saas_new_sales_policy FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.saas_new_sales_policy FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.saas_new_sales_policy FROM %I', r);
  END LOOP;
END $$;
CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.saas_new_sales_policy FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_new_sales_policy FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

CREATE FUNCTION hon.saas_legacy_new_sales_open() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce((SELECT legacy_new_sales = 'OPEN' FROM hon.saas_new_sales_policy WHERE policy_id = 1), false)
$$;

-- Backstop for every legacy sale path: no new legacy checkout, provider session on a legacy checkout, legacy subscription
-- record or legacy founder reservation while legacy sales are closed. HON OS rows and every update of an existing
-- legacy row (renewals, refunds, cancellations, reviews, expiry, slot release) are untouched.
CREATE FUNCTION hon.guard_saas_legacy_new_sale() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF hon.saas_legacy_new_sales_open() THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'saas_subscriptions' THEN
    IF NEW.source <> 'HON_OS_OFFER' THEN RAISE EXCEPTION 'SAAS_LEGACY_SALES_CLOSED' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'saas_checkout_sessions' THEN
    IF NEW.hon_os_offer_id IS NULL AND (TG_OP = 'INSERT' OR (OLD.status = 'CREATED' AND NEW.status = 'OPEN')) THEN
      RAISE EXCEPTION 'SAAS_LEGACY_SALES_CLOSED' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'saas_founder_reservations' THEN
    RAISE EXCEPTION 'SAAS_LEGACY_SALES_CLOSED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_legacy_new_sale BEFORE INSERT ON hon.saas_subscriptions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_legacy_new_sale();
CREATE TRIGGER saas_legacy_new_sale BEFORE INSERT OR UPDATE ON hon.saas_checkout_sessions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_legacy_new_sale();
CREATE TRIGGER saas_legacy_new_sale BEFORE INSERT ON hon.saas_founder_reservations FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_legacy_new_sale();

-- ---------- legacy checkout: closed to new sales ----------
CREATE OR REPLACE FUNCTION hon.create_saas_checkout_from_school(p_subject text, p_school uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; replay jsonb; created hon.saas_checkout_sessions%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p_school IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['offerId']
    OR coalesce(jsonb_typeof(p->'offerId'), '') <> 'string' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.family_access_grants IN SHARE MODE;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  -- D8: refused before the request is claimed, so replaying a key from before the closure never reaches the provider.
  IF NOT hon.saas_legacy_new_sales_open() THEN RAISE EXCEPTION 'SAAS_LEGACY_SALES_CLOSED' USING ERRCODE = '23514'; END IF;
  replay := hon.saas_claim_request(actor.principal_id, p_key, 'saas.checkout.create', hon.saas_fingerprint(ARRAY['saas.checkout.create', p_school::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  created := hon.saas_open_checkout(actor.principal_id, actor.organization_id, p_school, (p->>'offerId')::uuid, 'SCHOOL_OWNER', at);
  snapshot := hon.saas_checkout_json(created);
  RETURN hon.saas_record(actor.principal_id, p_key, 'saas.checkout.create', 'saas.checkout.created', 'CHECKOUT', created.id, created.organization_id,
    NULL, snapshot, jsonb_build_object('checkout', snapshot), at);
END $$;

CREATE OR REPLACE FUNCTION hon.create_saas_checkout_from_hq(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; created hon.saas_checkout_sessions%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['offerId','organizationId']
    OR coalesce(jsonb_typeof(p->'offerId'), '') <> 'string' OR coalesce(jsonb_typeof(p->'organizationId'), '') <> 'string' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, false);
  -- D8: refused before the request is claimed, so replaying a key from before the closure never reaches the provider.
  IF NOT hon.saas_legacy_new_sales_open() THEN RAISE EXCEPTION 'SAAS_LEGACY_SALES_CLOSED' USING ERRCODE = '23514'; END IF;
  replay := hon.saas_claim_request(actor, p_key, 'saas.checkout.create', hon.saas_fingerprint(ARRAY['saas.checkout.create', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  created := hon.saas_open_checkout(actor, (p->>'organizationId')::uuid, NULL, (p->>'offerId')::uuid, 'HQ', at);
  snapshot := hon.saas_checkout_json(created);
  RETURN hon.saas_record(actor, p_key, 'saas.checkout.create', 'saas.checkout.created', 'CHECKOUT', created.id, created.organization_id,
    NULL, snapshot, jsonb_build_object('checkout', snapshot), at);
END $$;

-- ---------- activation: a pre-closure legacy checkout paid now is held for HQ review ----------
CREATE OR REPLACE FUNCTION hon.saas_activate_checkout_core(p_checkout uuid, p_event jsonb, p_at timestamptz, p_retry boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); c hon.saas_checkout_sessions%ROWTYPE; o jsonb := p_event->'object'; ent hon.organization_entitlements%ROWTYPE;
  res hon.saas_founder_reservations%ROWTYPE; s hon.saas_subscriptions%ROWTYPE; ev uuid; reason text; prior record; occurred timestamptz;
  has_state boolean; awaiting boolean; access jsonb; review_reason text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || c.organization_id::text, 0));
  IF c.status = 'COMPLETED' THEN RETURN jsonb_build_object('outcome','ALREADY_APPLIED','detail','CHECKOUT_COMPLETED','subscriptionId',c.subscription_id); END IF;
  occurred := (p_event->>'createdAt')::timestamptz;
  has_state := hon.saas_awaiting_first_payment(c.organization_id);
  awaiting := has_state AND hon.saas_access_program_active();
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = c.organization_id FOR SHARE;
  IF c.founder_reservation_id IS NOT NULL THEN SELECT * INTO res FROM hon.saas_founder_reservations WHERE id = c.founder_reservation_id FOR UPDATE; END IF;
  reason := CASE
    WHEN c.status IN ('EXPIRED','CANCELLED','FAILED','PAID_NEEDS_REVIEW')
      AND NOT (p_retry AND awaiting AND c.status = 'PAID_NEEDS_REVIEW' AND c.status_reason = 'ACCESS_PROGRAM_INACTIVE') THEN 'PAID_AFTER_CLOSE'
    -- D8: HON OS is the only new-sale product. A legacy Core/Complete checkout opened before the closure (a stale link,
    -- a payment held while paid access was inactive) never creates a subscription or grants access: HQ reviews and refunds.
    WHEN NOT hon.saas_legacy_new_sales_open() THEN 'LEGACY_SALES_CLOSED'
    WHEN (o->>'amountTotal')::bigint IS DISTINCT FROM c.amount_minor OR o->>'currency' IS DISTINCT FROM 'usd' THEN 'AMOUNT_MISMATCH'
    WHEN has_state AND NOT awaiting THEN 'ACCESS_PROGRAM_INACTIVE'
    WHEN ent.organization_id IS NULL THEN 'ENTITLEMENT_CHANGED'
    WHEN NOT awaiting AND (ent.status <> 'ACTIVE' OR ent.tier::text <> c.plan_code OR ent.effective_from > p_at
      OR (ent.effective_until IS NOT NULL AND ent.effective_until <= p_at)) THEN 'ENTITLEMENT_CHANGED'
    WHEN EXISTS (SELECT 1 FROM hon.saas_subscriptions x WHERE x.organization_id = c.organization_id AND x.status <> 'VOIDED') THEN 'SUBSCRIPTION_EXISTS'
    WHEN c.founder_reservation_id IS NOT NULL AND (res.status <> 'RESERVED' OR res.hold_expires_at <= occurred) THEN 'FOUNDER_UNAVAILABLE' END;
  IF reason IS NOT NULL THEN
    review_reason := reason;
    IF c.status <> 'PAID_NEEDS_REVIEW' THEN
      UPDATE hon.saas_checkout_sessions SET status = 'PAID_NEEDS_REVIEW', status_reason = reason, version = version + 1, updated_at = p_at,
          provider_customer_ref = coalesce(provider_customer_ref, o->>'customerRef')
        WHERE id = c.id;
    END IF;
    IF has_state AND NOT EXISTS (SELECT 1 FROM hon.saas_access_transitions t WHERE t.checkout_id = c.id AND t.reason = review_reason) THEN
      -- An organization awaiting its first payment: the review is also recorded against its access.
      INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, checkout_id, provider_event_id, prior_entitlement,
          actor_principal_id, occurred_at)
        VALUES (c.organization_id, 'FIRST_PAYMENT_ACTIVATION', 'NEEDS_REVIEW', reason, c.id, p_event->>'eventId',
          hon.saas_entitlement_json(c.organization_id), actor, p_at);
    END IF;
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail',reason);
  END IF;
  INSERT INTO hon.saas_subscriptions(organization_id,source,catalog_id,offer_id,plan_code,entitlement_tier,offer_kind,billing_interval,price_minor,
      founder_reservation_id,entitlement_version_at_record,status,status_reason,version,created_by_principal_id,created_at,updated_at)
    VALUES (c.organization_id,'CATALOG_OFFER',c.catalog_id,c.offer_id,c.plan_code,
      CASE WHEN awaiting THEN c.plan_code::hon.plan_tier ELSE ent.tier END,c.offer_kind,c.billing_interval,c.amount_minor,
      c.founder_reservation_id,ent.version,'PENDING_ACTIVATION','RECORDED',1,actor,p_at,p_at)
    RETURNING * INTO s;
  INSERT INTO hon.saas_subscription_history(subscription_id,version,status,status_reason,actor_principal_id,occurred_at)
    VALUES (s.id,1,s.status,s.status_reason,actor,p_at);
  IF res.id IS NOT NULL THEN
    UPDATE hon.saas_founder_reservations SET status = 'ALLOCATED', status_reason = 'SUBSCRIPTION_RECORDED', version = version + 1,
      subscription_id = s.id, decided_by_principal_id = actor, decided_at = p_at WHERE id = res.id;
  END IF;
  -- Service starts at the verified payment; monthly periods are anchored to it.
  UPDATE hon.saas_subscriptions SET status = 'IN_SERVICE', status_reason = 'SERVICE_STARTED', version = version + 1, service_started_at = occurred,
      period_anchor_at = occurred, period_index = CASE WHEN billing_interval = 'MONTHLY' THEN 0 END, current_period_start = occurred,
      current_period_end = CASE WHEN billing_interval = 'MONTHLY' THEN occurred + interval '1 month' END, updated_at = p_at
    WHERE id = s.id RETURNING * INTO s;
  INSERT INTO hon.saas_subscription_history(subscription_id,version,status,status_reason,period_index,current_period_start,current_period_end,actor_principal_id,occurred_at)
    VALUES (s.id,s.version,s.status,s.status_reason,s.period_index,s.current_period_start,s.current_period_end,actor,p_at);
  ev := hon.saas_provider_invoice(s, CASE WHEN s.billing_interval = 'MONTHLY' THEN 0 END, c.amount_minor, occurred, o->>'sessionId', p_event, p_at);
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
    -- B6A: the verified payment activates the purchased plan, or is held for HQ review; never a partial grant.
    access := hon.saas_try_first_payment_access(c.id, s.id, ev, p_event, p_at);
    RETURN jsonb_build_object('outcome','APPLIED','detail',CASE WHEN access->>'outcome' = 'APPLIED' THEN 'ACCESS_ACTIVATED' ELSE 'ACCESS_ACTIVATION_NEEDS_REVIEW' END,
      'subscriptionId',s.id,'evidenceId',ev,'organizationId',c.organization_id);
  END IF;
  RETURN jsonb_build_object('outcome','APPLIED','detail','SUBSCRIPTION_ACTIVATED','subscriptionId',s.id,'evidenceId',ev);
END $$;

-- ---------- school legacy plan read: no legacy offers; subscription and checkout history unchanged ----------
CREATE OR REPLACE FUNCTION hon.read_saas_school_plan_options(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; ent hon.organization_entitlements%ROWTYPE; at timestamptz := clock_timestamp(); inv jsonb; sub hon.saas_subscriptions%ROWTYPE;
  chk hon.saas_checkout_sessions%ROWTYPE; awaiting boolean;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = actor.organization_id;
  inv := hon.saas_founder_inventory(at);
  awaiting := hon.saas_access_program_active() AND hon.saas_awaiting_first_payment(actor.organization_id);
  SELECT * INTO sub FROM hon.saas_subscriptions WHERE organization_id = actor.organization_id AND status <> 'VOIDED';
  SELECT * INTO chk FROM hon.saas_checkout_sessions WHERE organization_id = actor.organization_id ORDER BY created_at DESC, id LIMIT 1;
  RETURN jsonb_build_object('schoolId', p_school, 'entitlementTier', CASE WHEN awaiting THEN NULL ELSE ent.tier::text END,
    'payments', jsonb_build_object('status', (SELECT status FROM hon.saas_payment_program WHERE program_id = 1),
      'mode', CASE WHEN (SELECT status FROM hon.saas_payment_program WHERE program_id = 1) = 'TEST_MODE' THEN 'TEST' END),
    'offers', (SELECT coalesce(jsonb_agg(jsonb_build_object('offerId',o.id,'planCode',o.plan_code,'offerKind',o.offer_kind,'billingInterval',o.billing_interval,
        'priceMinor',o.price_minor,'currency','USD','monthlyPremiumCredits',pl.planned_monthly_premium_credits,
        'founderSlotsRemaining',CASE WHEN o.offer_kind = 'FOUNDER_LIFETIME' THEN (inv#>>'{remaining,lifetime}')::int
          WHEN o.offer_kind = 'FOUNDER_MONTHLY' THEN (inv#>>'{remaining,monthly}')::int END) ORDER BY o.price_minor, o.offer_kind, o.plan_code), '[]'::jsonb)
      FROM hon.saas_catalog_versions c JOIN hon.saas_catalog_offers o ON o.catalog_id = c.id
      JOIN hon.saas_catalog_plans pl ON pl.catalog_id = c.id AND pl.plan_code = o.plan_code
      WHERE c.status = 'PUBLISHED' AND hon.saas_legacy_new_sales_open() AND (o.plan_code = ent.tier::text OR (awaiting AND o.plan_code IN ('CORE','COMPLETE')))
        AND (o.offer_kind NOT LIKE 'FOUNDER_%' OR (at >= c.founder_opens_at AND (c.founder_closes_at IS NULL OR at < c.founder_closes_at)))),
    'subscription', CASE WHEN sub.id IS NULL THEN NULL ELSE hon.saas_subscription_json(sub) - 'organizationName' END,
    'paymentVerification', CASE WHEN sub.id IS NULL THEN 'NONE' ELSE hon.saas_subscription_payment(sub)->>'paymentVerification' END,
    'checkout', CASE WHEN chk.id IS NULL THEN NULL ELSE hon.saas_checkout_json(chk) END,
    'annualBilling', 'UNAVAILABLE', 'planChanges', 'UNAVAILABLE', 'cardDataStored', false);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.saas_legacy_new_sales_open()','hon.guard_saas_legacy_new_sale()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
END $$;

COMMIT;
