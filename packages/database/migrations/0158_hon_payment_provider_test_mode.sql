BEGIN;

-- HON Subscription Billing Milestone B5: payment-provider integration in TEST MODE ONLY.
-- A school owner (or HQ) opens a hosted checkout for a published Core/Complete offer; the API creates
-- the provider session through an adapter and verifies every provider webhook signature before it
-- reaches this database. A verified successful payment records the B1 subscription (service started),
-- issues the B2 invoice and records PROVIDER_VERIFIED payment evidence in one transaction.
-- - Live mode is impossible: the program can only be DISABLED or TEST_MODE, every provider event must
--   have livemode false, and every provider-verified evidence row is provider_mode TEST.
-- - No card data is ever received or stored (hosted checkout); only provider references are kept.
-- - HON never initiates a charge or a refund; provider refunds and disputes are reconciled as evidence.
-- - organization_entitlements stays the sole access authority and is never written here: a checkout
--   is only offered for the plan that matches the school's active entitlement (plan changes remain
--   undecided), so a verified payment never grants or changes access by itself.
-- - Tax stays undecided: test-mode invoices use the owner's recorded test-mode tax reference.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON payment provider integration requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON payment provider integration requires a restricted runtime';
  END IF;
END $$;

-- ---------- owner decisions and authority ----------
INSERT INTO hon.saas_policy_records(policy_code, version, status, decision_code, summary, blocks, source_reference, recorded_at) VALUES
  ('PAYMENT_PROVIDER',3,'PROPOSED','STRIPE_TEST_MODE_ADAPTER',
    'Stripe is the preferred initial provider behind a provider adapter, subject to owner approval and account setup; test mode only.',
    'Live mode, live charges and refunds stay unavailable; the program can only be DISABLED or TEST_MODE.','OWNER_DIRECTION_2026_10_19_B5',clock_timestamp());

INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable)
VALUES ('billing.hon.purchase','Purchase the school''s HON plan through hosted test-mode checkout; never changes entitlements or stores card data',true,true);
INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT id, organization_id, 'billing.hon.purchase' FROM hon.roles WHERE is_system_role AND code = 'OWNER' ON CONFLICT DO NOTHING;

-- The fixed integration principal that verified provider events act as. It has no user, no role and
-- no HQ grant, so no human or HQ check can ever resolve to it.
INSERT INTO hon.principals(id, principal_type, user_id, display_name, is_active)
VALUES ('00000000-0000-4000-8000-0000000000b5', 'INTEGRATION', NULL, 'HON payment provider (test mode)', true);

-- ---------- program ----------
CREATE TABLE hon.saas_payment_program (
  program_id smallint PRIMARY KEY CHECK (program_id = 1),
  status text NOT NULL CHECK (status IN ('DISABLED','TEST_MODE')),
  provider text CHECK (provider IN ('STRIPE','STRIPE_SIMULATED')),
  live_mode boolean NOT NULL DEFAULT false CHECK (live_mode = false),
  test_tax_reference text CHECK (length(test_tax_reference) BETWEEN 1 AND 200),
  authorization_reference text CHECK (length(authorization_reference) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK (version > 0),
  changed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL,
  CHECK ((status = 'TEST_MODE') = (provider IS NOT NULL AND test_tax_reference IS NOT NULL AND authorization_reference IS NOT NULL
    AND changed_by_principal_id IS NOT NULL))
);
INSERT INTO hon.saas_payment_program(program_id, status, version, changed_at) VALUES (1, 'DISABLED', 1, clock_timestamp());

-- ---------- checkout sessions ----------
CREATE TABLE hon.saas_checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid REFERENCES hon.schools(id) ON DELETE RESTRICT,
  catalog_id uuid NOT NULL, offer_id uuid NOT NULL,
  plan_code text NOT NULL CHECK (plan_code IN ('CORE','COMPLETE')),
  offer_kind text NOT NULL CHECK (offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME')),
  billing_interval text NOT NULL CHECK (billing_interval IN ('MONTHLY','LIFETIME')),
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 100 AND 10000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  founder_reservation_id uuid UNIQUE REFERENCES hon.saas_founder_reservations(id) ON DELETE RESTRICT,
  requester_kind text NOT NULL CHECK (requester_kind IN ('SCHOOL_OWNER','HQ')),
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('STRIPE','STRIPE_SIMULATED')),
  provider_mode text NOT NULL DEFAULT 'TEST' CHECK (provider_mode = 'TEST'),
  provider_session_id text UNIQUE CHECK (provider_session_id ~ '^cs_test_[A-Za-z0-9_]{1,200}$'),
  checkout_url text CHECK (length(checkout_url) <= 2000 AND checkout_url ~ '^https://(checkout\.stripe\.com|checkout\.simulated\.invalid)/[A-Za-z0-9_/#%?=&.-]+$'),
  provider_customer_ref text CHECK (provider_customer_ref ~ '^cus_[A-Za-z0-9]{1,100}$'),
  provider_subscription_ref text UNIQUE CHECK (provider_subscription_ref ~ '^sub_[A-Za-z0-9]{1,100}$'),
  status text NOT NULL CHECK (status IN ('CREATED','OPEN','COMPLETED','EXPIRED','CANCELLED','FAILED','PAID_NEEDS_REVIEW')),
  status_reason text NOT NULL CHECK (status_reason IN ('CREATED','PROVIDER_SESSION_OPENED','PROVIDER_CREATE_FAILED','PAYMENT_VERIFIED',
    'PROVIDER_EXPIRED','LOCAL_EXPIRED','CANCELLED_BY_REQUESTER','CANCELLED_BY_HQ','ASYNC_PAYMENT_FAILED','PAID_AFTER_CLOSE','AMOUNT_MISMATCH',
    'FOUNDER_UNAVAILABLE','ENTITLEMENT_CHANGED','SUBSCRIPTION_EXISTS')),
  subscription_id uuid REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  invoice_id uuid REFERENCES hon.saas_invoices(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, completed_at timestamptz,
  FOREIGN KEY (offer_id, catalog_id) REFERENCES hon.saas_catalog_offers(id, catalog_id) ON DELETE RESTRICT,
  CHECK ((founder_reservation_id IS NOT NULL) = (offer_kind LIKE 'FOUNDER_%')),
  CHECK (billing_interval = CASE WHEN offer_kind = 'FOUNDER_LIFETIME' THEN 'LIFETIME' ELSE 'MONTHLY' END),
  CHECK ((requester_kind = 'SCHOOL_OWNER') = (school_id IS NOT NULL)),
  CHECK ((status = 'OPEN') <= (provider_session_id IS NOT NULL AND checkout_url IS NOT NULL)),
  CHECK ((status = 'COMPLETED') = (subscription_id IS NOT NULL AND invoice_id IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
-- One live checkout per organization.
CREATE UNIQUE INDEX saas_checkout_one_live_per_organization ON hon.saas_checkout_sessions (organization_id) WHERE status IN ('CREATED','OPEN');

-- ---------- verified provider events (append-only) ----------
CREATE TABLE hon.saas_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('STRIPE','STRIPE_SIMULATED')),
  provider_event_id text NOT NULL CHECK (provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 3 AND 80),
  livemode boolean NOT NULL CHECK (livemode = false),
  provider_created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  normalized jsonb NOT NULL CHECK (jsonb_typeof(normalized) = 'object'),
  organization_id uuid REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  checkout_id uuid REFERENCES hon.saas_checkout_sessions(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','ALREADY_APPLIED','IGNORED','NEEDS_REVIEW','AWAITING_ASYNC_PAYMENT')),
  outcome_detail text NOT NULL CHECK (outcome_detail ~ '^[A-Z_]{3,60}$'),
  UNIQUE (provider, provider_event_id)
);

-- Provider payment references linked to the B2 PAYMENT_RECEIVED evidence they paid, so refunds and
-- disputes reconcile to the right payment whatever reference the provider reports.
CREATE TABLE hon.saas_provider_payment_refs (
  provider text NOT NULL CHECK (provider IN ('STRIPE','STRIPE_SIMULATED')),
  ref text NOT NULL CHECK (ref ~ '^(cs_test|pi|in|ch|py)_[A-Za-z0-9_]{1,200}$'),
  evidence_id uuid NOT NULL REFERENCES hon.saas_payment_evidence(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (provider, ref)
);

-- ---------- provider-verified evidence on B2 ----------
ALTER TABLE hon.saas_payment_evidence DROP CONSTRAINT saas_payment_evidence_source_check;
ALTER TABLE hon.saas_payment_evidence ADD CONSTRAINT saas_payment_evidence_source_check CHECK (source IN ('HQ_ATTESTATION','PROVIDER_VERIFIED'));
ALTER TABLE hon.saas_payment_evidence DROP CONSTRAINT saas_payment_evidence_provider_event_id_check;
ALTER TABLE hon.saas_payment_evidence ADD COLUMN provider_code text CHECK (provider_code IN ('STRIPE','STRIPE_SIMULATED'));
ALTER TABLE hon.saas_payment_evidence ADD COLUMN provider_mode text CHECK (provider_mode = 'TEST');
-- Each source carries exactly its own fields: an HQ attestation can never present a provider event.
ALTER TABLE hon.saas_payment_evidence ADD CONSTRAINT saas_payment_evidence_provider_event_id_check CHECK (CASE source
  WHEN 'PROVIDER_VERIFIED' THEN provider_event_id IS NOT NULL AND provider_event_id ~ '^evt_[A-Za-z0-9_]{1,200}$' AND provider_code IS NOT NULL AND provider_mode IS NOT NULL
  ELSE provider_event_id IS NULL AND provider_code IS NULL AND provider_mode IS NULL END);

-- ---------- vocabularies ----------
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (action_code IN ('saas.catalog.draft','saas.catalog.publish',
  'saas.founder.reserve','saas.founder.release','saas.subscription.record','saas.subscription.command',
  'saas.invoice.draft','saas.invoice.command','saas.payment.evidence',
  'saas.credits.program','saas.credits.cost_evidence','saas.credits.pricing_draft','saas.credits.pricing_publish',
  'saas.credits.allowance','saas.credits.reserve','saas.credits.settle','saas.credits.resolve',
  'saas.refund.request','saas.refund.decide','saas.rewards.fulfillment','saas.rewards.apply','saas.rewards.credit_apply','saas.rewards.alert_resolve',
  'saas.payments.program','saas.checkout.create','saas.checkout.attach','saas.checkout.cancel','saas.checkout.sweep','saas.provider.event'));
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION',
  'INVOICE','PAYMENT_EVIDENCE','CREDIT_PROGRAM','COST_EVIDENCE','PRICING','ALLOWANCE','CREDIT_RESERVATION',
  'REFUND_REQUEST','REWARD_FULFILLMENT','REWARD_APPLICATION','REFERRAL_ALERT','PAYMENT_PROGRAM','CHECKOUT','PROVIDER_EVENT'));
ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published',
  'saas.founder.reserved','saas.founder.released','saas.subscription.recorded','saas.subscription.changed',
  'saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded',
  'saas.credits.program_changed','saas.credits.cost_recorded','saas.credits.pricing_drafted','saas.credits.pricing_published',
  'saas.credits.allowance_changed','saas.credits.reserved','saas.credits.settled','saas.credits.resolved',
  'saas.refund.requested','saas.refund.decided','saas.rewards.fulfillment_changed','saas.rewards.applied','saas.rewards.credit_applied',
  'saas.rewards.alert_resolved','saas.payments.program_changed','saas.checkout.created','saas.checkout.changed','saas.checkouts.swept',
  'saas.provider.event_recorded'));

-- ---------- guards ----------
CREATE FUNCTION hon.guard_saas_payments() RETURNS trigger
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
        -- A provider-proven session id attached to a checkout whose adapter outcome was unknown.
        OR (OLD.status = 'CREATED' AND NEW.status = 'CREATED' AND OLD.provider_session_id IS NULL AND NEW.provider_session_id IS NOT NULL
          AND (after_row - ARRAY['provider_session_id','version','updated_at']) = (before_row - ARRAY['provider_session_id','version','updated_at']))) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_provider_events','saas_provider_payment_refs'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['saas_payment_program','saas_checkout_sessions'] LOOP
    EXECUTE format('CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_payments()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_payments()',t);
  END LOOP;
END $$;

-- ---------- private helpers ----------
CREATE FUNCTION hon.saas_payment_actor() RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$ SELECT '00000000-0000-4000-8000-0000000000b5'::uuid $$;

CREATE FUNCTION hon.saas_payment_program_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('status',p.status,'provider',p.provider,'mode',CASE WHEN p.status = 'TEST_MODE' THEN 'TEST' ELSE NULL END,
    'liveMode','UNAVAILABLE','testTaxReference',p.test_tax_reference,'authorizationReference',p.authorization_reference,'version',p.version,
    'changedAt',hon.saas_ts(p.changed_at),'cardDataStored',false,'refundExecution','UNAVAILABLE')
  FROM hon.saas_payment_program p WHERE p.program_id = 1
$$;

CREATE FUNCTION hon.saas_checkout_json(c hon.saas_checkout_sessions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('checkoutId',c.id,'organizationId',c.organization_id,'schoolId',c.school_id,'offerId',c.offer_id,'planCode',c.plan_code,
    'offerKind',c.offer_kind,'billingInterval',c.billing_interval,'amountMinor',c.amount_minor,'currency',c.currency,
    'founderReservationId',c.founder_reservation_id,'requesterKind',c.requester_kind,'provider',c.provider,'mode',c.provider_mode,
    'providerSessionId',c.provider_session_id,'checkoutUrl',CASE WHEN c.status = 'OPEN' THEN c.checkout_url END,
    'status',c.status,'statusReason',c.status_reason,'subscriptionId',c.subscription_id,'invoiceId',c.invoice_id,
    'expiresAt',hon.saas_ts(c.expires_at),'version',c.version,'createdAt',hon.saas_ts(c.created_at),'completedAt',hon.saas_ts(c.completed_at))
$$;

-- Payment status of a subscription, derived only from B2 invoices, evidence and provider failure events.
CREATE FUNCTION hon.saas_subscription_payment(s hon.saas_subscriptions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE rec jsonb; ver jsonb; latest record; v_status text; failed_last boolean;
BEGIN
  IF s.source <> 'CATALOG_OFFER' OR s.status = 'VOIDED' THEN
    RETURN jsonb_build_object('paymentStatus','NOT_BILLED','paidThroughAt',NULL,'paymentVerification','NONE');
  END IF;
  rec := hon.saas_payment_standing_strength(s.organization_id, false);
  ver := hon.saas_payment_standing_strength(s.organization_id, true);
  SELECT f.* INTO latest FROM hon.saas_invoice_facts(s.organization_id, NULL) f
    WHERE f.subscription_id = s.id AND f.status = 'ISSUED' ORDER BY f.period_index DESC NULLS FIRST, f.invoice_id LIMIT 1;
  -- Latest money event by provider time (arrival breaks ties): a failure after the last payment is PAST_DUE.
  SELECT e.event_type = 'invoice.payment_failed' INTO failed_last FROM hon.saas_provider_events e
    WHERE e.subscription_id = s.id AND e.outcome = 'APPLIED'
      AND e.event_type IN ('invoice.payment_failed','invoice.paid','checkout.session.completed','checkout.session.async_payment_succeeded')
    ORDER BY e.provider_created_at DESC, e.received_at DESC LIMIT 1;
  v_status := CASE
    WHEN latest.invoice_id IS NULL THEN 'NOT_BILLED'
    WHEN latest.charged_back_minor > 0 THEN 'DISPUTED'
    WHEN latest.refunded_minor > 0 AND latest.net_minor < latest.total_minor THEN 'REFUNDED'
    WHEN s.billing_interval = 'LIFETIME' AND (rec->>'lifetimePaid')::boolean THEN 'PAID'
    WHEN s.billing_interval = 'MONTHLY' AND (rec->>'paidThroughAt')::timestamptz > clock_timestamp() THEN 'PAID'
    WHEN coalesce(failed_last, false) THEN 'PAST_DUE'
    ELSE 'DUE' END;
  RETURN jsonb_build_object('paymentStatus',v_status,
    'paidThroughAt',CASE WHEN s.billing_interval = 'MONTHLY' THEN rec->>'paidThroughAt' END,
    'paymentVerification',CASE WHEN v_status <> 'PAID' THEN 'NONE'
      WHEN (s.billing_interval = 'LIFETIME' AND (ver->>'lifetimePaid')::boolean)
        OR (s.billing_interval = 'MONTHLY' AND ver->>'paidThroughAt' IS NOT DISTINCT FROM rec->>'paidThroughAt') THEN 'PROVIDER_VERIFIED'
      ELSE 'HQ_ATTESTED' END);
END $$;

CREATE OR REPLACE FUNCTION hon.saas_subscription_json(s hon.saas_subscriptions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('subscriptionId',s.id,'organizationId',s.organization_id,
    'organizationName',(SELECT o.display_name FROM hon.organizations o WHERE o.id = s.organization_id),
    'source',s.source,'catalogVersion',(SELECT c.catalog_version FROM hon.saas_catalog_versions c WHERE c.id = s.catalog_id),
    'offerId',s.offer_id,'planCode',s.plan_code,'entitlementTier',s.entitlement_tier::text,'offerKind',s.offer_kind,
    'billingInterval',s.billing_interval,'priceMinor',s.price_minor,'currency',s.currency,'founderReservationId',s.founder_reservation_id,
    'status',s.status,'statusReason',s.status_reason,'version',s.version,'serviceStartedAt',hon.saas_ts(s.service_started_at),
    'currentPeriod',CASE WHEN s.current_period_start IS NULL THEN NULL ELSE jsonb_build_object('index',s.period_index,
      'startsAt',hon.saas_ts(s.current_period_start),'endsAt',hon.saas_ts(s.current_period_end)) END,
    'paymentStatus',pay->>'paymentStatus','paidThroughAt',pay->>'paidThroughAt','paymentVerification',pay->>'paymentVerification',
    'chargesEnabled',false,
    'premiumCredits',jsonb_build_object('plannedMonthlyAllowance',
      (SELECT p.planned_monthly_premium_credits FROM hon.saas_catalog_plans p WHERE p.catalog_id = s.catalog_id AND p.plan_code = s.plan_code),
      'status','NOT_GRANTED'),
    'createdAt',hon.saas_ts(s.created_at),'updatedAt',hon.saas_ts(s.updated_at))
  FROM (SELECT hon.saas_subscription_payment(s) pay) x
$$;

CREATE OR REPLACE FUNCTION hon.saas_evidence_json(e hon.saas_payment_evidence) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('evidenceId',e.id,'invoiceId',e.invoice_id,'kind',e.kind,'source',e.source,'providerVerified',e.source = 'PROVIDER_VERIFIED',
    'amountMinor',e.amount_minor,'currency',e.currency,'occurredAt',hon.saas_ts(e.occurred_at),'reference',e.reference,
    'relatedEvidenceId',e.related_evidence_id,'note',e.note,'recordedAt',hon.saas_ts(e.recorded_at))
$$;

CREATE OR REPLACE FUNCTION hon.saas_payment_standing(p_organization uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('organizationId', p_organization,
    'subscriptionId', (SELECT s.id FROM hon.saas_subscriptions s WHERE s.organization_id = p_organization AND s.status <> 'VOIDED'),
    'verified', hon.saas_payment_standing_strength(p_organization, true),
    'recorded', hon.saas_payment_standing_strength(p_organization, false),
    'evidence', (SELECT jsonb_build_object('hqAttested', count(*) FILTER (WHERE e.source = 'HQ_ATTESTATION'),
      'providerVerified', count(*) FILTER (WHERE e.source = 'PROVIDER_VERIFIED')) FROM hon.saas_payment_evidence e WHERE e.organization_id = p_organization),
    'championsPaymentSource', 'NOT_CONNECTED',
    'providerVerification', CASE WHEN (SELECT status FROM hon.saas_payment_program WHERE program_id = 1) = 'TEST_MODE' THEN 'TEST_MODE' ELSE 'NOT_CONFIGURED' END)
$$;

-- Staff with billing.hon.purchase at the exact school (same identity rules as B3's school actor).
CREATE FUNCTION hon.require_saas_school_purchaser(p_subject text, p_school uuid)
RETURNS TABLE (principal_id uuid, organization_id uuid, school_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject OR p_school IS NULL THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT p.id, s.organization_id, s.id FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  JOIN hon.schools s ON s.id = p_school
  WHERE u.external_subject = p_subject AND p.is_active
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
    AND hon.staff_member_eligible(p.id, s.organization_id, s.id)
    AND EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id = r.id AND rp.organization_id = r.organization_id
      JOIN hon.permissions perm ON perm.code = rp.permission_code
      WHERE g.principal_id = p.id AND g.organization_id = s.organization_id AND g.school_id = s.id
        AND perm.code = 'billing.hon.purchase' AND perm.is_staff_assignable
        AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id = s.id)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      WHERE g.principal_id = p.id AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)');
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
END $$;

-- Ends a checkout that never paid and returns its founder hold to inventory.
CREATE FUNCTION hon.saas_close_checkout(p_checkout uuid, p_status text, p_reason text, p_actor uuid, p_at timestamptz) RETURNS hon.saas_checkout_sessions
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE c hon.saas_checkout_sessions%ROWTYPE;
BEGIN
  UPDATE hon.saas_checkout_sessions SET status = p_status, status_reason = p_reason, version = version + 1, updated_at = p_at
    WHERE id = p_checkout RETURNING * INTO c;
  UPDATE hon.saas_founder_reservations SET status = CASE WHEN p_status = 'EXPIRED' THEN 'EXPIRED' ELSE 'RELEASED' END,
      status_reason = CASE WHEN p_status = 'EXPIRED' THEN 'HOLD_EXPIRED' WHEN p_reason = 'CANCELLED_BY_HQ' THEN 'OWNER_RELEASED' ELSE 'SCHOOL_DECLINED' END,
      version = version + 1, decided_by_principal_id = p_actor, decided_at = p_at
    WHERE id = c.founder_reservation_id AND status = 'RESERVED';
  RETURN c;
END $$;

-- Opens a checkout for a published offer matching the organization's active entitlement. Founder
-- offers hold a founder slot (B1 inventory rules) until the checkout expires.
CREATE FUNCTION hon.saas_open_checkout(p_actor uuid, p_org uuid, p_school uuid, p_offer uuid, p_kind text, p_at timestamptz) RETURNS hon.saas_checkout_sessions
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prog hon.saas_payment_program%ROWTYPE; ent hon.organization_entitlements%ROWTYPE; v_catalog hon.saas_catalog_versions%ROWTYPE;
  v_offer hon.saas_catalog_offers%ROWTYPE; v_pool text; stale record; res hon.saas_founder_reservations%ROWTYPE; inventory jsonb; v_expires timestamptz;
  created hon.saas_checkout_sessions%ROWTYPE;
BEGIN
  SELECT * INTO prog FROM hon.saas_payment_program WHERE program_id = 1 FOR SHARE;
  IF prog.status <> 'TEST_MODE' THEN RAISE EXCEPTION 'SAAS_PAYMENTS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || p_org::text, 0));
  LOCK TABLE hon.saas_catalog_versions IN SHARE MODE;
  PERFORM 1 FROM hon.organizations o WHERE o.id = p_org AND o.status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = p_org FOR SHARE;
  IF NOT FOUND OR ent.status <> 'ACTIVE' OR ent.effective_from > p_at OR (ent.effective_until IS NOT NULL AND ent.effective_until <= p_at) THEN
    RAISE EXCEPTION 'SAAS_ENTITLEMENT_NOT_ACTIVE' USING ERRCODE = '23514';
  END IF;
  SELECT c.* INTO v_catalog FROM hon.saas_catalog_versions c WHERE c.status = 'PUBLISHED';
  SELECT o.* INTO v_offer FROM hon.saas_catalog_offers o WHERE o.id = p_offer AND o.catalog_id = v_catalog.id;
  IF v_catalog.id IS NULL OR v_offer.id IS NULL THEN RAISE EXCEPTION 'SAAS_OFFER_NOT_AVAILABLE' USING ERRCODE = '23514'; END IF;
  -- The plan must match the active entitlement: a payment never changes access, and plan changes stay undecided.
  IF v_offer.plan_code <> ent.tier::text THEN RAISE EXCEPTION 'SAAS_ENTITLEMENT_MISMATCH' USING ERRCODE = '23514'; END IF;
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

-- Issues the B2 invoice for a provider-verified payment and records the PROVIDER_VERIFIED evidence.
CREATE FUNCTION hon.saas_provider_invoice(p_sub hon.saas_subscriptions, p_period integer, p_amount integer, p_occurred timestamptz,
  p_reference text, p_event jsonb, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); prog hon.saas_payment_program%ROWTYPE; inv hon.saas_invoices%ROWTYPE; v_kind text;
  v_start timestamptz; v_end timestamptz; v_desc text; v_label text; v_year integer; v_seq integer; ev uuid;
BEGIN
  SELECT * INTO prog FROM hon.saas_payment_program WHERE program_id = 1;
  IF p_sub.billing_interval = 'MONTHLY' THEN
    v_kind := 'SUBSCRIPTION_PERIOD';
    v_start := p_sub.period_anchor_at + make_interval(months => p_period);
    v_end := p_sub.period_anchor_at + make_interval(months => p_period + 1);
  ELSE
    v_kind := 'LIFETIME_PURCHASE'; v_start := p_sub.service_started_at;
  END IF;
  SELECT * INTO inv FROM hon.saas_invoices i WHERE i.subscription_id = p_sub.id AND i.status <> 'VOID' AND i.kind = v_kind
    AND i.period_index IS NOT DISTINCT FROM p_period FOR UPDATE;
  IF inv.id IS NULL THEN
    v_label := CASE p_sub.offer_kind WHEN 'REGULAR_MONTHLY' THEN 'monthly' WHEN 'FOUNDER_MONTHLY' THEN 'founder monthly' ELSE 'founder paid lifetime' END;
    SELECT pl.display_name || ' — ' || v_label || CASE WHEN v_kind = 'SUBSCRIPTION_PERIOD'
        THEN ' — service period ' || to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' to ' || to_char(v_end AT TIME ZONE 'UTC', 'YYYY-MM-DD')
        ELSE ' — one-time purchase' END
      INTO v_desc FROM hon.saas_catalog_plans pl WHERE pl.catalog_id = p_sub.catalog_id AND pl.plan_code = p_sub.plan_code;
    INSERT INTO hon.saas_invoices(organization_id,subscription_id,kind,period_index,service_period_start,service_period_end,plan_code,offer_kind,
        description,status,version,subtotal_minor,tax_status,created_by_principal_id,created_at,updated_at)
      VALUES (p_sub.organization_id,p_sub.id,v_kind,p_period,v_start,v_end,p_sub.plan_code,p_sub.offer_kind,v_desc,'DRAFT',1,p_sub.price_minor,'UNRESOLVED',actor,p_at,p_at)
      RETURNING * INTO inv;
    INSERT INTO hon.saas_invoice_lines(invoice_id,line_number,line_kind,description,amount_minor,created_by_principal_id,created_at)
      VALUES (inv.id,1,'PLAN_FEE',v_desc,p_sub.price_minor,actor,p_at);
  END IF;
  IF inv.status = 'DRAFT' THEN
    IF inv.tax_status = 'UNRESOLVED' THEN
      -- TAXES is undecided: test mode records the owner's test-mode tax reference, never an assumed rate.
      UPDATE hon.saas_invoices SET tax_status = 'NO_TAX_APPLICABLE', tax_minor = 0, tax_verification_reference = prog.test_tax_reference,
          total_minor = subtotal_minor, version = version + 1, updated_at = p_at WHERE id = inv.id RETURNING * INTO inv;
    END IF;
    IF inv.total_minor <> p_amount THEN RAISE EXCEPTION 'SAAS_PROVIDER_AMOUNT_MISMATCH' USING ERRCODE = '23514'; END IF;
    v_year := extract(year FROM p_at AT TIME ZONE 'UTC')::integer;
    INSERT INTO hon.saas_invoice_sequences(invoice_year, last_number) VALUES (v_year, 0) ON CONFLICT (invoice_year) DO NOTHING;
    UPDATE hon.saas_invoice_sequences SET last_number = last_number + 1 WHERE invoice_year = v_year RETURNING last_number INTO v_seq;
    UPDATE hon.saas_invoices SET status = 'ISSUED', invoice_number = 'HON-' || v_year || '-' || lpad(v_seq::text, 6, '0'),
        issued_by_principal_id = actor, issued_at = p_at, version = version + 1, updated_at = p_at WHERE id = inv.id RETURNING * INTO inv;
  END IF;
  IF inv.total_minor - (SELECT f.net_minor FROM hon.saas_invoice_facts(NULL, inv.id) f) < p_amount THEN
    RAISE EXCEPTION 'SAAS_PROVIDER_AMOUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.saas_payment_evidence(invoice_id,organization_id,subscription_id,kind,source,provider_event_id,provider_code,provider_mode,amount_minor,
      occurred_at,reference,recorded_by_principal_id,recorded_at)
    VALUES (inv.id,p_sub.organization_id,p_sub.id,'PAYMENT_RECEIVED','PROVIDER_VERIFIED',p_event->>'eventId',p_event->>'provider','TEST',p_amount,
      least(p_occurred, p_at),p_reference,actor,p_at)
    RETURNING id INTO ev;
  RETURN ev;
END $$;

CREATE FUNCTION hon.saas_link_payment_refs(p_provider text, p_refs text[], p_evidence uuid, p_at timestamptz) RETURNS void
LANGUAGE sql VOLATILE SET search_path = pg_catalog, hon AS $$
  INSERT INTO hon.saas_provider_payment_refs(provider, ref, evidence_id, recorded_at)
  SELECT p_provider, r, p_evidence, p_at FROM unnest(p_refs) r WHERE r IS NOT NULL ON CONFLICT DO NOTHING
$$;

-- Applies a verified successful checkout payment: B1 subscription recorded and started (founder slot
-- allocated), B2 invoice issued, PROVIDER_VERIFIED evidence recorded. Business conflicts never
-- activate anything: the checkout moves to PAID_NEEDS_REVIEW for the HQ owner (no automatic refund).
CREATE FUNCTION hon.saas_activate_checkout(p_checkout uuid, p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); c hon.saas_checkout_sessions%ROWTYPE; o jsonb := p_event->'object'; ent hon.organization_entitlements%ROWTYPE;
  res hon.saas_founder_reservations%ROWTYPE; s hon.saas_subscriptions%ROWTYPE; ev uuid; reason text; prior record; occurred timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || c.organization_id::text, 0));
  IF c.status = 'COMPLETED' THEN RETURN jsonb_build_object('outcome','ALREADY_APPLIED','detail','CHECKOUT_COMPLETED','subscriptionId',c.subscription_id); END IF;
  occurred := (p_event->>'createdAt')::timestamptz;
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = c.organization_id FOR SHARE;
  IF c.founder_reservation_id IS NOT NULL THEN SELECT * INTO res FROM hon.saas_founder_reservations WHERE id = c.founder_reservation_id FOR UPDATE; END IF;
  reason := CASE
    WHEN c.status IN ('EXPIRED','CANCELLED','FAILED','PAID_NEEDS_REVIEW') THEN 'PAID_AFTER_CLOSE'
    WHEN (o->>'amountTotal')::bigint IS DISTINCT FROM c.amount_minor OR o->>'currency' IS DISTINCT FROM 'usd' THEN 'AMOUNT_MISMATCH'
    WHEN ent.organization_id IS NULL OR ent.status <> 'ACTIVE' OR ent.tier::text <> c.plan_code OR ent.effective_from > p_at
      OR (ent.effective_until IS NOT NULL AND ent.effective_until <= p_at) THEN 'ENTITLEMENT_CHANGED'
    WHEN EXISTS (SELECT 1 FROM hon.saas_subscriptions x WHERE x.organization_id = c.organization_id AND x.status <> 'VOIDED') THEN 'SUBSCRIPTION_EXISTS'
    WHEN c.founder_reservation_id IS NOT NULL AND (res.status <> 'RESERVED' OR res.hold_expires_at <= occurred) THEN 'FOUNDER_UNAVAILABLE' END;
  IF reason IS NOT NULL THEN
    IF c.status <> 'PAID_NEEDS_REVIEW' THEN
      UPDATE hon.saas_checkout_sessions SET status = 'PAID_NEEDS_REVIEW', status_reason = reason, version = version + 1, updated_at = p_at,
          provider_customer_ref = coalesce(provider_customer_ref, o->>'customerRef')
        WHERE id = c.id;
    END IF;
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail',reason);
  END IF;
  INSERT INTO hon.saas_subscriptions(organization_id,source,catalog_id,offer_id,plan_code,entitlement_tier,offer_kind,billing_interval,price_minor,
      founder_reservation_id,entitlement_version_at_record,status,status_reason,version,created_by_principal_id,created_at,updated_at)
    VALUES (c.organization_id,'CATALOG_OFFER',c.catalog_id,c.offer_id,c.plan_code,ent.tier,c.offer_kind,c.billing_interval,c.amount_minor,
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
  RETURN jsonb_build_object('outcome','APPLIED','detail','SUBSCRIPTION_ACTIVATED','subscriptionId',s.id,'evidenceId',ev);
END $$;

-- Monthly renewal paid by the provider for the period starting at periodStart.
CREATE FUNCTION hon.saas_apply_renewal(p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); o jsonb := p_event->'object'; c hon.saas_checkout_sessions%ROWTYPE; s hon.saas_subscriptions%ROWTYPE;
  v_start timestamptz := (o->>'periodStart')::timestamptz; n integer; ev uuid;
BEGIN
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND provider_subscription_ref = o->>'subscriptionRef';
  IF c.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND status IN ('CREATED','OPEN')) THEN
      RAISE EXCEPTION 'SAAS_PROVIDER_EVENT_NOT_READY' USING ERRCODE = '55006';
    END IF;
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','UNKNOWN_PROVIDER_SUBSCRIPTION');
  END IF;
  SELECT * INTO s FROM hon.saas_subscriptions WHERE id = c.subscription_id FOR UPDATE;
  IF s.status NOT IN ('IN_SERVICE','SUSPENDED') OR s.billing_interval <> 'MONTHLY' THEN
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','SUBSCRIPTION_NOT_BILLABLE','subscriptionId',s.id,'organizationId',s.organization_id);
  END IF;
  -- The provider's period must line up (within a day) with one of HON's anchored periods.
  SELECT g INTO n FROM generate_series(0, s.period_index + 1) g
    WHERE abs(extract(epoch FROM (s.period_anchor_at + make_interval(months => g)) - v_start)) <= 86400 ORDER BY g LIMIT 1;
  IF n IS NULL THEN RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','PERIOD_MISMATCH','subscriptionId',s.id,'organizationId',s.organization_id); END IF;
  IF (o->>'amountPaid')::integer <> s.price_minor OR o->>'currency' <> 'usd' THEN
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','AMOUNT_MISMATCH','subscriptionId',s.id,'organizationId',s.organization_id);
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_free_periods f WHERE f.subscription_id = s.id AND f.period_index = n) THEN
    -- A Champions free month was charged by the provider: never invoiced; the HQ owner reviews it.
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','FREE_PERIOD_CHARGED','subscriptionId',s.id,'organizationId',s.organization_id);
  END IF;
  IF n = s.period_index + 1 THEN
    UPDATE hon.saas_subscriptions SET status_reason = 'PERIOD_ELAPSED', version = version + 1, period_index = period_index + 1,
        current_period_start = period_anchor_at + make_interval(months => period_index + 1),
        current_period_end = period_anchor_at + make_interval(months => period_index + 2), updated_at = p_at
      WHERE id = s.id RETURNING * INTO s;
    INSERT INTO hon.saas_subscription_history(subscription_id,version,status,status_reason,period_index,current_period_start,current_period_end,actor_principal_id,occurred_at)
      VALUES (s.id,s.version,s.status,s.status_reason,s.period_index,s.current_period_start,s.current_period_end,actor,p_at);
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_provider_payment_refs r WHERE r.provider = p_event->>'provider' AND r.ref IN (o->>'invoiceRef', o->>'paymentIntentRef')) THEN
    RETURN jsonb_build_object('outcome','ALREADY_APPLIED','detail','PAYMENT_ALREADY_RECORDED','subscriptionId',s.id,'organizationId',s.organization_id);
  END IF;
  ev := hon.saas_provider_invoice(s, n, (o->>'amountPaid')::integer, (p_event->>'createdAt')::timestamptz, o->>'invoiceRef', p_event, p_at);
  PERFORM hon.saas_link_payment_refs(p_event->>'provider', ARRAY[o->>'invoiceRef', o->>'paymentIntentRef'], ev, p_at);
  RETURN jsonb_build_object('outcome','APPLIED','detail','RENEWAL_RECORDED','subscriptionId',s.id,'organizationId',s.organization_id,'evidenceId',ev);
END $$;

-- Provider refund or dispute reconciled to the payment it reverses (REFUND / CHARGEBACK evidence).
CREATE FUNCTION hon.saas_apply_reversal(p_event jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); o jsonb := p_event->'object'; pay hon.saas_payment_evidence%ROWTYPE; v_kind text; v_amount bigint;
  already bigint; v_ref text;
BEGIN
  SELECT e.* INTO pay FROM hon.saas_provider_payment_refs r JOIN hon.saas_payment_evidence e ON e.id = r.evidence_id
    WHERE r.provider = p_event->>'provider' AND r.ref IN (o->>'paymentIntentRef', o->>'invoiceRef', o->>'chargeRef') LIMIT 1;
  IF pay.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND status IN ('CREATED','OPEN')) THEN
      RAISE EXCEPTION 'SAAS_PROVIDER_EVENT_NOT_READY' USING ERRCODE = '55006';
    END IF;
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','UNMATCHED_PAYMENT');
  END IF;
  PERFORM hon.saas_link_payment_refs(p_event->>'provider', ARRAY[o->>'chargeRef'], pay.id, p_at);
  IF p_event->>'type' = 'charge.refunded' THEN
    -- The provider reports the cumulative refunded amount; only the increase is new evidence.
    v_kind := 'REFUND';
    SELECT coalesce(sum(amount_minor), 0) INTO already FROM hon.saas_payment_evidence WHERE related_evidence_id = pay.id AND kind = 'REFUND' AND source = 'PROVIDER_VERIFIED';
    v_amount := (o->>'amountRefunded')::bigint - already; v_ref := p_event->>'eventId';
  ELSE
    v_kind := 'CHARGEBACK'; v_ref := o->>'disputeRef';
    IF EXISTS (SELECT 1 FROM hon.saas_payment_evidence WHERE invoice_id = pay.invoice_id AND kind = 'CHARGEBACK' AND reference = v_ref) THEN
      RETURN jsonb_build_object('outcome','ALREADY_APPLIED','detail','DISPUTE_ALREADY_RECORDED','subscriptionId',pay.subscription_id,'organizationId',pay.organization_id);
    END IF;
    v_amount := (o->>'amount')::bigint;
  END IF;
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('outcome','ALREADY_APPLIED','detail','REFUND_ALREADY_RECORDED','subscriptionId',pay.subscription_id,'organizationId',pay.organization_id);
  END IF;
  IF v_amount > pay.amount_minor - (SELECT coalesce(sum(amount_minor), 0) FROM hon.saas_payment_evidence WHERE related_evidence_id = pay.id) THEN
    RETURN jsonb_build_object('outcome','NEEDS_REVIEW','detail','REVERSAL_EXCEEDS_PAYMENT','subscriptionId',pay.subscription_id,'organizationId',pay.organization_id);
  END IF;
  INSERT INTO hon.saas_payment_evidence(invoice_id,organization_id,subscription_id,kind,source,provider_event_id,provider_code,provider_mode,amount_minor,
      occurred_at,reference,related_evidence_id,recorded_by_principal_id,recorded_at)
    VALUES (pay.invoice_id,pay.organization_id,pay.subscription_id,v_kind,'PROVIDER_VERIFIED',p_event->>'eventId',p_event->>'provider','TEST',v_amount,
      greatest(least((p_event->>'createdAt')::timestamptz, p_at), pay.occurred_at),v_ref,pay.id,actor,p_at);
  RETURN jsonb_build_object('outcome','APPLIED','detail',v_kind || '_RECORDED','subscriptionId',pay.subscription_id,'organizationId',pay.organization_id);
END $$;

-- ---------- reads ----------
CREATE FUNCTION hon.read_saas_payments_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE at timestamptz := clock_timestamp();
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  RETURN jsonb_build_object('program', hon.saas_payment_program_json(),
    'checkouts', (SELECT coalesce(jsonb_agg(hon.saas_checkout_json(c) ORDER BY c.created_at DESC, c.id), '[]'::jsonb)
      FROM (SELECT * FROM hon.saas_checkout_sessions ORDER BY created_at DESC, id LIMIT 100) c),
    'events', (SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',e.id,'provider',e.provider,'providerEventId',e.provider_event_id,'type',e.event_type,
        'organizationId',e.organization_id,'checkoutId',e.checkout_id,'subscriptionId',e.subscription_id,'outcome',e.outcome,'detail',e.outcome_detail,
        'providerCreatedAt',hon.saas_ts(e.provider_created_at),'receivedAt',hon.saas_ts(e.received_at)) ORDER BY e.received_at DESC, e.id), '[]'::jsonb)
      FROM (SELECT * FROM hon.saas_provider_events ORDER BY received_at DESC, id LIMIT 100) e),
    'reconciliation', jsonb_build_object(
      'openPastExpiry', (SELECT count(*) FROM hon.saas_checkout_sessions WHERE status IN ('CREATED','OPEN') AND expires_at <= at),
      'createdWithoutProviderSession', (SELECT count(*) FROM hon.saas_checkout_sessions WHERE status = 'CREATED'),
      'paidNeedsReview', (SELECT count(*) FROM hon.saas_checkout_sessions WHERE status = 'PAID_NEEDS_REVIEW'),
      'eventsNeedingReview', (SELECT count(*) FROM hon.saas_provider_events WHERE outcome = 'NEEDS_REVIEW'),
      'awaitingAsyncPayment', (SELECT count(*) FROM hon.saas_checkout_sessions c WHERE c.status = 'OPEN' AND EXISTS (SELECT 1 FROM hon.saas_provider_events e
        WHERE e.checkout_id = c.id AND e.outcome = 'AWAITING_ASYNC_PAYMENT'))),
    'asOf', hon.saas_ts(at));
END $$;

CREATE FUNCTION hon.read_saas_school_plan_options(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; ent hon.organization_entitlements%ROWTYPE; at timestamptz := clock_timestamp(); inv jsonb; sub hon.saas_subscriptions%ROWTYPE;
  chk hon.saas_checkout_sessions%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = actor.organization_id;
  inv := hon.saas_founder_inventory(at);
  SELECT * INTO sub FROM hon.saas_subscriptions WHERE organization_id = actor.organization_id AND status <> 'VOIDED';
  SELECT * INTO chk FROM hon.saas_checkout_sessions WHERE organization_id = actor.organization_id ORDER BY created_at DESC, id LIMIT 1;
  RETURN jsonb_build_object('schoolId', p_school, 'entitlementTier', ent.tier::text,
    'payments', jsonb_build_object('status', (SELECT status FROM hon.saas_payment_program WHERE program_id = 1),
      'mode', CASE WHEN (SELECT status FROM hon.saas_payment_program WHERE program_id = 1) = 'TEST_MODE' THEN 'TEST' END),
    'offers', (SELECT coalesce(jsonb_agg(jsonb_build_object('offerId',o.id,'planCode',o.plan_code,'offerKind',o.offer_kind,'billingInterval',o.billing_interval,
        'priceMinor',o.price_minor,'currency','USD','monthlyPremiumCredits',pl.planned_monthly_premium_credits,
        'founderSlotsRemaining',CASE WHEN o.offer_kind = 'FOUNDER_LIFETIME' THEN (inv#>>'{remaining,lifetime}')::int
          WHEN o.offer_kind = 'FOUNDER_MONTHLY' THEN (inv#>>'{remaining,monthly}')::int END) ORDER BY o.price_minor, o.offer_kind), '[]'::jsonb)
      FROM hon.saas_catalog_versions c JOIN hon.saas_catalog_offers o ON o.catalog_id = c.id
      JOIN hon.saas_catalog_plans pl ON pl.catalog_id = c.id AND pl.plan_code = o.plan_code
      WHERE c.status = 'PUBLISHED' AND o.plan_code = ent.tier::text
        AND (o.offer_kind NOT LIKE 'FOUNDER_%' OR (at >= c.founder_opens_at AND (c.founder_closes_at IS NULL OR at < c.founder_closes_at)))),
    'subscription', CASE WHEN sub.id IS NULL THEN NULL ELSE hon.saas_subscription_json(sub) - 'organizationName' END,
    'checkout', CASE WHEN chk.id IS NULL THEN NULL ELSE hon.saas_checkout_json(chk) END,
    'annualBilling', 'UNAVAILABLE', 'planChanges', 'UNAVAILABLE', 'cardDataStored', false);
END $$;

-- ---------- commands ----------
CREATE FUNCTION hon.set_saas_payment_program(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_payment_program%ROWTYPE; at timestamptz; snapshot jsonb; keys text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k);
  IF NOT coalesce(keys = ARRAY['action','authorizationReference','expectedVersion','provider','testTaxReference']
      AND p->>'action' IN ('ENABLE_TEST_MODE','DISABLE') AND jsonb_typeof(p->'expectedVersion') = 'number' AND (p->>'expectedVersion') ~ '^[1-9][0-9]{0,8}$'
      AND jsonb_typeof(p->'authorizationReference') = 'string' AND length(p->>'authorizationReference') BETWEEN 1 AND 200
      AND btrim(p->>'authorizationReference') = p->>'authorizationReference'
      AND CASE WHEN p->>'action' = 'ENABLE_TEST_MODE' THEN p->>'provider' IN ('STRIPE','STRIPE_SIMULATED')
          AND jsonb_typeof(p->'testTaxReference') = 'string' AND length(p->>'testTaxReference') BETWEEN 1 AND 200
          AND btrim(p->>'testTaxReference') = p->>'testTaxReference'
        ELSE jsonb_typeof(p->'provider') = 'null' AND jsonb_typeof(p->'testTaxReference') = 'null' END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.payments.program', hon.saas_fingerprint(ARRAY['saas.payments.program', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO prior FROM hon.saas_payment_program WHERE program_id = 1 FOR UPDATE;
  IF prior.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF (p->>'action' = 'ENABLE_TEST_MODE') = (prior.status = 'TEST_MODE') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  UPDATE hon.saas_payment_program SET status = CASE WHEN p->>'action' = 'ENABLE_TEST_MODE' THEN 'TEST_MODE' ELSE 'DISABLED' END,
      provider = p->>'provider', test_tax_reference = p->>'testTaxReference', authorization_reference = p->>'authorizationReference',
      version = version + 1, changed_by_principal_id = actor, changed_at = at WHERE program_id = 1;
  snapshot := hon.saas_payment_program_json();
  RETURN hon.saas_record(actor, p_key, 'saas.payments.program', 'saas.payments.program_changed', 'PAYMENT_PROGRAM',
    '00000000-0000-4000-8000-000000000003'::uuid, NULL, jsonb_build_object('status', prior.status, 'version', prior.version), snapshot,
    jsonb_build_object('program', snapshot), at);
END $$;

CREATE FUNCTION hon.create_saas_checkout_from_school(p_subject text, p_school uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor record; replay jsonb; created hon.saas_checkout_sessions%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p_school IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['offerId']
    OR coalesce(jsonb_typeof(p->'offerId'), '') <> 'string' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.family_access_grants IN SHARE MODE;
  SELECT * INTO actor FROM hon.require_saas_school_purchaser(p_subject, p_school);
  replay := hon.saas_claim_request(actor.principal_id, p_key, 'saas.checkout.create', hon.saas_fingerprint(ARRAY['saas.checkout.create', p_school::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  created := hon.saas_open_checkout(actor.principal_id, actor.organization_id, p_school, (p->>'offerId')::uuid, 'SCHOOL_OWNER', at);
  snapshot := hon.saas_checkout_json(created);
  RETURN hon.saas_record(actor.principal_id, p_key, 'saas.checkout.create', 'saas.checkout.created', 'CHECKOUT', created.id, created.organization_id,
    NULL, snapshot, jsonb_build_object('checkout', snapshot), at);
END $$;

CREATE FUNCTION hon.create_saas_checkout_from_hq(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; created hon.saas_checkout_sessions%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['offerId','organizationId']
    OR coalesce(jsonb_typeof(p->'offerId'), '') <> 'string' OR coalesce(jsonb_typeof(p->'organizationId'), '') <> 'string' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, false);
  replay := hon.saas_claim_request(actor, p_key, 'saas.checkout.create', hon.saas_fingerprint(ARRAY['saas.checkout.create', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  created := hon.saas_open_checkout(actor, (p->>'organizationId')::uuid, NULL, (p->>'offerId')::uuid, 'HQ', at);
  snapshot := hon.saas_checkout_json(created);
  RETURN hon.saas_record(actor, p_key, 'saas.checkout.create', 'saas.checkout.created', 'CHECKOUT', created.id, created.organization_id,
    NULL, snapshot, jsonb_build_object('checkout', snapshot), at);
END $$;

-- The checkout's requester (school purchaser or HQ actor) records the adapter outcome:
-- OPENED (provider session id and hosted URL) or FAILED (nothing was sent to the provider).
-- An UNKNOWN adapter outcome records nothing: the checkout stays CREATED for reconciliation.
CREATE FUNCTION hon.attach_saas_checkout_session(p_subject text, p_checkout uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; c hon.saas_checkout_sessions%ROWTYPE; updated hon.saas_checkout_sessions%ROWTYPE; at timestamptz; snapshot jsonb; keys text[];
BEGIN
  IF p_checkout IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k);
  IF NOT coalesce(keys = ARRAY['checkoutUrl','outcome','providerSessionId'] AND CASE p->>'outcome'
      WHEN 'OPENED' THEN jsonb_typeof(p->'providerSessionId') = 'string' AND (p->>'providerSessionId') ~ '^cs_test_[A-Za-z0-9_]{1,200}$'
        AND jsonb_typeof(p->'checkoutUrl') = 'string'
        AND length(p->>'checkoutUrl') <= 2000 AND (p->>'checkoutUrl') ~ '^https://(checkout\.stripe\.com|checkout\.simulated\.invalid)/[A-Za-z0-9_/#%?=&.-]+$'
      WHEN 'FAILED' THEN jsonb_typeof(p->'providerSessionId') = 'null' AND jsonb_typeof(p->'checkoutUrl') = 'null'
      ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF c.requester_kind = 'SCHOOL_OWNER' THEN
    SELECT principal_id INTO actor FROM hon.require_saas_school_purchaser(p_subject, c.school_id);
  ELSE
    actor := hon.require_saas_hq_actor(p_subject, false);
  END IF;
  IF actor <> c.requested_by_principal_id THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  replay := hon.saas_claim_request(actor, p_key, 'saas.checkout.attach', hon.saas_fingerprint(ARRAY['saas.checkout.attach', p_checkout::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout FOR UPDATE;
  IF c.status <> 'CREATED' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  IF p->>'outcome' = 'OPENED' THEN
    UPDATE hon.saas_checkout_sessions SET status = 'OPEN', status_reason = 'PROVIDER_SESSION_OPENED', version = version + 1,
        provider_session_id = p->>'providerSessionId', checkout_url = p->>'checkoutUrl', updated_at = at
      WHERE id = c.id RETURNING * INTO updated;
  ELSE
    updated := hon.saas_close_checkout(c.id, 'FAILED', 'PROVIDER_CREATE_FAILED', actor, at);
  END IF;
  snapshot := hon.saas_checkout_json(updated);
  RETURN hon.saas_record(actor, p_key, 'saas.checkout.attach', 'saas.checkout.changed', 'CHECKOUT', updated.id, updated.organization_id,
    jsonb_build_object('status', c.status, 'version', c.version), snapshot, jsonb_build_object('checkout', snapshot), at);
END $$;

CREATE FUNCTION hon.cancel_saas_checkout(p_subject text, p_checkout uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; c hon.saas_checkout_sessions%ROWTYPE; updated hon.saas_checkout_sessions%ROWTYPE; at timestamptz; snapshot jsonb; v_reason text;
BEGIN
  IF p_checkout IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion']
    OR coalesce(jsonb_typeof(p->'expectedVersion'), '') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  -- The school's own purchaser, or HQ (owner or operator).
  BEGIN
    IF c.school_id IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
    SELECT principal_id INTO actor FROM hon.require_saas_school_purchaser(p_subject, c.school_id); v_reason := 'CANCELLED_BY_REQUESTER';
  EXCEPTION WHEN insufficient_privilege THEN
    actor := hon.require_saas_hq_actor(p_subject, false); v_reason := 'CANCELLED_BY_HQ';
  END;
  replay := hon.saas_claim_request(actor, p_key, 'saas.checkout.cancel', hon.saas_fingerprint(ARRAY['saas.checkout.cancel', p_checkout::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = p_checkout FOR UPDATE;
  IF c.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF c.status NOT IN ('CREATED','OPEN') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  updated := hon.saas_close_checkout(c.id, 'CANCELLED', v_reason, actor, at);
  snapshot := hon.saas_checkout_json(updated);
  RETURN hon.saas_record(actor, p_key, 'saas.checkout.cancel', 'saas.checkout.changed', 'CHECKOUT', updated.id, updated.organization_id,
    jsonb_build_object('status', c.status, 'version', c.version), snapshot, jsonb_build_object('checkout', snapshot), at);
END $$;

-- HQ (owner or operator): expire checkouts past their expiry and return their founder holds.
CREATE FUNCTION hon.sweep_saas_checkouts(p_subject text, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; at timestamptz; c record; n integer := 0;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, false);
  replay := hon.saas_claim_request(actor, p_key, 'saas.checkout.sweep', hon.saas_fingerprint(ARRAY['saas.checkout.sweep']), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  at := clock_timestamp();
  FOR c IN SELECT id FROM hon.saas_checkout_sessions WHERE status IN ('CREATED','OPEN') AND expires_at <= at ORDER BY id FOR UPDATE LOOP
    PERFORM hon.saas_close_checkout(c.id, 'EXPIRED', 'LOCAL_EXPIRED', actor, at); n := n + 1;
  END LOOP;
  RETURN hon.saas_record(actor, p_key, 'saas.checkout.sweep', 'saas.checkouts.swept', 'CHECKOUT', '00000000-0000-4000-8000-000000000004'::uuid, NULL,
    NULL, jsonb_build_object('expired', n), jsonb_build_object('expired', n, 'asOf', hon.saas_ts(at)), at);
END $$;

-- A provider event whose signature the API has already verified. Only test-mode events of the
-- configured provider are accepted; each provider event id is applied once (the idempotency key is
-- derived from it), a different payload under the same id is refused, and an event whose dependency
-- has not arrived yet is refused with SAAS_PROVIDER_EVENT_NOT_READY so the provider redelivers it.
CREATE FUNCTION hon.ingest_saas_provider_event(p_event jsonb, p_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); prog hon.saas_payment_program%ROWTYPE; replay jsonb; o jsonb; v_type text; at timestamptz;
  c hon.saas_checkout_sessions%ROWTYPE; result jsonb; v_key uuid; v_org uuid; ev_id uuid; keys text[];
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_event IS NULL OR jsonb_typeof(p_event) <> 'object' OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_event) k) IS DISTINCT FROM ARRAY['createdAt','eventId','livemode','object','provider','type']
    OR p_event->>'provider' NOT IN ('STRIPE','STRIPE_SIMULATED') OR coalesce(p_event->>'eventId', '') !~ '^evt_[A-Za-z0-9_]{1,200}$'
    OR jsonb_typeof(p_event->'livemode') <> 'boolean' OR coalesce(jsonb_typeof(p_event->'object'), '') <> 'object'
    OR coalesce(p_event->>'type', '') !~ '^[a-z_]+(\.[a-z_]+){1,3}$' OR length(p_event->>'type') > 80
    OR coalesce(p_event->>'createdAt', '') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF (p_event->>'livemode')::boolean THEN RAISE EXCEPTION 'SAAS_PROVIDER_LIVE_MODE_REFUSED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO prog FROM hon.saas_payment_program WHERE program_id = 1 FOR SHARE;
  IF prog.status <> 'TEST_MODE' OR prog.provider <> p_event->>'provider' THEN RAISE EXCEPTION 'SAAS_PAYMENTS_NOT_ACTIVE' USING ERRCODE = '42501'; END IF;
  o := p_event->'object'; v_type := p_event->>'type'; keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(o) k);
  -- Closed shapes for the event types HON applies; amounts are integer minor units.
  IF NOT coalesce(CASE
    WHEN v_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded') THEN
      keys = ARRAY['amountTotal','checkoutId','currency','customerRef','invoiceRef','paymentIntentRef','paymentStatus','sessionId','subscriptionRef']
      AND (o->>'sessionId') ~ '^cs_test_[A-Za-z0-9_]{1,200}$' AND (o->>'checkoutId') ~ '^[0-9a-f-]{36}$' AND jsonb_typeof(o->'amountTotal') = 'number'
      AND (o->>'amountTotal') ~ '^[0-9]{1,9}$' AND jsonb_typeof(o->'currency') = 'string' AND o->>'paymentStatus' IN ('paid','unpaid','no_payment_required')
      AND (jsonb_typeof(o->'customerRef') = 'null' OR (o->>'customerRef') ~ '^cus_[A-Za-z0-9]{1,100}$')
      AND (jsonb_typeof(o->'subscriptionRef') = 'null' OR (o->>'subscriptionRef') ~ '^sub_[A-Za-z0-9]{1,100}$')
      AND (jsonb_typeof(o->'paymentIntentRef') = 'null' OR (o->>'paymentIntentRef') ~ '^pi_[A-Za-z0-9_]{1,200}$')
      AND (jsonb_typeof(o->'invoiceRef') = 'null' OR (o->>'invoiceRef') ~ '^in_[A-Za-z0-9_]{1,200}$')
    WHEN v_type IN ('checkout.session.expired','checkout.session.async_payment_failed') THEN
      keys = ARRAY['checkoutId','sessionId'] AND (o->>'sessionId') ~ '^cs_test_[A-Za-z0-9_]{1,200}$' AND (o->>'checkoutId') ~ '^[0-9a-f-]{36}$'
    WHEN v_type IN ('invoice.paid','invoice.payment_failed') THEN
      keys = ARRAY['amount','billingReason','currency','invoiceRef','paymentIntentRef','periodEnd','periodStart','subscriptionRef']
      AND (o->>'invoiceRef') ~ '^in_[A-Za-z0-9_]{1,200}$' AND (o->>'subscriptionRef') ~ '^sub_[A-Za-z0-9]{1,100}$'
      AND jsonb_typeof(o->'amount') = 'number' AND (o->>'amount') ~ '^[0-9]{1,9}$' AND jsonb_typeof(o->'billingReason') = 'string'
      AND (jsonb_typeof(o->'paymentIntentRef') = 'null' OR (o->>'paymentIntentRef') ~ '^pi_[A-Za-z0-9_]{1,200}$')
      AND (o->>'periodStart') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]{12}Z$' AND (o->>'periodEnd') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]{12}Z$'
    WHEN v_type = 'charge.refunded' THEN
      keys = ARRAY['amountRefunded','chargeRef','currency','invoiceRef','paymentIntentRef'] AND (o->>'chargeRef') ~ '^(ch|py)_[A-Za-z0-9_]{1,200}$'
      AND jsonb_typeof(o->'amountRefunded') = 'number' AND (o->>'amountRefunded') ~ '^[0-9]{1,9}$'
      AND (jsonb_typeof(o->'paymentIntentRef') = 'null' OR (o->>'paymentIntentRef') ~ '^pi_[A-Za-z0-9_]{1,200}$')
      AND (jsonb_typeof(o->'invoiceRef') = 'null' OR (o->>'invoiceRef') ~ '^in_[A-Za-z0-9_]{1,200}$')
    WHEN v_type = 'charge.dispute.created' THEN
      keys = ARRAY['amount','chargeRef','currency','disputeRef','paymentIntentRef'] AND (o->>'chargeRef') ~ '^(ch|py)_[A-Za-z0-9_]{1,200}$'
      AND (o->>'disputeRef') ~ '^(dp|du)_[A-Za-z0-9_]{1,200}$' AND jsonb_typeof(o->'amount') = 'number' AND (o->>'amount') ~ '^[0-9]{1,9}$'
      AND (jsonb_typeof(o->'paymentIntentRef') = 'null' OR (o->>'paymentIntentRef') ~ '^pi_[A-Za-z0-9_]{1,200}$')
    ELSE keys IS NULL OR keys = ARRAY[]::text[] END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_key := md5('saas.provider.event:' || (p_event->>'provider') || ':' || (p_event->>'eventId'))::uuid;
  replay := hon.saas_claim_request(actor, v_key, 'saas.provider.event', p_digest, gen_random_uuid(), gen_random_uuid());
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  IF v_type LIKE 'checkout.session.%' THEN
    SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = (o->>'checkoutId')::uuid AND provider = p_event->>'provider';
    IF c.id IS NULL OR (c.provider_session_id IS NOT NULL AND c.provider_session_id <> o->>'sessionId')
      OR EXISTS (SELECT 1 FROM hon.saas_checkout_sessions x WHERE x.provider_session_id = o->>'sessionId' AND x.id <> c.id) THEN
      result := jsonb_build_object('outcome','NEEDS_REVIEW','detail','UNKNOWN_CHECKOUT');
      c := NULL;
    ELSE
      v_org := c.organization_id;
      IF c.provider_session_id IS NULL THEN
        -- The adapter outcome was unknown, but the provider proves the session: attach it (no URL is shown again).
        UPDATE hon.saas_checkout_sessions SET provider_session_id = o->>'sessionId', version = version + 1, updated_at = at WHERE id = c.id;
      END IF;
      IF v_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded') THEN
        IF o->>'paymentStatus' = 'paid' THEN
          result := hon.saas_activate_checkout(c.id, p_event, at);
        ELSE
          result := jsonb_build_object('outcome','AWAITING_ASYNC_PAYMENT','detail','PAYMENT_PENDING');
        END IF;
      ELSE
        SELECT * INTO c FROM hon.saas_checkout_sessions WHERE id = c.id FOR UPDATE;
        IF c.status IN ('CREATED','OPEN') THEN
          PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
          PERFORM hon.saas_close_checkout(c.id, CASE WHEN v_type = 'checkout.session.expired' THEN 'EXPIRED' ELSE 'FAILED' END,
            CASE WHEN v_type = 'checkout.session.expired' THEN 'PROVIDER_EXPIRED' ELSE 'ASYNC_PAYMENT_FAILED' END, actor, at);
          result := jsonb_build_object('outcome','APPLIED','detail',CASE WHEN v_type = 'checkout.session.expired' THEN 'CHECKOUT_EXPIRED' ELSE 'ASYNC_PAYMENT_FAILED' END);
        ELSE
          result := jsonb_build_object('outcome','IGNORED','detail','CHECKOUT_ALREADY_CLOSED');
        END IF;
      END IF;
    END IF;
  ELSIF v_type = 'invoice.paid' THEN
    IF o->>'billingReason' = 'subscription_create' THEN
      -- Covered by the checkout completion; linked to its payment so refunds reconcile either way.
      SELECT * INTO c FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND provider_subscription_ref = o->>'subscriptionRef';
      IF c.id IS NOT NULL THEN
        v_org := c.organization_id;
        PERFORM hon.saas_link_payment_refs(p_event->>'provider', ARRAY[o->>'invoiceRef', o->>'paymentIntentRef'],
          (SELECT e.id FROM hon.saas_payment_evidence e WHERE e.invoice_id = c.invoice_id AND e.kind = 'PAYMENT_RECEIVED' ORDER BY e.recorded_at LIMIT 1), at);
      END IF;
      result := jsonb_build_object('outcome','ALREADY_APPLIED','detail','FIRST_INVOICE_COVERED_BY_CHECKOUT','subscriptionId',c.subscription_id);
    ELSE
      result := hon.saas_apply_renewal(jsonb_set(p_event, '{object,amountPaid}', o->'amount'), at);
    END IF;
  ELSIF v_type = 'invoice.payment_failed' THEN
    SELECT * INTO c FROM hon.saas_checkout_sessions WHERE provider = p_event->>'provider' AND provider_subscription_ref = o->>'subscriptionRef';
    -- Recorded for payment status (PAST_DUE); HON never suspends, cancels or retries automatically.
    result := CASE WHEN c.id IS NULL THEN jsonb_build_object('outcome','NEEDS_REVIEW','detail','UNKNOWN_PROVIDER_SUBSCRIPTION')
      ELSE jsonb_build_object('outcome','APPLIED','detail','RENEWAL_PAYMENT_FAILED','subscriptionId',c.subscription_id,'organizationId',c.organization_id) END;
  ELSIF v_type IN ('charge.refunded','charge.dispute.created') THEN
    result := hon.saas_apply_reversal(p_event, at);
  ELSE
    result := jsonb_build_object('outcome','IGNORED','detail','EVENT_TYPE_NOT_USED');
  END IF;
  v_org := coalesce(v_org, (result->>'organizationId')::uuid,
    (SELECT organization_id FROM hon.saas_subscriptions WHERE id = (result->>'subscriptionId')::uuid));
  INSERT INTO hon.saas_provider_events(provider,provider_event_id,event_type,livemode,provider_created_at,received_at,payload_digest,normalized,
      organization_id,checkout_id,subscription_id,outcome,outcome_detail)
    VALUES (p_event->>'provider',p_event->>'eventId',v_type,false,(p_event->>'createdAt')::timestamptz,at,p_digest,p_event,
      v_org,c.id,(result->>'subscriptionId')::uuid,result->>'outcome',result->>'detail')
    RETURNING id INTO ev_id;
  result := jsonb_build_object('eventId', ev_id, 'providerEventId', p_event->>'eventId', 'type', v_type, 'outcome', result->>'outcome',
    'detail', result->>'detail', 'organizationId', v_org, 'checkoutId', c.id, 'subscriptionId', result->>'subscriptionId');
  RETURN hon.saas_record(actor, v_key, 'saas.provider.event', 'saas.provider.event_recorded', 'PROVIDER_EVENT', ev_id, v_org, NULL, result,
    jsonb_build_object('event', result), at);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_payment_program','saas_checkout_sessions','saas_provider_events','saas_provider_payment_refs'] LOOP
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
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = 'hon.saas_payment_evidence'::regclass AND attname IN ('provider_code','provider_mode') LOOP
    EXECUTE format('REVOKE ALL (%I) ON hon.saas_payment_evidence FROM PUBLIC CASCADE',col);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.saas_payment_evidence FROM %I CASCADE',col,r);
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
      hon.sweep_saas_checkouts(text,uuid,uuid,uuid), hon.ingest_saas_provider_event(jsonb,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
