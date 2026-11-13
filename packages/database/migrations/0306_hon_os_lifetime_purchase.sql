BEGIN;

-- HON OS lifetime purchase through the schedule path (owner decisions 2026-11-12, after 0237 closed the v1 lifetime checkout).
--   * HQ keeps the flexibility to sell lifetime (owner, 2026-11-12): a LIFETIME or FOUNDER_LIFETIME offer HQ published
--     (0181, ONE_TIME, refund window, sale limit and fair-use reference required) can now be accepted, generated and bound
--     like a recurring plan, with NEW one-time terms (schemaVersion 3). Every version 1 and 2 output is unchanged.
--   * One payment of the locked price, recorded as a paid period [startsAt, infinity). Nothing renews or is charged again;
--     any later payment overlaps it and is held for HQ review.
--   * Each lifetime offer has its own HQ sale limit, counted at the FIRST VERIFIED PAYMENT under that offer's row lock
--     (never at sign-up). Founder lifetime never uses the 50 founder spots (owner D1). A payment that arrives after the
--     limit is reached is held for HQ review (LIFETIME_SALE_LIMIT_REACHED) and refunded by HQ, never auto-refunded.
--     A refund never returns a sale. Sign-up, acceptance and generation are refused once the limit is reached.
--   * Access: the first verified lifetime payment makes the entitlement COMPLETE ACTIVE with no end (effective_until NULL).
--     Paid access stays behind the INACTIVE paid-access program exactly like every other schedule plan (0235).
--   * Not in this migration: a verified refund ending lifetime access (owner D2, migration 0309; until then a refund of a
--     counted lifetime payment stays in HQ review like any counted payment), and switching from monthly or annual to
--     lifetime with unused-time credit (owner D3/D3a, migration 0307).
-- No checkout, provider, live payment, entitlement grant or credit is enabled by this migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS lifetime purchase requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS lifetime purchase requires a restricted runtime';
  END IF;
END $$;

-- ---------- one immutable row per counted lifetime sale ----------
CREATE TABLE hon.saas_lifetime_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES hon.saas_offer_set_offers(id) ON DELETE RESTRICT,
  offer_set_id uuid NOT NULL REFERENCES hon.saas_offer_sets(id) ON DELETE RESTRICT,
  offer_kind text NOT NULL CHECK (offer_kind IN ('LIFETIME','FOUNDER_LIFETIME')),
  sale_number integer NOT NULL CHECK (sale_number BETWEEN 1 AND 10000),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL REFERENCES hon.schools(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL UNIQUE REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  paid_period_id uuid NOT NULL UNIQUE REFERENCES hon.saas_schedule_paid_periods(id) ON DELETE RESTRICT,
  provider_event_id text NOT NULL UNIQUE CHECK (provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  price_minor integer NOT NULL CHECK (price_minor BETWEEN 100 AND 10000000),
  sold_at timestamptz NOT NULL,
  UNIQUE (offer_id, sale_number)
);

-- ---------- review reason for a lifetime payment that found the limit reached ----------
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_schedule_bindings'::regclass AND conname='saas_schedule_bindings_status_reason_check';
  IF def IS NULL OR position('FOUNDER_SPOT_UNAVAILABLE' IN def)=0 THEN RAISE EXCEPTION 'saas_schedule_bindings status_reason constraint drifted'; END IF;
  ALTER TABLE hon.saas_schedule_bindings DROP CONSTRAINT saas_schedule_bindings_status_reason_check;
  ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_status_reason_check CHECK (status_reason IN ('BINDING_REQUESTED',
    'BINDING_OBSERVED_TEST_ONLY','FIRST_PAYMENT_VERIFIED','PROVIDER_CONFIRMED_NOT_CREATED','PROVIDER_TERMS_MISMATCH','UNPAID_WINDOW_ELAPSED',
    'AMOUNT_MISMATCH','OVERLAPPING_COVERED_PERIOD','REVERSAL_REVIEW_REQUIRED','UNLINKED_REVERSAL','PURCHASER_CANCELLED_BEFORE_PAYMENT',
    'PERIOD_INTERVAL_MISMATCH','REVIEW_REFUND_VERIFIED','FOUNDER_SPOT_UNAVAILABLE','LIFETIME_SALE_LIMIT_REACHED'));
END $$;

-- ---------- sales of one offer (0182 body plus counted lifetime sales) ----------
CREATE OR REPLACE FUNCTION hon.saas_hon_os_offer_usage(p_offer uuid, p_at timestamptz, p_exclude uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  -- 0306: plus every lifetime sale counted through the schedule path (refunds never return a sale).
  SELECT ((SELECT count(*) FROM hon.saas_subscriptions s WHERE s.hon_os_offer_id = p_offer AND s.status <> 'VOIDED')
    + (SELECT count(*) FROM hon.saas_lifetime_sales l WHERE l.offer_id = p_offer)
    + (SELECT count(*) FROM hon.saas_checkout_sessions c WHERE c.hon_os_offer_id = p_offer AND c.status IN ('CREATED','OPEN')
        AND c.expires_at > p_at AND c.id IS DISTINCT FROM p_exclude))::integer
$$;

-- ---------- availability (read-only; never a reservation) ----------
-- NULL means one more sale of this lifetime offer could be counted now. Not a promise: the sale is counted only by the
-- first verified payment, under the offer row lock. A missing sale limit fails closed.
CREATE FUNCTION hon.saas_lifetime_unavailable_reason(p_offer uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN o.id IS NULL OR o.billing_interval<>'ONE_TIME' OR o.sale_limit IS NULL
      OR hon.saas_hon_os_offer_usage(o.id,clock_timestamp(),NULL)>=o.sale_limit THEN 'LIFETIME_SOLD_OUT' END
  FROM (SELECT 1) one LEFT JOIN hon.saas_offer_set_offers o ON o.id=p_offer
$$;

-- The lifetime offer a binding was signed up for, or NULL for a recurring plan. Read from the binding's fixed requirements.
CREATE FUNCTION hon.saas_schedule_binding_lifetime_offer(b hon.saas_schedule_bindings) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT o.id FROM hon.saas_offer_set_offers o WHERE o.id::text=b.requirements->>'offerId' AND o.billing_interval='ONE_TIME'
    AND b.requirements->>'billingInterval'='ONE_TIME'
$$;
-- Founder lifetime is a founder offer (0181 founder=true) but never a founder-pool plan (owner D1).
CREATE OR REPLACE FUNCTION hon.saas_schedule_binding_founder_offer(b hon.saas_schedule_bindings) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT o.id FROM hon.saas_offer_set_offers o WHERE o.id::text=b.requirements->>'offerId' AND o.founder AND o.billing_interval<>'ONE_TIME'
$$;

-- ---------- the school offers read (0185 body): founder lifetime ignores the founder pool ----------
-- The v1 refusal (0185) is unchanged: it still decides the legacy v1 checkout, which 0237 refuses for every founder and
-- lifetime offer. Only what a school is shown follows owner D1: a one-time founder offer has its own HQ sale limit and
-- is never FOUNDER_SOLD_OUT. The founder-pool check is the last refusal in 0185, so dropping only that answer for a
-- one-time offer leaves every earlier refusal (sale limit, entitlement, open checkout) in force.
CREATE FUNCTION hon.saas_hon_os_school_refusal(p_org uuid, o hon.saas_offer_set_offers, p_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE refusal text := hon.saas_hon_os_refusal(p_org, o, p_at);
BEGIN
  IF refusal = 'SAAS_FOUNDER_SOLD_OUT' AND o.billing_interval = 'ONE_TIME' THEN RETURN NULL; END IF;
  RETURN refusal;
END $$;

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
          WHEN 'SAAS_ENTITLEMENT_NOT_ACTIVE' THEN 'NOT_ELIGIBLE_ENTITLEMENT' WHEN 'SAAS_ACCESS_EXCEPTION_ACTIVE' THEN 'NOT_ELIGIBLE_ENTITLEMENT' WHEN 'SAAS_ENTITLEMENT_MISMATCH' THEN 'NOT_ELIGIBLE_ENTITLEMENT'
          WHEN 'SAAS_SUBSCRIPTION_EXISTS' THEN 'NOT_ELIGIBLE_EXISTING_SUBSCRIPTION' WHEN 'SAAS_OFFER_NOT_ELIGIBLE' THEN 'NOT_ELIGIBLE_PRIOR_PURCHASE'
          WHEN 'SAAS_CHECKOUT_OPEN' THEN 'CHECKOUT_IN_PROGRESS' WHEN 'SAAS_OFFER_SOLD_OUT' THEN 'SOLD_OUT'
          WHEN 'SAAS_FOUNDER_SOLD_OUT' THEN 'FOUNDER_SOLD_OUT' WHEN 'SAAS_OFFER_NOT_AVAILABLE' THEN 'NOT_AVAILABLE' ELSE 'ELIGIBLE' END)
      ORDER BY o.position),'[]'::jsonb)
      FROM hon.saas_offer_set_offers o CROSS JOIN LATERAL (SELECT hon.saas_hon_os_school_refusal(actor.organization_id, o, at) refusal) r
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

-- 0172 body + revoke-first pilot conversion (owner policy, 2026-10-24): an approved pilot, demonstration or testing
-- exception must be revoked by an HQ owner or reach its expiry before the school enters awaiting-first-payment. While
-- one is active or scheduled the transition is refused (SAAS_ACCESS_EXCEPTION_ACTIVE) and nothing changes. An open
-- exception that already lapsed (or whose entitlement was replaced) is closed here first, so its record ends as EXPIRED
-- (or SUPERSEDED) rather than staying open under the awaiting state. A seamless verified-payment conversion is a
-- separate, unapproved milestone.
CREATE OR REPLACE FUNCTION hon.place_saas_organization_awaiting_payment(p_subject text, p_org uuid, p_input jsonb, p_key uuid, p_request_id uuid,
  p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; fp text; replay jsonb; ent hon.organization_entitlements%ROWTYPE; prior jsonb; nxt jsonb; at timestamptz := clock_timestamp();
  expected integer; lapsed hon.saas_access_exceptions%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> ARRAY['expectedEntitlementVersion']
    OR jsonb_typeof(p_input->'expectedEntitlementVersion') <> 'number' OR (p_input->>'expectedEntitlementVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  expected := (p_input->>'expectedEntitlementVersion')::integer;
  actor := hon.require_saas_hq_actor(p_subject, true);
  fp := hon.saas_fingerprint(ARRAY['access.await', p_org::text, expected::text]);
  replay := hon.saas_claim_request(actor, p_key, 'saas.access.await', fp, p_request_id, p_correlation_id);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT hon.saas_access_program_active() THEN RAISE EXCEPTION 'SAAS_ACCESS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || p_org::text, 0));
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF ent.version <> expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF hon.saas_access_exception_live(p_org) THEN RAISE EXCEPTION 'SAAS_ACCESS_EXCEPTION_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_access_states WHERE organization_id = p_org) THEN RAISE EXCEPTION 'SAAS_ACCESS_STATE_EXISTS' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_subscriptions WHERE organization_id = p_org AND status <> 'VOIDED') THEN
    RAISE EXCEPTION 'SAAS_SUBSCRIPTION_EXISTS' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id = p_org AND status IN ('CREATED','OPEN')) THEN
    RAISE EXCEPTION 'SAAS_CHECKOUT_OPEN' USING ERRCODE = '23514';
  END IF;
  prior := hon.saas_entitlement_json(p_org);
  SELECT * INTO lapsed FROM hon.saas_access_exceptions WHERE organization_id = p_org AND status = 'GRANTED' FOR UPDATE;
  IF FOUND THEN PERFORM hon.saas_end_access_exception(lapsed.id, 'EXPIRED', NULL, actor, at); END IF;
  -- No access before the first payment: the existing row is held SUSPENDED (every status-gated function refuses it).
  UPDATE hon.organization_entitlements SET status = 'SUSPENDED', version = version + 1, updated_at = at WHERE organization_id = p_org;
  nxt := hon.saas_entitlement_json(p_org);
  INSERT INTO hon.saas_access_states(organization_id, state, reason, version, changed_by_principal_id, created_at, updated_at)
    VALUES (p_org, 'AWAITING_FIRST_PAYMENT', 'AWAITING_INITIAL_PAYMENT', 1, actor, at, at);
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
    VALUES (p_org, 'AWAITING_FIRST_PAYMENT', 'APPLIED', 'AWAITING_INITIAL_PAYMENT', prior, nxt, actor, at);
  RETURN hon.saas_record(actor, p_key, 'saas.access.await', 'saas.access.awaiting', 'ACCESS_STATE', p_org, p_org, prior, nxt,
    jsonb_build_object('access', hon.saas_organization_access(p_org)), at);
END $$;

-- Database backstop for the same rule on every path: no access state (awaiting or paid) is created for an
-- organization holding an open, unexpired exception.
CREATE FUNCTION hon.guard_saas_access_state_exception() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hon.saas_access_exceptions x WHERE x.organization_id = NEW.organization_id AND x.status = 'GRANTED'
    AND x.expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'SAAS_ACCESS_EXCEPTION_ACTIVE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_exception_await BEFORE INSERT ON hon.saas_access_states FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_access_state_exception();

-- 0152 body + the entitlement window: Champions contest eligibility (live standings and the frozen results that
-- winner proposals read) requires the referrer's entitlement to be in effect at the evaluation time (p_cutoff: now
-- for live standings, the END time for the freeze), not only ACTIVE at an eligible tier. A scheduled (future-start)
-- or lapsed window, such as an expired HQ-owner exception that nobody closed yet, is TIER_NOT_ELIGIBLE. Results
-- already frozen are evidence and are not recalculated.
CREATE OR REPLACE FUNCTION hon.champions_contest_counts(p_contest uuid, p_cutoff timestamptz)
RETURNS TABLE (school_id uuid, organization_id uuid, qualified integer, reached_at timestamptz, ineligible_reason text)
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH c AS (SELECT * FROM hon.champions_contests WHERE id = p_contest),
  counted AS (
    SELECT a.referrer_school_id, a.referrer_organization_id, count(*)::integer qualified, max(a.qualified_at) reached_at
    FROM hon.champions_attributions a, c
    WHERE a.state = 'QUALIFIED' AND a.qualified_at >= c.starts_at AND a.qualified_at < least(c.ends_at, p_cutoff)
      AND (c.count_basis = 'QUALIFIED_IN_WINDOW' OR (a.captured_at >= c.starts_at AND a.captured_at < c.ends_at))
      AND NOT EXISTS (SELECT 1 FROM hon.champions_contest_pauses pz WHERE pz.contest_id = c.id
        AND a.qualified_at >= pz.paused_at AND a.qualified_at < coalesce(pz.resumed_at, 'infinity'::timestamptz))
    GROUP BY a.referrer_school_id, a.referrer_organization_id)
  SELECT k.referrer_school_id, k.referrer_organization_id, k.qualified, k.reached_at,
    CASE
      WHEN c.eligibility_scope = 'SELECTED_SCHOOLS' AND NOT EXISTS (SELECT 1 FROM hon.champions_contest_schools cs
        WHERE cs.contest_id = c.id AND cs.school_id = k.referrer_school_id) THEN 'NOT_SELECTED'
      WHEN NOT EXISTS (SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
        WHERE s.id = k.referrer_school_id AND s.status = 'ACTIVE' AND o.status = 'ACTIVE') THEN 'SCHOOL_INACTIVE'
      WHEN NOT EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = k.referrer_organization_id
        AND e.status = 'ACTIVE' AND e.tier::text = ANY(c.eligible_tiers)
        AND e.effective_from <= p_cutoff AND (e.effective_until IS NULL OR e.effective_until > p_cutoff)) THEN 'TIER_NOT_ELIGIBLE'
      WHEN EXISTS (SELECT 1 FROM hon.champions_leaderboard_holds h WHERE h.school_id = k.referrer_school_id AND h.status = 'ACTIVE') THEN 'LEADERBOARD_HOLD'
      WHEN k.qualified < c.minimum_qualified THEN 'BELOW_MINIMUM'
    END
  FROM counted k, c
$$;

-- ---------- one-time terms (0279 body plus a lifetime branch) ----------
CREATE OR REPLACE FUNCTION hon.saas_price_content(p_offer uuid,p_renewal uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE o hon.saas_offer_set_offers%ROWTYPE; r hon.saas_offer_set_offers%ROWTYPE; s hon.saas_offer_sets%ROWTYPE;
 monthly integer; standard integer; n integer; ns integer; annual boolean; founder boolean; disclosure text; terms jsonb; snapshot jsonb;
BEGIN
 SELECT * INTO o FROM hon.saas_offer_set_offers WHERE id=p_offer;
 SELECT * INTO r FROM hon.saas_offer_set_offers WHERE id=p_renewal;
 SELECT * INTO s FROM hon.saas_offer_sets WHERE id=o.set_id;
 IF s.status IS DISTINCT FROM 'PUBLISHED' OR NOT hon.saas_hon_os_offer_on_sale(o,clock_timestamp())
  OR NOT hon.saas_hon_os_offer_on_sale(r,clock_timestamp()) OR r.set_id IS DISTINCT FROM o.set_id THEN
  RAISE EXCEPTION 'SAAS_OFFER_NOT_AVAILABLE' USING ERRCODE='23514'; END IF;
 IF o.offer_kind NOT IN ('REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL','LIFETIME','FOUNDER_LIFETIME')
  THEN RAISE EXCEPTION 'SAAS_PRICE_TERMS_UNSUPPORTED' USING ERRCODE='23514'; END IF;
 -- 0306: a one-time (lifetime) offer HQ published. One price, paid once, never renews; its own HQ sale limit (founder
 -- lifetime never uses the 50 founder spots, owner D1); a refund window and a fair-use reference are required.
 IF o.billing_interval='ONE_TIME' THEN
  SELECT count(*),min(price_minor) INTO n,monthly FROM hon.saas_offer_set_offers WHERE set_id=s.id AND offer_kind='REGULAR_MONTHLY';
  IF n<>1 OR r.id<>o.id OR o.refund_window_days IS NULL OR o.sale_limit IS NULL OR o.ai_fair_use_reference IS NULL
   OR o.cancellation_timing IS NOT NULL OR o.price_lock<>'NONE'
  THEN RAISE EXCEPTION 'SAAS_PRICE_TERMS_UNSUPPORTED' USING ERRCODE='23514'; END IF;
  terms:=jsonb_build_object('schemaVersion',3,'productCode','HON_OS','currency','USD','offerKind',o.offer_kind,
   'billingInterval','ONE_TIME','initialPriceMinor',o.price_minor,'introductoryPaidPeriods',0,'renewalPriceMinor',o.price_minor,
   'monthlyListReferenceMinor',monthly,'renewalPriceRule','NO_RENEWAL_ONE_TIME','periodCountingRule','DISTINCT_VERIFIED_PAID_PERIODS',
   'discountStacking','FORBIDDEN','promotionReuse','REQUIRES_ORGANIZATION_PROMOTION_HISTORY','existingCustomerPrices','UNCHANGED',
   'lifetimeAccessRule','OPEN_ENDED_AFTER_ONE_VERIFIED_PAYMENT','saleLimitRule','OFFER_SALE_LIMIT_COUNTED_AT_FIRST_VERIFIED_PAYMENT',
   'founderSpotRule','NOT_COUNTED_IN_FOUNDER_POOL','refundAccessRule','VERIFIED_REFUND_IN_WINDOW_ENDS_ACCESS');
  disclosure:=hon.saas_price_usd(o.price_minor)||' paid once for lifetime HON OS access. It never renews and is never charged again. '
   ||'Sale limit: '||o.sale_limit||'. A sale is counted only when the payment is verified, and if the limit is reached first, that payment is held for review and refunded. '
   ||CASE WHEN o.founder THEN 'Founder lifetime does not use one of the 50 founder spots. ' ELSE '' END
   ||'A refund within the '||o.refund_window_days||'-day refund window ends lifetime access. AI use follows the fair-use terms: '||o.ai_fair_use_reference||'.';
  snapshot:=hon.saas_hon_os_accepted_offer(o);
  RETURN jsonb_build_object('offerId',o.id,'offerSetId',s.id,'offerSetVersion',s.set_version,'offerSetRevision',s.revision,
   'renewalOfferId',r.id,'terms',terms,'acceptedOffer',snapshot,'acceptedOfferDigest',hon.saas_hon_os_digest(snapshot),
   'disclosureVersion','HON_OS_PRICING_EN_V1','disclosureLanguage','en','disclosureText',disclosure,
   'termsReference',s.terms_reference,'refundTerms',jsonb_build_object('termsReference',s.terms_reference,'windowDays',o.refund_window_days),
   'cancellationTerms',jsonb_build_object('termsReference',s.terms_reference,'timing',NULL));
 END IF;
 annual:=o.billing_interval='ANNUAL'; founder:=o.founder;
 SELECT count(*),min(price_minor) INTO n,monthly FROM hon.saas_offer_set_offers WHERE set_id=s.id AND offer_kind='REGULAR_MONTHLY';
 SELECT count(*),min(price_minor) INTO ns,standard FROM hon.saas_offer_set_offers WHERE set_id=s.id
  AND offer_kind=CASE WHEN annual THEN 'REGULAR_ANNUAL' ELSE 'REGULAR_MONTHLY' END;
 IF n<>1 OR o.refund_window_days IS NULL OR o.cancellation_timing IS DISTINCT FROM 'END_OF_PAID_PERIOD' OR r.id<>o.id
  OR (annual AND o.annual_renewal IS DISTINCT FROM 'AUTO_RENEW_AT_LOCKED_PRICE')
  -- Standard: exactly the 0188 rule (renewal is the same standard offer, no offer-level lock field).
  OR (NOT founder AND o.price_lock<>'NONE')
  -- Founder: renews at its own price, locked while subscribed, below the standard price of the same interval. The
  -- disclosed return-to-standard rule names the 7-day grace, so a different grace makes the terms unsupported.
  OR (founder AND (ns<>1 OR o.price_lock<>'WHILE_CONTINUOUSLY_SUBSCRIBED' OR o.price_minor>=standard
   OR hon.saas_schedule_access_grace()<>interval '7 days'))
  THEN RAISE EXCEPTION 'SAAS_PRICE_TERMS_UNSUPPORTED' USING ERRCODE='23514'; END IF;
 terms:=jsonb_build_object('schemaVersion',CASE WHEN founder THEN 2 ELSE 1 END,'productCode','HON_OS','currency','USD','offerKind',o.offer_kind,
  'billingInterval',o.billing_interval,'initialPriceMinor',o.price_minor,'introductoryPaidPeriods',0,
  'renewalPriceMinor',r.price_minor,'monthlyListReferenceMinor',monthly,'renewalPriceRule','FIXED_ACCEPTED_SCHEDULE',
  'periodCountingRule','DISTINCT_VERIFIED_PAID_PERIODS','discountStacking','FORBIDDEN',
  'promotionReuse','REQUIRES_ORGANIZATION_PROMOTION_HISTORY','existingCustomerPrices','UNCHANGED')
  || CASE WHEN founder THEN jsonb_build_object('standardPriceMinor',standard,'founderPriceRule','LOCKED_WHILE_SUBSCRIBED',
   'returnPriceRule','STANDARD_PRICE_AFTER_CANCEL_OR_LAPSE','founderSpotRule','ONE_PER_ORGANIZATION_COUNTED_AT_FIRST_VERIFIED_PAYMENT')
   ELSE '{}'::jsonb END;
 disclosure:=CASE
  WHEN o.offer_kind='FOUNDER_MONTHLY' THEN hon.saas_price_usd(o.price_minor)||' per month for as long as this subscription stays active. If it is canceled, or lapses for more than the 7-day grace period, a new subscription is at the standard price of '||hon.saas_price_usd(standard)||' per month. A founder spot is counted only when the first payment is verified; if every spot is taken first, that payment is held for review and refunded.'
  WHEN o.offer_kind='FOUNDER_ANNUAL' THEN hon.saas_price_usd(o.price_minor)||' per annual subscription period for as long as this subscription stays active. Renews at '||hon.saas_price_usd(o.price_minor)||' annually unless canceled under the accepted terms. If it is canceled, or lapses for more than the 7-day grace period, a new subscription is at the standard price of '||hon.saas_price_usd(standard)||' per year. A founder spot is counted only when the first payment is verified; if every spot is taken first, that payment is held for review and refunded.'
  WHEN annual THEN hon.saas_price_usd(o.price_minor)||' per annual subscription period. Renews at '||hon.saas_price_usd(r.price_minor)||' annually unless canceled under the accepted terms.'
  ELSE hon.saas_price_usd(o.price_minor)||' per month until canceled under the accepted terms.' END;
 snapshot:=hon.saas_hon_os_accepted_offer(o);
 RETURN jsonb_build_object('offerId',o.id,'offerSetId',s.id,'offerSetVersion',s.set_version,'offerSetRevision',s.revision,
  'renewalOfferId',r.id,'terms',terms,'acceptedOffer',snapshot,'acceptedOfferDigest',hon.saas_hon_os_digest(snapshot),
  'disclosureVersion','HON_OS_PRICING_EN_V1','disclosureLanguage','en','disclosureText',disclosure,
  'termsReference',s.terms_reference,'refundTerms',jsonb_build_object('termsReference',s.terms_reference,'windowDays',o.refund_window_days),
  'cancellationTerms',jsonb_build_object('termsReference',s.terms_reference,'timing',o.cancellation_timing));
END $$;

CREATE OR REPLACE FUNCTION hon.saas_price_acceptance_preview(p_org uuid,p_school uuid,p_schedule uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE s hon.saas_price_schedules%ROWTYPE; content jsonb; blockers jsonb:='[]'; digest text; founder_reason text; lt_reason text;
BEGIN
 SELECT * INTO s FROM hon.saas_price_schedules WHERE id=p_schedule;
 IF s.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 BEGIN
  content:=hon.saas_price_content(s.offer_id,s.renewal_offer_id);
  IF hon.saas_hon_os_digest(content||jsonb_build_object('version',s.version))<>s.schedule_digest
   THEN blockers:=blockers||'"SCHEDULE_CHANGED"'::jsonb; END IF;
 EXCEPTION WHEN check_violation THEN blockers:=blockers||'"OFFER_NOT_AVAILABLE"'::jsonb; END;
 IF s.version<>(SELECT max(version) FROM hon.saas_price_schedules WHERE offer_id=s.offer_id) THEN blockers:=blockers||'"SCHEDULE_SUPERSEDED"'::jsonb; END IF;
 IF s.terms->>'offerKind' IN ('FOUNDER_MONTHLY','FOUNDER_ANNUAL') THEN
  -- A version 1 (step-up) founder schedule stays history only. A locked one shows today's availability, never a hold.
  founder_reason:=CASE WHEN s.terms->>'schemaVersion' IS DISTINCT FROM '2' THEN 'FOUNDER_TERMS_NOT_LOCKED'
   ELSE hon.saas_founder_unavailable_reason(p_org,s.offer_id) END;
  IF founder_reason IS NOT NULL THEN blockers:=blockers||to_jsonb(founder_reason); END IF;
 END IF;
 -- 0306: a lifetime schedule shows whether its sale limit is reached now. Never a hold: a sale is counted at payment.
 IF s.terms->>'billingInterval'='ONE_TIME' THEN
  lt_reason:=hon.saas_lifetime_unavailable_reason(s.offer_id);
  IF lt_reason IS NOT NULL THEN blockers:=blockers||to_jsonb(lt_reason); END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM hon.saas_price_acceptances WHERE organization_id=p_org AND school_id=p_school AND schedule_id=s.id)
  THEN blockers:=blockers||'"ALREADY_ACCEPTED"'::jsonb; END IF;
 digest:=hon.saas_hon_os_digest(jsonb_build_object('organizationId',p_org,'schoolId',p_school,'scheduleId',s.id,'scheduleDigest',s.schedule_digest));
 RETURN jsonb_build_object('organizationId',p_org,'schoolId',p_school,'schedule',hon.saas_price_schedule_json(s),
  'acceptanceDigest',digest,'canAcknowledge',jsonb_array_length(blockers)=0,'blockers',blockers,
  'purchaseAvailable',false,'paymentAuthorized',false,'accessGranted',false,'asOf',hon.saas_ts(clock_timestamp()));
END $$;

CREATE OR REPLACE FUNCTION hon.saas_generation_content(p_id uuid,p_acceptance uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE a hon.saas_price_acceptances%ROWTYPE; s hon.saas_price_schedules%ROWTYPE;
BEGIN
 SELECT * INTO a FROM hon.saas_price_acceptances WHERE id=p_acceptance;
 SELECT * INTO s FROM hon.saas_price_schedules WHERE id=a.schedule_id;
 IF a.id IS NULL OR s.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF a.schedule_digest<>s.schedule_digest OR a.disclosure_version<>s.disclosure_version OR a.disclosure_text<>s.disclosure_text
  OR a.confirmation<>'ACCEPT_INITIAL_AND_SCHEDULED_RENEWAL_PRICES' OR a.founder_allocation_id IS NOT NULL
  OR NOT (s.terms->>'offerKind' IN ('REGULAR_MONTHLY','REGULAR_ANNUAL')
   OR (s.terms->>'offerKind' IN ('FOUNDER_MONTHLY','FOUNDER_ANNUAL') AND s.terms->>'schemaVersion'='2'
    AND s.terms->>'founderPriceRule'='LOCKED_WHILE_SUBSCRIBED' AND s.terms->>'initialPriceMinor'=s.terms->>'renewalPriceMinor')
   -- 0306: lifetime (one-time) terms.
   OR (s.terms->>'offerKind' IN ('LIFETIME','FOUNDER_LIFETIME') AND s.terms->>'schemaVersion'='3' AND s.terms->>'billingInterval'='ONE_TIME'
    AND s.terms->>'initialPriceMinor'=s.terms->>'renewalPriceMinor'))
  OR a.acceptance_digest<>hon.saas_hon_os_digest(jsonb_build_object('organizationId',a.organization_id,'schoolId',a.school_id,'scheduleId',s.id,'scheduleDigest',s.schedule_digest))
  THEN RAISE EXCEPTION 'SAAS_GENERATION_ACCEPTANCE_INVALID' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('schemaVersion',1,'generationId',p_id,'organizationId',a.organization_id,'schoolId',a.school_id,
  'acceptance',hon.saas_price_acceptance_json(a),'provider',jsonb_build_object('identity','UNCONFIGURED','mode','TEST',
   'generationReference',p_id,'accountReference',NULL,'subscriptionReference',NULL,'scheduleReference',NULL,'bindingStatus','NOT_BOUND'));
END $$;
CREATE OR REPLACE FUNCTION hon.saas_generation_available(p_acceptance uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE s hon.saas_price_schedules%ROWTYPE; o hon.saas_offer_set_offers%ROWTYPE; org uuid;
BEGIN
 SELECT ps.* INTO s FROM hon.saas_price_acceptances a JOIN hon.saas_price_schedules ps ON ps.id=a.schedule_id WHERE a.id=p_acceptance;
 SELECT organization_id INTO org FROM hon.saas_price_acceptances WHERE id=p_acceptance;
 SELECT * INTO o FROM hon.saas_offer_set_offers WHERE id=s.offer_id;
 IF o.id IS NULL OR NOT hon.saas_hon_os_offer_on_sale(o,clock_timestamp())
  THEN RAISE EXCEPTION 'SAAS_OFFER_NOT_AVAILABLE' USING ERRCODE='23514'; END IF;
 IF o.billing_interval='ONE_TIME' AND hon.saas_lifetime_unavailable_reason(o.id) IS NOT NULL
  THEN RAISE EXCEPTION 'SAAS_LIFETIME_SOLD_OUT' USING ERRCODE='23514'; END IF;
 IF o.founder AND o.billing_interval<>'ONE_TIME' AND hon.saas_founder_unavailable_reason(org,o.id) IS NOT NULL
  THEN RAISE EXCEPTION 'SAAS_FOUNDER_UNAVAILABLE' USING ERRCODE='23514'; END IF;
END $$;

-- ---------- fixed requirements and the paid period of a one-time payment (0230 bodies) ----------
CREATE OR REPLACE FUNCTION hon.saas_schedule_requirements(g hon.saas_subscription_generations) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE a jsonb:=g.acceptance_snapshot; s jsonb; t jsonb;
BEGIN
  s:=a->'schedule'; t:=s->'terms';
  IF a->>'acceptanceId' IS NULL OR a->>'acceptanceDigest' !~ '^[0-9a-f]{64}$' OR a->>'scheduleDigest' !~ '^[0-9a-f]{64}$'
    OR s->>'offerId' IS NULL OR s->>'renewalOfferId' IS NULL OR s->>'offerSetId' IS NULL OR s->>'acceptedOfferDigest' !~ '^[0-9a-f]{64}$'
    OR (t->>'initialPriceMinor') !~ '^[1-9][0-9]*$' OR (t->>'renewalPriceMinor') !~ '^[1-9][0-9]*$'
    OR t->>'currency' <> 'USD' OR t->>'billingInterval' NOT IN ('MONTHLY','ANNUAL','ONE_TIME')
    OR t->>'periodCountingRule' <> 'DISTINCT_VERIFIED_PAID_PERIODS' OR s->'refundTerms' IS NULL OR s->'cancellationTerms' IS NULL
    -- 0306: only lifetime (v3) terms are one-time; nothing else may claim it.
    OR (t->>'billingInterval'='ONE_TIME') IS DISTINCT FROM (t->>'schemaVersion'='3')
  THEN RAISE EXCEPTION 'SAAS_GENERATION_ACCEPTANCE_INVALID' USING ERRCODE='23514'; END IF;
  -- Owner answer 4a: one price for as long as the school stays subscribed. A schedule whose price changes after an
  -- introductory phase cannot be bound, so no payment's expected amount ever depends on counting earlier payments.
  IF t->>'introductoryPaidPeriods' IS DISTINCT FROM '0' OR t->>'initialPriceMinor' IS DISTINCT FROM t->>'renewalPriceMinor'
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_PRICE_NOT_LOCKED' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('generationId',g.id,'generationDigest',g.generation_digest,'organizationId',g.organization_id,'schoolId',g.school_id,
    'acceptanceId',a->>'acceptanceId','acceptanceDigest',a->>'acceptanceDigest','scheduleDigest',a->>'scheduleDigest',
    'offerId',s->>'offerId','renewalOfferId',s->>'renewalOfferId','offerSetId',s->>'offerSetId','offerSetVersion',(s->>'offerSetVersion')::integer,
    'acceptedOfferDigest',s->>'acceptedOfferDigest','disclosureVersion',a->>'disclosureVersion','disclosureText',a->>'disclosureText',
    'termsReference',s->>'termsReference','refundTerms',s->'refundTerms','cancellationTerms',s->'cancellationTerms',
    'lockedPriceMinor',(t->>'initialPriceMinor')::integer,'currency','USD','billingInterval',t->>'billingInterval',
    'priceRule',CASE WHEN t->>'billingInterval'='ONE_TIME' THEN 'ONE_TIME_PURCHASE' ELSE 'LOCKED_WHILE_SUBSCRIBED' END,'periodCountingRule','DISTINCT_VERIFIED_PAID_PERIODS',
    'automaticCalendarTransition',false,'automaticCollectionEnabled',false);
END $$;

CREATE OR REPLACE FUNCTION hon.saas_schedule_period_matches(p_interval text,p_starts timestamptz,p_ends timestamptz) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  -- 0306: a one-time (lifetime) payment covers [startsAt, infinity); nothing else is one interval of it.
  SELECT CASE WHEN p_interval='ONE_TIME' THEN coalesce(isfinite(p_starts) AND p_ends='infinity'::timestamptz, false)
    ELSE coalesce(isfinite(p_ends) AND p_ends BETWEEN e.expected - interval '1 day' AND e.expected + interval '1 day', false) END
  FROM (SELECT ((p_starts AT TIME ZONE 'UTC') + CASE p_interval WHEN 'MONTHLY' THEN interval '1 month' WHEN 'ANNUAL' THEN interval '1 year' END)
    AT TIME ZONE 'UTC' AS expected) e
$$;

-- ---------- binding: no new lifetime sign-up once the limit is reached ----------
CREATE FUNCTION hon.guard_saas_lifetime_binding_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE offer uuid:=hon.saas_schedule_binding_lifetime_offer(NEW);
BEGIN
  IF NEW.requirements->>'billingInterval'='ONE_TIME' AND (offer IS NULL OR hon.saas_lifetime_unavailable_reason(offer) IS NOT NULL) THEN
    RAISE EXCEPTION 'SAAS_LIFETIME_SOLD_OUT' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_lifetime_binding_insert BEFORE INSERT ON hon.saas_schedule_bindings FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_lifetime_binding_insert();

-- ---------- a sale: only by the first verified payment of a lifetime binding, under the offer row lock ----------
CREATE FUNCTION hon.guard_saas_lifetime_sale_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; per hon.saas_schedule_paid_periods%ROWTYPE; o hon.saas_offer_set_offers%ROWTYPE;
BEGIN
  SELECT * INTO o FROM hon.saas_offer_set_offers WHERE id=NEW.offer_id FOR UPDATE;
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=NEW.binding_id;
  SELECT * INTO per FROM hon.saas_schedule_paid_periods WHERE id=NEW.paid_period_id;
  IF o.id IS NULL OR b.id IS NULL OR per.id IS NULL OR per.binding_id<>b.id OR hon.saas_schedule_binding_lifetime_offer(b) IS DISTINCT FROM o.id
    OR b.status<>'BOUND_TEST_ONLY' OR b.activated_at IS NOT NULL
    OR (SELECT count(*) FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id)<>1
    OR per.covered_ends_at<>'infinity'::timestamptz
    OR NEW.organization_id<>b.organization_id OR NEW.school_id<>b.school_id OR NEW.offer_set_id<>o.set_id
    OR NEW.offer_set_id::text<>b.requirements->>'offerSetId' OR NEW.offer_kind<>o.offer_kind
    OR NEW.price_minor<>(b.requirements->>'lockedPriceMinor')::integer OR per.amount_minor<>NEW.price_minor
    OR NEW.provider_event_id<>per.provider_event_id OR NEW.sold_at<>per.recorded_at
    OR hon.saas_lifetime_unavailable_reason(o.id) IS NOT NULL
    OR NEW.sale_number<>(SELECT count(*)+1 FROM hon.saas_lifetime_sales x WHERE x.offer_id=o.id)
  THEN RAISE EXCEPTION 'SAAS_LIFETIME_SALE_REFUSED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
-- At commit: the sale's payment must be the stored, counted invoice.paid event of that binding (only ingest writes those).
CREATE FUNCTION hon.verify_saas_lifetime_sale_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.saas_schedule_provider_events e JOIN hon.saas_schedule_paid_periods q
      ON q.binding_id=e.binding_id AND q.provider_event_id=e.provider_event_id
    WHERE e.binding_id=NEW.binding_id AND e.provider_event_id=NEW.provider_event_id AND q.id=NEW.paid_period_id
      AND e.event_type='invoice.paid' AND e.outcome='APPLIED' AND e.normalized->'receipt'->>'billingStatus'='ACTIVE')
  THEN RAISE EXCEPTION 'SAAS_LIFETIME_SALE_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

-- ---------- ingest: count the sale with the first lifetime payment, or hold the payment (0279 body) ----------
CREATE OR REPLACE FUNCTION hon.ingest_saas_schedule_evidence(p jsonb,p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; e hon.saas_schedule_provider_events%ROWTYPE; org uuid; bid uuid;
  req uuid:=gen_random_uuid(); at timestamptz:=clock_timestamp(); occurred_at timestamptz; period_id uuid;
  outcome text:='NEEDS_REVIEW'; reason text:='RECONCILIATION_REQUIRED'; first_payment boolean:=false; collecting boolean;
  access jsonb:=jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false); result jsonb; founder_offer uuid;
  lifetime_offer uuid; covered_ends timestamptz; covered_starts timestamptz;
BEGIN
  IF p_digest !~ '^[0-9a-f]{64}$' OR p_digest<>hon.saas_hon_os_digest(p)
    OR NOT hon.saas_trial_keys(p,ARRAY['accountReference','amountMinor','bindingId','coveredPeriod','currency','eventId','eventType','invoiceReference','mode','occurredAt','provider','relatedInvoiceReference','scheduleReference','subscriptionReference'])
    OR p->>'provider'<>'STRIPE_SIMULATED' OR p->>'mode'<>'TEST' OR p->>'eventId' !~ '^evt_[A-Za-z0-9_]{1,200}$'
    OR p->>'eventType' NOT IN ('invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created')
    OR coalesce(p->>'bindingId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT (p->>'accountReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'subscriptionReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'scheduleReference' ~ '^fake_[a-z0-9_-]{1,150}$')
    OR p->>'currency'<>'USD' OR jsonb_typeof(p->'amountMinor')<>'number' OR coalesce(p->>'amountMinor','') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'occurredAt')<>'string' OR coalesce(p->>'occurredAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  BEGIN occurred_at:=(p->>'occurredAt')::timestamptz;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END;
  IF occurred_at>at+interval '5 minutes' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  -- Serialize same-event deliveries before the immutable-ledger lookup.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.schedule.provider-event:' || (p->>'eventId'),0));
  SELECT * INTO e FROM hon.saas_schedule_provider_events WHERE provider='STRIPE_SIMULATED' AND provider_event_id=p->>'eventId';
  IF e.id IS NOT NULL THEN
    IF e.payload_digest<>p_digest THEN RAISE EXCEPTION 'SAAS_SCHEDULE_EVENT_CONFLICT' USING ERRCODE='23505'; END IF;
    RETURN e.normalized->'receipt';
  END IF;
  PERFORM hon.saas_refuse_context(); PERFORM hon.saas_schedule_payment_program();
  -- The binding is found by the provider's own references; the payload's bindingId must agree but never selects it.
  SELECT id,organization_id INTO bid,org FROM hon.saas_schedule_bindings
    WHERE provider_account_reference=p->>'accountReference' AND provider_subscription_reference=p->>'subscriptionReference'
      AND provider_schedule_reference=p->>'scheduleReference';
  IF bid IS NULL OR bid::text<>p->>'bindingId' THEN RAISE EXCEPTION 'SAAS_SCHEDULE_EVENT_NOT_READY' USING ERRCODE='55P03'; END IF;
  -- Canonical order: event id -> organization -> binding row -> paid periods.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||org::text,0));
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=bid FOR UPDATE;
  collecting:=b.status IN ('BOUND_TEST_ONLY','ACTIVE');
  -- Piece 4: a founder binding's first payment counts a spot under the one pool lock (after the binding row lock).
  founder_offer:=hon.saas_schedule_binding_founder_offer(b);
  IF founder_offer IS NOT NULL AND b.status='BOUND_TEST_ONLY' AND p->>'eventType'='invoice.paid' THEN
    PERFORM 1 FROM hon.saas_founder_pool WHERE pool_id=1 FOR UPDATE;
  END IF;
  -- 0306: a lifetime binding's first payment counts one sale of its offer under that offer row's lock (after the binding).
  lifetime_offer:=hon.saas_schedule_binding_lifetime_offer(b);
  IF lifetime_offer IS NOT NULL AND b.status='BOUND_TEST_ONLY' AND p->>'eventType'='invoice.paid' THEN
    PERFORM 1 FROM hon.saas_offer_set_offers WHERE id=lifetime_offer FOR UPDATE;
  END IF;
  IF NOT collecting THEN
    -- Stored for review instead of refused: money for a parked or ended binding must never be lost or retried forever.
    IF p->>'eventType'='invoice.payment_failed' THEN outcome:='ATTEMPT_FAILED'; reason:='PAYMENT_NOT_VERIFIED';
    ELSIF b.status<>'NEEDS_REVIEW' AND p->>'eventType'='invoice.paid' THEN reason:='PAID_AFTER_TERMINAL';
    ELSE reason:='BINDING_NOT_COLLECTING'; END IF;
  ELSIF p->>'eventType'='invoice.paid' THEN
    -- 0306: a one-time (lifetime) payment reports coveredPeriod.endsAt null (open-ended); every recurring payment a time.
    IF p->'coveredPeriod' IS NULL OR jsonb_typeof(p->'coveredPeriod')<>'object' OR jsonb_typeof(p->'coveredPeriod'->'startsAt')<>'string'
      OR jsonb_typeof(p->'coveredPeriod'->'endsAt') IS DISTINCT FROM (CASE WHEN b.requirements->>'billingInterval'='ONE_TIME' THEN 'null' ELSE 'string' END)
      OR coalesce(p->'coveredPeriod'->>'startsAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
      OR (jsonb_typeof(p->'coveredPeriod'->'endsAt')='string' AND p->'coveredPeriod'->>'endsAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$')
      OR coalesce(p->>'invoiceReference','') !~ '^fake_[a-z0-9_-]{1,150}$' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
    BEGIN covered_starts:=(p->'coveredPeriod'->>'startsAt')::timestamptz;
      covered_ends:=coalesce((p->'coveredPeriod'->>'endsAt')::timestamptz,'infinity'::timestamptz);
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END;
    IF covered_ends <= covered_starts THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
    -- The single locked price, fixed at acceptance (owner answer 4a). Never derived from current offers or a count.
    IF (p->>'amountMinor')::integer<>(b.requirements->>'lockedPriceMinor')::integer THEN reason:='AMOUNT_MISMATCH';
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id AND q.provider_invoice_reference=p->>'invoiceReference') THEN outcome:='ALREADY_APPLIED'; reason:='DUPLICATE_INVOICE_REFERENCE';
    -- One payment covers exactly one billing interval of the locked terms; any other length is reviewed, never counted.
    ELSIF NOT hon.saas_schedule_period_matches(b.requirements->>'billingInterval',covered_starts,covered_ends) THEN reason:='PERIOD_INTERVAL_MISMATCH';
    -- A second lifetime payment always overlaps the open-ended first one, so it is reviewed, never counted.
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id AND tstzrange(q.covered_starts_at,q.covered_ends_at,'[)') && tstzrange(covered_starts,covered_ends,'[)')) THEN reason:='OVERLAPPING_COVERED_PERIOD';
    -- Piece 4: the last spot was taken first (or this organization already used its one spot). The payment is held for
    -- HQ review, never counted, never auto-refunded (owner answer 3).
    ELSIF founder_offer IS NOT NULL AND b.status='BOUND_TEST_ONLY' AND hon.saas_founder_unavailable_reason(b.organization_id,founder_offer) IS NOT NULL
      THEN reason:='FOUNDER_SPOT_UNAVAILABLE';
    -- 0306: the offer's HQ sale limit was reached first. Held for HQ review and refund, never counted or auto-refunded.
    ELSIF lifetime_offer IS NOT NULL AND b.status='BOUND_TEST_ONLY' AND hon.saas_lifetime_unavailable_reason(lifetime_offer) IS NOT NULL
      THEN reason:='LIFETIME_SALE_LIMIT_REACHED';
    ELSE
      -- A late earlier period is recorded normally; only overlap needs review.
      INSERT INTO hon.saas_schedule_paid_periods(binding_id,provider_invoice_reference,provider_event_id,covered_starts_at,covered_ends_at,amount_minor,currency,recorded_at)
      VALUES(b.id,p->>'invoiceReference',p->>'eventId',covered_starts,covered_ends,(p->>'amountMinor')::integer,'USD',at)
      RETURNING id INTO period_id; outcome:='APPLIED'; reason:='QUALIFYING_PERIOD_RECORDED'; first_payment:=b.status='BOUND_TEST_ONLY';
      IF first_payment AND founder_offer IS NOT NULL THEN
        INSERT INTO hon.saas_founder_allocations(spot_number,organization_id,school_id,binding_id,paid_period_id,provider_event_id,offer_id,
          offer_set_id,offer_kind,locked_price_minor,allocated_at)
        SELECT (SELECT count(*)+1 FROM hon.saas_founder_allocations),b.organization_id,b.school_id,b.id,period_id,p->>'eventId',o.id,o.set_id,
          o.offer_kind,(b.requirements->>'lockedPriceMinor')::integer,at
        FROM hon.saas_offer_set_offers o WHERE o.id=founder_offer;
      END IF;
      IF first_payment AND lifetime_offer IS NOT NULL THEN
        INSERT INTO hon.saas_lifetime_sales(sale_number,offer_id,offer_set_id,offer_kind,organization_id,school_id,binding_id,paid_period_id,
          provider_event_id,price_minor,sold_at)
        SELECT (SELECT count(*)+1 FROM hon.saas_lifetime_sales x WHERE x.offer_id=o.id),o.id,o.set_id,o.offer_kind,b.organization_id,b.school_id,
          b.id,period_id,p->>'eventId',(b.requirements->>'lockedPriceMinor')::integer,at
        FROM hon.saas_offer_set_offers o WHERE o.id=lifetime_offer;
      END IF;
    END IF;
  ELSIF p->>'eventType'='invoice.payment_failed' THEN outcome:='ATTEMPT_FAILED'; reason:='PAYMENT_NOT_VERIFIED';
  ELSE
    SELECT id INTO period_id FROM hon.saas_schedule_paid_periods WHERE binding_id=b.id AND provider_invoice_reference=p->>'relatedInvoiceReference';
    reason:=CASE WHEN period_id IS NULL THEN 'UNLINKED_REVERSAL' ELSE 'REVERSAL_REVIEW_REQUIRED' END;
  END IF;
  -- Billing outcome first. It is final for this transaction whatever happens to access below.
  IF first_payment THEN
    b:=hon.saas_schedule_binding_transition(b,'ACTIVE','FIRST_PAYMENT_VERIFIED','saas.schedule_binding.transition',gen_random_uuid(),at);
  ELSIF outcome='NEEDS_REVIEW' AND collecting THEN
    b:=hon.saas_schedule_binding_transition(b,'NEEDS_REVIEW',reason,'saas.schedule_binding.transition',gen_random_uuid(),at);
  END IF;
  PERFORM hon.saas_claim_request(hon.saas_payment_actor(),req,'saas.schedule_evidence.ingest',hon.saas_fingerprint(ARRAY['saas.schedule_evidence.ingest',p->>'eventId',p_digest]),req,req);
  IF outcome='NEEDS_REVIEW' THEN INSERT INTO hon.saas_schedule_reconciliations(binding_id,provider_event_id,related_period_id,outcome,reason,created_at)
    VALUES(b.id,p->>'eventId',period_id,'NEEDS_REVIEW',reason,at); END IF;
  -- Access outcome second, isolated: the sub-block rolls back only the hook's own work.
  IF outcome='APPLIED' THEN
    BEGIN
      access:=hon.saas_schedule_after_paid_period(b.id,period_id,at);
      IF jsonb_typeof(access) IS DISTINCT FROM 'object' OR coalesce(access->>'accessActivation','') NOT IN ('APPLIED','EXTENDED','NEEDS_REVIEW','NOT_ATTEMPTED') THEN
        RAISE EXCEPTION 'SAAS_ACCESS_HOOK_CONTRACT';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      access:=jsonb_build_object('accessActivation','NEEDS_REVIEW','reason','ACCESS_HOOK_FAILED','accessGranted',false);
      INSERT INTO hon.saas_schedule_reconciliations(binding_id,provider_event_id,related_period_id,outcome,reason,created_at)
        VALUES(b.id,p->>'eventId',period_id,'NEEDS_REVIEW','ACCESS_HOOK_FAILED',at);
    END;
  END IF;
  result:=jsonb_build_object('providerEventId',p->>'eventId','bindingId',b.id,'outcome',outcome,'reason',reason,
    'billingStatus',b.status,'qualifyingPaidPeriodCount',(SELECT count(*)::integer FROM hon.saas_schedule_paid_periods WHERE binding_id=b.id),
    'access',access,'checkoutAvailable',false,'billingEnabled',false);
  INSERT INTO hon.saas_schedule_provider_events(provider,provider_mode,provider_event_id,payload_digest,binding_id,event_type,normalized,outcome,outcome_reason,request_key,provider_occurred_at,received_at)
    VALUES('STRIPE_SIMULATED','TEST',p->>'eventId',p_digest,b.id,p->>'eventType',p||jsonb_build_object('receipt',result),outcome,reason,req,occurred_at,at);
  PERFORM hon.saas_record(hon.saas_payment_actor(),req,'saas.schedule_evidence.ingest','saas.schedule_evidence.recorded','SCHEDULE_EVENT',
    (SELECT id FROM hon.saas_schedule_provider_events WHERE provider='STRIPE_SIMULATED' AND provider_event_id=p->>'eventId'),b.organization_id,NULL,result,result,at);
  RETURN result;
END $$;

-- ---------- access: lifetime activates open-ended, only with its counted sale (0279 body) ----------
CREATE OR REPLACE FUNCTION hon.saas_schedule_activate_access(p_binding uuid, p_period uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); b hon.saas_schedule_bindings%ROWTYPE; per hon.saas_schedule_paid_periods%ROWTYPE;
  ent hon.organization_entitlements%ROWTYPE; st hon.saas_access_states%ROWTYPE; reason text; prior jsonb; nxt jsonb; msg text;
BEGIN
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id = p_binding;
  SELECT * INTO per FROM hon.saas_schedule_paid_periods WHERE id = p_period AND binding_id = p_binding;
  -- Canonical order after the binding: entitlement, then access state.
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = b.organization_id FOR UPDATE;
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = b.organization_id FOR UPDATE;
  prior := hon.saas_entitlement_json(b.organization_id);
  reason := CASE
    WHEN b.id IS NULL OR per.id IS NULL THEN 'ACCESS_ACTIVATION_ERROR'
    WHEN NOT hon.saas_access_program_active() THEN 'ACCESS_PROGRAM_INACTIVE'
    WHEN b.status <> 'ACTIVE' THEN 'BILLING_NOT_ACTIVE'
    WHEN ent.organization_id IS NULL OR st.organization_id IS NULL OR st.state <> 'AWAITING_FIRST_PAYMENT' THEN 'ACCESS_STATE_NOT_ELIGIBLE'
    WHEN hon.saas_access_exception_live(b.organization_id) THEN 'EXCEPTION_ACTIVE'
    WHEN hon.saas_org_billing_conflict(b.organization_id) IS NOT NULL THEN 'BILLING_REVIEW_PENDING'
    -- Piece 4: a founder plan activates only with the spot its first verified payment counted (any later period of the
    -- same binding may activate it, e.g. the HQ retry uses the latest started period).
    WHEN hon.saas_schedule_binding_founder_offer(b) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM hon.saas_founder_allocations fa WHERE fa.binding_id = b.id) THEN 'FOUNDER_UNAVAILABLE'
    -- 0306: a lifetime plan activates only with the sale its first verified payment counted.
    WHEN hon.saas_schedule_binding_lifetime_offer(b) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM hon.saas_lifetime_sales ls WHERE ls.binding_id = b.id AND ls.paid_period_id = per.id) THEN 'LIFETIME_SALE_NOT_COUNTED'
    WHEN per.amount_minor <> (b.requirements->>'lockedPriceMinor')::integer THEN 'ACCESS_ACTIVATION_ERROR'
    WHEN per.covered_starts_at > p_at + interval '5 minutes' THEN 'PAID_PERIOD_NOT_STARTED'
    WHEN per.covered_ends_at <= p_at THEN 'PAID_PERIOD_ELAPSED' END;
  IF reason IS NULL THEN
    BEGIN
      UPDATE hon.organization_entitlements SET tier = 'COMPLETE', status = 'ACTIVE', effective_from = per.covered_starts_at,
          -- 0306: lifetime access is open-ended (NULL = no end); a recurring plan ends with its paid period plus grace.
          effective_until = CASE WHEN isfinite(per.covered_ends_at) THEN per.covered_ends_at + hon.saas_schedule_access_grace() END,
          version = version + 1, updated_at = p_at
        WHERE organization_id = b.organization_id AND version = ent.version;
      IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT'; END IF;
      nxt := hon.saas_entitlement_json(b.organization_id);
      UPDATE hon.saas_access_states SET state = 'PAYMENT_ACTIVE', reason = 'FIRST_PAYMENT_VERIFIED', version = version + 1,
          activation_source = 'SCHEDULE_BINDING', binding_id = b.id, first_paid_period_id = per.id, paid_through = per.covered_ends_at,
          changed_by_principal_id = actor, updated_at = p_at
        WHERE organization_id = b.organization_id AND version = st.version;
      IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT'; END IF;
      INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
          prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
        VALUES (b.organization_id, 'SCHEDULE_FIRST_PAYMENT_ACTIVATION', 'APPLIED', 'FIRST_PAYMENT_VERIFIED', b.id, per.id, per.provider_event_id,
          prior, nxt, actor, p_at);
      RETURN jsonb_build_object('accessActivation','APPLIED','accessGranted',true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
      reason := 'ACCESS_ACTIVATION_ERROR';
    END;
  END IF;
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
      prior_entitlement, actor_principal_id, occurred_at)
    VALUES (b.organization_id, 'SCHEDULE_FIRST_PAYMENT_ACTIVATION', 'NEEDS_REVIEW', reason, b.id, per.id, per.provider_event_id,
      hon.saas_entitlement_json(b.organization_id), actor, p_at);
  RETURN jsonb_build_object('accessActivation','NEEDS_REVIEW','accessGranted',false,'reason',reason);
END $$;

-- ---------- RLS, immutability, ACLs and grants ----------
ALTER TABLE hon.saas_lifetime_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.saas_lifetime_sales FORCE ROW LEVEL SECURITY;
CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.saas_lifetime_sales FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_lifetime_sales FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_lifetime_sale_authority BEFORE INSERT ON hon.saas_lifetime_sales FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_lifetime_sale_insert();
CREATE CONSTRAINT TRIGGER saas_lifetime_sale_evidence AFTER INSERT ON hon.saas_lifetime_sales DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_lifetime_sale_evidence();
DO $$ DECLARE r text; c text; f text; BEGIN
  REVOKE ALL ON TABLE hon.saas_lifetime_sales FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.saas_lifetime_sales FROM %I',r); END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid='hon.saas_lifetime_sales'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.saas_lifetime_sales FROM PUBLIC',c);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.saas_lifetime_sales FROM %I',c,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.saas_hon_os_offer_usage(uuid,timestamp with time zone,uuid)','hon.saas_lifetime_unavailable_reason(uuid)',
    'hon.saas_schedule_binding_lifetime_offer(hon.saas_schedule_bindings)','hon.saas_schedule_binding_founder_offer(hon.saas_schedule_bindings)',
    'hon.saas_hon_os_school_refusal(uuid,hon.saas_offer_set_offers,timestamp with time zone)',
    'hon.saas_price_content(uuid,uuid)','hon.saas_price_acceptance_preview(uuid,uuid,uuid)','hon.saas_generation_content(uuid,uuid)',
    'hon.saas_generation_available(uuid)','hon.saas_schedule_requirements(hon.saas_subscription_generations)',
    'hon.saas_schedule_period_matches(text,timestamp with time zone,timestamp with time zone)',
    'hon.guard_saas_lifetime_binding_insert()','hon.guard_saas_lifetime_sale_insert()','hon.verify_saas_lifetime_sale_evidence()',
    'hon.ingest_saas_schedule_evidence(jsonb,text)','hon.saas_schedule_activate_access(uuid,uuid,timestamp with time zone)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.ingest_saas_schedule_evidence(jsonb,text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
