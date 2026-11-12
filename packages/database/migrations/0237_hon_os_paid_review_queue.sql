BEGIN;

-- HON OS schedule billing, piece 3 of 5 (owner checklist 2026-11-09): HQ review queue for held payments and refunds, and
-- the end of v1 founder and lifetime sales.
--   * Owner answer 5: the flat v1 checkout no longer sells HON OS founder or lifetime offers. Existing buyers, legacy
--     catalog checkouts and all history are untouched. Standard HON OS v1 sales are NOT changed (OD-3 stays open).
--   * Owner answer 3: a payment is never auto-refunded and never treated as failed. Money HON holds for review (a v1
--     checkout PAID_NEEDS_REVIEW, a schedule payment that was not counted, or late money on an ended sign-up) is listed for
--     the HQ owner. The HQ owner may record REFUND_OWED (an obligation only; no provider refund is executed here) and,
--     once the provider's own refund evidence is stored, verify it. Only a verified full refund of every held payment
--     clears the billing hold. Nothing is ever inferred from a read.
--   * After a verified refund a parked schedule plan carries on as before: a plan that was billing goes back to ACTIVE,
--     a plan that was never paid goes back to waiting for its first payment (the 7-day window still applies).
--   * Not decided here (owner decisions): accepting a held payment without a refund (OD-14), refund or dispute effects on a
--     counted payment (OD-11/12), disputes on a held payment. Those items stay listed with a blocker and no decision.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON OS paid review queue requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON OS paid review queue requires a restricted runtime';
  END IF;
END $$;

-- ---------- v1 sale rule (owner answer 5) ----------
CREATE FUNCTION hon.guard_saas_hon_os_v1_offer_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.hon_os_offer_id IS NOT NULL AND NEW.offer_kind IN ('FOUNDER_MONTHLY','FOUNDER_ANNUAL','FOUNDER_LIFETIME','LIFETIME') THEN
    RAISE EXCEPTION 'SAAS_OFFER_REQUIRES_SCHEDULE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_hon_os_v1_offer_kind BEFORE INSERT ON hon.saas_checkout_sessions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_hon_os_v1_offer_kind();

-- ---------- review records ----------
CREATE TABLE hon.saas_paid_review_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  subject_kind text NOT NULL CHECK (subject_kind IN ('V1_CHECKOUT','SCHEDULE_BINDING')),
  checkout_id uuid REFERENCES hon.saas_checkout_sessions(id) ON DELETE RESTRICT,
  binding_id uuid REFERENCES hon.saas_schedule_bindings(id) ON DELETE RESTRICT,
  subject_version integer NOT NULL CHECK (subject_version>=1),
  decision text NOT NULL CHECK (decision='REFUND_OWED'),
  status text NOT NULL CHECK (status IN ('AWAITING_REFUND_EVIDENCE','REFUND_VERIFIED')),
  held_item_count integer NOT NULL CHECK (held_item_count>=1),
  held_amount_minor bigint NOT NULL CHECK (held_amount_minor>=100),
  reason text NOT NULL CHECK (reason=btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version IN (1,2)),
  refunded_amount_minor bigint,
  reviewed_item_count integer,
  refund_evidence jsonb,
  verified_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  verification_key uuid,
  refund_verified_at timestamptz,
  FOREIGN KEY(actor_principal_id,idempotency_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key),
  FOREIGN KEY(verified_by_principal_id,verification_key) REFERENCES hon.saas_requests(actor_principal_id,idempotency_key),
  UNIQUE(actor_principal_id,idempotency_key),
  CHECK ((subject_kind='V1_CHECKOUT')=(checkout_id IS NOT NULL AND binding_id IS NULL)),
  CHECK ((subject_kind='SCHEDULE_BINDING')=(binding_id IS NOT NULL AND checkout_id IS NULL)),
  CHECK ((status='AWAITING_REFUND_EVIDENCE')=(version=1)),
  CHECK ((status='REFUND_VERIFIED')=(refunded_amount_minor IS NOT NULL AND reviewed_item_count IS NOT NULL AND refund_evidence IS NOT NULL
    AND verified_by_principal_id IS NOT NULL AND verification_key IS NOT NULL AND refund_verified_at IS NOT NULL)),
  CHECK (refund_evidence IS NULL OR (jsonb_typeof(refund_evidence)='array' AND jsonb_array_length(refund_evidence)>=1)),
  CHECK (refunded_amount_minor IS NULL OR refunded_amount_minor=held_amount_minor),
  CHECK (reviewed_item_count IS NULL OR reviewed_item_count>=held_item_count),
  CHECK (refund_verified_at IS NULL OR refund_verified_at>=created_at)
);
-- One open refund obligation per subject; history is kept.
CREATE UNIQUE INDEX saas_paid_review_one_open_per_subject ON hon.saas_paid_review_resolutions((coalesce(checkout_id,binding_id)))
  WHERE status='AWAITING_REFUND_EVIDENCE';

-- Insert only through the resolve command (open request), update only AWAITING -> REFUND_VERIFIED through the verify command.
CREATE FUNCTION hon.guard_saas_paid_review_resolutions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE allowed text[]:=ARRAY['status','version','held_item_count','held_amount_minor','refunded_amount_minor','reviewed_item_count','refund_evidence','verified_by_principal_id',
  'verification_key','refund_verified_at'];
BEGIN
  IF TG_OP NOT IN ('INSERT','UPDATE') THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'AWAITING_REFUND_EVIDENCE' OR NEW.version<>1 OR NEW.created_at>clock_timestamp()
      OR NOT EXISTS(SELECT 1 FROM hon.saas_requests WHERE actor_principal_id=NEW.actor_principal_id AND idempotency_key=NEW.idempotency_key
        AND operation='saas.paid_review.resolve' AND status='IN_PROGRESS') THEN
      RAISE EXCEPTION 'SAAS_PAID_REVIEW_EVIDENCE_REQUIRED' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='AWAITING_REFUND_EVIDENCE' AND NEW.status='REFUND_VERIFIED' AND NEW.version=2
    AND (to_jsonb(NEW)-allowed)=(to_jsonb(OLD)-allowed)
    AND EXISTS(SELECT 1 FROM hon.saas_requests WHERE actor_principal_id=NEW.verified_by_principal_id AND idempotency_key=NEW.verification_key
      AND operation='saas.paid_review.verify_refund' AND status='IN_PROGRESS') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE='42501';
END $$;

-- ---------- held money and its refund evidence (read-only) ----------
-- Held money: payments stored for review and never counted. Refund evidence: the provider's own stored refund events for
-- those exact payments (cumulative amount, so the largest report counts). Anything else on the subject is a blocker.
CREATE FUNCTION hon.saas_paid_review_items(p_kind text,p_subject uuid) RETURNS jsonb
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
      FROM hon.saas_schedule_provider_events e WHERE e.binding_id=p_subject AND e.event_type IN ('charge.refunded','charge.dispute.created')),
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

-- Items the latest verified refund already covered. A later held payment on the same subject opens it again.
CREATE FUNCTION hon.saas_paid_review_reviewed_count(p_subject uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(max(reviewed_item_count),0) FROM hon.saas_paid_review_resolutions
  WHERE coalesce(checkout_id,binding_id)=p_subject AND status='REFUND_VERIFIED'
$$;

-- True while the subject holds money for review that no verified refund covers.
CREATE FUNCTION hon.saas_paid_review_open(p_kind text,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE p_kind
    WHEN 'V1_CHECKOUT' THEN EXISTS(SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.id=p_subject AND c.status='PAID_NEEDS_REVIEW'
      AND (SELECT x.n=0 OR x.n>hon.saas_paid_review_reviewed_count(c.id) FROM (SELECT (hon.saas_paid_review_items('V1_CHECKOUT',c.id)->>'itemCount')::integer AS n) x))
    WHEN 'SCHEDULE_BINDING' THEN EXISTS(SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.id=p_subject AND (b.status='NEEDS_REVIEW'
      OR (b.status IN ('EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT')
        AND (SELECT count(*) FROM hon.saas_schedule_reconciliations r WHERE r.binding_id=b.id)>hon.saas_paid_review_reviewed_count(b.id))))
    ELSE false END
$$;

-- Read-only billing-conflict probe (replaces the 0230 strict stub). Still STABLE; never writes and never infers a refund
-- from raw evidence: only a REFUND_VERIFIED resolution written by the audited command clears a hold.
CREATE OR REPLACE FUNCTION hon.saas_org_billing_conflict(p_org uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM hon.saas_checkout_sessions c WHERE c.organization_id=p_org AND c.status='PAID_NEEDS_REVIEW'
      AND hon.saas_paid_review_open('V1_CHECKOUT',c.id))
    OR EXISTS (SELECT 1 FROM hon.saas_schedule_bindings b WHERE b.organization_id=p_org
      AND b.status IN ('NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT')
      AND hon.saas_paid_review_open('SCHEDULE_BINDING',b.id))
  THEN 'PAID_NEEDS_REVIEW' END
$$;

-- A refund recorded or verified for a held v1 payment must never be activated afterwards by the v1 access retry.
CREATE FUNCTION hon.guard_saas_checkout_refund_recorded() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF OLD.status='PAID_NEEDS_REVIEW' AND NEW.status IS DISTINCT FROM OLD.status
    AND EXISTS(SELECT 1 FROM hon.saas_paid_review_resolutions WHERE checkout_id=OLD.id) THEN
    RAISE EXCEPTION 'SAAS_REVIEW_REFUND_RECORDED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saas_checkout_refund_recorded BEFORE UPDATE ON hon.saas_checkout_sessions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_checkout_refund_recorded();

-- ---------- binding: back to its previous collecting state after a verified refund ----------
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_schedule_bindings'::regclass AND conname='saas_schedule_bindings_status_reason_check';
  IF def IS NULL THEN RAISE EXCEPTION 'saas_schedule_bindings status_reason constraint missing'; END IF;
  ALTER TABLE hon.saas_schedule_bindings DROP CONSTRAINT saas_schedule_bindings_status_reason_check;
  ALTER TABLE hon.saas_schedule_bindings ADD CONSTRAINT saas_schedule_bindings_status_reason_check CHECK (status_reason IN ('BINDING_REQUESTED',
    'BINDING_OBSERVED_TEST_ONLY','FIRST_PAYMENT_VERIFIED','PROVIDER_CONFIRMED_NOT_CREATED','PROVIDER_TERMS_MISMATCH','UNPAID_WINDOW_ELAPSED',
    'AMOUNT_MISMATCH','OVERLAPPING_COVERED_PERIOD','REVERSAL_REVIEW_REQUIRED','UNLINKED_REVERSAL','PURCHASER_CANCELLED_BEFORE_PAYMENT',
    'PERIOD_INTERVAL_MISMATCH','REVIEW_REFUND_VERIFIED'));
END $$;

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
          ELSE CASE NEW.status WHEN 'ACTIVE' THEN ARRAY['saas.schedule_binding.transition']
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

-- ---------- queue item shape ----------
CREATE FUNCTION hon.saas_paid_review_resolution_json(r hon.saas_paid_review_resolutions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('resolutionId',r.id,'subjectKind',r.subject_kind,
    'subjectId',coalesce(r.checkout_id,r.binding_id),'organizationId',r.organization_id,'decision',r.decision,'status',r.status,
    'version',r.version,'heldItemCount',r.held_item_count,'heldAmountMinor',r.held_amount_minor,'reason',r.reason,
    'refundedAmountMinor',r.refunded_amount_minor,'refundEvidence',coalesce(r.refund_evidence,'[]'::jsonb),
    'createdAt',hon.saas_ts(r.created_at),'refundVerifiedAt',hon.saas_ts(r.refund_verified_at),
    'providerActionExecuted',false) END
$$;

CREATE FUNCTION hon.saas_paid_review_item_json(p_kind text,p_subject uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE c hon.saas_checkout_sessions%ROWTYPE; b hon.saas_schedule_bindings%ROWTYPE; items jsonb; open_res hon.saas_paid_review_resolutions%ROWTYPE;
  org uuid; school uuid; billing_status text; status_reason text; subject_version integer; allowed jsonb; retry boolean:=false;
BEGIN
  IF p_kind='V1_CHECKOUT' THEN
    SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id=p_subject;
    org:=c.organization_id; school:=c.school_id; billing_status:=c.status; status_reason:=c.status_reason; subject_version:=c.version;
    retry:=c.status='PAID_NEEDS_REVIEW' AND c.status_reason='ACCESS_PROGRAM_INACTIVE';
  ELSE
    SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=p_subject;
    org:=b.organization_id; school:=b.school_id; billing_status:=b.status; status_reason:=b.status_reason; subject_version:=b.version;
  END IF;
  items:=hon.saas_paid_review_items(p_kind,p_subject);
  SELECT * INTO open_res FROM hon.saas_paid_review_resolutions WHERE coalesce(checkout_id,binding_id)=p_subject AND status='AWAITING_REFUND_EVIDENCE';
  allowed:=CASE WHEN open_res.id IS NULL AND items->>'blocker' IS NULL THEN '["REFUND_OWED"]'::jsonb ELSE '[]'::jsonb END;
  RETURN jsonb_build_object('subjectKind',p_kind,'subjectId',p_subject,'subjectVersion',subject_version,'organizationId',org,'schoolId',school,
    'billingStatus',billing_status,'reason',status_reason,'heldItemCount',(items->>'heldItemCount')::integer,
    'heldAmountMinor',(items->>'heldAmountMinor')::bigint,'refundedAmountMinor',(items->>'refundedAmountMinor')::bigint,
    'fullyRefunded',(items->>'fullyRefunded')::boolean,'receivedAt',items->>'firstHeldAt','blocker',items->'blocker',
    'allowedDecisions',allowed,'accessRetryAvailable',retry,'openResolution',hon.saas_paid_review_resolution_json(open_res),
    'providerActionExecuted',false);
END $$;

-- ---------- HQ queue read: complete, cursor-paged by (subject created_at, subject id) ----------
CREATE FUNCTION hon.read_saas_paid_reviews(p_subject text,p_cursor text) RETURNS jsonb
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
      WHERE b.status IN ('NEEDS_REVIEW','EXPIRED_UNPAID','VOIDED_PROVIDER_FAILED','CANCELLED_BEFORE_PAYMENT') AND hon.saas_paid_review_open('SCHEDULE_BINDING',b.id)),
  numbered AS (SELECT kind, id, created_at, row_number() OVER (ORDER BY created_at,id) AS n FROM subjects
    WHERE after_at IS NULL OR (created_at,id)>(after_at,after_id) ORDER BY created_at,id LIMIT page_size+1)
  SELECT coalesce(jsonb_agg(hon.saas_paid_review_item_json(kind,id) ORDER BY n) FILTER (WHERE n<=page_size),'[]'::jsonb),
    CASE WHEN max(n)>page_size THEN max(CASE WHEN n=page_size THEN to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')||'~'||id::text END) END
  INTO page, next_cursor FROM numbered;
  RETURN jsonb_build_object('items',page,'nextCursor',next_cursor,'providerActionExecuted',false);
END $$;

-- ---------- HQ owner: record a refund obligation (no provider action) ----------
CREATE FUNCTION hon.resolve_saas_paid_review(p_subject text,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; kind text; subject uuid; expected integer; org uuid; ver integer; items jsonb; at timestamptz:=clock_timestamp();
  r hon.saas_paid_review_resolutions%ROWTYPE;
BEGIN
  IF NOT hon.saas_trial_keys(p,ARRAY['confirmation','decision','expectedVersion','reason','subjectId','subjectKind'])
    OR p->>'subjectKind' NOT IN ('V1_CHECKOUT','SCHEDULE_BINDING')
    OR coalesce(p->>'subjectId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion')<>'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'decision')<>'string' OR p->>'decision' NOT IN ('ACTIVATE','RESUME_BILLING','REFUND_OWED')
    OR jsonb_typeof(p->'reason')<>'string' OR p->>'reason'<>btrim(p->>'reason') OR length(p->>'reason') NOT BETWEEN 10 AND 500
    OR p->>'confirmation' IS DISTINCT FROM 'RESOLVE_PAID_REVIEW_NO_PROVIDER_ACTION' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';
  END IF;
  kind:=p->>'subjectKind'; subject:=(p->>'subjectId')::uuid; expected:=(p->>'expectedVersion')::integer;
  actor:=hon.require_saas_hq_actor(p_subject,true);
  replay:=hon.saas_claim_request(actor,p_key,'saas.paid_review.resolve',
    hon.saas_fingerprint(ARRAY['paid_review.resolve',kind,subject::text,expected::text,p->>'decision',p->>'reason']),p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  -- Accepting held money without a refund (ACTIVATE / RESUME_BILLING) is owner decision OD-14 and not built. The v1
  -- access-program case keeps its existing HQ access retry.
  IF p->>'decision'<>'REFUND_OWED' THEN RAISE EXCEPTION 'SAAS_BILLING_POLICY_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  IF kind='V1_CHECKOUT' THEN SELECT organization_id INTO org FROM hon.saas_checkout_sessions WHERE id=subject;
  ELSE SELECT organization_id INTO org FROM hon.saas_schedule_bindings WHERE id=subject; END IF;
  IF org IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||org::text,0));
  -- Authority is rechecked after the wait; a revoked HQ owner fails closed.
  actor:=hon.require_saas_hq_actor(p_subject,true);
  IF kind='V1_CHECKOUT' THEN SELECT version INTO ver FROM hon.saas_checkout_sessions WHERE id=subject FOR UPDATE;
  ELSE SELECT version INTO ver FROM hon.saas_schedule_bindings WHERE id=subject FOR UPDATE; END IF;
  IF ver<>expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  items:=hon.saas_paid_review_items(kind,subject);
  IF NOT hon.saas_paid_review_open(kind,subject) OR items->>'blocker' IS NOT NULL
    OR EXISTS(SELECT 1 FROM hon.saas_paid_review_resolutions WHERE coalesce(checkout_id,binding_id)=subject AND status='AWAITING_REFUND_EVIDENCE') THEN
    RAISE EXCEPTION 'SAAS_REVIEW_NOT_RESOLVABLE' USING ERRCODE='23514';
  END IF;
  INSERT INTO hon.saas_paid_review_resolutions(organization_id,subject_kind,checkout_id,binding_id,subject_version,decision,status,
      held_item_count,held_amount_minor,reason,actor_principal_id,idempotency_key,created_at,version)
    VALUES(org,kind,CASE WHEN kind='V1_CHECKOUT' THEN subject END,CASE WHEN kind='SCHEDULE_BINDING' THEN subject END,ver,'REFUND_OWED',
      'AWAITING_REFUND_EVIDENCE',(items->>'heldItemCount')::integer,(items->>'heldAmountMinor')::bigint,p->>'reason',actor,p_key,at,1)
    RETURNING * INTO r;
  RETURN hon.saas_record(actor,p_key,'saas.paid_review.resolve','saas.paid_review.resolved','PAID_REVIEW',r.id,org,NULL,
    hon.saas_paid_review_resolution_json(r),
    jsonb_build_object('resolution',hon.saas_paid_review_resolution_json(r),'item',hon.saas_paid_review_item_json(kind,subject)),at);
END $$;

-- ---------- HQ owner: verify the provider's stored refund evidence ----------
CREATE FUNCTION hon.verify_saas_paid_review_refund(p_subject text,p_resolution uuid,p jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; replay jsonb; expected integer; org uuid; r hon.saas_paid_review_resolutions%ROWTYPE; b hon.saas_schedule_bindings%ROWTYPE;
  items jsonb; at timestamptz:=clock_timestamp(); prior jsonb; transition_key uuid; back_to text;
BEGIN
  IF p_resolution IS NULL OR NOT hon.saas_trial_keys(p,ARRAY['confirmation','expectedVersion'])
    OR jsonb_typeof(p->'expectedVersion')<>'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR p->>'confirmation' IS DISTINCT FROM 'VERIFY_RECORDED_REFUND_EVIDENCE_ONLY' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE='22023';
  END IF;
  expected:=(p->>'expectedVersion')::integer;
  actor:=hon.require_saas_hq_actor(p_subject,true);
  replay:=hon.saas_claim_request(actor,p_key,'saas.paid_review.verify_refund',
    hon.saas_fingerprint(ARRAY['paid_review.verify_refund',p_resolution::text,expected::text]),p_request,p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT organization_id INTO org FROM hon.saas_paid_review_resolutions WHERE id=p_resolution;
  IF org IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  -- Canonical order: organization -> subject row -> resolution row.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:'||org::text,0));
  actor:=hon.require_saas_hq_actor(p_subject,true);
  SELECT * INTO r FROM hon.saas_paid_review_resolutions WHERE id=p_resolution;
  IF r.subject_kind='SCHEDULE_BINDING' THEN SELECT * INTO b FROM hon.saas_schedule_bindings WHERE id=r.binding_id FOR UPDATE;
  ELSE PERFORM 1 FROM hon.saas_checkout_sessions WHERE id=r.checkout_id FOR UPDATE; END IF;
  SELECT * INTO r FROM hon.saas_paid_review_resolutions WHERE id=p_resolution FOR UPDATE;
  IF r.version<>expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF r.status<>'AWAITING_REFUND_EVIDENCE' THEN RAISE EXCEPTION 'SAAS_REVIEW_NOT_RESOLVABLE' USING ERRCODE='23514'; END IF;
  -- Recomputed now: any held payment received since the obligation was recorded must be refunded too, and the record
  -- is brought up to the full held amount it verifies.
  items:=hon.saas_paid_review_items(r.subject_kind,coalesce(r.checkout_id,r.binding_id));
  IF items->>'blocker' IS NOT NULL THEN RAISE EXCEPTION 'SAAS_REVIEW_NOT_RESOLVABLE' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(items->'refundEvidence')=0 THEN RAISE EXCEPTION 'SAAS_REFUND_EVIDENCE_MISSING' USING ERRCODE='23514'; END IF;
  IF NOT (items->>'fullyRefunded')::boolean THEN RAISE EXCEPTION 'SAAS_REFUND_INCOMPLETE' USING ERRCODE='23514'; END IF;
  prior:=hon.saas_paid_review_resolution_json(r);
  UPDATE hon.saas_paid_review_resolutions SET status='REFUND_VERIFIED',version=2,held_item_count=(items->>'heldItemCount')::integer,
      held_amount_minor=(items->>'heldAmountMinor')::bigint,
      refunded_amount_minor=(items->>'refundedAmountMinor')::bigint,reviewed_item_count=(items->>'itemCount')::integer,
      refund_evidence=items->'refundEvidence',verified_by_principal_id=actor,verification_key=p_key,refund_verified_at=at
    WHERE id=r.id AND version=1 RETURNING * INTO r;
  IF r.id IS NULL THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF r.subject_kind='SCHEDULE_BINDING' AND b.status='NEEDS_REVIEW' THEN
    back_to:=CASE WHEN b.activated_at IS NOT NULL THEN 'ACTIVE' ELSE 'BOUND_TEST_ONLY' END;
    UPDATE hon.saas_schedule_bindings SET status=back_to,status_reason='REVIEW_REFUND_VERIFIED',version=version+1
      WHERE id=b.id AND version=b.version RETURNING * INTO b;
    IF b.id IS NULL THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    transition_key:=gen_random_uuid();
    PERFORM hon.saas_claim_request(actor,transition_key,'saas.paid_review.verify_refund',
      hon.saas_fingerprint(ARRAY['paid_review.binding_transition',b.id::text,b.version::text]),p_request,p_correlation);
    PERFORM hon.saas_record(actor,transition_key,'saas.paid_review.verify_refund','saas.schedule_binding.transitioned','SCHEDULE_BINDING',b.id,
      b.organization_id,NULL,hon.saas_schedule_binding_json(b),jsonb_build_object('binding',hon.saas_schedule_binding_json(b)),at);
  END IF;
  RETURN hon.saas_record(actor,p_key,'saas.paid_review.verify_refund','saas.paid_review.refund_verified','PAID_REVIEW',r.id,org,prior,
    hon.saas_paid_review_resolution_json(r),
    jsonb_build_object('resolution',hon.saas_paid_review_resolution_json(r),
      'billingStatus',CASE WHEN r.subject_kind='SCHEDULE_BINDING' THEN b.status ELSE (SELECT status FROM hon.saas_checkout_sessions WHERE id=r.checkout_id) END,
      'billingReviewOpen',hon.saas_paid_review_open(r.subject_kind,coalesce(r.checkout_id,r.binding_id))),at);
END $$;

-- ---------- evidence vocabularies ----------
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_action_code_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR action_code IN (''saas.paid_review.resolve'',''saas.paid_review.verify_refund''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_entity_type_check';
  ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
  EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR entity_type IN (''PAID_REVIEW''))';
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_outbox'::regclass AND conname='saas_outbox_event_type_check';
  ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
  EXECUTE 'ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR event_type IN (''saas.paid_review.resolved'',''saas.paid_review.refund_verified''))';
END $$;

-- ---------- RLS, immutability and grants ----------
ALTER TABLE hon.saas_paid_review_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.saas_paid_review_resolutions FORCE ROW LEVEL SECURITY;
CREATE TRIGGER saas_paid_review_rows BEFORE INSERT OR UPDATE OR DELETE ON hon.saas_paid_review_resolutions FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_paid_review_resolutions();
CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_paid_review_resolutions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_paid_review_resolutions();
DO $$ DECLARE r text; c text; f text; BEGIN
  REVOKE ALL ON TABLE hon.saas_paid_review_resolutions FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.saas_paid_review_resolutions FROM %I',r); END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid='hon.saas_paid_review_resolutions'::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.saas_paid_review_resolutions FROM PUBLIC',c);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.saas_paid_review_resolutions FROM %I',c,r); END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_saas_hon_os_v1_offer_kind()','hon.guard_saas_paid_review_resolutions()',
    'hon.saas_paid_review_items(text,uuid)','hon.saas_paid_review_reviewed_count(uuid)','hon.saas_paid_review_open(text,uuid)',
    'hon.saas_org_billing_conflict(uuid)','hon.guard_saas_checkout_refund_recorded()','hon.guard_saas_schedule_bindings()',
    'hon.verify_saas_schedule_binding_evidence()','hon.saas_paid_review_resolution_json(hon.saas_paid_review_resolutions)',
    'hon.saas_paid_review_item_json(text,uuid)','hon.read_saas_paid_reviews(text,text)',
    'hon.resolve_saas_paid_review(text,jsonb,uuid,uuid,uuid)','hon.verify_saas_paid_review_refund(text,uuid,jsonb,uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_saas_paid_reviews(text,text),hon.resolve_saas_paid_review(text,jsonb,uuid,uuid,uuid),
      hon.verify_saas_paid_review_refund(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;
COMMIT;
