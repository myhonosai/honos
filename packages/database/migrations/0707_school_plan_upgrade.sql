BEGIN;

-- HQ Plan builder piece 5a: a paid subscription opens the plan's features (David 2026-11-28: "It should be limited but
-- opens up when they opt in to regular subscription"). Test mode only: the 0230 schedule provider is STRIPE_SIMULATED,
-- the paid-access program stays INACTIVE, and nothing here charges, grants credits or changes an entitlement.
-- - Locks follow a paid subscription first: while the organization's access is PAYMENT_ACTIVATED, through an ACTIVE 0230
--   schedule binding or an IN_SERVICE 0182 HON OS checkout subscription, hon.school_plan_features uses that purchase's offer
--   capability list (source SUBSCRIPTION). Otherwise
--   it is the 0699 rule unchanged (HQ assignment; none, custom or removed locks nothing).
-- - Per-plan price terms: hon.saas_price_content (0306 body) counts the regular monthly offer, and a founder offer's standard
--   price, within the offer's own plan (offers that share a display name, 0697) when that plan has one, else in the whole
--   set as before. Every set that worked before gives exactly the same terms and digests, so recorded schedules and
--   acceptances are unchanged; a set with several plans now works per plan.
-- - hon.read_saas_school_price_schedules: an exact-school purchaser (billing.hon.purchase) sees the current price
--   schedule of each offer in the published set, so the subscription page can preview and accept exact terms.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Plan upgrade requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.read_school_plan_features(text,uuid)') IS NULL THEN RAISE EXCEPTION 'Apply migration 0699 first'; END IF;
END $$;

-- ---------- per-plan price terms (0306 body; plan = offers sharing a display name) ----------
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
  SELECT count(*),min(price_minor) INTO n,monthly FROM hon.saas_offer_set_offers WHERE set_id=s.id AND offer_kind='REGULAR_MONTHLY'
   AND (display_name=o.display_name OR NOT EXISTS (SELECT 1 FROM hon.saas_offer_set_offers x WHERE x.set_id=s.id
    AND x.offer_kind='REGULAR_MONTHLY' AND x.display_name=o.display_name));
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
 -- 0707: the offer's own plan first; a plan with no such offer (every set before 0697 named each offer on its own) keeps
 -- the 0306 whole-set rule, so terms and digests of every set that worked before are unchanged.
 SELECT count(*),min(price_minor) INTO n,monthly FROM hon.saas_offer_set_offers WHERE set_id=s.id AND offer_kind='REGULAR_MONTHLY'
   AND (display_name=o.display_name OR NOT EXISTS (SELECT 1 FROM hon.saas_offer_set_offers x WHERE x.set_id=s.id
    AND x.offer_kind='REGULAR_MONTHLY' AND x.display_name=o.display_name));
 SELECT count(*),min(price_minor) INTO ns,standard FROM hon.saas_offer_set_offers WHERE set_id=s.id
  AND offer_kind=CASE WHEN annual THEN 'REGULAR_ANNUAL' ELSE 'REGULAR_MONTHLY' END
  AND (display_name=o.display_name OR NOT EXISTS (SELECT 1 FROM hon.saas_offer_set_offers x WHERE x.set_id=s.id
   AND x.offer_kind=CASE WHEN annual THEN 'REGULAR_ANNUAL' ELSE 'REGULAR_MONTHLY' END AND x.display_name=o.display_name));
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

-- ---------- locks follow a paid subscription first ----------
CREATE OR REPLACE FUNCTION hon.school_plan_features(p_org uuid, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE cur hon.hq_school_plan_assignments%ROWTYPE; every text[] := hon.saas_plan_capabilities('COMPLETE'); included text[];
  src text; plan text;
BEGIN
  -- 0707: a verified paid subscription (0230 schedule binding that activated access) decides first.
  IF (hon.saas_organization_access(p_org)->>'source') = 'PAYMENT_ACTIVATED' THEN
    -- Either payment path (0235): a 0230 schedule binding (its offer) or a 0182 HON OS checkout (its subscription's offer).
    SELECT o.capabilities, o.display_name INTO included, plan FROM hon.saas_access_states st
      LEFT JOIN hon.saas_schedule_bindings b ON st.activation_source = 'SCHEDULE_BINDING' AND b.id = st.binding_id
        AND b.organization_id = st.organization_id AND b.status = 'ACTIVE'
      LEFT JOIN hon.saas_subscriptions sub ON st.activation_source IS NULL AND sub.id = st.subscription_id
        AND sub.organization_id = st.organization_id AND sub.status = 'IN_SERVICE'
      JOIN hon.saas_offer_set_offers o ON o.id::text = coalesce(b.requirements->>'offerId', sub.hon_os_offer_id::text)
    WHERE st.organization_id = p_org AND st.state = 'PAYMENT_ACTIVE';
    IF included IS NOT NULL THEN src := 'SUBSCRIPTION'; END IF;
  END IF;
  IF included IS NULL THEN
    cur := hon.hq_school_plan_current(p_org);
    IF cur.action = 'ASSIGN' AND cur.source = 'OFFER' AND cur.school_id = p_school THEN
      SELECT o.capabilities INTO included FROM hon.saas_offer_set_offers o WHERE o.id = cur.offer_id;
      src := 'OFFER'; plan := cur.plan_name;
    END IF;
  END IF;
  IF included IS NULL THEN
    RETURN jsonb_build_object('source', CASE WHEN cur.action = 'ASSIGN' THEN cur.source ELSE 'NONE' END,
      'planName', CASE WHEN cur.action = 'ASSIGN' THEN cur.plan_name END,
      'included', to_jsonb(every), 'locked', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object('source', src, 'planName', plan,
    'included', to_jsonb(ARRAY(SELECT c FROM unnest(every) WITH ORDINALITY AS x(c, n) WHERE c = ANY(included) ORDER BY n)),
    'locked', to_jsonb(ARRAY(SELECT c FROM unnest(every) WITH ORDINALITY AS x(c, n) WHERE NOT c = ANY(included) ORDER BY n)));
END $$;

-- ---------- the current price schedule of each published offer, for an exact-school purchaser ----------
CREATE FUNCTION hon.read_saas_school_price_schedules(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  IF actor.principal_id IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('schoolId', p_school,
    'schedules', (SELECT coalesce(jsonb_agg(jsonb_build_object('offerId', x.offer_id, 'scheduleId', x.id, 'version', x.version)
        ORDER BY o.position, x.offer_id), '[]'::jsonb)
      FROM (SELECT DISTINCT ON (ps.offer_id) ps.* FROM hon.saas_price_schedules ps ORDER BY ps.offer_id, ps.version DESC) x
      JOIN hon.saas_offer_set_offers o ON o.id = x.offer_id
      JOIN hon.saas_offer_sets s ON s.id = o.set_id AND s.status = 'PUBLISHED'),
    'asOf', hon.saas_ts(clock_timestamp()));
END $$;

DO $$ DECLARE r text; f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.saas_price_content(uuid,uuid)','hon.school_plan_features(uuid,uuid)',
      'hon.read_saas_school_price_schedules(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role',
        'hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_school_price_schedules(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
