BEGIN;

-- Commercial B2: TEST-only generation-to-schedule binding and verified-period reconciliation.
-- This migration is intentionally additive and must merge only after the owner-prioritized 0190 A2P migration.
-- It never opens checkout, collects money, executes refunds, changes entitlements, grants paid access, or mutates B1/A2/legacy B5 facts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Commercial B2 requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Commercial B2 requires a restricted runtime';
  END IF;
  -- A B2 branch may never apply its later migration before the owner-prioritized A2P 0190 record.
  IF NOT EXISTS (SELECT 1 FROM hon.schema_migrations WHERE filename='0190_a2p_registration_preparation.sql') THEN
    RAISE EXCEPTION 'Commercial B2 requires applied predecessor 0190_a2p_registration_preparation.sql';
  END IF;
END $$;

-- Private schedule lifecycle. A review-required row remains live and blocks a second lifecycle for the organization.
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
  status text NOT NULL CHECK (status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','NEEDS_REVIEW')),
  status_reason text NOT NULL CHECK (status_reason IN ('BINDING_REQUESTED','BINDING_OBSERVED_TEST_ONLY','PROVIDER_UNAVAILABLE','PROVIDER_UNKNOWN','TERMS_MISMATCH','RECONCILIATION_REQUIRED')),
  provider_account_reference text CHECK (provider_account_reference ~ '^fake_[a-z0-9_-]{1,150}$'),
  provider_subscription_reference text UNIQUE CHECK (provider_subscription_reference ~ '^fake_[a-z0-9_-]{1,150}$'),
  provider_schedule_reference text UNIQUE CHECK (provider_schedule_reference ~ '^fake_[a-z0-9_-]{1,150}$'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  observed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  observation_key uuid UNIQUE,
  created_at timestamptz NOT NULL,
  bound_at timestamptz,
  FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key),
  FOREIGN KEY(observed_by_principal_id,observation_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key),
  UNIQUE(actor_principal_id,idempotency_key),
  CHECK (status <> 'PENDING_PROVIDER_BINDING' OR (bound_at IS NULL AND provider_account_reference IS NULL AND provider_subscription_reference IS NULL
    AND provider_schedule_reference IS NULL AND observed_by_principal_id IS NULL AND observation_key IS NULL)),
  CHECK (status <> 'BOUND_TEST_ONLY' OR (bound_at IS NOT NULL AND provider_account_reference IS NOT NULL AND provider_subscription_reference IS NOT NULL
    AND provider_schedule_reference IS NOT NULL AND observed_by_principal_id IS NOT NULL AND observation_key IS NOT NULL))
);
CREATE UNIQUE INDEX saas_schedule_binding_one_live_per_organization ON hon.saas_schedule_bindings(organization_id)
  WHERE status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','NEEDS_REVIEW');

-- A signed/normalized provider event is immutable. A missing binding is deliberately not stored: redelivery must retry after its predecessor exists.
CREATE TABLE hon.saas_schedule_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider='STRIPE_SIMULATED'),
  provider_mode text NOT NULL CHECK (provider_mode='TEST'),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  binding_id uuid NOT NULL REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created')),
  normalized jsonb NOT NULL CHECK (jsonb_typeof(normalized)='object'),
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','ALREADY_APPLIED','NEEDS_REVIEW')),
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

-- Reversals and all mismatches are evidence-only review records. They never change a qualifying period or access state.
CREATE TABLE hon.saas_schedule_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  related_period_id uuid REFERENCES hon.saas_schedule_paid_periods(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('NEEDS_REVIEW','APPLIED')),
  reason text NOT NULL CHECK (reason ~ '^[A-Z_]{3,80}$'),
  created_at timestamptz NOT NULL,
  UNIQUE(binding_id,provider_event_id)
);

-- ---------- fixed requirements and lifecycle helpers ----------
CREATE FUNCTION hon.saas_schedule_requirements(g hon.saas_subscription_generations) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE a jsonb:=g.acceptance_snapshot; s jsonb; t jsonb; result jsonb;
BEGIN
  s:=a->'schedule'; t:=s->'terms';
  IF a->>'acceptanceId' IS NULL OR a->>'acceptanceDigest' !~ '^[0-9a-f]{64}$' OR a->>'scheduleDigest' !~ '^[0-9a-f]{64}$'
    OR s->>'offerId' IS NULL OR s->>'renewalOfferId' IS NULL OR s->>'offerSetId' IS NULL OR s->>'acceptedOfferDigest' !~ '^[0-9a-f]{64}$'
    OR (t->>'initialPriceMinor') !~ '^[1-9][0-9]*$' OR (t->>'renewalPriceMinor') !~ '^[1-9][0-9]*$'
    OR t->>'currency' <> 'USD' OR t->>'billingInterval' NOT IN ('MONTHLY','ANNUAL')
    OR t->>'periodCountingRule' <> 'DISTINCT_VERIFIED_PAID_PERIODS' OR s->'refundTerms' IS NULL OR s->'cancellationTerms' IS NULL
  THEN RAISE EXCEPTION 'SAAS_GENERATION_ACCEPTANCE_INVALID' USING ERRCODE='23514'; END IF;
  result:=jsonb_build_object('generationId',g.id,'generationDigest',g.generation_digest,'organizationId',g.organization_id,'schoolId',g.school_id,
    'acceptanceId',a->>'acceptanceId','acceptanceDigest',a->>'acceptanceDigest','scheduleDigest',a->>'scheduleDigest',
    'offerId',s->>'offerId','renewalOfferId',s->>'renewalOfferId','offerSetId',s->>'offerSetId','offerSetVersion',(s->>'offerSetVersion')::integer,
    'acceptedOfferDigest',s->>'acceptedOfferDigest','disclosureVersion',a->>'disclosureVersion','disclosureText',a->>'disclosureText',
    'termsReference',s->>'termsReference','refundTerms',s->'refundTerms','cancellationTerms',s->'cancellationTerms',
    'initialAmountMinor',(t->>'initialPriceMinor')::integer,'renewalAmountMinor',(t->>'renewalPriceMinor')::integer,
    'currency','USD','billingInterval',t->>'billingInterval','introductoryPaidPeriods',(t->>'introductoryPaidPeriods')::integer,
    'periodCountingRule','DISTINCT_VERIFIED_PAID_PERIODS','automaticCalendarTransition',false,'automaticCollectionEnabled',false);
  RETURN result;
END $$;

CREATE FUNCTION hon.saas_schedule_binding_json(b hon.saas_schedule_bindings) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('bindingId',b.id,'bindingKey',b.binding_key,'generationId',b.generation_id,'generationDigest',b.requirements->>'generationDigest',
    'organizationId',b.organization_id,'schoolId',b.school_id,'requirements',b.requirements,'provider','STRIPE_SIMULATED','mode','TEST',
    'status',b.status,'statusReason',b.status_reason,'providerAccountReference',b.provider_account_reference,
    'providerSubscriptionReference',b.provider_subscription_reference,'providerScheduleReference',b.provider_schedule_reference,
    'requirementsDigest',b.requirements_digest,
    'qualifyingPaidPeriodCount',(SELECT count(*)::integer FROM hon.saas_schedule_paid_periods p WHERE p.binding_id=b.id),
    'unresolvedReconciliation',EXISTS(SELECT 1 FROM hon.saas_schedule_reconciliations r WHERE r.binding_id=b.id AND r.outcome='NEEDS_REVIEW'),
    'checkoutAvailable',false,'billingEnabled',false,'accessGranted',false,'paidAccessProgram','INACTIVE',
    'createdAt',hon.saas_ts(b.created_at),'boundAt',hon.saas_ts(b.bound_at))
$$;

CREATE FUNCTION hon.saas_schedule_binding_available(p_org uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM hon.saas_subscriptions WHERE organization_id=p_org AND status <> 'VOIDED') THEN
    RAISE EXCEPTION 'SAAS_SUBSCRIPTION_EXISTS' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM hon.saas_checkout_sessions WHERE organization_id=p_org AND status IN ('CREATED','OPEN')) THEN
    RAISE EXCEPTION 'SAAS_CHECKOUT_OPEN' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM hon.saas_access_states WHERE organization_id=p_org)
    OR hon.saas_access_exception_live(p_org) THEN RAISE EXCEPTION 'SAAS_ACCESS_EXCEPTION_ACTIVE' USING ERRCODE='23514'; END IF;
END $$;

-- Every competing lifecycle writer uses the same organization key as B2 creation. A partial B2 index alone
-- cannot prevent a checkout/access writer that began before a binding committed.
CREATE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_org uuid;
BEGIN
  v_org:=NEW.organization_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'SAAS_SCHEDULE_LIFECYCLE_CONFLICT' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||v_org::text,0));
  IF EXISTS(SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.organization_id=v_org
      AND b.status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','NEEDS_REVIEW')) THEN
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

CREATE FUNCTION hon.guard_saas_schedule_bindings() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE old_row jsonb:=to_jsonb(OLD); new_row jsonb:=to_jsonb(NEW);
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE='42501'; END IF;
  IF OLD.status='PENDING_PROVIDER_BINDING' AND NEW.status='BOUND_TEST_ONLY'
    AND NEW.bound_at IS NOT NULL AND NEW.observed_by_principal_id=hon.saas_payment_actor() AND NEW.observation_key IS NOT NULL
    AND (new_row - ARRAY['status','status_reason','provider_account_reference','provider_subscription_reference','provider_schedule_reference','observed_by_principal_id','observation_key','bound_at'])
      = (old_row - ARRAY['status','status_reason','provider_account_reference','provider_subscription_reference','provider_schedule_reference','observed_by_principal_id','observation_key','bound_at'])
  THEN RETURN NEW; END IF;
  IF OLD.status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY') AND NEW.status='NEEDS_REVIEW'
    AND (new_row - ARRAY['status','status_reason'])=(old_row - ARRAY['status','status_reason']) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE='42501';
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
    OR NEW.created_at>clock_timestamp() OR NOT EXISTS(SELECT 1 FROM hon.saas_requests WHERE actor_principal_id=NEW.actor_principal_id
      AND idempotency_key=NEW.idempotency_key AND operation='saas.schedule_binding.start' AND status='IN_PROGRESS')
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION hon.verify_saas_schedule_binding_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE data jsonb; expected_actor uuid; expected_key uuid; expected_operation text; expected_event text;
BEGIN
  data:=hon.saas_schedule_binding_json(NEW);
  IF NEW.status='PENDING_PROVIDER_BINDING' THEN
    expected_actor:=NEW.actor_principal_id; expected_key:=NEW.idempotency_key; expected_operation:='saas.schedule_binding.start'; expected_event:='saas.schedule_binding.requested';
  ELSIF NEW.status='BOUND_TEST_ONLY' THEN
    expected_actor:=NEW.observed_by_principal_id; expected_key:=NEW.observation_key; expected_operation:='saas.schedule_binding.observe'; expected_event:='saas.schedule_binding.observed';
  ELSE RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.saas_requests r JOIN hon.saas_audit a USING(actor_principal_id,idempotency_key) JOIN hon.saas_outbox o ON o.audit_id=a.id
    WHERE r.actor_principal_id=expected_actor AND r.idempotency_key=expected_key AND r.status='COMPLETED' AND r.operation=expected_operation
      AND r.response_body->'binding'=data AND a.action_code=expected_operation AND a.entity_type='SCHEDULE_BINDING' AND a.entity_id=NEW.id
      AND a.organization_id=NEW.organization_id AND a.next_state=data AND o.event_type=expected_event AND o.payload->>'executionAllowed'='false')
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
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
    -- The original request receipt records its initial PENDING intent. After the separate observation transaction
    -- completes, return the authoritative durable binding rather than repeating a provider operation on retry.
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
DECLARE b hon.saas_schedule_bindings%ROWTYPE; replay jsonb; actor uuid:=hon.saas_payment_actor(); at timestamptz:=clock_timestamp();
BEGIN
  IF p_binding IS NULL OR NOT hon.saas_trial_keys(p,ARRAY['accountReference','automaticCalendarTransition','automaticCollectionEnabled','bindingId','bindingKey','identity','mode','outcome','requirementsDigest','scheduleReference','subscriptionReference'])
    OR p->>'identity'<>'DETERMINISTIC_FAKE' OR p->>'mode'<>'TEST' OR p->>'outcome' NOT IN ('BOUND','ALREADY_BOUND')
    OR p->>'bindingId' IS DISTINCT FROM p_binding::text OR p->>'requirementsDigest' !~ '^[0-9a-f]{64}$'
    OR NOT (p->>'accountReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'subscriptionReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'scheduleReference' ~ '^fake_[a-z0-9_-]{1,150}$')
    OR jsonb_typeof(p->'automaticCalendarTransition')<>'boolean' OR p->'automaticCalendarTransition' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p->'automaticCollectionEnabled')<>'boolean' OR p->'automaticCollectionEnabled' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  PERFORM hon.saas_schedule_payment_program(); SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_binding FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  IF b.status='BOUND_TEST_ONLY' AND b.provider_account_reference=p->>'accountReference' AND b.provider_subscription_reference=p->>'subscriptionReference'
    AND b.provider_schedule_reference=p->>'scheduleReference' AND b.requirements_digest=p->>'requirementsDigest'
  THEN RETURN jsonb_build_object('binding',hon.saas_schedule_binding_json(b),'replayed',true); END IF;
  IF b.status<>'PENDING_PROVIDER_BINDING' OR b.binding_key::text IS DISTINCT FROM p->>'bindingKey' OR b.requirements_digest IS DISTINCT FROM p->>'requirementsDigest'
  THEN RAISE EXCEPTION 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED' USING ERRCODE='23514'; END IF;
  replay:=hon.saas_claim_request(actor,b.id,'saas.schedule_binding.observe',hon.saas_fingerprint(ARRAY['saas.schedule_binding.observe',b.id::text,p::text]),p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  UPDATE hon.saas_schedule_bindings SET status='BOUND_TEST_ONLY',status_reason='BINDING_OBSERVED_TEST_ONLY',provider_account_reference=p->>'accountReference',
    provider_subscription_reference=p->>'subscriptionReference',provider_schedule_reference=p->>'scheduleReference',observed_by_principal_id=actor,observation_key=b.id,bound_at=at
    WHERE id=b.id RETURNING * INTO b;
  RETURN hon.saas_record(actor,b.id,'saas.schedule_binding.observe','saas.schedule_binding.observed','SCHEDULE_BINDING',b.id,b.organization_id,NULL,
    hon.saas_schedule_binding_json(b),jsonb_build_object('binding',hon.saas_schedule_binding_json(b)),at);
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
DECLARE b hon.saas_schedule_bindings%ROWTYPE; e hon.saas_schedule_provider_events%ROWTYPE; req uuid:=gen_random_uuid(); at timestamptz:=clock_timestamp(); occurred_at timestamptz;
  count_paid integer; expected_amount integer; period_id uuid; outcome text:='NEEDS_REVIEW'; reason text:='RECONCILIATION_REQUIRED'; result jsonb;
BEGIN
  IF p_digest !~ '^[0-9a-f]{64}$' OR p_digest<>hon.saas_hon_os_digest(p)
    OR NOT hon.saas_trial_keys(p,ARRAY['accountReference','amountMinor','bindingId','coveredPeriod','currency','eventId','eventType','invoiceReference','mode','occurredAt','provider','relatedInvoiceReference','scheduleReference','subscriptionReference'])
    OR p->>'provider'<>'STRIPE_SIMULATED' OR p->>'mode'<>'TEST' OR p->>'eventId' !~ '^evt_[A-Za-z0-9_]{1,200}$'
    OR p->>'eventType' NOT IN ('invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created')
    OR coalesce(p->>'bindingId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NOT (p->>'accountReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'subscriptionReference' ~ '^fake_[a-z0-9_-]{1,150}$' AND p->>'scheduleReference' ~ '^fake_[a-z0-9_-]{1,150}$')
    OR p->>'currency'<>'USD' OR jsonb_typeof(p->'amountMinor')<>'number' OR coalesce(p->>'amountMinor','') !~ '^[1-9][0-9]*$'
    OR jsonb_typeof(p->'occurredAt')<>'string' OR coalesce(p->>'occurredAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
  THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  BEGIN occurred_at:=(p->>'occurredAt')::timestamptz;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END;
  IF occurred_at>at+interval '5 minutes' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
  -- Extract eventId before key concatenation: serialize same-event deliveries before the immutable-ledger lookup.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.schedule.provider-event:' || (p->>'eventId'),0));
  SELECT * INTO e FROM hon.saas_schedule_provider_events WHERE provider='STRIPE_SIMULATED' AND provider_event_id=p->>'eventId';
  IF e.id IS NOT NULL THEN
    IF e.payload_digest<>p_digest THEN RAISE EXCEPTION 'SAAS_SCHEDULE_EVENT_CONFLICT' USING ERRCODE='23505'; END IF;
    RETURN e.normalized->'receipt';
  END IF;
  PERFORM hon.saas_refuse_context(); PERFORM hon.saas_schedule_payment_program();
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=(p->>'bindingId')::uuid FOR UPDATE;
  IF b.id IS NULL OR b.status='PENDING_PROVIDER_BINDING' THEN RAISE EXCEPTION 'SAAS_SCHEDULE_EVENT_NOT_READY' USING ERRCODE='55P03'; END IF;
  IF b.status<>'BOUND_TEST_ONLY' OR b.provider_account_reference<>p->>'accountReference' OR b.provider_subscription_reference<>p->>'subscriptionReference'
    OR b.provider_schedule_reference<>p->>'scheduleReference' THEN RAISE EXCEPTION 'SAAS_SCHEDULE_EVENT_NOT_READY' USING ERRCODE='55P03'; END IF;
  IF p->>'eventType'='invoice.paid' THEN
    IF p->'coveredPeriod' IS NULL OR jsonb_typeof(p->'coveredPeriod')<>'object' OR jsonb_typeof(p->'coveredPeriod'->'startsAt')<>'string' OR jsonb_typeof(p->'coveredPeriod'->'endsAt')<>'string'
      OR coalesce(p->'coveredPeriod'->>'startsAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
      OR coalesce(p->'coveredPeriod'->>'endsAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
      OR p->>'invoiceReference' !~ '^fake_[a-z0-9_-]{1,150}$' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023'; END IF;
    SELECT count(*)::integer INTO count_paid FROM hon.saas_schedule_paid_periods WHERE binding_id=b.id;
    expected_amount:=CASE WHEN (b.requirements->>'introductoryPaidPeriods')::integer>count_paid THEN (b.requirements->>'initialAmountMinor')::integer ELSE (b.requirements->>'renewalAmountMinor')::integer END;
    IF (p->>'amountMinor')::integer<>expected_amount THEN reason:='AMOUNT_MISMATCH';
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id AND q.provider_invoice_reference=p->>'invoiceReference') THEN outcome:='ALREADY_APPLIED'; reason:='DUPLICATE_INVOICE_REFERENCE';
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id
      AND (p->'coveredPeriod'->>'startsAt')::timestamptz < q.covered_starts_at) THEN reason:='OUT_OF_ORDER_COVERED_PERIOD';
    ELSIF EXISTS(SELECT 1 FROM hon.saas_schedule_paid_periods q WHERE q.binding_id=b.id AND tstzrange(q.covered_starts_at,q.covered_ends_at,'[)') && tstzrange((p->'coveredPeriod'->>'startsAt')::timestamptz,(p->'coveredPeriod'->>'endsAt')::timestamptz,'[)')) THEN reason:='OVERLAPPING_COVERED_PERIOD';
    ELSE
      INSERT INTO hon.saas_schedule_paid_periods(binding_id,provider_invoice_reference,provider_event_id,covered_starts_at,covered_ends_at,amount_minor,currency,recorded_at)
      VALUES(b.id,p->>'invoiceReference',p->>'eventId',(p->'coveredPeriod'->>'startsAt')::timestamptz,(p->'coveredPeriod'->>'endsAt')::timestamptz,(p->>'amountMinor')::integer,'USD',at)
      RETURNING id INTO period_id; outcome:='APPLIED'; reason:='QUALIFYING_PERIOD_RECORDED';
    END IF;
  ELSIF p->>'eventType'='invoice.payment_failed' THEN reason:='PAYMENT_NOT_VERIFIED';
  ELSE
    SELECT id INTO period_id FROM hon.saas_schedule_paid_periods WHERE binding_id=b.id AND provider_invoice_reference=p->>'relatedInvoiceReference';
    reason:=CASE WHEN period_id IS NULL THEN 'UNLINKED_REVERSAL' ELSE 'REVERSAL_REVIEW_REQUIRED' END;
  END IF;
  result:=jsonb_build_object('providerEventId',p->>'eventId','bindingId',b.id,'outcome',outcome,'reason',reason,
    'qualifyingPaidPeriodCount',(SELECT count(*)::integer FROM hon.saas_schedule_paid_periods WHERE binding_id=b.id),
    'checkoutAvailable',false,'billingEnabled',false,'accessGranted',false,'paidAccessProgram','INACTIVE');
  PERFORM hon.saas_claim_request(hon.saas_payment_actor(),req,'saas.schedule_evidence.ingest',hon.saas_fingerprint(ARRAY['saas.schedule_evidence.ingest',p->>'eventId',p_digest]),req,req);
  INSERT INTO hon.saas_schedule_provider_events(provider,provider_mode,provider_event_id,payload_digest,binding_id,event_type,normalized,outcome,outcome_reason,request_key,provider_occurred_at,received_at)
    VALUES('STRIPE_SIMULATED','TEST',p->>'eventId',p_digest,b.id,p->>'eventType',p||jsonb_build_object('receipt',result),outcome,reason,req,occurred_at,at);
  IF outcome='NEEDS_REVIEW' THEN INSERT INTO hon.saas_schedule_reconciliations(binding_id,provider_event_id,related_period_id,outcome,reason,created_at)
    VALUES(b.id,p->>'eventId',period_id,'NEEDS_REVIEW',reason,at); END IF;
  PERFORM hon.saas_record(hon.saas_payment_actor(),req,'saas.schedule_evidence.ingest','saas.schedule_evidence.recorded','SCHEDULE_EVENT',
    (SELECT id FROM hon.saas_schedule_provider_events WHERE provider='STRIPE_SIMULATED' AND provider_event_id=p->>'eventId'),b.organization_id,NULL,result,result,at);
  RETURN result;
END $$;

-- ---------- evidence vocabularies ----------
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_action_code_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR action_code IN (''saas.schedule_binding.start'',''saas.schedule_binding.observe'',''saas.schedule_evidence.ingest''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_entity_type_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR entity_type IN (''SCHEDULE_BINDING'',''SCHEDULE_EVENT''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_outbox'::regclass AND conname='saas_outbox_event_type_check';
  ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
  EXECUTE 'ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR event_type IN (''saas.schedule_binding.requested'',''saas.schedule_binding.observed'',''saas.schedule_evidence.recorded''))';
END $$;

-- ---------- RLS, immutability and grants ----------
ALTER TABLE hon.saas_schedule_bindings ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.saas_schedule_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.saas_schedule_provider_events ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.saas_schedule_provider_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.saas_schedule_paid_periods ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.saas_schedule_paid_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.saas_schedule_reconciliations ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.saas_schedule_reconciliations FORCE ROW LEVEL SECURITY;
CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.saas_schedule_bindings FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_bindings();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_schedule_bindings FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_schedule_bindings();
CREATE TRIGGER saas_schedule_binding_authority BEFORE INSERT ON hon.saas_schedule_bindings FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_binding_insert();
CREATE CONSTRAINT TRIGGER saas_schedule_binding_evidence AFTER INSERT OR UPDATE ON hon.saas_schedule_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.verify_saas_schedule_binding_evidence();
CREATE TRIGGER saas_schedule_lifecycle_exclusion BEFORE INSERT ON hon.saas_checkout_sessions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion();
CREATE TRIGGER saas_schedule_lifecycle_exclusion BEFORE INSERT ON hon.saas_subscriptions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion();
CREATE TRIGGER saas_schedule_lifecycle_exclusion BEFORE INSERT ON hon.saas_access_states FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion();
CREATE TRIGGER saas_schedule_lifecycle_exclusion BEFORE INSERT ON hon.saas_access_exceptions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_schedule_lifecycle_exclusion();
DO $$ DECLARE t text;r text;c text;f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_schedule_provider_events','saas_schedule_paid_periods','saas_schedule_reconciliations'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['saas_schedule_bindings','saas_schedule_provider_events','saas_schedule_paid_periods','saas_schedule_reconciliations'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('hon.%I',t)::regclass AND attnum>0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC',c,t);
      FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM %I',c,t,r); END LOOP;
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.saas_schedule_requirements(hon.saas_subscription_generations)','hon.saas_schedule_binding_json(hon.saas_schedule_bindings)',
    'hon.saas_schedule_binding_available(uuid)','hon.guard_saas_schedule_lifecycle_exclusion()','hon.saas_schedule_payment_program()','hon.guard_saas_schedule_bindings()','hon.guard_saas_schedule_binding_insert()',
    'hon.verify_saas_schedule_binding_evidence()','hon.start_saas_schedule_binding(text,uuid,jsonb,uuid,uuid,uuid)',
    'hon.record_saas_schedule_binding_observation(uuid,jsonb,uuid,uuid)','hon.read_saas_schedule_binding(text,uuid,uuid)',
    'hon.read_saas_schedule_binding_from_hq(text,uuid)','hon.ingest_saas_schedule_evidence(jsonb,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.start_saas_schedule_binding(text,uuid,jsonb,uuid,uuid,uuid),hon.record_saas_schedule_binding_observation(uuid,jsonb,uuid,uuid),
      hon.read_saas_schedule_binding(text,uuid,uuid),hon.read_saas_schedule_binding_from_hq(text,uuid),hon.ingest_saas_schedule_evidence(jsonb,text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
