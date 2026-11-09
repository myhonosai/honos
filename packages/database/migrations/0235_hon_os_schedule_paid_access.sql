BEGIN;

-- HON OS schedule billing, piece 2 of 5 (owner checklist 2026-11-09): access after the first verified schedule payment.
--   * Replaces the 0230 stub hon.saas_schedule_after_paid_period. Billing and access stay separate outcomes (owner answer 3):
--     the payment, paid period and binding ACTIVE are already final when this runs; every access refusal is recorded as an
--     HQ access review and never raises, and an unexpected error inside the activation is rolled back to its own
--     savepoint and recorded the same way.
--   * One access authority: organization_entitlements (B6A). The first qualifying period of an organization AWAITING its first
--     payment makes the entitlement COMPLETE ACTIVE for the paid period plus the owner-approved 7-day grace (owner answer 6);
--     access state PAYMENT_ACTIVE with source SCHEDULE_BINDING. Later periods extend the window; nothing ever shortens it.
--     After the window, access lapses by time with no job (fail closed).
--   * Paid-access program stays INACTIVE (0170 CHECK): until a separately owner-approved migration flips it, every first
--     payment lands in HQ access review (ACCESS_PROGRAM_INACTIVE). HQ-owner retry re-runs activation on the latest period.
--   * No AI or creative credits are granted here (AI team included; creative wallet is separate and INACTIVE).
--   * The v1 checkout activation path (0172) is unchanged: its rows keep checkout/subscription and a NULL source.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS schedule paid access requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS schedule paid access requires a restricted runtime';
  END IF;
END $$;

-- ---------- access state: a second, schedule-backed activation source ----------
ALTER TABLE hon.saas_access_states
  ADD COLUMN activation_source text CHECK (activation_source='SCHEDULE_BINDING'),
  ADD COLUMN binding_id uuid REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  ADD COLUMN first_paid_period_id uuid REFERENCES hon.saas_schedule_paid_periods(id) ON DELETE RESTRICT,
  ADD COLUMN paid_through timestamptz;
-- Replace 0172's two v1-only CHECKs (located by definition; 0172 itself stays byte-identical).
DO $$ DECLARE c record; n integer:=0; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='hon.saas_access_states'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%PAYMENT_ACTIVE%' AND pg_get_constraintdef(oid) NOT LIKE '%AWAITING_FIRST_PAYMENT%' LOOP
    EXECUTE format('ALTER TABLE hon.saas_access_states DROP CONSTRAINT %I',c.conname); n:=n+1;
  END LOOP;
  IF n<>2 THEN RAISE EXCEPTION 'unexpected 0172 access-state constraints: %',n; END IF;
END $$;
ALTER TABLE hon.saas_access_states ADD CONSTRAINT saas_access_states_reason_by_state CHECK ((state='PAYMENT_ACTIVE')=(reason='FIRST_PAYMENT_VERIFIED'));
-- Awaiting: no source at all. Active: exactly one source shape, v1 checkout (legacy, NULL source) or schedule binding.
ALTER TABLE hon.saas_access_states ADD CONSTRAINT saas_access_states_source_shape CHECK (
  (state='AWAITING_FIRST_PAYMENT' AND checkout_id IS NULL AND subscription_id IS NULL AND activation_source IS NULL AND binding_id IS NULL
    AND first_paid_period_id IS NULL AND paid_through IS NULL)
  OR (state='PAYMENT_ACTIVE' AND activation_source IS NULL AND checkout_id IS NOT NULL AND subscription_id IS NOT NULL AND binding_id IS NULL
    AND first_paid_period_id IS NULL AND paid_through IS NULL)
  OR (state='PAYMENT_ACTIVE' AND activation_source='SCHEDULE_BINDING' AND checkout_id IS NULL AND subscription_id IS NULL
    AND binding_id IS NOT NULL AND first_paid_period_id IS NOT NULL AND paid_through IS NOT NULL));

-- Two allowed changes: awaiting -> payment active (either source), and a schedule-backed extension that only moves
-- paid_through forward on the same binding. One version step; identity and creation never change; no delete.
CREATE OR REPLACE FUNCTION hon.guard_saas_access() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND NEW.organization_id = OLD.organization_id AND NEW.created_at = OLD.created_at THEN
    IF OLD.state = 'AWAITING_FIRST_PAYMENT' AND NEW.state = 'PAYMENT_ACTIVE' THEN RETURN NEW; END IF;
    IF OLD.state = 'PAYMENT_ACTIVE' AND NEW.state = 'PAYMENT_ACTIVE' AND OLD.activation_source = 'SCHEDULE_BINDING'
      AND NEW.paid_through > OLD.paid_through
      AND (to_jsonb(NEW) - ARRAY['paid_through','version','changed_by_principal_id','updated_at'])
        = (to_jsonb(OLD) - ARRAY['paid_through','version','changed_by_principal_id','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE = '42501';
END $$;

-- ---------- access transitions: schedule activation and extension evidence ----------
ALTER TABLE hon.saas_access_transitions
  ADD COLUMN binding_id uuid REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  ADD COLUMN paid_period_id uuid REFERENCES hon.saas_schedule_paid_periods(id) ON DELETE RESTRICT;
ALTER TABLE hon.saas_access_transitions DROP CONSTRAINT saas_access_transitions_kind_check;
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_kind_check
  CHECK (kind IN ('AWAITING_FIRST_PAYMENT','FIRST_PAYMENT_ACTIVATION','PAST_DUE_SUSPENSION','SCHEDULE_FIRST_PAYMENT_ACTIVATION','SCHEDULE_RENEWAL_EXTENSION'));
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_schedule_check CHECK (
  (kind IN ('SCHEDULE_FIRST_PAYMENT_ACTIVATION','SCHEDULE_RENEWAL_EXTENSION')) = (binding_id IS NOT NULL AND paid_period_id IS NOT NULL));
-- One applied activation per organization and per binding; each paid period applies to access at most once.
CREATE UNIQUE INDEX saas_access_one_schedule_activation_per_org ON hon.saas_access_transitions (organization_id)
  WHERE kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION' AND outcome = 'APPLIED';
CREATE UNIQUE INDEX saas_access_one_schedule_activation_per_binding ON hon.saas_access_transitions (binding_id)
  WHERE kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION' AND outcome = 'APPLIED';
CREATE UNIQUE INDEX saas_access_one_applied_per_paid_period ON hon.saas_access_transitions (paid_period_id)
  WHERE outcome = 'APPLIED' AND paid_period_id IS NOT NULL;

-- ---------- helpers ----------
-- Owner answer 6 (2026-11-09): full access for 7 days after the paid period while a renewal is outstanding.
CREATE FUNCTION hon.saas_schedule_access_grace() RETURNS interval
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$ SELECT interval '7 days' $$;

-- Access outcome of a binding, for reads: the applied activation if any, else the latest review, else not attempted.
CREATE FUNCTION hon.saas_schedule_access_json(p_binding uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE
    WHEN applied.id IS NOT NULL THEN jsonb_build_object('accessActivation','APPLIED','reason',NULL,
      'paidThrough',hon.saas_ts(st.paid_through),'accessUntil',hon.saas_ts(st.paid_through + hon.saas_schedule_access_grace()))
    WHEN review.id IS NOT NULL THEN jsonb_build_object('accessActivation','NEEDS_REVIEW','reason',review.reason,'paidThrough',NULL,'accessUntil',NULL)
    ELSE jsonb_build_object('accessActivation','NOT_ATTEMPTED','reason',NULL,'paidThrough',NULL,'accessUntil',NULL) END
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT t.id FROM hon.saas_access_transitions t WHERE t.binding_id = p_binding
    AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION' AND t.outcome = 'APPLIED' LIMIT 1) applied ON true
  LEFT JOIN LATERAL (SELECT t.id, t.reason FROM hon.saas_access_transitions t WHERE t.binding_id = p_binding
    AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION' AND t.outcome = 'NEEDS_REVIEW' ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1) review ON true
  LEFT JOIN hon.saas_access_states st ON st.binding_id = p_binding
$$;

-- First activation from one paid period. Internal; the caller holds the organization lock and the binding row lock.
-- Returns a review reason instead of raising for every business refusal; effects run inside their own savepoint.
CREATE FUNCTION hon.saas_schedule_activate_access(p_binding uuid, p_period uuid, p_at timestamptz) RETURNS jsonb
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
    -- Founder pricing activates only once founder allocation exists (piece 4); 0189 refuses founder generations today.
    WHEN EXISTS (SELECT 1 FROM hon.saas_offer_set_offers o WHERE o.id::text = b.requirements->>'offerId' AND o.offer_kind LIKE 'FOUNDER%') THEN 'FOUNDER_UNAVAILABLE'
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

-- ---------- the 0230 seam, now real ----------
-- Called by ingest for every newly recorded qualifying paid period, after the binding's billing outcome is final.
CREATE OR REPLACE FUNCTION hon.saas_schedule_after_paid_period(p_binding uuid, p_period uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); b hon.saas_schedule_bindings%ROWTYPE; per hon.saas_schedule_paid_periods%ROWTYPE;
  ent hon.organization_entitlements%ROWTYPE; st hon.saas_access_states%ROWTYPE; prior jsonb; nxt jsonb; new_until timestamptz;
BEGIN
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id = p_binding;
  SELECT * INTO per FROM hon.saas_schedule_paid_periods WHERE id = p_period AND binding_id = p_binding;
  IF b.id IS NULL OR per.id IS NULL THEN RAISE EXCEPTION 'SAAS_ACCESS_HOOK_INPUT'; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.saas_access_transitions t WHERE t.binding_id = b.id AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION'
      AND t.outcome = 'APPLIED') THEN
    -- An open access review waits for the HQ-owner retry, which uses the latest period; later payments still count.
    IF EXISTS (SELECT 1 FROM hon.saas_access_transitions t WHERE t.binding_id = b.id AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION'
        AND t.outcome = 'NEEDS_REVIEW') THEN
      RETURN jsonb_build_object('accessActivation','NEEDS_REVIEW','accessGranted',false,'reason','ACTIVATION_PENDING');
    END IF;
    RETURN hon.saas_schedule_activate_access(b.id, per.id, p_at);
  END IF;
  -- Renewal: extend the same binding's access window forward; a late earlier period never shortens it.
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = b.organization_id FOR UPDATE;
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = b.organization_id FOR UPDATE;
  IF st.state IS DISTINCT FROM 'PAYMENT_ACTIVE' OR st.binding_id IS DISTINCT FROM b.id OR ent.organization_id IS NULL OR ent.status <> 'ACTIVE' THEN
    -- The payment stands; HQ reviews why this organization's access no longer follows the binding.
    INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
        prior_entitlement, actor_principal_id, occurred_at)
      VALUES (b.organization_id, 'SCHEDULE_RENEWAL_EXTENSION', 'NEEDS_REVIEW', 'ACCESS_STATE_NOT_ELIGIBLE', b.id, per.id, per.provider_event_id,
        hon.saas_entitlement_json(b.organization_id), actor, p_at);
    RETURN jsonb_build_object('accessActivation','NEEDS_REVIEW','accessGranted',false,'reason','ACCESS_STATE_NOT_ELIGIBLE');
  END IF;
  IF per.covered_ends_at <= st.paid_through THEN
    RETURN jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false,'reason','ALREADY_COVERED');
  END IF;
  -- Paid periods are contiguous; a period that starts after the current window has lapsed is reviewed, never bridged.
  IF per.covered_starts_at > st.paid_through + hon.saas_schedule_access_grace() THEN
    INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
        prior_entitlement, actor_principal_id, occurred_at)
      VALUES (b.organization_id, 'SCHEDULE_RENEWAL_EXTENSION', 'NEEDS_REVIEW', 'PAID_PERIOD_GAP', b.id, per.id, per.provider_event_id,
        hon.saas_entitlement_json(b.organization_id), actor, p_at);
    RETURN jsonb_build_object('accessActivation','NEEDS_REVIEW','accessGranted',false,'reason','PAID_PERIOD_GAP');
  END IF;
  prior := hon.saas_entitlement_json(b.organization_id);
  new_until := greatest(coalesce(ent.effective_until, '-infinity'::timestamptz), per.covered_ends_at + hon.saas_schedule_access_grace());
  UPDATE hon.organization_entitlements SET effective_until = new_until, version = version + 1, updated_at = p_at
    WHERE organization_id = b.organization_id AND version = ent.version;
  nxt := hon.saas_entitlement_json(b.organization_id);
  UPDATE hon.saas_access_states SET paid_through = per.covered_ends_at, version = version + 1, changed_by_principal_id = actor, updated_at = p_at
    WHERE organization_id = b.organization_id AND version = st.version;
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
      prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
    VALUES (b.organization_id, 'SCHEDULE_RENEWAL_EXTENSION', 'APPLIED', 'RENEWAL_PAYMENT_VERIFIED', b.id, per.id, per.provider_event_id,
      prior, nxt, actor, p_at);
  RETURN jsonb_build_object('accessActivation','EXTENDED','accessGranted',true);
END $$;

-- ---------- HQ-owner access retry (the only fix for an access review) ----------
CREATE FUNCTION hon.retry_saas_schedule_access(p_subject text, p_binding uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; org uuid; b hon.saas_schedule_bindings%ROWTYPE; latest uuid; result jsonb; at timestamptz := clock_timestamp();
  expected integer; later uuid;
BEGIN
  IF p_binding IS NULL OR NOT hon.saas_trial_keys(p, ARRAY['expectedBindingVersion'])
    OR jsonb_typeof(p->'expectedBindingVersion') <> 'number' OR (p->>'expectedBindingVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  expected := (p->>'expectedBindingVersion')::integer;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.access.retry',
    hon.saas_fingerprint(ARRAY['access.retry.schedule', p_binding::text, expected::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT hon.saas_access_program_active() THEN RAISE EXCEPTION 'SAAS_ACCESS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  SELECT organization_id INTO org FROM hon.saas_schedule_bindings WHERE id = p_binding;
  IF org IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || org::text, 0));
  -- Authority is rechecked after the wait; a revoked HQ owner fails closed.
  actor := hon.require_saas_hq_actor(p_subject, true);
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id = p_binding FOR UPDATE;
  IF b.version <> expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF b.status <> 'ACTIVE'
    OR NOT EXISTS (SELECT 1 FROM hon.saas_access_transitions t WHERE t.binding_id = b.id AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION' AND t.outcome = 'NEEDS_REVIEW')
    OR EXISTS (SELECT 1 FROM hon.saas_access_transitions t WHERE t.binding_id = b.id AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION' AND t.outcome = 'APPLIED') THEN
    RAISE EXCEPTION 'SAAS_ACCESS_NOT_RETRYABLE' USING ERRCODE = '23514';
  END IF;
  -- A refund or dispute reported on this binding is never activated (piece 3 resolves those).
  IF EXISTS (SELECT 1 FROM hon.saas_schedule_provider_events e WHERE e.binding_id = b.id AND e.event_type IN ('charge.refunded','charge.dispute.created')) THEN
    RAISE EXCEPTION 'SAAS_ACCESS_PAYMENT_REVERSED' USING ERRCODE = '23514';
  END IF;
  -- The latest period that has started activates; renewals paid in advance while waiting are then applied in order.
  SELECT id INTO latest FROM hon.saas_schedule_paid_periods WHERE binding_id = b.id
    ORDER BY (covered_starts_at <= at + interval '5 minutes') DESC, covered_ends_at DESC, id DESC LIMIT 1;
  result := hon.saas_schedule_activate_access(b.id, latest, at);
  IF result->>'accessActivation' = 'APPLIED' THEN
    FOR later IN SELECT q.id FROM hon.saas_schedule_paid_periods q JOIN hon.saas_access_states s ON s.binding_id = b.id
        WHERE q.binding_id = b.id AND q.covered_ends_at > s.paid_through ORDER BY q.covered_ends_at, q.id LOOP
      PERFORM hon.saas_schedule_after_paid_period(b.id, later, at);
    END LOOP;
  END IF;
  RETURN hon.saas_record(actor, p_key, 'saas.access.retry', 'saas.access.retried', 'ACCESS_STATE', b.organization_id, b.organization_id, NULL,
    jsonb_build_object('outcome', result->>'accessActivation', 'detail', coalesce(result->>'reason', 'ACCESS_ACTIVATED'), 'bindingId', b.id),
    jsonb_build_object('bindingId', b.id, 'access', hon.saas_schedule_access_json(b.id) || jsonb_build_object('accessGranted', (result->>'accessGranted')::boolean)),
    at);
END $$;

-- ---------- reads: billing and access reported separately ----------
CREATE OR REPLACE FUNCTION hon.read_saas_schedule_binding(p_subject text,p_school uuid,p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; b hon.saas_schedule_bindings%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding AND organization_id=actor.organization_id AND school_id=p_school;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN hon.saas_schedule_binding_json(b) || jsonb_build_object('access',hon.saas_schedule_access_json(b.id));
END $$;
CREATE OR REPLACE FUNCTION hon.read_saas_schedule_binding_from_hq(p_subject text,p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false); SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN hon.saas_schedule_binding_json(b) || jsonb_build_object('access',hon.saas_schedule_access_json(b.id));
END $$;

-- ---------- grants ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.saas_schedule_access_grace()','hon.saas_schedule_access_json(uuid)',
    'hon.saas_schedule_activate_access(uuid,uuid,timestamp with time zone)',
    'hon.saas_schedule_after_paid_period(uuid,uuid,timestamp with time zone)','hon.guard_saas_access()',
    'hon.retry_saas_schedule_access(text,uuid,jsonb,uuid,uuid,uuid)',
    'hon.read_saas_schedule_binding(text,uuid,uuid)','hon.read_saas_schedule_binding_from_hq(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.retry_saas_schedule_access(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_schedule_binding(text,uuid,uuid),hon.read_saas_schedule_binding_from_hq(text,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
