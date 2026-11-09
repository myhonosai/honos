BEGIN;

-- HON OS schedule billing, piece 1 of 5 (owner checklist 2026-11-09): TEST-only generation-to-schedule binding,
-- verified paid-period evidence and the binding lifecycle. Rebuilt on current main from the October B2 draft (#90).
--   * Billing outcome only. A first verified payment moves the binding to ACTIVE; whether the school's ACCESS turns on is a
--     separate outcome decided by hon.saas_schedule_after_paid_period (a no-op stub here, replaced in piece 2). Its failure
--     can never roll back, hide or relabel a recorded payment (owner answer 3).
--   * One locked price per binding (owner answer 4a): every qualifying payment must equal the accepted schedule's single
--     price. Schedules with an introductory phase are refused, so the expected amount never depends on a paid-period count.
--   * Fail-closed lifecycle: problems park the binding in NEEDS_REVIEW (resolution arrives in piece 3); provider-confirmed
--     failures and unpaid expiry are terminal and release the organization. Expiry needs an owner-recorded unpaid window;
--     the policy row is deliberately not seeded.
-- Never opens checkout, collects money, executes refunds, changes entitlements or access, or touches A2/B1/legacy B5 facts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS schedule billing requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS schedule billing requires a restricted runtime';
  END IF;
END $$;

-- Owner-recorded lifecycle values. No row is seeded: a missing row or NULL value refuses the dependent transition.
CREATE TABLE hon.saas_billing_lifecycle_policy (
  policy_id smallint PRIMARY KEY CHECK (policy_id=1),
  version integer NOT NULL CHECK (version>0),
  unpaid_window_minutes integer CHECK (unpaid_window_minutes BETWEEN 15 AND 43200),
  approved_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  approval_reference text NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL
);

-- Private schedule lifecycle. Live rows (pending, bound, active, review) block a second lifecycle for the organization.
CREATE TABLE hon.saas_schedule_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_key uuid NOT NULL UNIQUE,
  generation_id uuid NOT NULL UNIQUE REFERENCES hon.saas_subscription_generations(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL REFERENCES hon.schools(id) ON DELETE RESTRICT,
  requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements)='object'),
  requirements_digest text NOT NULL CHECK (requirements_digest ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (provider='STRIPE_SIMULATED'),
  provider_mode text NOT NULL CHECK (provider_mode='TEST'),
  status text NOT NULL CHECK (status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW',
    'EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED')),
  status_reason text NOT NULL CHECK (status_reason IN ('BINDING_REQUESTED','BINDING_OBSERVED_TEST_ONLY','FIRST_PAYMENT_VERIFIED',
    'PROVIDER_CONFIRMED_NOT_CREATED','PROVIDER_TERMS_MISMATCH','UNPAID_WINDOW_ELAPSED','AMOUNT_MISMATCH','OVERLAPPING_COVERED_PERIOD',
    'REVERSAL_REVIEW_REQUIRED','UNLINKED_REVERSAL')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  provider_account_reference text CHECK (provider_account_reference ~ '^fake_[a-z0-9_-]{1,150}$'),
  provider_subscription_reference text UNIQUE CHECK (provider_subscription_reference ~ '^fake_[a-z0-9_-]{1,150}$'),
  provider_schedule_reference text UNIQUE CHECK (provider_schedule_reference ~ '^fake_[a-z0-9_-]{1,150}$'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  observed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  observation_key uuid UNIQUE,
  created_at timestamptz NOT NULL,
  bound_at timestamptz,
  activated_at timestamptz,
  terminal_at timestamptz,
  policy_version integer,
  FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key),
  FOREIGN KEY(observed_by_principal_id,observation_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key),
  UNIQUE(actor_principal_id,idempotency_key),
  CHECK (status <> 'PENDING_PROVIDER_BINDING' OR (bound_at IS NULL AND provider_account_reference IS NULL AND provider_subscription_reference IS NULL
    AND provider_schedule_reference IS NULL AND observed_by_principal_id IS NULL AND observation_key IS NULL)),
  CHECK (status NOT IN ('BOUND_TEST_ONLY','ACTIVE','EXPIRED_UNPAID') OR (bound_at IS NOT NULL AND provider_account_reference IS NOT NULL
    AND provider_subscription_reference IS NOT NULL AND provider_schedule_reference IS NOT NULL AND observed_by_principal_id IS NOT NULL
    AND observation_key IS NOT NULL)),
  CHECK ((status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED'))=(terminal_at IS NOT NULL)),
  CHECK (status <> 'ACTIVE' OR activated_at IS NOT NULL),
  CHECK (status <> 'BOUND_TEST_ONLY' OR activated_at IS NULL),
  CHECK (status <> 'EXPIRED_UNPAID' OR (activated_at IS NULL AND policy_version IS NOT NULL))
);
CREATE UNIQUE INDEX saas_schedule_binding_one_live_per_organization ON hon.saas_schedule_bindings(organization_id)
  WHERE status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW');

-- A signed/normalized provider event is immutable. An event for an unknown or still-pending binding is not stored:
-- redelivery must retry after its predecessor exists. Events for review/terminal bindings ARE stored for review.
CREATE TABLE hon.saas_schedule_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider='STRIPE_SIMULATED'),
  provider_mode text NOT NULL CHECK (provider_mode='TEST'),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  binding_id uuid NOT NULL REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created')),
  normalized jsonb NOT NULL CHECK (jsonb_typeof(normalized)='object'),
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','ALREADY_APPLIED','ATTEMPT_FAILED','NEEDS_REVIEW')),
  outcome_reason text NOT NULL CHECK (outcome_reason ~ '^[A-Z_]{3,80}$'),
  request_key uuid NOT NULL,
  provider_occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE(provider,provider_event_id)
);

-- A qualifying period is an immutable verified fact, independent of the legacy calendar subscription period_index.
CREATE TABLE hon.saas_schedule_paid_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  provider_invoice_reference text NOT NULL CHECK (provider_invoice_reference ~ '^fake_[a-z0-9_-]{1,150}$'),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  covered_starts_at timestamptz NOT NULL,
  covered_ends_at timestamptz NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 100 AND 10000000),
  currency text NOT NULL CHECK (currency='USD'),
  qualifying boolean NOT NULL DEFAULT true CHECK (qualifying=true),
  recorded_at timestamptz NOT NULL,
  UNIQUE(binding_id,provider_invoice_reference),
  UNIQUE(binding_id,covered_starts_at,covered_ends_at),
  CHECK (covered_ends_at > covered_starts_at)
);

-- Reversals, mismatches and access-hook failures are evidence-only review records. They never change a qualifying period.
CREATE TABLE hon.saas_schedule_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  related_period_id uuid REFERENCES hon.saas_schedule_paid_periods(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome='NEEDS_REVIEW'),
  reason text NOT NULL CHECK (reason ~ '^[A-Z_]{3,80}$'),
  created_at timestamptz NOT NULL,
  UNIQUE(binding_id,provider_event_id,reason)
);

-- ---------- fixed requirements and lifecycle helpers ----------
CREATE FUNCTION hon.saas_schedule_requirements(g hon.saas_subscription_generations) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE a jsonb:=g.acceptance_snapshot; s jsonb; t jsonb;
BEGIN
  s:=a->'schedule'; t:=s->'terms';
  IF a->>'acceptanceId' IS NULL OR a->>'acceptanceDigest' !~ '^[0-9a-f]{64}$' OR a->>'scheduleDigest' !~ '^[0-9a-f]{64}$'
    OR s->>'offerId' IS NULL OR s->>'renewalOfferId' IS NULL OR s->>'offerSetId' IS NULL OR s->>'acceptedOfferDigest' !~ '^[0-9a-f]{64}$'
    OR (t->>'initialPriceMinor') !~ '^[1-9][0-9]*$' OR (t->>'renewalPriceMinor') !~ '^[1-9][0-9]*$'
    OR t->>'currency' <> 'USD' OR t->>'billingInterval' NOT IN ('MONTHLY','ANNUAL')
    OR t->>'periodCountingRule' <> 'DISTINCT_VERIFIED_PAID_PERIODS' OR s->'refundTerms' IS NULL OR s->'cancellationTerms' IS NULL
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
    'priceRule','LOCKED_WHILE_SUBSCRIBED','periodCountingRule','DISTINCT_VERIFIED_PAID_PERIODS',
    'automaticCalendarTransition',false,'automaticCollectionEnabled',false);
END $$;

CREATE FUNCTION hon.saas_schedule_binding_json(b hon.saas_schedule_bindings) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('bindingId',b.id,'bindingKey',b.binding_key,'generationId',b.generation_id,'generationDigest',b.requirements->>'generationDigest',
    'organizationId',b.organization_id,'schoolId',b.school_id,'requirements',b.requirements,'provider','STRIPE_SIMULATED','mode','TEST',
    'status',b.status,'statusReason',b.status_reason,'version',b.version,'providerAccountReference',b.provider_account_reference,
    'providerSubscriptionReference',b.provider_subscription_reference,'providerScheduleReference',b.provider_schedule_reference,
    'requirementsDigest',b.requirements_digest,
    'qualifyingPaidPeriodCount',(SELECT count(*)::integer FROM hon.saas_schedule_paid_periods p WHERE p.binding_id=b.id),
    'unresolvedReconciliation',EXISTS(SELECT 1 FROM hon.saas_schedule_reconciliations r WHERE r.binding_id=b.id),
    -- Billing status only. Access is a separate outcome and is never derived from a binding status.
    'accessDecidedSeparately',true,'checkoutAvailable',false,'billingEnabled',false,
    'createdAt',hon.saas_ts(b.created_at),'boundAt',hon.saas_ts(b.bound_at),'activatedAt',hon.saas_ts(b.activated_at),
    'terminalAt',hon.saas_ts(b.terminal_at))
$$;

-- Read-only billing-conflict probe shared with later pieces. STABLE, no writes; NULL means no conflict. Any payment held
-- for review (legacy checkout or schedule binding) blocks a new binding until piece 3 adds resolution.
CREATE FUNCTION hon.saas_org_billing_conflict(p_org uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id=p_org AND status='PAID_NEEDS_REVIEW')
    OR EXISTS (SELECT 1 FROM hon.saas_schedule_bindings WHERE organization_id=p_org AND status='NEEDS_REVIEW')
  THEN 'PAID_NEEDS_REVIEW' END
$$;

CREATE FUNCTION hon.saas_schedule_binding_available(p_org uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF hon.saas_org_billing_conflict(p_org) IS NOT NULL THEN RAISE EXCEPTION 'SAAS_BILLING_REVIEW_PENDING' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM hon.saas_subscriptions WHERE organization_id=p_org AND status <> 'VOIDED') THEN
    RAISE EXCEPTION 'SAAS_SUBSCRIPTION_EXISTS' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id=p_org AND status IN ('CREATED','OPEN')) THEN
    RAISE EXCEPTION 'SAAS_CHECKOUT_OPEN' USING ERRCODE='23514'; END IF;
  -- Awaiting-first-payment is the legitimate pre-payment condition. The historical no-row case stays eligible; any other
  -- present state (today PAYMENT_ACTIVE; fail closed for future values) is a distinct lifecycle conflict.
  IF EXISTS(SELECT 1 FROM hon.saas_access_states WHERE organization_id=p_org AND state IS DISTINCT FROM 'AWAITING_FIRST_PAYMENT') THEN
    RAISE EXCEPTION 'SAAS_ACCESS_STATE_EXISTS' USING ERRCODE='23514'; END IF;
  IF hon.saas_access_exception_live(p_org) THEN RAISE EXCEPTION 'SAAS_ACCESS_EXCEPTION_ACTIVE' USING ERRCODE='23514'; END IF;
END $$;

-- Every competing lifecycle writer uses the same organization key as binding creation. A partial index alone cannot
-- prevent a checkout/access writer that began before a binding committed.
CREATE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_org uuid;
BEGIN
  v_org:=NEW.organization_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'SAAS_SCHEDULE_LIFECYCLE_CONFLICT' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||v_org::text,0));
  IF EXISTS(SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.organization_id=v_org
      AND b.status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW')) THEN
    RAISE EXCEPTION 'SAAS_SCHEDULE_LIFECYCLE_CONFLICT' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION hon.saas_schedule_payment_program() RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE p hon.saas_payment_program%ROWTYPE;
BEGIN
  SELECT * INTO p FROM hon.saas_payment_program WHERE program_id=1;
  IF p.program_id IS NULL OR p.status <> 'TEST_MODE' OR p.provider <> 'STRIPE_SIMULATED' OR p.live_mode OR p.test_tax_reference IS NULL OR p.authorization_reference IS NULL THEN
    RAISE EXCEPTION 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE' USING ERRCODE='23514'; END IF;
END $$;

-- Billing-only access seams. Internal, never granted. Piece 2 replaces the first body; later pieces the second.
-- Contract: return a jsonb object with accessActivation in (APPLIED, EXTENDED, NEEDS_REVIEW, NOT_ATTEMPTED).
CREATE FUNCTION hon.saas_schedule_after_paid_period(p_binding uuid,p_period uuid,p_at timestamptz) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false)
$$;
CREATE FUNCTION hon.saas_schedule_after_binding_terminal(p_binding uuid,p_at timestamptz) RETURNS void
LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$ SELECT $$;

-- Closed transition table. Identity columns never change; every transition bumps version by exactly one.
CREATE FUNCTION hon.guard_saas_schedule_bindings() RETURNS trigger
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
    WHEN OLD.status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE') AND NEW.status='NEEDS_REVIEW'
      THEN ARRAY['status','status_reason','version']
    WHEN OLD.status='BOUND_TEST_ONLY' AND NEW.status='ACTIVE' AND NEW.status_reason='FIRST_PAYMENT_VERIFIED'
      THEN ARRAY['status','status_reason','version','activated_at']
    WHEN OLD.status='BOUND_TEST_ONLY' AND NEW.status='EXPIRED_UNPAID' AND NEW.status_reason='UNPAID_WINDOW_ELAPSED'
      THEN ARRAY['status','status_reason','version','terminal_at','policy_version']
  END;
  IF allowed IS NULL OR (new_row - allowed) IS DISTINCT FROM (old_row - allowed) THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION hon.guard_saas_schedule_binding_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject text; actor record; g hon.saas_subscription_generations%ROWTYPE; expected jsonb;
BEGIN
  SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id=NEW.actor_principal_id;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(subject,NEW.school_id);
  SELECT * INTO g FROM hon.saas_subscription_generations WHERE id=NEW.generation_id;
  expected:=hon.saas_schedule_requirements(g);
  PERFORM hon.saas_schedule_payment_program();
  IF g.id IS NULL OR actor.principal_id<>NEW.actor_principal_id OR actor.organization_id<>NEW.organization_id OR g.organization_id<>NEW.organization_id
    OR g.school_id<>NEW.school_id OR NEW.requirements IS DISTINCT FROM expected OR NEW.requirements_digest<>hon.saas_hon_os_digest(expected)
    OR NEW.provider<>'STRIPE_SIMULATED' OR NEW.provider_mode<>'TEST' OR NEW.status<>'PENDING_PROVIDER_BINDING' OR NEW.status_reason<>'BINDING_REQUESTED'
    OR NEW.version<>1 OR NEW.activated_at IS NOT NULL OR NEW.terminal_at IS NOT NULL OR NEW.policy_version IS NOT NULL
    OR NEW.created_at>clock_timestamp() OR NOT EXISTS(SELECT 1 FROM hon.saas_requests WHERE actor_principal_id=NEW.actor_principal_id
      AND idempotency_key=NEW.idempotency_key AND operation='saas.schedule_binding.start' AND status='IN_PROGRESS')
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- Every committed binding state must have its exact request receipt, audit row and inert outbox event.
CREATE FUNCTION hon.verify_saas_schedule_binding_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE data jsonb; expected_actor uuid; expected_key uuid; expected_operation text; expected_event text;
BEGIN
  -- Only the row's final committed version is checked; a queued firing for a superseded version is ignored.
  IF NOT EXISTS(SELECT 1 FROM hon.saas_schedule_bindings WHERE id=NEW.id AND version=NEW.version) THEN RETURN NULL; END IF;
  data:=hon.saas_schedule_binding_json(NEW);
  IF NEW.status='PENDING_PROVIDER_BINDING' THEN
    expected_actor:=NEW.actor_principal_id; expected_key:=NEW.idempotency_key; expected_operation:='saas.schedule_binding.start'; expected_event:='saas.schedule_binding.requested';
  ELSIF NEW.status='BOUND_TEST_ONLY' THEN
    expected_actor:=NEW.observed_by_principal_id; expected_key:=NEW.observation_key; expected_operation:='saas.schedule_binding.observe'; expected_event:='saas.schedule_binding.observed';
  ELSE
    -- Worker and ingest transitions: an audit row for this exact binding version and status must exist.
    IF NOT EXISTS(SELECT 1 FROM hon.saas_audit a JOIN hon.saas_outbox o ON o.audit_id=a.id
      WHERE a.entity_type='SCHEDULE_BINDING' AND a.entity_id=NEW.id AND a.organization_id=NEW.organization_id
        AND a.next_state->>'version'=NEW.version::text AND a.next_state->>'status'=NEW.status
        AND a.action_code IN ('saas.schedule_binding.reconcile','saas.schedule_binding.expire','saas.schedule_binding.transition')
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

-- Internal: one audited binding transition under a worker request key. The caller already holds the organization lock
-- and the binding row lock. Never granted.
CREATE FUNCTION hon.saas_schedule_binding_transition(p_binding hon.saas_schedule_bindings,p_status text,p_reason text,
  p_action text,p_key uuid,p_at timestamptz) RETURNS hon.saas_schedule_bindings
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE prior jsonb:=hon.saas_schedule_binding_json(p_binding); b hon.saas_schedule_bindings%ROWTYPE; actor uuid:=hon.saas_payment_actor();
BEGIN
  UPDATE hon.saas_schedule_bindings SET status=p_status,status_reason=p_reason,version=version+1,
    activated_at=CASE WHEN p_status='ACTIVE' THEN p_at ELSE activated_at END,
    terminal_at=CASE WHEN p_status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED') THEN p_at ELSE terminal_at END,
    policy_version=CASE WHEN p_status='EXPIRED_UNPAID' THEN (SELECT version FROM hon.saas_billing_lifecycle_policy WHERE policy_id=1) ELSE policy_version END
  WHERE id=p_binding.id AND version=p_binding.version RETURNING * INTO b;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.saas_claim_request(actor,p_key,p_action,hon.saas_fingerprint(ARRAY[p_action,b.id::text,b.version::text]),p_key,p_key);
  PERFORM hon.saas_record(actor,p_key,p_action,'saas.schedule_binding.transitioned','SCHEDULE_BINDING',b.id,b.organization_id,
    prior,hon.saas_schedule_binding_json(b),jsonb_build_object('binding',hon.saas_schedule_binding_json(b)),p_at);
  IF p_status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED') THEN PERFORM hon.saas_schedule_after_binding_terminal(b.id,p_at); END IF;
  RETURN b;
END $$;

-- ---------- public fixed functions ----------
CREATE FUNCTION hon.start_saas_schedule_binding(p_subject text,p_school uuid,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; replay jsonb; g hon.saas_subscription_generations%ROWTYPE; b hon.saas_schedule_bindings%ROWTYPE; req jsonb; at timestamptz:=clock_timestamp();
BEGIN
  IF NOT hon.saas_trial_keys(p,ARRAY['confirmation','generationDigest','generationId'])
    OR coalesce(p->>'generationId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR coalesce(p->>'generationDigest','') !~ '^[0-9a-f]{64}$' OR p->>'confirmation'<>'BIND_TEST_ONLY_SCHEDULE_NO_COLLECTION'
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  PERFORM hon.saas_generation_lock_authority(); SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  replay:=hon.saas_claim_request(actor.principal_id,p_key,'saas.schedule_binding.start',
    hon.saas_fingerprint(ARRAY['saas.schedule_binding.start',p_school::text,p::text]),p_request,p_correlation);
  IF replay IS NOT NULL THEN
    PERFORM hon.require_saas_school_purchaser(p_subject,p_school);
    -- The original receipt records the PENDING intent. Once observed, return the authoritative durable binding rather
    -- than repeating a provider operation on retry.
    IF coalesce(replay->'binding'->>'bindingId','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT * INTO b FROM hon.saas_schedule_bindings
        WHERE id=(replay->'binding'->>'bindingId')::uuid AND organization_id=actor.organization_id AND school_id=p_school;
      IF b.id IS NOT NULL AND b.status<>'PENDING_PROVIDER_BINDING' THEN
        RETURN jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'replayed',true);
      END IF;
    END IF;
    RETURN replay;
  END IF;
  SELECT * INTO g FROM hon.saas_subscription_generations WHERE id=(p->>'generationId')::uuid AND organization_id=actor.organization_id AND school_id=p_school;
  IF g.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF g.generation_digest<>p->>'generationDigest' THEN RAISE EXCEPTION 'SAAS_GENERATION_ACCEPTANCE_STALE' USING ERRCODE='40001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||actor.organization_id::text,0));
  PERFORM hon.saas_schedule_binding_available(actor.organization_id); PERFORM hon.saas_schedule_payment_program();
  IF EXISTS(SELECT 1 FROM hon.saas_schedule_bindings WHERE generation_id=g.id) THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_EXISTS' USING ERRCODE='40001'; END IF;
  req:=hon.saas_schedule_requirements(g);
  INSERT INTO hon.saas_schedule_bindings(binding_key,generation_id,organization_id,school_id,requirements,requirements_digest,provider,provider_mode,status,status_reason,
    actor_principal_id,idempotency_key,created_at)
  VALUES(gen_random_uuid(),g.id,actor.organization_id,p_school,req,hon.saas_hon_os_digest(req),'STRIPE_SIMULATED','TEST','PENDING_PROVIDER_BINDING','BINDING_REQUESTED',
    actor.principal_id,p_key,at) RETURNING * INTO b;
  RETURN hon.saas_record(actor.principal_id,p_key,'saas.schedule_binding.start','saas.schedule_binding.requested','SCHEDULE_BINDING',b.id,actor.organization_id,NULL,
    hon.saas_schedule_binding_json(b),jsonb_build_object('binding',hon.saas_schedule_binding_json(b)),at);
END $$;

CREATE FUNCTION hon.record_saas_schedule_binding_observation(p_binding uuid,p jsonb,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; org uuid; replay jsonb; actor uuid:=hon.saas_payment_actor(); at timestamptz:=clock_timestamp();
BEGIN
  IF p_binding IS NULL OR NOT hon.saas_trial_keys(p,ARRAY['accountReference','automaticCalendarTransition','automaticCollectionEnabled','bindingId','bindingKey','identity','mode','outcome','requirementsDigest','scheduleReference','subscriptionReference'])
    OR p->>'identity'<>'DETERMINISTIC_FAKE' OR p->>'mode'<>'TEST' OR p->>'outcome' NOT IN ('BOUND','ALREADY_BOUND')
    OR p->>'bindingId' IS DISTINCT FROM p_binding::text OR p->>'requirementsDigest' !~ '^[0-9a-f]{64}$'
    OR NOT (p->>'accountReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'subscriptionReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'scheduleReference' ~ '^fake_[a-z0-9_-]{1,150}$')
    OR jsonb_typeof(p->'automaticCalendarTransition')<>'boolean' OR p->'automaticCalendarTransition' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p->'automaticCollectionEnabled')<>'boolean' OR p->'automaticCollectionEnabled' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  PERFORM hon.saas_schedule_payment_program();
  SELECT organization_id INTO org FROM hon.saas_schedule_bindings WHERE id=p_binding;
  IF org IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||org::text,0));
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding FOR UPDATE;
  IF b.status IN ('BOUND_TEST_ONLY','ACTIVE') AND b.provider_account_reference=p->>'accountReference' AND b.provider_subscription_reference=p->>'subscriptionReference'
    AND b.provider_schedule_reference=p->>'scheduleReference' AND b.requirements_digest=p->>'requirementsDigest'
  THEN RETURN jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'replayed',true); END IF;
  IF b.status<>'PENDING_PROVIDER_BINDING' OR b.binding_key::text IS DISTINCT FROM p->>'bindingKey' OR b.requirements_digest IS DISTINCT FROM p->>'requirementsDigest'
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED' USING ERRCODE='23514'; END IF;
  replay:=hon.saas_claim_request(actor,b.id,'saas.schedule_binding.observe',hon.saas_fingerprint(ARRAY['saas.schedule_binding.observe',b.id::text,p::text]),p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  UPDATE hon.saas_schedule_bindings SET status='BOUND_TEST_ONLY',status_reason='BINDING_OBSERVED_TEST_ONLY',version=version+1,
    provider_account_reference=p->>'accountReference',provider_subscription_reference=p->>'subscriptionReference',
    provider_schedule_reference=p->>'scheduleReference',observed_by_principal_id=actor,observation_key=b.id,bound_at=at
    WHERE id=b.id RETURNING * INTO b;
  RETURN hon.saas_record(actor,b.id,'saas.schedule_binding.observe','saas.schedule_binding.observed','SCHEDULE_BINDING',b.id,b.organization_id,NULL,
    hon.saas_schedule_binding_json(b),jsonb_build_object('binding',hon.saas_schedule_binding_json(b)),at);
END $$;

-- Privileged worker: a PENDING binding whose provider outcome was never observed. The provider lookup by binding key
-- happens outside this transaction; only a definite answer is recorded (a found schedule goes through the observation).
CREATE FUNCTION hon.record_saas_schedule_binding_reconciliation(p_binding uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; org uuid; at timestamptz:=clock_timestamp();
BEGIN
  IF p_binding IS NULL OR NOT hon.saas_trial_keys(p,ARRAY['bindingId','bindingKey','identity','mode','outcome','requirementsDigest'])
    OR p->>'identity'<>'DETERMINISTIC_FAKE' OR p->>'mode'<>'TEST' OR p->>'outcome' NOT IN ('NOT_FOUND','TERMS_MISMATCH')
    OR p->>'bindingId' IS DISTINCT FROM p_binding::text OR coalesce(p->>'requirementsDigest','') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  PERFORM hon.saas_refuse_context(); PERFORM hon.saas_schedule_payment_program();
  SELECT organization_id INTO org FROM hon.saas_schedule_bindings WHERE id=p_binding;
  IF org IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||org::text,0));
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding FOR UPDATE;
  IF b.binding_key::text IS DISTINCT FROM p->>'bindingKey' OR b.requirements_digest IS DISTINCT FROM p->>'requirementsDigest'
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED' USING ERRCODE='23514'; END IF;
  IF b.status<>'PENDING_PROVIDER_BINDING' THEN RETURN jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'replayed',true); END IF;
  b:=hon.saas_schedule_binding_transition(b,CASE WHEN p->>'outcome'='NOT_FOUND' THEN 'VOIDED_PROVIDER_FAILED' ELSE 'NEEDS_REVIEW' END,
    CASE WHEN p->>'outcome'='NOT_FOUND' THEN 'PROVIDER_CONFIRMED_NOT_CREATED' ELSE 'PROVIDER_TERMS_MISMATCH' END,
    'saas.schedule_binding.reconcile',md5('saas.schedule_binding.reconcile:'||b.id::text)::uuid,at);
  RETURN jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'replayed',false);
END $$;

-- Privileged worker: bound but never paid. Requires the owner-recorded unpaid window to have elapsed AND the provider to
-- confirm the schedule was cancelled with nothing collected (fetched outside this transaction).
CREATE FUNCTION hon.record_saas_schedule_binding_expiry(p_binding uuid,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; org uuid; pol hon.saas_billing_lifecycle_policy%ROWTYPE; at timestamptz:=clock_timestamp();
BEGIN
  IF p_binding IS NULL OR NOT hon.saas_trial_keys(p,ARRAY['accountReference','bindingId','identity','mode','outcome','scheduleReference','subscriptionReference'])
    OR p->>'identity'<>'DETERMINISTIC_FAKE' OR p->>'mode'<>'TEST' OR p->>'outcome'<>'CANCELLED_NOTHING_COLLECTED'
    OR p->>'bindingId' IS DISTINCT FROM p_binding::text
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  PERFORM hon.saas_refuse_context(); PERFORM hon.saas_schedule_payment_program();
  SELECT organization_id INTO org FROM hon.saas_schedule_bindings WHERE id=p_binding;
  IF org IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||org::text,0));
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding FOR UPDATE;
  IF b.status='EXPIRED_UNPAID' THEN RETURN jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'replayed',true); END IF;
  IF b.status<>'BOUND_TEST_ONLY' OR b.provider_account_reference IS DISTINCT FROM p->>'accountReference'
    OR b.provider_subscription_reference IS DISTINCT FROM p->>'subscriptionReference' OR b.provider_schedule_reference IS DISTINCT FROM p->>'scheduleReference'
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_NOT_EXPIRABLE' USING ERRCODE='23514'; END IF;
  SELECT * INTO pol FROM hon.saas_billing_lifecycle_policy WHERE policy_id=1;
  IF pol.policy_id IS NULL OR pol.unpaid_window_minutes IS NULL THEN RAISE EXCEPTION 'SAAS_BILLING_POLICY_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  IF at < b.bound_at + make_interval(mins=>pol.unpaid_window_minutes) THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_NOT_EXPIRABLE' USING ERRCODE='23514'; END IF;
  -- Money evidence (even a reversal) must never be expired away: any stored non-failure event for this binding blocks.
  IF EXISTS(SELECT 1 FROM hon.saas_schedule_provider_events WHERE binding_id=b.id AND event_type<>'invoice.payment_failed')
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_NOT_EXPIRABLE' USING ERRCODE='23514'; END IF;
  b:=hon.saas_schedule_binding_transition(b,'EXPIRED_UNPAID','UNPAID_WINDOW_ELAPSED','saas.schedule_binding.expire',
    md5('saas.schedule_binding.expire:'||b.id::text)::uuid,at);
  RETURN jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'replayed',false);
END $$;

CREATE FUNCTION hon.read_saas_schedule_binding(p_subject text,p_school uuid,p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor record; b hon.saas_schedule_bindings%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject,p_school);
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding AND organization_id=actor.organization_id AND school_id=p_school;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF; RETURN hon.saas_schedule_binding_json(b);
END $$;
CREATE FUNCTION hon.read_saas_schedule_binding_from_hq(p_subject text,p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject,false); SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF; RETURN hon.saas_schedule_binding_json(b);
END $$;

CREATE FUNCTION hon.ingest_saas_schedule_evidence(p jsonb,p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; e hon.saas_schedule_provider_events%ROWTYPE; org uuid; bid uuid;
  req uuid:=gen_random_uuid(); at timestamptz:=clock_timestamp(); occurred_at timestamptz; period_id uuid;
  outcome text:='NEEDS_REVIEW'; reason text:='RECONCILIATION_REQUIRED'; first_payment boolean:=false; collecting boolean;
  access jsonb:=jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false); result jsonb;
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
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id AND tstzrange(q.covered_starts_at,q.covered_ends_at,'[)') && tstzrange((p->'coveredPeriod'->>'startsAt')::timestamptz,(p->'coveredPeriod'->>'endsAt')::timestamptz,'[)')) THEN reason:='OVERLAPPING_COVERED_PERIOD';
    ELSE
      -- A late earlier period is recorded normally; only overlap needs review.
      INSERT INTO hon.saas_schedule_paid_periods(binding_id,provider_invoice_reference,provider_event_id,covered_starts_at,covered_ends_at,amount_minor,currency,recorded_at)
      VALUES(b.id,p->>'invoiceReference',p->>'eventId',(p->'coveredPeriod'->>'startsAt')::timestamptz,(p->'coveredPeriod'->>'endsAt')::timestamptz,(p->>'amountMinor')::integer,'USD',at)
      RETURNING id INTO period_id; outcome:='APPLIED'; reason:='QUALIFYING_PERIOD_RECORDED'; first_payment:=b.status='BOUND_TEST_ONLY';
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

-- ---------- evidence vocabularies ----------
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_action_code_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR action_code IN (''saas.schedule_binding.start'',''saas.schedule_binding.observe'',''saas.schedule_binding.reconcile'',''saas.schedule_binding.expire'',''saas.schedule_binding.transition'',''saas.schedule_evidence.ingest''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_entity_type_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR entity_type IN (''SCHEDULE_BINDING'',''SCHEDULE_EVENT''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_outbox'::regclass AND conname='saas_outbox_event_type_check';
  ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
  EXECUTE 'ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR event_type IN (''saas.schedule_binding.requested'',''saas.schedule_binding.observed'',''saas.schedule_binding.transitioned'',''saas.schedule_evidence.recorded''))';
END $$;

-- ---------- RLS, immutability and grants ----------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_billing_lifecycle_policy','saas_schedule_bindings','saas_schedule_provider_events','saas_schedule_paid_periods','saas_schedule_reconciliations'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;
CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.saas_schedule_bindings FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_bindings();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_schedule_bindings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_schedule_bindings();
CREATE TRIGGER saas_schedule_binding_authority BEFORE INSERT ON hon.saas_schedule_bindings FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_binding_insert();
CREATE CONSTRAINT TRIGGER saas_schedule_binding_evidence AFTER INSERT OR UPDATE ON hon.saas_schedule_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_schedule_binding_evidence();
CREATE TRIGGER saas_schedule_lifecycle_exclusion BEFORE INSERT ON hon.saas_checkout_sessions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion();
CREATE TRIGGER saas_schedule_lifecycle_exclusion BEFORE INSERT ON hon.saas_subscriptions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion();
CREATE TRIGGER saas_schedule_lifecycle_exclusion BEFORE INSERT ON hon.saas_access_states FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion();
CREATE TRIGGER saas_schedule_lifecycle_exclusion BEFORE INSERT ON hon.saas_access_exceptions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion();
DO $$ DECLARE t text;r text;c text;f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_billing_lifecycle_policy','saas_schedule_provider_events','saas_schedule_paid_periods','saas_schedule_reconciliations'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['saas_billing_lifecycle_policy','saas_schedule_bindings','saas_schedule_provider_events','saas_schedule_paid_periods','saas_schedule_reconciliations'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.saas_schedule_requirements(hon.saas_subscription_generations)','hon.saas_schedule_binding_json(hon.saas_schedule_bindings)',
    'hon.saas_org_billing_conflict(uuid)','hon.saas_schedule_binding_available(uuid)','hon.guard_saas_schedule_lifecycle_exclusion()',
    'hon.saas_schedule_payment_program()','hon.saas_schedule_after_paid_period(uuid,uuid,timestamp with time zone)',
    'hon.saas_schedule_after_binding_terminal(uuid,timestamp with time zone)','hon.guard_saas_schedule_bindings()',
    'hon.guard_saas_schedule_binding_insert()','hon.verify_saas_schedule_binding_evidence()',
    'hon.saas_schedule_binding_transition(hon.saas_schedule_bindings,text,text,text,uuid,timestamp with time zone)',
    'hon.start_saas_schedule_binding(text,uuid,jsonb,uuid,uuid,uuid)','hon.record_saas_schedule_binding_observation(uuid,jsonb,uuid,uuid)',
    'hon.record_saas_schedule_binding_reconciliation(uuid,jsonb)','hon.record_saas_schedule_binding_expiry(uuid,jsonb)',
    'hon.read_saas_schedule_binding(text,uuid,uuid)','hon.read_saas_schedule_binding_from_hq(text,uuid)','hon.ingest_saas_schedule_evidence(jsonb,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.start_saas_schedule_binding(text,uuid,jsonb,uuid,uuid,uuid),hon.record_saas_schedule_binding_observation(uuid,jsonb,uuid,uuid),
      hon.record_saas_schedule_binding_reconciliation(uuid,jsonb),hon.record_saas_schedule_binding_expiry(uuid,jsonb),
      hon.read_saas_schedule_binding(text,uuid,uuid),hon.read_saas_schedule_binding_from_hq(text,uuid),hon.ingest_saas_schedule_evidence(jsonb,text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
