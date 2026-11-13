BEGIN;

-- 0309: a verified refund inside the refund window ends lifetime access (owner D2, 2026-11-12; sale stays counted, owner 2026-11-13).
--   * TEST provider only. HON never refunds anything: it records the provider's own charge.refunded event, as 0237 does.
--   * Ends access only when the stored refund (1) names the counted lifetime payment's invoice, (2) covers its full amount
--     and (3) is received within the offer's refundWindowDays of the verified payment, on an ACTIVE lifetime binding.
--     In the same ingest transaction, under the binding lock: the binding goes to the new terminal status REFUNDED_ENDED,
--     the entitlement goes back to SUSPENDED and ends now, and the access state goes back to awaiting a first payment.
--     If ending access cannot be recorded, the whole delivery fails and the provider retries it (never half-ended).
--   * Everything else is held for HQ review, unchanged: a partial refund, a refund after the window, a dispute, or any
--     refund on a binding that is already in review.
--   * The lifetime sale stays counted and never returns to HQ's sale limit.
--   * Afterwards the school may sign up again at any price on sale (founder lifetime only while still eligible). Any money
--     that reaches an ended binding later is held, listed for HQ and blocks a new sign-up until HQ resolves it.
--   * The paid-access program stays INACTIVE. No checkout, provider call, live payment, refund or credit is enabled.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS lifetime refund requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS lifetime refund requires a restricted runtime';
  END IF;
END $$;

-- ---------- binding: one new terminal status and reason (constraints located by definition) ----------
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_schedule_bindings'::regclass AND conname='saas_schedule_bindings_status_check';
  IF def IS NULL OR position('CANCELLED_BEFORE_PAYMENT' IN def)=0 OR position('REFUNDED_ENDED' IN def)>0 THEN RAISE EXCEPTION 'saas_schedule_bindings status constraint drifted'; END IF;
  ALTER TABLE hon.saas_schedule_bindings DROP CONSTRAINT saas_schedule_bindings_status_check;
  ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_status_check CHECK (status IN ('PENDING_PROVIDER_BINDING',
    'BOUND_TEST_ONLY','ACTIVE','NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED'));
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_schedule_bindings'::regclass AND conname='saas_schedule_bindings_status_reason_check';
  IF def IS NULL OR position('LIFETIME_SALE_LIMIT_REACHED' IN def)=0 THEN RAISE EXCEPTION 'saas_schedule_bindings status_reason constraint drifted'; END IF;
  ALTER TABLE hon.saas_schedule_bindings DROP CONSTRAINT saas_schedule_bindings_status_reason_check;
  ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_status_reason_check CHECK (status_reason IN ('BINDING_REQUESTED',
    'BINDING_OBSERVED_TEST_ONLY','FIRST_PAYMENT_VERIFIED','PROVIDER_CONFIRMED_NOT_CREATED','PROVIDER_TERMS_MISMATCH','UNPAID_WINDOW_ELAPSED',
    'AMOUNT_MISMATCH','OVERLAPPING_COVERED_PERIOD','REVERSAL_REVIEW_REQUIRED','UNLINKED_REVERSAL','PURCHASER_CANCELLED_BEFORE_PAYMENT',
    'PERIOD_INTERVAL_MISMATCH','REVIEW_REFUND_VERIFIED','FOUNDER_SPOT_UNAVAILABLE','LIFETIME_SALE_LIMIT_REACHED','LIFETIME_REFUND_IN_WINDOW'));
  SELECT conname INTO def FROM pg_constraint WHERE conrelid='hon.saas_schedule_bindings'::regclass AND contype='c'
    AND pg_get_constraintdef(oid)='CHECK (((status = ANY (ARRAY[''EXPIRED_UNPAID''::text, ''VOIDED_PROVIDER_FAILED''::text, ''CANCELLED_BEFORE_PAYMENT''::text])) = (terminal_at IS NOT NULL)))';
  IF def IS NULL THEN RAISE EXCEPTION 'saas_schedule_bindings terminal constraint drifted'; END IF;
  EXECUTE format('ALTER TABLE hon.saas_schedule_bindings DROP CONSTRAINT %I',def);
END $$;
ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_terminal_at CHECK (
  (status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED')) = (terminal_at IS NOT NULL));
-- An ended lifetime plan was bound, paid and active before it ended.
ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_refunded_ended CHECK (status <> 'REFUNDED_ENDED'
  OR (bound_at IS NOT NULL AND activated_at IS NOT NULL AND status_reason = 'LIFETIME_REFUND_IN_WINDOW' AND requirements->>'billingInterval' = 'ONE_TIME'));

-- ---------- access transitions: the end of a lifetime plan ----------
ALTER TABLE hon.saas_access_transitions DROP CONSTRAINT saas_access_transitions_kind_check;
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_kind_check CHECK (kind IN ('AWAITING_FIRST_PAYMENT',
  'FIRST_PAYMENT_ACTIVATION','PAST_DUE_SUSPENSION','SCHEDULE_FIRST_PAYMENT_ACTIVATION','SCHEDULE_RENEWAL_EXTENSION','SCHEDULE_REFUND_ENDED'));
ALTER TABLE hon.saas_access_transitions DROP CONSTRAINT saas_access_transitions_schedule_check;
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_schedule_check CHECK (
  (kind IN ('SCHEDULE_FIRST_PAYMENT_ACTIVATION','SCHEDULE_RENEWAL_EXTENSION','SCHEDULE_REFUND_ENDED')) = (binding_id IS NOT NULL AND paid_period_id IS NOT NULL));
ALTER TABLE hon.saas_access_transitions ADD CONSTRAINT saas_access_transitions_refund_ended CHECK (kind <> 'SCHEDULE_REFUND_ENDED'
  OR (outcome = 'APPLIED' AND reason = 'LIFETIME_REFUND_IN_WINDOW' AND provider_event_id IS NOT NULL));
-- A school whose lifetime plan ended may buy again, so one organization can have a second applied activation (on a new
-- binding). Still one per binding (0235), one live binding per organization (0230) and awaiting -> active only under the
-- access-state row lock (guard_saas_access).
DROP INDEX hon.saas_access_one_schedule_activation_per_org;
-- The ending refund names the same paid period its activation used; each period still applies to access once.
DROP INDEX hon.saas_access_one_applied_per_paid_period;
CREATE UNIQUE INDEX saas_access_one_applied_per_paid_period ON hon.saas_access_transitions (paid_period_id)
  WHERE outcome = 'APPLIED' AND paid_period_id IS NOT NULL AND kind <> 'SCHEDULE_REFUND_ENDED';
CREATE UNIQUE INDEX saas_access_one_refund_end_per_binding ON hon.saas_access_transitions (binding_id) WHERE kind = 'SCHEDULE_REFUND_ENDED';

-- ---------- binding transitions (0230 body; REFUNDED_ENDED is terminal) ----------
CREATE OR REPLACE FUNCTION hon.saas_schedule_binding_transition(p_binding hon.saas_schedule_bindings,p_status text,p_reason text,
  p_action text,p_key uuid,p_at timestamptz) RETURNS hon.saas_schedule_bindings
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE prior jsonb:=hon.saas_schedule_binding_json(p_binding); b hon.saas_schedule_bindings%ROWTYPE; actor uuid:=hon.saas_payment_actor();
BEGIN
  UPDATE hon.saas_schedule_bindings SET status=p_status,status_reason=p_reason,version=version+1,
    activated_at=CASE WHEN p_status='ACTIVE' THEN p_at ELSE activated_at END,
    terminal_at=CASE WHEN p_status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','REFUNDED_ENDED') THEN p_at ELSE terminal_at END,
    policy_version=CASE WHEN p_status='EXPIRED_UNPAID' THEN (SELECT version FROM hon.saas_billing_lifecycle_policy WHERE policy_id=1) ELSE policy_version END
  WHERE id=p_binding.id AND version=p_binding.version RETURNING * INTO b;
  IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  PERFORM hon.saas_claim_request(actor,p_key,p_action,hon.saas_fingerprint(ARRAY[p_action,b.id::text,b.version::text]),p_key,p_key);
  PERFORM hon.saas_record(actor,p_key,p_action,'saas.schedule_binding.transitioned','SCHEDULE_BINDING',b.id,b.organization_id,
    prior,hon.saas_schedule_binding_json(b),jsonb_build_object('binding',hon.saas_schedule_binding_json(b)),p_at);
  IF p_status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED') THEN PERFORM hon.saas_schedule_after_binding_terminal(b.id,p_at); END IF;
  RETURN b;
END $$;

-- ---------- closed binding transition table (0237 body plus ACTIVE -> REFUNDED_ENDED for a lifetime plan) ----------
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
    WHEN OLD.status IN ('PENDING_PROVIDER_BINDING','BOUND_TEST_ONLY','ACTIVE') AND NEW.status='NEEDS_REVIEW' AND NEW.status_reason<>'REVIEW_REFUND_VERIFIED'
      THEN ARRAY['status','status_reason','version']
    WHEN OLD.status='BOUND_TEST_ONLY' AND NEW.status='ACTIVE' AND NEW.status_reason='FIRST_PAYMENT_VERIFIED'
      THEN ARRAY['status','status_reason','version','activated_at']
    WHEN OLD.status='BOUND_TEST_ONLY' AND NEW.status='EXPIRED_UNPAID' AND NEW.status_reason='UNPAID_WINDOW_ELAPSED'
      THEN ARRAY['status','status_reason','version','terminal_at','policy_version']
    WHEN OLD.status='BOUND_TEST_ONLY' AND NEW.status='CANCELLED_BEFORE_PAYMENT' AND NEW.status_reason='PURCHASER_CANCELLED_BEFORE_PAYMENT'
      THEN ARRAY['status','status_reason','version','terminal_at']
    -- Piece 3: a verified full refund of every held payment returns the plan to where it was (owner decision 2026-11-09).
    WHEN OLD.status='NEEDS_REVIEW' AND NEW.status='ACTIVE' AND NEW.status_reason='REVIEW_REFUND_VERIFIED' AND OLD.activated_at IS NOT NULL
      THEN ARRAY['status','status_reason','version']
    WHEN OLD.status='NEEDS_REVIEW' AND NEW.status='BOUND_TEST_ONLY' AND NEW.status_reason='REVIEW_REFUND_VERIFIED' AND OLD.activated_at IS NULL
      AND OLD.bound_at IS NOT NULL THEN ARRAY['status','status_reason','version']
    -- 0309 (owner D2): a verified full refund inside the window ends an active lifetime plan, from the ingest path only.
    WHEN OLD.status='ACTIVE' AND NEW.status='REFUNDED_ENDED' AND NEW.status_reason='LIFETIME_REFUND_IN_WINDOW'
      AND OLD.requirements->>'billingInterval'='ONE_TIME' AND NEW.terminal_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM hon.saas_lifetime_sales ls WHERE ls.binding_id=OLD.id)
      THEN ARRAY['status','status_reason','version','terminal_at']
  END;
  IF allowed IS NULL OR (new_row - allowed) IS DISTINCT FROM (old_row - allowed) THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  -- Only the refund-verification command may take a binding out of review, and only with its verified resolution present.
  IF NEW.status_reason='REVIEW_REFUND_VERIFIED' AND NOT EXISTS(SELECT 1 FROM hon.saas_paid_review_resolutions r JOIN hon.saas_requests q
      ON q.actor_principal_id=r.verified_by_principal_id AND q.idempotency_key=r.verification_key
    WHERE r.binding_id=NEW.id AND r.status='REFUND_VERIFIED' AND q.status='IN_PROGRESS' AND q.operation='saas.paid_review.verify_refund') THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

-- ---------- binding evidence (0237 body; the ending is an ingest transition) ----------
CREATE OR REPLACE FUNCTION hon.verify_saas_schedule_binding_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE data jsonb; expected_actor uuid; expected_key uuid; expected_operation text; expected_event text;
BEGIN
  -- Only the row's final committed version is checked; a queued firing for a superseded version is ignored.
  IF NOT EXISTS(SELECT 1 FROM hon.saas_schedule_bindings WHERE id=NEW.id AND version=NEW.version) THEN RETURN NULL; END IF;
  data:=hon.saas_schedule_binding_json(NEW);
  IF NEW.status='PENDING_PROVIDER_BINDING' THEN
    expected_actor:=NEW.actor_principal_id; expected_key:=NEW.idempotency_key; expected_operation:='saas.schedule_binding.start'; expected_event:='saas.schedule_binding.requested';
  ELSIF NEW.status='BOUND_TEST_ONLY' AND NEW.status_reason<>'REVIEW_REFUND_VERIFIED' THEN
    expected_actor:=NEW.observed_by_principal_id; expected_key:=NEW.observation_key; expected_operation:='saas.schedule_binding.observe'; expected_event:='saas.schedule_binding.observed';
  ELSE
    -- Worker, ingest and review transitions: an audit row for this exact binding version and status must exist.
    IF NOT EXISTS(SELECT 1 FROM hon.saas_audit a JOIN hon.saas_outbox o ON o.audit_id=a.id
      WHERE a.entity_type='SCHEDULE_BINDING' AND a.entity_id=NEW.id AND a.organization_id=NEW.organization_id
        AND a.next_state->>'version'=NEW.version::text AND a.next_state->>'status'=NEW.status
        AND a.action_code = ANY(CASE WHEN NEW.status_reason='REVIEW_REFUND_VERIFIED' THEN ARRAY['saas.paid_review.verify_refund']
          ELSE CASE NEW.status WHEN 'ACTIVE' THEN ARRAY['saas.schedule_binding.transition'] WHEN 'REFUNDED_ENDED' THEN ARRAY['saas.schedule_binding.transition']
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

-- ---------- access state (0235 body plus the end of a refunded lifetime plan) ----------
CREATE OR REPLACE FUNCTION hon.guard_saas_access() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND NEW.organization_id = OLD.organization_id AND NEW.created_at = OLD.created_at THEN
    IF OLD.state = 'AWAITING_FIRST_PAYMENT' AND NEW.state = 'PAYMENT_ACTIVE' THEN RETURN NEW; END IF;
    IF OLD.state = 'PAYMENT_ACTIVE' AND NEW.state = 'PAYMENT_ACTIVE' AND OLD.activation_source = 'SCHEDULE_BINDING'
      AND NEW.paid_through > OLD.paid_through
      AND (to_jsonb(NEW) - ARRAY['paid_through','version','changed_by_principal_id','updated_at'])
        = (to_jsonb(OLD) - ARRAY['paid_through','version','changed_by_principal_id','updated_at']) THEN RETURN NEW; END IF;
    -- 0309 (owner D2): lifetime access granted by a binding that a verified in-window refund just ended goes back to
    -- awaiting a first payment, so the school may buy again. Nothing else on the row changes.
    IF OLD.state = 'PAYMENT_ACTIVE' AND NEW.state = 'AWAITING_FIRST_PAYMENT' AND NEW.reason = 'AWAITING_INITIAL_PAYMENT'
      AND OLD.activation_source = 'SCHEDULE_BINDING'
      AND EXISTS (SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.id = OLD.binding_id AND b.status = 'REFUNDED_ENDED')
      AND (to_jsonb(NEW) - ARRAY['state','reason','activation_source','binding_id','first_paid_period_id','paid_through','version','changed_by_principal_id','updated_at'])
        = (to_jsonb(OLD) - ARRAY['state','reason','activation_source','binding_id','first_paid_period_id','paid_through','version','changed_by_principal_id','updated_at'])
      THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE = '42501';
END $$;

-- ---------- end lifetime access (internal; the caller holds the organization lock and the binding row lock) ----------
-- Access granted from this binding goes back to awaiting a first payment and the entitlement ends now. If access was never
-- switched on (for example while the paid-access program is INACTIVE) only the record is written. Raises on any failure.
CREATE FUNCTION hon.saas_schedule_end_lifetime_access(p_binding uuid, p_period uuid, p_event text, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); b hon.saas_schedule_bindings%ROWTYPE; ent hon.organization_entitlements%ROWTYPE;
  st hon.saas_access_states%ROWTYPE; prior jsonb;
BEGIN
  SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id = p_binding;
  IF b.id IS NULL OR b.status <> 'REFUNDED_ENDED'
    OR NOT EXISTS (SELECT 1 FROM hon.saas_lifetime_sales ls WHERE ls.binding_id = b.id AND ls.paid_period_id = p_period) THEN
    RAISE EXCEPTION 'SAAS_ACCESS_HOOK_INPUT';
  END IF;
  -- Canonical order after the binding: entitlement, then access state.
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = b.organization_id FOR UPDATE;
  SELECT * INTO st FROM hon.saas_access_states WHERE organization_id = b.organization_id FOR UPDATE;
  prior := hon.saas_entitlement_json(b.organization_id);
  IF st.state = 'PAYMENT_ACTIVE' AND st.binding_id = b.id THEN
    UPDATE hon.organization_entitlements SET status = 'SUSPENDED', effective_until = greatest(p_at, effective_from + interval '1 microsecond'),
        version = version + 1, updated_at = p_at
      WHERE organization_id = b.organization_id AND version = ent.version;
    IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    UPDATE hon.saas_access_states SET state = 'AWAITING_FIRST_PAYMENT', reason = 'AWAITING_INITIAL_PAYMENT', activation_source = NULL,
        binding_id = NULL, first_paid_period_id = NULL, paid_through = NULL, version = version + 1, changed_by_principal_id = actor, updated_at = p_at
      WHERE organization_id = b.organization_id AND version = st.version;
    IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  END IF;
  INSERT INTO hon.saas_access_transitions(organization_id, kind, outcome, reason, binding_id, paid_period_id, provider_event_id,
      prior_entitlement, next_entitlement, actor_principal_id, occurred_at)
    VALUES (b.organization_id, 'SCHEDULE_REFUND_ENDED', 'APPLIED', 'LIFETIME_REFUND_IN_WINDOW', b.id, p_period, p_event,
      prior, hon.saas_entitlement_json(b.organization_id), actor, p_at);
  RETURN jsonb_build_object('accessActivation','ENDED','accessGranted',false);
END $$;

-- ---------- binding access read (0235 body plus ENDED) ----------
CREATE OR REPLACE FUNCTION hon.saas_schedule_access_json(p_binding uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE
    -- 0309: a lifetime plan ended by an in-window refund reports ENDED, whether or not access had been switched on.
    WHEN ended.id IS NOT NULL THEN jsonb_build_object('accessActivation','ENDED','reason',NULL,'paidThrough',NULL,'accessUntil',NULL)
    WHEN applied.id IS NOT NULL THEN jsonb_build_object('accessActivation','APPLIED','reason',NULL,
      'paidThrough',hon.saas_ts(st.paid_through),'accessUntil',hon.saas_ts(st.paid_through + hon.saas_schedule_access_grace()))
    WHEN review.id IS NOT NULL THEN jsonb_build_object('accessActivation','NEEDS_REVIEW','reason',review.reason,'paidThrough',NULL,'accessUntil',NULL)
    ELSE jsonb_build_object('accessActivation','NOT_ATTEMPTED','reason',NULL,'paidThrough',NULL,'accessUntil',NULL) END
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT t.id FROM hon.saas_access_transitions t WHERE t.binding_id = p_binding
    AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION' AND t.outcome = 'APPLIED' LIMIT 1) applied ON true
  LEFT JOIN LATERAL (SELECT t.id, t.reason FROM hon.saas_access_transitions t WHERE t.binding_id = p_binding
    AND t.kind = 'SCHEDULE_FIRST_PAYMENT_ACTIVATION' AND t.outcome = 'NEEDS_REVIEW' ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1) review ON true
  LEFT JOIN LATERAL (SELECT t.id FROM hon.saas_access_transitions t WHERE t.binding_id = p_binding
    AND t.kind = 'SCHEDULE_REFUND_ENDED' AND t.outcome = 'APPLIED' LIMIT 1) ended ON true
  LEFT JOIN hon.saas_access_states st ON st.binding_id = p_binding
$$;

-- ---------- ingest (0306 body plus the in-window lifetime refund) ----------
CREATE OR REPLACE FUNCTION hon.ingest_saas_schedule_evidence(p jsonb,p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.saas_schedule_bindings%ROWTYPE; e hon.saas_schedule_provider_events%ROWTYPE; org uuid; bid uuid;
  req uuid:=gen_random_uuid(); at timestamptz:=clock_timestamp(); occurred_at timestamptz; period_id uuid;
  outcome text:='NEEDS_REVIEW'; reason text:='RECONCILIATION_REQUIRED'; first_payment boolean:=false; collecting boolean;
  access jsonb:=jsonb_build_object('accessActivation','NOT_ATTEMPTED','accessGranted',false); result jsonb; founder_offer uuid;
  lifetime_offer uuid; covered_ends timestamptz; covered_starts timestamptz; ending boolean:=false;
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
    IF (p->>'amountMinor')::integer<>(b.requirements->>'lockedPriceMinor')::integer THEN reason:='AMOUNT_MISMATCH';
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

-- ---------- paid review: the ending refund is not a reversal; money reaching an ended plan is held and listed (0237 bodies) ----------
CREATE OR REPLACE FUNCTION hon.saas_paid_review_items(p_kind text,p_subject uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
  IF p_kind='SCHEDULE_BINDING' THEN
    WITH held_events AS (
      SELECT e.provider_event_id, e.normalized->>'invoiceReference' AS ref, (e.normalized->>'amountMinor')::bigint AS amount, e.received_at
      FROM hon.saas_schedule_provider_events e WHERE e.binding_id=p_subject AND e.event_type='invoice.paid' AND e.outcome='NEEDS_REVIEW'),
    held AS (SELECT ref, min(amount) AS amount, max(amount) AS amount_hi, min(received_at) AS received_at FROM held_events GROUP BY ref),
    reversals AS (
      SELECT e.provider_event_id, e.event_type, e.normalized->>'relatedInvoiceReference' AS ref, (e.normalized->>'amountMinor')::bigint AS amount
      FROM hon.saas_schedule_provider_events e WHERE e.binding_id=p_subject AND e.event_type IN ('charge.refunded','charge.dispute.created')
        -- 0309: the refund that ended a lifetime plan was applied, not held; it is never a reversal to review.
        AND e.outcome<>'APPLIED'),
    per_ref AS (
      SELECT h.ref, h.amount, h.amount_hi, h.received_at,
        (SELECT max(r.amount) FROM reversals r WHERE r.event_type='charge.refunded' AND r.ref=h.ref) AS refunded
      FROM held h)
    SELECT jsonb_build_object(
      'itemCount',(SELECT count(*)::integer FROM hon.saas_schedule_reconciliations WHERE binding_id=p_subject),
      'heldItemCount',(SELECT count(*)::integer FROM per_ref),
      'heldAmountMinor',(SELECT coalesce(sum(amount),0) FROM per_ref),
      'refundedAmountMinor',(SELECT coalesce(sum(least(refunded,amount)),0) FROM per_ref),
      'firstHeldAt',(SELECT hon.saas_ts(min(received_at)) FROM per_ref),
      'fullyRefunded',(SELECT count(*)>0 AND bool_and(refunded IS NOT NULL AND refunded=amount) FROM per_ref),
      'refundEvidence',(SELECT coalesce(jsonb_agg(r.provider_event_id ORDER BY r.provider_event_id),'[]'::jsonb) FROM reversals r
        WHERE r.event_type='charge.refunded' AND r.ref IN (SELECT ref FROM held)),
      'blocker',CASE
        WHEN NOT EXISTS(SELECT 1 FROM per_ref) THEN 'NO_HELD_PAYMENT'
        WHEN EXISTS(SELECT 1 FROM per_ref WHERE ref IS NULL OR amount<>amount_hi)
          OR EXISTS(SELECT 1 FROM per_ref h JOIN hon.saas_schedule_paid_periods q ON q.binding_id=p_subject AND q.provider_invoice_reference=h.ref)
          THEN 'HELD_PAYMENT_CONFLICT'
        WHEN EXISTS(SELECT 1 FROM reversals WHERE event_type='charge.dispute.created') THEN 'DISPUTE_POLICY_REQUIRED'
        WHEN EXISTS(SELECT 1 FROM reversals r WHERE r.ref IS NULL OR r.ref NOT IN (SELECT ref FROM held WHERE ref IS NOT NULL)) THEN 'REVERSAL_POLICY_REQUIRED'
      END) INTO result;
  ELSIF p_kind='V1_CHECKOUT' THEN
    -- A v1 payment is identified by its payment intent (one-time) or its first invoice (subscription mode); a refund or
    -- dispute matches when it reports either of those references.
    WITH c AS (SELECT * FROM hon.saas_checkout_sessions WHERE id=p_subject),
    held_events AS (
      SELECT e.provider_event_id, coalesce(e.normalized->'object'->>'paymentIntentRef',e.normalized->'object'->>'invoiceRef') AS ref,
        array_remove(ARRAY[e.normalized->'object'->>'paymentIntentRef',e.normalized->'object'->>'invoiceRef'],NULL) AS refs,
        (e.normalized->'object'->>'amountTotal')::bigint AS amount, e.received_at
      FROM hon.saas_provider_events e JOIN c ON e.checkout_id=c.id AND e.provider=c.provider
      WHERE e.event_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded')
        AND e.normalized->'object'->>'paymentStatus'='paid' AND e.outcome='NEEDS_REVIEW'),
    held AS (SELECT ref, min(amount) AS amount, max(amount) AS amount_hi, min(received_at) AS received_at,
      (SELECT array_agg(DISTINCT x) FROM held_events h2, unnest(h2.refs) x WHERE h2.ref IS NOT DISTINCT FROM h.ref) AS refs
      FROM held_events h GROUP BY ref),
    direct_reversals AS (
      SELECT e.provider_event_id, e.event_type, h.ref, e.normalized->'object'->>'chargeRef' AS charge_ref,
        CASE WHEN e.event_type='charge.refunded' THEN (e.normalized->'object'->>'amountRefunded')::bigint END AS amount
      FROM hon.saas_provider_events e JOIN c ON e.provider=c.provider JOIN held h ON h.ref IS NOT NULL
        AND (e.normalized->'object'->>'paymentIntentRef'=ANY(h.refs) OR e.normalized->'object'->>'invoiceRef'=ANY(h.refs))
      WHERE e.event_type IN ('charge.refunded','charge.dispute.created')),
    -- A dispute carries no invoice; in subscription mode it is matched through the charge of a matched refund.
    reversals AS (
      SELECT provider_event_id, event_type, ref, amount FROM direct_reversals
      UNION
      SELECT e.provider_event_id, e.event_type, d.ref, NULL::bigint
      FROM hon.saas_provider_events e JOIN c ON e.provider=c.provider
        JOIN direct_reversals d ON d.event_type='charge.refunded' AND d.charge_ref IS NOT NULL AND e.normalized->'object'->>'chargeRef'=d.charge_ref
      WHERE e.event_type='charge.dispute.created'),
    per_ref AS (
      SELECT h.ref, h.amount, h.amount_hi, h.received_at,
        (SELECT max(r.amount) FROM reversals r WHERE r.event_type='charge.refunded' AND r.ref=h.ref) AS refunded
      FROM held h)
    SELECT jsonb_build_object(
      -- Held payments plus every matched refund or dispute: any later provider report reopens a verified subject.
      'itemCount',(SELECT count(*)::integer FROM held_events)+(SELECT count(DISTINCT provider_event_id)::integer FROM reversals),
      'heldItemCount',(SELECT count(*)::integer FROM per_ref),
      'heldAmountMinor',(SELECT coalesce(sum(amount),0) FROM per_ref),
      'refundedAmountMinor',(SELECT coalesce(sum(least(refunded,amount)),0) FROM per_ref),
      'firstHeldAt',(SELECT hon.saas_ts(min(received_at)) FROM per_ref),
      'fullyRefunded',(SELECT count(*)>0 AND bool_and(refunded IS NOT NULL AND refunded=amount) FROM per_ref),
      'refundEvidence',(SELECT coalesce(jsonb_agg(DISTINCT r.provider_event_id),'[]'::jsonb) FROM reversals r WHERE r.event_type='charge.refunded'),
      'blocker',CASE
        WHEN NOT EXISTS(SELECT 1 FROM per_ref) THEN 'NO_HELD_PAYMENT'
        WHEN EXISTS(SELECT 1 FROM per_ref WHERE ref IS NULL) THEN 'PAYMENT_REFERENCE_MISSING'
        WHEN EXISTS(SELECT 1 FROM per_ref WHERE amount<>amount_hi) THEN 'HELD_PAYMENT_CONFLICT'
        WHEN EXISTS(SELECT 1 FROM reversals WHERE event_type='charge.dispute.created') THEN 'DISPUTE_POLICY_REQUIRED'
      END) INTO result;
  ELSE
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';
  END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION hon.saas_paid_review_open(p_kind text,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE p_kind
    WHEN 'V1_CHECKOUT' THEN EXISTS(SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.id=p_subject AND c.status='PAID_NEEDS_REVIEW'
      AND (SELECT x.n=0 OR x.n>hon.saas_paid_review_reviewed_count(c.id) FROM (SELECT (hon.saas_paid_review_items('V1_CHECKOUT',c.id)->>'itemCount')::integer AS n) x))
    WHEN 'SCHEDULE_BINDING' THEN EXISTS(SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.id=p_subject AND (b.status='NEEDS_REVIEW'
      OR (b.status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED')
        AND (SELECT count(*) FROM hon.saas_schedule_reconciliations r WHERE r.binding_id=b.id)>hon.saas_paid_review_reviewed_count(b.id)
        -- 0309: an ended lifetime plan is open only while it holds money; a repeated refund report alone holds nothing.
        AND (b.status<>'REFUNDED_ENDED' OR (hon.saas_paid_review_items('SCHEDULE_BINDING',b.id)->>'heldItemCount')::integer>0))))
    ELSE false END
$$;

CREATE OR REPLACE FUNCTION hon.saas_org_billing_conflict(p_org uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.organization_id=p_org AND c.status='PAID_NEEDS_REVIEW'
      AND hon.saas_paid_review_open('V1_CHECKOUT',c.id))
    OR EXISTS (SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.organization_id=p_org
      AND b.status IN ('NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED')
      AND hon.saas_paid_review_open('SCHEDULE_BINDING',b.id))
  THEN 'PAID_NEEDS_REVIEW' END
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
      WHERE b.status IN ('NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT','REFUNDED_ENDED') AND hon.saas_paid_review_open('SCHEDULE_BINDING',b.id)),
  numbered AS (SELECT kind, id, created_at, row_number() OVER (ORDER BY created_at,id) AS n FROM subjects
    WHERE after_at IS NULL OR (created_at,id)>(after_at,after_id) ORDER BY created_at,id LIMIT page_size+1)
  SELECT coalesce(jsonb_agg(hon.saas_paid_review_item_json(kind,id) ORDER BY n) FILTER (WHERE n<=page_size),'[]'::jsonb),
    CASE WHEN max(n)>page_size THEN max(CASE WHEN n=page_size THEN to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||'~'||id::text END) END
  INTO page, next_cursor FROM numbered;
  RETURN jsonb_build_object('items',page,'nextCursor',next_cursor,'providerActionExecuted',false);
END $$;

-- ---------- ACLs ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.saas_schedule_end_lifetime_access(uuid,uuid,text,timestamp with time zone)',
    'hon.saas_schedule_binding_transition(hon.saas_schedule_bindings,text,text,text,uuid,timestamp with time zone)',
    'hon.guard_saas_schedule_bindings()','hon.verify_saas_schedule_binding_evidence()','hon.guard_saas_access()',
    'hon.saas_schedule_access_json(uuid)','hon.saas_paid_review_items(text,uuid)','hon.saas_paid_review_open(text,uuid)',
    'hon.saas_org_billing_conflict(uuid)','hon.read_saas_paid_reviews(text,text)','hon.ingest_saas_schedule_evidence(jsonb,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.ingest_saas_schedule_evidence(jsonb,text) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_saas_paid_reviews(text,text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
