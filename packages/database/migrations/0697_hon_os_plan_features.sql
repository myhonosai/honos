BEGIN;

-- HQ Plan builder piece 2: plans with their own features (David chose "Let me pick features per plan", 2026-11-26).
-- - Every HON OS offer now carries the capability list of the plan it sells: a non-empty subset of the HON OS (COMPLETE)
--   capability policy, stored in canonical policy order. A plan is the offers of one set that share a display name, so
--   offers with the same name must carry the same list (checked on every draft write).
-- - Existing offers, including published and retired ones, get the full list through the column default. No row is
--   updated (ADD COLUMN fires no row trigger), so the 0181 immutability guard is untouched and every published price
--   and feature list is exactly what schools had before.
-- - The list is in the offer JSON, so the server preview digest covers it: publishing approves the exact feature lists.
-- - Nothing here enforces features at school access, sells, charges, grants credits or changes an entitlement.
--   Enforcement (piece 3) and per-plan checkout are separate reviewed changes. Purchase code is unchanged: its price
--   acceptance (0188/0279/0306) still needs exactly one regular monthly price per set, so with payments live a set with
--   two plans would refuse recurring price acceptance (SAAS_PRICE_TERMS_UNSUPPORTED) until per-plan checkout lands.
--   Paid access is INACTIVE today; HQ can still assign any published offer to a school (0676).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS plan features require a trusted migration owner';
  END IF;
END $$;

DO $$ BEGIN
  EXECUTE format('ALTER TABLE hon.saas_offer_set_offers ADD COLUMN capabilities text[] NOT NULL DEFAULT %L::text[]',
    hon.saas_plan_capabilities('COMPLETE'));
END $$;
ALTER TABLE hon.saas_offer_set_offers ADD CONSTRAINT saas_offer_set_offers_capabilities_check
  CHECK (cardinality(capabilities) BETWEEN 1 AND cardinality(hon.saas_plan_capabilities('COMPLETE'))
    AND capabilities <@ hon.saas_plan_capabilities('COMPLETE') AND array_position(capabilities, NULL) IS NULL);

CREATE OR REPLACE FUNCTION hon.saas_offer_json(o hon.saas_offer_set_offers) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('offerId',o.id,'offerCode',o.offer_code,'position',o.position,'offerKind',o.offer_kind,
    'billingInterval',o.billing_interval,'founder',o.founder,'displayName',o.display_name,'priceMinor',o.price_minor,'currency',o.currency,
    'salesOpensAt',hon.saas_ts(o.sales_opens_at),'salesClosesAt',hon.saas_ts(o.sales_closes_at),'eligibility',o.eligibility,
    'saleLimit',o.sale_limit,'priceLock',o.price_lock,'priceLockMonths',o.price_lock_months,'annualRenewal',o.annual_renewal,
    'plannedMonthlyPremiumCredits',o.planned_monthly_premium_credits,'premiumCreditsStatus','PLANNING_ONLY_NOT_A_CREDIT_GRANT',
    'aiFairUseReference',o.ai_fair_use_reference,'refundWindowDays',o.refund_window_days,'cancellationTiming',o.cancellation_timing,
    'capabilities',to_jsonb(o.capabilities),
    'salesStop',(SELECT jsonb_build_object('reasonCode',x.reason_code,'stoppedAt',hon.saas_ts(x.stopped_at))
      FROM hon.saas_offer_sales_stops x WHERE x.offer_id = o.id))
$$;

-- The capability list of one validated offer input, in canonical HON OS policy order (absent = the full list).
CREATE FUNCTION hon.saas_offer_input_capabilities(o jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN o ? 'capabilities' THEN ARRAY(SELECT c FROM unnest(hon.saas_plan_capabilities('COMPLETE')) WITH ORDINALITY u(c, i)
      WHERE o->'capabilities' ? c ORDER BY i)
    ELSE hon.saas_plan_capabilities('COMPLETE') END
$$;

-- Same strict check as 0181, plus the optional per-offer 'capabilities' (absent = the full HON OS list): an array of
-- 1..16 distinct known capability strings, identical for offers that share a display name.
CREATE OR REPLACE FUNCTION hon.saas_offer_set_content_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE item jsonb; ts constant text := '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'; kind text; interval_kind text;
  nullable_int constant text[] := ARRAY['saleLimit','priceLockMonths','plannedMonthlyPremiumCredits','refundWindowDays'];
  nullable_text constant text[] := ARRAY['salesOpensAt','salesClosesAt','annualRenewal','aiFairUseReference','cancellationTiming'];
  offer_keys constant text[] := ARRAY['aiFairUseReference','annualRenewal','cancellationTiming','displayName','eligibility','offerCode','offerKind',
    'plannedMonthlyPremiumCredits','priceLock','priceLockMonths','priceMinor','refundWindowDays','saleLimit','salesClosesAt','salesOpensAt'];
  all_caps constant text[] := hon.saas_plan_capabilities('COMPLETE');
BEGIN
  IF jsonb_typeof(p->'termsReference') NOT IN ('string','null')
    OR (jsonb_typeof(p->'termsReference') = 'string' AND (length(p->>'termsReference') NOT BETWEEN 1 AND 500 OR btrim(p->>'termsReference') <> p->>'termsReference'))
    OR jsonb_typeof(p->'founderTotalLimit') NOT IN ('number','null')
    OR (jsonb_typeof(p->'founderTotalLimit') = 'number' AND ((p->>'founderTotalLimit') !~ '^[0-9]{1,4}$' OR (p->>'founderTotalLimit')::integer > 1000))
    OR jsonb_typeof(p->'offers') <> 'array' OR jsonb_array_length(p->'offers') NOT BETWEEN 1 AND 12 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'offers') LOOP
    IF jsonb_typeof(item) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item - 'capabilities') k) IS DISTINCT FROM offer_keys THEN
      RETURN false;
    END IF;
    IF item ? 'capabilities' AND (jsonb_typeof(item->'capabilities') <> 'array'
        OR jsonb_array_length(item->'capabilities') NOT BETWEEN 1 AND cardinality(all_caps)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(item->'capabilities') c WHERE jsonb_typeof(c) <> 'string' OR NOT (c #>> '{}') = ANY (all_caps))
        OR (SELECT count(DISTINCT c) FROM jsonb_array_elements_text(item->'capabilities') c) <> jsonb_array_length(item->'capabilities')) THEN
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
  -- One plan, one feature list: offers that share a display name must list the same capabilities.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->'offers') x
      GROUP BY x.value->>'displayName' HAVING count(DISTINCT hon.saas_offer_input_capabilities(x.value)) > 1) THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;


CREATE OR REPLACE FUNCTION hon.saas_offer_set_write_content(p_set uuid, p jsonb) RETURNS void
LANGUAGE sql VOLATILE SET search_path = pg_catalog, hon AS $$
  INSERT INTO hon.saas_offer_set_offers(set_id,position,offer_code,offer_kind,billing_interval,founder,display_name,price_minor,
      sales_opens_at,sales_closes_at,eligibility,sale_limit,price_lock,price_lock_months,annual_renewal,planned_monthly_premium_credits,
      ai_fair_use_reference,refund_window_days,cancellation_timing,capabilities)
  SELECT p_set, x.ord::integer, x.o->>'offerCode', x.o->>'offerKind',
    CASE WHEN x.o->>'offerKind' LIKE '%_MONTHLY' THEN 'MONTHLY' WHEN x.o->>'offerKind' LIKE '%_ANNUAL' THEN 'ANNUAL' ELSE 'ONE_TIME' END,
    x.o->>'offerKind' LIKE 'FOUNDER_%', x.o->>'displayName', (x.o->>'priceMinor')::integer,
    (x.o->>'salesOpensAt')::timestamptz, (x.o->>'salesClosesAt')::timestamptz, x.o->>'eligibility', (x.o->>'saleLimit')::integer,
    x.o->>'priceLock', (x.o->>'priceLockMonths')::integer, x.o->>'annualRenewal', (x.o->>'plannedMonthlyPremiumCredits')::integer,
    x.o->>'aiFairUseReference', (x.o->>'refundWindowDays')::integer, x.o->>'cancellationTiming', hon.saas_offer_input_capabilities(x.o)
  FROM jsonb_array_elements(p->'offers') WITH ORDINALITY AS x(o, ord)
$$;

-- Helper is internal like the other 0181 content helpers: no role may call it directly.
DO $$ DECLARE r text;
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION hon.saas_offer_input_capabilities(jsonb) FROM PUBLIC';
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role',
      'hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.saas_offer_input_capabilities(jsonb) FROM %I', r);
  END LOOP;
END $$;

COMMIT;
