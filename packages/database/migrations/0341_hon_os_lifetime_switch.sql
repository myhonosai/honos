BEGIN;

-- 0341: a school on a monthly or annual HON OS plan switches straight to lifetime, with credit (owner D3/D3a, 2026-11-12).
--   * TEST provider only. HON never sends a refund: the unused paid days of the current period are credited off the
--     lifetime price, lifetime starts at once, and the old plan's schedule is stopped with no proration and no refund.
--   * Credit (fixed at sign-up, stored on an immutable switch record): what the school paid for its current period, times
--     the whole unused days of that period over its whole days, rounded down to the cent, and never the whole lifetime
--     price (at least $1.00 is always charged). Whole days keep a quote stable for the rest of the UTC day.
--   * Sign-up opens a second, lifetime binding marked as a switch from the live plan (one live switch per organization).
--     The old plan keeps running, and keeps the school's access, until the switch is paid.
--   * A verified payment of exactly the lifetime price minus the credit, while the old plan is still ACTIVE, still on the
--     same paid period and still holds the school's access, does all of this in one ingest transaction under the
--     organization lock: the lifetime binding becomes ACTIVE and its sale is counted (sale limit, D1); access moves to it
--     with no end; the old binding moves to the new terminal status SWITCHED_TO_LIFETIME. If any of it cannot be recorded
--     the whole delivery fails and the provider retries it (never half-switched).
--   * Anything else is held for HQ review and access stays on the old plan: a wrong amount, an old-plan renewal or
--     suspension that lands first, a payment after the period ended, or a sale limit reached first.
--   * A refund of the switch payment inside the window ends lifetime access (0309, D2); the old plan does not come back.
--   * Unused welcome credit (0325) is not added to the switch credit; it stays recorded on the old plan, unapplied.
--   * The paid-access program stays INACTIVE. No checkout, live payment, refund or cash payout is enabled.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS lifetime switch requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS lifetime switch requires a restricted runtime';
  END IF;
END $$;

-- ---------- binding: the switch link, one new terminal status and two reasons ----------
ALTER TABLE hon.saas_schedule_bindings ADD COLUMN switch_from_binding_id uuid REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT;
ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_switch_lifetime CHECK (switch_from_binding_id IS NULL
  OR (switch_from_binding_id <> id AND requirements->>'billingInterval' = 'ONE_TIME'));
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_schedule_bindings'::regclass AND conname='saas_schedule_bindings_status_check';
  IF def IS NULL OR position('REFUNDED_ENDED' IN def)=0 OR position('SWITCHED_TO_LIFETIME' IN def)>0 THEN RAISE EXCEPTION 'saas_schedule_bindings status constraint drifted'; END IF;
  ALTER TABLE hon.saas_schedule_bindings DROP CONSTRAINT saas_schedule_bindings_status_check;
  ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_status_check CHECK (status IN ('PENDING_PROVIDER_BINDING',
    'BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED','SWITCHED_TO_LIFETIME'));
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_schedule_bindings'::regclass AND conname='saas_schedule_bindings_status_reason_check';
  IF def IS NULL OR position('LIFETIME_REFUND_IN_WINDOW' IN def)=0 THEN RAISE EXCEPTION 'saas_schedule_bindings status_reason constraint drifted'; END IF;
  ALTER TABLE hon.saas_schedule_bindings DROP CONSTRAINT saas_schedule_bindings_status_reason_check;
  ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_status_reason_check CHECK (status_reason IN ('BINDING_REQUESTED',
    'BINDING_OBSERVED_TEST_ONLY','FIRST_PAYMENT_VERIFIED','PROVIDER_CONFIRMED_NOT_CREATED','PROVIDER_TERMS_MISMATCH','UNPAID_WINDOW_ELAPSED',
    'AMOUNT_MISMATCH','OVERLAPPING_COVERED_PERIOD','REVERSAL_REVIEW_REQUIRED','UNLINKED_REVERSAL','PURCHASER_CANCELLED_BEFORE_PAYMENT',
    'PERIOD_INTERVAL_MISMATCH','REVIEW_REFUND_VERIFIED','FOUNDER_SPOT_UNAVAILABLE','LIFETIME_SALE_LIMIT_REACHED','LIFETIME_REFUND_IN_WINDOW',
    'SWITCHED_TO_LIFETIME','LIFETIME_SWITCH_SOURCE_CHANGED'));
END $$;
ALTER TABLE hon.saas_schedule_bindings DROP CONSTRAINT saas_schedule_bindings_terminal_at;
ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_terminal_at CHECK (
  (status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED','SWITCHED_TO_LIFETIME')) = (terminal_at IS NOT NULL));
-- A switched plan was a bound, paid, active recurring plan.
ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_switched CHECK (status <> 'SWITCHED_TO_LIFETIME'
  OR (bound_at IS NOT NULL AND activated_at IS NOT NULL AND status_reason = 'SWITCHED_TO_LIFETIME'
    AND requirements->>'billingInterval' IN ('MONTHLY','ANNUAL') AND switch_from_binding_id IS NULL));
-- Still one live plan per organization (0230), plus at most one live switch beside it while the switch is unpaid.
DROP INDEX hon.saas_schedule_binding_one_live_per_organization;
CREATE UNIQUE INDEX saas_schedule_binding_one_live_per_organization ON hon.saas_schedule_bindings(organization_id)
  WHERE status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW') AND switch_from_binding_id IS NULL;
CREATE UNIQUE INDEX saas_schedule_binding_one_live_switch_per_organization ON hon.saas_schedule_bindings(organization_id)
  WHERE status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','NEEDS_REVIEW') AND switch_from_binding_id IS NOT NULL;
-- An old plan is switched once.
CREATE UNIQUE INDEX saas_schedule_binding_one_paid_switch_per_source ON hon.saas_schedule_bindings(switch_from_binding_id)
  WHERE status IN ('ACTIVE','REFUNDED_ENDED') AND switch_from_binding_id IS NOT NULL;

-- ---------- one immutable record per switch sign-up ----------
CREATE TABLE hon.saas_lifetime_switches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL REFERENCES hon.schools(id) ON DELETE RESTRICT,
  from_binding_id uuid NOT NULL REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  to_binding_id uuid NOT NULL UNIQUE REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  from_paid_period_id uuid NOT NULL REFERENCES hon.saas_schedule_paid_periods(id) ON DELETE RESTRICT,
  from_period_starts_at timestamptz NOT NULL,
  from_period_ends_at timestamptz NOT NULL,
  from_period_paid_minor integer NOT NULL CHECK (from_period_paid_minor BETWEEN 0 AND 10000000),
  unused_days integer NOT NULL CHECK (unused_days >= 0),
  period_days integer NOT NULL CHECK (period_days BETWEEN 1 AND 400),
  lifetime_price_minor integer NOT NULL CHECK (lifetime_price_minor BETWEEN 100 AND 10000000),
  credit_minor integer NOT NULL CHECK (credit_minor >= 0),
  amount_due_minor integer NOT NULL CHECK (amount_due_minor >= 100),
  provider_credit_key uuid NOT NULL UNIQUE,
  quoted_at timestamptz NOT NULL,
  CHECK (from_period_ends_at > from_period_starts_at AND unused_days <= period_days),
  CHECK (credit_minor = (from_period_paid_minor::bigint * unused_days / period_days)::integer OR credit_minor = lifetime_price_minor - 100),
  CHECK (amount_due_minor = lifetime_price_minor - credit_minor)
);
ALTER TABLE hon.saas_lifetime_switches ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hon.saas_lifetime_switches FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON hon.saas_lifetime_switches FROM %I',r);
  END LOOP;
END $$;
CREATE TRIGGER saas_immutable BEFORE DELETE OR UPDATE ON hon.saas_lifetime_switches FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_lifetime_switches FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence();

-- ---------- access: the switch move ----------
ALTER TABLE hon.saas_access_transitions DROP CONSTRAINT saas_access_transitions_kind_check;
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_kind_check CHECK (kind IN ('AWAITING_FIRST_PAYMENT',
  'FIRST_PAYMENT_ACTIVATION','PAST_DUE_SUSPENSION','SCHEDULE_FIRST_PAYMENT_ACTIVATION','SCHEDULE_RENEWAL_EXTENSION','SCHEDULE_REFUND_ENDED',
  'SCHEDULE_ACCESS_RESTORED','SCHEDULE_LIFETIME_SWITCH'));
ALTER TABLE hon.saas_access_transitions DROP CONSTRAINT saas_access_transitions_schedule_check;
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_schedule_check CHECK (
  CASE WHEN kind IN ('SCHEDULE_FIRST_PAYMENT_ACTIVATION','SCHEDULE_RENEWAL_EXTENSION','SCHEDULE_REFUND_ENDED','SCHEDULE_ACCESS_RESTORED','SCHEDULE_LIFETIME_SWITCH')
    THEN binding_id IS NOT NULL AND paid_period_id IS NOT NULL
    WHEN kind = 'PAST_DUE_SUSPENSION' THEN (binding_id IS NULL) = (paid_period_id IS NULL)
    ELSE binding_id IS NULL AND paid_period_id IS NULL END);
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_lifetime_switch CHECK (kind <> 'SCHEDULE_LIFETIME_SWITCH'
  OR (outcome = 'APPLIED' AND reason = 'LIFETIME_SWITCH_PAID' AND provider_event_id IS NOT NULL));
CREATE UNIQUE INDEX saas_access_one_lifetime_switch_per_binding ON hon.saas_access_transitions (binding_id) WHERE kind = 'SCHEDULE_LIFETIME_SWITCH';

-- ---------- credit ----------
-- Whole unused days of the period at p_at over its whole days, of what was paid for it, rounded down to the cent; never
-- more than the lifetime price less $1.00.
CREATE FUNCTION hon.saas_lifetime_switch_credit(p_paid integer, p_starts timestamptz, p_ends timestamptz, p_at timestamptz, p_price integer,
  OUT unused_days integer, OUT period_days integer, OUT credit_minor integer)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT u, d, least((p_paid::bigint * u / d)::integer, p_price - 100)
  FROM (SELECT greatest(1, round(extract(epoch FROM p_ends - p_starts) / 86400))::integer d,
    greatest(0, floor(extract(epoch FROM p_ends - p_at) / 86400))::integer u0) x
  CROSS JOIN LATERAL (SELECT least(x.u0, x.d) u) y
$$;

-- The live recurring plan a school may switch from now, its current paid period, or why it cannot switch.
-- Read-only; never a reservation. The caller holds the organization lock when the answer is used to write.
CREATE FUNCTION hon.saas_lifetime_switch_source(p_org uuid, p_at timestamptz, OUT refusal text, OUT binding_id uuid, OUT period_id uuid)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; q hon.saas_schedule_paid_periods%ROWTYPE; st hon.saas_access_states%ROWTYPE;
  ent hon.organization_entitlements%ROWTYPE;
BEGIN
  SELECT * INTO b FROM hon.saas_schedule_bindings x WHERE x.organization_id=p_org AND x.switch_from_binding_id IS NULL
    AND x.status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW');
  SELECT * INTO st FROM hon.saas_access_states s WHERE s.organization_id=p_org;
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id=p_org;
  SELECT * INTO q FROM hon.saas_schedule_paid_periods p WHERE p.binding_id=b.id ORDER BY p.covered_ends_at DESC, p.id DESC LIMIT 1;
  refusal:=CASE
    WHEN b.id IS NULL OR b.status<>'ACTIVE' OR b.requirements->>'billingInterval' NOT IN ('MONTHLY','ANNUAL') THEN 'NO_ACTIVE_PLAN'
    WHEN EXISTS (SELECT 1 FROM hon.saas_schedule_bindings x WHERE x.organization_id=p_org AND x.switch_from_binding_id IS NOT NULL
      AND x.status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','NEEDS_REVIEW')) THEN 'SWITCH_IN_PROGRESS'
    WHEN hon.saas_org_billing_conflict(p_org) IS NOT NULL THEN 'BILLING_REVIEW_PENDING'
    WHEN hon.saas_access_exception_live(p_org) THEN 'ACCESS_EXCEPTION_ACTIVE'
    WHEN EXISTS (SELECT 1 FROM hon.saas_subscriptions s WHERE s.organization_id=p_org AND s.status<>'VOIDED')
      OR EXISTS (SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.organization_id=p_org AND c.status IN ('CREATED','OPEN')) THEN 'OTHER_BILLING_OPEN'
    WHEN st.organization_id IS NULL OR st.state<>'PAYMENT_ACTIVE' OR st.activation_source<>'SCHEDULE_BINDING' OR st.binding_id IS DISTINCT FROM b.id
      OR ent.organization_id IS NULL OR ent.status<>'ACTIVE' OR ent.tier::text<>'COMPLETE' THEN 'ACCESS_NOT_ACTIVE'
    WHEN q.id IS NULL OR q.covered_starts_at > p_at OR q.covered_ends_at <= p_at OR NOT isfinite(q.covered_ends_at) THEN 'NO_CURRENT_PAID_PERIOD'
  END;
  IF refusal IS NULL THEN binding_id:=b.id; period_id:=q.id; END IF;
END $$;

CREATE FUNCTION hon.saas_lifetime_switch_json(s hon.saas_lifetime_switches) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('switchId',s.id,'fromBindingId',s.from_binding_id,'toBindingId',s.to_binding_id,
    'fromPlan',jsonb_build_object('offerKind',(SELECT o.offer_kind FROM hon.saas_offer_set_offers o WHERE o.id::text=fb.requirements->>'offerId'),'billingInterval',fb.requirements->>'billingInterval',
      'lockedPriceMinor',(fb.requirements->>'lockedPriceMinor')::integer),
    'fromPeriod',jsonb_build_object('startsAt',hon.saas_ts(s.from_period_starts_at),'endsAt',hon.saas_ts(s.from_period_ends_at),
      'paidMinor',s.from_period_paid_minor,'unusedDays',s.unused_days,'periodDays',s.period_days),
    'lifetimePriceMinor',s.lifetime_price_minor,'creditMinor',s.credit_minor,'amountDueMinor',s.amount_due_minor,
    'providerCreditKey',s.provider_credit_key,'quotedAt',hon.saas_ts(s.quoted_at),
    'status',CASE WHEN tb.status='ACTIVE' AND fb.status='SWITCHED_TO_LIFETIME' THEN 'SWITCHED'
      WHEN tb.status='REFUNDED_ENDED' THEN 'SWITCHED_THEN_REFUNDED'
      WHEN tb.status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY') THEN 'AWAITING_PAYMENT'
      WHEN tb.status='NEEDS_REVIEW' THEN 'NEEDS_REVIEW' ELSE 'NOT_COMPLETED' END,
    'lifetimeStartedAt',CASE WHEN fb.status='SWITCHED_TO_LIFETIME' AND tb.activated_at IS NOT NULL THEN hon.saas_ts(tb.activated_at) END,
    'refundSent',false)
  FROM hon.saas_schedule_bindings fb, hon.saas_schedule_bindings tb WHERE fb.id=s.from_binding_id AND tb.id=s.to_binding_id
$$;
-- The switch a binding is part of (either side), newest first; NULL when none.
CREATE FUNCTION hon.saas_lifetime_switch_for_binding(p_binding uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.saas_lifetime_switch_json(s) FROM hon.saas_lifetime_switches s
  WHERE s.to_binding_id=p_binding OR s.from_binding_id=p_binding ORDER BY (s.to_binding_id=p_binding) DESC, s.quoted_at DESC, s.id DESC LIMIT 1
$$;

-- ---------- school read: the switch quote ----------
CREATE FUNCTION hon.read_saas_hon_os_lifetime_switch_quote(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; at timestamptz:=clock_timestamp(); src record; b hon.saas_schedule_bindings%ROWTYPE; q hon.saas_schedule_paid_periods%ROWTYPE;
  pub hon.saas_offer_sets%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  SELECT * INTO src FROM hon.saas_lifetime_switch_source(actor.organization_id,at);
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=src.binding_id AND school_id=p_school;
  SELECT * INTO q FROM hon.saas_schedule_paid_periods WHERE id=src.period_id;
  SELECT * INTO pub FROM hon.saas_offer_sets WHERE status='PUBLISHED';
  IF src.refusal IS NULL AND b.id IS NULL THEN src.refusal:='NO_ACTIVE_PLAN'; END IF;
  RETURN jsonb_build_object('schoolId',p_school,'quotedAt',hon.saas_ts(at),'eligible',src.refusal IS NULL,'refusal',src.refusal,
    'fromBindingId',CASE WHEN src.refusal IS NULL THEN b.id END,'fromBindingVersion',CASE WHEN src.refusal IS NULL THEN b.version END,
    'fromPlan',CASE WHEN src.refusal IS NULL THEN jsonb_build_object('offerKind',(SELECT o.offer_kind FROM hon.saas_offer_set_offers o WHERE o.id::text=b.requirements->>'offerId'),'billingInterval',b.requirements->>'billingInterval',
      'lockedPriceMinor',(b.requirements->>'lockedPriceMinor')::integer) END,
    'fromPeriod',CASE WHEN src.refusal IS NULL THEN jsonb_build_object('startsAt',hon.saas_ts(q.covered_starts_at),'endsAt',hon.saas_ts(q.covered_ends_at),
      'paidMinor',q.amount_minor) END,
    'offers',CASE WHEN src.refusal IS NOT NULL THEN '[]'::jsonb ELSE (SELECT coalesce(jsonb_agg(jsonb_build_object('offerId',o.id,'offerKind',o.offer_kind,
        'displayName',o.display_name,'priceMinor',o.price_minor,'unusedDays',cr.unused_days,'periodDays',cr.period_days,'creditMinor',cr.credit_minor,
        'amountDueMinor',o.price_minor-cr.credit_minor,
        'availability',CASE WHEN hon.saas_lifetime_unavailable_reason(o.id) IS NOT NULL THEN 'SOLD_OUT'
          WHEN hon.saas_hon_os_school_refusal(actor.organization_id,o,at) IS NOT NULL THEN 'NOT_ELIGIBLE' ELSE 'AVAILABLE' END)
        ORDER BY o.position),'[]'::jsonb)
      FROM hon.saas_offer_set_offers o CROSS JOIN LATERAL hon.saas_lifetime_switch_credit(q.amount_minor,q.covered_starts_at,q.covered_ends_at,at,o.price_minor) cr
      WHERE o.set_id=pub.id AND o.billing_interval='ONE_TIME' AND o.price_minor>=200 AND hon.saas_hon_os_offer_on_sale(o,at)) END,
    'refundSent',false,'paidAccessProgram',CASE WHEN hon.saas_access_program_active() THEN 'ACTIVE' ELSE 'INACTIVE' END,'chargesEnabled',false);
END $$;

-- ---------- school command: sign up for the switch ----------
-- Same request operation as a plain sign-up (0230 evidence and insert guards), with its own fingerprint and checks. The
-- provider binding, observation, expiry and no-cost cancel before payment are the unchanged 0230 paths.
CREATE FUNCTION hon.start_saas_schedule_lifetime_switch(p_subject text,p_school uuid,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; replay jsonb; g hon.saas_subscription_generations%ROWTYPE; b hon.saas_schedule_bindings%ROWTYPE; fb hon.saas_schedule_bindings%ROWTYPE;
  q hon.saas_schedule_paid_periods%ROWTYPE; sw hon.saas_lifetime_switches%ROWTYPE; src record; cr record; req jsonb; at timestamptz:=clock_timestamp();
  price integer; offer uuid;
BEGIN
  IF NOT hon.saas_trial_keys(p,ARRAY['confirmation','expectedCreditMinor','expectedFromVersion','fromBindingId','generationDigest','generationId'])
    OR coalesce(p->>'generationId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR coalesce(p->>'fromBindingId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR coalesce(p->>'generationDigest','') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p->'expectedFromVersion')<>'number' OR coalesce(p->>'expectedFromVersion','') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'expectedCreditMinor')<>'number' OR coalesce(p->>'expectedCreditMinor','') !~ '^(0|[1-9][0-9]{0,8})$'
    OR p->>'confirmation'<>'SWITCH_TO_LIFETIME_UNUSED_DAYS_CREDITED_NO_REFUND'
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  PERFORM hon.saas_generation_lock_authority(); SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  replay:=hon.saas_claim_request(actor.principal_id,p_key,'saas.schedule_binding.start',
    hon.saas_fingerprint(ARRAY['saas.schedule_binding.start.lifetime_switch',p_school::text,p::text]),p_request,p_correlation);
  IF replay IS NOT NULL THEN
    PERFORM hon.require_saas_school_purchaser(p_subject,p_school);
    IF coalesce(replay->'binding'->>'bindingId','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT * INTO b FROM hon.saas_schedule_bindings
        WHERE id=(replay->'binding'->>'bindingId')::uuid AND organization_id=actor.organization_id AND school_id=p_school;
      SELECT * INTO sw FROM hon.saas_lifetime_switches WHERE to_binding_id=b.id;
      IF b.id IS NOT NULL AND sw.id IS NOT NULL AND b.status<>'PENDING_PROVIDER_BINDING' THEN
        RETURN jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'lifetimeSwitch',hon.saas_lifetime_switch_json(sw),'replayed',true);
      END IF;
    END IF;
    RETURN replay;
  END IF;
  SELECT * INTO g FROM hon.saas_subscription_generations WHERE id=(p->>'generationId')::uuid AND organization_id=actor.organization_id AND school_id=p_school;
  IF g.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF g.generation_digest<>p->>'generationDigest' THEN RAISE EXCEPTION 'SAAS_GENERATION_ACCEPTANCE_STALE' USING ERRCODE='40001'; END IF;
  -- Canonical order: organization -> old binding row.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||actor.organization_id::text,0));
  PERFORM hon.saas_schedule_payment_program();
  SELECT * INTO src FROM hon.saas_lifetime_switch_source(actor.organization_id,at);
  IF src.refusal IS NOT NULL OR src.binding_id<>(p->>'fromBindingId')::uuid THEN
    RAISE EXCEPTION 'SAAS_LIFETIME_SWITCH_NOT_AVAILABLE' USING ERRCODE='23514', DETAIL=coalesce(src.refusal,'NO_ACTIVE_PLAN'); END IF;
  SELECT * INTO fb FROM hon.saas_schedule_bindings WHERE id=src.binding_id AND school_id=p_school FOR UPDATE;
  IF fb.id IS NULL THEN RAISE EXCEPTION 'SAAS_LIFETIME_SWITCH_NOT_AVAILABLE' USING ERRCODE='23514', DETAIL='NO_ACTIVE_PLAN'; END IF;
  IF fb.version<>(p->>'expectedFromVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM hon.saas_schedule_bindings WHERE generation_id=g.id) THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_EXISTS' USING ERRCODE='40001'; END IF;
  req:=hon.saas_schedule_requirements(g);
  offer:=(SELECT o.id FROM hon.saas_offer_set_offers o WHERE o.id::text=req->>'offerId' AND o.billing_interval='ONE_TIME' AND req->>'billingInterval'='ONE_TIME');
  IF offer IS NULL THEN RAISE EXCEPTION 'SAAS_LIFETIME_SWITCH_NOT_AVAILABLE' USING ERRCODE='23514', DETAIL='NOT_A_LIFETIME_OFFER'; END IF;
  IF hon.saas_lifetime_unavailable_reason(offer) IS NOT NULL THEN RAISE EXCEPTION 'SAAS_LIFETIME_SOLD_OUT' USING ERRCODE='23514'; END IF;
  price:=(req->>'lockedPriceMinor')::integer;
  IF price<200 THEN RAISE EXCEPTION 'SAAS_LIFETIME_SWITCH_NOT_AVAILABLE' USING ERRCODE='23514', DETAIL='NOT_A_LIFETIME_OFFER'; END IF;
  SELECT * INTO q FROM hon.saas_schedule_paid_periods WHERE id=src.period_id;
  SELECT * INTO cr FROM hon.saas_lifetime_switch_credit(q.amount_minor,q.covered_starts_at,q.covered_ends_at,at,price);
  -- The school agreed to an exact credit; a new UTC day (or anything else) that changes it asks for a fresh quote.
  IF cr.credit_minor<>(p->>'expectedCreditMinor')::integer THEN RAISE EXCEPTION 'SAAS_LIFETIME_SWITCH_QUOTE_STALE' USING ERRCODE='40001'; END IF;
  INSERT INTO hon.saas_schedule_bindings(binding_key,generation_id,organization_id,school_id,requirements,requirements_digest,provider,provider_mode,status,status_reason,
    actor_principal_id,idempotency_key,created_at,switch_from_binding_id)
  VALUES(gen_random_uuid(),g.id,actor.organization_id,p_school,req,hon.saas_hon_os_digest(req),'STRIPE_SIMULATED','TEST','PENDING_PROVIDER_BINDING','BINDING_REQUESTED',
    actor.principal_id,p_key,at,fb.id) RETURNING * INTO b;
  INSERT INTO hon.saas_lifetime_switches(organization_id,school_id,from_binding_id,to_binding_id,from_paid_period_id,from_period_starts_at,from_period_ends_at,
    from_period_paid_minor,unused_days,period_days,lifetime_price_minor,credit_minor,amount_due_minor,provider_credit_key,quoted_at)
  VALUES(actor.organization_id,p_school,fb.id,b.id,q.id,q.covered_starts_at,q.covered_ends_at,q.amount_minor,cr.unused_days,cr.period_days,price,
    cr.credit_minor,price-cr.credit_minor,gen_random_uuid(),at) RETURNING * INTO sw;
  RETURN hon.saas_record(actor.principal_id,p_key,'saas.schedule_binding.start','saas.schedule_binding.requested','SCHEDULE_BINDING',b.id,actor.organization_id,NULL,
    hon.saas_schedule_binding_json(b),jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'lifetimeSwitch',hon.saas_lifetime_switch_json(sw)),at);
END $$;

-- A switch binding is inserted only by the switch command, from a live recurring plan of the same school, with its switch
-- record in the same transaction (checked at commit).
CREATE FUNCTION hon.guard_saas_lifetime_switch_binding_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE fb hon.saas_schedule_bindings%ROWTYPE;
BEGIN
  IF NEW.switch_from_binding_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO fb FROM hon.saas_schedule_bindings WHERE id=NEW.switch_from_binding_id;
  IF fb.id IS NULL OR fb.status<>'ACTIVE' OR fb.switch_from_binding_id IS NOT NULL OR fb.organization_id<>NEW.organization_id
    OR fb.school_id<>NEW.school_id OR fb.requirements->>'billingInterval' NOT IN ('MONTHLY','ANNUAL')
    OR NOT EXISTS(SELECT 1 FROM hon.saas_requests r WHERE r.actor_principal_id=NEW.actor_principal_id AND r.idempotency_key=NEW.idempotency_key
      AND r.operation='saas.schedule_binding.start' AND r.status='IN_PROGRESS')
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_lifetime_switch_binding_insert BEFORE INSERT ON hon.saas_schedule_bindings FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_lifetime_switch_binding_insert();

-- The switch record matches its bindings, its period and its credit (runs at commit as its owner).
CREATE FUNCTION hon.verify_saas_lifetime_switch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_to uuid; ok boolean;
BEGIN
  IF TG_TABLE_NAME='saas_lifetime_switches' THEN v_to:=NEW.to_binding_id;
  ELSE
    IF NEW.switch_from_binding_id IS NULL THEN RETURN NULL; END IF;
    v_to:=NEW.id;
  END IF;
  SELECT count(*)=1 AND bool_and(s.from_binding_id=tb.switch_from_binding_id AND s.organization_id=tb.organization_id AND s.school_id=tb.school_id
      AND s.lifetime_price_minor=(tb.requirements->>'lockedPriceMinor')::integer AND q.binding_id=s.from_binding_id
      AND q.covered_starts_at=s.from_period_starts_at AND q.covered_ends_at=s.from_period_ends_at AND q.amount_minor=s.from_period_paid_minor
      AND (SELECT c.credit_minor FROM hon.saas_lifetime_switch_credit(q.amount_minor,q.covered_starts_at,q.covered_ends_at,s.quoted_at,s.lifetime_price_minor) c)=s.credit_minor
      AND s.quoted_at=tb.created_at)
    INTO ok
  FROM hon.saas_lifetime_switches s JOIN hon.saas_schedule_bindings tb ON tb.id=s.to_binding_id
    JOIN hon.saas_schedule_paid_periods q ON q.id=s.from_paid_period_id WHERE s.to_binding_id=v_to;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'SAAS_LIFETIME_SWITCH_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER saas_lifetime_switch_consistency AFTER INSERT ON hon.saas_lifetime_switches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_lifetime_switch();
CREATE CONSTRAINT TRIGGER saas_lifetime_switch_consistency AFTER INSERT ON hon.saas_schedule_bindings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_lifetime_switch();

-- ---------- welcome-credit consistency (0325 body; the switch payment is lowered by its recorded switch credit) ----------
CREATE OR REPLACE FUNCTION hon.verify_saas_schedule_credit_consistency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_period uuid; v_credit uuid; ok boolean;
BEGIN
  IF TG_TABLE_NAME = 'saas_schedule_paid_periods' THEN v_period := NEW.id; ELSE v_period := NEW.paid_period_id; v_credit := NEW.credit_id; END IF;
  SELECT q.amount_minor + coalesce((SELECT sum(u.amount_minor) FROM hon.saas_schedule_credit_uses u WHERE u.paid_period_id = q.id), 0)
      -- 0341: a lifetime binding has one paid period; a switch lowers it by the credit fixed at sign-up.
      + coalesce((SELECT s.credit_minor FROM hon.saas_lifetime_switches s WHERE s.to_binding_id = q.binding_id), 0)
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

-- ---------- binding transitions (0309 body; SWITCHED_TO_LIFETIME is terminal) ----------
CREATE OR REPLACE FUNCTION hon.saas_schedule_binding_transition(p_binding hon.saas_schedule_bindings,p_status text,p_reason text,
  p_action text,p_key uuid,p_at timestamptz) RETURNS hon.saas_schedule_bindings
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE prior jsonb:=hon.saas_schedule_binding_json(p_binding); b hon.saas_schedule_bindings%ROWTYPE; actor uuid:=hon.saas_payment_actor();
BEGIN
  UPDATE hon.saas_schedule_bindings SET status=p_status,status_reason=p_reason,version=version+1,
    activated_at=CASE WHEN p_status='ACTIVE' THEN p_at ELSE activated_at END,
    terminal_at=CASE WHEN p_status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','REFUNDED_ENDED','SWITCHED_TO_LIFETIME') THEN p_at ELSE terminal_at END,
    policy_version=CASE WHEN p_status='EXPIRED_UNPAID' THEN (SELECT version FROM hon.saas_billing_lifecycle_policy WHERE policy_id=1) ELSE policy_version END
  WHERE id=p_binding.id AND version=p_binding.version RETURNING * INTO b;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.saas_claim_request(actor,p_key,p_action,hon.saas_fingerprint(ARRAY[p_action,b.id::text,b.version::text]),p_key,p_key);
  PERFORM hon.saas_record(actor,p_key,p_action,'saas.schedule_binding.transitioned','SCHEDULE_BINDING',b.id,b.organization_id,
    prior,hon.saas_schedule_binding_json(b),jsonb_build_object('binding',hon.saas_schedule_binding_json(b)),p_at);
  IF p_status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED') THEN PERFORM hon.saas_schedule_after_binding_terminal(b.id,p_at); END IF;
  RETURN b;
END $$;

-- ---------- closed binding transition table (0309 body plus ACTIVE -> SWITCHED_TO_LIFETIME) ----------
CREATE OR REPLACE FUNCTION hon.guard_saas_schedule_bindings() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE old_row jsonb:=to_jsonb(OLD); new_row jsonb:=to_jsonb(NEW); allowed text[];
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE='42501'; END IF;
  IF NEW.version IS DISTINCT FROM OLD.version+1 THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  allowed:=CASE
    WHEN OLD.status='PENDING_PROVIDER_BINDING' AND NEW.status='BOUND_TEST_ONLY' AND NEW.status_reason='BINDING_OBSERVED_TEST_ONLY'
      AND NEW.observed_by_principal_id=hon.saas_payment_actor() AND NEW.bound_at IS NOT NULL
      THEN ARRAY['status','status_reason','version','provider_account_reference','provider_subscription_reference','provider_schedule_reference',
        'observed_by_principal_id','observation_key','bound_at']
    WHEN OLD.status='PENDING_PROVIDER_BINDING' AND NEW.status='VOIDED_PROVIDER_FAILED' AND NEW.status_reason='PROVIDER_CONFIRMED_NOT_CREATED'
      THEN ARRAY['status','status_reason','version','terminal_at']
    WHEN OLD.status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE') AND NEW.status='NEEDS_REVIEW' AND NEW.status_reason NOT IN ('REVIEW_REFUND_VERIFIED','SWITCHED_TO_LIFETIME')
      THEN ARRAY['status','status_reason','version']
    WHEN OLD.status='BOUND_TEST_ONLY' AND NEW.status='ACTIVE' AND NEW.status_reason='FIRST_PAYMENT_VERIFIED'
      THEN ARRAY['status','status_reason','version','activated_at']
    WHEN OLD.status='BOUND_TEST_ONLY' AND NEW.status='EXPIRED_UNPAID' AND NEW.status_reason='UNPAID_WINDOW_ELAPSED'
      THEN ARRAY['status','status_reason','version','terminal_at','policy_version']
    WHEN OLD.status='BOUND_TEST_ONLY' AND NEW.status='CANCELLED_BEFORE_PAYMENT' AND NEW.status_reason='PURCHASER_CANCELLED_BEFORE_PAYMENT'
      THEN ARRAY['status','status_reason','version','terminal_at']
    WHEN OLD.status='NEEDS_REVIEW' AND NEW.status='ACTIVE' AND NEW.status_reason='REVIEW_REFUND_VERIFIED' AND OLD.activated_at IS NOT NULL
      THEN ARRAY['status','status_reason','version']
    WHEN OLD.status='NEEDS_REVIEW' AND NEW.status='BOUND_TEST_ONLY' AND NEW.status_reason='REVIEW_REFUND_VERIFIED' AND OLD.activated_at IS NULL
      AND OLD.bound_at IS NOT NULL THEN ARRAY['status','status_reason','version']
    WHEN OLD.status='ACTIVE' AND NEW.status='REFUNDED_ENDED' AND NEW.status_reason='LIFETIME_REFUND_IN_WINDOW'
      AND OLD.requirements->>'billingInterval'='ONE_TIME' AND NEW.terminal_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM hon.saas_lifetime_sales ls WHERE ls.binding_id=OLD.id)
      THEN ARRAY['status','status_reason','version','terminal_at']
    -- 0341 (owner D3/D3a): the old plan ends only after its paid switch made the lifetime plan ACTIVE, from the ingest path.
    WHEN OLD.status='ACTIVE' AND NEW.status='SWITCHED_TO_LIFETIME' AND NEW.status_reason='SWITCHED_TO_LIFETIME'
      AND OLD.requirements->>'billingInterval' IN ('MONTHLY','ANNUAL') AND NEW.terminal_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM hon.saas_lifetime_switches s JOIN hon.saas_schedule_bindings tb ON tb.id=s.to_binding_id
        JOIN hon.saas_lifetime_sales ls ON ls.binding_id=tb.id WHERE s.from_binding_id=OLD.id AND tb.status='ACTIVE' AND tb.switch_from_binding_id=OLD.id)
      THEN ARRAY['status','status_reason','version','terminal_at']
  END;
  IF allowed IS NULL OR (new_row - allowed) IS DISTINCT FROM (old_row - allowed) THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF NEW.status_reason='REVIEW_REFUND_VERIFIED' AND NOT EXISTS(SELECT 1 FROM hon.saas_paid_review_resolutions r JOIN hon.saas_requests q
      ON q.actor_principal_id=r.verified_by_principal_id AND q.idempotency_key=r.verification_key
    WHERE r.binding_id=NEW.id AND r.status='REFUND_VERIFIED' AND q.status='IN_PROGRESS' AND q.operation='saas.paid_review.verify_refund') THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

-- ---------- binding evidence (0309 body; the switch end is an ingest transition) ----------
CREATE OR REPLACE FUNCTION hon.verify_saas_schedule_binding_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE data jsonb; expected_actor uuid; expected_key uuid; expected_operation text; expected_event text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.saas_schedule_bindings WHERE id=NEW.id AND version=NEW.version) THEN RETURN NULL; END IF;
  data:=hon.saas_schedule_binding_json(NEW);
  IF NEW.status='PENDING_PROVIDER_BINDING' THEN
    expected_actor:=NEW.actor_principal_id; expected_key:=NEW.idempotency_key; expected_operation:='saas.schedule_binding.start'; expected_event:='saas.schedule_binding.requested';
  ELSIF NEW.status='BOUND_TEST_ONLY' AND NEW.status_reason<>'REVIEW_REFUND_VERIFIED' THEN
    expected_actor:=NEW.observed_by_principal_id; expected_key:=NEW.observation_key; expected_operation:='saas.schedule_binding.observe'; expected_event:='saas.schedule_binding.observed';
  ELSE
    IF NOT EXISTS(SELECT 1 FROM hon.saas_audit a JOIN hon.saas_outbox o ON o.audit_id=a.id
      WHERE a.entity_type='SCHEDULE_BINDING' AND a.entity_id=NEW.id AND a.organization_id=NEW.organization_id
        AND a.next_state->>'version'=NEW.version::text AND a.next_state->>'status'=NEW.status
        AND a.action_code = ANY(CASE WHEN NEW.status_reason='REVIEW_REFUND_VERIFIED' THEN ARRAY['saas.paid_review.verify_refund']
          ELSE CASE NEW.status WHEN 'ACTIVE' THEN ARRAY['saas.schedule_binding.transition'] WHEN 'REFUNDED_ENDED' THEN ARRAY['saas.schedule_binding.transition']
          WHEN 'SWITCHED_TO_LIFETIME' THEN ARRAY['saas.schedule_binding.transition']
          WHEN 'NEEDS_REVIEW' THEN ARRAY['saas.schedule_binding.transition','saas.schedule_binding.reconcile']
          WHEN 'VOIDED_PROVIDER_FAILED' THEN ARRAY['saas.schedule_binding.reconcile'] WHEN 'EXPIRED_UNPAID' THEN ARRAY['saas.schedule_binding.expire']
          WHEN 'CANCELLED_BEFORE_PAYMENT' THEN ARRAY['saas.schedule_binding.cancel'] ELSE ARRAY[]::text[] END END)
        AND o.event_type='saas.schedule_binding.transitioned' AND o.payload->>'executionAllowed'='false')
    THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.saas_requests r JOIN hon.saas_audit a USING(actor_principal_id,idempotency_key) JOIN hon.saas_outbox o ON o.audit_id=a.id
    WHERE r.actor_principal_id=expected_actor AND r.idempotency_key=expected_key AND r.status='COMPLETED' AND r.operation=expected_operation
      AND r.response_body->'binding'=data AND a.action_code=expected_operation AND a.entity_type='SCHEDULE_BINDING' AND a.entity_id=NEW.id
      AND a.organization_id=NEW.organization_id AND a.next_state=data AND o.event_type=expected_event AND o.payload->>'executionAllowed'='false')
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

-- ---------- access state (0309 body plus the switch move) ----------
CREATE OR REPLACE FUNCTION hon.guard_saas_access() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND NEW.organization_id = OLD.organization_id AND NEW.created_at = OLD.created_at THEN
    IF OLD.state = 'AWAITING_FIRST_PAYMENT' AND NEW.state = 'PAYMENT_ACTIVE' THEN RETURN NEW; END IF;
    IF OLD.state = 'PAYMENT_ACTIVE' AND NEW.state = 'PAYMENT_ACTIVE' AND OLD.activation_source = 'SCHEDULE_BINDING'
      AND NEW.paid_through > OLD.paid_through
      AND (to_jsonb(NEW) - ARRAY['paid_through','version','changed_by_principal_id','updated_at'])
        = (to_jsonb(OLD) - ARRAY['paid_through','version','changed_by_principal_id','updated_at']) THEN RETURN NEW; END IF;
    IF OLD.state = 'PAYMENT_ACTIVE' AND NEW.state = 'AWAITING_FIRST_PAYMENT' AND NEW.reason = 'AWAITING_INITIAL_PAYMENT'
      AND OLD.activation_source = 'SCHEDULE_BINDING'
      AND EXISTS (SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.id = OLD.binding_id AND b.status = 'REFUNDED_ENDED')
      AND (to_jsonb(NEW) - ARRAY['state','reason','activation_source','binding_id','first_paid_period_id','paid_through','version','changed_by_principal_id','updated_at'])
        = (to_jsonb(OLD) - ARRAY['state','reason','activation_source','binding_id','first_paid_period_id','paid_through','version','changed_by_principal_id','updated_at'])
      THEN RETURN NEW; END IF;
    -- 0341 (owner D3/D3a): access moves from the switched plan to its paid lifetime plan, open-ended. Nothing else changes.
    IF OLD.state = 'PAYMENT_ACTIVE' AND NEW.state = 'PAYMENT_ACTIVE' AND OLD.activation_source = 'SCHEDULE_BINDING'
      AND NEW.paid_through = 'infinity'::timestamptz
      AND EXISTS (SELECT 1 FROM hon.saas_schedule_bindings b JOIN hon.saas_lifetime_sales ls ON ls.binding_id = b.id AND ls.paid_period_id = NEW.first_paid_period_id
        WHERE b.id = NEW.binding_id AND b.status = 'ACTIVE' AND b.switch_from_binding_id = OLD.binding_id)
      AND (to_jsonb(NEW) - ARRAY['binding_id','first_paid_period_id','paid_through','version','changed_by_principal_id','updated_at'])
        = (to_jsonb(OLD) - ARRAY['binding_id','first_paid_period_id','paid_through','version','changed_by_principal_id','updated_at'])
      THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE = '42501';
END $$;

-- ---------- move access (internal; the caller holds the organization, binding, entitlement and access-state locks) ----------
-- Raises on any failure: the ingest delivery then fails as a whole and the provider retries it.
CREATE FUNCTION hon.saas_schedule_switch_lifetime_access(p_to uuid, p_from uuid, p_period uuid, p_event text, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); b hon.saas_schedule_bindings%ROWTYPE; ent hon.organization_entitlements%ROWTYPE;
  st hon.saas_access_states%ROWTYPE; prior jsonb;
BEGIN
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id = p_to;
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = b.organization_id FOR UPDATE;
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = b.organization_id FOR UPDATE;
  IF b.id IS NULL OR b.status <> 'ACTIVE' OR b.switch_from_binding_id IS DISTINCT FROM p_from
    OR NOT EXISTS (SELECT 1 FROM hon.saas_lifetime_sales ls WHERE ls.binding_id = b.id AND ls.paid_period_id = p_period)
    OR st.state IS DISTINCT FROM 'PAYMENT_ACTIVE' OR st.binding_id IS DISTINCT FROM p_from OR ent.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'SAAS_ACCESS_HOOK_INPUT';
  END IF;
  prior := hon.saas_entitlement_json(b.organization_id);
  UPDATE hon.organization_entitlements SET tier = 'COMPLETE', status = 'ACTIVE', effective_until = NULL, version = version + 1, updated_at = p_at
    WHERE organization_id = b.organization_id AND version = ent.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  UPDATE hon.saas_access_states SET binding_id = b.id, first_paid_period_id = p_period, paid_through = 'infinity', version = version + 1,
      changed_by_principal_id = actor, updated_at = p_at
    WHERE organization_id = b.organization_id AND version = st.version;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
      prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
    VALUES (b.organization_id, 'SCHEDULE_LIFETIME_SWITCH', 'APPLIED', 'LIFETIME_SWITCH_PAID', b.id, p_period, p_event,
      prior, hon.saas_entitlement_json(b.organization_id), actor, p_at);
  RETURN jsonb_build_object('accessActivation','APPLIED','accessGranted',true);
END $$;

-- ---------- binding access read (0309 body plus the switch on both sides) ----------
CREATE OR REPLACE FUNCTION hon.saas_schedule_access_json(p_binding uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE
    WHEN ended.id IS NOT NULL THEN jsonb_build_object('accessActivation','ENDED','reason',NULL,'paidThrough',NULL,'accessUntil',NULL)
    -- 0341: the old plan's access moved to its lifetime plan.
    WHEN switched.id IS NOT NULL THEN jsonb_build_object('accessActivation','SWITCHED','reason',NULL,'paidThrough',NULL,'accessUntil',NULL)
    WHEN applied.id IS NOT NULL THEN jsonb_build_object('accessActivation','APPLIED','reason',NULL,
      'paidThrough',hon.saas_ts(st.paid_through),'accessUntil',hon.saas_ts(st.paid_through + hon.saas_schedule_access_grace()))
    WHEN review.id IS NOT NULL THEN jsonb_build_object('accessActivation','NEEDS_REVIEW','reason',review.reason,'paidThrough',NULL,'accessUntil',NULL)
    ELSE jsonb_build_object('accessActivation','NOT_ATTEMPTED','reason',NULL,'paidThrough',NULL,'accessUntil',NULL) END
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT t.id FROM hon.saas_access_transitions t WHERE t.binding_id = p_binding
    AND t.kind IN ('SCHEDULE_FIRST_PAYMENT_ACTIVATION','SCHEDULE_LIFETIME_SWITCH') AND t.outcome = 'APPLIED' LIMIT 1) applied ON true
  LEFT JOIN LATERAL (SELECT t.id, t.reason FROM hon.saas_access_transitions t WHERE t.binding_id = p_binding
    AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION' AND t.outcome = 'NEEDS_REVIEW' ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1) review ON true
  LEFT JOIN LATERAL (SELECT t.id FROM hon.saas_access_transitions t WHERE t.binding_id = p_binding
    AND t.kind = 'SCHEDULE_REFUND_ENDED' AND t.outcome = 'APPLIED' LIMIT 1) ended ON true
  LEFT JOIN LATERAL (SELECT b.id FROM hon.saas_schedule_bindings b WHERE b.id = p_binding AND b.status = 'SWITCHED_TO_LIFETIME') switched ON true
  LEFT JOIN hon.saas_access_states st ON st.binding_id = p_binding
$$;

-- ---------- billing conflict (0309 body; money reaching a switched plan is held like any ended plan) ----------
CREATE OR REPLACE FUNCTION hon.saas_org_billing_conflict(p_org uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.organization_id=p_org AND c.status='PAID_NEEDS_REVIEW'
      AND hon.saas_paid_review_open('V1_CHECKOUT',c.id))
    OR EXISTS (SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.organization_id=p_org
      AND b.status IN ('NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED','SWITCHED_TO_LIFETIME')
      AND hon.saas_paid_review_open('SCHEDULE_BINDING',b.id))
  THEN 'PAID_NEEDS_REVIEW' END
$$;

-- ---------- binding reads (0325 body plus the switch) ----------
CREATE OR REPLACE FUNCTION hon.read_saas_schedule_binding(p_subject text, p_school uuid, p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; b hon.saas_schedule_bindings%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding AND organization_id=actor.organization_id AND school_id=p_school;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN hon.saas_schedule_binding_json(b) || jsonb_build_object('access',hon.saas_schedule_access_json(b.id),
    'welcomeCredit',hon.saas_schedule_welcome_credit_json(b.id),'lifetimeSwitch',hon.saas_lifetime_switch_for_binding(b.id));
END $$;
CREATE OR REPLACE FUNCTION hon.read_saas_schedule_binding_from_hq(p_subject text, p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false); SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  RETURN hon.saas_schedule_binding_json(b) || jsonb_build_object('access',hon.saas_schedule_access_json(b.id),
    'welcomeCredit',hon.saas_schedule_welcome_credit_json(b.id),'lifetimeSwitch',hon.saas_lifetime_switch_for_binding(b.id));
END $$;

-- ---------- HQ read: every switch, newest first ----------
CREATE FUNCTION hon.read_saas_hq_lifetime_switches(p_subject text, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('switches',(SELECT coalesce(jsonb_agg(x.j ORDER BY x.quoted_at DESC, x.id DESC),'[]'::jsonb) FROM (
    SELECT s.id, s.quoted_at, hon.saas_lifetime_switch_json(s) || jsonb_build_object('organizationId',s.organization_id,'schoolId',s.school_id,
      'schoolName',(SELECT sc.name FROM hon.schools sc WHERE sc.id=s.school_id)) j
    FROM hon.saas_lifetime_switches s ORDER BY s.quoted_at DESC, s.id DESC LIMIT p_limit) x),'refundSent',false);
END $$;

-- ---------- HQ paid review (0309 bodies; a switched plan is reviewed like an ended one) ----------
CREATE OR REPLACE FUNCTION hon.saas_paid_review_open(p_kind text,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE p_kind
    WHEN 'V1_CHECKOUT' THEN EXISTS(SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.id=p_subject AND c.status='PAID_NEEDS_REVIEW'
      AND (SELECT x.n=0 OR x.n>hon.saas_paid_review_reviewed_count(c.id) FROM (SELECT (hon.saas_paid_review_items('V1_CHECKOUT',c.id)->>'itemCount')::integer AS n) x))
    WHEN 'SCHEDULE_BINDING' THEN EXISTS(SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.id=p_subject AND (b.status='NEEDS_REVIEW'
      OR (b.status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED','SWITCHED_TO_LIFETIME')
        AND (SELECT count(*) FROM hon.saas_schedule_reconciliations r WHERE r.binding_id=b.id)>hon.saas_paid_review_reviewed_count(b.id)
        -- 0309/0341: an ended lifetime plan or a switched plan is open only while it holds money; a repeated refund report alone holds nothing.
        AND (b.status NOT IN ('REFUNDED_ENDED','SWITCHED_TO_LIFETIME') OR (hon.saas_paid_review_items('SCHEDULE_BINDING',b.id)->>'heldItemCount')::integer>0))))
    ELSE false END
$$;

CREATE OR REPLACE FUNCTION hon.read_saas_paid_reviews(p_subject text,p_cursor text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE after_at timestamptz; after_id uuid; page jsonb; next_cursor text; page_size constant integer:=50;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false);
  IF p_cursor IS NOT NULL THEN
    IF p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z~[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
    BEGIN after_at:=split_part(p_cursor,'~',1)::timestamptz; after_id:=split_part(p_cursor,'~',2)::uuid;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR invalid_text_representation THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END;
  END IF;
  WITH subjects AS (
    SELECT 'V1_CHECKOUT'::text AS kind, c.id, c.created_at FROM hon.saas_checkout_sessions c
      WHERE c.status='PAID_NEEDS_REVIEW' AND hon.saas_paid_review_open('V1_CHECKOUT',c.id)
    UNION ALL
    SELECT 'SCHEDULE_BINDING', b.id, b.created_at FROM hon.saas_schedule_bindings b
      WHERE b.status IN ('NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED','SWITCHED_TO_LIFETIME') AND hon.saas_paid_review_open('SCHEDULE_BINDING',b.id)),
  numbered AS (SELECT kind, id, created_at, row_number() OVER (ORDER BY created_at,id) AS n FROM subjects
    WHERE after_at IS NULL OR (created_at,id)>(after_at,after_id) ORDER BY created_at,id LIMIT page_size+1)
  SELECT coalesce(jsonb_agg(hon.saas_paid_review_item_json(kind,id) ORDER BY n) FILTER (WHERE n<=page_size),'[]'::jsonb),
    CASE WHEN max(n)>page_size THEN max(CASE WHEN n=page_size THEN to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||'~'||id::text END) END
  INTO page, next_cursor FROM numbered;
  RETURN jsonb_build_object('items',page,'nextCursor',next_cursor,'providerActionExecuted',false);
END $$;

-- ---------- ingest (0325 body plus the paid switch) ----------
CREATE OR REPLACE FUNCTION hon.ingest_saas_schedule_evidence(p jsonb,p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; e hon.saas_schedule_provider_events%ROWTYPE; org uuid; bid uuid;
  req uuid:=gen_random_uuid(); at timestamptz:=clock_timestamp(); occurred_at timestamptz; period_id uuid;
  outcome text:='NEEDS_REVIEW'; reason text:='RECONCILIATION_REQUIRED'; first_payment boolean:=false; collecting boolean;
  access jsonb:=jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false); result jsonb; founder_offer uuid;
  lifetime_offer uuid; covered_ends timestamptz; covered_starts timestamptz; ending boolean:=false;
  locked integer; expected integer; credit_left integer:=0; use_left integer; c record;
  sw hon.saas_lifetime_switches%ROWTYPE; fb hon.saas_schedule_bindings%ROWTYPE; switching boolean:=false; switch_ok boolean:=false;
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
  -- 0341: a switch's first payment also locks the plan it switches from (after the binding row).
  IF b.switch_from_binding_id IS NOT NULL AND b.status='BOUND_TEST_ONLY' AND p->>'eventType'='invoice.paid' THEN
    SELECT * INTO sw FROM hon.saas_lifetime_switches WHERE to_binding_id=b.id;
    SELECT * INTO fb FROM hon.saas_schedule_bindings WHERE id=b.switch_from_binding_id FOR UPDATE;
  END IF;
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
  -- 0341: then the entitlement and access state the switch moves. The switch stands only while the old plan is still
  -- ACTIVE, still on the period its credit was fixed from (no renewal landed first), inside that period, and still holds
  -- the school's access.
  IF sw.id IS NOT NULL THEN
    PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=b.organization_id FOR UPDATE;
    PERFORM 1 FROM hon.saas_access_states WHERE organization_id=b.organization_id FOR UPDATE;
    switch_ok:=fb.id IS NOT NULL AND fb.status='ACTIVE' AND at < sw.from_period_ends_at
      AND (SELECT q.id FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=fb.id ORDER BY q.covered_ends_at DESC, q.id DESC LIMIT 1)=sw.from_paid_period_id
      AND EXISTS(SELECT 1 FROM hon.saas_access_states xs WHERE xs.organization_id=b.organization_id AND xs.state='PAYMENT_ACTIVE' AND xs.binding_id=fb.id)
      AND EXISTS(SELECT 1 FROM hon.organization_entitlements oe WHERE oe.organization_id=b.organization_id AND oe.status='ACTIVE')
      AND NOT hon.saas_access_exception_live(b.organization_id);
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
    -- 0341: a switch is charged the lifetime price minus the credit fixed at sign-up.
    IF sw.id IS NOT NULL THEN expected:=sw.amount_due_minor; END IF;
    IF (p->>'amountMinor')::integer<>expected THEN reason:='AMOUNT_MISMATCH';
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id AND q.provider_invoice_reference=p->>'invoiceReference') THEN outcome:='ALREADY_APPLIED'; reason:='DUPLICATE_INVOICE_REFERENCE';
    -- One payment covers exactly one billing interval of the locked terms; any other length is reviewed, never counted.
    ELSIF NOT hon.saas_schedule_period_matches(b.requirements->>'billingInterval',covered_starts,covered_ends) THEN reason:='PERIOD_INTERVAL_MISMATCH';
    -- A second lifetime payment always overlaps the open-ended first one, so it is reviewed, never counted.
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id AND tstzrange(q.covered_starts_at,q.covered_ends_at,'[)') && tstzrange(covered_starts,covered_ends,'[)')) THEN reason:='OVERLAPPING_COVERED_PERIOD';
    -- 0341: the old plan changed (renewal, suspension, review or period end) before the switch was paid.
    ELSIF sw.id IS NOT NULL AND NOT switch_ok THEN reason:='LIFETIME_SWITCH_SOURCE_CHANGED';
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
      switching:=first_payment AND sw.id IS NOT NULL;
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
    -- 0341: then the old plan ends; its schedule is stopped by the API afterwards, with no proration and no refund.
    IF switching THEN
      fb:=hon.saas_schedule_binding_transition(fb,'SWITCHED_TO_LIFETIME','SWITCHED_TO_LIFETIME','saas.schedule_binding.transition',gen_random_uuid(),at);
    END IF;
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
  -- 0341: moving access is not isolated either; billing never switches while access stays on the old plan.
  ELSIF switching THEN access:=hon.saas_schedule_switch_lifetime_access(b.id,fb.id,period_id,p->>'eventId',at);
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
  IF switching THEN
    result:=result||jsonb_build_object('switchedFrom',jsonb_build_object('bindingId',fb.id,'accountReference',fb.provider_account_reference,
      'subscriptionReference',fb.provider_subscription_reference,'scheduleReference',fb.provider_schedule_reference,
      'billingStatus',fb.status,'stopSchedule','NO_PRORATION_NO_REFUND'));
  END IF;
  INSERT INTO hon.saas_schedule_provider_events(provider,provider_mode,provider_event_id,payload_digest,binding_id,event_type,normalized,outcome,outcome_reason,request_key,provider_occurred_at,received_at)
    VALUES('STRIPE_SIMULATED','TEST',p->>'eventId',p_digest,b.id,p->>'eventType',p||jsonb_build_object('receipt',result),outcome,reason,req,occurred_at,at);
  PERFORM hon.saas_record(hon.saas_payment_actor(),req,'saas.schedule_evidence.ingest','saas.schedule_evidence.recorded','SCHEDULE_EVENT',
    (SELECT id FROM hon.saas_schedule_provider_events WHERE provider='STRIPE_SIMULATED' AND provider_event_id=p->>'eventId'),b.organization_id,NULL,result,result,at);
  RETURN result;
END $$;


-- ---------- a sale paid by a switch: the payment is the lifetime price less the switch credit (0306 body) ----------
CREATE OR REPLACE FUNCTION hon.guard_saas_lifetime_sale_insert() RETURNS trigger
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
    OR NEW.price_minor<>(b.requirements->>'lockedPriceMinor')::integer OR per.amount_minor<>NEW.price_minor-coalesce((SELECT s.credit_minor FROM hon.saas_lifetime_switches s WHERE s.to_binding_id=b.id),0)
    OR NEW.provider_event_id<>per.provider_event_id OR NEW.sold_at<>per.recorded_at
    OR hon.saas_lifetime_unavailable_reason(o.id) IS NOT NULL
    OR NEW.sale_number<>(SELECT count(*)+1 FROM hon.saas_lifetime_sales x WHERE x.offer_id=o.id)
  THEN RAISE EXCEPTION 'SAAS_LIFETIME_SALE_REFUSED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- ---------- ACLs ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_saas_hon_os_lifetime_switch_quote(text,uuid)','hon.start_saas_schedule_lifetime_switch(text,uuid,jsonb,uuid,uuid,uuid)',
    'hon.read_saas_hq_lifetime_switches(text,integer)','hon.read_saas_schedule_binding(text,uuid,uuid)','hon.read_saas_schedule_binding_from_hq(text,uuid)',
    'hon.ingest_saas_schedule_evidence(jsonb,text)',
    'hon.saas_lifetime_switch_credit(integer,timestamp with time zone,timestamp with time zone,timestamp with time zone,integer)',
    'hon.saas_lifetime_switch_source(uuid,timestamp with time zone)','hon.saas_lifetime_switch_json(hon.saas_lifetime_switches)',
    'hon.saas_lifetime_switch_for_binding(uuid)','hon.guard_saas_lifetime_switch_binding_insert()','hon.verify_saas_lifetime_switch()',
    'hon.verify_saas_schedule_credit_consistency()','hon.saas_schedule_binding_transition(hon.saas_schedule_bindings,text,text,text,uuid,timestamp with time zone)',
    'hon.guard_saas_schedule_bindings()','hon.verify_saas_schedule_binding_evidence()','hon.guard_saas_access()',
    'hon.saas_schedule_switch_lifetime_access(uuid,uuid,uuid,text,timestamp with time zone)','hon.saas_schedule_access_json(uuid)',
    'hon.saas_org_billing_conflict(uuid)','hon.guard_saas_lifetime_sale_insert()','hon.saas_paid_review_open(text,uuid)','hon.read_saas_paid_reviews(text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_hon_os_lifetime_switch_quote(text,uuid),hon.start_saas_schedule_lifetime_switch(text,uuid,jsonb,uuid,uuid,uuid),
      hon.read_saas_hq_lifetime_switches(text,integer),hon.read_saas_schedule_binding(text,uuid,uuid),hon.read_saas_schedule_binding_from_hq(text,uuid),
      hon.ingest_saas_schedule_evidence(jsonb,text),hon.read_saas_paid_reviews(text,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
