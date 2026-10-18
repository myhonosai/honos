BEGIN;

-- HON Subscription Billing Milestone B4: 30-day refund guarantee records and Champions Club reward
-- application, connecting B1 subscriptions, B2 invoices and payment evidence, B3 allowances and the
-- Champions Club M2 reward ledger. No money moves here:
-- - Refund requests are eligibility, approval and accounting records only; execution_status is
--   pinned NOT_EXECUTED. A refund is only ever evidenced by an HQ-attested B2 REFUND entry.
-- - Champions rewards are applied only after the HQ owner activates reward fulfillment, and only for
--   APPROVED M2 entries with no open payment alert. Applying records account credit, free service
--   periods or a blocked lifetime conversion; it never charges, pays out, issues a prize or changes a
--   plan, entitlement or founder slot. Previews never count as fulfillment.
-- - A refund or chargeback against a referred school raises a referral payment alert for owner review;
--   nothing is reversed, clawed back or charged automatically.
-- - Free months and lifetime use the B3 allowance (one ledger, full plan allowance, no rollover).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON refunds and fulfillment require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON refunds and fulfillment require a restricted runtime';
  END IF;
END $$;

-- ---------- owner decisions ----------
ALTER TABLE hon.saas_policy_decisions DROP CONSTRAINT saas_policy_decisions_policy_code_check;
ALTER TABLE hon.saas_policy_decisions ADD CONSTRAINT saas_policy_decisions_policy_code_check CHECK (policy_code IN ('ANNUAL_BILLING','TAXES',
  'PRORATION','PLAN_CHANGE_TIMING','CANCELLATION_TIMING','REFUND_EXECUTION','PAYMENT_PROVIDER','FOUNDER_SLOT_RETURN','CREDIT_ROLLOVER',
  'TOP_UP_PRICING','REFUND_GUARANTEE','FOUNDER_PROGRAM','FOUNDER_RESERVATION_HOLD','FOUNDER_ALLOWANCE','PLAN_ALLOWANCES','PREMIUM_OPERATIONS',
  'SUSPENDED_ALLOWANCE','PAYMENT_ATTESTATION','ZERO_DOLLAR_INVOICE','REWARD_CLAWBACK','CHAMPIONS_REWARD_LADDER'));
INSERT INTO hon.saas_policy_decisions(policy_code, status, blocks) VALUES
  ('ZERO_DOLLAR_INVOICE','UNDECIDED','A fully credited (zero-dollar) invoice cannot be issued'),
  ('REWARD_CLAWBACK','UNDECIDED','No fulfilled reward is reversed, clawed back or charged'),
  ('CHAMPIONS_REWARD_LADDER','UNDECIDED','No Champions reward is applied to a HON subscription');
INSERT INTO hon.saas_policy_records(policy_code, version, status, decision_code, summary, blocks, source_reference, recorded_at) VALUES
  ('REFUND_GUARANTEE',3,'DECIDED','FIRST_PURCHASE_30_DAY_FULL_REFUND_ALL_OFFERS',
    '100% refund of the first eligible HON plan purchase when requested within 30 days of its first recorded payment; regular Core and Complete, founder monthly and paid lifetime are covered.',
    'Refund execution stays unavailable until a payment provider, final customer terms and owner approval exist; subscription consequences stay blocked.','OWNER_DIRECTION_2026_10_18_B4',clock_timestamp()),
  ('CHAMPIONS_REWARD_LADDER',2,'DECIDED','CREDITS_1_4_WELCOME_6_12_MONTHS_PRIZE_20_LIFETIME_30',
    '$100 account credit per qualifying referral 1-4 and $100 welcome credit per qualified referred school; 6 total free months at 5 referrals and 12 total (including the 6) at 10; an approved prize at 20; lifetime membership with the full monthly AI allowance at 30.',
    'Rewards are applied only after the HQ owner activates reward fulfillment; prizes are never issued here.','OWNER_DIRECTION_2026_10_18_B4',clock_timestamp()),
  ('REWARD_CLAWBACK',2,'UNDECIDED',NULL,'The clawback policy is subject to owner approval.',
    'Refunds and chargebacks raise referral payment alerts and block unresolved rewards; nothing fulfilled is reversed and no debt is created.','OWNER_DIRECTION_2026_10_18_B4',clock_timestamp()),
  ('ZERO_DOLLAR_INVOICE',2,'UNDECIDED',NULL,'Zero-dollar invoices are permitted only where final terms allow.',
    'Credits may reduce a draft to zero, but a zero-total invoice cannot be issued.','OWNER_DIRECTION_2026_10_18_B4',clock_timestamp());

-- ---------- refund guarantee ----------
CREATE TABLE hon.saas_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES hon.saas_invoices(id) ON DELETE RESTRICT,
  offer_kind text NOT NULL CHECK (offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME')),
  first_paid_at timestamptz NOT NULL,
  window_ends_at timestamptz NOT NULL,
  request_received_at timestamptz NOT NULL,
  customer_reference text NOT NULL CHECK (length(customer_reference) BETWEEN 1 AND 200),
  requested_amount_minor integer NOT NULL CHECK (requested_amount_minor > 0),
  approved_amount_minor integer CHECK (approved_amount_minor > 0),
  evidence_strength text NOT NULL CHECK (evidence_strength IN ('HQ_ATTESTED','PROVIDER_VERIFIED')),
  status text NOT NULL CHECK (status IN ('REQUESTED','APPROVED','DENIED','REFUND_EVIDENCED')),
  status_reason text NOT NULL CHECK (status_reason IN ('REQUESTED','GUARANTEE_APPROVED','OWNER_DECLINED_TERMS','FRAUD_SUSPECTED',
    'DUPLICATE_REQUEST','REFUND_EVIDENCE_RECORDED')),
  execution_status text NOT NULL DEFAULT 'NOT_EXECUTED' CHECK (execution_status = 'NOT_EXECUTED'),
  subscription_consequence text NOT NULL DEFAULT 'BLOCKED_PENDING_TERMS' CHECK (subscription_consequence = 'BLOCKED_PENDING_TERMS'),
  version integer NOT NULL CHECK (version > 0),
  note text CHECK (length(note) BETWEEN 1 AND 500),
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  decided_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  CHECK (window_ends_at = first_paid_at + interval '30 days'),
  CHECK (request_received_at >= first_paid_at AND request_received_at < window_ends_at AND request_received_at <= created_at),
  CHECK ((status IN ('APPROVED','REFUND_EVIDENCED')) = (approved_amount_minor IS NOT NULL)),
  CHECK ((status = 'REQUESTED') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by_principal_id IS NULL))
);
-- One live request per organization: the guarantee covers the first purchase once.
CREATE UNIQUE INDEX saas_refund_one_live_per_organization ON hon.saas_refund_requests (organization_id) WHERE status <> 'DENIED';

CREATE TABLE hon.saas_refund_history (
  refund_request_id uuid NOT NULL REFERENCES hon.saas_refund_requests(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL, status_reason text NOT NULL,
  amount_minor integer,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (refund_request_id, version)
);

-- ---------- Champions reward fulfillment ----------
CREATE TABLE hon.saas_reward_fulfillment (
  program_id smallint PRIMARY KEY CHECK (program_id = 1),
  status text NOT NULL CHECK (status IN ('INACTIVE','ACTIVE')),
  version integer NOT NULL CHECK (version > 0),
  authorization_reference text CHECK (length(authorization_reference) BETWEEN 1 AND 200),
  changed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL,
  prizes_issued boolean NOT NULL DEFAULT false CHECK (prizes_issued = false),
  cash_payouts boolean NOT NULL DEFAULT false CHECK (cash_payouts = false),
  CHECK (status = 'INACTIVE' OR (authorization_reference IS NOT NULL AND changed_by_principal_id IS NOT NULL))
);
INSERT INTO hon.saas_reward_fulfillment(program_id, status, version, changed_at) VALUES (1, 'INACTIVE', 1, clock_timestamp());

-- One application per Champions reward entry, ever (duplicate benefits are impossible).
CREATE TABLE hon.saas_reward_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_entry_id uuid NOT NULL UNIQUE REFERENCES hon.champions_reward_entries(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  application_kind text NOT NULL CHECK (application_kind IN ('ACCOUNT_CREDIT','FREE_PERIODS','LIFETIME_CONVERSION')),
  credit_minor integer CHECK (credit_minor > 0),
  free_months integer CHECK (free_months BETWEEN 1 AND 60),
  first_period_index integer CHECK (first_period_index >= 0),
  lifetime_tier hon.plan_tier,
  status text NOT NULL CHECK (status IN ('APPLIED','CONVERSION_BLOCKED')),
  applied_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL,
  CHECK (CASE application_kind
    WHEN 'ACCOUNT_CREDIT' THEN credit_minor IS NOT NULL AND free_months IS NULL AND first_period_index IS NULL AND lifetime_tier IS NULL AND status = 'APPLIED'
    WHEN 'FREE_PERIODS' THEN credit_minor IS NULL AND free_months IS NOT NULL AND first_period_index IS NOT NULL AND lifetime_tier IS NULL AND status = 'APPLIED'
    ELSE credit_minor IS NULL AND free_months IS NULL AND first_period_index IS NULL AND lifetime_tier IS NOT NULL AND status = 'CONVERSION_BLOCKED' END)
);

-- Account credit: GRANT from an applied reward; APPLY consumes a grant onto a draft invoice line.
CREATE TABLE hon.saas_account_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  entry_kind text NOT NULL CHECK (entry_kind IN ('GRANT','APPLY')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  application_id uuid REFERENCES hon.saas_reward_applications(id) ON DELETE RESTRICT,
  grant_id uuid REFERENCES hon.saas_account_credit_ledger(id) ON DELETE RESTRICT,
  invoice_id uuid REFERENCES hon.saas_invoices(id) ON DELETE RESTRICT,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  CHECK (CASE entry_kind WHEN 'GRANT' THEN application_id IS NOT NULL AND grant_id IS NULL AND invoice_id IS NULL
    ELSE application_id IS NULL AND grant_id IS NOT NULL AND invoice_id IS NOT NULL END)
);
CREATE UNIQUE INDEX saas_account_credit_one_grant_per_application ON hon.saas_account_credit_ledger (application_id) WHERE entry_kind = 'GRANT';

-- Free service periods: one row per covered billing period, never counted twice.
CREATE TABLE hon.saas_free_periods (
  subscription_id uuid NOT NULL REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  period_index integer NOT NULL CHECK (period_index >= 0),
  application_id uuid NOT NULL REFERENCES hon.saas_reward_applications(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (subscription_id, period_index)
);

-- A refund or chargeback against a referred school, raised for owner review of the referral.
CREATE TABLE hon.saas_referral_payment_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id uuid NOT NULL REFERENCES hon.champions_attributions(id) ON DELETE RESTRICT,
  referred_organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  referrer_school_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('PAYMENT_EVIDENCE','REFUND_REQUEST')),
  payment_evidence_id uuid REFERENCES hon.saas_payment_evidence(id) ON DELETE RESTRICT,
  refund_request_id uuid REFERENCES hon.saas_refund_requests(id) ON DELETE RESTRICT,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('REFUND','CHARGEBACK','REFUND_APPROVED')),
  referred_recorded_net_minor bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  resolution text CHECK (resolution IN ('ATTRIBUTION_DECIDED','NO_QUALIFICATION_IMPACT')),
  resolution_reference text CHECK (length(resolution_reference) BETWEEN 1 AND 300),
  version integer NOT NULL CHECK (version > 0),
  raised_at timestamptz NOT NULL,
  resolved_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  CHECK ((source = 'PAYMENT_EVIDENCE') = (payment_evidence_id IS NOT NULL) AND (source = 'REFUND_REQUEST') = (refund_request_id IS NOT NULL)),
  CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL) AND (resolved_at IS NULL) = (resolution IS NULL)
    AND (resolved_at IS NULL) = (resolution_reference IS NULL) AND (resolved_at IS NULL) = (resolved_by_principal_id IS NULL))
);
CREATE UNIQUE INDEX saas_referral_alert_once_per_evidence ON hon.saas_referral_payment_alerts (attribution_id, payment_evidence_id) WHERE payment_evidence_id IS NOT NULL;
CREATE UNIQUE INDEX saas_referral_alert_once_per_refund ON hon.saas_referral_payment_alerts (attribution_id, refund_request_id) WHERE refund_request_id IS NOT NULL;

-- ---------- vocabularies on earlier tables ----------
ALTER TABLE hon.saas_invoice_lines DROP CONSTRAINT saas_invoice_lines_line_kind_check;
ALTER TABLE hon.saas_invoice_lines ADD CONSTRAINT saas_invoice_lines_line_kind_check CHECK (line_kind IN ('PLAN_FEE','DISCOUNT','CORRECTION','TAX','ACCOUNT_CREDIT'));
ALTER TABLE hon.saas_invoice_lines DROP CONSTRAINT saas_invoice_lines_check;
ALTER TABLE hon.saas_invoice_lines ADD CONSTRAINT saas_invoice_lines_check CHECK (CASE line_kind WHEN 'PLAN_FEE' THEN amount_minor > 0
  WHEN 'DISCOUNT' THEN amount_minor < 0 WHEN 'TAX' THEN amount_minor > 0 WHEN 'ACCOUNT_CREDIT' THEN amount_minor < 0 ELSE true END);
ALTER TABLE hon.saas_credit_allowances DROP CONSTRAINT saas_credit_allowances_allowance_basis_check;
ALTER TABLE hon.saas_credit_allowances ADD CONSTRAINT saas_credit_allowances_allowance_basis_check CHECK (allowance_basis IN ('REGULAR','FOUNDER',
  'LIFETIME','LEGACY','CHAMPIONS_FREE_MONTH'));
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (action_code IN ('saas.catalog.draft','saas.catalog.publish',
  'saas.founder.reserve','saas.founder.release','saas.subscription.record','saas.subscription.command',
  'saas.invoice.draft','saas.invoice.command','saas.payment.evidence',
  'saas.credits.program','saas.credits.cost_evidence','saas.credits.pricing_draft','saas.credits.pricing_publish',
  'saas.credits.allowance','saas.credits.reserve','saas.credits.settle','saas.credits.resolve',
  'saas.refund.request','saas.refund.decide','saas.rewards.fulfillment','saas.rewards.apply','saas.rewards.credit_apply','saas.rewards.alert_resolve'));
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION',
  'INVOICE','PAYMENT_EVIDENCE','CREDIT_PROGRAM','COST_EVIDENCE','PRICING','ALLOWANCE','CREDIT_RESERVATION',
  'REFUND_REQUEST','REWARD_FULFILLMENT','REWARD_APPLICATION','REFERRAL_ALERT'));
ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published',
  'saas.founder.reserved','saas.founder.released','saas.subscription.recorded','saas.subscription.changed',
  'saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded',
  'saas.credits.program_changed','saas.credits.cost_recorded','saas.credits.pricing_drafted','saas.credits.pricing_published',
  'saas.credits.allowance_changed','saas.credits.reserved','saas.credits.settled','saas.credits.resolved',
  'saas.refund.requested','saas.refund.decided','saas.rewards.fulfillment_changed','saas.rewards.applied','saas.rewards.credit_applied',
  'saas.rewards.alert_resolved'));

-- ---------- guards ----------
CREATE FUNCTION hon.guard_saas_refunds_rewards() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE before_row jsonb; after_row jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE = '42501'; END IF;
  before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'saas_refund_requests' THEN
    IF NEW.version = OLD.version + 1
      AND (after_row - ARRAY['status','status_reason','version','approved_amount_minor','decided_by_principal_id','decided_at','note'])
        = (before_row - ARRAY['status','status_reason','version','approved_amount_minor','decided_by_principal_id','decided_at','note'])
      AND ((OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED','DENIED'))
        OR (OLD.status = 'APPROVED' AND NEW.status = 'REFUND_EVIDENCED' AND NEW.approved_amount_minor = OLD.approved_amount_minor
          AND NEW.decided_at = OLD.decided_at AND NEW.decided_by_principal_id = OLD.decided_by_principal_id)) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'saas_reward_fulfillment' THEN
    IF NEW.version = OLD.version + 1 AND NEW.status <> OLD.status
      AND (after_row - ARRAY['status','version','authorization_reference','changed_by_principal_id','changed_at'])
        = (before_row - ARRAY['status','version','authorization_reference','changed_by_principal_id','changed_at']) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'saas_referral_payment_alerts' THEN
    IF OLD.status = 'OPEN' AND NEW.status = 'RESOLVED' AND NEW.version = OLD.version + 1
      AND (after_row - ARRAY['status','version','resolution','resolution_reference','resolved_by_principal_id','resolved_at'])
        = (before_row - ARRAY['status','version','resolution','resolution_reference','resolved_by_principal_id','resolved_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

-- A refund or chargeback against a school referred by a QUALIFIED attribution raises an alert.
CREATE FUNCTION hon.saas_evidence_referral_alert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF NEW.kind IN ('REFUND','CHARGEBACK') THEN
    INSERT INTO hon.saas_referral_payment_alerts(attribution_id, referred_organization_id, referrer_school_id, source, payment_evidence_id,
        evidence_kind, referred_recorded_net_minor, status, version, raised_at)
      SELECT a.id, a.referred_organization_id, a.referrer_school_id, 'PAYMENT_EVIDENCE', NEW.id, NEW.kind,
        (SELECT coalesce(sum(f.net_minor), 0) FROM hon.saas_invoice_facts(NEW.organization_id, NULL) f WHERE f.status = 'ISSUED'),
        'OPEN', 1, NEW.recorded_at
      FROM hon.champions_attributions a WHERE a.referred_organization_id = NEW.organization_id AND a.state = 'QUALIFIED'
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

-- A billing period covered by a Champions free month is never invoiced.
CREATE FUNCTION hon.saas_invoice_free_period_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF NEW.kind = 'SUBSCRIPTION_PERIOD' AND EXISTS (SELECT 1 FROM hon.saas_free_periods f
      WHERE f.subscription_id = NEW.subscription_id AND f.period_index = NEW.period_index) THEN
    RAISE EXCEPTION 'SAAS_PERIOD_FREE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- The B3 allowance of a free period is labelled; its credits stay the full plan allowance.
CREATE FUNCTION hon.saas_allowance_champions_basis() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hon.saas_free_periods f WHERE f.subscription_id = NEW.subscription_id AND f.period_index = NEW.period_index)
    AND (SELECT billing_interval FROM hon.saas_subscriptions WHERE id = NEW.subscription_id) = 'MONTHLY' THEN
    NEW.allowance_basis := 'CHAMPIONS_FREE_MONTH';
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_refund_history','saas_reward_applications','saas_account_credit_ledger','saas_free_periods'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['saas_refund_requests','saas_reward_fulfillment','saas_referral_payment_alerts'] LOOP
    EXECUTE format('CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_refunds_rewards()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_refunds_rewards()',t);
  END LOOP;
  CREATE TRIGGER saas_referral_alert AFTER INSERT ON hon.saas_payment_evidence FOR EACH ROW EXECUTE FUNCTION hon.saas_evidence_referral_alert();
  CREATE TRIGGER saas_free_period_check BEFORE INSERT ON hon.saas_invoices FOR EACH ROW EXECUTE FUNCTION hon.saas_invoice_free_period_check();
  CREATE TRIGGER saas_champions_basis BEFORE INSERT ON hon.saas_credit_allowances FOR EACH ROW EXECUTE FUNCTION hon.saas_allowance_champions_basis();
END $$;

-- ---------- private helpers ----------
-- First eligible HON plan purchase: the organization's issued invoice with the earliest recorded payment.
CREATE FUNCTION hon.saas_refund_eligibility(p_organization uuid, p_received_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE inv hon.saas_invoices%ROWTYPE; first_paid timestamptz; net bigint; reason text; verified bigint;
BEGIN
  SELECT i.* INTO inv FROM hon.saas_invoices i JOIN hon.saas_payment_evidence e ON e.invoice_id = i.id AND e.kind = 'PAYMENT_RECEIVED'
    WHERE i.organization_id = p_organization AND i.status = 'ISSUED' GROUP BY i.id ORDER BY min(e.occurred_at), i.id LIMIT 1;
  IF inv.id IS NOT NULL THEN
    SELECT min(e.occurred_at) INTO first_paid FROM hon.saas_payment_evidence e WHERE e.invoice_id = inv.id AND e.kind = 'PAYMENT_RECEIVED';
    SELECT f.net_minor, f.verified_net_minor INTO net, verified FROM hon.saas_invoice_facts(NULL, inv.id) f;
  END IF;
  reason := CASE WHEN inv.id IS NULL THEN 'SAAS_REFUND_NO_PAID_PURCHASE'
    WHEN EXISTS (SELECT 1 FROM hon.saas_refund_requests r WHERE r.organization_id = p_organization AND r.status IN ('APPROVED','REFUND_EVIDENCED')) THEN 'SAAS_REFUND_ALREADY_GRANTED'
    WHEN EXISTS (SELECT 1 FROM hon.saas_refund_requests r WHERE r.organization_id = p_organization AND r.status = 'REQUESTED') THEN 'SAAS_REFUND_REQUEST_OPEN'
    WHEN p_received_at < first_paid THEN 'SAAS_REFUND_BEFORE_PAYMENT'
    WHEN p_received_at >= first_paid + interval '30 days' THEN 'SAAS_REFUND_WINDOW_EXPIRED'
    WHEN coalesce(net, 0) <= 0 THEN 'SAAS_REFUND_NOTHING_TO_REFUND' END;
  RETURN jsonb_build_object('organizationId', p_organization, 'eligible', reason IS NULL, 'refusal', reason,
    'invoiceId', inv.id, 'invoiceNumber', inv.invoice_number, 'subscriptionId', inv.subscription_id, 'offerKind', inv.offer_kind,
    'firstPaidAt', hon.saas_ts(first_paid), 'windowEndsAt', hon.saas_ts(first_paid + interval '30 days'),
    'requestReceivedAt', hon.saas_ts(p_received_at), 'refundableMinor', CASE WHEN inv.id IS NULL THEN 0 ELSE greatest(coalesce(net, 0), 0) END,
    'evidenceStrength', CASE WHEN inv.id IS NULL THEN NULL WHEN coalesce(verified, 0) >= coalesce(net, 0) AND coalesce(net, 0) > 0 THEN 'PROVIDER_VERIFIED' ELSE 'HQ_ATTESTED' END,
    'execution', 'UNAVAILABLE');
END $$;

CREATE FUNCTION hon.saas_refund_json(r hon.saas_refund_requests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('refundRequestId',r.id,'organizationId',r.organization_id,
    'organizationName',(SELECT o.display_name FROM hon.organizations o WHERE o.id = r.organization_id),
    'subscriptionId',r.subscription_id,'invoiceId',r.invoice_id,
    'invoiceNumber',(SELECT i.invoice_number FROM hon.saas_invoices i WHERE i.id = r.invoice_id),'offerKind',r.offer_kind,
    'firstPaidAt',hon.saas_ts(r.first_paid_at),'windowEndsAt',hon.saas_ts(r.window_ends_at),'requestReceivedAt',hon.saas_ts(r.request_received_at),
    'customerReference',r.customer_reference,'requestedAmountMinor',r.requested_amount_minor,'approvedAmountMinor',r.approved_amount_minor,
    'evidenceStrength',r.evidence_strength,'status',r.status,'statusReason',r.status_reason,'version',r.version,'note',r.note,
    'execution','UNAVAILABLE','executionStatus',r.execution_status,'subscriptionConsequence',r.subscription_consequence,
    'refundEvidencedMinor',(SELECT f.refunded_minor FROM hon.saas_invoice_facts(NULL, r.invoice_id) f),
    'createdAt',hon.saas_ts(r.created_at),'decidedAt',hon.saas_ts(r.decided_at))
$$;

CREATE FUNCTION hon.saas_reward_fulfillment_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('status',p.status,'version',p.version,'authorizationReference',p.authorization_reference,
    'changedAt',hon.saas_ts(p.changed_at),'prizes','NOT_ISSUED','cashPayouts','DISABLED')
  FROM hon.saas_reward_fulfillment p WHERE p.program_id = 1
$$;

-- A reward is blocked while any open referral payment alert concerns it: its own attribution for a
-- welcome credit, or any of the referrer school's attributions for ladder rewards.
CREATE FUNCTION hon.saas_reward_entry_blocked(p_entry uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.champions_reward_entries e JOIN hon.saas_referral_payment_alerts al ON al.status = 'OPEN'
    AND (CASE WHEN e.reward_kind = 'WELCOME_CREDIT' THEN al.attribution_id = e.attribution_id ELSE al.referrer_school_id = e.referrer_school_id END)
    WHERE e.id = p_entry)
$$;

-- Account credit that may still be applied: remaining grants whose reward entry is APPROVED and
-- not blocked by an open referral payment alert. Credit applied to an invoice later voided is restored.
CREATE FUNCTION hon.saas_account_credit_grants(p_organization uuid)
RETURNS TABLE (grant_id uuid, granted_minor integer, applied_minor bigint, remaining_minor bigint, usable boolean, granted_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT g.id, g.amount_minor, coalesce((SELECT sum(x.amount_minor) FROM hon.saas_account_credit_ledger x
      JOIN hon.saas_invoices iv ON iv.id = x.invoice_id AND iv.status <> 'VOID' WHERE x.grant_id = g.id), 0),
    g.amount_minor - coalesce((SELECT sum(x.amount_minor) FROM hon.saas_account_credit_ledger x
      JOIN hon.saas_invoices iv ON iv.id = x.invoice_id AND iv.status <> 'VOID' WHERE x.grant_id = g.id), 0),
    e.status = 'APPROVED' AND NOT hon.saas_reward_entry_blocked(e.id), g.occurred_at
  FROM hon.saas_account_credit_ledger g JOIN hon.saas_reward_applications a ON a.id = g.application_id
  JOIN hon.champions_reward_entries e ON e.id = a.reward_entry_id
  WHERE g.organization_id = p_organization AND g.entry_kind = 'GRANT'
$$;

CREATE FUNCTION hon.saas_reward_application_json(a hon.saas_reward_applications) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('applicationId',a.id,'rewardEntryId',a.reward_entry_id,'organizationId',a.organization_id,'subscriptionId',a.subscription_id,
    'applicationKind',a.application_kind,'creditMinor',a.credit_minor,'freeMonths',a.free_months,'firstPeriodIndex',a.first_period_index,
    'lifetimeTier',a.lifetime_tier::text,'status',a.status,'appliedAt',hon.saas_ts(a.applied_at))
$$;

CREATE FUNCTION hon.saas_alert_json(al hon.saas_referral_payment_alerts) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('alertId',al.id,'attributionId',al.attribution_id,'attributionState',(SELECT a.state FROM hon.champions_attributions a WHERE a.id = al.attribution_id),
    'referredOrganizationId',al.referred_organization_id,
    'referredOrganizationName',(SELECT o.display_name FROM hon.organizations o WHERE o.id = al.referred_organization_id),
    'referrerSchoolId',al.referrer_school_id,'source',al.source,'paymentEvidenceId',al.payment_evidence_id,'refundRequestId',al.refund_request_id,
    'evidenceKind',al.evidence_kind,'referredRecordedNetMinor',al.referred_recorded_net_minor,'status',al.status,'resolution',al.resolution,
    'resolutionReference',al.resolution_reference,'version',al.version,'raisedAt',hon.saas_ts(al.raised_at),'resolvedAt',hon.saas_ts(al.resolved_at),
    'affectedApplications',(SELECT coalesce(jsonb_agg(x.id ORDER BY x.applied_at, x.id), '[]'::jsonb) FROM hon.saas_reward_applications x
      JOIN hon.champions_reward_entries e ON e.id = x.reward_entry_id
      WHERE (e.reward_kind = 'WELCOME_CREDIT' AND e.attribution_id = al.attribution_id)
        OR (e.reward_kind <> 'WELCOME_CREDIT' AND e.referrer_school_id = al.referrer_school_id)),
    'automaticReversal','NONE','debtCreated',false)
$$;

-- Reward state for the HQ preview: what each Champions entry would become and what blocks it.
CREATE FUNCTION hon.saas_reward_entry_state(e hon.champions_reward_entries) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE s hon.saas_subscriptions%ROWTYPE; app hon.saas_reward_applications%ROWTYPE; blocker text; kind text;
BEGIN
  SELECT * INTO app FROM hon.saas_reward_applications WHERE reward_entry_id = e.id;
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = e.beneficiary_organization_id AND status <> 'VOIDED';
  kind := CASE e.reward_kind WHEN 'REFERRER_CREDIT' THEN 'ACCOUNT_CREDIT' WHEN 'WELCOME_CREDIT' THEN 'ACCOUNT_CREDIT'
    WHEN 'FREE_MONTHS' THEN 'FREE_PERIODS' WHEN 'LIFETIME_MEMBERSHIP' THEN 'LIFETIME_CONVERSION' ELSE 'PRIZE_MANUAL' END;
  blocker := CASE WHEN app.id IS NOT NULL THEN NULL
    WHEN e.status = 'VOIDED' THEN 'SAAS_REWARD_VOIDED'
    WHEN e.status = 'REVERSAL_REVIEW' THEN 'SAAS_REWARD_UNDER_REVIEW'
    WHEN e.status <> 'APPROVED' THEN 'SAAS_REWARD_NOT_APPROVED'
    WHEN e.reward_kind = 'PRIZE' THEN 'SAAS_REWARD_PRIZE_MANUAL'
    WHEN e.fulfillment_form = 'OWNER_SUBSTITUTE' THEN 'SAAS_REWARD_SUBSTITUTE_MANUAL'
    WHEN hon.saas_reward_entry_blocked(e.id) THEN 'SAAS_REWARD_PAYMENT_ALERT_OPEN'
    WHEN s.id IS NULL THEN 'SAAS_REWARD_NO_SUBSCRIPTION'
    WHEN kind = 'FREE_PERIODS' AND (s.billing_interval <> 'MONTHLY' OR s.service_started_at IS NULL) THEN 'SAAS_REWARD_NOT_APPLICABLE'
    WHEN (kind = 'ACCOUNT_CREDIT' AND coalesce(e.credit_minor, 0) = 0) OR (kind = 'FREE_PERIODS' AND coalesce(e.free_months, 0) = 0) THEN 'SAAS_REWARD_NOTHING_TO_APPLY'
    WHEN NOT (SELECT status = 'ACTIVE' FROM hon.saas_reward_fulfillment WHERE program_id = 1) THEN 'SAAS_REWARDS_NOT_ACTIVE' END;
  RETURN jsonb_build_object('rewardEntryId',e.id,'rewardKind',e.reward_kind,'beneficiaryRole',e.beneficiary_role,
    'beneficiaryOrganizationId',e.beneficiary_organization_id,'milestoneCount',e.milestone_count,'creditMinor',e.credit_minor,
    'freeMonths',e.free_months,'lifetimeTier',e.lifetime_tier::text,'aiAllowance',e.ai_allowance,'entryStatus',e.status,'entryVersion',e.version,
    'fulfillmentForm',e.fulfillment_form,'applicationKind',kind,'subscriptionId',s.id,
    'state',CASE WHEN app.id IS NOT NULL THEN CASE app.status WHEN 'APPLIED' THEN 'APPLIED' ELSE 'APPLIED_CONVERSION_BLOCKED' END
      WHEN e.status = 'VOIDED' THEN 'VOIDED' WHEN e.status = 'REVERSAL_REVIEW' OR blocker = 'SAAS_REWARD_PAYMENT_ALERT_OPEN' THEN 'BLOCKED_REVIEW'
      WHEN blocker IS NULL THEN 'READY' ELSE 'PENDING' END,
    'blocker',blocker,'application',CASE WHEN app.id IS NULL THEN NULL ELSE hon.saas_reward_application_json(app) END,
    'fulfilledNotice','PREVIEW_IS_NOT_FULFILLMENT');
END $$;

-- ---------- refund reads and commands ----------
CREATE FUNCTION hon.read_saas_refund_eligibility_from_hq(p_subject text, p_organization uuid, p_received_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_organization IS NULL OR p_received_at IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = p_organization) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.saas_refund_eligibility(p_organization, least(p_received_at, clock_timestamp()));
END $$;

CREATE FUNCTION hon.read_saas_refund_requests_from_hq(p_subject text, p_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE rows jsonb;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('REQUESTED','APPROVED','DENIED','REFUND_EVIDENCED') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT coalesce(jsonb_agg(hon.saas_refund_json(r) ORDER BY r.created_at DESC, r.id), '[]'::jsonb) INTO rows
    FROM (SELECT * FROM hon.saas_refund_requests WHERE p_status IS NULL OR status = p_status ORDER BY created_at DESC, id LIMIT 200) r;
  RETURN jsonb_build_object('refundRequests', rows, 'limit', 200, 'execution', 'UNAVAILABLE');
END $$;

-- Refund reserve: recorded first-purchase receipts still inside their 30-day window, plus approved
-- refunds not yet evidenced. Recorded amounts are HQ-attested until a provider exists.
CREATE FUNCTION hon.read_saas_refund_reserve_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE at timestamptz := clock_timestamp(); exposure jsonb; approved jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  WITH first_purchase AS (
    SELECT DISTINCT ON (i.organization_id) i.organization_id, i.id invoice_id, i.offer_kind, min(e.occurred_at) OVER (PARTITION BY i.id) first_paid
    FROM hon.saas_invoices i JOIN hon.saas_payment_evidence e ON e.invoice_id = i.id AND e.kind = 'PAYMENT_RECEIVED'
    WHERE i.status = 'ISSUED' ORDER BY i.organization_id, min(e.occurred_at) OVER (PARTITION BY i.id), i.id),
  open_window AS (
    SELECT fp.*, f.net_minor FROM first_purchase fp CROSS JOIN LATERAL hon.saas_invoice_facts(NULL, fp.invoice_id) f
    WHERE at < fp.first_paid + interval '30 days' AND f.net_minor > 0
      AND NOT EXISTS (SELECT 1 FROM hon.saas_refund_requests r WHERE r.organization_id = fp.organization_id AND r.status <> 'DENIED'))
  SELECT jsonb_build_object('organizations', count(*), 'totalMinor', coalesce(sum(net_minor), 0),
      'paidLifetimeMinor', coalesce(sum(net_minor) FILTER (WHERE offer_kind = 'FOUNDER_LIFETIME'), 0),
      'monthlyMinor', coalesce(sum(net_minor) FILTER (WHERE offer_kind <> 'FOUNDER_LIFETIME'), 0),
      'earliestWindowEndsAt', hon.saas_ts(min(first_paid) + interval '30 days'))
    INTO exposure FROM open_window;
  SELECT jsonb_build_object('requests', count(*), 'totalMinor', coalesce(sum(approved_amount_minor), 0)) INTO approved
    FROM hon.saas_refund_requests WHERE status = 'APPROVED';
  RETURN jsonb_build_object('asOf', hon.saas_ts(at), 'windowExposure', exposure, 'approvedNotEvidenced', approved,
    'pendingRequests', (SELECT jsonb_build_object('requests', count(*), 'totalMinor', coalesce(sum(requested_amount_minor), 0)) FROM hon.saas_refund_requests WHERE status = 'REQUESTED'),
    'recommendedReserveMinor', (exposure->>'totalMinor')::bigint + (approved->>'totalMinor')::bigint
      + (SELECT coalesce(sum(requested_amount_minor), 0) FROM hon.saas_refund_requests WHERE status = 'REQUESTED'),
    'evidenceStrength', 'RECORDED', 'currency', 'USD', 'execution', 'UNAVAILABLE');
END $$;

-- Owner or operator records a customer's refund request (intake). Eligibility is computed, never asserted.
CREATE FUNCTION hon.create_saas_refund_request(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; v_org uuid; v_received timestamptz; elig jsonb; created hon.saas_refund_requests%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['customerReference','note','organizationId','requestReceivedAt']
    OR coalesce(jsonb_typeof(p->'organizationId'), '') <> 'string'
    OR coalesce(jsonb_typeof(p->'requestReceivedAt'), '') <> 'string' OR (p->>'requestReceivedAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR coalesce(jsonb_typeof(p->'customerReference'), '') <> 'string' OR length(p->>'customerReference') NOT BETWEEN 1 AND 200
    OR btrim(p->>'customerReference') <> p->>'customerReference'
    OR coalesce(jsonb_typeof(p->'note'), '') NOT IN ('string','null') OR (jsonb_typeof(p->'note') = 'string' AND length(p->>'note') NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_org := (p->>'organizationId')::uuid; v_received := (p->>'requestReceivedAt')::timestamptz;
  actor := hon.require_saas_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, false);
  replay := hon.saas_claim_request(actor, p_key, 'saas.refund.request', hon.saas_fingerprint(ARRAY['saas.refund.request', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.refund:' || v_org::text, 0));
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = v_org) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  at := clock_timestamp();
  IF v_received > at THEN RAISE EXCEPTION 'SAAS_EVIDENCE_IN_FUTURE' USING ERRCODE = '23514'; END IF;
  elig := hon.saas_refund_eligibility(v_org, v_received);
  IF NOT (elig->>'eligible')::boolean THEN RAISE EXCEPTION '%', elig->>'refusal' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.saas_refund_requests(organization_id, subscription_id, invoice_id, offer_kind, first_paid_at, window_ends_at, request_received_at,
      customer_reference, requested_amount_minor, evidence_strength, status, status_reason, version, note, requested_by_principal_id, created_at)
    VALUES (v_org, (elig->>'subscriptionId')::uuid, (elig->>'invoiceId')::uuid, elig->>'offerKind', (elig->>'firstPaidAt')::timestamptz,
      (elig->>'firstPaidAt')::timestamptz + interval '30 days', v_received, p->>'customerReference', (elig->>'refundableMinor')::integer,
      elig->>'evidenceStrength', 'REQUESTED', 'REQUESTED', 1, p->>'note', actor, at)
    RETURNING * INTO created;
  INSERT INTO hon.saas_refund_history(refund_request_id, version, status, status_reason, amount_minor, actor_principal_id, occurred_at)
    VALUES (created.id, 1, created.status, created.status_reason, created.requested_amount_minor, actor, at);
  snapshot := hon.saas_refund_json(created);
  RETURN hon.saas_record(actor, p_key, 'saas.refund.request', 'saas.refund.requested', 'REFUND_REQUEST', created.id, v_org, NULL, snapshot,
    jsonb_build_object('refundRequest', snapshot), at);
END $$;

-- HQ owner only. APPROVE (guarantee applies), DENY (with reason), or MARK_EVIDENCED once B2 refund
-- evidence on the purchase covers the approved amount. Nothing is executed or cancelled here.
CREATE FUNCTION hon.decide_saas_refund_request(p_subject text, p_refund uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_refund_requests%ROWTYPE; updated hon.saas_refund_requests%ROWTYPE; keys text[]; action text;
  facts record; at timestamptz; snapshot jsonb;
BEGIN
  IF p_refund IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k); action := p->>'decision';
  IF NOT coalesce(keys = ARRAY['decision','expectedVersion','note','reasonCode'] AND jsonb_typeof(p->'expectedVersion') = 'number'
      AND (p->>'expectedVersion') ~ '^[1-9][0-9]{0,8}$' AND jsonb_typeof(p->'note') IN ('string','null')
      AND (jsonb_typeof(p->'note') = 'null' OR length(p->>'note') BETWEEN 1 AND 500)
      AND CASE action WHEN 'APPROVE' THEN p->>'reasonCode' = 'GUARANTEE_APPROVED'
        WHEN 'DENY' THEN p->>'reasonCode' IN ('OWNER_DECLINED_TERMS','FRAUD_SUSPECTED','DUPLICATE_REQUEST')
        WHEN 'MARK_EVIDENCED' THEN p->>'reasonCode' = 'REFUND_EVIDENCE_RECORDED' ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.refund.decide', hon.saas_fingerprint(ARRAY['saas.refund.decide', p_refund::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO prior FROM hon.saas_refund_requests WHERE id = p_refund;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.refund:' || prior.organization_id::text, 0));
  SELECT * INTO prior FROM hon.saas_refund_requests WHERE id = p_refund FOR UPDATE;
  IF prior.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF NOT ((action IN ('APPROVE','DENY') AND prior.status = 'REQUESTED') OR (action = 'MARK_EVIDENCED' AND prior.status = 'APPROVED')) THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001';
  END IF;
  at := clock_timestamp();
  SELECT * INTO facts FROM hon.saas_invoice_facts(NULL, prior.invoice_id);
  IF action = 'APPROVE' THEN
    -- 100% of what is still recorded as paid on the first purchase (a chargeback may have reduced it).
    IF facts.net_minor <= 0 THEN RAISE EXCEPTION 'SAAS_REFUND_NOTHING_TO_REFUND' USING ERRCODE = '23514'; END IF;
    UPDATE hon.saas_refund_requests SET status = 'APPROVED', status_reason = 'GUARANTEE_APPROVED', approved_amount_minor = facts.net_minor::integer,
        version = version + 1, decided_by_principal_id = actor, decided_at = at, note = coalesce(p->>'note', note) WHERE id = p_refund RETURNING * INTO updated;
    -- A refunded referred school is re-reviewed for Champions qualification.
    INSERT INTO hon.saas_referral_payment_alerts(attribution_id, referred_organization_id, referrer_school_id, source, refund_request_id, evidence_kind,
        referred_recorded_net_minor, status, version, raised_at)
      SELECT a.id, a.referred_organization_id, a.referrer_school_id, 'REFUND_REQUEST', p_refund, 'REFUND_APPROVED', facts.net_minor, 'OPEN', 1, at
      FROM hon.champions_attributions a WHERE a.referred_organization_id = prior.organization_id AND a.state = 'QUALIFIED' ON CONFLICT DO NOTHING;
  ELSIF action = 'DENY' THEN
    UPDATE hon.saas_refund_requests SET status = 'DENIED', status_reason = p->>'reasonCode', version = version + 1,
        decided_by_principal_id = actor, decided_at = at, note = coalesce(p->>'note', note) WHERE id = p_refund RETURNING * INTO updated;
  ELSE
    IF facts.refunded_minor < prior.approved_amount_minor THEN RAISE EXCEPTION 'SAAS_REFUND_EVIDENCE_INCOMPLETE' USING ERRCODE = '23514'; END IF;
    UPDATE hon.saas_refund_requests SET status = 'REFUND_EVIDENCED', status_reason = 'REFUND_EVIDENCE_RECORDED', version = version + 1,
        note = coalesce(p->>'note', note) WHERE id = p_refund RETURNING * INTO updated;
  END IF;
  INSERT INTO hon.saas_refund_history(refund_request_id, version, status, status_reason, amount_minor, actor_principal_id, occurred_at)
    VALUES (updated.id, updated.version, updated.status, updated.status_reason, coalesce(updated.approved_amount_minor, updated.requested_amount_minor), actor, at);
  snapshot := hon.saas_refund_json(updated);
  RETURN hon.saas_record(actor, p_key, 'saas.refund.decide', 'saas.refund.decided', 'REFUND_REQUEST', updated.id, updated.organization_id,
    jsonb_build_object('status', prior.status, 'version', prior.version), snapshot || jsonb_build_object('decision', action),
    jsonb_build_object('refundRequest', snapshot, 'decision', action), at);
END $$;

-- ---------- reward reads and commands ----------
CREATE FUNCTION hon.read_saas_reward_preview_from_hq(p_subject text, p_organization uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE entries jsonb; grants jsonb; free jsonb; alerts jsonb;
BEGIN
  IF p_organization IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = p_organization) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(jsonb_agg(hon.saas_reward_entry_state(e) ORDER BY e.accrued_at, e.milestone_count NULLS LAST, e.id), '[]'::jsonb) INTO entries
    FROM hon.champions_reward_entries e WHERE e.beneficiary_organization_id = p_organization;
  SELECT jsonb_build_object('grantedMinor', coalesce(sum(granted_minor), 0), 'appliedMinor', coalesce(sum(applied_minor), 0),
      'availableMinor', coalesce(sum(remaining_minor) FILTER (WHERE usable), 0), 'blockedMinor', coalesce(sum(remaining_minor) FILTER (WHERE NOT usable), 0))
    INTO grants FROM hon.saas_account_credit_grants(p_organization);
  SELECT coalesce(jsonb_agg(jsonb_build_object('subscriptionId', f.subscription_id, 'periodIndex', f.period_index, 'applicationId', f.application_id)
      ORDER BY f.period_index), '[]'::jsonb) INTO free
    FROM hon.saas_free_periods f JOIN hon.saas_subscriptions s ON s.id = f.subscription_id WHERE s.organization_id = p_organization;
  SELECT coalesce(jsonb_agg(hon.saas_alert_json(al) ORDER BY al.raised_at DESC, al.id), '[]'::jsonb) INTO alerts
    FROM hon.saas_referral_payment_alerts al JOIN hon.schools sc ON sc.id = al.referrer_school_id
    WHERE sc.organization_id = p_organization OR al.referred_organization_id = p_organization;
  RETURN jsonb_build_object('organizationId', p_organization, 'fulfillment', hon.saas_reward_fulfillment_json(), 'rewards', entries,
    'accountCredit', grants, 'freePeriods', free, 'alerts', alerts, 'currency', 'USD');
END $$;

CREATE FUNCTION hon.read_saas_referral_alerts_from_hq(p_subject text, p_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE rows jsonb;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('OPEN','RESOLVED') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT coalesce(jsonb_agg(hon.saas_alert_json(al) ORDER BY al.raised_at DESC, al.id), '[]'::jsonb) INTO rows
    FROM (SELECT * FROM hon.saas_referral_payment_alerts WHERE p_status IS NULL OR status = p_status ORDER BY raised_at DESC, id LIMIT 200) al;
  RETURN jsonb_build_object('alerts', rows, 'limit', 200);
END $$;

CREATE FUNCTION hon.set_saas_reward_fulfillment(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_reward_fulfillment%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['action','authorizationReference','expectedVersion']
    OR coalesce(p->>'action', '') NOT IN ('ACTIVATE','DEACTIVATE') OR coalesce(jsonb_typeof(p->'expectedVersion'), '') <> 'number'
    OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' OR coalesce(jsonb_typeof(p->'authorizationReference'), '') <> 'string'
    OR length(p->>'authorizationReference') NOT BETWEEN 1 AND 200 OR btrim(p->>'authorizationReference') <> p->>'authorizationReference' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.rewards.fulfillment', hon.saas_fingerprint(ARRAY['saas.rewards.fulfillment', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO prior FROM hon.saas_reward_fulfillment WHERE program_id = 1 FOR UPDATE;
  IF prior.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF (p->>'action' = 'ACTIVATE') = (prior.status = 'ACTIVE') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  UPDATE hon.saas_reward_fulfillment SET status = CASE WHEN p->>'action' = 'ACTIVATE' THEN 'ACTIVE' ELSE 'INACTIVE' END, version = version + 1,
      authorization_reference = p->>'authorizationReference', changed_by_principal_id = actor, changed_at = at WHERE program_id = 1;
  snapshot := hon.saas_reward_fulfillment_json();
  RETURN hon.saas_record(actor, p_key, 'saas.rewards.fulfillment', 'saas.rewards.fulfillment_changed', 'REWARD_FULFILLMENT',
    '00000000-0000-4000-8000-000000000002'::uuid, NULL, jsonb_build_object('status', prior.status, 'version', prior.version), snapshot,
    jsonb_build_object('fulfillment', snapshot), at);
END $$;

-- HQ owner only, while fulfillment is ACTIVE. Applies one APPROVED, unblocked Champions entry to the
-- beneficiary's HON subscription: account credit, free billing periods, or a blocked lifetime conversion.
CREATE FUNCTION hon.apply_saas_champions_reward(p_subject text, p_entry uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; e hon.champions_reward_entries%ROWTYPE; s hon.saas_subscriptions%ROWTYPE; st jsonb; app hon.saas_reward_applications%ROWTYPE;
  v_start integer; i integer; at timestamptz; snapshot jsonb;
BEGIN
  IF p_entry IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedEntryVersion','firstPeriodIndex']
    OR coalesce(jsonb_typeof(p->'expectedEntryVersion'), '') <> 'number' OR (p->>'expectedEntryVersion') !~ '^[1-9][0-9]{0,8}$'
    OR coalesce(jsonb_typeof(p->'firstPeriodIndex'), '') NOT IN ('number','null')
    OR (jsonb_typeof(p->'firstPeriodIndex') = 'number' AND (p->>'firstPeriodIndex') !~ '^[0-9]{1,4}$') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.rewards.apply', hon.saas_fingerprint(ARRAY['saas.rewards.apply', p_entry::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  -- The Champions entry is locked so a concurrent review or void cannot interleave with its application.
  SELECT * INTO e FROM hon.champions_reward_entries WHERE id = p_entry FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.rewards:' || e.beneficiary_organization_id::text, 0));
  IF e.version <> (p->>'expectedEntryVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_reward_applications WHERE reward_entry_id = e.id) THEN RAISE EXCEPTION 'SAAS_REWARD_ALREADY_APPLIED' USING ERRCODE = '23514'; END IF;
  st := hon.saas_reward_entry_state(e);
  IF st->>'blocker' IS NOT NULL THEN RAISE EXCEPTION '%', st->>'blocker' USING ERRCODE = '23514'; END IF;
  SELECT * INTO s FROM hon.saas_subscriptions WHERE id = (st->>'subscriptionId')::uuid FOR UPDATE;
  at := clock_timestamp();
  IF st->>'applicationKind' = 'ACCOUNT_CREDIT' THEN
    IF jsonb_typeof(p->'firstPeriodIndex') <> 'null' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
    INSERT INTO hon.saas_reward_applications(reward_entry_id, organization_id, subscription_id, application_kind, credit_minor, status, applied_by_principal_id, applied_at)
      VALUES (e.id, e.beneficiary_organization_id, s.id, 'ACCOUNT_CREDIT', e.credit_minor, 'APPLIED', actor, at) RETURNING * INTO app;
    INSERT INTO hon.saas_account_credit_ledger(organization_id, entry_kind, amount_minor, application_id, actor_principal_id, occurred_at)
      VALUES (e.beneficiary_organization_id, 'GRANT', e.credit_minor, app.id, actor, at);
  ELSIF st->>'applicationKind' = 'FREE_PERIODS' THEN
    IF jsonb_typeof(p->'firstPeriodIndex') <> 'number' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
    v_start := (p->>'firstPeriodIndex')::integer;
    IF v_start < s.period_index THEN RAISE EXCEPTION 'SAAS_REWARD_PERIOD_IN_PAST' USING ERRCODE = '23514'; END IF;
    FOR i IN v_start .. v_start + e.free_months - 1 LOOP
      IF EXISTS (SELECT 1 FROM hon.saas_invoices iv WHERE iv.subscription_id = s.id AND iv.kind = 'SUBSCRIPTION_PERIOD' AND iv.period_index = i AND iv.status <> 'VOID')
        OR EXISTS (SELECT 1 FROM hon.saas_free_periods f WHERE f.subscription_id = s.id AND f.period_index = i) THEN
        RAISE EXCEPTION 'SAAS_REWARD_PERIOD_TAKEN' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    INSERT INTO hon.saas_reward_applications(reward_entry_id, organization_id, subscription_id, application_kind, free_months, first_period_index,
        status, applied_by_principal_id, applied_at)
      VALUES (e.id, e.beneficiary_organization_id, s.id, 'FREE_PERIODS', e.free_months, v_start, 'APPLIED', actor, at) RETURNING * INTO app;
    INSERT INTO hon.saas_free_periods(subscription_id, period_index, application_id, recorded_at)
      SELECT s.id, g, app.id, at FROM generate_series(v_start, v_start + e.free_months - 1) g;
  ELSE
    -- Converting the subscription to lifetime is a plan change: recorded and blocked until terms exist.
    IF jsonb_typeof(p->'firstPeriodIndex') <> 'null' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
    INSERT INTO hon.saas_reward_applications(reward_entry_id, organization_id, subscription_id, application_kind, lifetime_tier, status, applied_by_principal_id, applied_at)
      VALUES (e.id, e.beneficiary_organization_id, s.id, 'LIFETIME_CONVERSION', coalesce(e.lifetime_tier, s.entitlement_tier), 'CONVERSION_BLOCKED', actor, at)
      RETURNING * INTO app;
  END IF;
  snapshot := hon.saas_reward_application_json(app);
  RETURN hon.saas_record(actor, p_key, 'saas.rewards.apply', 'saas.rewards.applied', 'REWARD_APPLICATION', app.id, e.beneficiary_organization_id,
    NULL, snapshot, jsonb_build_object('application', snapshot, 'reward', hon.saas_reward_entry_state(e)), at);
END $$;

-- Preview (read) and application (owner command) of usable account credit onto a draft invoice. The
-- credit never exceeds the invoice subtotal; a zero-total invoice stays unissuable (ZERO_DOLLAR_INVOICE).
CREATE FUNCTION hon.read_saas_credit_application_preview(p_subject text, p_invoice uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE inv hon.saas_invoices%ROWTYPE; available bigint; apply bigint;
BEGIN
  IF p_invoice IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT * INTO inv FROM hon.saas_invoices WHERE id = p_invoice;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(sum(remaining_minor) FILTER (WHERE usable), 0) INTO available FROM hon.saas_account_credit_grants(inv.organization_id);
  apply := least(available, inv.subtotal_minor);
  RETURN jsonb_build_object('invoiceId', inv.id, 'invoiceStatus', inv.status, 'taxStatus', inv.tax_status, 'subtotalMinor', inv.subtotal_minor,
    'availableCreditMinor', available, 'wouldApplyMinor', CASE WHEN inv.status = 'DRAFT' AND inv.tax_status = 'UNRESOLVED' THEN apply ELSE 0 END,
    'resultingSubtotalMinor', inv.subtotal_minor - CASE WHEN inv.status = 'DRAFT' AND inv.tax_status = 'UNRESOLVED' THEN apply ELSE 0 END,
    'applicable', inv.status = 'DRAFT' AND inv.tax_status = 'UNRESOLVED' AND apply > 0,
    'zeroTotalIssuable', false, 'fulfillment', (SELECT status FROM hon.saas_reward_fulfillment WHERE program_id = 1), 'previewOnly', true);
END $$;

CREATE FUNCTION hon.apply_saas_account_credit(p_subject text, p_invoice uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; inv hon.saas_invoices%ROWTYPE; g record; remaining bigint; take bigint; total bigint := 0; next_line integer; at timestamptz; snapshot jsonb;
BEGIN
  IF p_invoice IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion']
    OR coalesce(jsonb_typeof(p->'expectedVersion'), '') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.rewards.credit_apply', hon.saas_fingerprint(ARRAY['saas.rewards.credit_apply', p_invoice::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT (SELECT status = 'ACTIVE' FROM hon.saas_reward_fulfillment WHERE program_id = 1) THEN RAISE EXCEPTION 'SAAS_REWARDS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  SELECT * INTO inv FROM hon.saas_invoices WHERE id = p_invoice;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.rewards:' || inv.organization_id::text, 0));
  SELECT * INTO inv FROM hon.saas_invoices WHERE id = p_invoice FOR UPDATE;
  IF inv.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF inv.status <> 'DRAFT' OR inv.tax_status <> 'UNRESOLVED' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  remaining := inv.subtotal_minor;
  at := clock_timestamp();
  FOR g IN SELECT * FROM hon.saas_account_credit_grants(inv.organization_id) WHERE usable AND remaining_minor > 0 ORDER BY granted_at, grant_id LOOP
    EXIT WHEN remaining <= 0;
    take := least(g.remaining_minor, remaining);
    INSERT INTO hon.saas_account_credit_ledger(organization_id, entry_kind, amount_minor, grant_id, invoice_id, actor_principal_id, occurred_at)
      VALUES (inv.organization_id, 'APPLY', take, g.grant_id, inv.id, actor, at);
    remaining := remaining - take; total := total + take;
  END LOOP;
  IF total = 0 THEN RAISE EXCEPTION 'SAAS_NO_ACCOUNT_CREDIT' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(max(line_number), 0) + 1 INTO next_line FROM hon.saas_invoice_lines WHERE invoice_id = inv.id;
  IF next_line > 20 THEN RAISE EXCEPTION 'SAAS_INVOICE_TOO_MANY_LINES' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.saas_invoice_lines(invoice_id, line_number, line_kind, description, amount_minor, reference, created_by_principal_id, created_at)
    VALUES (inv.id, next_line, 'ACCOUNT_CREDIT', 'HON Champions Club account credit', -total::integer, 'CHAMPIONS_ACCOUNT_CREDIT', actor, at);
  UPDATE hon.saas_invoices SET subtotal_minor = subtotal_minor - total, version = version + 1, updated_at = at WHERE id = inv.id;
  snapshot := hon.saas_invoice_json(inv.id, true);
  RETURN hon.saas_record(actor, p_key, 'saas.rewards.credit_apply', 'saas.rewards.credit_applied', 'INVOICE', inv.id, inv.organization_id,
    jsonb_build_object('subtotalMinor', inv.subtotal_minor, 'version', inv.version), snapshot || jsonb_build_object('appliedCreditMinor', total),
    jsonb_build_object('invoice', snapshot, 'appliedCreditMinor', total), at);
END $$;

-- HQ owner resolves a referral payment alert: ATTRIBUTION_DECIDED once the attribution is no longer
-- QUALIFIED (decided through Champions, which moves its liabilities to review), or NO_QUALIFICATION_IMPACT.
CREATE FUNCTION hon.resolve_saas_referral_alert(p_subject text, p_alert uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; al hon.saas_referral_payment_alerts%ROWTYPE; updated hon.saas_referral_payment_alerts%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p_alert IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion','reference','resolution']
    OR coalesce(jsonb_typeof(p->'expectedVersion'), '') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR coalesce(p->>'resolution', '') NOT IN ('ATTRIBUTION_DECIDED','NO_QUALIFICATION_IMPACT')
    OR coalesce(jsonb_typeof(p->'reference'), '') <> 'string' OR length(p->>'reference') NOT BETWEEN 1 AND 300 OR btrim(p->>'reference') <> p->>'reference' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.rewards.alert_resolve', hon.saas_fingerprint(ARRAY['saas.rewards.alert_resolve', p_alert::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO al FROM hon.saas_referral_payment_alerts WHERE id = p_alert FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF al.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF al.status <> 'OPEN' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF p->>'resolution' = 'ATTRIBUTION_DECIDED' AND (SELECT state FROM hon.champions_attributions WHERE id = al.attribution_id) = 'QUALIFIED' THEN
    RAISE EXCEPTION 'SAAS_ALERT_ATTRIBUTION_UNDECIDED' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  UPDATE hon.saas_referral_payment_alerts SET status = 'RESOLVED', resolution = p->>'resolution', resolution_reference = p->>'reference',
      version = version + 1, resolved_by_principal_id = actor, resolved_at = at WHERE id = p_alert RETURNING * INTO updated;
  snapshot := hon.saas_alert_json(updated);
  RETURN hon.saas_record(actor, p_key, 'saas.rewards.alert_resolve', 'saas.rewards.alert_resolved', 'REFERRAL_ALERT', updated.id, updated.referred_organization_id,
    jsonb_build_object('status', al.status, 'version', al.version), snapshot, jsonb_build_object('alert', snapshot), at);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_refund_requests','saas_refund_history','saas_reward_fulfillment','saas_reward_applications','saas_account_credit_ledger',
    'saas_free_periods','saas_referral_payment_alerts'] LOOP
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
      hon.apply_saas_champions_reward(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_credit_application_preview(text,uuid),
      hon.apply_saas_account_credit(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_referral_alert(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
