BEGIN;

-- HON OS purchase binding. A school buys exactly one HQ-published HON OS offer (0181) through the existing B5 hosted
-- checkout, TEST MODE ONLY, at the exact published price and terms, with payment evidence verified by the provider.
-- - The offer the school accepted is frozen as a snapshot (price, kind, renewal, price lock, refund window, planned
--   credits, fair use and terms references, set version) on the checkout and copied verbatim to the subscription.
--   Later HQ edits, new set versions or sales stops never change it. Classification is by source + kind, never price.
-- - Checkout opens only for an on-sale offer of the PUBLISHED set, for an ACTIVE organization with an ACTIVE COMPLETE
--   entitlement (the HON OS capability policy v1), no live subscription or open checkout, inside the offer's sale limit
--   and, for founder offers, inside one cumulative HON OS founder pool. Counting and holding happen in the same
--   transaction under one advisory lock. Organizations awaiting a first payment under B6A are refused: changing the
--   B6A awaiting path needs a separate owner authorization.
-- - A verified payment activates only if it matches the snapshot exactly and the offer was still on sale when the
--   customer paid; anything else is held for HQ review (PAID_NEEDS_REVIEW), never activated and never auto-refunded.
--   A purchase never changes the entitlement.
-- - Monthly and auto-renewing annual offers bill through a provider subscription at the accepted price. Annual offers
--   without auto-renewal and lifetime offers are one-time payments: a provider subscription on them is refused, and
--   they never create a recurring obligation.
-- - Legacy Core/Complete catalog checkout, subscriptions, founder reservations, allowances, refunds and B6A behave
--   exactly as before; every legacy row combination allowed before stays allowed and nothing else is added for them.
-- Number: 0179 is reserved for E1b-2 and 0180 for E1c.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS purchase binding requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS purchase binding requires a restricted runtime';
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
  'saas.checkout.create_hon_os'));

-- Interval of a sold HON OS offer kind (subscriptions and checkouts use LIFETIME where offers say ONE_TIME).
CREATE FUNCTION hon.saas_hon_os_billing_interval(p_kind text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN p_kind IN ('LIFETIME','FOUNDER_LIFETIME') THEN 'LIFETIME' WHEN p_kind LIKE '%\_ANNUAL' THEN 'ANNUAL' ELSE 'MONTHLY' END
$$;

-- ---------- purchase records ----------
ALTER TABLE hon.saas_offer_set_offers ADD CONSTRAINT saas_offer_set_offers_id_set_key UNIQUE (id, set_id);

ALTER TABLE hon.saas_subscriptions
  ADD COLUMN hon_os_offer_id uuid, ADD COLUMN offer_set_id uuid, ADD COLUMN accepted_offer jsonb, ADD COLUMN accepted_offer_digest text,
  ADD CONSTRAINT saas_subscriptions_hon_os_offer_fkey FOREIGN KEY (hon_os_offer_id, offer_set_id)
    REFERENCES hon.saas_offer_set_offers(id, set_id) ON DELETE RESTRICT,
  DROP CONSTRAINT saas_subscriptions_source_check, DROP CONSTRAINT saas_subscriptions_offer_kind_check,
  DROP CONSTRAINT saas_subscriptions_billing_interval_check, DROP CONSTRAINT saas_subscriptions_check1,
  DROP CONSTRAINT saas_subscriptions_check2, DROP CONSTRAINT saas_subscriptions_check4;
ALTER TABLE hon.saas_subscriptions
  ADD CONSTRAINT saas_subscriptions_source_check CHECK (source IN ('CATALOG_OFFER','LEGACY_ENTITLEMENT','HON_OS_OFFER')),
  ADD CONSTRAINT saas_subscriptions_offer_kind_check CHECK (offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME',
    'REGULAR_ANNUAL','FOUNDER_ANNUAL','LIFETIME')),
  ADD CONSTRAINT saas_subscriptions_billing_interval_check CHECK (billing_interval IN ('MONTHLY','ANNUAL','LIFETIME','NONE')),
  ADD CONSTRAINT saas_subscriptions_source_shape_check CHECK (coalesce(CASE source
    WHEN 'CATALOG_OFFER' THEN catalog_id IS NOT NULL AND offer_id IS NOT NULL AND offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME')
      AND price_minor IS NOT NULL AND plan_code <> 'ESSENTIAL'
      AND billing_interval = CASE WHEN offer_kind = 'FOUNDER_LIFETIME' THEN 'LIFETIME' ELSE 'MONTHLY' END
      AND hon_os_offer_id IS NULL AND offer_set_id IS NULL AND accepted_offer IS NULL AND accepted_offer_digest IS NULL
    WHEN 'HON_OS_OFFER' THEN catalog_id IS NULL AND offer_id IS NULL AND hon_os_offer_id IS NOT NULL AND offer_set_id IS NOT NULL
      AND offer_kind IS NOT NULL AND price_minor IS NOT NULL AND plan_code = 'COMPLETE' AND billing_interval = hon.saas_hon_os_billing_interval(offer_kind)
      AND jsonb_typeof(accepted_offer) = 'object' AND accepted_offer->>'offerId' = hon_os_offer_id::text
      AND accepted_offer->>'offerSetId' = offer_set_id::text AND accepted_offer->>'offerKind' = offer_kind
      AND accepted_offer->'priceMinor' = to_jsonb(price_minor) AND accepted_offer_digest ~ '^[0-9a-f]{64}$'
    ELSE catalog_id IS NULL AND offer_id IS NULL AND offer_kind IS NULL AND price_minor IS NULL AND billing_interval = 'NONE'
      AND hon_os_offer_id IS NULL AND offer_set_id IS NULL AND accepted_offer IS NULL AND accepted_offer_digest IS NULL END, false)),
  ADD CONSTRAINT saas_subscriptions_founder_reservation_check CHECK ((founder_reservation_id IS NOT NULL)
    = (source = 'CATALOG_OFFER' AND offer_kind LIKE 'FOUNDER\_%')),
  ADD CONSTRAINT saas_subscriptions_period_check CHECK (CASE
    WHEN service_started_at IS NULL OR billing_interval = 'NONE' THEN period_anchor_at IS NULL AND period_index IS NULL
      AND current_period_start IS NULL AND current_period_end IS NULL
    WHEN billing_interval IN ('MONTHLY','ANNUAL') THEN period_anchor_at = service_started_at AND period_index IS NOT NULL
      AND current_period_start IS NOT NULL AND current_period_end > current_period_start
    ELSE period_anchor_at = service_started_at AND period_index IS NULL AND current_period_start = service_started_at AND current_period_end IS NULL END);

ALTER TABLE hon.saas_checkout_sessions
  ALTER COLUMN catalog_id DROP NOT NULL, ALTER COLUMN offer_id DROP NOT NULL,
  ADD COLUMN hon_os_offer_id uuid, ADD COLUMN offer_set_id uuid, ADD COLUMN accepted_offer jsonb, ADD COLUMN accepted_offer_digest text,
  ADD COLUMN provider_recurring text CHECK (provider_recurring IN ('MONTH','YEAR','NONE')),
  ADD CONSTRAINT saas_checkout_sessions_hon_os_offer_fkey FOREIGN KEY (hon_os_offer_id, offer_set_id)
    REFERENCES hon.saas_offer_set_offers(id, set_id) ON DELETE RESTRICT,
  DROP CONSTRAINT saas_checkout_sessions_offer_kind_check, DROP CONSTRAINT saas_checkout_sessions_billing_interval_check,
  DROP CONSTRAINT saas_checkout_sessions_check, DROP CONSTRAINT saas_checkout_sessions_check1,
  DROP CONSTRAINT saas_checkout_sessions_status_reason_check;
ALTER TABLE hon.saas_checkout_sessions
  ADD CONSTRAINT saas_checkout_sessions_offer_kind_check CHECK (offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME',
    'REGULAR_ANNUAL','FOUNDER_ANNUAL','LIFETIME')),
  ADD CONSTRAINT saas_checkout_sessions_billing_interval_check CHECK (billing_interval IN ('MONTHLY','ANNUAL','LIFETIME')),
  ADD CONSTRAINT saas_checkout_sessions_founder_reservation_check CHECK ((founder_reservation_id IS NOT NULL)
    = (hon_os_offer_id IS NULL AND offer_kind LIKE 'FOUNDER\_%')),
  ADD CONSTRAINT saas_checkout_sessions_source_shape_check CHECK (coalesce(CASE WHEN hon_os_offer_id IS NULL THEN
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
      AND accepted_offer_digest ~ '^[0-9a-f]{64}$' AND status_reason <> 'ACCESS_PROGRAM_INACTIVE' END, false)),
  ADD CONSTRAINT saas_checkout_sessions_status_reason_check CHECK (status_reason IN ('CREATED','PROVIDER_SESSION_OPENED','PROVIDER_CREATE_FAILED',
    'PAYMENT_VERIFIED','PROVIDER_EXPIRED','LOCAL_EXPIRED','CANCELLED_BY_REQUESTER','CANCELLED_BY_HQ','ASYNC_PAYMENT_FAILED','PAID_AFTER_CLOSE',
    'AMOUNT_MISMATCH','FOUNDER_UNAVAILABLE','ENTITLEMENT_CHANGED','SUBSCRIPTION_EXISTS','ACCESS_PROGRAM_INACTIVE',
    'OFFER_SALES_STOPPED','SALE_LIMIT_REACHED','RECURRING_MISMATCH'));
CREATE INDEX saas_checkout_sessions_hon_os_offer ON hon.saas_checkout_sessions (hon_os_offer_id) WHERE hon_os_offer_id IS NOT NULL;
CREATE INDEX saas_subscriptions_hon_os_offer ON hon.saas_subscriptions (hon_os_offer_id) WHERE hon_os_offer_id IS NOT NULL;

ALTER TABLE hon.saas_invoices DROP CONSTRAINT saas_invoices_offer_kind_check, DROP CONSTRAINT saas_invoices_check2;
ALTER TABLE hon.saas_invoices
  ADD CONSTRAINT saas_invoices_offer_kind_check CHECK (offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME',
    'REGULAR_ANNUAL','FOUNDER_ANNUAL','LIFETIME')),
  ADD CONSTRAINT saas_invoices_lifetime_kind_check CHECK ((kind = 'LIFETIME_PURCHASE') = (offer_kind IN ('FOUNDER_LIFETIME','LIFETIME')));

-- The refund window is the accepted offer's (legacy purchases keep 30 days = 720 hours).
ALTER TABLE hon.saas_refund_requests
  ADD COLUMN window_hours integer NOT NULL DEFAULT 720 CHECK (window_hours BETWEEN 0 AND 8760),
  DROP CONSTRAINT saas_refund_requests_offer_kind_check, DROP CONSTRAINT saas_refund_requests_check;
ALTER TABLE hon.saas_refund_requests
  ADD CONSTRAINT saas_refund_requests_offer_kind_check CHECK (offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME',
    'REGULAR_ANNUAL','FOUNDER_ANNUAL','LIFETIME')),
  ADD CONSTRAINT saas_refund_requests_window_check CHECK (window_ends_at = first_paid_at + window_hours * interval '1 hour');

-- ---------- offer helpers ----------
-- Recurring provider billing an offer needs, or NULL when its terms cannot be sold yet (repricing at renewal needs a
-- separately authorized flow).
CREATE FUNCTION hon.saas_hon_os_recurring(o hon.saas_offer_set_offers) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN o.billing_interval = 'MONTHLY' THEN 'MONTH' WHEN o.billing_interval = 'ONE_TIME' THEN 'NONE'
    WHEN o.annual_renewal = 'AUTO_RENEW_AT_LOCKED_PRICE' THEN 'YEAR' WHEN o.annual_renewal = 'NO_AUTO_RENEWAL' THEN 'NONE' END
$$;

-- On sale at p_at: published at that time (or retired only later), inside its sales window and not stopped by then.
CREATE FUNCTION hon.saas_hon_os_offer_on_sale(o hon.saas_offer_set_offers, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT o.id IS NOT NULL AND o.sales_opens_at IS NOT NULL AND o.sales_opens_at <= p_at AND (o.sales_closes_at IS NULL OR o.sales_closes_at > p_at)
    AND NOT EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops x WHERE x.offer_id = o.id AND x.stopped_at <= p_at)
    AND EXISTS (SELECT 1 FROM hon.saas_offer_sets s WHERE s.id = o.set_id AND s.published_at <= p_at
      AND (s.status = 'PUBLISHED' OR (s.status = 'RETIRED' AND s.retired_at > p_at)))
$$;

-- The exact terms a school accepts; frozen on the checkout and copied to the subscription.
CREATE FUNCTION hon.saas_hon_os_accepted_offer(o hon.saas_offer_set_offers) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT (hon.saas_offer_json(o) - ARRAY['salesStop','position']) || jsonb_build_object('productCode',s.product_code,
    'capabilityPolicyVersion',s.capability_policy_version,'planCode','COMPLETE','offerSetId',s.id,'offerSetVersion',s.set_version,
    'termsReference',s.terms_reference,'approvedPreviewDigest',s.approved_preview_digest,'recurringBilling',hon.saas_hon_os_recurring(o))
  FROM hon.saas_offer_sets s WHERE s.id = o.set_id
$$;

CREATE FUNCTION hon.saas_hon_os_digest(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT encode(sha256(convert_to(p::text, 'UTF8')), 'hex')
$$;

-- Sales of one offer: recorded subscriptions plus live (unexpired) checkouts, optionally excluding one checkout.
CREATE FUNCTION hon.saas_hon_os_offer_usage(p_offer uuid, p_at timestamptz, p_exclude uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT ((SELECT count(*) FROM hon.saas_subscriptions s WHERE s.hon_os_offer_id = p_offer AND s.status <> 'VOIDED')
    + (SELECT count(*) FROM hon.saas_checkout_sessions c WHERE c.hon_os_offer_id = p_offer AND c.status IN ('CREATED','OPEN')
        AND c.expires_at > p_at AND c.id IS DISTINCT FROM p_exclude))::integer
$$;

-- The one HON OS founder pool, cumulative across every set version and separate from the legacy founder inventory.
CREATE FUNCTION hon.saas_hon_os_founder_usage(p_at timestamptz, p_exclude uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object(
    'allocated', (SELECT count(*) FROM hon.saas_subscriptions s WHERE s.source = 'HON_OS_OFFER' AND s.offer_kind LIKE 'FOUNDER\_%' AND s.status <> 'VOIDED'),
    'held', (SELECT count(*) FROM hon.saas_checkout_sessions c WHERE c.hon_os_offer_id IS NOT NULL AND c.offer_kind LIKE 'FOUNDER\_%'
      AND c.status IN ('CREATED','OPEN') AND c.expires_at > p_at AND c.id IS DISTINCT FROM p_exclude))
$$;

-- Why this organization cannot buy this offer now (an exception code), or NULL. Payment program state is checked by callers.
CREATE FUNCTION hon.saas_hon_os_refusal(p_org uuid, o hon.saas_offer_set_offers, p_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE ent hon.organization_entitlements%ROWTYPE; v_set hon.saas_offer_sets%ROWTYPE; used jsonb;
BEGIN
  SELECT * INTO v_set FROM hon.saas_offer_sets WHERE id = o.set_id;
  IF o.id IS NULL OR v_set.status IS DISTINCT FROM 'PUBLISHED' OR NOT hon.saas_hon_os_offer_on_sale(o, p_at) THEN RETURN 'SAAS_OFFER_NOT_AVAILABLE'; END IF;
  IF hon.saas_hon_os_recurring(o) IS NULL THEN RETURN 'SAAS_OFFER_TERMS_UNSUPPORTED'; END IF;
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = p_org;
  IF ent.organization_id IS NULL OR ent.status <> 'ACTIVE' OR ent.effective_from > p_at OR (ent.effective_until IS NOT NULL AND ent.effective_until <= p_at)
    OR hon.saas_awaiting_first_payment(p_org) THEN
    RETURN 'SAAS_ENTITLEMENT_NOT_ACTIVE';
  END IF;
  IF ent.tier::text <> 'COMPLETE' THEN RETURN 'SAAS_ENTITLEMENT_MISMATCH'; END IF;
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

-- ---------- checkout ----------
CREATE FUNCTION hon.saas_open_hon_os_checkout(p_actor uuid, p_org uuid, p_school uuid, p_offer uuid, p_at timestamptz)
RETURNS hon.saas_checkout_sessions LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE prog hon.saas_payment_program%ROWTYPE; v_offer hon.saas_offer_set_offers%ROWTYPE; stale record; refusal text; snapshot jsonb;
  created hon.saas_checkout_sessions%ROWTYPE;
BEGIN
  SELECT * INTO prog FROM hon.saas_payment_program WHERE program_id = 1 FOR SHARE;
  IF prog.status <> 'TEST_MODE' THEN RAISE EXCEPTION 'SAAS_PAYMENTS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  -- One lock serializes every HON OS sale-limit and founder-pool count with the hold it creates.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.hon_os.inventory', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || p_org::text, 0));
  -- Publishing, retiring and stopping sales wait for this purchase, and it waits for them.
  LOCK TABLE hon.saas_offer_sets, hon.saas_offer_sales_stops IN SHARE MODE;
  PERFORM 1 FROM hon.organizations o WHERE o.id = p_org AND o.status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM hon.organization_entitlements e WHERE e.organization_id = p_org FOR SHARE;
  -- An abandoned checkout past its expiry no longer blocks a new one.
  FOR stale IN SELECT id FROM hon.saas_checkout_sessions WHERE organization_id = p_org AND status IN ('CREATED','OPEN') AND expires_at <= p_at FOR UPDATE LOOP
    PERFORM hon.saas_close_checkout(stale.id, 'EXPIRED', 'LOCAL_EXPIRED', p_actor, p_at);
  END LOOP;
  SELECT o.* INTO v_offer FROM hon.saas_offer_set_offers o WHERE o.id = p_offer;
  refusal := hon.saas_hon_os_refusal(p_org, v_offer, p_at);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '23514'; END IF;
  snapshot := hon.saas_hon_os_accepted_offer(v_offer);
  INSERT INTO hon.saas_checkout_sessions(organization_id,school_id,catalog_id,offer_id,hon_os_offer_id,offer_set_id,accepted_offer,accepted_offer_digest,
      provider_recurring,plan_code,offer_kind,billing_interval,amount_minor,founder_reservation_id,requester_kind,requested_by_principal_id,provider,
      status,status_reason,expires_at,version,created_at,updated_at)
    VALUES (p_org,p_school,NULL,NULL,v_offer.id,v_offer.set_id,snapshot,hon.saas_hon_os_digest(snapshot),snapshot->>'recurringBilling','COMPLETE',
      v_offer.offer_kind,hon.saas_hon_os_billing_interval(v_offer.offer_kind),v_offer.price_minor,NULL,'SCHOOL_OWNER',p_actor,prog.provider,
      'CREATED','CREATED',p_at + interval '23 hours 59 minutes',1,p_at,p_at)
    RETURNING * INTO created;
  RETURN created;
END $$;

CREATE FUNCTION hon.saas_hon_os_purchase_json(c hon.saas_checkout_sessions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('productName','HON OS — ' || (c.accepted_offer->>'displayName'),'offerDisplayName',c.accepted_offer->>'displayName',
    'recurringBilling',c.provider_recurring,'offerSetVersion',(c.accepted_offer->>'offerSetVersion')::integer,
    'termsReference',c.accepted_offer->>'termsReference','acceptedOfferDigest',c.accepted_offer_digest)
$$;

-- The school's only input is the offer ID; price, kind, interval, renewal and every term come from the published offer.
CREATE FUNCTION hon.create_saas_hon_os_checkout_from_school(p_subject text, p_school uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; replay jsonb; created hon.saas_checkout_sessions%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p_school IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['offerId']
    OR coalesce(jsonb_typeof(p->'offerId'), '') <> 'string' OR (p->>'offerId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.family_access_grants IN SHARE MODE;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  replay := hon.saas_claim_request(actor.principal_id, p_key, 'saas.checkout.create_hon_os',
    hon.saas_fingerprint(ARRAY['saas.checkout.create_hon_os', p_school::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  created := hon.saas_open_hon_os_checkout(actor.principal_id, actor.organization_id, p_school, (p->>'offerId')::uuid, at);
  snapshot := hon.saas_checkout_json(created);
  RETURN hon.saas_record(actor.principal_id, p_key, 'saas.checkout.create_hon_os', 'saas.checkout.created', 'CHECKOUT', created.id, created.organization_id,
    NULL, snapshot || jsonb_build_object('acceptedOffer', created.accepted_offer),
    jsonb_build_object('checkout', snapshot, 'purchase', hon.saas_hon_os_purchase_json(created)), at);
END $$;

-- ---------- activation ----------
-- Verified payment for a HON OS checkout: activates only when everything still matches the accepted offer.
CREATE FUNCTION hon.saas_activate_hon_os_checkout(p_checkout uuid, p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); c hon.saas_checkout_sessions%ROWTYPE; o jsonb := p_event->'object';
  ent hon.organization_entitlements%ROWTYPE; v_offer hon.saas_offer_set_offers%ROWTYPE; v_limit integer; used jsonb;
  s hon.saas_subscriptions%ROWTYPE; ev uuid; reason text; prior record; occurred timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.hon_os.inventory', 0));
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || c.organization_id::text, 0));
  IF c.status = 'COMPLETED' THEN RETURN jsonb_build_object('outcome','ALREADY_APPLIED','detail','CHECKOUT_COMPLETED','subscriptionId',c.subscription_id); END IF;
  occurred := (p_event->>'createdAt')::timestamptz;
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = c.organization_id FOR SHARE;
  SELECT * INTO v_offer FROM hon.saas_offer_set_offers WHERE id = c.hon_os_offer_id;
  SELECT founder_total_limit INTO v_limit FROM hon.saas_offer_sets WHERE id = c.offer_set_id;
  used := hon.saas_hon_os_founder_usage(p_at, c.id);
  reason := CASE
    WHEN c.status IN ('EXPIRED','CANCELLED','FAILED','PAID_NEEDS_REVIEW') THEN 'PAID_AFTER_CLOSE'
    -- A checkout is valid only until it expires, even if the expiry sweep has not closed it yet.
    WHEN greatest(occurred, c.created_at) >= c.expires_at THEN 'PAID_AFTER_CLOSE'
    WHEN (o->>'amountTotal')::bigint IS DISTINCT FROM c.amount_minor OR o->>'currency' IS DISTINCT FROM 'usd' THEN 'AMOUNT_MISMATCH'
    -- One-time offers must never have created a provider subscription; recurring offers must have one.
    WHEN (c.provider_recurring = 'NONE') <> (o->>'subscriptionRef' IS NULL) THEN 'RECURRING_MISMATCH'
    WHEN ent.organization_id IS NULL OR ent.status <> 'ACTIVE' OR ent.tier::text <> 'COMPLETE' OR ent.effective_from > p_at
      OR (ent.effective_until IS NOT NULL AND ent.effective_until <= p_at) OR hon.saas_awaiting_first_payment(c.organization_id) THEN 'ENTITLEMENT_CHANGED'
    WHEN EXISTS (SELECT 1 FROM hon.saas_subscriptions x WHERE x.organization_id = c.organization_id AND x.status <> 'VOIDED') THEN 'SUBSCRIPTION_EXISTS'
    -- Owner decision D6 (revised 2026-10-23): a valid checkout keeps its accepted offer if HQ publishes a new price
    -- version or the offer's sales window ends before payment. Only an explicit HQ stop-sales on that offer, at or
    -- before the payment, sends it to review. Provider times have whole-second precision and a payment cannot
    -- precede its checkout, so the payment time is never taken as earlier than the checkout.
    WHEN EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops x WHERE x.offer_id = c.hon_os_offer_id
      AND x.stopped_at <= least(greatest(occurred, c.created_at), p_at)) THEN 'OFFER_SALES_STOPPED'
    WHEN v_offer.sale_limit IS NOT NULL AND hon.saas_hon_os_offer_usage(v_offer.id, p_at, c.id) >= v_offer.sale_limit THEN 'SALE_LIMIT_REACHED'
    WHEN v_offer.founder AND (used->>'allocated')::integer + (used->>'held')::integer >= coalesce(v_limit, 0) THEN 'FOUNDER_UNAVAILABLE' END;
  IF reason IS NOT NULL THEN
    IF c.status <> 'PAID_NEEDS_REVIEW' THEN
      UPDATE hon.saas_checkout_sessions SET status = 'PAID_NEEDS_REVIEW', status_reason = reason, version = version + 1, updated_at = p_at,
          provider_customer_ref = coalesce(provider_customer_ref, o->>'customerRef')
        WHERE id = c.id;
    END IF;
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail',reason);
  END IF;
  INSERT INTO hon.saas_subscriptions(organization_id,source,catalog_id,offer_id,hon_os_offer_id,offer_set_id,accepted_offer,accepted_offer_digest,
      plan_code,entitlement_tier,offer_kind,billing_interval,price_minor,founder_reservation_id,entitlement_version_at_record,status,status_reason,version,
      created_by_principal_id,created_at,updated_at)
    VALUES (c.organization_id,'HON_OS_OFFER',NULL,NULL,c.hon_os_offer_id,c.offer_set_id,c.accepted_offer,c.accepted_offer_digest,
      'COMPLETE',ent.tier,c.offer_kind,c.billing_interval,c.amount_minor,NULL,ent.version,'PENDING_ACTIVATION','RECORDED',1,actor,p_at,p_at)
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
  RETURN jsonb_build_object('outcome','APPLIED','detail','SUBSCRIPTION_ACTIVATED','subscriptionId',s.id,'evidenceId',ev);
END $$;

CREATE OR REPLACE FUNCTION hon.saas_activate_checkout(p_checkout uuid, p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE id = p_checkout AND hon_os_offer_id IS NOT NULL) THEN
    RETURN hon.saas_activate_hon_os_checkout(p_checkout, p_event, p_at);
  END IF;
  RETURN hon.saas_activate_checkout_core(p_checkout, p_event, p_at, false);
END $$;

-- ---------- invoices, renewals and standing (annual periods are 12 months) ----------
CREATE OR REPLACE FUNCTION hon.saas_provider_invoice(p_sub hon.saas_subscriptions, p_period integer, p_amount integer, p_occurred timestamptz,
  p_reference text, p_event jsonb, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); prog hon.saas_payment_program%ROWTYPE; inv hon.saas_invoices%ROWTYPE; v_kind text;
  v_start timestamptz; v_end timestamptz; v_desc text; v_label text; v_year integer; v_seq integer; ev uuid; v_months integer;
BEGIN
  SELECT * INTO prog FROM hon.saas_payment_program WHERE program_id = 1;
  v_months := CASE p_sub.billing_interval WHEN 'MONTHLY' THEN 1 WHEN 'ANNUAL' THEN 12 END;
  IF v_months IS NOT NULL THEN
    v_kind := 'SUBSCRIPTION_PERIOD';
    v_start := p_sub.period_anchor_at + make_interval(months => p_period * v_months);
    v_end := p_sub.period_anchor_at + make_interval(months => (p_period + 1) * v_months);
  ELSE
    v_kind := 'LIFETIME_PURCHASE'; v_start := p_sub.service_started_at;
  END IF;
  SELECT * INTO inv FROM hon.saas_invoices i WHERE i.subscription_id = p_sub.id AND i.status <> 'VOID' AND i.kind = v_kind
    AND i.period_index IS NOT DISTINCT FROM p_period FOR UPDATE;
  IF inv.id IS NULL THEN
    IF p_sub.source = 'HON_OS_OFFER' THEN
      v_desc := 'HON OS — ' || (p_sub.accepted_offer->>'displayName') || CASE WHEN v_kind = 'SUBSCRIPTION_PERIOD'
        THEN ' — service period ' || to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' to ' || to_char(v_end AT TIME ZONE 'UTC', 'YYYY-MM-DD')
        ELSE ' — one-time purchase' END;
    ELSE
      v_label := CASE p_sub.offer_kind WHEN 'REGULAR_MONTHLY' THEN 'monthly' WHEN 'FOUNDER_MONTHLY' THEN 'founder monthly' ELSE 'founder paid lifetime' END;
      SELECT pl.display_name || ' — ' || v_label || CASE WHEN v_kind = 'SUBSCRIPTION_PERIOD'
          THEN ' — service period ' || to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' to ' || to_char(v_end AT TIME ZONE 'UTC', 'YYYY-MM-DD')
          ELSE ' — one-time purchase' END
        INTO v_desc FROM hon.saas_catalog_plans pl WHERE pl.catalog_id = p_sub.catalog_id AND pl.plan_code = p_sub.plan_code;
    END IF;
    INSERT INTO hon.saas_invoices(organization_id,subscription_id,kind,period_index,service_period_start,service_period_end,plan_code,offer_kind,
        description,status,version,subtotal_minor,tax_status,created_by_principal_id,created_at,updated_at)
      VALUES (p_sub.organization_id,p_sub.id,v_kind,p_period,v_start,v_end,p_sub.plan_code,p_sub.offer_kind,v_desc,'DRAFT',1,p_sub.price_minor,'UNRESOLVED',actor,p_at,p_at)
      RETURNING * INTO inv;
    INSERT INTO hon.saas_invoice_lines(invoice_id,line_number,line_kind,description,amount_minor,created_by_principal_id,created_at)
      VALUES (inv.id,1,'PLAN_FEE',v_desc,p_sub.price_minor,actor,p_at);
  END IF;
  IF inv.status = 'DRAFT' THEN
    IF inv.tax_status = 'UNRESOLVED' THEN
      -- TAXES is undecided: test mode records the owner's test-mode tax reference, never an assumed rate.
      UPDATE hon.saas_invoices SET tax_status = 'NO_TAX_APPLICABLE', tax_minor = 0, tax_verification_reference = prog.test_tax_reference,
          total_minor = subtotal_minor, version = version + 1, updated_at = p_at WHERE id = inv.id RETURNING * INTO inv;
    END IF;
    IF inv.total_minor <> p_amount THEN RAISE EXCEPTION 'SAAS_PROVIDER_AMOUNT_MISMATCH' USING ERRCODE = '23514'; END IF;
    v_year := extract(year FROM p_at AT TIME ZONE 'UTC')::integer;
    INSERT INTO hon.saas_invoice_sequences(invoice_year, last_number) VALUES (v_year, 0) ON CONFLICT (invoice_year) DO NOTHING;
    UPDATE hon.saas_invoice_sequences SET last_number = last_number + 1 WHERE invoice_year = v_year RETURNING last_number INTO v_seq;
    UPDATE hon.saas_invoices SET status = 'ISSUED', invoice_number = 'HON-' || v_year || '-' || lpad(v_seq::text, 6, '0'),
        issued_by_principal_id = actor, issued_at = p_at, version = version + 1, updated_at = p_at WHERE id = inv.id RETURNING * INTO inv;
  END IF;
  IF inv.total_minor - (SELECT f.net_minor FROM hon.saas_invoice_facts(NULL, inv.id) f) < p_amount THEN
    RAISE EXCEPTION 'SAAS_PROVIDER_AMOUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.saas_payment_evidence(invoice_id,organization_id,subscription_id,kind,source,provider_event_id,provider_code,provider_mode,amount_minor,
      occurred_at,reference,recorded_by_principal_id,recorded_at)
    VALUES (inv.id,p_sub.organization_id,p_sub.id,'PAYMENT_RECEIVED','PROVIDER_VERIFIED',p_event->>'eventId',p_event->>'provider','TEST',p_amount,
      least(p_occurred, p_at),p_reference,actor,p_at)
    RETURNING id INTO ev;
  RETURN ev;
END $$;

CREATE OR REPLACE FUNCTION hon.saas_apply_renewal(p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); o jsonb := p_event->'object'; c hon.saas_checkout_sessions%ROWTYPE; s hon.saas_subscriptions%ROWTYPE;
  v_start timestamptz := (o->>'periodStart')::timestamptz; n integer; ev uuid; v_months integer;
BEGIN
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND provider_subscription_ref = o->>'subscriptionRef';
  IF c.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND status IN ('CREATED','OPEN')) THEN
      RAISE EXCEPTION 'SAAS_PROVIDER_EVENT_NOT_READY' USING ERRCODE = '55006';
    END IF;
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','UNKNOWN_PROVIDER_SUBSCRIPTION');
  END IF;
  SELECT * INTO s FROM hon.saas_subscriptions WHERE id = c.subscription_id FOR UPDATE;
  -- Only monthly subscriptions and HON OS annual subscriptions that auto-renew are billed again by the provider.
  v_months := CASE WHEN s.billing_interval = 'MONTHLY' THEN 1 WHEN s.billing_interval = 'ANNUAL' AND c.provider_recurring = 'YEAR' THEN 12 END;
  IF s.status NOT IN ('IN_SERVICE','SUSPENDED') OR v_months IS NULL THEN
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','SUBSCRIPTION_NOT_BILLABLE','subscriptionId',s.id,'organizationId',s.organization_id);
  END IF;
  -- The provider's period must line up (within a day) with one of HON's anchored periods.
  SELECT g INTO n FROM generate_series(0, s.period_index + 1) g
    WHERE abs(extract(epoch FROM (s.period_anchor_at + make_interval(months => g * v_months)) - v_start)) <= 86400 ORDER BY g LIMIT 1;
  IF n IS NULL THEN RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','PERIOD_MISMATCH','subscriptionId',s.id,'organizationId',s.organization_id); END IF;
  -- Renewals are always at the accepted price: HON never reprices an existing subscription.
  IF (o->>'amountPaid')::integer <> s.price_minor OR o->>'currency' <> 'usd' THEN
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','AMOUNT_MISMATCH','subscriptionId',s.id,'organizationId',s.organization_id);
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_free_periods f WHERE f.subscription_id = s.id AND f.period_index = n) THEN
    -- A Champions free month was charged by the provider: never invoiced; the HQ owner reviews it.
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','FREE_PERIOD_CHARGED','subscriptionId',s.id,'organizationId',s.organization_id);
  END IF;
  IF n = s.period_index + 1 THEN
    UPDATE hon.saas_subscriptions SET status_reason = 'PERIOD_ELAPSED', version = version + 1, period_index = period_index + 1,
        current_period_start = period_anchor_at + make_interval(months => (period_index + 1) * v_months),
        current_period_end = period_anchor_at + make_interval(months => (period_index + 2) * v_months), updated_at = p_at
      WHERE id = s.id RETURNING * INTO s;
    INSERT INTO hon.saas_subscription_history(subscription_id,version,status,status_reason,period_index,current_period_start,current_period_end,actor_principal_id,occurred_at)
      VALUES (s.id,s.version,s.status,s.status_reason,s.period_index,s.current_period_start,s.current_period_end,actor,p_at);
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_provider_payment_refs r WHERE r.provider = p_event->>'provider' AND r.ref IN (o->>'invoiceRef', o->>'paymentIntentRef')) THEN
    RETURN jsonb_build_object('outcome','ALREADY_APPLIED','detail','PAYMENT_ALREADY_RECORDED','subscriptionId',s.id,'organizationId',s.organization_id);
  END IF;
  ev := hon.saas_provider_invoice(s, n, (o->>'amountPaid')::integer, (p_event->>'createdAt')::timestamptz, o->>'invoiceRef', p_event, p_at);
  PERFORM hon.saas_link_payment_refs(p_event->>'provider', ARRAY[o->>'invoiceRef', o->>'paymentIntentRef'], ev, p_at);
  RETURN jsonb_build_object('outcome','APPLIED','detail','RENEWAL_RECORDED','subscriptionId',s.id,'organizationId',s.organization_id,'evidenceId',ev);
END $$;

CREATE OR REPLACE FUNCTION hon.saas_payment_standing_strength(p_organization uuid, p_verified boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH cur AS (SELECT * FROM hon.saas_subscriptions s WHERE s.organization_id = p_organization AND s.status <> 'VOIDED'),
  x AS (SELECT f.*, CASE WHEN p_verified THEN f.verified_net_minor >= f.total_minor ELSE f.net_minor >= f.total_minor END AS paid,
      CASE WHEN p_verified THEN f.last_verified_received_at ELSE f.last_received_at END AS paid_at,
      CASE WHEN p_verified THEN f.verified_refunded_minor ELSE f.refunded_minor END AS refunds,
      CASE WHEN p_verified THEN f.verified_charged_back_minor ELSE f.charged_back_minor END AS chargebacks
    FROM hon.saas_invoice_facts(p_organization, NULL) f WHERE f.status = 'ISSUED'),
  gap AS (SELECT cur.id, coalesce((SELECT min(g) FROM generate_series(0, cur.period_index) g
      WHERE NOT EXISTS (SELECT 1 FROM x WHERE x.subscription_id = cur.id AND x.period_index = g AND x.paid)), cur.period_index + 1) AS n
    FROM cur WHERE cur.billing_interval IN ('MONTHLY','ANNUAL') AND cur.period_index IS NOT NULL)
  SELECT jsonb_build_object(
    'firstPaidAt', hon.saas_ts((SELECT min(x.paid_at) FROM x WHERE x.paid)),
    'paidThroughAt', hon.saas_ts((SELECT x.service_period_end FROM gap JOIN x ON x.subscription_id = gap.id AND x.period_index = gap.n - 1 AND x.paid)),
    'lifetimePaid', EXISTS (SELECT 1 FROM cur JOIN x ON x.subscription_id = cur.id AND x.kind = 'LIFETIME_PURCHASE' AND x.paid
      WHERE cur.billing_interval = 'LIFETIME'),
    'paidInvoiceCount', (SELECT count(*) FROM x WHERE x.paid),
    'refundedInvoiceCount', (SELECT count(*) FROM x WHERE x.refunds > 0),
    'chargebackInvoiceCount', (SELECT count(*) FROM x WHERE x.chargebacks > 0))
$$;

CREATE OR REPLACE FUNCTION hon.saas_subscription_payment(s hon.saas_subscriptions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE rec jsonb; ver jsonb; latest record; v_status text; failed_last boolean; periodic boolean := s.billing_interval IN ('MONTHLY','ANNUAL');
BEGIN
  IF s.source NOT IN ('CATALOG_OFFER','HON_OS_OFFER') OR s.status = 'VOIDED' THEN
    RETURN jsonb_build_object('paymentStatus','NOT_BILLED','paidThroughAt',NULL,'paymentVerification','NONE');
  END IF;
  rec := hon.saas_payment_standing_strength(s.organization_id, false);
  ver := hon.saas_payment_standing_strength(s.organization_id, true);
  SELECT f.* INTO latest FROM hon.saas_invoice_facts(s.organization_id, NULL) f
    WHERE f.subscription_id = s.id AND f.status = 'ISSUED' ORDER BY f.period_index DESC NULLS FIRST, f.invoice_id LIMIT 1;
  -- Latest money event by provider time (arrival breaks ties): a failure after the last payment is PAST_DUE.
  SELECT e.event_type = 'invoice.payment_failed' INTO failed_last FROM hon.saas_provider_events e
    WHERE e.subscription_id = s.id AND e.outcome = 'APPLIED'
      AND e.event_type IN ('invoice.payment_failed','invoice.paid','checkout.session.completed','checkout.session.async_payment_succeeded')
    ORDER BY e.provider_created_at DESC, e.received_at DESC LIMIT 1;
  v_status := CASE
    WHEN latest.invoice_id IS NULL THEN 'NOT_BILLED'
    WHEN latest.charged_back_minor > 0 THEN 'DISPUTED'
    WHEN latest.refunded_minor > 0 AND latest.net_minor < latest.total_minor THEN 'REFUNDED'
    WHEN s.billing_interval = 'LIFETIME' AND (rec->>'lifetimePaid')::boolean THEN 'PAID'
    WHEN periodic AND (rec->>'paidThroughAt')::timestamptz > clock_timestamp() THEN 'PAID'
    WHEN coalesce(failed_last, false) THEN 'PAST_DUE'
    ELSE 'DUE' END;
  RETURN jsonb_build_object('paymentStatus',v_status,
    'paidThroughAt',CASE WHEN periodic THEN rec->>'paidThroughAt' END,
    'paymentVerification',CASE WHEN v_status <> 'PAID' THEN 'NONE'
      WHEN (s.billing_interval = 'LIFETIME' AND (ver->>'lifetimePaid')::boolean)
        OR (periodic AND ver->>'paidThroughAt' IS NOT DISTINCT FROM rec->>'paidThroughAt') THEN 'PROVIDER_VERIFIED'
      ELSE 'HQ_ATTESTED' END);
END $$;

-- ---------- reads ----------
-- Planned monthly premium credits of a subscription (planning only; never a grant by itself).
CREATE FUNCTION hon.saas_planned_monthly_credits(s hon.saas_subscriptions) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN s.source = 'HON_OS_OFFER' THEN (s.accepted_offer->>'plannedMonthlyPremiumCredits')::integer
    ELSE (SELECT p.planned_monthly_premium_credits FROM hon.saas_catalog_plans p WHERE p.catalog_id = s.catalog_id AND p.plan_code = s.plan_code) END
$$;

-- Same keys as before: HON OS rows carry no catalog version, their offer ID is the HON OS offer and planned credits
-- come from the accepted offer.
CREATE OR REPLACE FUNCTION hon.saas_subscription_json(s hon.saas_subscriptions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('subscriptionId',s.id,'organizationId',s.organization_id,
    'organizationName',(SELECT o.display_name FROM hon.organizations o WHERE o.id = s.organization_id),
    'source',s.source,'catalogVersion',(SELECT c.catalog_version FROM hon.saas_catalog_versions c WHERE c.id = s.catalog_id),
    'offerId',coalesce(s.offer_id, s.hon_os_offer_id),'planCode',s.plan_code,'entitlementTier',s.entitlement_tier::text,'offerKind',s.offer_kind,
    'billingInterval',s.billing_interval,'priceMinor',s.price_minor,'currency',s.currency,'founderReservationId',s.founder_reservation_id,
    'status',s.status,'statusReason',s.status_reason,'version',s.version,'serviceStartedAt',hon.saas_ts(s.service_started_at),
    'currentPeriod',CASE WHEN s.current_period_start IS NULL THEN NULL ELSE jsonb_build_object('index',s.period_index,
      'startsAt',hon.saas_ts(s.current_period_start),'endsAt',hon.saas_ts(s.current_period_end)) END,
    'paymentStatus',pay->>'paymentStatus','paidThroughAt',pay->>'paidThroughAt',
    'chargesEnabled',false,
    'premiumCredits',jsonb_build_object('plannedMonthlyAllowance',hon.saas_planned_monthly_credits(s),'status','NOT_GRANTED'),
    'createdAt',hon.saas_ts(s.created_at),'updatedAt',hon.saas_ts(s.updated_at))
  FROM (SELECT hon.saas_subscription_payment(s) pay) x
$$;

CREATE OR REPLACE FUNCTION hon.saas_checkout_json(c hon.saas_checkout_sessions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('checkoutId',c.id,'organizationId',c.organization_id,'schoolId',c.school_id,'offerId',coalesce(c.offer_id, c.hon_os_offer_id),
    'planCode',c.plan_code,'offerKind',c.offer_kind,'billingInterval',c.billing_interval,'amountMinor',c.amount_minor,'currency',c.currency,
    'founderReservationId',c.founder_reservation_id,'requesterKind',c.requester_kind,'provider',c.provider,'mode',c.provider_mode,
    'providerSessionId',c.provider_session_id,'checkoutUrl',CASE WHEN c.status = 'OPEN' THEN c.checkout_url END,
    'status',c.status,'statusReason',c.status_reason,'subscriptionId',c.subscription_id,'invoiceId',c.invoice_id,
    'expiresAt',hon.saas_ts(c.expires_at),'version',c.version,'createdAt',hon.saas_ts(c.created_at),'completedAt',hon.saas_ts(c.completed_at))
$$;

-- ---------- premium credits (the program stays INACTIVE; this only decides what a grant would be) ----------
CREATE OR REPLACE FUNCTION hon.saas_current_allowance(p_subscription uuid, p_actor uuid, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE s hon.saas_subscriptions%ROWTYPE; per record; v_id uuid; v_credits integer; v_basis text; old record; remaining integer;
BEGIN
  SELECT * INTO s FROM hon.saas_subscriptions WHERE id = p_subscription;
  FOR old IN SELECT a.id FROM hon.saas_credit_allowances a WHERE a.subscription_id = p_subscription AND a.status = 'OPEN' AND a.period_end <= p_at LOOP
    remaining := (hon.saas_allowance_balance(old.id)->>'availableCredits')::integer;
    IF remaining > 0 THEN
      INSERT INTO hon.saas_credit_ledger(allowance_id, entry_kind, credits, actor_principal_id, occurred_at) VALUES (old.id, 'EXPIRE', remaining, p_actor, p_at);
    END IF;
    UPDATE hon.saas_credit_allowances SET status = 'EXPIRED', expired_at = p_at, version = version + 1 WHERE id = old.id;
  END LOOP;
  SELECT * INTO per FROM hon.saas_allowance_period(s, p_at);
  IF per.period_index IS NULL OR p_at >= per.period_end OR p_at < per.period_start
    -- An annual term has monthly allowances only inside its current paid 12-month period.
    OR (s.billing_interval = 'ANNUAL' AND per.period_start >= s.current_period_end) THEN
    RAISE EXCEPTION 'SAAS_ALLOWANCE_PERIOD_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  SELECT a.id INTO v_id FROM hon.saas_credit_allowances a WHERE a.subscription_id = p_subscription AND a.period_index = per.period_index;
  IF v_id IS NOT NULL THEN
    IF (SELECT status FROM hon.saas_credit_allowances WHERE id = v_id) <> 'OPEN' THEN RAISE EXCEPTION 'SAAS_ALLOWANCE_PERIOD_UNAVAILABLE' USING ERRCODE = '23514'; END IF;
    RETURN v_id;
  END IF;
  -- Opening is a grant: only for an in-service subscription while the HQ owner has activated the program.
  IF s.status <> 'IN_SERVICE' THEN RAISE EXCEPTION 'SAAS_SUBSCRIPTION_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF NOT hon.saas_credit_program_active() THEN RAISE EXCEPTION 'SAAS_CREDITS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF s.source = 'CATALOG_OFFER' THEN
    SELECT p.planned_monthly_premium_credits INTO v_credits FROM hon.saas_catalog_plans p WHERE p.catalog_id = s.catalog_id AND p.plan_code = s.plan_code;
    v_basis := CASE s.offer_kind WHEN 'REGULAR_MONTHLY' THEN 'REGULAR' WHEN 'FOUNDER_MONTHLY' THEN 'FOUNDER' ELSE 'LIFETIME' END;
  ELSIF s.source = 'HON_OS_OFFER' THEN
    -- The accepted offer's monthly allowance, for every kind (owner decision D5).
    v_credits := (s.accepted_offer->>'plannedMonthlyPremiumCredits')::integer;
    v_basis := CASE WHEN s.offer_kind IN ('LIFETIME','FOUNDER_LIFETIME') THEN 'LIFETIME' WHEN s.offer_kind LIKE 'FOUNDER\_%' THEN 'FOUNDER' ELSE 'REGULAR' END;
  ELSE
    -- Legacy Core/Complete records take the currently published plan allowance for their tier.
    SELECT p.planned_monthly_premium_credits INTO v_credits FROM hon.saas_catalog_plans p JOIN hon.saas_catalog_versions c ON c.id = p.catalog_id
      WHERE c.status = 'PUBLISHED' AND p.plan_code = s.plan_code;
    v_basis := 'LEGACY';
  END IF;
  IF s.plan_code NOT IN ('CORE','COMPLETE') OR v_credits IS NULL OR v_credits < 1 THEN
    RAISE EXCEPTION 'SAAS_NO_PREMIUM_ALLOWANCE' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.saas_credit_allowances(subscription_id, organization_id, period_index, period_start, period_end, plan_code, allowance_basis,
      allowance_credits, status, version, opened_by_principal_id, opened_at)
    VALUES (s.id, s.organization_id, per.period_index, per.period_start, per.period_end, s.plan_code, v_basis, v_credits, 'OPEN', 1, p_actor, p_at)
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION hon.read_saas_school_billing_account(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; s hon.saas_subscriptions%ROWTYPE; cond jsonb; ent jsonb; per record; v_allowance uuid; allowance jsonb;
  bal jsonb; v_program text; v_planned integer; v_state text; v_activation text; v_alignment text; history jsonb; subs jsonb; refunds jsonb;
  standing jsonb; in_effect boolean; paid boolean;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_billing_viewer(p_subject, p_school) LIMIT 1;
  cond := hon.saas_access_condition(scope.organization_id);
  ent := cond->'entitlement';
  in_effect := coalesce((ent->>'inEffect')::boolean, false);
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = scope.organization_id AND status <> 'VOIDED';
  paid := cond->>'paymentStatus' = 'PAID';
  v_alignment := CASE WHEN s.id IS NULL THEN 'NO_SUBSCRIPTION' WHEN s.status <> 'IN_SERVICE' THEN 'SUBSCRIPTION_NOT_IN_SERVICE'
    WHEN (cond->>'planMatchesEntitlement')::boolean THEN 'ALIGNED' ELSE 'PLAN_MISMATCH' END;
  -- Readiness is read from the entitlement; a payment alone never makes an account ready.
  v_activation := CASE WHEN in_effect AND v_alignment IN ('ALIGNED','NO_SUBSCRIPTION') THEN 'READY'
    WHEN paid THEN 'PENDING_ACCOUNT_ACTIVATION' ELSE 'UNAVAILABLE' END;

  v_program := (SELECT status FROM hon.saas_credit_program WHERE program_id = 1);
  IF s.id IS NOT NULL THEN
    v_planned := hon.saas_planned_monthly_credits(s);
    IF s.status = 'IN_SERVICE' THEN
      SELECT * INTO per FROM hon.saas_allowance_period(s, clock_timestamp());
      SELECT a.id INTO v_allowance FROM hon.saas_credit_allowances a WHERE a.subscription_id = s.id AND a.period_index = per.period_index;
    END IF;
  END IF;
  IF v_allowance IS NOT NULL THEN
    allowance := hon.saas_allowance_json(v_allowance); bal := allowance->'balance';
  END IF;
  v_state := CASE WHEN NOT in_effect THEN 'ACCESS_NOT_ACTIVE' WHEN s.id IS NULL THEN 'NO_SUBSCRIPTION'
    WHEN s.status = 'SUSPENDED' THEN 'SUSPENDED' WHEN s.status <> 'IN_SERVICE' THEN 'SUBSCRIPTION_NOT_IN_SERVICE'
    WHEN v_program <> 'ACTIVE' THEN 'PROGRAM_INACTIVE' WHEN v_allowance IS NULL THEN 'NOT_YET_OPENED'
    WHEN allowance->>'status' <> 'OPEN' THEN 'PERIOD_CLOSED' WHEN (bal->>'availableCredits')::int = 0 THEN 'EXHAUSTED' ELSE 'AVAILABLE' END;

  SELECT coalesce(jsonb_agg(jsonb_build_object('version',h.version,'status',h.status,'statusReason',h.status_reason,'periodIndex',h.period_index,
      'periodStart',hon.saas_ts(h.current_period_start),'periodEnd',hon.saas_ts(h.current_period_end),'occurredAt',hon.saas_ts(h.occurred_at))
      ORDER BY h.version), '[]'::jsonb) INTO history
    FROM hon.saas_subscription_history h WHERE h.subscription_id = s.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('subscriptionId',x.id,'source',x.source,
      'catalogVersion',(SELECT c.catalog_version FROM hon.saas_catalog_versions c WHERE c.id = x.catalog_id),
      'planCode',x.plan_code,'offerKind',x.offer_kind,'billingInterval',x.billing_interval,'priceMinor',x.price_minor,'currency',x.currency,
      'status',x.status,'statusReason',x.status_reason,'serviceStartedAt',hon.saas_ts(x.service_started_at),'createdAt',hon.saas_ts(x.created_at))
      ORDER BY x.created_at DESC, x.id), '[]'::jsonb) INTO subs
    FROM (SELECT * FROM hon.saas_subscriptions WHERE organization_id = scope.organization_id ORDER BY created_at DESC, id LIMIT 20) x;
  SELECT coalesce(jsonb_agg(hon.saas_school_refund_json(r) ORDER BY r.created_at DESC, r.id), '[]'::jsonb) INTO refunds
    FROM (SELECT * FROM hon.saas_refund_requests WHERE organization_id = scope.organization_id ORDER BY created_at DESC, id LIMIT 50) r;
  standing := hon.saas_payment_standing(scope.organization_id);

  RETURN jsonb_build_object('schoolId', p_school, 'organizationId', scope.organization_id,
    'organizationName', (SELECT o.display_name FROM hon.organizations o WHERE o.id = scope.organization_id),
    'billingScope', 'ORGANIZATION',
    'schoolCount', (SELECT count(*)::int FROM hon.schools sc WHERE sc.organization_id = scope.organization_id AND sc.status = 'ACTIVE'),
    'entitlement', ent,
    'access', jsonb_build_object('source', CASE WHEN ent IS NULL THEN 'NONE'
        WHEN EXISTS (SELECT 1 FROM hon.saas_access_states x WHERE x.organization_id = scope.organization_id AND x.state = 'PAYMENT_ACTIVE') THEN 'PAYMENT_ACTIVATED'
        ELSE 'PROVISIONED' END,
      'paymentActivated', EXISTS (SELECT 1 FROM hon.saas_access_states x WHERE x.organization_id = scope.organization_id AND x.state = 'PAYMENT_ACTIVE'),
      'state', (hon.saas_organization_access(scope.organization_id)->>'state'),
      'paidAccessProgram', (SELECT status FROM hon.saas_access_program WHERE program_id = 1), 'activation', v_activation, 'alignment', v_alignment),
    'subscription', CASE WHEN s.id IS NULL THEN NULL ELSE hon.saas_subscription_json(s) - 'organizationName' END,
    'subscriptionHistory', history, 'subscriptions', subs,
    'payment', jsonb_build_object('status', cond->>'paymentStatus', 'verification', cond->>'paymentVerification',
      'paidThroughAt', cond->>'paidThroughAt', 'unpaidSince', cond->>'unpaidSince',
      'verified', standing->'verified', 'recorded', standing->'recorded', 'evidenceCounts', standing->'evidence',
      'providerVerification', standing->>'providerVerification'),
    'allowance', jsonb_build_object('state', v_state, 'programStatus', v_program, 'plannedMonthlyCredits', v_planned,
      'period', CASE WHEN allowance IS NULL THEN NULL ELSE jsonb_build_object('index', (allowance->>'periodIndex')::int,
        'startsAt', allowance->>'periodStart', 'endsAt', allowance->>'periodEnd') END,
      'basis', allowance->>'allowanceBasis',
      'grantedCredits', (bal->>'allowanceCredits')::int, 'consumedCredits', (bal->>'consumedCredits')::int,
      'reservedCredits', (bal->>'heldCredits')::int, 'remainingCredits', (bal->>'availableCredits')::int, 'usedPercent', (bal->>'usedPercent')::int,
      'suspensionPolicy', 'UNDECIDED', 'topUps', 'UNAVAILABLE'),
    'refunds', refunds, 'cardDataStored', false, 'asOf', hon.saas_ts(clock_timestamp()));
END $$;

-- ---------- refunds: the accepted offer's window (legacy purchases keep 720 hours) ----------
CREATE FUNCTION hon.saas_refund_window_hours(p_subscription uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce((SELECT CASE WHEN s.source = 'HON_OS_OFFER' THEN coalesce((s.accepted_offer->>'refundWindowDays')::integer, 0) * 24 ELSE 720 END
    FROM hon.saas_subscriptions s WHERE s.id = p_subscription), 720)
$$;

CREATE OR REPLACE FUNCTION hon.saas_refund_eligibility(p_organization uuid, p_received_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE inv hon.saas_invoices%ROWTYPE; first_paid timestamptz; net bigint; reason text; verified bigint; v_window interval;
BEGIN
  SELECT i.* INTO inv FROM hon.saas_invoices i JOIN hon.saas_payment_evidence e ON e.invoice_id = i.id AND e.kind = 'PAYMENT_RECEIVED'
    WHERE i.organization_id = p_organization AND i.status = 'ISSUED' GROUP BY i.id ORDER BY min(e.occurred_at), i.id LIMIT 1;
  IF inv.id IS NOT NULL THEN
    SELECT min(e.occurred_at) INTO first_paid FROM hon.saas_payment_evidence e WHERE e.invoice_id = inv.id AND e.kind = 'PAYMENT_RECEIVED';
    SELECT f.net_minor, f.verified_net_minor INTO net, verified FROM hon.saas_invoice_facts(NULL, inv.id) f;
  END IF;
  v_window := hon.saas_refund_window_hours(inv.subscription_id) * interval '1 hour';
  reason := CASE WHEN inv.id IS NULL THEN 'SAAS_REFUND_NO_PAID_PURCHASE'
    WHEN EXISTS (SELECT 1 FROM hon.saas_refund_requests r WHERE r.organization_id = p_organization AND r.status IN ('APPROVED','REFUND_EVIDENCED')) THEN 'SAAS_REFUND_ALREADY_GRANTED'
    WHEN EXISTS (SELECT 1 FROM hon.saas_refund_requests r WHERE r.organization_id = p_organization AND r.status = 'REQUESTED') THEN 'SAAS_REFUND_REQUEST_OPEN'
    WHEN p_received_at < first_paid THEN 'SAAS_REFUND_BEFORE_PAYMENT'
    WHEN p_received_at >= first_paid + v_window THEN 'SAAS_REFUND_WINDOW_EXPIRED'
    WHEN coalesce(net, 0) <= 0 THEN 'SAAS_REFUND_NOTHING_TO_REFUND' END;
  RETURN jsonb_build_object('organizationId', p_organization, 'eligible', reason IS NULL, 'refusal', reason,
    'invoiceId', inv.id, 'invoiceNumber', inv.invoice_number, 'subscriptionId', inv.subscription_id, 'offerKind', inv.offer_kind,
    'firstPaidAt', hon.saas_ts(first_paid), 'windowEndsAt', hon.saas_ts(first_paid + v_window),
    'requestReceivedAt', hon.saas_ts(p_received_at), 'refundableMinor', CASE WHEN inv.id IS NULL THEN 0 ELSE greatest(coalesce(net, 0), 0) END,
    'evidenceStrength', CASE WHEN inv.id IS NULL THEN NULL WHEN coalesce(verified, 0) >= coalesce(net, 0) AND coalesce(net, 0) > 0 THEN 'PROVIDER_VERIFIED' ELSE 'HQ_ATTESTED' END,
    'execution', 'UNAVAILABLE');
END $$;

CREATE OR REPLACE FUNCTION hon.create_saas_refund_request(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; v_org uuid; v_received timestamptz; elig jsonb; created hon.saas_refund_requests%ROWTYPE; at timestamptz; snapshot jsonb;
  v_hours integer;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['customerReference','note','organizationId','requestReceivedAt']
    OR coalesce(jsonb_typeof(p->'organizationId'), '') <> 'string'
    OR coalesce(jsonb_typeof(p->'requestReceivedAt'), '') <> 'string' OR (p->>'requestReceivedAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR coalesce(jsonb_typeof(p->'customerReference'), '') <> 'string' OR length(p->>'customerReference') NOT BETWEEN 1 AND 200
    OR btrim(p->>'customerReference') <> p->>'customerReference'
    OR coalesce(jsonb_typeof(p->'note'), '') NOT IN ('string','null') OR (jsonb_typeof(p->'note') = 'string' AND length(p->>'note') NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_org := (p->>'organizationId')::uuid; v_received := (p->>'requestReceivedAt')::timestamptz;
  actor := hon.require_saas_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, false);
  replay := hon.saas_claim_request(actor, p_key, 'saas.refund.request', hon.saas_fingerprint(ARRAY['saas.refund.request', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.refund:' || v_org::text, 0));
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = v_org) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  at := clock_timestamp();
  IF v_received > at THEN RAISE EXCEPTION 'SAAS_EVIDENCE_IN_FUTURE' USING ERRCODE = '23514'; END IF;
  elig := hon.saas_refund_eligibility(v_org, v_received);
  IF NOT (elig->>'eligible')::boolean THEN RAISE EXCEPTION '%', elig->>'refusal' USING ERRCODE = '23514'; END IF;
  v_hours := hon.saas_refund_window_hours((elig->>'subscriptionId')::uuid);
  INSERT INTO hon.saas_refund_requests(organization_id, subscription_id, invoice_id, offer_kind, first_paid_at, window_hours, window_ends_at, request_received_at,
      customer_reference, requested_amount_minor, evidence_strength, status, status_reason, version, note, requested_by_principal_id, created_at)
    VALUES (v_org, (elig->>'subscriptionId')::uuid, (elig->>'invoiceId')::uuid, elig->>'offerKind', (elig->>'firstPaidAt')::timestamptz, v_hours,
      (elig->>'firstPaidAt')::timestamptz + v_hours * interval '1 hour', v_received, p->>'customerReference', (elig->>'refundableMinor')::integer,
      elig->>'evidenceStrength', 'REQUESTED', 'REQUESTED', 1, p->>'note', actor, at)
    RETURNING * INTO created;
  INSERT INTO hon.saas_refund_history(refund_request_id, version, status, status_reason, amount_minor, actor_principal_id, occurred_at)
    VALUES (created.id, 1, created.status, created.status_reason, created.requested_amount_minor, actor, at);
  snapshot := hon.saas_refund_json(created);
  RETURN hon.saas_record(actor, p_key, 'saas.refund.request', 'saas.refund.requested', 'REFUND_REQUEST', created.id, v_org, NULL, snapshot,
    jsonb_build_object('refundRequest', snapshot), at);
END $$;

CREATE OR REPLACE FUNCTION hon.read_saas_refund_reserve_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE at timestamptz := clock_timestamp(); exposure jsonb; approved jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  WITH first_purchase AS (
    SELECT DISTINCT ON (i.organization_id) i.organization_id, i.id invoice_id, i.subscription_id, i.offer_kind, min(e.occurred_at) OVER (PARTITION BY i.id) first_paid
    FROM hon.saas_invoices i JOIN hon.saas_payment_evidence e ON e.invoice_id = i.id AND e.kind = 'PAYMENT_RECEIVED'
    WHERE i.status = 'ISSUED' ORDER BY i.organization_id, min(e.occurred_at) OVER (PARTITION BY i.id), i.id),
  windowed AS (SELECT fp.*, fp.first_paid + hon.saas_refund_window_hours(fp.subscription_id) * interval '1 hour' window_ends FROM first_purchase fp),
  open_window AS (
    SELECT w.*, f.net_minor FROM windowed w CROSS JOIN LATERAL hon.saas_invoice_facts(NULL, w.invoice_id) f
    WHERE at < w.window_ends AND f.net_minor > 0
      AND NOT EXISTS (SELECT 1 FROM hon.saas_refund_requests r WHERE r.organization_id = w.organization_id AND r.status <> 'DENIED'))
  SELECT jsonb_build_object('organizations', count(*), 'totalMinor', coalesce(sum(net_minor), 0),
      'paidLifetimeMinor', coalesce(sum(net_minor) FILTER (WHERE offer_kind IN ('FOUNDER_LIFETIME','LIFETIME')), 0),
      'monthlyMinor', coalesce(sum(net_minor) FILTER (WHERE offer_kind NOT IN ('FOUNDER_LIFETIME','LIFETIME')), 0),
      'earliestWindowEndsAt', hon.saas_ts(min(window_ends)))
    INTO exposure FROM open_window;
  SELECT jsonb_build_object('requests', count(*), 'totalMinor', coalesce(sum(approved_amount_minor), 0)) INTO approved
    FROM hon.saas_refund_requests WHERE status = 'APPROVED';
  RETURN jsonb_build_object('asOf', hon.saas_ts(at), 'windowExposure', exposure, 'approvedNotEvidenced', approved,
    'pendingRequests', (SELECT jsonb_build_object('requests', count(*), 'totalMinor', coalesce(sum(requested_amount_minor), 0)) FROM hon.saas_refund_requests WHERE status = 'REQUESTED'),
    'recommendedReserveMinor', (exposure->>'totalMinor')::bigint + (approved->>'totalMinor')::bigint
      + (SELECT coalesce(sum(requested_amount_minor), 0) FROM hon.saas_refund_requests WHERE status = 'REQUESTED'),
    'evidenceStrength', 'RECORDED', 'currency', 'USD', 'execution', 'UNAVAILABLE');
END $$;

-- ---------- emergency stop-sales (owner decision D6, revised) ----------
-- A routine price change (a new published version) leaves open checkouts on the retired offer valid. HQ can still stop
-- them explicitly: stopping sales is allowed on a published offer, and on a retired offer while it has a live checkout.
CREATE OR REPLACE FUNCTION hon.stop_saas_offer_sales(p_subject text, p_offer uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; o hon.saas_offer_set_offers%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p_offer IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['reasonCode']
    OR jsonb_typeof(p->'reasonCode') <> 'string' OR p->>'reasonCode' NOT IN ('OWNER_DISABLED','PRICE_CHANGE_PENDING','TERMS_REVIEW') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.saas_offer_owner(p_subject);
  replay := hon.saas_claim_request(actor, p_key, 'saas.offers.stop_sales', hon.saas_fingerprint(ARRAY['saas.offers.stop_sales', p_offer::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.offer_sets', 0));
  -- Serialized with checkout opening and payment activation, so a stop is either before or after each of them.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.hon_os.inventory', 0));
  SELECT * INTO o FROM hon.saas_offer_set_offers WHERE id = p_offer;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  at := clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM hon.saas_offer_sets s WHERE s.id = o.set_id AND (s.status = 'PUBLISHED'
      OR (s.status = 'RETIRED' AND EXISTS (SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.hon_os_offer_id = o.id
        AND c.status IN ('CREATED','OPEN') AND c.expires_at > at)))) THEN
    RAISE EXCEPTION 'SAAS_OFFER_NOT_PUBLISHED' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops WHERE offer_id = p_offer) THEN
    RAISE EXCEPTION 'SAAS_OFFER_SALES_ALREADY_STOPPED' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.saas_offer_sales_stops(offer_id,set_id,reason_code,stopped_by_principal_id,stopped_at) VALUES (p_offer,o.set_id,p->>'reasonCode',actor,at);
  SELECT hon.saas_offer_json(x) INTO snapshot FROM hon.saas_offer_set_offers x WHERE x.id = p_offer;
  RETURN hon.saas_record(actor, p_key, 'saas.offers.stop_sales', 'saas.offers.sales_stopped', 'OFFER', p_offer, NULL, NULL, snapshot,
    jsonb_build_object('offer', snapshot), at);
END $$;

-- ---------- HON OS reads ----------
CREATE OR REPLACE FUNCTION hon.read_saas_hon_os_offers_for_school(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; at timestamptz := clock_timestamp(); pub hon.saas_offer_sets%ROWTYPE; chk hon.saas_checkout_sessions%ROWTYPE;
  sub hon.saas_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  SELECT * INTO pub FROM hon.saas_offer_sets WHERE status = 'PUBLISHED';
  SELECT * INTO chk FROM hon.saas_checkout_sessions WHERE organization_id = actor.organization_id AND hon_os_offer_id IS NOT NULL
    ORDER BY created_at DESC, id LIMIT 1;
  SELECT * INTO sub FROM hon.saas_subscriptions WHERE organization_id = actor.organization_id AND status <> 'VOIDED' AND source = 'HON_OS_OFFER';
  RETURN jsonb_build_object('schoolId',p_school,'product',hon.saas_hon_os_product_json(),'offerSetVersion',pub.set_version,
    'termsReference',pub.terms_reference,
    -- Eligibility is the server's purchase decision for this organization now; the client never re-derives it.
    'offers',(SELECT coalesce(jsonb_agg((hon.saas_offer_json(o) - ARRAY['salesStop','salesOpensAt','position','saleLimit'])
        || jsonb_build_object('recurringBilling',hon.saas_hon_os_recurring(o),'eligibility',CASE r.refusal
          WHEN 'SAAS_OFFER_TERMS_UNSUPPORTED' THEN 'NOT_AVAILABLE_TERMS'
          WHEN 'SAAS_ENTITLEMENT_NOT_ACTIVE' THEN 'NOT_ELIGIBLE_ENTITLEMENT' WHEN 'SAAS_ENTITLEMENT_MISMATCH' THEN 'NOT_ELIGIBLE_ENTITLEMENT'
          WHEN 'SAAS_SUBSCRIPTION_EXISTS' THEN 'NOT_ELIGIBLE_EXISTING_SUBSCRIPTION' WHEN 'SAAS_OFFER_NOT_ELIGIBLE' THEN 'NOT_ELIGIBLE_PRIOR_PURCHASE'
          WHEN 'SAAS_CHECKOUT_OPEN' THEN 'CHECKOUT_IN_PROGRESS' WHEN 'SAAS_OFFER_SOLD_OUT' THEN 'SOLD_OUT'
          WHEN 'SAAS_FOUNDER_SOLD_OUT' THEN 'FOUNDER_SOLD_OUT' WHEN 'SAAS_OFFER_NOT_AVAILABLE' THEN 'NOT_AVAILABLE' ELSE 'ELIGIBLE' END)
      ORDER BY o.position),'[]'::jsonb)
      FROM hon.saas_offer_set_offers o CROSS JOIN LATERAL (SELECT hon.saas_hon_os_refusal(actor.organization_id, o, at) refusal) r
      WHERE o.set_id = pub.id AND hon.saas_hon_os_offer_on_sale(o, at)),
    'purchase',CASE WHEN (SELECT status FROM hon.saas_payment_program WHERE program_id = 1) = 'TEST_MODE' THEN 'TEST_MODE' ELSE 'UNAVAILABLE' END,
    'checkout',CASE WHEN chk.id IS NULL THEN NULL ELSE hon.saas_checkout_json(chk) END,
    'purchased',CASE WHEN sub.id IS NULL THEN NULL ELSE jsonb_build_object('subscriptionId',sub.id,'offerId',sub.hon_os_offer_id,
      'offerKind',sub.offer_kind,'displayName',sub.accepted_offer->>'displayName','priceMinor',sub.price_minor,
      'recurringBilling',sub.accepted_offer->>'recurringBilling','offerSetVersion',(sub.accepted_offer->>'offerSetVersion')::integer,
      'acceptedOfferDigest',sub.accepted_offer_digest,'status',sub.status,'serviceStartedAt',hon.saas_ts(sub.service_started_at)) END,
    'paidAccessProgram',CASE WHEN hon.saas_access_program_active() THEN 'ACTIVE' ELSE 'INACTIVE' END,
    'chargesEnabled',false);
END $$;

CREATE OR REPLACE FUNCTION hon.read_saas_offer_management_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE at timestamptz := clock_timestamp(); pub uuid; v_limit integer; used jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT id, founder_total_limit INTO pub, v_limit FROM hon.saas_offer_sets WHERE status = 'PUBLISHED';
  used := hon.saas_hon_os_founder_usage(at, NULL);
  RETURN jsonb_build_object('product',hon.saas_hon_os_product_json(),
    'published',CASE WHEN pub IS NULL THEN NULL ELSE hon.saas_offer_set_json(pub) END,
    'onSaleOfferIds',(SELECT coalesce(jsonb_agg(o.id ORDER BY o.position),'[]'::jsonb) FROM hon.saas_offer_set_offers o
      WHERE o.set_id = pub AND hon.saas_hon_os_offer_on_sale(o, at)),
    'drafts',(SELECT coalesce(jsonb_agg(hon.saas_offer_set_json(s.id) ORDER BY s.set_version DESC),'[]'::jsonb)
      FROM (SELECT id, set_version FROM hon.saas_offer_sets WHERE status = 'DRAFT' ORDER BY set_version DESC LIMIT 20) s),
    'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('setId',s.id,'setVersion',s.set_version,'status',s.status,'revision',s.revision,
        'offerCount',(SELECT count(*) FROM hon.saas_offer_set_offers o WHERE o.set_id = s.id),
        'createdAt',hon.saas_ts(s.created_at),'publishedAt',hon.saas_ts(s.published_at),'retiredAt',hon.saas_ts(s.retired_at),
        'discardedAt',hon.saas_ts(s.discarded_at)) ORDER BY s.set_version DESC),'[]'::jsonb)
      FROM (SELECT * FROM hon.saas_offer_sets ORDER BY set_version DESC LIMIT 100) s),
    -- Recorded HON OS sales (test mode): offers of the published set and any offer that has a purchase or checkout.
    'honOsSales',jsonb_build_object(
      'offers',(SELECT coalesce(jsonb_agg(jsonb_build_object('offerId',g.id,'setVersion',g.set_version,'offerCode',g.offer_code,'offerKind',g.offer_kind,
          'displayName',g.display_name,'priceMinor',g.price_minor,'saleLimit',g.sale_limit,
          -- HQ sees whether a published offer can actually be bought: unsupported terms are never shown as on sale.
          'saleStatus',(SELECT CASE WHEN x.set_id IS DISTINCT FROM pub OR NOT hon.saas_hon_os_offer_on_sale(x, at) THEN 'NOT_ON_SALE'
            WHEN hon.saas_hon_os_recurring(x) IS NULL THEN 'TERMS_UNSUPPORTED' ELSE 'ON_SALE' END FROM hon.saas_offer_set_offers x WHERE x.id = g.id),
          'subscriptions',(SELECT count(*) FROM hon.saas_subscriptions s WHERE s.hon_os_offer_id = g.id AND s.status <> 'VOIDED')::integer,
          'openCheckouts',(SELECT count(*) FROM hon.saas_checkout_sessions c WHERE c.hon_os_offer_id = g.id AND c.status IN ('CREATED','OPEN')
            AND c.expires_at > at)::integer,
          'paidNeedsReview',(SELECT count(*) FROM hon.saas_checkout_sessions c WHERE c.hon_os_offer_id = g.id AND c.status = 'PAID_NEEDS_REVIEW')::integer)
        ORDER BY g.set_version DESC, g.position),'[]'::jsonb)
        FROM (SELECT o.*, st.set_version FROM hon.saas_offer_set_offers o JOIN hon.saas_offer_sets st ON st.id = o.set_id
          WHERE o.set_id = pub OR EXISTS (SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.hon_os_offer_id = o.id)
          ORDER BY st.set_version DESC, o.position LIMIT 100) g),
      'founderPool',jsonb_build_object('limit',v_limit,'allocated',(used->>'allocated')::integer,'held',(used->>'held')::integer,
        'remaining',CASE WHEN v_limit IS NULL THEN NULL
          ELSE greatest(v_limit - (used->>'allocated')::integer - (used->>'held')::integer, 0) END)),
    'legacySales',(SELECT coalesce(jsonb_agg(jsonb_build_object('catalogVersion',g.catalog_version,'planCode',g.plan_code,'offerKind',g.offer_kind,
        'priceMinor',g.price_minor,'status',g.status,'subscriptions',g.n) ORDER BY g.catalog_version, g.plan_code, g.offer_kind, g.price_minor, g.status),'[]'::jsonb)
      FROM (SELECT c.catalog_version, s.plan_code, s.offer_kind, s.price_minor, s.status, count(*)::integer n
        FROM hon.saas_subscriptions s JOIN hon.saas_catalog_versions c ON c.id = s.catalog_id
        WHERE s.source = 'CATALOG_OFFER' GROUP BY 1,2,3,4,5) g),
    'paidAccessProgram',CASE WHEN hon.saas_access_program_active() THEN 'ACTIVE' ELSE 'INACTIVE' END,
    'purchase',CASE WHEN (SELECT status FROM hon.saas_payment_program WHERE program_id = 1) = 'TEST_MODE' THEN 'TEST_MODE' ELSE 'UNAVAILABLE' END,
    'chargesEnabled',false,'creditGrantsEnabled',false);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.saas_hon_os_billing_interval(text)','hon.saas_hon_os_recurring(hon.saas_offer_set_offers)',
      'hon.saas_hon_os_offer_on_sale(hon.saas_offer_set_offers,timestamp with time zone)','hon.saas_hon_os_accepted_offer(hon.saas_offer_set_offers)',
      'hon.saas_hon_os_digest(jsonb)','hon.saas_hon_os_offer_usage(uuid,timestamp with time zone,uuid)',
      'hon.saas_hon_os_founder_usage(timestamp with time zone,uuid)','hon.saas_hon_os_refusal(uuid,hon.saas_offer_set_offers,timestamp with time zone)',
      'hon.saas_open_hon_os_checkout(uuid,uuid,uuid,uuid,timestamp with time zone)','hon.saas_hon_os_purchase_json(hon.saas_checkout_sessions)',
      'hon.create_saas_hon_os_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid)',
      'hon.saas_activate_hon_os_checkout(uuid,jsonb,timestamp with time zone)','hon.saas_planned_monthly_credits(hon.saas_subscriptions)',
      'hon.saas_refund_window_hours(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_saas_hon_os_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
