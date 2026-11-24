BEGIN;

-- HON OS schedule billing, piece 4 of 5 (owner checklist 2026-11-09, owner decisions with Claude 2026-11-09): the founder
-- 50-spot count for new schedule-plan founder sales.
--   * Founder price is locked for as long as the school stays subscribed ($199.20/month or $1,494/year). After a
--     cancellation, or a lapse past the 7-day grace period, a new subscription is at the standard price. Recorded as NEW
--     founder terms (schemaVersion 2); 0188 history and every version 1 schedule are never rewritten.
--   * The 50-spot cap counts ONLY founder sales made through the schedule plan. v1 checkouts and legacy founder
--     reservations stay outside it (they are neither counted nor changed).
--   * A spot is counted at the FIRST VERIFIED PAYMENT, never at sign-up (OD-4: an unpaid sign-up holds no spot). Sign-up,
--     acceptance, generation and binding are refused once the count is full, but they never reserve a spot.
--   * A payment that arrives after the last spot was taken is never auto-refunded (owner answer 3): it is held for HQ
--     review with reason FOUNDER_SPOT_UNAVAILABLE. After HQ verifies a full refund the sign-up carries on as before
--     (waiting for its first payment); the school may then cancel it and sign up at the standard price.
--   * A 30-day refund never returns a spot, and an organization uses at most one founder spot, ever.
-- No checkout, provider, live payment, entitlement grant or credit is enabled by this migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS founder allocation requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS founder allocation requires a restricted runtime';
  END IF;
END $$;

-- ---------- the one pool and its immutable spots ----------
CREATE TABLE hon.saas_founder_pool (
  pool_id smallint PRIMARY KEY CHECK (pool_id=1),
  capacity integer NOT NULL CHECK (capacity=50),
  counting_rule text NOT NULL CHECK (counting_rule='FIRST_VERIFIED_SCHEDULE_PAYMENT'),
  created_at timestamptz NOT NULL
);
INSERT INTO hon.saas_founder_pool(pool_id,capacity,counting_rule,created_at) VALUES(1,50,'FIRST_VERIFIED_SCHEDULE_PAYMENT',clock_timestamp());

CREATE TABLE hon.saas_founder_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id smallint NOT NULL DEFAULT 1 REFERENCES hon.saas_founder_pool(pool_id) ON DELETE RESTRICT,
  spot_number integer NOT NULL UNIQUE CHECK (spot_number BETWEEN 1 AND 50),
  organization_id uuid NOT NULL UNIQUE REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL REFERENCES hon.schools(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL UNIQUE REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  paid_period_id uuid NOT NULL UNIQUE REFERENCES hon.saas_schedule_paid_periods(id) ON DELETE RESTRICT,
  provider_event_id text NOT NULL UNIQUE CHECK (provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  offer_id uuid NOT NULL REFERENCES hon.saas_offer_set_offers(id) ON DELETE RESTRICT,
  offer_set_id uuid NOT NULL REFERENCES hon.saas_offer_sets(id) ON DELETE RESTRICT,
  offer_kind text NOT NULL CHECK (offer_kind IN ('FOUNDER_MONTHLY','FOUNDER_ANNUAL')),
  locked_price_minor integer NOT NULL CHECK (locked_price_minor BETWEEN 100 AND 10000000),
  allocated_at timestamptz NOT NULL
);

-- ---------- review reason for a payment that found no spot ----------
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_schedule_bindings'::regclass AND conname='saas_schedule_bindings_status_reason_check';
  IF def IS NULL OR position('REVIEW_REFUND_VERIFIED' IN def)=0 THEN RAISE EXCEPTION 'saas_schedule_bindings status_reason constraint drifted'; END IF;
  ALTER TABLE hon.saas_schedule_bindings DROP CONSTRAINT saas_schedule_bindings_status_reason_check;
  ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_status_reason_check CHECK (status_reason IN ('BINDING_REQUESTED',
    'BINDING_OBSERVED_TEST_ONLY','FIRST_PAYMENT_VERIFIED','PROVIDER_CONFIRMED_NOT_CREATED','PROVIDER_TERMS_MISMATCH','UNPAID_WINDOW_ELAPSED',
    'AMOUNT_MISMATCH','OVERLAPPING_COVERED_PERIOD','REVERSAL_REVIEW_REQUIRED','UNLINKED_REVERSAL','PURCHASER_CANCELLED_BEFORE_PAYMENT',
    'PERIOD_INTERVAL_MISMATCH','REVIEW_REFUND_VERIFIED','FOUNDER_SPOT_UNAVAILABLE'));
END $$;

-- ---------- availability (read-only; never a reservation) ----------
-- NULL means a founder spot could be counted for this organization and offer right now. It is NOT a promise: the spot is
-- counted only by the first verified payment, under the pool lock.
CREATE FUNCTION hon.saas_founder_unavailable_reason(p_org uuid,p_offer uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE
    WHEN o.id IS NULL OR NOT o.founder THEN 'FOUNDER_TERMS_NOT_LOCKED'
    WHEN EXISTS (SELECT 1 FROM hon.saas_founder_allocations a WHERE a.organization_id=p_org) THEN 'FOUNDER_ALREADY_USED'
    WHEN (SELECT count(*) FROM hon.saas_founder_allocations)>=(SELECT capacity FROM hon.saas_founder_pool WHERE pool_id=1) THEN 'FOUNDER_SOLD_OUT'
    WHEN s.founder_total_limit IS NULL OR (SELECT count(*) FROM hon.saas_founder_allocations a WHERE a.offer_set_id=s.id)>=s.founder_total_limit
      THEN 'FOUNDER_SET_LIMIT_REACHED'
    WHEN o.sale_limit IS NOT NULL AND (SELECT count(*) FROM hon.saas_founder_allocations a WHERE a.offer_id=o.id)>=o.sale_limit
      THEN 'FOUNDER_OFFER_LIMIT_REACHED'
  END
  FROM (SELECT 1) one LEFT JOIN hon.saas_offer_set_offers o ON o.id=p_offer LEFT JOIN hon.saas_offer_sets s ON s.id=o.set_id
$$;

-- The founder offer a binding was signed up for, or NULL for a standard plan. Read from the binding's fixed requirements.
CREATE FUNCTION hon.saas_schedule_binding_founder_offer(b hon.saas_schedule_bindings) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT o.id FROM hon.saas_offer_set_offers o WHERE o.id::text=b.requirements->>'offerId' AND o.founder
$$;

-- ---------- founder terms locked while subscribed (replaces the 0188 step-up founder content) ----------
-- Standard (REGULAR_*) content is byte-for-byte the 0188 output, so every existing standard schedule digest still matches.
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
 IF o.offer_kind NOT IN ('REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL')
  THEN RAISE EXCEPTION 'SAAS_PRICE_TERMS_UNSUPPORTED' USING ERRCODE='23514'; END IF;
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
DECLARE s hon.saas_price_schedules%ROWTYPE; content jsonb; blockers jsonb:='[]'; digest text; founder_reason text;
BEGIN
 SELECT * INTO s FROM hon.saas_price_schedules WHERE id=p_schedule;
 IF s.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 BEGIN
  content:=hon.saas_price_content(s.offer_id,s.renewal_offer_id);
  IF hon.saas_hon_os_digest(content||jsonb_build_object('version',s.version))<>s.schedule_digest
   THEN blockers:=blockers||'"SCHEDULE_CHANGED"'::jsonb; END IF;
 EXCEPTION WHEN check_violation THEN blockers:=blockers||'"OFFER_NOT_AVAILABLE"'::jsonb; END;
 IF s.version<>(SELECT max(version) FROM hon.saas_price_schedules WHERE offer_id=s.offer_id) THEN blockers:=blockers||'"SCHEDULE_SUPERSEDED"'::jsonb; END IF;
 IF s.terms->>'offerKind' LIKE 'FOUNDER_%' THEN
  -- A version 1 (step-up) founder schedule stays history only. A locked one shows today's availability, never a hold.
  founder_reason:=CASE WHEN s.terms->>'schemaVersion' IS DISTINCT FROM '2' THEN 'FOUNDER_TERMS_NOT_LOCKED'
   ELSE hon.saas_founder_unavailable_reason(p_org,s.offer_id) END;
  IF founder_reason IS NOT NULL THEN blockers:=blockers||to_jsonb(founder_reason); END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM hon.saas_price_acceptances WHERE organization_id=p_org AND school_id=p_school AND schedule_id=s.id)
  THEN blockers:=blockers||'"ALREADY_ACCEPTED"'::jsonb; END IF;
 digest:=hon.saas_hon_os_digest(jsonb_build_object('organizationId',p_org,'schoolId',p_school,'scheduleId',s.id,'scheduleDigest',s.schedule_digest));
 RETURN jsonb_build_object('organizationId',p_org,'schoolId',p_school,'schedule',hon.saas_price_schedule_json(s),
  'acceptanceDigest',digest,'canAcknowledge',jsonb_array_length(blockers)=0,'blockers',blockers,
  'purchaseAvailable',false,'paymentAuthorized',false,'accessGranted',false,'asOf',hon.saas_ts(clock_timestamp()));
END $$;

-- ---------- generation: locked founder acceptances may now generate; availability is rechecked ----------
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
    AND s.terms->>'founderPriceRule'='LOCKED_WHILE_SUBSCRIBED' AND s.terms->>'initialPriceMinor'=s.terms->>'renewalPriceMinor'))
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
 IF o.founder AND hon.saas_founder_unavailable_reason(org,o.id) IS NOT NULL
  THEN RAISE EXCEPTION 'SAAS_FOUNDER_UNAVAILABLE' USING ERRCODE='23514'; END IF;
END $$;

-- ---------- binding: no new founder sign-up once no spot could be counted ----------
CREATE FUNCTION hon.guard_saas_founder_binding_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE offer uuid:=hon.saas_schedule_binding_founder_offer(NEW);
BEGIN
  IF offer IS NOT NULL AND hon.saas_founder_unavailable_reason(NEW.organization_id,offer) IS NOT NULL THEN
    RAISE EXCEPTION 'SAAS_FOUNDER_UNAVAILABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_founder_binding_insert BEFORE INSERT ON hon.saas_schedule_bindings FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_founder_binding_insert();

-- ---------- a spot: only by the first verified payment of a founder binding, under the pool lock ----------
CREATE FUNCTION hon.guard_saas_founder_allocation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; per hon.saas_schedule_paid_periods%ROWTYPE; o hon.saas_offer_set_offers%ROWTYPE; pool hon.saas_founder_pool%ROWTYPE;
BEGIN
  SELECT * INTO pool FROM hon.saas_founder_pool WHERE pool_id=NEW.pool_id FOR UPDATE;
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=NEW.binding_id;
  SELECT * INTO per FROM hon.saas_schedule_paid_periods WHERE id=NEW.paid_period_id;
  SELECT * INTO o FROM hon.saas_offer_set_offers WHERE id=hon.saas_schedule_binding_founder_offer(b);
  IF pool.pool_id IS NULL OR b.id IS NULL OR per.id IS NULL OR o.id IS NULL OR per.binding_id<>b.id
    OR b.status<>'BOUND_TEST_ONLY' OR b.activated_at IS NOT NULL
    OR (SELECT count(*) FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id)<>1
    OR NEW.organization_id<>b.organization_id OR NEW.school_id<>b.school_id OR NEW.offer_id<>o.id OR NEW.offer_set_id<>o.set_id
    OR NEW.offer_set_id::text<>b.requirements->>'offerSetId' OR NEW.offer_kind<>o.offer_kind
    OR NEW.locked_price_minor<>(b.requirements->>'lockedPriceMinor')::integer OR per.amount_minor<>NEW.locked_price_minor
    OR NEW.provider_event_id<>per.provider_event_id OR NEW.allocated_at<>per.recorded_at
    OR hon.saas_founder_unavailable_reason(b.organization_id,o.id) IS NOT NULL
    OR NEW.spot_number<>(SELECT count(*)+1 FROM hon.saas_founder_allocations)
  THEN RAISE EXCEPTION 'SAAS_FOUNDER_ALLOCATION_REFUSED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
-- At commit: the spot's payment must be the stored, counted invoice.paid event of that binding (only ingest writes those).
CREATE FUNCTION hon.verify_saas_founder_allocation_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.saas_schedule_provider_events e JOIN hon.saas_schedule_paid_periods q
      ON q.binding_id=e.binding_id AND q.provider_event_id=e.provider_event_id
    WHERE e.binding_id=NEW.binding_id AND e.provider_event_id=NEW.provider_event_id AND q.id=NEW.paid_period_id
      AND e.event_type='invoice.paid' AND e.outcome='APPLIED' AND e.normalized->'receipt'->>'billingStatus'='ACTIVE')
  THEN RAISE EXCEPTION 'SAAS_FOUNDER_ALLOCATION_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

-- ---------- ingest: count the spot with the first founder payment, or hold the payment ----------
CREATE OR REPLACE FUNCTION hon.ingest_saas_schedule_evidence(p jsonb,p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; e hon.saas_schedule_provider_events%ROWTYPE; org uuid; bid uuid;
  req uuid:=gen_random_uuid(); at timestamptz:=clock_timestamp(); occurred_at timestamptz; period_id uuid;
  outcome text:='NEEDS_REVIEW'; reason text:='RECONCILIATION_REQUIRED'; first_payment boolean:=false; collecting boolean;
  access jsonb:=jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false); result jsonb; founder_offer uuid;
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
  IF NOT collecting THEN
    -- Stored for review instead of refused: money for a parked or ended binding must never be lost or retried forever.
    IF p->>'eventType'='invoice.payment_failed' THEN outcome:='ATTEMPT_FAILED'; reason:='PAYMENT_NOT_VERIFIED';
    ELSIF b.status<>'NEEDS_REVIEW' AND p->>'eventType'='invoice.paid' THEN reason:='PAID_AFTER_TERMINAL';
    ELSE reason:='BINDING_NOT_COLLECTING'; END IF;
  ELSIF p->>'eventType'='invoice.paid' THEN
    IF p->'coveredPeriod' IS NULL OR jsonb_typeof(p->'coveredPeriod')<>'object' OR jsonb_typeof(p->'coveredPeriod'->'startsAt')<>'string' OR jsonb_typeof(p->'coveredPeriod'->'endsAt')<>'string'
      OR coalesce(p->'coveredPeriod'->>'startsAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
      OR coalesce(p->'coveredPeriod'->>'endsAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
      OR coalesce(p->>'invoiceReference','') !~ '^fake_[a-z0-9_-]{1,150}$' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
    IF (p->'coveredPeriod'->>'endsAt')::timestamptz <= (p->'coveredPeriod'->>'startsAt')::timestamptz
    THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
    -- The single locked price, fixed at acceptance (owner answer 4a). Never derived from current offers or a count.
    IF (p->>'amountMinor')::integer<>(b.requirements->>'lockedPriceMinor')::integer THEN reason:='AMOUNT_MISMATCH';
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id AND q.provider_invoice_reference=p->>'invoiceReference') THEN outcome:='ALREADY_APPLIED'; reason:='DUPLICATE_INVOICE_REFERENCE';
    -- One payment covers exactly one billing interval of the locked terms; any other length is reviewed, never counted.
    ELSIF NOT hon.saas_schedule_period_matches(b.requirements->>'billingInterval',(p->'coveredPeriod'->>'startsAt')::timestamptz,(p->'coveredPeriod'->>'endsAt')::timestamptz) THEN reason:='PERIOD_INTERVAL_MISMATCH';
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id AND tstzrange(q.covered_starts_at,q.covered_ends_at,'[)') && tstzrange((p->'coveredPeriod'->>'startsAt')::timestamptz,(p->'coveredPeriod'->>'endsAt')::timestamptz,'[)')) THEN reason:='OVERLAPPING_COVERED_PERIOD';
    -- Piece 4: the last spot was taken first (or this organization already used its one spot). The payment is held for
    -- HQ review, never counted, never auto-refunded (owner answer 3).
    ELSIF founder_offer IS NOT NULL AND b.status='BOUND_TEST_ONLY' AND hon.saas_founder_unavailable_reason(b.organization_id,founder_offer) IS NOT NULL
      THEN reason:='FOUNDER_SPOT_UNAVAILABLE';
    ELSE
      -- A late earlier period is recorded normally; only overlap needs review.
      INSERT INTO hon.saas_schedule_paid_periods(binding_id,provider_invoice_reference,provider_event_id,covered_starts_at,covered_ends_at,amount_minor,currency,recorded_at)
      VALUES(b.id,p->>'invoiceReference',p->>'eventId',(p->'coveredPeriod'->>'startsAt')::timestamptz,(p->'coveredPeriod'->>'endsAt')::timestamptz,(p->>'amountMinor')::integer,'USD',at)
      RETURNING id INTO period_id; outcome:='APPLIED'; reason:='QUALIFYING_PERIOD_RECORDED'; first_payment:=b.status='BOUND_TEST_ONLY';
      IF first_payment AND founder_offer IS NOT NULL THEN
        INSERT INTO hon.saas_founder_allocations(spot_number,organization_id,school_id,binding_id,paid_period_id,provider_event_id,offer_id,
          offer_set_id,offer_kind,locked_price_minor,allocated_at)
        SELECT (SELECT count(*)+1 FROM hon.saas_founder_allocations),b.organization_id,b.school_id,b.id,period_id,p->>'eventId',o.id,o.set_id,
          o.offer_kind,(b.requirements->>'lockedPriceMinor')::integer,at
        FROM hon.saas_offer_set_offers o WHERE o.id=founder_offer;
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

-- ---------- access: founder plans activate only with their counted spot (replaces the 0235 blanket refusal) ----------
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
    WHEN per.amount_minor <> (b.requirements->>'lockedPriceMinor')::integer THEN 'ACCESS_ACTIVATION_ERROR'
    WHEN per.covered_starts_at > p_at + interval '5 minutes' THEN 'PAID_PERIOD_NOT_STARTED'
    WHEN per.covered_ends_at <= p_at THEN 'PAID_PERIOD_ELAPSED' END;
  IF reason IS NULL THEN
    BEGIN
      UPDATE hon.organization_entitlements SET tier = 'COMPLETE', status = 'ACTIVE', effective_from = per.covered_starts_at,
          effective_until = per.covered_ends_at + hon.saas_schedule_access_grace(), version = version + 1, updated_at = p_at
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

-- ---------- cancel: a refunded held-only sign-up may be cancelled ----------
CREATE OR REPLACE FUNCTION hon.cancel_saas_schedule_binding(p_subject text,p_school uuid,p_binding uuid,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; b hon.saas_schedule_bindings%ROWTYPE; prior jsonb; replay jsonb; at timestamptz:=clock_timestamp();
BEGIN
  IF p_binding IS NULL OR NOT hon.saas_trial_keys(p,ARRAY['accountReference','bindingId','identity','mode','outcome','scheduleReference','subscriptionReference'])
    OR p->>'identity'<>'DETERMINISTIC_FAKE' OR p->>'mode'<>'TEST' OR p->>'outcome'<>'CANCELLED_NOTHING_COLLECTED'
    OR p->>'bindingId' IS DISTINCT FROM p_binding::text
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  replay:=hon.saas_claim_request(actor.principal_id,p_key,'saas.schedule_binding.cancel',
    hon.saas_fingerprint(ARRAY['saas.schedule_binding.cancel',p_school::text,p_binding::text,p::text]),p_request,p_correlation);
  IF replay IS NOT NULL THEN PERFORM hon.require_saas_school_purchaser(p_subject,p_school); RETURN replay; END IF;
  PERFORM hon.saas_schedule_payment_program();
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||actor.organization_id::text,0));
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding AND organization_id=actor.organization_id AND school_id=p_school FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF b.status<>'BOUND_TEST_ONLY' OR b.provider_account_reference IS DISTINCT FROM p->>'accountReference'
    OR b.provider_subscription_reference IS DISTINCT FROM p->>'subscriptionReference' OR b.provider_schedule_reference IS DISTINCT FROM p->>'scheduleReference'
    OR (EXISTS(SELECT 1 FROM hon.saas_schedule_provider_events WHERE binding_id=b.id AND event_type<>'invoice.payment_failed')
      -- Piece 4: money that was only ever held (never counted) and is fully covered by the HQ-verified refund no longer
      -- blocks cancelling, so a school whose payment found no founder spot can sign up again at the standard price.
      AND NOT (NOT EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id)
        AND hon.saas_paid_review_reviewed_count(b.id)>0
        AND (SELECT count(*) FROM hon.saas_schedule_reconciliations r WHERE r.binding_id=b.id)<=hon.saas_paid_review_reviewed_count(b.id)))
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_NOT_CANCELLABLE' USING ERRCODE='23514'; END IF;
  prior:=hon.saas_schedule_binding_json(b);
  UPDATE hon.saas_schedule_bindings SET status='CANCELLED_BEFORE_PAYMENT',status_reason='PURCHASER_CANCELLED_BEFORE_PAYMENT',
    version=version+1,terminal_at=at WHERE id=b.id AND version=b.version RETURNING * INTO b;
  PERFORM hon.saas_schedule_after_binding_terminal(b.id,at);
  RETURN hon.saas_record(actor.principal_id,p_key,'saas.schedule_binding.cancel','saas.schedule_binding.transitioned','SCHEDULE_BINDING',b.id,
    b.organization_id,prior,hon.saas_schedule_binding_json(b),jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'replayed',false),at);
END $$;
-- ---------- reads (never a promise, never a reservation) ----------
CREATE FUNCTION hon.saas_founder_pool_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('capacity',p.capacity,'allocated',(SELECT count(*)::integer FROM hon.saas_founder_allocations),
    'remaining',greatest(p.capacity-(SELECT count(*)::integer FROM hon.saas_founder_allocations),0),
    'countingRule',p.counting_rule,'legacyFounderSalesCounted',false)
  FROM hon.saas_founder_pool p WHERE p.pool_id=1
$$;

-- HQ (owner or operator): the pool, every counted spot, and payments held because no spot was left.
CREATE FUNCTION hon.read_saas_founder_pool_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false);
  RETURN hon.saas_founder_pool_json() || jsonb_build_object(
    'spots',coalesce((SELECT jsonb_agg(jsonb_build_object('spotNumber',a.spot_number,'organizationId',a.organization_id,'schoolId',a.school_id,
      'bindingId',a.binding_id,'offerId',a.offer_id,'offerKind',a.offer_kind,'lockedPriceMinor',a.locked_price_minor,
      'allocatedAt',hon.saas_ts(a.allocated_at)) ORDER BY a.spot_number) FROM hon.saas_founder_allocations a),'[]'::jsonb),
    'heldWithoutSpot',(SELECT count(*)::integer FROM hon.saas_schedule_bindings b WHERE b.status='NEEDS_REVIEW' AND b.status_reason='FOUNDER_SPOT_UNAVAILABLE'),
    'checkoutAvailable',false,'asOf',hon.saas_ts(clock_timestamp()));
END $$;

-- School purchaser: whether a founder spot could be counted for this organization right now, per founder offer on sale.
CREATE FUNCTION hon.read_saas_founder_availability_for_school(p_subject text,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; at timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  RETURN jsonb_build_object('organizationId',actor.organization_id,'schoolId',p_school,
    'pool',hon.saas_founder_pool_json(),
    'organizationUsedFounderSpot',EXISTS(SELECT 1 FROM hon.saas_founder_allocations a WHERE a.organization_id=actor.organization_id),
    'offers',coalesce((SELECT jsonb_agg(jsonb_build_object('offerId',o.id,'offerKind',o.offer_kind,'billingInterval',o.billing_interval,
        'priceMinor',o.price_minor,'standardPriceMinor',(SELECT r.price_minor FROM hon.saas_offer_set_offers r WHERE r.set_id=o.set_id
          AND r.offer_kind=CASE o.billing_interval WHEN 'ANNUAL' THEN 'REGULAR_ANNUAL' ELSE 'REGULAR_MONTHLY' END),
        'available',hon.saas_founder_unavailable_reason(actor.organization_id,o.id) IS NULL,
        'reason',hon.saas_founder_unavailable_reason(actor.organization_id,o.id)) ORDER BY o.position)
      FROM hon.saas_offer_set_offers o JOIN hon.saas_offer_sets s ON s.id=o.set_id
      WHERE s.status='PUBLISHED' AND o.founder AND o.offer_kind IN ('FOUNDER_MONTHLY','FOUNDER_ANNUAL') AND hon.saas_hon_os_offer_on_sale(o,at)),'[]'::jsonb),
    'spotCountedAt','FIRST_VERIFIED_PAYMENT','spotReserved',false,'checkoutAvailable',false,'asOf',hon.saas_ts(at));
END $$;

-- ---------- RLS, immutability, ACLs and grants ----------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_founder_pool','saas_founder_allocations'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
END $$;
CREATE TRIGGER saas_founder_pool_insert BEFORE INSERT ON hon.saas_founder_pool FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_founder_allocation_authority BEFORE INSERT ON hon.saas_founder_allocations FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_founder_allocation_insert();
CREATE CONSTRAINT TRIGGER saas_founder_allocation_evidence AFTER INSERT ON hon.saas_founder_allocations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_founder_allocation_evidence();
DO $$ DECLARE t text; r text; c text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_founder_pool','saas_founder_allocations'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.saas_founder_unavailable_reason(uuid,uuid)','hon.saas_schedule_binding_founder_offer(hon.saas_schedule_bindings)',
    'hon.saas_price_content(uuid,uuid)','hon.saas_price_acceptance_preview(uuid,uuid,uuid)','hon.saas_generation_content(uuid,uuid)',
    'hon.saas_generation_available(uuid)','hon.guard_saas_founder_binding_insert()','hon.guard_saas_founder_allocation_insert()',
    'hon.verify_saas_founder_allocation_evidence()','hon.ingest_saas_schedule_evidence(jsonb,text)',
    'hon.saas_schedule_activate_access(uuid,uuid,timestamp with time zone)','hon.cancel_saas_schedule_binding(text,uuid,uuid,jsonb,uuid,uuid,uuid)',
    'hon.saas_founder_pool_json()','hon.read_saas_founder_pool_from_hq(text)','hon.read_saas_founder_availability_for_school(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.ingest_saas_schedule_evidence(jsonb,text),hon.cancel_saas_schedule_binding(text,uuid,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_founder_pool_from_hq(text),hon.read_saas_founder_availability_for_school(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
