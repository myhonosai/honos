BEGIN;

-- HON Subscription Billing B6A: verified first payment -> authorized software access (INACTIVE).
-- - One access authority: organization_entitlements stays the only entitlement record. A new access state
--   records how an organization's access came to be (HQ-provisioned, awaiting its first payment, or activated by
--   a verified payment), and hon.saas_organization_access / hon.saas_capability_allowed are the central read.
-- - First-payment activation runs inside the B5 verified-payment transaction: for an organization awaiting its
--   first payment, the server-chosen published offer's plan becomes the entitlement tier (status ACTIVE, version
--   step, evidence) and the period's B3 allowance opens. Failure never reports activation: the payment stays
--   recorded, the organization stays awaiting, and an HQ-review transition is written for an owner-only retry.
-- - INACTIVE: the paid-access program can only be INACTIVE (0170 CHECK). Every path here that changes access
--   requires it to be ACTIVE, so nothing changes for any real organization until a reviewed migration after
--   owner approval. Existing provisioned schools are untouched; no suspension, cancellation, refund or dunning.
-- - Six staff scope resolvers (achievements, staff reporting, follow-ups, human work, teaching studio, testing
--   registration review) also require the entitlement to be ACTIVE and in effect, closing the recorded coverage gaps.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON paid access requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON paid access requires a restricted runtime';
  END IF;
END $$;

-- ---------- vocabularies ----------
ALTER TABLE hon.saas_checkout_sessions DROP CONSTRAINT saas_checkout_sessions_status_reason_check;
ALTER TABLE hon.saas_checkout_sessions ADD CONSTRAINT saas_checkout_sessions_status_reason_check CHECK (status_reason IN ('CREATED',
  'PROVIDER_SESSION_OPENED','PROVIDER_CREATE_FAILED','PAYMENT_VERIFIED','PROVIDER_EXPIRED','LOCAL_EXPIRED','CANCELLED_BY_REQUESTER',
  'CANCELLED_BY_HQ','ASYNC_PAYMENT_FAILED','PAID_AFTER_CLOSE','AMOUNT_MISMATCH','FOUNDER_UNAVAILABLE','ENTITLEMENT_CHANGED',
  'SUBSCRIPTION_EXISTS','ACCESS_PROGRAM_INACTIVE'));
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (action_code IN ('saas.catalog.draft','saas.catalog.publish',
  'saas.founder.reserve','saas.founder.release','saas.subscription.record','saas.subscription.command',
  'saas.invoice.draft','saas.invoice.command','saas.payment.evidence',
  'saas.credits.program','saas.credits.cost_evidence','saas.credits.pricing_draft','saas.credits.pricing_publish',
  'saas.credits.allowance','saas.credits.reserve','saas.credits.settle','saas.credits.resolve',
  'saas.refund.request','saas.refund.decide','saas.rewards.fulfillment','saas.rewards.apply','saas.rewards.credit_apply','saas.rewards.alert_resolve',
  'saas.payments.program','saas.checkout.create','saas.checkout.attach','saas.checkout.cancel','saas.checkout.sweep','saas.provider.event',
  'saas.access.await','saas.access.retry'));
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION',
  'INVOICE','PAYMENT_EVIDENCE','CREDIT_PROGRAM','COST_EVIDENCE','PRICING','ALLOWANCE','CREDIT_RESERVATION',
  'REFUND_REQUEST','REWARD_FULFILLMENT','REWARD_APPLICATION','REFERRAL_ALERT','PAYMENT_PROGRAM','CHECKOUT','PROVIDER_EVENT','ACCESS_STATE'));
ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published',
  'saas.founder.reserved','saas.founder.released','saas.subscription.recorded','saas.subscription.changed',
  'saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded',
  'saas.credits.program_changed','saas.credits.cost_recorded','saas.credits.pricing_drafted','saas.credits.pricing_published',
  'saas.credits.allowance_changed','saas.credits.reserved','saas.credits.settled','saas.credits.resolved',
  'saas.refund.requested','saas.refund.decided','saas.rewards.fulfillment_changed','saas.rewards.applied','saas.rewards.credit_applied',
  'saas.rewards.alert_resolved','saas.payments.program_changed','saas.checkout.created','saas.checkout.changed','saas.checkouts.swept',
  'saas.provider.event_recorded','saas.access.awaiting','saas.access.retried'));

-- ---------- access state and its evidence ----------
CREATE TABLE hon.saas_access_states (
  organization_id uuid PRIMARY KEY REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('AWAITING_FIRST_PAYMENT','PAYMENT_ACTIVE')),
  reason text NOT NULL CHECK (reason IN ('AWAITING_INITIAL_PAYMENT','FIRST_PAYMENT_VERIFIED')),
  version integer NOT NULL CHECK (version > 0),
  checkout_id uuid REFERENCES hon.saas_checkout_sessions(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  changed_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CHECK ((state = 'PAYMENT_ACTIVE') = (checkout_id IS NOT NULL AND subscription_id IS NOT NULL)),
  CHECK ((state = 'PAYMENT_ACTIVE') = (reason = 'FIRST_PAYMENT_VERIFIED'))
);
CREATE TABLE hon.saas_access_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('AWAITING_FIRST_PAYMENT','FIRST_PAYMENT_ACTIVATION')),
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','NEEDS_REVIEW')),
  reason text NOT NULL CHECK (reason ~ '^[A-Z_]{3,60}$'),
  checkout_id uuid REFERENCES hon.saas_checkout_sessions(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  evidence_id uuid REFERENCES hon.saas_payment_evidence(id) ON DELETE RESTRICT,
  allowance_id uuid REFERENCES hon.saas_credit_allowances(id) ON DELETE RESTRICT,
  provider_event_id text CHECK (provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  prior_entitlement jsonb, next_entitlement jsonb,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  CHECK ((kind = 'FIRST_PAYMENT_ACTIVATION') = (checkout_id IS NOT NULL)),
  CHECK ((outcome = 'APPLIED') = (next_entitlement IS NOT NULL))
);
-- At most one applied activation per organization and per checkout: a replay can never activate twice.
CREATE UNIQUE INDEX saas_access_one_activation_per_org ON hon.saas_access_transitions (organization_id)
  WHERE kind = 'FIRST_PAYMENT_ACTIVATION' AND outcome = 'APPLIED';
CREATE UNIQUE INDEX saas_access_one_activation_per_checkout ON hon.saas_access_transitions (checkout_id)
  WHERE kind = 'FIRST_PAYMENT_ACTIVATION' AND outcome = 'APPLIED';

CREATE FUNCTION hon.guard_saas_access() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  -- The only state change: awaiting -> payment active, one version step, same organization.
  IF TG_OP = 'UPDATE' AND OLD.state = 'AWAITING_FIRST_PAYMENT' AND NEW.state = 'PAYMENT_ACTIVE' AND NEW.version = OLD.version + 1
    AND NEW.organization_id = OLD.organization_id AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.saas_access_states FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_access();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_access_states FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_access();
CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.saas_access_transitions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_access_transitions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- ---------- central access authority ----------
CREATE FUNCTION hon.saas_access_program_active() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce((SELECT status = 'ACTIVE' FROM hon.saas_access_program WHERE program_id = 1), false)
$$;

-- The one read of what an organization may use: the entitlement (status, window, tier) and how it was obtained.
CREATE FUNCTION hon.saas_organization_access(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE ent jsonb; st hon.saas_access_states%ROWTYPE; in_effect boolean;
BEGIN
  ent := hon.saas_entitlement_json(p_org);
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = p_org;
  in_effect := coalesce((ent->>'inEffect')::boolean, false);
  RETURN jsonb_build_object('organizationId', p_org,
    'state', CASE WHEN st.state IS NOT NULL THEN st.state WHEN ent IS NULL THEN 'NONE' ELSE 'PROVISIONED' END,
    'source', CASE WHEN NOT in_effect THEN 'NONE' WHEN st.state = 'PAYMENT_ACTIVE' THEN 'PAYMENT_ACTIVATED' ELSE 'PROVISIONED' END,
    'entitlement', ent,
    'capabilities', to_jsonb(CASE WHEN in_effect THEN hon.saas_plan_capabilities(ent->>'tier') ELSE ARRAY[]::text[] END),
    'paidAccessProgram', CASE WHEN hon.saas_access_program_active() THEN 'ACTIVE' ELSE 'INACTIVE' END);
END $$;

CREATE FUNCTION hon.saas_capability_allowed(p_org uuid, p_capability text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(p_capability = ANY(ARRAY(SELECT jsonb_array_elements_text(hon.saas_organization_access(p_org)->'capabilities'))), false)
$$;

CREATE FUNCTION hon.saas_awaiting_first_payment(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.saas_access_states WHERE organization_id = p_org AND state = 'AWAITING_FIRST_PAYMENT')
$$;

CREATE FUNCTION hon.read_saas_organization_access_from_hq(p_subject text, p_org uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = p_org) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.saas_organization_access(p_org) || jsonb_build_object(
    'transitions', (SELECT coalesce(jsonb_agg(jsonb_build_object('transitionId', t.id, 'kind', t.kind, 'outcome', t.outcome, 'reason', t.reason,
        'checkoutId', t.checkout_id, 'subscriptionId', t.subscription_id, 'allowanceId', t.allowance_id, 'providerEventId', t.provider_event_id,
        'priorEntitlement', t.prior_entitlement, 'nextEntitlement', t.next_entitlement, 'occurredAt', hon.saas_ts(t.occurred_at))
        ORDER BY t.occurred_at, t.id), '[]'::jsonb)
      FROM (SELECT * FROM hon.saas_access_transitions WHERE organization_id = p_org ORDER BY occurred_at DESC, id LIMIT 50) t),
    'asOf', hon.saas_ts(clock_timestamp()));
END $$;

-- ---------- awaiting first payment (HQ owner; only while the program is ACTIVE) ----------
CREATE FUNCTION hon.place_saas_organization_awaiting_payment(p_subject text, p_org uuid, p_input jsonb, p_key uuid, p_request_id uuid,
  p_correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; fp text; replay jsonb; ent hon.organization_entitlements%ROWTYPE; prior jsonb; nxt jsonb; at timestamptz := clock_timestamp();
  expected integer;
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
  IF EXISTS (SELECT 1 FROM hon.saas_access_states WHERE organization_id = p_org) THEN RAISE EXCEPTION 'SAAS_ACCESS_STATE_EXISTS' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_subscriptions WHERE organization_id = p_org AND status <> 'VOIDED') THEN
    RAISE EXCEPTION 'SAAS_SUBSCRIPTION_EXISTS' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id = p_org AND status IN ('CREATED','OPEN')) THEN
    RAISE EXCEPTION 'SAAS_CHECKOUT_OPEN' USING ERRCODE = '23514';
  END IF;
  prior := hon.saas_entitlement_json(p_org);
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

-- ---------- first-payment activation (inside the verified-payment transaction) ----------
CREATE FUNCTION hon.saas_apply_first_payment_access(p_checkout uuid, p_subscription uuid, p_evidence uuid, p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); c hon.saas_checkout_sessions%ROWTYPE; s hon.saas_subscriptions%ROWTYPE;
  st hon.saas_access_states%ROWTYPE; ent hon.organization_entitlements%ROWTYPE; f record; prior jsonb; nxt jsonb; v_allow uuid;
BEGIN
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout;
  SELECT * INTO s FROM hon.saas_subscriptions WHERE id = p_subscription FOR SHARE;
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = c.organization_id FOR UPDATE;
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = c.organization_id FOR UPDATE;
  -- Every fact is re-derived on the server: the checkout's frozen offer, the subscription it produced, and
  -- provider-verified evidence covering the invoice in full. Nothing from the browser is consulted.
  IF NOT hon.saas_access_program_active() THEN RAISE EXCEPTION 'SAAS_ACCESS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF st.state IS DISTINCT FROM 'AWAITING_FIRST_PAYMENT' OR ent.organization_id IS NULL THEN RAISE EXCEPTION 'SAAS_ACCESS_STATE_CHANGED' USING ERRCODE = '23514'; END IF;
  IF s.id IS NULL OR s.organization_id <> c.organization_id OR s.status <> 'IN_SERVICE' OR s.plan_code <> c.plan_code OR s.offer_id <> c.offer_id
    OR s.price_minor <> c.amount_minor OR c.status <> 'COMPLETED' OR c.subscription_id <> s.id OR s.plan_code NOT IN ('CORE','COMPLETE') THEN
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
  -- The period's full plan allowance (5,000 Core / 12,000 Complete, lifetime included), once: unique per period.
  IF hon.saas_credit_program_active() THEN v_allow := hon.saas_current_allowance(s.id, actor, p_at); END IF;
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, checkout_id, subscription_id, evidence_id, allowance_id,
      provider_event_id, prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
    VALUES (c.organization_id, 'FIRST_PAYMENT_ACTIVATION', 'APPLIED', 'FIRST_PAYMENT_VERIFIED', c.id, s.id, p_evidence, v_allow,
      p_event->>'eventId', prior, nxt, actor, p_at);
  RETURN jsonb_build_object('outcome', 'APPLIED', 'entitlement', nxt, 'allowanceId', v_allow);
END $$;

-- The activation step, isolated: a failure becomes a recorded HQ review, never a partial grant or a false success.
CREATE FUNCTION hon.saas_try_first_payment_access(p_checkout uuid, p_subscription uuid, p_evidence uuid, p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE c hon.saas_checkout_sessions%ROWTYPE; msg text;
BEGIN
  BEGIN
    RETURN hon.saas_apply_first_payment_access(p_checkout, p_subscription, p_evidence, p_event, p_at);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout;
    INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, checkout_id, subscription_id, evidence_id, provider_event_id,
        prior_entitlement, actor_principal_id, occurred_at)
      VALUES (c.organization_id, 'FIRST_PAYMENT_ACTIVATION', 'NEEDS_REVIEW',
        CASE WHEN msg ~ '^SAAS_[A-Z_]{3,55}$' THEN msg ELSE 'ACTIVATION_FAILED' END,
        c.id, p_subscription, p_evidence, p_event->>'eventId', hon.saas_entitlement_json(c.organization_id), hon.saas_payment_actor(), p_at);
    RETURN jsonb_build_object('outcome', 'NEEDS_REVIEW', 'reason', CASE WHEN msg ~ '^SAAS_[A-Z_]{3,55}$' THEN msg ELSE 'ACTIVATION_FAILED' END);
  END;
END $$;

-- ---------- B5 functions extended for B6A (same behavior when nothing is awaiting payment) ----------
CREATE OR REPLACE FUNCTION hon.guard_saas_payments() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE before_row jsonb; after_row jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE = '42501'; END IF;
  before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'saas_payment_program' THEN
    IF NEW.version = OLD.version + 1 AND NEW.status <> OLD.status
      AND (after_row - ARRAY['status','provider','test_tax_reference','authorization_reference','version','changed_by_principal_id','changed_at'])
        = (before_row - ARRAY['status','provider','test_tax_reference','authorization_reference','version','changed_by_principal_id','changed_at']) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'saas_checkout_sessions' THEN
    IF NEW.version = OLD.version + 1
      AND (after_row - ARRAY['status','status_reason','version','provider_session_id','checkout_url','provider_customer_ref','provider_subscription_ref',
          'subscription_id','invoice_id','updated_at','completed_at'])
        = (before_row - ARRAY['status','status_reason','version','provider_session_id','checkout_url','provider_customer_ref','provider_subscription_ref',
          'subscription_id','invoice_id','updated_at','completed_at'])
      AND (OLD.provider_session_id IS NULL OR NEW.provider_session_id = OLD.provider_session_id)
      AND (OLD.checkout_url IS NULL OR NEW.checkout_url = OLD.checkout_url)
      AND (OLD.subscription_id IS NULL OR NEW.subscription_id = OLD.subscription_id)
      AND (OLD.invoice_id IS NULL OR NEW.invoice_id = OLD.invoice_id)
      AND ((OLD.status = 'CREATED' AND NEW.status IN ('OPEN','COMPLETED','EXPIRED','CANCELLED','FAILED','PAID_NEEDS_REVIEW'))
        OR (OLD.status = 'OPEN' AND NEW.status IN ('COMPLETED','EXPIRED','CANCELLED','FAILED','PAID_NEEDS_REVIEW'))
        OR (OLD.status IN ('EXPIRED','CANCELLED','FAILED') AND NEW.status = 'PAID_NEEDS_REVIEW')
        -- B6A: a payment held only because paid access was inactive completes on an HQ-owner retry.
        OR (OLD.status = 'PAID_NEEDS_REVIEW' AND OLD.status_reason = 'ACCESS_PROGRAM_INACTIVE' AND NEW.status = 'COMPLETED')
        -- A provider-proven session id attached to a checkout whose adapter outcome was unknown.
        OR (OLD.status = 'CREATED' AND NEW.status = 'CREATED' AND OLD.provider_session_id IS NULL AND NEW.provider_session_id IS NOT NULL
          AND (after_row - ARRAY['provider_session_id','version','updated_at']) = (before_row - ARRAY['provider_session_id','version','updated_at']))) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

CREATE OR REPLACE FUNCTION hon.saas_open_checkout(p_actor uuid, p_org uuid, p_school uuid, p_offer uuid, p_kind text, p_at timestamptz) RETURNS hon.saas_checkout_sessions
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prog hon.saas_payment_program%ROWTYPE; ent hon.organization_entitlements%ROWTYPE; v_catalog hon.saas_catalog_versions%ROWTYPE;
  v_offer hon.saas_catalog_offers%ROWTYPE; v_pool text; stale record; res hon.saas_founder_reservations%ROWTYPE; inventory jsonb; v_expires timestamptz;
  created hon.saas_checkout_sessions%ROWTYPE; awaiting boolean;
BEGIN
  SELECT * INTO prog FROM hon.saas_payment_program WHERE program_id = 1 FOR SHARE;
  IF prog.status <> 'TEST_MODE' THEN RAISE EXCEPTION 'SAAS_PAYMENTS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || p_org::text, 0));
  LOCK TABLE hon.saas_catalog_versions IN SHARE MODE;
  PERFORM 1 FROM hon.organizations o WHERE o.id = p_org AND o.status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = p_org FOR SHARE;
  -- B6A: awaiting its first payment (only while paid access is ACTIVE), the entitlement is held suspended and the
  -- school chooses the plan it buys; otherwise the plan must match the active entitlement exactly as in B5.
  awaiting := hon.saas_access_program_active() AND hon.saas_awaiting_first_payment(p_org);
  IF NOT awaiting AND NOT FOUND OR NOT awaiting AND ent.status <> 'ACTIVE' OR ent.effective_from > p_at OR (ent.effective_until IS NOT NULL AND ent.effective_until <= p_at) THEN
    RAISE EXCEPTION 'SAAS_ENTITLEMENT_NOT_ACTIVE' USING ERRCODE = '23514';
  END IF;
  SELECT c.* INTO v_catalog FROM hon.saas_catalog_versions c WHERE c.status = 'PUBLISHED';
  SELECT o.* INTO v_offer FROM hon.saas_catalog_offers o WHERE o.id = p_offer AND o.catalog_id = v_catalog.id;
  IF v_catalog.id IS NULL OR v_offer.id IS NULL THEN RAISE EXCEPTION 'SAAS_OFFER_NOT_AVAILABLE' USING ERRCODE = '23514'; END IF;
  -- The plan must match the active entitlement: a payment never changes access, and plan changes stay undecided.
  IF NOT awaiting AND v_offer.plan_code <> ent.tier::text THEN RAISE EXCEPTION 'SAAS_ENTITLEMENT_MISMATCH' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_subscriptions s WHERE s.organization_id = p_org AND s.status <> 'VOIDED') THEN
    RAISE EXCEPTION 'SAAS_SUBSCRIPTION_EXISTS' USING ERRCODE = '23514';
  END IF;
  -- An abandoned checkout past its expiry no longer blocks a new one.
  FOR stale IN SELECT id FROM hon.saas_checkout_sessions WHERE organization_id = p_org AND status IN ('CREATED','OPEN') AND expires_at <= p_at FOR UPDATE LOOP
    PERFORM hon.saas_close_checkout(stale.id, 'EXPIRED', 'LOCAL_EXPIRED', p_actor, p_at);
  END LOOP;
  IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id = p_org AND status IN ('CREATED','OPEN')) THEN
    RAISE EXCEPTION 'SAAS_CHECKOUT_OPEN' USING ERRCODE = '23514';
  END IF;
  v_expires := p_at + interval '23 hours 59 minutes';
  IF v_offer.offer_kind LIKE 'FOUNDER_%' THEN
    v_pool := CASE WHEN v_offer.offer_kind = 'FOUNDER_LIFETIME' THEN 'LIFETIME' ELSE 'MONTHLY' END;
    IF p_at < v_catalog.founder_opens_at OR (v_catalog.founder_closes_at IS NOT NULL AND p_at >= v_catalog.founder_closes_at) THEN
      RAISE EXCEPTION 'SAAS_FOUNDER_WINDOW_CLOSED' USING ERRCODE = '23514';
    END IF;
    IF v_catalog.founder_eligibility = 'NO_PRIOR_CATALOG_SUBSCRIPTION' AND EXISTS (SELECT 1 FROM hon.saas_subscriptions s
        WHERE s.organization_id = p_org AND s.source = 'CATALOG_OFFER') THEN
      RAISE EXCEPTION 'SAAS_FOUNDER_NOT_ELIGIBLE' USING ERRCODE = '23514';
    END IF;
    FOR stale IN SELECT * FROM hon.saas_founder_reservations r WHERE r.organization_id = p_org AND r.status IN ('RESERVED','ALLOCATED') FOR UPDATE LOOP
      IF stale.status = 'RESERVED' AND stale.hold_expires_at <= p_at THEN
        UPDATE hon.saas_founder_reservations SET status = 'EXPIRED', status_reason = 'HOLD_EXPIRED', version = version + 1,
          decided_by_principal_id = p_actor, decided_at = p_at WHERE id = stale.id;
      ELSE
        RAISE EXCEPTION 'SAAS_FOUNDER_ALREADY_RESERVED' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    inventory := hon.saas_founder_inventory(p_at);
    IF coalesce((inventory#>>'{remaining,total}')::int, 0) < 1 OR coalesce((inventory#>>ARRAY['remaining', lower(v_pool)])::int, 0) < 1 THEN
      RAISE EXCEPTION 'SAAS_FOUNDER_SOLD_OUT' USING ERRCODE = '23514';
    END IF;
    v_expires := least(v_expires, p_at + make_interval(days => v_catalog.founder_hold_days));
    INSERT INTO hon.saas_founder_reservations(organization_id,catalog_id,offer_id,pool,status,status_reason,version,hold_expires_at,reserved_by_principal_id,reserved_at)
      VALUES (p_org,v_catalog.id,v_offer.id,v_pool,'RESERVED','RESERVED',1,v_expires,p_actor,p_at) RETURNING * INTO res;
  END IF;
  INSERT INTO hon.saas_checkout_sessions(organization_id,school_id,catalog_id,offer_id,plan_code,offer_kind,billing_interval,amount_minor,
      founder_reservation_id,requester_kind,requested_by_principal_id,provider,status,status_reason,expires_at,version,created_at,updated_at)
    VALUES (p_org,p_school,v_catalog.id,v_offer.id,v_offer.plan_code,v_offer.offer_kind,v_offer.billing_interval,v_offer.price_minor,
      res.id,p_kind,p_actor,prog.provider,'CREATED','CREATED',v_expires,1,p_at,p_at)
    RETURNING * INTO created;
  RETURN created;
END $$;

CREATE FUNCTION hon.saas_activate_checkout_core(p_checkout uuid, p_event jsonb, p_at timestamptz, p_retry boolean) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION hon.saas_activate_checkout(p_checkout uuid, p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
BEGIN
  RETURN hon.saas_activate_checkout_core(p_checkout, p_event, p_at, false);
END $$;

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
      WHERE c.status = 'PUBLISHED' AND (o.plan_code = ent.tier::text OR (awaiting AND o.plan_code IN ('CORE','COMPLETE')))
        AND (o.offer_kind NOT LIKE 'FOUNDER_%' OR (at >= c.founder_opens_at AND (c.founder_closes_at IS NULL OR at < c.founder_closes_at)))),
    'subscription', CASE WHEN sub.id IS NULL THEN NULL ELSE hon.saas_subscription_json(sub) - 'organizationName' END,
    'paymentVerification', CASE WHEN sub.id IS NULL THEN 'NONE' ELSE hon.saas_subscription_payment(sub)->>'paymentVerification' END,
    'checkout', CASE WHEN chk.id IS NULL THEN NULL ELSE hon.saas_checkout_json(chk) END,
    'annualBilling', 'UNAVAILABLE', 'planChanges', 'UNAVAILABLE', 'cardDataStored', false);
END $$;

CREATE OR REPLACE FUNCTION hon.read_saas_school_billing_account(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
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
    v_planned := (SELECT p.planned_monthly_premium_credits FROM hon.saas_catalog_plans p WHERE p.catalog_id = s.catalog_id AND p.plan_code = s.plan_code);
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

-- ---------- HQ recovery: retry an activation held for review (HQ owner; only while the program is ACTIVE) ----------
CREATE FUNCTION hon.retry_saas_first_payment_activation(p_subject text, p_checkout uuid, p_input jsonb, p_key uuid, p_request_id uuid,
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
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
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
    result := hon.saas_activate_checkout_core(c.id, evt, at, true);
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

-- ---------- staff scope resolvers: entitlement in effect (the six recorded B6A coverage gaps) ----------
-- These resolvers checked identity and permission but not the entitlement, so a SUSPENDED organization (which
-- includes one awaiting its first payment) still resolved them. Each now also requires the organization's
-- entitlement to be ACTIVE and in effect, the same test resolve_renewal_scope already applies. The check is
-- applied after each resolver's existing ambiguity rule, so for an organization in effect the result is exactly
-- what it was; signatures, volatility, SECURITY DEFINER, search path, owner and grants are unchanged.
CREATE OR REPLACE FUNCTION hon.resolve_achievement_scope(subject text,p_school uuid) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT DISTINCT p.id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND g.school_id=p_school AND EXISTS(SELECT 1 FROM unnest(ARRAY['achievement.definition.read','achievement.definition.manage','achievement.award.read','achievement.award.record']) code WHERE hon.achievement_permission(p.id,g.organization_id,g.school_id,code))
  AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=g.organization_id AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

CREATE OR REPLACE FUNCTION hon.resolve_follow_up_scope(subject text) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS(SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND hon.follow_up_has_permission(p.id,g.organization_id,g.school_id,'crm.lead.read')
 AND (hon.follow_up_has_permission(p.id,g.organization_id,g.school_id,'crm.follow_up.self_manage') OR hon.follow_up_has_permission(p.id,g.organization_id,g.school_id,'crm.follow_up.manage')))
 SELECT c.* FROM candidates c WHERE (SELECT count(*) FROM candidates)=1
  AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=c.organization_id AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

CREATE OR REPLACE FUNCTION hon.resolve_human_work_scope(subject text) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS(SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND (hon.human_work_permission(p.id,g.organization_id,g.school_id,'work_item.create') OR hon.human_work_permission(p.id,g.organization_id,g.school_id,'work_item.manage') OR hon.human_work_permission(p.id,g.organization_id,g.school_id,'work_item.self_manage')))
 SELECT c.* FROM candidates c WHERE (SELECT count(*) FROM candidates)=1
  AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=c.organization_id AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

CREATE OR REPLACE FUNCTION hon.resolve_teaching_studio_scope(subject text,p_school uuid) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT DISTINCT p.id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND g.school_id=p_school AND EXISTS(SELECT 1 FROM unnest(ARRAY['teaching.studio.read','teaching.lesson.manage','teaching.resource.manage','teaching.assessment.record']) code
  WHERE hon.teaching_studio_permission(p.id,g.organization_id,g.school_id,code))
  AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=g.organization_id AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

-- The caller requires exactly one scope. Every candidate must be in effect, so a suspended scope can neither be
-- returned nor be silently dropped to turn an ambiguous (refused) subject into a resolved one.
CREATE OR REPLACE FUNCTION hon.resolve_testing_registration_review_scopes(p_subject text)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH scopes AS(SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id
 FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
 JOIN hon.principal_role_grants g ON g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id AND (r.management_school_id IS NULL OR r.management_school_id=g.school_id)
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id AND rp.permission_code='testing.registration.review'
 JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id AND s.status='ACTIVE'
 JOIN hon.organizations o ON o.id=s.organization_id AND o.status='ACTIVE'
 WHERE u.external_subject=p_subject AND length(btrim(p_subject)) BETWEEN 1 AND 200
  AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
 ORDER BY g.organization_id,g.school_id LIMIT 2)
 SELECT s.* FROM scopes s WHERE NOT EXISTS(SELECT 1 FROM scopes x WHERE NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e
  WHERE e.organization_id=x.organization_id AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())))
 ORDER BY s.organization_id,s.school_id;
$$;

-- Same body as 0141 with the entitlement test on the single final candidate (statement time, as 0141 uses).
CREATE OR REPLACE FUNCTION hon.resolve_current_staff_reporting_scope(p_subject text)
RETURNS TABLE (organization_id uuid, school_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  WITH live_identity AS MATERIALIZED (
    SELECT principal.id AS principal_id
    FROM hon.users AS app_user
    JOIN hon.principals AS principal ON principal.user_id = app_user.id
    WHERE app_user.external_subject = p_subject
      AND principal.principal_type = 'HUMAN_USER' AND principal.is_active
      -- users has no separate activation flag; a live user is its unique active
      -- human principal. Reject any additional active principal, not just staff.
      AND (SELECT count(*) FROM hon.principals AS other
           WHERE other.user_id = app_user.id AND other.is_active) = 1
      -- Match 0077: any HQ grant excludes an ordinary-staff default, even expired.
      AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq
                      WHERE hq.principal_id = principal.id)
      AND NOT EXISTS (
        SELECT 1 FROM hon.family_access_grants AS family
        WHERE family.principal_id = principal.id AND family.effective_from <= statement_timestamp()
          AND (family.effective_until IS NULL OR family.effective_until > statement_timestamp())
      )
      -- A mixed role at ANY school is disqualifying, even without reporting.view.
      AND NOT EXISTS (
        SELECT 1 FROM hon.principal_role_grants AS mixed
        JOIN hon.roles AS mixed_role ON mixed_role.id = mixed.role_id
          AND mixed_role.organization_id = mixed.organization_id
        WHERE mixed.principal_id = principal.id AND mixed.revoked_at IS NULL
          AND mixed.effective_from <= statement_timestamp()
          AND (mixed.effective_until IS NULL OR mixed.effective_until > statement_timestamp())
          AND mixed_role.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
      )
  ), current_scopes AS MATERIALIZED (
    SELECT DISTINCT identity.principal_id, role_grant.organization_id, role_grant.school_id
    FROM live_identity AS identity
    JOIN hon.principal_role_grants AS role_grant ON role_grant.principal_id = identity.principal_id
    JOIN hon.roles AS role ON role.id = role_grant.role_id AND role.organization_id = role_grant.organization_id
    JOIN hon.schools AS school ON school.id = role_grant.school_id
      AND school.organization_id = role_grant.organization_id AND school.status = 'ACTIVE'
    JOIN hon.organizations AS organization ON organization.id = school.organization_id AND organization.status = 'ACTIVE'
    WHERE role_grant.revoked_at IS NULL AND role_grant.effective_from <= statement_timestamp()
      AND (role_grant.effective_until IS NULL OR role_grant.effective_until > statement_timestamp())
      AND (role.management_school_id IS NULL OR role.management_school_id = school.id)
      AND role.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
  ), candidates AS MATERIALIZED (
    SELECT scope.organization_id, scope.school_id
    FROM current_scopes AS scope
    -- Conservative exact-one live school, including a second non-reporting scope.
    WHERE (SELECT count(*) FROM current_scopes) = 1
      AND hon.staff_member_eligible(scope.principal_id, scope.organization_id, scope.school_id)
      AND EXISTS (
        SELECT 1 FROM hon.principal_role_grants AS role_grant
        JOIN hon.roles AS role ON role.id = role_grant.role_id AND role.organization_id = role_grant.organization_id
        JOIN hon.role_permissions AS role_permission ON role_permission.role_id = role.id
          AND role_permission.organization_id = role.organization_id
        JOIN hon.permissions AS permission ON permission.code = role_permission.permission_code
        WHERE role_grant.principal_id = scope.principal_id
          AND role_grant.organization_id = scope.organization_id AND role_grant.school_id = scope.school_id
          AND role_grant.revoked_at IS NULL AND role_grant.effective_from <= statement_timestamp()
          AND (role_grant.effective_until IS NULL OR role_grant.effective_until > statement_timestamp())
          AND (role.management_school_id IS NULL OR role.management_school_id = scope.school_id)
          AND role.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
          AND permission.code = 'reporting.view' AND permission.is_staff_assignable
      )
  )
  SELECT candidates.organization_id, candidates.school_id FROM candidates
  WHERE (SELECT count(*) FROM candidates) = 1
    AND EXISTS (SELECT 1 FROM hon.organization_entitlements AS entitlement
                WHERE entitlement.organization_id = candidates.organization_id AND entitlement.status = 'ACTIVE'
                  AND entitlement.effective_from <= statement_timestamp()
                  AND (entitlement.effective_until IS NULL OR entitlement.effective_until > statement_timestamp()));
$$;

COMMENT ON FUNCTION hon.saas_organization_access(uuid) IS
  'Central access authority: the canonical entitlement plus how it was obtained (provisioned, awaiting first payment, payment-activated) and its plan capabilities.';
COMMENT ON FUNCTION hon.place_saas_organization_awaiting_payment(text,uuid,jsonb,uuid,uuid,uuid) IS
  'HQ owner places an organization awaiting its first payment. Refused unless the paid-access program is ACTIVE (it can only be INACTIVE today).';

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_access_states','saas_access_transitions'] LOOP
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
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_catalog_from_hq(text), hon.create_saas_catalog_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_saas_catalog(text,uuid,uuid,uuid,uuid), hon.read_saas_founder_reservations_from_hq(text,text),
      hon.reserve_saas_founder_offer(text,jsonb,uuid,uuid,uuid), hon.release_saas_founder_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_subscriptions_from_hq(text,text), hon.read_saas_organization_subscription_from_hq(text,uuid),
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_invoices_from_hq(text,text), hon.read_saas_invoice_from_hq(text,uuid), hon.read_saas_payment_standing_from_hq(text,uuid),
      hon.create_saas_invoice_draft(text,jsonb,uuid,uuid,uuid), hon.command_saas_invoice(text,uuid,jsonb,uuid,uuid,uuid),
      hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_credit_program_from_hq(text), hon.read_saas_organization_credits_from_hq(text,uuid),
      hon.set_saas_credit_program(text,jsonb,uuid,uuid,uuid), hon.record_saas_provider_cost_evidence(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_pricing_draft(text,jsonb,uuid,uuid,uuid), hon.publish_saas_pricing(text,uuid,uuid,uuid,uuid),
      hon.command_saas_credit_allowance(text,jsonb,uuid,uuid,uuid), hon.read_saas_school_credits(text,uuid),
      hon.estimate_saas_premium_operation(text,uuid,text,integer), hon.reserve_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid),
      hon.settle_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_credit_reservation(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_refund_eligibility_from_hq(text,uuid,timestamptz), hon.read_saas_refund_requests_from_hq(text,text),
      hon.read_saas_refund_reserve_from_hq(text), hon.create_saas_refund_request(text,jsonb,uuid,uuid,uuid),
      hon.decide_saas_refund_request(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_reward_preview_from_hq(text,uuid),
      hon.read_saas_referral_alerts_from_hq(text,text), hon.set_saas_reward_fulfillment(text,jsonb,uuid,uuid,uuid),
      hon.apply_saas_referral_reward(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_credit_application_preview(text,uuid),
      hon.apply_saas_account_credit(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_referral_alert(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_payments_from_hq(text), hon.read_saas_school_plan_options(text,uuid), hon.set_saas_payment_program(text,jsonb,uuid,uuid,uuid),
      hon.create_saas_checkout_from_school(text,uuid,jsonb,uuid,uuid,uuid), hon.create_saas_checkout_from_hq(text,jsonb,uuid,uuid,uuid),
      hon.attach_saas_checkout_session(text,uuid,jsonb,uuid,uuid,uuid), hon.cancel_saas_checkout(text,uuid,jsonb,uuid,uuid,uuid),
      hon.sweep_saas_checkouts(text,uuid,uuid,uuid), hon.ingest_saas_provider_event(jsonb,text),
      hon.read_saas_school_invoices(text,uuid,text,text,timestamptz,uuid,integer), hon.read_saas_school_invoice(text,uuid,uuid),
      hon.read_saas_school_billing_account(text,uuid), hon.read_saas_access_readiness_from_hq(text,uuid),
      hon.read_saas_organization_access_from_hq(text,uuid), hon.place_saas_organization_awaiting_payment(text,uuid,jsonb,uuid,uuid,uuid),
      hon.retry_saas_first_payment_activation(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
