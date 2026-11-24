BEGIN;

-- HQ plan promotions (0308, allocated by the coordinator 2026-11-12). Owner ask 2026-11-12: "Since we are going to allow
-- change in payment plans, there should be a way for HQ to promote that to school accounts."
--
-- An HQ owner writes a short in-app promotion that links to one offer of the published HON OS offer set (0181), picks the
-- schools that see it and a date window, previews the exact wording and reach, and starts it by echoing the preview
-- digest. School staff holding billing.hon.purchase at a targeted school see it in the app while it is live, the linked
-- offer is on sale and that school is eligible to buy it now (the same server decision the subscription page uses).
-- They can mark it seen, opened or dismissed; HQ reads real counts of those records.
--
-- A promotion never sets a price, creates or changes an offer, starts a checkout, switches a plan, gives credit, sends an
-- email or text, or touches billing, entitlements, payments or creative credits. Nothing exists until an HQ owner creates
-- and starts one.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ plan promotions require a trusted migration owner';
  END IF;
END $$;

CREATE TABLE hon.hq_plan_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,39}$'),
  headline text NOT NULL CHECK (headline = btrim(headline) AND length(headline) BETWEEN 3 AND 80),
  body text NOT NULL CHECK (body = btrim(body) AND length(body) BETWEEN 3 AND 400),
  button_label text NOT NULL CHECK (button_label = btrim(button_label) AND length(button_label) BETWEEN 2 AND 30),
  offer_id uuid NOT NULL REFERENCES hon.saas_offer_set_offers(id) ON DELETE RESTRICT,
  audience text NOT NULL CHECK (audience IN ('ALL_SCHOOLS','MONTHLY_PLAN','ANNUAL_PLAN','TRIAL','NO_PLAN','SELECTED_SCHOOLS')),
  school_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(school_ids) <= 500),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  marketing_campaign_id uuid REFERENCES hon.hq_marketing_campaigns(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ENDED')),
  approved_digest text CHECK (approved_digest IS NULL OR approved_digest ~ '^[0-9a-f]{64}$'),
  first_started_at timestamptz,
  created_by uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 999999999),
  CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '90 days'),
  CHECK ((audience = 'SELECTED_SCHOOLS') = (cardinality(school_ids) > 0)),
  CHECK ((approved_digest IS NULL) = (first_started_at IS NULL)),
  CHECK ((status = 'DRAFT') = (approved_digest IS NULL) OR (status = 'ENDED' AND approved_digest IS NULL)),
  CHECK (updated_at >= created_at)
);
CREATE INDEX hq_plan_promotions_created_idx ON hon.hq_plan_promotions (created_at DESC, id DESC);
CREATE INDEX hq_plan_promotions_live_idx ON hon.hq_plan_promotions (status, starts_at) WHERE status = 'ACTIVE';

CREATE TABLE hon.hq_plan_promotion_versions (
  promotion_id uuid NOT NULL REFERENCES hon.hq_plan_promotions(id),
  version integer NOT NULL CHECK (version > 0),
  kind text NOT NULL CHECK (kind IN ('CREATED','UPDATED','STATUS')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (promotion_id, version),
  CHECK ((kind = 'CREATED') = (version = 1))
);

CREATE TABLE hon.hq_plan_promotion_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('CREATE','UPDATE','STATUS')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  promotion_id uuid NOT NULL REFERENCES hon.hq_plan_promotions(id),
  response jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (actor_principal_id, idempotency_key)
);

-- What one school staff member did with a promotion. Once per person and kind; never changed.
CREATE TABLE hon.school_plan_promotion_events (
  promotion_id uuid NOT NULL REFERENCES hon.hq_plan_promotions(id),
  principal_id uuid NOT NULL REFERENCES hon.principals(id),
  kind text NOT NULL CHECK (kind IN ('SEEN','OPENED','DISMISSED')),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (promotion_id, principal_id, kind),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id)
);
CREATE INDEX school_plan_promotion_events_school_idx ON hon.school_plan_promotion_events (promotion_id, school_id);

-- Content changes only while DRAFT; every change bumps the version by one; the approved digest and first start are set
-- once (on the first start) and never change; ENDED is final. History, requests and school events never change.
CREATE FUNCTION hon.guard_hq_plan_promotion() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND OLD.status <> 'ENDED' AND NEW.updated_at >= OLD.updated_at
    AND (to_jsonb(NEW) - ARRAY['headline','body','button_label','offer_id','audience','school_ids','starts_at','ends_at',
        'marketing_campaign_id','status','approved_digest','first_started_at','updated_at','version'])
      = (to_jsonb(OLD) - ARRAY['headline','body','button_label','offer_id','audience','school_ids','starts_at','ends_at',
        'marketing_campaign_id','status','approved_digest','first_started_at','updated_at','version'])
    AND (OLD.status = 'DRAFT' OR (NEW.headline, NEW.body, NEW.button_label, NEW.offer_id, NEW.audience, NEW.school_ids, NEW.starts_at,
        NEW.ends_at, NEW.marketing_campaign_id) IS NOT DISTINCT FROM (OLD.headline, OLD.body, OLD.button_label, OLD.offer_id, OLD.audience,
        OLD.school_ids, OLD.starts_at, OLD.ends_at, OLD.marketing_campaign_id))
    AND (OLD.approved_digest IS NULL OR (NEW.approved_digest, NEW.first_started_at) IS NOT DISTINCT FROM (OLD.approved_digest, OLD.first_started_at)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'HQ_PLAN_PROMOTION_IMMUTABLE' USING ERRCODE = '42501';
END $$;
CREATE FUNCTION hon.guard_hq_plan_promotion_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN RAISE EXCEPTION 'HQ_PLAN_PROMOTION_IMMUTABLE' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.hq_plan_promotions FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_plan_promotion();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.hq_plan_promotions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_plan_promotion_evidence();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_plan_promotion_versions','hq_plan_promotion_requests','school_plan_promotion_events'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_hq_plan_promotion_evidence()', t);
    EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_hq_plan_promotion_evidence()', t);
  END LOOP;
END $$;

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hq_plan_promotions','hq_plan_promotion_versions','hq_plan_promotion_requests','school_plan_promotion_events'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- ---------- facts ----------
-- The school's current HON OS plan as a promotion audience sees it: TRIAL while a HON OS trial owns the entitlement,
-- otherwise the interval of its live schedule binding or HON OS subscription, otherwise NONE.
CREATE FUNCTION hon.hq_plan_promotion_school_plan(p_org uuid, p_at timestamptz) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE
    WHEN hon.hon_os_trial_live(p_org, p_at) THEN 'TRIAL'
    ELSE coalesce(
      (SELECT b.requirements->>'billingInterval' FROM hon.saas_schedule_bindings b WHERE b.organization_id = p_org
        AND b.status IN ('BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW') ORDER BY b.created_at DESC, b.id LIMIT 1),
      (SELECT CASE WHEN s.offer_kind LIKE '%_MONTHLY' THEN 'MONTHLY' WHEN s.offer_kind LIKE '%_ANNUAL' THEN 'ANNUAL' ELSE 'ONE_TIME' END
        FROM hon.saas_subscriptions s WHERE s.organization_id = p_org AND s.status <> 'VOIDED' AND s.source = 'HON_OS_OFFER'
        ORDER BY s.created_at DESC, s.id LIMIT 1),
      'NONE') END
$$;

-- Whether a school is in the promotion's audience now. A school already on the promoted offer's billing interval, an
-- inactive school or organization, and an organization with an open billing review are never in the audience.
CREATE FUNCTION hon.hq_plan_promotion_targets(p hon.hq_plan_promotions, p_school uuid, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (
    SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
      JOIN hon.saas_offer_set_offers f ON f.id = p.offer_id
      CROSS JOIN LATERAL (SELECT hon.hq_plan_promotion_school_plan(s.organization_id, p_at) plan) x
    WHERE s.id = p_school AND s.status = 'ACTIVE' AND o.status = 'ACTIVE'
      AND x.plan <> f.billing_interval
      AND hon.saas_org_billing_conflict(s.organization_id) IS NULL
      AND CASE p.audience WHEN 'ALL_SCHOOLS' THEN true WHEN 'MONTHLY_PLAN' THEN x.plan = 'MONTHLY' WHEN 'ANNUAL_PLAN' THEN x.plan = 'ANNUAL'
        WHEN 'TRIAL' THEN x.plan = 'TRIAL' WHEN 'NO_PLAN' THEN x.plan = 'NONE' WHEN 'SELECTED_SCHOOLS' THEN s.id = ANY(p.school_ids) ELSE false END)
$$;

-- Live: started, inside its window, and the promoted offer is on sale.
CREATE FUNCTION hon.hq_plan_promotion_live(p hon.hq_plan_promotions, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT p.status = 'ACTIVE' AND p.starts_at <= p_at AND p.ends_at > p_at
    AND hon.saas_hon_os_offer_on_sale((SELECT f FROM hon.saas_offer_set_offers f WHERE f.id = p.offer_id), p_at)
$$;

-- ---------- authority ----------
-- Commands: a current HQ owner only (promoting pricing is commercial policy). Reads: an HQ owner, or an HQ operator holding
-- hq.marketing.manage or hq.marketing.read (0252 rules).
CREATE FUNCTION hon.require_hq_plan_promotion_owner(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
BEGIN RETURN hon.require_saas_hq_actor(p_subject, true); END $$;

CREATE FUNCTION hon.hq_plan_promotion_owner_eligible(p_principal uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT hon.hq_marketing_principal_eligible(p_principal, false) AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g
    WHERE g.principal_id = p_principal AND g.hq_role = 'HON_HQ_OWNER'
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp()))
$$;

-- ---------- projections ----------
CREATE FUNCTION hon.hq_plan_promotion_offer_json(p_offer uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('offerId', f.id, 'offerCode', f.offer_code, 'offerKind', f.offer_kind, 'billingInterval', f.billing_interval,
    'displayName', f.display_name, 'priceMinor', f.price_minor, 'currency', f.currency, 'offerSetVersion', s.set_version,
    'onSale', hon.saas_hon_os_offer_on_sale(f, clock_timestamp()))
  FROM hon.saas_offer_set_offers f JOIN hon.saas_offer_sets s ON s.id = f.set_id WHERE f.id = p_offer
$$;

CREATE FUNCTION hon.hq_plan_promotion_snapshot(p hon.hq_plan_promotions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('headline', p.headline, 'body', p.body, 'buttonLabel', p.button_label, 'offerId', p.offer_id,
    'audience', p.audience, 'schoolIds', to_jsonb(p.school_ids), 'startsAt', hon.saas_ts(p.starts_at), 'endsAt', hon.saas_ts(p.ends_at),
    'marketingCampaignId', p.marketing_campaign_id, 'status', p.status)
$$;

CREATE FUNCTION hon.hq_plan_promotion_json(p hon.hq_plan_promotions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('promotionId', p.id, 'code', p.code, 'headline', p.headline, 'body', p.body, 'buttonLabel', p.button_label,
    'offer', hon.hq_plan_promotion_offer_json(p.offer_id), 'audience', p.audience, 'schoolIds', to_jsonb(p.school_ids),
    'startsAt', hon.saas_ts(p.starts_at), 'endsAt', hon.saas_ts(p.ends_at), 'marketingCampaignId', p.marketing_campaign_id,
    'status', p.status, 'live', hon.hq_plan_promotion_live(p, clock_timestamp()), 'approvedDigest', p.approved_digest,
    'firstStartedAt', hon.saas_ts(p.first_started_at), 'createdBy', hon.hq_marketing_person_json(p.created_by),
    'createdAt', hon.saas_ts(p.created_at), 'updatedAt', hon.saas_ts(p.updated_at), 'version', p.version)
$$;

-- The digest an HQ owner echoes to start a promotion: its id, version and every field a school would see or that picks
-- who sees it.
CREATE FUNCTION hon.hq_plan_promotion_digest(p hon.hq_plan_promotions) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT hon.saas_fingerprint(ARRAY['hq.plan_promotion.preview', p.id::text, p.version::text, hon.hq_plan_promotion_snapshot(p)::text,
    hon.hq_plan_promotion_offer_json(p.offer_id)::text])
$$;

-- Reach now: schools in the audience, and of those the ones the server would let buy the promoted offer now.
CREATE FUNCTION hon.hq_plan_promotion_preview(p hon.hq_plan_promotions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH at AS (SELECT clock_timestamp() t), f AS (SELECT o FROM hon.saas_offer_set_offers o WHERE o.id = p.offer_id),
  aud AS (SELECT s.id, s.organization_id FROM hon.schools s, at WHERE hon.hq_plan_promotion_targets(p, s.id, at.t))
  SELECT jsonb_build_object('digest', hon.hq_plan_promotion_digest(p), 'offerOnSale', hon.saas_hon_os_offer_on_sale((SELECT o FROM f), (SELECT t FROM at)),
    'audienceSchools', (SELECT count(*) FROM aud),
    'eligibleSchools', (SELECT count(*) FROM aud WHERE hon.saas_hon_os_refusal(aud.organization_id, (SELECT o FROM f), (SELECT t FROM at)) IS NULL),
    'asOf', hon.saas_ts((SELECT t FROM at)))
$$;

-- Real counts of school records since the first start: distinct schools that saw, opened, dismissed; and of the schools
-- that saw it, how many started a purchase of the promoted offer afterwards (a checkout or schedule sign-up).
CREATE FUNCTION hon.hq_plan_promotion_reach(p hon.hq_plan_promotions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object(
    'seenSchools', (SELECT count(DISTINCT e.school_id) FROM hon.school_plan_promotion_events e WHERE e.promotion_id = p.id AND e.kind = 'SEEN'),
    'openedSchools', (SELECT count(DISTINCT e.school_id) FROM hon.school_plan_promotion_events e WHERE e.promotion_id = p.id AND e.kind = 'OPENED'),
    'dismissedSchools', (SELECT count(DISTINCT e.school_id) FROM hon.school_plan_promotion_events e WHERE e.promotion_id = p.id AND e.kind = 'DISMISSED'),
    'purchaseStartedSchools', CASE WHEN p.first_started_at IS NULL THEN 0 ELSE (SELECT count(DISTINCT e.school_id)
      FROM hon.school_plan_promotion_events e WHERE e.promotion_id = p.id AND e.kind = 'SEEN'
        AND (EXISTS (SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.organization_id = e.organization_id
              AND c.hon_os_offer_id = p.offer_id AND c.created_at >= e.recorded_at)
          OR EXISTS (SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.organization_id = e.organization_id
              AND b.requirements->>'offerId' = p.offer_id::text AND b.created_at >= e.recorded_at))) END,
    'countsAre', 'RECORDED_EVENTS_NOT_ESTIMATES')
$$;

-- ---------- input helpers ----------
CREATE FUNCTION hon.hq_plan_promotion_claim(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prior hon.hq_plan_promotion_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('hq-plan-promotion:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO prior FROM hon.hq_plan_promotion_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF prior.operation <> p_operation OR prior.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505'; END IF;
  RETURN prior.response || jsonb_build_object('replayed', true);
END $$;

CREATE FUNCTION hon.hq_plan_promotion_time(p_input jsonb, p_key text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE t timestamptz;
BEGIN
  IF jsonb_typeof(p_input->p_key) IS DISTINCT FROM 'string'
    OR (p_input->>p_key) !~ '^20[2-9][0-9]-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?Z$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  BEGIN t := (p_input->>p_key)::timestamptz;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END;
  RETURN t;
END $$;

-- The content fields shared by CREATE and UPDATE, checked and returned row-shaped (id, code, status and audit columns unset).
CREATE FUNCTION hon.hq_plan_promotion_content(p_input jsonb) RETURNS hon.hq_plan_promotions
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE p hon.hq_plan_promotions%ROWTYPE; ids uuid[];
BEGIN
  IF jsonb_typeof(p_input->'audience') IS DISTINCT FROM 'string'
    OR (p_input->>'audience') NOT IN ('ALL_SCHOOLS','MONTHLY_PLAN','ANNUAL_PLAN','TRIAL','NO_PLAN','SELECTED_SCHOOLS')
    OR jsonb_typeof(p_input->'schoolIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'schoolIds') > 500
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_input->'schoolIds') x
      WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR jsonb_typeof(p_input->'offerId') IS DISTINCT FROM 'string'
    OR (p_input->>'offerId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (jsonb_typeof(p_input->'marketingCampaignId') IS DISTINCT FROM 'null'
      AND ((p_input->>'marketingCampaignId') IS NULL OR (p_input->>'marketingCampaignId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(DISTINCT (x #>> '{}')::uuid ORDER BY (x #>> '{}')::uuid), '{}') INTO ids FROM jsonb_array_elements(p_input->'schoolIds') x;
  IF cardinality(ids) <> jsonb_array_length(p_input->'schoolIds')
    OR ((p_input->>'audience') = 'SELECTED_SCHOOLS') <> (cardinality(ids) > 0)
    OR EXISTS (SELECT 1 FROM unnest(ids) i WHERE NOT EXISTS (SELECT 1 FROM hon.schools s WHERE s.id = i)) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  p.headline := hon.hq_marketing_text(p_input, 'headline', 3, 80);
  p.body := hon.hq_marketing_text(p_input, 'body', 3, 400);
  p.button_label := hon.hq_marketing_text(p_input, 'buttonLabel', 2, 30);
  p.audience := p_input->>'audience'; p.school_ids := ids;
  p.offer_id := (p_input->>'offerId')::uuid;
  p.marketing_campaign_id := (p_input->>'marketingCampaignId')::uuid;
  p.starts_at := hon.hq_plan_promotion_time(p_input, 'startsAt'); p.ends_at := hon.hq_plan_promotion_time(p_input, 'endsAt');
  IF p.ends_at <= p.starts_at OR p.ends_at - p.starts_at > interval '90 days' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  -- Only an offer of the published HON OS set can be promoted, and only one that is on sale or opens later.
  IF NOT EXISTS (SELECT 1 FROM hon.saas_offer_set_offers f JOIN hon.saas_offer_sets s ON s.id = f.set_id
      WHERE f.id = p.offer_id AND s.status = 'PUBLISHED' AND f.sales_opens_at IS NOT NULL
        AND (f.sales_closes_at IS NULL OR f.sales_closes_at > clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops x WHERE x.offer_id = f.id)) THEN
    RAISE EXCEPTION 'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE' USING ERRCODE = '23514';
  END IF;
  IF p.marketing_campaign_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hon.hq_marketing_campaigns c
      WHERE c.id = p.marketing_campaign_id AND c.status <> 'ARCHIVED') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  RETURN p;
END $$;

CREATE FUNCTION hon.hq_plan_promotion_lock(p_promotion uuid, p_expected integer) RETURNS hon.hq_plan_promotions
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE p hon.hq_plan_promotions%ROWTYPE;
BEGIN
  SELECT * INTO p FROM hon.hq_plan_promotions WHERE id = p_promotion FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF p.version <> p_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF p.status = 'ENDED' THEN RAISE EXCEPTION 'HQ_PLAN_PROMOTION_ENDED' USING ERRCODE = '23514'; END IF;
  RETURN p;
END $$;

-- ---------- HQ commands ----------
-- CREATE: {code, headline, body, buttonLabel, offerId, audience, schoolIds, startsAt, endsAt, marketingCampaignId}; DRAFT.
CREATE FUNCTION hon.create_hq_plan_promotion(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; c hon.hq_plan_promotions%ROWTYPE; p hon.hq_plan_promotions%ROWTYPE; fp text;
  at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  actor := hon.require_hq_plan_promotion_owner(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)
      <> ARRAY['audience','body','buttonLabel','code','endsAt','headline','marketingCampaignId','offerId','schoolIds','startsAt']
    OR jsonb_typeof(p_input->'code') IS DISTINCT FROM 'string' OR (p_input->>'code') !~ '^[A-Z0-9][A-Z0-9-]{1,39}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  fp := hon.saas_fingerprint(ARRAY['hq.plan_promotion.create', p_input::text]);
  replay := hon.hq_plan_promotion_claim(actor, p_key, 'CREATE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_plan_promotion_owner(p_subject); RETURN replay; END IF;
  c := hon.hq_plan_promotion_content(p_input);
  IF EXISTS (SELECT 1 FROM hon.hq_plan_promotions WHERE code = p_input->>'code') THEN
    RAISE EXCEPTION 'HQ_PLAN_PROMOTION_CODE_TAKEN' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.hq_plan_promotions (code, headline, body, button_label, offer_id, audience, school_ids, starts_at, ends_at,
    marketing_campaign_id, status, created_by, created_at, updated_at)
  VALUES (p_input->>'code', c.headline, c.body, c.button_label, c.offer_id, c.audience, c.school_ids, c.starts_at, c.ends_at,
    c.marketing_campaign_id, 'DRAFT', actor, at, at) RETURNING * INTO p;
  INSERT INTO hon.hq_plan_promotion_versions VALUES (p.id, 1, 'CREATED', actor, hon.hq_plan_promotion_snapshot(p), at);
  result := jsonb_build_object('operation', 'CREATE', 'promotion', hon.hq_plan_promotion_json(p));
  INSERT INTO hon.hq_plan_promotion_requests VALUES (actor, p_key, 'CREATE', fp, p.id, result, at);
  PERFORM hon.require_hq_plan_promotion_owner(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- UPDATE (DRAFT only): {expectedVersion, headline, body, buttonLabel, offerId, audience, schoolIds, startsAt, endsAt,
-- marketingCampaignId}. The code never changes. A live promotion is changed by ending it and creating another.
CREATE FUNCTION hon.update_hq_plan_promotion(p_subject text, p_promotion uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; c hon.hq_plan_promotions%ROWTYPE; p hon.hq_plan_promotions%ROWTYPE; v_expected integer;
  fp text; at timestamptz; result jsonb;
BEGIN
  actor := hon.require_hq_plan_promotion_owner(p_subject);
  IF p_promotion IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)
      <> ARRAY['audience','body','buttonLabel','endsAt','expectedVersion','headline','marketingCampaignId','offerId','schoolIds','startsAt'] THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := hon.hq_marketing_expected(p_input);
  fp := hon.saas_fingerprint(ARRAY['hq.plan_promotion.update', p_promotion::text, p_input::text]);
  replay := hon.hq_plan_promotion_claim(actor, p_key, 'UPDATE', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_plan_promotion_owner(p_subject); RETURN replay; END IF;
  c := hon.hq_plan_promotion_content(p_input);
  p := hon.hq_plan_promotion_lock(p_promotion, v_expected);
  IF p.status <> 'DRAFT' THEN RAISE EXCEPTION 'HQ_PLAN_PROMOTION_NOT_DRAFT' USING ERRCODE = '23514'; END IF;
  IF (p.headline, p.body, p.button_label, p.offer_id, p.audience, p.school_ids, p.starts_at, p.ends_at, p.marketing_campaign_id)
    IS NOT DISTINCT FROM (c.headline, c.body, c.button_label, c.offer_id, c.audience, c.school_ids, c.starts_at, c.ends_at, c.marketing_campaign_id) THEN
    RAISE EXCEPTION 'HQ_PLAN_PROMOTION_NO_CHANGE' USING ERRCODE = '23514';
  END IF;
  at := greatest(clock_timestamp(), p.updated_at);
  UPDATE hon.hq_plan_promotions SET headline = c.headline, body = c.body, button_label = c.button_label, offer_id = c.offer_id,
    audience = c.audience, school_ids = c.school_ids, starts_at = c.starts_at, ends_at = c.ends_at,
    marketing_campaign_id = c.marketing_campaign_id, updated_at = at, version = version + 1
  WHERE id = p.id RETURNING * INTO p;
  INSERT INTO hon.hq_plan_promotion_versions VALUES (p.id, p.version, 'UPDATED', actor, hon.hq_plan_promotion_snapshot(p), at);
  result := jsonb_build_object('operation', 'UPDATE', 'promotion', hon.hq_plan_promotion_json(p));
  INSERT INTO hon.hq_plan_promotion_requests VALUES (actor, p_key, 'UPDATE', fp, p.id, result, at);
  PERFORM hon.require_hq_plan_promotion_owner(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- STATUS: {expectedVersion, status, previewDigest}. DRAFT -> ACTIVE (previewDigest must equal the current preview digest,
-- the window must not have ended and the offer must be on sale or open later) | ENDED; ACTIVE -> PAUSED | ENDED;
-- PAUSED -> ACTIVE (same window and offer checks) | ENDED. ENDED is final. previewDigest is null except for DRAFT -> ACTIVE.
CREATE FUNCTION hon.set_hq_plan_promotion_status(p_subject text, p_promotion uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; p hon.hq_plan_promotions%ROWTYPE; v_expected integer; v_status text; v_digest text;
  fp text; at timestamptz; result jsonb;
BEGIN
  actor := hon.require_hq_plan_promotion_owner(p_subject);
  IF p_promotion IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> ARRAY['expectedVersion','previewDigest','status']
    OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR (p_input->>'status') NOT IN ('ACTIVE','PAUSED','ENDED')
    OR NOT (jsonb_typeof(p_input->'previewDigest') = 'null'
      OR (jsonb_typeof(p_input->'previewDigest') = 'string' AND (p_input->>'previewDigest') ~ '^[0-9a-f]{64}$')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_expected := hon.hq_marketing_expected(p_input); v_status := p_input->>'status'; v_digest := p_input->>'previewDigest';
  fp := hon.saas_fingerprint(ARRAY['hq.plan_promotion.status', p_promotion::text, p_input::text]);
  replay := hon.hq_plan_promotion_claim(actor, p_key, 'STATUS', fp);
  IF replay IS NOT NULL THEN PERFORM hon.require_hq_plan_promotion_owner(p_subject); RETURN replay; END IF;
  p := hon.hq_plan_promotion_lock(p_promotion, v_expected);
  IF NOT ((p.status = 'DRAFT' AND v_status IN ('ACTIVE','ENDED')) OR (p.status = 'ACTIVE' AND v_status IN ('PAUSED','ENDED'))
    OR (p.status = 'PAUSED' AND v_status IN ('ACTIVE','ENDED'))) THEN
    RAISE EXCEPTION 'HQ_PLAN_PROMOTION_STATUS_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
  IF (p.status = 'DRAFT' AND v_status = 'ACTIVE') <> (v_digest IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  at := greatest(clock_timestamp(), p.updated_at);
  IF v_status = 'ACTIVE' THEN
    IF p.status = 'DRAFT' AND v_digest <> hon.hq_plan_promotion_digest(p) THEN
      RAISE EXCEPTION 'HQ_PLAN_PROMOTION_PREVIEW_STALE' USING ERRCODE = '40001';
    END IF;
    IF p.ends_at <= at THEN RAISE EXCEPTION 'HQ_PLAN_PROMOTION_WINDOW_ENDED' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM hon.saas_offer_set_offers f JOIN hon.saas_offer_sets s ON s.id = f.set_id
        WHERE f.id = p.offer_id AND s.status = 'PUBLISHED' AND f.sales_opens_at IS NOT NULL
          AND (f.sales_closes_at IS NULL OR f.sales_closes_at > at)
          AND NOT EXISTS (SELECT 1 FROM hon.saas_offer_sales_stops x WHERE x.offer_id = f.id)) THEN
      RAISE EXCEPTION 'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE' USING ERRCODE = '23514';
    END IF;
  END IF;
  UPDATE hon.hq_plan_promotions SET status = v_status, updated_at = at, version = version + 1,
    approved_digest = CASE WHEN p.status = 'DRAFT' AND v_status = 'ACTIVE' THEN v_digest ELSE approved_digest END,
    first_started_at = CASE WHEN p.status = 'DRAFT' AND v_status = 'ACTIVE' THEN at ELSE first_started_at END
  WHERE id = p.id RETURNING * INTO p;
  INSERT INTO hon.hq_plan_promotion_versions VALUES (p.id, p.version, 'STATUS', actor, hon.hq_plan_promotion_snapshot(p), at);
  result := jsonb_build_object('operation', 'STATUS', 'promotion', hon.hq_plan_promotion_json(p));
  INSERT INTO hon.hq_plan_promotion_requests VALUES (actor, p_key, 'STATUS', fp, p.id, result, at);
  PERFORM hon.require_hq_plan_promotion_owner(p_subject);
  RETURN result || jsonb_build_object('replayed', false);
END $$;

-- ---------- HQ reads ----------
-- List (newest first, keyset by created_at, id) with reach counts. p_status NULL (all), 'OPEN' (not ended) or one status.
CREATE FUNCTION hon.read_hq_plan_promotions(p_subject text, p_status text, p_cursor_at timestamptz, p_cursor_id uuid, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; v_rows jsonb; v_last hon.hq_plan_promotions%ROWTYPE; n integer; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR (p_cursor_at IS NULL) <> (p_cursor_id IS NULL)
    OR (p_status IS NOT NULL AND p_status NOT IN ('OPEN','DRAFT','ACTIVE','PAUSED','ENDED')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  WITH page AS (
    SELECT p AS r, p.created_at, p.id FROM hon.hq_plan_promotions p
    WHERE (p_status IS NULL OR (p_status = 'OPEN' AND p.status <> 'ENDED') OR p.status = p_status)
      AND (p_cursor_at IS NULL OR (p.created_at, p.id) < (p_cursor_at, p_cursor_id))
    ORDER BY p.created_at DESC, p.id DESC LIMIT p_limit)
  SELECT coalesce(jsonb_agg(hon.hq_plan_promotion_json(page.r) || jsonb_build_object('reach', hon.hq_plan_promotion_reach(page.r))
    ORDER BY page.created_at DESC, page.id DESC), '[]'::jsonb), count(*) INTO v_rows, n FROM page;
  IF n = p_limit THEN SELECT * INTO v_last FROM hon.hq_plan_promotions WHERE id = (v_rows->(n - 1)->>'promotionId')::uuid; END IF;
  result := jsonb_build_object('promotions', v_rows, 'limit', p_limit,
    'nextCursor', CASE WHEN n = p_limit THEN jsonb_build_object('createdAt', hon.saas_ts(v_last.created_at), 'promotionId', v_last.id) END,
    'offers', (SELECT coalesce(jsonb_agg(hon.hq_plan_promotion_offer_json(f.id) ORDER BY f.position), '[]'::jsonb)
      FROM hon.saas_offer_set_offers f JOIN hon.saas_offer_sets s ON s.id = f.set_id WHERE s.status = 'PUBLISHED'),
    'viewer', hon.hq_marketing_person_json(actor) || jsonb_build_object('canManage', hon.hq_plan_promotion_owner_eligible(actor)),
    'messaging', 'IN_APP_ONLY', 'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_marketing_actor(p_subject, false);
  RETURN result;
END $$;

-- One promotion with its history, the current preview (digest and reach now) and the recorded reach.
CREATE FUNCTION hon.read_hq_plan_promotion(p_subject text, p_promotion uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; p hon.hq_plan_promotions%ROWTYPE; result jsonb;
BEGIN
  actor := hon.require_hq_marketing_actor(p_subject, false);
  IF p_promotion IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT * INTO p FROM hon.hq_plan_promotions WHERE id = p_promotion;
  IF p.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  result := jsonb_build_object('promotion', hon.hq_plan_promotion_json(p), 'preview', hon.hq_plan_promotion_preview(p),
    'reach', hon.hq_plan_promotion_reach(p),
    'versions', (SELECT coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'kind', v.kind,
        'actor', hon.hq_marketing_person_json(v.actor_principal_id), 'snapshot', v.snapshot, 'recordedAt', hon.saas_ts(v.recorded_at))
      ORDER BY v.version), '[]'::jsonb) FROM hon.hq_plan_promotion_versions v WHERE v.promotion_id = p.id),
    'viewer', hon.hq_marketing_person_json(actor) || jsonb_build_object('canManage', hon.hq_plan_promotion_owner_eligible(actor)),
    'asOf', hon.saas_ts(clock_timestamp()));
  PERFORM hon.require_hq_marketing_actor(p_subject, false);
  RETURN result;
END $$;

-- ---------- school ----------
-- The promotions shown to this staff member at this school now: live, the school is in the audience, and the server's
-- purchase decision for this organization (the subscription page's offer read) lists the promoted offer as ELIGIBLE.
CREATE FUNCTION hon.school_plan_promotions_shown(p_subject text, p_school uuid, p_at timestamptz)
RETURNS SETOF hon.hq_plan_promotions LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE offers jsonb;
BEGIN
  offers := hon.read_saas_hon_os_offers_for_school(p_subject, p_school);
  RETURN QUERY SELECT p.* FROM hon.hq_plan_promotions p
    WHERE hon.hq_plan_promotion_live(p, p_at) AND hon.hq_plan_promotion_targets(p, p_school, p_at)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(offers->'offers', '[]'::jsonb)) o
        WHERE o->>'offerId' = p.offer_id::text AND o->>'eligibility' = 'ELIGIBLE')
    ORDER BY p.starts_at DESC, p.id DESC LIMIT 20;
END $$;

CREATE FUNCTION hon.read_school_plan_promotions(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; at timestamptz := clock_timestamp(); rows jsonb;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  IF actor.principal_id IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('promotionId', p.id, 'headline', p.headline, 'body', p.body, 'buttonLabel', p.button_label,
      'offer', hon.hq_plan_promotion_offer_json(p.offer_id) - ARRAY['onSale','offerSetVersion'], 'endsAt', hon.saas_ts(p.ends_at),
      'dismissed', EXISTS (SELECT 1 FROM hon.school_plan_promotion_events e WHERE e.promotion_id = p.id
        AND e.principal_id = actor.principal_id AND e.kind = 'DISMISSED'))
    ORDER BY p.starts_at DESC, p.id DESC), '[]'::jsonb)
  INTO rows FROM hon.school_plan_promotions_shown(p_subject, p_school, at) p;
  RETURN jsonb_build_object('schoolId', p_school, 'promotions', rows, 'asOf', hon.saas_ts(at));
END $$;

-- {kind: SEEN | OPENED | DISMISSED} for a promotion shown to this person now. Once per person and kind: a repeat records
-- nothing and reports recorded false. A promotion not shown now is refused as unavailable.
CREATE FUNCTION hon.record_school_plan_promotion_event(p_subject text, p_school uuid, p_promotion uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; at timestamptz := clock_timestamp(); v_kind text; n integer;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  IF actor.principal_id IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  IF p_promotion IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) <> ARRAY['kind']
    OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string' OR (p_input->>'kind') NOT IN ('SEEN','OPENED','DISMISSED') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_kind := p_input->>'kind';
  IF NOT EXISTS (SELECT 1 FROM hon.school_plan_promotions_shown(p_subject, p_school, at) p WHERE p.id = p_promotion) THEN
    RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO hon.school_plan_promotion_events (promotion_id, principal_id, kind, organization_id, school_id, recorded_at)
  VALUES (p_promotion, actor.principal_id, v_kind, actor.organization_id, actor.school_id, at) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('promotionId', p_promotion, 'kind', v_kind, 'recorded', n = 1);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['guard_hq_plan_promotion()','guard_hq_plan_promotion_evidence()',
    'hq_plan_promotion_school_plan(uuid,timestamptz)','hq_plan_promotion_targets(hon.hq_plan_promotions,uuid,timestamptz)',
    'hq_plan_promotion_live(hon.hq_plan_promotions,timestamptz)','require_hq_plan_promotion_owner(text)','hq_plan_promotion_owner_eligible(uuid)',
    'hq_plan_promotion_offer_json(uuid)','hq_plan_promotion_snapshot(hon.hq_plan_promotions)','hq_plan_promotion_json(hon.hq_plan_promotions)',
    'hq_plan_promotion_digest(hon.hq_plan_promotions)','hq_plan_promotion_preview(hon.hq_plan_promotions)','hq_plan_promotion_reach(hon.hq_plan_promotions)',
    'hq_plan_promotion_claim(uuid,uuid,text,text)','hq_plan_promotion_time(jsonb,text)','hq_plan_promotion_content(jsonb)',
    'hq_plan_promotion_lock(uuid,integer)','create_hq_plan_promotion(text,jsonb,uuid)','update_hq_plan_promotion(text,uuid,jsonb,uuid)',
    'set_hq_plan_promotion_status(text,uuid,jsonb,uuid)','read_hq_plan_promotions(text,text,timestamptz,uuid,integer)',
    'read_hq_plan_promotion(text,uuid)','school_plan_promotions_shown(text,uuid,timestamptz)','read_school_plan_promotions(text,uuid)',
    'record_school_plan_promotion_event(text,uuid,uuid,jsonb)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.create_hq_plan_promotion(text,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.update_hq_plan_promotion(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.set_hq_plan_promotion_status(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_plan_promotions(text,text,timestamptz,uuid,integer) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_hq_plan_promotion(text,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_school_plan_promotions(text,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.record_school_plan_promotion_event(text,uuid,uuid,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
