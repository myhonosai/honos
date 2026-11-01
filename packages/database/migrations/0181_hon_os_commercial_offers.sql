BEGIN;

-- HON OS commercial offers (HQ Pricing & Offers). One customer-facing product, HON OS, whose capability policy
-- is the former Complete entitlement, sold through several independently identified payment offers: regular
-- monthly, regular annual, founder monthly, founder annual, lifetime and founder lifetime.
-- - Offers live in versioned offer sets. The HQ owner drafts and revises a set, previews it (quotes, readiness and a
--   server-computed preview digest), then explicitly approves and publishes exactly the previewed content. A published
--   set and its offers are immutable; a price change is a new set version with new offer IDs, so it can only ever
--   apply to future purchases. Sales of one published offer can be stopped (irreversibly, for that version).
-- - Nothing here sells anything. No checkout, subscription, invoice, entitlement, credit, provider or Stripe object is
--   created or changed; the B5 checkout and B6A paid-access paths and the legacy Core/Complete catalog (0154) are
--   untouched, and an offer ID from this file is not a catalog offer, so the existing checkout refuses it.
--   Connecting HON OS offers to checkout is a separate reviewed change.
-- - Legacy Essential/Core/Complete catalogs, subscriptions, founder reservations, invoices, refunds and allowances are
--   not read for authority and not modified. The planned premium-credit amount is planning metadata, never a grant.
-- Number: 0179 is reserved for E1b-2 and 0180 for E1c.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS commercial offers require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS commercial offers require a restricted runtime';
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
  'saas.offers.draft','saas.offers.revise','saas.offers.discard','saas.offers.publish','saas.offers.stop_sales'));
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION',
  'INVOICE','PAYMENT_EVIDENCE','CREDIT_PROGRAM','COST_EVIDENCE','PRICING','ALLOWANCE','CREDIT_RESERVATION',
  'REFUND_REQUEST','REWARD_FULFILLMENT','REWARD_APPLICATION','REFERRAL_ALERT','PAYMENT_PROGRAM','CHECKOUT','PROVIDER_EVENT','ACCESS_STATE',
  'OFFER_SET','OFFER'));
ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published',
  'saas.founder.reserved','saas.founder.released','saas.subscription.recorded','saas.subscription.changed',
  'saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded',
  'saas.credits.program_changed','saas.credits.cost_recorded','saas.credits.pricing_drafted','saas.credits.pricing_published',
  'saas.credits.allowance_changed','saas.credits.reserved','saas.credits.settled','saas.credits.resolved',
  'saas.refund.requested','saas.refund.decided','saas.rewards.fulfillment_changed','saas.rewards.applied','saas.rewards.credit_applied',
  'saas.rewards.alert_resolved','saas.payments.program_changed','saas.checkout.created','saas.checkout.changed','saas.checkouts.swept',
  'saas.provider.event_recorded','saas.access.awaiting','saas.access.retried',
  'saas.offers.drafted','saas.offers.revised','saas.offers.discarded','saas.offers.published','saas.offers.sales_stopped'));

-- ---------- tables ----------
-- One row per offer-set version. Only one set is PUBLISHED; publishing retires the previous one.
CREATE TABLE hon.saas_offer_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_version integer NOT NULL UNIQUE CHECK (set_version > 0),
  product_code text NOT NULL DEFAULT 'HON_OS' CHECK (product_code = 'HON_OS'),
  capability_policy_version integer NOT NULL DEFAULT 1 CHECK (capability_policy_version = 1),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED','DISCARDED')),
  revision integer NOT NULL CHECK (revision > 0),
  based_on_set_id uuid REFERENCES hon.saas_offer_sets(id) ON DELETE RESTRICT,
  terms_reference text CHECK (terms_reference IS NULL OR (length(terms_reference) BETWEEN 1 AND 500 AND btrim(terms_reference) = terms_reference)),
  founder_total_limit integer CHECK (founder_total_limit BETWEEN 0 AND 1000),
  approved_preview_digest text CHECK (approved_preview_digest IS NULL OR approved_preview_digest ~ '^[0-9a-f]{64}$'),
  charges_enabled boolean NOT NULL DEFAULT false CHECK (charges_enabled = false),
  credit_grants_enabled boolean NOT NULL DEFAULT false CHECK (credit_grants_enabled = false),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  revised_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL,
  published_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  published_at timestamptz,
  retired_at timestamptz,
  discarded_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  discarded_at timestamptz,
  CHECK ((status IN ('PUBLISHED','RETIRED')) = (published_at IS NOT NULL)),
  CHECK ((published_at IS NULL) = (published_by_principal_id IS NULL) AND (published_at IS NULL) = (approved_preview_digest IS NULL)),
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL)),
  CHECK ((status = 'DISCARDED') = (discarded_at IS NOT NULL) AND (discarded_at IS NULL) = (discarded_by_principal_id IS NULL))
);
CREATE UNIQUE INDEX saas_offer_sets_one_published ON hon.saas_offer_sets ((true)) WHERE status = 'PUBLISHED';

-- One row per offer in a set. The row id is that offer version's identity; offer_code is stable across versions.
CREATE TABLE hon.saas_offer_set_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES hon.saas_offer_sets(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 12),
  offer_code text NOT NULL CHECK (offer_code ~ '^[A-Z][A-Z0-9_]{2,47}$'),
  offer_kind text NOT NULL CHECK (offer_kind IN ('REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL','LIFETIME','FOUNDER_LIFETIME')),
  billing_interval text NOT NULL CHECK (billing_interval = CASE WHEN offer_kind LIKE '%_MONTHLY' THEN 'MONTHLY'
    WHEN offer_kind LIKE '%_ANNUAL' THEN 'ANNUAL' ELSE 'ONE_TIME' END),
  founder boolean NOT NULL CHECK (founder = (offer_kind LIKE 'FOUNDER_%')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80 AND btrim(display_name) = display_name),
  price_minor integer NOT NULL CHECK (price_minor BETWEEN 100 AND 10000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  sales_opens_at timestamptz,
  sales_closes_at timestamptz CHECK (sales_closes_at IS NULL OR sales_opens_at IS NULL OR sales_closes_at > sales_opens_at),
  eligibility text NOT NULL CHECK (eligibility IN ('ANY_ACTIVE_ORGANIZATION','NEW_ORGANIZATIONS_ONLY')),
  sale_limit integer CHECK (sale_limit BETWEEN 1 AND 10000),
  price_lock text NOT NULL CHECK (price_lock IN ('NONE','WHILE_CONTINUOUSLY_SUBSCRIBED','FIXED_MONTHS')),
  price_lock_months integer CHECK (price_lock_months BETWEEN 1 AND 120),
  annual_renewal text CHECK (annual_renewal IN ('AUTO_RENEW_AT_LOCKED_PRICE','AUTO_RENEW_AT_CURRENT_PRICE','NO_AUTO_RENEWAL')),
  planned_monthly_premium_credits integer CHECK (planned_monthly_premium_credits BETWEEN 0 AND 1000000),
  ai_fair_use_reference text CHECK (ai_fair_use_reference IS NULL OR (length(ai_fair_use_reference) BETWEEN 1 AND 500 AND btrim(ai_fair_use_reference) = ai_fair_use_reference)),
  refund_window_days integer CHECK (refund_window_days BETWEEN 0 AND 365),
  cancellation_timing text CHECK (cancellation_timing IN ('END_OF_PAID_PERIOD')),
  UNIQUE (set_id, offer_code),
  UNIQUE (set_id, position),
  CHECK ((price_lock = 'FIXED_MONTHS') = (price_lock_months IS NOT NULL)),
  CHECK (billing_interval <> 'ONE_TIME' OR (price_lock = 'NONE' AND cancellation_timing IS NULL)),
  CHECK ((billing_interval = 'ANNUAL') = (annual_renewal IS NOT NULL))
);

-- Stopping new sales of a published offer version. Append-only; a stopped offer returns only as a new set version.
CREATE TABLE hon.saas_offer_sales_stops (
  offer_id uuid PRIMARY KEY REFERENCES hon.saas_offer_set_offers(id) ON DELETE RESTRICT,
  set_id uuid NOT NULL REFERENCES hon.saas_offer_sets(id) ON DELETE RESTRICT,
  reason_code text NOT NULL CHECK (reason_code IN ('OWNER_DISABLED','PRICE_CHANGE_PENDING','TERMS_REVIEW')),
  stopped_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  stopped_at timestamptz NOT NULL
);

-- ---------- guards ----------
CREATE FUNCTION hon.guard_saas_offer_sets() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE before_row jsonb; after_row jsonb;
  draft_fields constant text[] := ARRAY['revision','terms_reference','founder_total_limit','revised_by_principal_id','updated_at'];
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE = '42501'; END IF;
  before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
  IF (OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND NEW.revision = OLD.revision + 1
        AND (after_row - draft_fields) = (before_row - draft_fields))
    OR (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED'
        AND (after_row - ARRAY['status','published_by_principal_id','published_at','approved_preview_digest'])
          = (before_row - ARRAY['status','published_by_principal_id','published_at','approved_preview_digest']))
    OR (OLD.status = 'DRAFT' AND NEW.status = 'DISCARDED'
        AND (after_row - ARRAY['status','discarded_by_principal_id','discarded_at']) = (before_row - ARRAY['status','discarded_by_principal_id','discarded_at']))
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
        AND (after_row - ARRAY['status','retired_at']) = (before_row - ARRAY['status','retired_at'])) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

-- Offer rows are written or replaced only while their set is a draft; never updated.
CREATE FUNCTION hon.guard_saas_offer_set_offers() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM hon.saas_offer_sets s WHERE s.id = NEW.set_id AND s.status = 'DRAFT') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM hon.saas_offer_sets s WHERE s.id = OLD.set_id AND s.status = 'DRAFT') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_OFFER' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.saas_offer_sets FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_offer_sets();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_offer_sets FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_offer_sets();
CREATE TRIGGER saas_offer_rows BEFORE INSERT OR UPDATE OR DELETE ON hon.saas_offer_set_offers FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_offer_set_offers();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_offer_set_offers FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_offer_set_offers();
CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.saas_offer_sales_stops FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_offer_sales_stops FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- ---------- product policy and json ----------
-- The one HON OS product: the COMPLETE entitlement capability list (0154). Every offer grants this same product;
-- a capability listed here is an entitlement policy, not a claim that the capability is built or available today.
CREATE FUNCTION hon.saas_hon_os_product_json() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('productCode','HON_OS','displayName','HON OS','entitlementTier','COMPLETE','capabilityPolicyVersion',1,
    'capabilities',to_jsonb(hon.saas_plan_capabilities('COMPLETE')),'capabilityStatus','ENTITLEMENT_POLICY_NOT_A_READINESS_CLAIM',
    'legacyTiersForNewSale',false)
$$;

CREATE FUNCTION hon.saas_offer_json(o hon.saas_offer_set_offers) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('offerId',o.id,'offerCode',o.offer_code,'position',o.position,'offerKind',o.offer_kind,
    'billingInterval',o.billing_interval,'founder',o.founder,'displayName',o.display_name,'priceMinor',o.price_minor,'currency',o.currency,
    'salesOpensAt',hon.saas_ts(o.sales_opens_at),'salesClosesAt',hon.saas_ts(o.sales_closes_at),'eligibility',o.eligibility,
    'saleLimit',o.sale_limit,'priceLock',o.price_lock,'priceLockMonths',o.price_lock_months,'annualRenewal',o.annual_renewal,
    'plannedMonthlyPremiumCredits',o.planned_monthly_premium_credits,'premiumCreditsStatus','PLANNING_ONLY_NOT_A_CREDIT_GRANT',
    'aiFairUseReference',o.ai_fair_use_reference,'refundWindowDays',o.refund_window_days,'cancellationTiming',o.cancellation_timing,
    'salesStop',(SELECT jsonb_build_object('reasonCode',x.reason_code,'stoppedAt',hon.saas_ts(x.stopped_at))
      FROM hon.saas_offer_sales_stops x WHERE x.offer_id = o.id))
$$;

CREATE FUNCTION hon.saas_offer_set_json(p_set uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('setId',s.id,'setVersion',s.set_version,'productCode',s.product_code,'status',s.status,'revision',s.revision,
    'basedOnSetId',s.based_on_set_id,'termsReference',s.terms_reference,'founderTotalLimit',s.founder_total_limit,
    'offers',(SELECT coalesce(jsonb_agg(hon.saas_offer_json(o) ORDER BY o.position),'[]'::jsonb) FROM hon.saas_offer_set_offers o WHERE o.set_id = s.id),
    'approvedPreviewDigest',s.approved_preview_digest,'chargesEnabled',false,'creditGrantsEnabled',false,
    'createdAt',hon.saas_ts(s.created_at),'updatedAt',hon.saas_ts(s.updated_at),'publishedAt',hon.saas_ts(s.published_at),
    'retiredAt',hon.saas_ts(s.retired_at),'discardedAt',hon.saas_ts(s.discarded_at))
  FROM hon.saas_offer_sets s WHERE s.id = p_set
$$;

-- Server-computed preview of a set: what each offer costs per month / per year, publication readiness, and the digest
-- the owner must echo to publish. The digest covers the set id, revision and every commercial field of every offer.
CREATE FUNCTION hon.saas_offer_set_preview(p_set uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE s hon.saas_offer_sets%ROWTYPE; content jsonb; issues jsonb := '[]'::jsonb; quotes jsonb; ref_monthly integer; ref_code text;
BEGIN
  SELECT * INTO s FROM hon.saas_offer_sets WHERE id = p_set;
  content := jsonb_build_object('setId',s.id,'revision',s.revision,'termsReference',s.terms_reference,'founderTotalLimit',s.founder_total_limit,
    'offers',(SELECT coalesce(jsonb_agg(hon.saas_offer_json(o) - ARRAY['offerId','salesStop'] ORDER BY o.position),'[]'::jsonb)
      FROM hon.saas_offer_set_offers o WHERE o.set_id = s.id));
  SELECT o.price_minor, o.offer_code INTO ref_monthly, ref_code FROM hon.saas_offer_set_offers o
    WHERE o.set_id = s.id AND o.offer_kind = 'REGULAR_MONTHLY' ORDER BY o.position LIMIT 1;
  IF s.terms_reference IS NULL THEN issues := issues || jsonb_build_array(jsonb_build_object('code','TERMS_REFERENCE_REQUIRED','offerCode',NULL)); END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.saas_offer_set_offers o WHERE o.set_id = s.id) THEN
    issues := issues || jsonb_build_array(jsonb_build_object('code','OFFER_REQUIRED','offerCode',NULL));
  END IF;
  IF s.founder_total_limit IS NULL AND EXISTS (SELECT 1 FROM hon.saas_offer_set_offers o WHERE o.set_id = s.id AND o.founder) THEN
    issues := issues || jsonb_build_array(jsonb_build_object('code','FOUNDER_LIMIT_REQUIRED','offerCode',NULL));
  END IF;
  issues := issues || coalesce((SELECT jsonb_agg(jsonb_build_object('code',x.code,'offerCode',x.offer_code) ORDER BY x.position, x.code) FROM (
      SELECT o.position, o.offer_code, 'REFUND_WINDOW_REQUIRED' code FROM hon.saas_offer_set_offers o WHERE o.set_id = s.id AND o.refund_window_days IS NULL
      UNION ALL SELECT o.position, o.offer_code, 'CANCELLATION_TIMING_REQUIRED' FROM hon.saas_offer_set_offers o
        WHERE o.set_id = s.id AND o.billing_interval <> 'ONE_TIME' AND o.cancellation_timing IS NULL
      UNION ALL SELECT o.position, o.offer_code, 'LIFETIME_FAIR_USE_REQUIRED' FROM hon.saas_offer_set_offers o
        WHERE o.set_id = s.id AND o.billing_interval = 'ONE_TIME' AND (o.ai_fair_use_reference IS NULL OR o.planned_monthly_premium_credits IS NULL)
      UNION ALL SELECT o.position, o.offer_code, 'LIFETIME_SALE_LIMIT_REQUIRED' FROM hon.saas_offer_set_offers o
        WHERE o.set_id = s.id AND o.billing_interval = 'ONE_TIME' AND o.sale_limit IS NULL) x), '[]'::jsonb);
  SELECT coalesce(jsonb_agg(jsonb_build_object('offerCode',o.offer_code,'offerKind',o.offer_kind,'billingInterval',o.billing_interval,
      'priceMinor',o.price_minor,'currency',o.currency,
      'monthlyEquivalentMinor',CASE o.billing_interval WHEN 'MONTHLY' THEN o.price_minor WHEN 'ANNUAL' THEN round(o.price_minor / 12.0)::integer END,
      'annualSavingsVsRegularMonthlyMinor',CASE WHEN o.billing_interval = 'ANNUAL' AND ref_monthly IS NOT NULL THEN 12 * ref_monthly - o.price_minor END,
      'lifetimeBreakEvenMonths',CASE WHEN o.billing_interval = 'ONE_TIME' AND ref_monthly IS NOT NULL THEN ceil(o.price_minor::numeric / ref_monthly)::integer END,
      'founderDiscountPercentVsRegular',CASE WHEN o.founder AND reg.price_minor IS NOT NULL
        THEN round(100.0 * (reg.price_minor - o.price_minor) / reg.price_minor)::integer END)
    ORDER BY o.position), '[]'::jsonb) INTO quotes
  FROM hon.saas_offer_set_offers o
  LEFT JOIN LATERAL (SELECT r.price_minor FROM hon.saas_offer_set_offers r WHERE r.set_id = o.set_id AND o.founder
      AND r.offer_kind = CASE o.offer_kind WHEN 'FOUNDER_MONTHLY' THEN 'REGULAR_MONTHLY' WHEN 'FOUNDER_ANNUAL' THEN 'REGULAR_ANNUAL' ELSE 'LIFETIME' END
      ORDER BY r.position LIMIT 1) reg ON true
  WHERE o.set_id = s.id;
  RETURN jsonb_build_object('setId',s.id,'revision',s.revision,'previewDigest',encode(sha256(convert_to(content::text,'UTF8')),'hex'),
    'ready',jsonb_array_length(issues) = 0,'issues',issues,'quotes',quotes,'comparisonOfferCode',ref_code,
    'effect','NEW_PURCHASES_ONLY','existingSubscriptionsRepriced',false,'product',hon.saas_hon_os_product_json());
END $$;

-- Strict input check for a set's commercial content. Raises INVALID_SAAS_INPUT on any unknown key, type or range.
CREATE FUNCTION hon.saas_offer_set_content_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE item jsonb; ts constant text := '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'; kind text; interval_kind text;
  nullable_int constant text[] := ARRAY['saleLimit','priceLockMonths','plannedMonthlyPremiumCredits','refundWindowDays'];
  nullable_text constant text[] := ARRAY['salesOpensAt','salesClosesAt','annualRenewal','aiFairUseReference','cancellationTiming'];
BEGIN
  IF jsonb_typeof(p->'termsReference') NOT IN ('string','null')
    OR (jsonb_typeof(p->'termsReference') = 'string' AND (length(p->>'termsReference') NOT BETWEEN 1 AND 500 OR btrim(p->>'termsReference') <> p->>'termsReference'))
    OR jsonb_typeof(p->'founderTotalLimit') NOT IN ('number','null')
    OR (jsonb_typeof(p->'founderTotalLimit') = 'number' AND ((p->>'founderTotalLimit') !~ '^[0-9]{1,4}$' OR (p->>'founderTotalLimit')::integer > 1000))
    OR jsonb_typeof(p->'offers') <> 'array' OR jsonb_array_length(p->'offers') NOT BETWEEN 1 AND 12 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'offers') LOOP
    IF jsonb_typeof(item) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k) IS DISTINCT FROM
        ARRAY['aiFairUseReference','annualRenewal','cancellationTiming','displayName','eligibility','offerCode','offerKind','plannedMonthlyPremiumCredits',
          'priceLock','priceLockMonths','priceMinor','refundWindowDays','saleLimit','salesClosesAt','salesOpensAt'] THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(item->'offerCode') <> 'string' OR item->>'offerCode' !~ '^[A-Z][A-Z0-9_]{2,47}$'
      OR jsonb_typeof(item->'offerKind') <> 'string'
      OR item->>'offerKind' NOT IN ('REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL','LIFETIME','FOUNDER_LIFETIME')
      OR jsonb_typeof(item->'displayName') <> 'string' OR length(item->>'displayName') NOT BETWEEN 1 AND 80 OR btrim(item->>'displayName') <> item->>'displayName'
      OR jsonb_typeof(item->'priceMinor') <> 'number' OR (item->>'priceMinor') !~ '^[0-9]{3,8}$' OR (item->>'priceMinor')::integer NOT BETWEEN 100 AND 10000000
      OR jsonb_typeof(item->'eligibility') <> 'string' OR item->>'eligibility' NOT IN ('ANY_ACTIVE_ORGANIZATION','NEW_ORGANIZATIONS_ONLY')
      OR jsonb_typeof(item->'priceLock') <> 'string' OR item->>'priceLock' NOT IN ('NONE','WHILE_CONTINUOUSLY_SUBSCRIBED','FIXED_MONTHS')
      OR EXISTS (SELECT 1 FROM unnest(nullable_int) k WHERE jsonb_typeof(item->k) NOT IN ('number','null')
        OR (jsonb_typeof(item->k) = 'number' AND (item->>k) !~ '^[0-9]{1,7}$'))
      OR EXISTS (SELECT 1 FROM unnest(nullable_text) k WHERE jsonb_typeof(item->k) NOT IN ('string','null')) THEN
      RETURN false;
    END IF;
    kind := item->>'offerKind';
    interval_kind := CASE WHEN kind LIKE '%_MONTHLY' THEN 'MONTHLY' WHEN kind LIKE '%_ANNUAL' THEN 'ANNUAL' ELSE 'ONE_TIME' END;
    IF (jsonb_typeof(item->'saleLimit') = 'number' AND (item->>'saleLimit')::integer NOT BETWEEN 1 AND 10000)
      OR (jsonb_typeof(item->'priceLockMonths') = 'number' AND (item->>'priceLockMonths')::integer NOT BETWEEN 1 AND 120)
      OR (jsonb_typeof(item->'plannedMonthlyPremiumCredits') = 'number' AND (item->>'plannedMonthlyPremiumCredits')::integer > 1000000)
      OR (jsonb_typeof(item->'refundWindowDays') = 'number' AND (item->>'refundWindowDays')::integer > 365)
      OR ((item->>'priceLock') = 'FIXED_MONTHS') <> (jsonb_typeof(item->'priceLockMonths') = 'number')
      OR (interval_kind = 'ONE_TIME' AND (item->>'priceLock' <> 'NONE' OR jsonb_typeof(item->'cancellationTiming') <> 'null'))
      OR (interval_kind = 'ANNUAL') <> (jsonb_typeof(item->'annualRenewal') = 'string')
      OR (jsonb_typeof(item->'annualRenewal') = 'string' AND item->>'annualRenewal' NOT IN ('AUTO_RENEW_AT_LOCKED_PRICE','AUTO_RENEW_AT_CURRENT_PRICE','NO_AUTO_RENEWAL'))
      OR (jsonb_typeof(item->'cancellationTiming') = 'string' AND item->>'cancellationTiming' <> 'END_OF_PAID_PERIOD')
      OR (jsonb_typeof(item->'aiFairUseReference') = 'string' AND (length(item->>'aiFairUseReference') NOT BETWEEN 1 AND 500
        OR btrim(item->>'aiFairUseReference') <> item->>'aiFairUseReference'))
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['salesOpensAt','salesClosesAt']) k WHERE jsonb_typeof(item->k) = 'string' AND (item->>k) !~ ts)
      OR (jsonb_typeof(item->'salesOpensAt') = 'string' AND jsonb_typeof(item->'salesClosesAt') = 'string'
        AND (item->>'salesClosesAt')::timestamptz <= (item->>'salesOpensAt')::timestamptz) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'offerCode') FROM jsonb_array_elements(p->'offers')) <> jsonb_array_length(p->'offers') THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION hon.saas_offer_set_write_content(p_set uuid, p jsonb) RETURNS void
LANGUAGE sql VOLATILE SET search_path = pg_catalog, hon AS $$
  INSERT INTO hon.saas_offer_set_offers(set_id,position,offer_code,offer_kind,billing_interval,founder,display_name,price_minor,
      sales_opens_at,sales_closes_at,eligibility,sale_limit,price_lock,price_lock_months,annual_renewal,planned_monthly_premium_credits,
      ai_fair_use_reference,refund_window_days,cancellation_timing)
  SELECT p_set, x.ord::integer, x.o->>'offerCode', x.o->>'offerKind',
    CASE WHEN x.o->>'offerKind' LIKE '%_MONTHLY' THEN 'MONTHLY' WHEN x.o->>'offerKind' LIKE '%_ANNUAL' THEN 'ANNUAL' ELSE 'ONE_TIME' END,
    x.o->>'offerKind' LIKE 'FOUNDER_%', x.o->>'displayName', (x.o->>'priceMinor')::integer,
    (x.o->>'salesOpensAt')::timestamptz, (x.o->>'salesClosesAt')::timestamptz, x.o->>'eligibility', (x.o->>'saleLimit')::integer,
    x.o->>'priceLock', (x.o->>'priceLockMonths')::integer, x.o->>'annualRenewal', (x.o->>'plannedMonthlyPremiumCredits')::integer,
    x.o->>'aiFairUseReference', (x.o->>'refundWindowDays')::integer, x.o->>'cancellationTiming'
  FROM jsonb_array_elements(p->'offers') WITH ORDINALITY AS x(o, ord)
$$;

-- Owner-only command prologue: identity locked and re-checked, then the idempotent request claimed.
CREATE FUNCTION hon.saas_offer_owner(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  RETURN hon.require_saas_hq_actor(p_subject, true);
END $$;

-- ---------- HQ reads (owner, or operator with hq.billing.manage) ----------
CREATE FUNCTION hon.read_saas_offer_management_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE at timestamptz := clock_timestamp(); pub uuid;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT id INTO pub FROM hon.saas_offer_sets WHERE status = 'PUBLISHED';
  RETURN jsonb_build_object('product',hon.saas_hon_os_product_json(),
    'published',CASE WHEN pub IS NULL THEN NULL ELSE hon.saas_offer_set_json(pub) END,
    'onSaleOfferIds',(SELECT coalesce(jsonb_agg(o.id ORDER BY o.position),'[]'::jsonb) FROM hon.saas_offer_set_offers o
      WHERE o.set_id = pub AND o.sales_opens_at IS NOT NULL AND o.sales_opens_at <= at AND (o.sales_closes_at IS NULL OR o.sales_closes_at > at)
        AND NOT EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops x WHERE x.offer_id = o.id)),
    'drafts',(SELECT coalesce(jsonb_agg(hon.saas_offer_set_json(s.id) ORDER BY s.set_version DESC),'[]'::jsonb)
      FROM (SELECT id, set_version FROM hon.saas_offer_sets WHERE status = 'DRAFT' ORDER BY set_version DESC LIMIT 20) s),
    'history',(SELECT coalesce(jsonb_agg(jsonb_build_object('setId',s.id,'setVersion',s.set_version,'status',s.status,'revision',s.revision,
        'offerCount',(SELECT count(*) FROM hon.saas_offer_set_offers o WHERE o.set_id = s.id),
        'createdAt',hon.saas_ts(s.created_at),'publishedAt',hon.saas_ts(s.published_at),'retiredAt',hon.saas_ts(s.retired_at),
        'discardedAt',hon.saas_ts(s.discarded_at)) ORDER BY s.set_version DESC),'[]'::jsonb)
      FROM (SELECT * FROM hon.saas_offer_sets ORDER BY set_version DESC LIMIT 100) s),
    -- Sales performance of HON OS offers needs the checkout connection; until then only legacy catalog sales exist.
    'honOsSales',jsonb_build_object('status','CHECKOUT_NOT_CONNECTED'),
    'legacySales',(SELECT coalesce(jsonb_agg(jsonb_build_object('catalogVersion',g.catalog_version,'planCode',g.plan_code,'offerKind',g.offer_kind,
        'priceMinor',g.price_minor,'status',g.status,'subscriptions',g.n) ORDER BY g.catalog_version, g.plan_code, g.offer_kind, g.price_minor, g.status),'[]'::jsonb)
      FROM (SELECT c.catalog_version, s.plan_code, s.offer_kind, s.price_minor, s.status, count(*)::integer n
        FROM hon.saas_subscriptions s JOIN hon.saas_catalog_versions c ON c.id = s.catalog_id
        WHERE s.source = 'CATALOG_OFFER' GROUP BY 1,2,3,4,5) g),
    'paidAccessProgram',CASE WHEN hon.saas_access_program_active() THEN 'ACTIVE' ELSE 'INACTIVE' END,
    'purchase','NOT_CONNECTED','chargesEnabled',false,'creditGrantsEnabled',false);
END $$;

CREATE FUNCTION hon.read_saas_offer_set_from_hq(p_subject text, p_set uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF p_set IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.saas_offer_sets WHERE id = p_set) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('set',hon.saas_offer_set_json(p_set),'preview',hon.saas_offer_set_preview(p_set));
END $$;

-- ---------- HQ owner commands ----------
CREATE FUNCTION hon.create_saas_offer_set_draft(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; created hon.saas_offer_sets%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['basedOnSetId','founderTotalLimit','offers','termsReference']
    OR jsonb_typeof(p->'basedOnSetId') NOT IN ('string','null')
    OR (jsonb_typeof(p->'basedOnSetId') = 'string' AND (p->>'basedOnSetId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR NOT hon.saas_offer_set_content_valid(p) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.saas_offer_owner(p_subject);
  replay := hon.saas_claim_request(actor, p_key, 'saas.offers.draft', hon.saas_fingerprint(ARRAY['saas.offers.draft', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.offer_sets', 0));
  IF jsonb_typeof(p->'basedOnSetId') = 'string' AND NOT EXISTS (SELECT 1 FROM hon.saas_offer_sets WHERE id = (p->>'basedOnSetId')::uuid) THEN
    RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  at := clock_timestamp();
  INSERT INTO hon.saas_offer_sets(set_version,status,revision,based_on_set_id,terms_reference,founder_total_limit,
      created_by_principal_id,created_at,revised_by_principal_id,updated_at)
    VALUES ((SELECT coalesce(max(set_version),0) + 1 FROM hon.saas_offer_sets),'DRAFT',1,(p->>'basedOnSetId')::uuid,p->>'termsReference',
      (p->>'founderTotalLimit')::integer,actor,at,actor,at)
    RETURNING * INTO created;
  PERFORM hon.saas_offer_set_write_content(created.id, p);
  snapshot := hon.saas_offer_set_json(created.id);
  RETURN hon.saas_record(actor, p_key, 'saas.offers.draft', 'saas.offers.drafted', 'OFFER_SET', created.id, NULL, NULL, snapshot,
    jsonb_build_object('set', snapshot, 'preview', hon.saas_offer_set_preview(created.id)), at);
END $$;

CREATE FUNCTION hon.revise_saas_offer_set_draft(p_subject text, p_set uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_offer_sets%ROWTYPE; prior_json jsonb; at timestamptz; snapshot jsonb;
BEGIN
  IF p_set IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedRevision','founderTotalLimit','offers','termsReference']
    OR jsonb_typeof(p->'expectedRevision') <> 'number' OR (p->>'expectedRevision') !~ '^[1-9][0-9]{0,8}$'
    OR NOT hon.saas_offer_set_content_valid(p) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.saas_offer_owner(p_subject);
  replay := hon.saas_claim_request(actor, p_key, 'saas.offers.revise', hon.saas_fingerprint(ARRAY['saas.offers.revise', p_set::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.offer_sets', 0));
  SELECT * INTO prior FROM hon.saas_offer_sets WHERE id = p_set FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF prior.status <> 'DRAFT' THEN RAISE EXCEPTION 'SAAS_OFFER_SET_NOT_DRAFT' USING ERRCODE = '40001'; END IF;
  IF prior.revision <> (p->>'expectedRevision')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  prior_json := hon.saas_offer_set_json(p_set);
  at := clock_timestamp();
  DELETE FROM hon.saas_offer_set_offers WHERE set_id = p_set;
  UPDATE hon.saas_offer_sets SET revision = revision + 1, terms_reference = p->>'termsReference',
    founder_total_limit = (p->>'founderTotalLimit')::integer, revised_by_principal_id = actor, updated_at = at WHERE id = p_set;
  PERFORM hon.saas_offer_set_write_content(p_set, p);
  snapshot := hon.saas_offer_set_json(p_set);
  RETURN hon.saas_record(actor, p_key, 'saas.offers.revise', 'saas.offers.revised', 'OFFER_SET', p_set, NULL, prior_json, snapshot,
    jsonb_build_object('set', snapshot, 'preview', hon.saas_offer_set_preview(p_set)), at);
END $$;

CREATE FUNCTION hon.discard_saas_offer_set_draft(p_subject text, p_set uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_offer_sets%ROWTYPE; prior_json jsonb; at timestamptz; snapshot jsonb;
BEGIN
  IF p_set IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedRevision']
    OR jsonb_typeof(p->'expectedRevision') <> 'number' OR (p->>'expectedRevision') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.saas_offer_owner(p_subject);
  replay := hon.saas_claim_request(actor, p_key, 'saas.offers.discard', hon.saas_fingerprint(ARRAY['saas.offers.discard', p_set::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.offer_sets', 0));
  SELECT * INTO prior FROM hon.saas_offer_sets WHERE id = p_set FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF prior.status <> 'DRAFT' THEN RAISE EXCEPTION 'SAAS_OFFER_SET_NOT_DRAFT' USING ERRCODE = '40001'; END IF;
  IF prior.revision <> (p->>'expectedRevision')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  prior_json := hon.saas_offer_set_json(p_set);
  at := clock_timestamp();
  UPDATE hon.saas_offer_sets SET status = 'DISCARDED', discarded_by_principal_id = actor, discarded_at = at WHERE id = p_set;
  snapshot := hon.saas_offer_set_json(p_set);
  RETURN hon.saas_record(actor, p_key, 'saas.offers.discard', 'saas.offers.discarded', 'OFFER_SET', p_set, NULL, prior_json, snapshot,
    jsonb_build_object('set', snapshot), at);
END $$;

-- Publishing is the owner's explicit approval of exactly the previewed revision: the echoed digest must equal the
-- server's digest of the draft as it stands, and every readiness issue must be resolved.
CREATE FUNCTION hon.publish_saas_offer_set(p_subject text, p_set uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; draft hon.saas_offer_sets%ROWTYPE; prior hon.saas_offer_sets%ROWTYPE; preview jsonb; at timestamptz; snapshot jsonb;
BEGIN
  IF p_set IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['approval','expectedRevision','previewDigest']
    OR jsonb_typeof(p->'expectedRevision') <> 'number' OR (p->>'expectedRevision') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'previewDigest') <> 'string' OR (p->>'previewDigest') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p->'approval') <> 'string' OR p->>'approval' <> 'APPROVE_FOR_NEW_PURCHASES_ONLY' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.saas_offer_owner(p_subject);
  replay := hon.saas_claim_request(actor, p_key, 'saas.offers.publish', hon.saas_fingerprint(ARRAY['saas.offers.publish', p_set::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.offer_sets', 0));
  SELECT * INTO draft FROM hon.saas_offer_sets WHERE id = p_set FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF draft.status <> 'DRAFT' THEN RAISE EXCEPTION 'SAAS_OFFER_SET_NOT_DRAFT' USING ERRCODE = '40001'; END IF;
  IF draft.revision <> (p->>'expectedRevision')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  preview := hon.saas_offer_set_preview(p_set);
  IF preview->>'previewDigest' <> p->>'previewDigest' THEN RAISE EXCEPTION 'SAAS_OFFER_PREVIEW_CHANGED' USING ERRCODE = '23514'; END IF;
  IF NOT (preview->>'ready')::boolean THEN RAISE EXCEPTION 'SAAS_OFFER_SET_NOT_READY' USING ERRCODE = '23514'; END IF;
  at := clock_timestamp();
  SELECT * INTO prior FROM hon.saas_offer_sets WHERE status = 'PUBLISHED' FOR UPDATE;
  IF FOUND THEN UPDATE hon.saas_offer_sets SET status = 'RETIRED', retired_at = at WHERE id = prior.id; END IF;
  UPDATE hon.saas_offer_sets SET status = 'PUBLISHED', published_by_principal_id = actor, published_at = at,
    approved_preview_digest = preview->>'previewDigest' WHERE id = p_set;
  snapshot := hon.saas_offer_set_json(p_set);
  RETURN hon.saas_record(actor, p_key, 'saas.offers.publish', 'saas.offers.published', 'OFFER_SET', p_set, NULL,
    CASE WHEN prior.id IS NULL THEN NULL ELSE jsonb_build_object('retiredSetId', prior.id, 'retiredSetVersion', prior.set_version) END, snapshot,
    jsonb_build_object('set', snapshot, 'retiredSetId', prior.id), at);
END $$;

CREATE FUNCTION hon.stop_saas_offer_sales(p_subject text, p_offer uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
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
  SELECT * INTO o FROM hon.saas_offer_set_offers WHERE id = p_offer;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.saas_offer_sets s WHERE s.id = o.set_id AND s.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'SAAS_OFFER_NOT_PUBLISHED' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops WHERE offer_id = p_offer) THEN
    RAISE EXCEPTION 'SAAS_OFFER_SALES_ALREADY_STOPPED' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  INSERT INTO hon.saas_offer_sales_stops(offer_id,set_id,reason_code,stopped_by_principal_id,stopped_at) VALUES (p_offer,o.set_id,p->>'reasonCode',actor,at);
  SELECT hon.saas_offer_json(x) INTO snapshot FROM hon.saas_offer_set_offers x WHERE x.id = p_offer;
  RETURN hon.saas_record(actor, p_key, 'saas.offers.stop_sales', 'saas.offers.sales_stopped', 'OFFER', p_offer, NULL, NULL, snapshot,
    jsonb_build_object('offer', snapshot), at);
END $$;

-- ---------- school purchaser discovery (read only) ----------
-- What a school purchaser may see now: published, on-sale, not stopped offers with server-evaluated eligibility.
-- Purchasing stays NOT_CONNECTED; the client never supplies a price, tier or founder flag.
CREATE FUNCTION hon.read_saas_hon_os_offers_for_school(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; at timestamptz := clock_timestamp(); pub hon.saas_offer_sets%ROWTYPE; has_subscription boolean;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  SELECT * INTO pub FROM hon.saas_offer_sets WHERE status = 'PUBLISHED';
  has_subscription := EXISTS (SELECT 1 FROM hon.saas_subscriptions s WHERE s.organization_id = actor.organization_id AND s.status <> 'VOIDED');
  RETURN jsonb_build_object('schoolId',p_school,'product',hon.saas_hon_os_product_json(),'offerSetVersion',pub.set_version,
    'termsReference',pub.terms_reference,
    'offers',(SELECT coalesce(jsonb_agg((hon.saas_offer_json(o) - ARRAY['salesStop','salesOpensAt','position','saleLimit'])
        || jsonb_build_object('eligibility',CASE WHEN o.eligibility = 'NEW_ORGANIZATIONS_ONLY' AND has_subscription THEN 'NOT_ELIGIBLE_EXISTING_SUBSCRIPTION'
          WHEN o.founder THEN 'REQUIRES_HQ_FOUNDER_RESERVATION' ELSE 'ELIGIBLE' END)
      ORDER BY o.position),'[]'::jsonb)
      FROM hon.saas_offer_set_offers o WHERE o.set_id = pub.id AND o.sales_opens_at IS NOT NULL AND o.sales_opens_at <= at
        AND (o.sales_closes_at IS NULL OR o.sales_closes_at > at) AND NOT EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops x WHERE x.offer_id = o.id)),
    'purchase','NOT_CONNECTED','paidAccessProgram',CASE WHEN hon.saas_access_program_active() THEN 'ACTIVE' ELSE 'INACTIVE' END,
    'chargesEnabled',false);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_offer_sets','saas_offer_set_offers','saas_offer_sales_stops'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
        EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I CASCADE',col,t,r);
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_saas_offer_sets()','hon.guard_saas_offer_set_offers()','hon.saas_hon_os_product_json()',
      'hon.saas_offer_json(hon.saas_offer_set_offers)','hon.saas_offer_set_json(uuid)','hon.saas_offer_set_preview(uuid)',
      'hon.saas_offer_set_content_valid(jsonb)','hon.saas_offer_set_write_content(uuid,jsonb)','hon.saas_offer_owner(text)',
      'hon.read_saas_offer_management_from_hq(text)','hon.read_saas_offer_set_from_hq(text,uuid)',
      'hon.create_saas_offer_set_draft(text,jsonb,uuid,uuid,uuid)','hon.revise_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid)',
      'hon.discard_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid)','hon.publish_saas_offer_set(text,uuid,jsonb,uuid,uuid,uuid)',
      'hon.stop_saas_offer_sales(text,uuid,jsonb,uuid,uuid,uuid)','hon.read_saas_hon_os_offers_for_school(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_offer_management_from_hq(text), hon.read_saas_offer_set_from_hq(text,uuid),
      hon.create_saas_offer_set_draft(text,jsonb,uuid,uuid,uuid), hon.revise_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid),
      hon.discard_saas_offer_set_draft(text,uuid,jsonb,uuid,uuid,uuid), hon.publish_saas_offer_set(text,uuid,jsonb,uuid,uuid,uuid),
      hon.stop_saas_offer_sales(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_hon_os_offers_for_school(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
