BEGIN;

-- 0325: the $100 Champions Club welcome credit on HON OS plans (schedule path). TEST provider only; never cash.
--   * The credit is earned when the HQ owner QUALIFIES the referral (existing Champions accrual, 0149/0153). Recommended
--     reading of the owner docs; David's timing answer is pending (plan: founder-billing/WELCOME_CREDIT_0325_PLAN.md).
--   * The HQ owner applies an APPROVED WELCOME_CREDIT entry to the referred school's ACTIVE monthly or annual plan while
--     the reward-fulfillment switch (0157) is ACTIVE. It ships INACTIVE. One application per entry, ever, on either path.
--   * The API then asks the provider (deterministic TEST adapter) to put the same amount on the customer's balance, with
--     the command's idempotency key. A retry with the same key converges.
--   * Renewals: an ACTIVE recurring plan's renewal is accepted at the locked price minus the credit still unused (down
--     to zero); the credited part is consumed oldest first. Any other amount, including the full price while credit
--     remains, is held for review as before. A remainder carries to the following renewals.
--   * A refund or dispute on a referred school's HON OS plan now raises the same referral payment alert as the legacy
--     path, which blocks its welcome credit and the referrer's rewards. Nothing applied is clawed back.
--   * The school sees only amounts (credited, used, remaining), never who referred it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS welcome credit requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS welcome credit requires a restricted runtime';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.saas_reward_fulfillment WHERE program_id=1 AND cash_payouts=false) THEN
    RAISE EXCEPTION 'reward fulfillment drifted';
  END IF;
END $$;

-- ---------- ledger: one welcome credit per Champions entry, and its consumption by paid renewals ----------
CREATE TABLE hon.saas_schedule_welcome_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_entry_id uuid NOT NULL UNIQUE REFERENCES hon.champions_reward_entries(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000),
  provider_credit_key uuid NOT NULL UNIQUE,
  applied_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL
);
CREATE INDEX saas_schedule_welcome_credits_binding ON hon.saas_schedule_welcome_credits(binding_id, applied_at, id);
CREATE TABLE hon.saas_schedule_credit_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id uuid NOT NULL REFERENCES hon.saas_schedule_welcome_credits(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  paid_period_id uuid NOT NULL REFERENCES hon.saas_schedule_paid_periods(id) ON DELETE RESTRICT,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 100000),
  recorded_at timestamptz NOT NULL,
  UNIQUE (credit_id, paid_period_id)
);
CREATE INDEX saas_schedule_credit_uses_period ON hon.saas_schedule_credit_uses(paid_period_id);
ALTER TABLE hon.saas_schedule_welcome_credits ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.saas_schedule_credit_uses ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
DO $$ DECLARE r text; t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.saas_schedule_welcome_credits','hon.saas_schedule_credit_uses'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',t,r); END LOOP;
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE DELETE OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
END $$;

-- A renewal fully covered by credit is recorded at zero. Every paid period must equal its plan's locked price minus the
-- credit it consumed, and no credit is consumed beyond its amount (checked at commit, so nothing is written by hand).
ALTER TABLE hon.saas_schedule_paid_periods DROP CONSTRAINT saas_schedule_paid_periods_amount_minor_check;
ALTER TABLE hon.saas_schedule_paid_periods ADD CONSTRAINT saas_schedule_paid_periods_amount_minor_check
  CHECK (amount_minor BETWEEN 0 AND 10000000);

-- Runs at commit, possibly outside the definer command that wrote the rows, so it reads as its owner.
CREATE FUNCTION hon.verify_saas_schedule_credit_consistency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_period uuid; v_credit uuid; ok boolean;
BEGIN
  IF TG_TABLE_NAME = 'saas_schedule_paid_periods' THEN v_period := NEW.id; ELSE v_period := NEW.paid_period_id; v_credit := NEW.credit_id; END IF;
  SELECT q.amount_minor + coalesce((SELECT sum(u.amount_minor) FROM hon.saas_schedule_credit_uses u WHERE u.paid_period_id = q.id), 0)
      = (b.requirements->>'lockedPriceMinor')::bigint
    AND NOT EXISTS (SELECT 1 FROM hon.saas_schedule_credit_uses u JOIN hon.saas_schedule_welcome_credits w ON w.id = u.credit_id
      WHERE u.paid_period_id = q.id AND (w.binding_id <> q.binding_id OR u.binding_id <> q.binding_id))
    INTO ok
  FROM hon.saas_schedule_paid_periods q JOIN hon.saas_schedule_bindings b ON b.id = q.binding_id WHERE q.id = v_period;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'SAAS_SCHEDULE_CREDIT_INCONSISTENT' USING ERRCODE = '23514'; END IF;
  IF v_credit IS NOT NULL AND (SELECT sum(u.amount_minor) FROM hon.saas_schedule_credit_uses u WHERE u.credit_id = v_credit)
      > (SELECT w.amount_minor FROM hon.saas_schedule_welcome_credits w WHERE w.id = v_credit) THEN
    RAISE EXCEPTION 'SAAS_SCHEDULE_CREDIT_INCONSISTENT' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER saas_schedule_credit_consistency AFTER INSERT ON hon.saas_schedule_paid_periods
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_schedule_credit_consistency();
CREATE CONSTRAINT TRIGGER saas_schedule_credit_consistency AFTER INSERT ON hon.saas_schedule_credit_uses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_schedule_credit_consistency();

-- An entry is applied once, on one path: the legacy B4 application refuses an entry already used here.
CREATE FUNCTION hon.guard_saas_reward_single_path() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_TABLE_NAME = 'saas_reward_applications'
    AND EXISTS (SELECT 1 FROM hon.saas_schedule_welcome_credits w WHERE w.reward_entry_id = NEW.reward_entry_id) THEN
    RAISE EXCEPTION 'SAAS_REWARD_ALREADY_APPLIED' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'saas_schedule_welcome_credits'
    AND EXISTS (SELECT 1 FROM hon.saas_reward_applications a WHERE a.reward_entry_id = NEW.reward_entry_id) THEN
    RAISE EXCEPTION 'SAAS_REWARD_ALREADY_APPLIED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_reward_single_path BEFORE INSERT ON hon.saas_reward_applications
  FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_reward_single_path();
CREATE TRIGGER saas_reward_single_path BEFORE INSERT ON hon.saas_schedule_welcome_credits
  FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_reward_single_path();

CREATE FUNCTION hon.saas_schedule_credit_remaining(p_binding uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT (coalesce((SELECT sum(w.amount_minor) FROM hon.saas_schedule_welcome_credits w WHERE w.binding_id = p_binding), 0)
    - coalesce((SELECT sum(u.amount_minor) FROM hon.saas_schedule_credit_uses u WHERE u.binding_id = p_binding), 0))::integer
$$;
CREATE FUNCTION hon.saas_schedule_welcome_credit_json(p_binding uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object(
    'creditedMinor', coalesce((SELECT sum(w.amount_minor) FROM hon.saas_schedule_welcome_credits w WHERE w.binding_id = p_binding), 0)::integer,
    'usedMinor', coalesce((SELECT sum(u.amount_minor) FROM hon.saas_schedule_credit_uses u WHERE u.binding_id = p_binding), 0)::integer,
    'remainingMinor', hon.saas_schedule_credit_remaining(p_binding))
$$;

-- ---------- referral payment alerts from schedule refunds and disputes ----------
ALTER TABLE hon.saas_referral_payment_alerts ADD COLUMN schedule_event_id uuid REFERENCES hon.saas_schedule_provider_events(id) ON DELETE RESTRICT;
ALTER TABLE hon.saas_referral_payment_alerts DROP CONSTRAINT saas_referral_payment_alerts_source_check;
ALTER TABLE hon.saas_referral_payment_alerts ADD CONSTRAINT saas_referral_payment_alerts_source_check
  CHECK (source IN ('PAYMENT_EVIDENCE','REFUND_REQUEST','SCHEDULE_EVENT'));
ALTER TABLE hon.saas_referral_payment_alerts DROP CONSTRAINT saas_referral_payment_alerts_check;
ALTER TABLE hon.saas_referral_payment_alerts ADD CONSTRAINT saas_referral_payment_alerts_check
  CHECK ((source = 'PAYMENT_EVIDENCE') = (payment_evidence_id IS NOT NULL) AND (source = 'REFUND_REQUEST') = (refund_request_id IS NOT NULL)
    AND (source = 'SCHEDULE_EVENT') = (schedule_event_id IS NOT NULL));
CREATE UNIQUE INDEX saas_referral_alert_once_per_schedule_event ON hon.saas_referral_payment_alerts (attribution_id, schedule_event_id)
  WHERE schedule_event_id IS NOT NULL;

CREATE FUNCTION hon.saas_schedule_event_referral_alert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE org uuid;
BEGIN
  IF NEW.event_type IN ('charge.refunded','charge.dispute.created') AND NEW.binding_id IS NOT NULL THEN
    SELECT organization_id INTO org FROM hon.saas_schedule_bindings WHERE id = NEW.binding_id;
    INSERT INTO hon.saas_referral_payment_alerts(attribution_id, referred_organization_id, referrer_school_id, source, schedule_event_id,
        evidence_kind, referred_recorded_net_minor, status, version, raised_at)
      SELECT a.id, a.referred_organization_id, a.referrer_school_id, 'SCHEDULE_EVENT', NEW.id,
        CASE NEW.event_type WHEN 'charge.refunded' THEN 'REFUND' ELSE 'CHARGEBACK' END,
        (SELECT coalesce(sum(q.amount_minor), 0) FROM hon.saas_schedule_paid_periods q JOIN hon.saas_schedule_bindings x ON x.id = q.binding_id
          WHERE x.organization_id = org),
        'OPEN', 1, NEW.received_at
      FROM hon.champions_attributions a WHERE a.referred_organization_id = org AND a.state = 'QUALIFIED'
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER saas_referral_alert AFTER INSERT ON hon.saas_schedule_provider_events
  FOR EACH ROW EXECUTE FUNCTION hon.saas_schedule_event_referral_alert();

CREATE OR REPLACE FUNCTION hon.saas_alert_json(al hon.saas_referral_payment_alerts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('alertId',al.id,'attributionId',al.attribution_id,'attributionState',(SELECT a.state FROM hon.champions_attributions a WHERE a.id = al.attribution_id),
    'referredOrganizationId',al.referred_organization_id,
    'referredOrganizationName',(SELECT o.display_name FROM hon.organizations o WHERE o.id = al.referred_organization_id),
    'referrerSchoolId',al.referrer_school_id,'source',al.source,'paymentEvidenceId',al.payment_evidence_id,'refundRequestId',al.refund_request_id,
    'scheduleEventId',al.schedule_event_id,
    'evidenceKind',al.evidence_kind,'referredRecordedNetMinor',al.referred_recorded_net_minor,'status',al.status,'resolution',al.resolution,
    'resolutionReference',al.resolution_reference,'version',al.version,'raisedAt',hon.saas_ts(al.raised_at),'resolvedAt',hon.saas_ts(al.resolved_at),
    -- 0325: welcome credits applied to a HON OS plan are affected benefits too.
    'affectedApplications',(SELECT coalesce(jsonb_agg(x.id ORDER BY x.at, x.id), '[]'::jsonb) FROM (
      SELECT ra.id, ra.applied_at AS at FROM hon.saas_reward_applications ra JOIN hon.champions_reward_entries e ON e.id = ra.reward_entry_id
        WHERE (e.reward_kind = 'WELCOME_CREDIT' AND e.attribution_id = al.attribution_id)
          OR (e.reward_kind <> 'WELCOME_CREDIT' AND e.referrer_school_id = al.referrer_school_id)
      UNION ALL
      SELECT w.id, w.applied_at FROM hon.saas_schedule_welcome_credits w JOIN hon.champions_reward_entries e ON e.id = w.reward_entry_id
        WHERE e.attribution_id = al.attribution_id) x),
    'automaticReversal','NONE','debtCreated',false)
$$;

-- ---------- HQ owner: apply one approved welcome credit to the referred school's HON OS plan ----------
CREATE FUNCTION hon.apply_saas_schedule_welcome_credit(p_subject text, p_entry uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; e hon.champions_reward_entries%ROWTYPE; b hon.saas_schedule_bindings%ROWTYPE;
  ent hon.organization_entitlements%ROWTYPE; st hon.saas_access_states%ROWTYPE; w hon.saas_schedule_welcome_credits%ROWTYPE;
  v_org uuid; at timestamptz; snapshot jsonb;
BEGIN
  IF p_entry IS NULL OR p_key IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['bindingId','expectedEntryVersion']
    OR coalesce(jsonb_typeof(p->'expectedEntryVersion'), '') <> 'number' OR (p->>'expectedEntryVersion') !~ '^[1-9][0-9]{0,8}$'
    OR coalesce(jsonb_typeof(p->'bindingId'), '') <> 'string'
    OR (p->>'bindingId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.rewards.apply',
    hon.saas_fingerprint(ARRAY['saas.rewards.apply.hon_os_welcome_credit', p_entry::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT organization_id INTO v_org FROM hon.saas_schedule_bindings WHERE id = (p->>'bindingId')::uuid;
  IF v_org IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  -- Canonical order: organization -> binding row -> entitlement -> access state -> Champions entry -> reward lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||v_org::text,0));
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id = (p->>'bindingId')::uuid FOR UPDATE;
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = v_org FOR UPDATE;
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = v_org FOR UPDATE;
  SELECT * INTO e FROM hon.champions_reward_entries WHERE id = p_entry FOR UPDATE;
  IF e.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.rewards:' || e.beneficiary_organization_id::text, 0));
  IF e.version <> (p->>'expectedEntryVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_reward_applications WHERE reward_entry_id = e.id)
    OR EXISTS (SELECT 1 FROM hon.saas_schedule_welcome_credits WHERE reward_entry_id = e.id) THEN
    RAISE EXCEPTION 'SAAS_REWARD_ALREADY_APPLIED' USING ERRCODE = '23514';
  END IF;
  IF e.reward_kind <> 'WELCOME_CREDIT' OR e.beneficiary_organization_id <> b.organization_id THEN
    RAISE EXCEPTION 'SAAS_REWARD_NOT_APPLICABLE' USING ERRCODE = '23514'; END IF;
  IF e.status = 'VOIDED' THEN RAISE EXCEPTION 'SAAS_REWARD_VOIDED' USING ERRCODE = '23514'; END IF;
  IF e.status = 'REVERSAL_REVIEW' THEN RAISE EXCEPTION 'SAAS_REWARD_UNDER_REVIEW' USING ERRCODE = '23514'; END IF;
  IF e.status <> 'APPROVED' THEN RAISE EXCEPTION 'SAAS_REWARD_NOT_APPROVED' USING ERRCODE = '23514'; END IF;
  IF e.fulfillment_form = 'OWNER_SUBSTITUTE' THEN RAISE EXCEPTION 'SAAS_REWARD_SUBSTITUTE_MANUAL' USING ERRCODE = '23514'; END IF;
  IF hon.saas_reward_entry_blocked(e.id) THEN RAISE EXCEPTION 'SAAS_REWARD_PAYMENT_ALERT_OPEN' USING ERRCODE = '23514'; END IF;
  IF coalesce(e.credit_minor, 0) = 0 THEN RAISE EXCEPTION 'SAAS_REWARD_NOTHING_TO_APPLY' USING ERRCODE = '23514'; END IF;
  IF NOT (SELECT status = 'ACTIVE' FROM hon.saas_reward_fulfillment WHERE program_id = 1) THEN
    RAISE EXCEPTION 'SAAS_REWARDS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  -- Only a paying recurring plan with access on can use a renewal credit: never a lifetime, ended, suspended,
  -- unpaid or reviewed plan.
  IF b.status <> 'ACTIVE' OR b.requirements->>'billingInterval' NOT IN ('MONTHLY','ANNUAL')
    OR st.state IS DISTINCT FROM 'PAYMENT_ACTIVE' OR st.activation_source IS DISTINCT FROM 'SCHEDULE_BINDING' OR st.binding_id IS DISTINCT FROM b.id
    OR ent.organization_id IS NULL OR ent.status <> 'ACTIVE' OR b.provider_account_reference IS NULL THEN
    RAISE EXCEPTION 'SAAS_REWARD_NOT_APPLICABLE' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  INSERT INTO hon.saas_schedule_welcome_credits(reward_entry_id, organization_id, binding_id, amount_minor, provider_credit_key,
      applied_by_principal_id, applied_at)
    VALUES (e.id, b.organization_id, b.id, e.credit_minor, p_key, actor, at) RETURNING * INTO w;
  snapshot := jsonb_build_object('welcomeCreditId', w.id, 'rewardEntryId', e.id, 'bindingId', b.id, 'organizationId', b.organization_id,
    'amountMinor', w.amount_minor, 'providerAccountReference', b.provider_account_reference, 'providerCreditKey', w.provider_credit_key,
    'appliedAt', hon.saas_ts(w.applied_at), 'welcomeCredit', hon.saas_schedule_welcome_credit_json(b.id), 'cashPayout', false);
  RETURN hon.saas_record(actor, p_key, 'saas.rewards.apply', 'saas.rewards.applied', 'REWARD_APPLICATION', w.id, b.organization_id,
    NULL, snapshot, snapshot, at);
END $$;

-- ---------- reads: the school and HQ binding views carry amounts only ----------
CREATE OR REPLACE FUNCTION hon.read_saas_schedule_binding(p_subject text, p_school uuid, p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; b hon.saas_schedule_bindings%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding AND organization_id=actor.organization_id AND school_id=p_school;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN hon.saas_schedule_binding_json(b) || jsonb_build_object('access',hon.saas_schedule_access_json(b.id),
    'welcomeCredit',hon.saas_schedule_welcome_credit_json(b.id));
END $$;
CREATE OR REPLACE FUNCTION hon.read_saas_schedule_binding_from_hq(p_subject text, p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false); SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN hon.saas_schedule_binding_json(b) || jsonb_build_object('access',hon.saas_schedule_access_json(b.id),
    'welcomeCredit',hon.saas_schedule_welcome_credit_json(b.id));
END $$;

-- ---------- ingest (0309 body; a recorded welcome credit lowers the accepted renewal amount) ----------
CREATE OR REPLACE FUNCTION hon.ingest_saas_schedule_evidence(p jsonb,p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; e hon.saas_schedule_provider_events%ROWTYPE; org uuid; bid uuid;
  req uuid:=gen_random_uuid(); at timestamptz:=clock_timestamp(); occurred_at timestamptz; period_id uuid;
  outcome text:='NEEDS_REVIEW'; reason text:='RECONCILIATION_REQUIRED'; first_payment boolean:=false; collecting boolean;
  access jsonb:=jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false); result jsonb; founder_offer uuid;
  lifetime_offer uuid; covered_ends timestamptz; covered_starts timestamptz; ending boolean:=false;
  locked integer; expected integer; credit_left integer:=0; use_left integer; c record;
BEGIN
  IF p_digest !~ '^[0-9a-f]{64}$' OR p_digest<>hon.saas_hon_os_digest(p)
    OR NOT hon.saas_trial_keys(p,ARRAY['accountReference','amountMinor','bindingId','coveredPeriod','currency','eventId','eventType','invoiceReference','mode','occurredAt','provider','relatedInvoiceReference','scheduleReference','subscriptionReference'])
    OR p->>'provider'<>'STRIPE_SIMULATED' OR p->>'mode'<>'TEST' OR p->>'eventId' !~ '^evt_[A-Za-z0-9_]{1,200}$'
    OR p->>'eventType' NOT IN ('invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created')
    OR coalesce(p->>'bindingId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT (p->>'accountReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'subscriptionReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'scheduleReference' ~ '^fake_[a-z0-9_-]{1,150}$')
    OR p->>'currency'<>'USD' OR jsonb_typeof(p->'amountMinor')<>'number' OR coalesce(p->>'amountMinor','') !~ '^(0|[1-9][0-9]{0,8})$'
    -- 0325: only a renewal fully covered by a recorded welcome credit can report zero.
    OR (p->>'amountMinor'='0' AND p->>'eventType'<>'invoice.paid')
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
    -- 0325: a recorded welcome credit lowers an ACTIVE recurring plan's renewal by up to the locked price (the provider
    -- applies the same customer balance). Any other amount, including the full price while credit remains, is reviewed.
    locked:=(b.requirements->>'lockedPriceMinor')::integer;
    IF b.status='ACTIVE' AND b.requirements->>'billingInterval' IN ('MONTHLY','ANNUAL') THEN credit_left:=hon.saas_schedule_credit_remaining(b.id); END IF;
    expected:=locked-least(locked,credit_left);
    IF (p->>'amountMinor')::integer<>expected THEN reason:='AMOUNT_MISMATCH';
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
      -- 0325: the credited part of this renewal is consumed from the oldest recorded welcome credit first.
      use_left:=locked-(p->>'amountMinor')::integer;
      FOR c IN SELECT w.id, (w.amount_minor-coalesce((SELECT sum(u.amount_minor) FROM hon.saas_schedule_credit_uses u WHERE u.credit_id=w.id),0))::integer AS left_minor
        FROM hon.saas_schedule_welcome_credits w WHERE w.binding_id=b.id ORDER BY w.applied_at, w.id LOOP
        EXIT WHEN use_left<=0;
        CONTINUE WHEN c.left_minor<=0;
        INSERT INTO hon.saas_schedule_credit_uses(credit_id,binding_id,paid_period_id,amount_minor,recorded_at)
          VALUES(c.id,b.id,period_id,least(use_left,c.left_minor),at);
        use_left:=use_left-least(use_left,c.left_minor);
      END LOOP;
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
    -- 0309 (owner D2): the provider's own full refund of the counted lifetime payment, received within the offer's refund
    -- window of the verified payment, ends lifetime access. A partial or late refund, or a dispute, stays held for HQ review.
    -- The sale stays counted (owner 2026-11-13). HON never refunds; it records the provider's refund event.
    IF period_id IS NOT NULL AND p->>'eventType'='charge.refunded' AND lifetime_offer IS NOT NULL AND b.status='ACTIVE'
      AND coalesce(b.requirements->'refundTerms'->>'windowDays','') ~ '^[0-9]{1,3}$'
      AND EXISTS(SELECT 1 FROM hon.saas_lifetime_sales ls JOIN hon.saas_schedule_paid_periods q ON q.id=ls.paid_period_id
        WHERE ls.binding_id=b.id AND ls.paid_period_id=period_id AND q.amount_minor=(p->>'amountMinor')::integer
          AND at <= ls.sold_at + make_interval(days => (b.requirements->'refundTerms'->>'windowDays')::integer)) THEN
      outcome:='APPLIED'; reason:='LIFETIME_REFUND_IN_WINDOW'; ending:=true;
    END IF;
  END IF;
  -- Billing outcome first. It is final for this transaction whatever happens to access below.
  IF first_payment THEN
    b:=hon.saas_schedule_binding_transition(b,'ACTIVE','FIRST_PAYMENT_VERIFIED','saas.schedule_binding.transition',gen_random_uuid(),at);
  ELSIF ending THEN
    b:=hon.saas_schedule_binding_transition(b,'REFUNDED_ENDED','LIFETIME_REFUND_IN_WINDOW','saas.schedule_binding.transition',gen_random_uuid(),at);
  ELSIF outcome='NEEDS_REVIEW' AND collecting THEN
    b:=hon.saas_schedule_binding_transition(b,'NEEDS_REVIEW',reason,'saas.schedule_binding.transition',gen_random_uuid(),at);
  END IF;
  PERFORM hon.saas_claim_request(hon.saas_payment_actor(),req,'saas.schedule_evidence.ingest',hon.saas_fingerprint(ARRAY['saas.schedule_evidence.ingest',p->>'eventId',p_digest]),req,req);
  IF outcome='NEEDS_REVIEW' THEN INSERT INTO hon.saas_schedule_reconciliations(binding_id,provider_event_id,related_period_id,outcome,reason,created_at)
    VALUES(b.id,p->>'eventId',period_id,'NEEDS_REVIEW',reason,at); END IF;
  -- Access outcome second, isolated: the sub-block rolls back only the hook's own work.
  -- 0309: ending access is not isolated. If it cannot be recorded, the whole delivery fails and the provider retries it,
  -- so billing never ends while access stays on.
  IF ending THEN access:=hon.saas_schedule_end_lifetime_access(b.id,period_id,p->>'eventId',at);
  ELSIF outcome='APPLIED' THEN
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

-- ---------- ACLs ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.apply_saas_schedule_welcome_credit(text,uuid,jsonb,uuid,uuid,uuid)',
    'hon.read_saas_schedule_binding(text,uuid,uuid)','hon.read_saas_schedule_binding_from_hq(text,uuid)',
    'hon.ingest_saas_schedule_evidence(jsonb,text)','hon.saas_schedule_credit_remaining(uuid)','hon.saas_schedule_welcome_credit_json(uuid)',
    'hon.verify_saas_schedule_credit_consistency()','hon.guard_saas_reward_single_path()','hon.saas_schedule_event_referral_alert()',
    'hon.saas_alert_json(hon.saas_referral_payment_alerts)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.apply_saas_schedule_welcome_credit(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_schedule_binding(text,uuid,uuid),hon.read_saas_schedule_binding_from_hq(text,uuid),
      hon.ingest_saas_schedule_evidence(jsonb,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
