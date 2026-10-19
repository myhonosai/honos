BEGIN;

-- HON Subscription Billing Milestone B2: HON-to-school invoices and append-only payment evidence.
-- HON billing schools; entirely separate from school-to-family billing (billing_accounts,
-- memberships, invoices, membership_payment_schedules). Recordkeeping only:
-- - No payment collection, checkout, provider call, refund execution, credit grant or reward.
-- - Invoices are never delivered (delivery_status = 'NOT_SENT') and never collected
--   (collection_enabled = false), both pinned by constraint.
-- - Payment evidence is HQ attestation only (source = 'HQ_ATTESTATION' pinned); nothing can be
--   recorded as provider-verified until a provider milestone (B5) is separately approved.
-- - Tax is never assumed: each invoice starts UNRESOLVED and cannot be issued until the HQ owner
--   records its verified tax treatment with a verification reference.
-- Owner commercial direction (2026-10-18) is recorded as append-only policy records; every record
-- has actions_enabled = false, so no recorded decision unblocks an action by itself.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON invoices require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON invoices require a restricted runtime';
  END IF;
END $$;

-- ---------- owner decisions (append-only records over the B1 baseline) ----------
ALTER TABLE hon.saas_policy_decisions DROP CONSTRAINT saas_policy_decisions_policy_code_check;
ALTER TABLE hon.saas_policy_decisions ADD CONSTRAINT saas_policy_decisions_policy_code_check CHECK (policy_code IN ('ANNUAL_BILLING','TAXES',
  'PRORATION','PLAN_CHANGE_TIMING','CANCELLATION_TIMING','REFUND_EXECUTION','PAYMENT_PROVIDER','FOUNDER_SLOT_RETURN','CREDIT_ROLLOVER',
  'TOP_UP_PRICING','REFUND_GUARANTEE','FOUNDER_PROGRAM','FOUNDER_RESERVATION_HOLD','FOUNDER_ALLOWANCE'));
INSERT INTO hon.saas_policy_decisions(policy_code, status, blocks) VALUES
  ('REFUND_GUARANTEE','UNDECIDED','No refund guarantee is evaluated'),
  ('FOUNDER_PROGRAM','UNDECIDED','Founder offers publish only with owner-set inventory'),
  ('FOUNDER_RESERVATION_HOLD','UNDECIDED','Hold length is set per catalog'),
  ('FOUNDER_ALLOWANCE','UNDECIDED','Allowances are planned amounts only');

CREATE TABLE hon.saas_policy_records (
  policy_code text NOT NULL REFERENCES hon.saas_policy_decisions(policy_code) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 1),
  status text NOT NULL CHECK (status IN ('UNDECIDED','PROPOSED','DECIDED')),
  decision_code text CHECK (decision_code ~ '^[A-Z0-9_]{1,80}$'),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  blocks text NOT NULL CHECK (length(blocks) BETWEEN 1 AND 300),
  -- A recorded decision never enables an action on its own; a later reviewed migration must.
  actions_enabled boolean NOT NULL DEFAULT false CHECK (actions_enabled = false),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (policy_code, version),
  CHECK ((status = 'UNDECIDED') = (decision_code IS NULL))
);
INSERT INTO hon.saas_policy_records(policy_code, version, status, decision_code, summary, blocks, source_reference, recorded_at) VALUES
  ('CREDIT_ROLLOVER',2,'DECIDED','NO_ROLLOVER','Monthly premium credits do not roll over.',
    'Allowances are planned amounts until B3; nothing is granted.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('TOP_UP_PRICING',2,'DECIDED','TWICE_VERIFIED_PROVIDER_COST','Premium top-ups are priced at 2x the independently verified fully loaded provider cost, never a fixed assumed amount.',
    'No verified provider cost is recorded, so no top-up can be offered or sold.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('FOUNDER_SLOT_RETURN',2,'DECIDED','EXPIRED_UNPAID_RETURN_ACTIVATED_RETAINED','Expired or unpaid founder reservations return to inventory; activated founder subscriptions keep their slot on cancellation.',
    'Cancellation is unavailable; voiding a never-started record is the only path that releases an allocated slot.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('CANCELLATION_TIMING',2,'PROPOSED','END_OF_PAID_PERIOD','Proposed: recurring subscriptions cancel at the end of the paid period.',
    'Cancellation stays refused until final terms are authorized.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('PLAN_CHANGE_TIMING',2,'PROPOSED','BILLING_PERIOD_BOUNDARY','Proposed: plan changes take effect at billing-period boundaries.',
    'Plan changes stay refused until final terms are authorized.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('PRORATION',2,'PROPOSED','NO_AUTOMATIC_PRORATION','Proposed: no automatic proration; changes align to period boundaries.',
    'No proration is calculated.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('REFUND_GUARANTEE',2,'DECIDED','FIRST_PURCHASE_30_DAY_FULL_REFUND','The 30-day full refund guarantee on the first eligible HON plan purchase is approved commercial policy.',
    'Refund execution stays disabled; a refund can only be recorded as HQ-attested evidence.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('FOUNDER_PROGRAM',2,'DECIDED','FIFTY_TOTAL_THIRTY_MONTHLY_TWENTY_LIFETIME_ONE_PER_ORGANIZATION','50 founder organizations: 30 founder monthly and 20 original paid lifetime offers, one founder offer per eligible organization.',
    'Founder offers publish only when the owner sets eligibility, hold and window on a catalog.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('FOUNDER_RESERVATION_HOLD',2,'PROPOSED','ONE_DAY','Recommended initial founder reservation hold: 1 day.',
    'The hold length is set by the owner on each catalog draft.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('FOUNDER_ALLOWANCE',2,'DECIDED','FULL_MONTHLY_PLAN_ALLOWANCE','Founder and paid lifetime plans keep the full monthly premium credit allowance of their tier.',
    'Allowances are planned amounts until B3; nothing is granted.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('TAXES',2,'UNDECIDED',NULL,'Tax treatment is unresolved until verified.',
    'No tax is assumed: each invoice stays UNRESOLVED and cannot be issued until the HQ owner records its verified tax treatment.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('PAYMENT_PROVIDER',2,'UNDECIDED',NULL,'No payment provider is approved.',
    'No checkout, charge or provider verification exists; payments can only be HQ-attested evidence.','OWNER_DIRECTION_2026_10_18',clock_timestamp()),
  ('ANNUAL_BILLING',2,'UNDECIDED',NULL,'Annual plans stay unavailable until their commercial terms are approved.',
    'Annual regular and founder offers cannot be drafted.','OWNER_DIRECTION_2026_10_18',clock_timestamp());

-- Only a DECIDED record with actions_enabled (impossible today) unblocks an action.
CREATE OR REPLACE FUNCTION hon.saas_require_policy(p_code text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM (SELECT r.status, r.actions_enabled FROM hon.saas_policy_records r WHERE r.policy_code = p_code
      ORDER BY r.version DESC LIMIT 1) latest WHERE latest.status = 'DECIDED' AND latest.actions_enabled) THEN
    RAISE EXCEPTION 'SAAS_POLICY_UNDECIDED' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION hon.saas_policies_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_agg(jsonb_build_object('policyCode',d.policy_code,'status',coalesce(r.status,'UNDECIDED'),'decision',r.decision_code,
      'summary',r.summary,'blocks',coalesce(r.blocks,d.blocks),'actionsEnabled',false,'version',coalesce(r.version,1))
    ORDER BY d.policy_code COLLATE "C")
  FROM hon.saas_policy_decisions d
  LEFT JOIN LATERAL (SELECT * FROM hon.saas_policy_records x WHERE x.policy_code = d.policy_code ORDER BY x.version DESC LIMIT 1) r ON true
$$;

-- ---------- invoices ----------
CREATE TABLE hon.saas_invoice_sequences (
  invoice_year integer PRIMARY KEY CHECK (invoice_year BETWEEN 2020 AND 2999),
  last_number integer NOT NULL CHECK (last_number BETWEEN 0 AND 999999)
);

CREATE TABLE hon.saas_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Assigned only when issued: HON-<year>-<6-digit sequence>, gapless per UTC year.
  invoice_number text UNIQUE CHECK (invoice_number ~ '^HON-20[0-9]{2}-[0-9]{6}$'),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('SUBSCRIPTION_PERIOD','LIFETIME_PURCHASE')),
  period_index integer CHECK (period_index >= 0),
  service_period_start timestamptz NOT NULL,
  service_period_end timestamptz,
  plan_code text NOT NULL CHECK (plan_code IN ('CORE','COMPLETE')),
  offer_kind text NOT NULL CHECK (offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status text NOT NULL CHECK (status IN ('DRAFT','ISSUED','VOID')),
  version integer NOT NULL CHECK (version > 0),
  subtotal_minor integer NOT NULL CHECK (subtotal_minor BETWEEN 0 AND 100000000),
  tax_status text NOT NULL CHECK (tax_status IN ('UNRESOLVED','NO_TAX_APPLICABLE','TAX_LINES')),
  tax_minor integer CHECK (tax_minor BETWEEN 0 AND 100000000),
  tax_verification_reference text CHECK (length(tax_verification_reference) BETWEEN 1 AND 200),
  total_minor integer CHECK (total_minor BETWEEN 0 AND 200000000),
  delivery_status text NOT NULL DEFAULT 'NOT_SENT' CHECK (delivery_status = 'NOT_SENT'),
  collection_enabled boolean NOT NULL DEFAULT false CHECK (collection_enabled = false),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  issued_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  issued_at timestamptz,
  voided_at timestamptz,
  void_reason text CHECK (void_reason IN ('ISSUED_IN_ERROR','DUPLICATE','SUPERSEDED')),
  updated_at timestamptz NOT NULL,
  CHECK ((kind = 'SUBSCRIPTION_PERIOD') = (period_index IS NOT NULL AND service_period_end IS NOT NULL)),
  CHECK (service_period_end IS NULL OR service_period_end > service_period_start),
  CHECK ((kind = 'LIFETIME_PURCHASE') = (offer_kind = 'FOUNDER_LIFETIME')),
  -- Tax is either unresolved (no amount, no total) or recorded with a verification reference.
  CHECK (CASE tax_status WHEN 'UNRESOLVED' THEN tax_minor IS NULL AND total_minor IS NULL AND tax_verification_reference IS NULL
    WHEN 'NO_TAX_APPLICABLE' THEN tax_minor = 0 AND total_minor = subtotal_minor AND tax_verification_reference IS NOT NULL
    ELSE tax_minor > 0 AND total_minor = subtotal_minor + tax_minor AND tax_verification_reference IS NOT NULL END),
  CHECK ((invoice_number IS NOT NULL) = (issued_at IS NOT NULL) AND (issued_at IS NULL) = (issued_by_principal_id IS NULL)),
  CHECK (status <> 'ISSUED' OR (issued_at IS NOT NULL AND tax_status <> 'UNRESOLVED' AND total_minor > 0)),
  CHECK ((status = 'VOID') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE UNIQUE INDEX saas_invoice_one_live_per_period ON hon.saas_invoices (subscription_id, period_index)
  WHERE status <> 'VOID' AND kind = 'SUBSCRIPTION_PERIOD';
CREATE UNIQUE INDEX saas_invoice_one_live_lifetime ON hon.saas_invoices (subscription_id)
  WHERE status <> 'VOID' AND kind = 'LIFETIME_PURCHASE';

CREATE TABLE hon.saas_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES hon.saas_invoices(id) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 30),
  line_kind text NOT NULL CHECK (line_kind IN ('PLAN_FEE','DISCOUNT','CORRECTION','TAX')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN -100000000 AND 100000000 AND amount_minor <> 0),
  reference text CHECK (length(reference) BETWEEN 1 AND 200),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  UNIQUE (invoice_id, line_number),
  CHECK (CASE line_kind WHEN 'PLAN_FEE' THEN amount_minor > 0 WHEN 'DISCOUNT' THEN amount_minor < 0 WHEN 'TAX' THEN amount_minor > 0 ELSE true END)
);

-- ---------- payment evidence ----------
CREATE TABLE hon.saas_payment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES hon.saas_invoices(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('PAYMENT_RECEIVED','REFUND','CHARGEBACK')),
  -- HQ attestation is never processor confirmation. PROVIDER_VERIFIED needs a reviewed provider milestone.
  source text NOT NULL CHECK (source = 'HQ_ATTESTATION'),
  provider_event_id text CHECK (provider_event_id IS NULL),
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 200000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  occurred_at timestamptz NOT NULL,
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  related_evidence_id uuid REFERENCES hon.saas_payment_evidence(id) ON DELETE RESTRICT,
  note text CHECK (length(note) BETWEEN 1 AND 500),
  recorded_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL,
  CHECK ((kind = 'PAYMENT_RECEIVED') = (related_evidence_id IS NULL)),
  CHECK (occurred_at <= recorded_at),
  UNIQUE (invoice_id, kind, reference)
);

-- ---------- evidence and audit vocabularies ----------
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (action_code IN ('saas.catalog.draft','saas.catalog.publish',
  'saas.founder.reserve','saas.founder.release','saas.subscription.record','saas.subscription.command',
  'saas.invoice.draft','saas.invoice.command','saas.payment.evidence'));
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION',
  'INVOICE','PAYMENT_EVIDENCE'));
ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published',
  'saas.founder.reserved','saas.founder.released','saas.subscription.recorded','saas.subscription.changed',
  'saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded'));

-- ---------- guards ----------
CREATE FUNCTION hon.guard_saas_invoicing() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE before_row jsonb; after_row jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_INVOICE' USING ERRCODE = '42501'; END IF;
  before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'saas_invoice_sequences' THEN
    IF NEW.invoice_year = OLD.invoice_year AND NEW.last_number = OLD.last_number + 1 THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'saas_invoices' THEN
    IF NEW.version = OLD.version + 1 AND (
      -- Draft totals change only while tax is unresolved, or once when tax is recorded.
      (OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' AND OLD.tax_status = 'UNRESOLVED'
        AND (after_row - ARRAY['version','subtotal_minor','tax_status','tax_minor','tax_verification_reference','total_minor','updated_at'])
          = (before_row - ARRAY['version','subtotal_minor','tax_status','tax_minor','tax_verification_reference','total_minor','updated_at'])
        AND (NEW.tax_status = 'UNRESOLVED' OR NEW.subtotal_minor = OLD.subtotal_minor))
      OR (OLD.status = 'DRAFT' AND NEW.status = 'ISSUED'
        AND (after_row - ARRAY['version','status','invoice_number','issued_by_principal_id','issued_at','updated_at'])
          = (before_row - ARRAY['version','status','invoice_number','issued_by_principal_id','issued_at','updated_at']))
      OR (OLD.status IN ('DRAFT','ISSUED') AND NEW.status = 'VOID'
        AND (after_row - ARRAY['version','status','voided_at','void_reason','updated_at'])
          = (before_row - ARRAY['version','status','voided_at','void_reason','updated_at']))) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

-- Lines are written once, only onto a draft whose tax is still unresolved.
CREATE FUNCTION hon.guard_saas_invoice_lines() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM hon.saas_invoices i WHERE i.id = NEW.invoice_id AND i.status = 'DRAFT' AND i.tax_status = 'UNRESOLVED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_INVOICE_LINE' USING ERRCODE = '42501';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_policy_records','saas_payment_evidence'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['saas_invoice_sequences','saas_invoices'] LOOP
    EXECUTE format('CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_invoicing()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_invoicing()',t);
  END LOOP;
  CREATE TRIGGER saas_invoice_lines_rows BEFORE INSERT OR UPDATE OR DELETE ON hon.saas_invoice_lines FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_invoice_lines();
  CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_invoice_lines FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_invoice_lines();
END $$;

-- ---------- accounting helpers (private) ----------
-- Per-invoice evidence totals. "verified" counts only PROVIDER_VERIFIED evidence, which cannot exist yet.
CREATE FUNCTION hon.saas_invoice_facts(p_organization uuid, p_invoice uuid)
RETURNS TABLE (invoice_id uuid, subscription_id uuid, kind text, status text, period_index integer, service_period_end timestamptz,
  total_minor integer, received_minor bigint, refunded_minor bigint, charged_back_minor bigint, net_minor bigint, verified_net_minor bigint,
  verified_refunded_minor bigint, verified_charged_back_minor bigint, last_received_at timestamptz, last_verified_received_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT i.id, i.subscription_id, i.kind, i.status, i.period_index, i.service_period_end, i.total_minor,
    coalesce(sum(e.amount_minor) FILTER (WHERE e.kind = 'PAYMENT_RECEIVED'), 0),
    coalesce(sum(e.amount_minor) FILTER (WHERE e.kind = 'REFUND'), 0),
    coalesce(sum(e.amount_minor) FILTER (WHERE e.kind = 'CHARGEBACK'), 0),
    coalesce(sum(CASE WHEN e.kind = 'PAYMENT_RECEIVED' THEN e.amount_minor ELSE -e.amount_minor END), 0),
    coalesce(sum(CASE WHEN e.kind = 'PAYMENT_RECEIVED' THEN e.amount_minor ELSE -e.amount_minor END) FILTER (WHERE e.source = 'PROVIDER_VERIFIED'), 0),
    coalesce(sum(e.amount_minor) FILTER (WHERE e.kind = 'REFUND' AND e.source = 'PROVIDER_VERIFIED'), 0),
    coalesce(sum(e.amount_minor) FILTER (WHERE e.kind = 'CHARGEBACK' AND e.source = 'PROVIDER_VERIFIED'), 0),
    max(e.occurred_at) FILTER (WHERE e.kind = 'PAYMENT_RECEIVED'),
    max(e.occurred_at) FILTER (WHERE e.kind = 'PAYMENT_RECEIVED' AND e.source = 'PROVIDER_VERIFIED')
  FROM hon.saas_invoices i LEFT JOIN hon.saas_payment_evidence e ON e.invoice_id = i.id
  WHERE (p_invoice IS NULL OR i.id = p_invoice) AND (p_organization IS NULL OR i.organization_id = p_organization)
  GROUP BY i.id
$$;

CREATE FUNCTION hon.saas_evidence_json(e hon.saas_payment_evidence) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('evidenceId',e.id,'invoiceId',e.invoice_id,'kind',e.kind,'source',e.source,'providerVerified',false,
    'amountMinor',e.amount_minor,'currency',e.currency,'occurredAt',hon.saas_ts(e.occurred_at),'reference',e.reference,
    'relatedEvidenceId',e.related_evidence_id,'note',e.note,'recordedAt',hon.saas_ts(e.recorded_at))
$$;

CREATE FUNCTION hon.saas_invoice_json(p_invoice uuid, p_detail boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('invoiceId',i.id,'invoiceNumber',i.invoice_number,'organizationId',i.organization_id,
    'organizationName',(SELECT o.display_name FROM hon.organizations o WHERE o.id = i.organization_id),
    'subscriptionId',i.subscription_id,'kind',i.kind,'periodIndex',i.period_index,
    'servicePeriod',jsonb_build_object('startsAt',hon.saas_ts(i.service_period_start),'endsAt',hon.saas_ts(i.service_period_end)),
    'planCode',i.plan_code,'offerKind',i.offer_kind,'description',i.description,'currency',i.currency,'status',i.status,'version',i.version,
    'subtotalMinor',i.subtotal_minor,'taxStatus',i.tax_status,'taxMinor',i.tax_minor,'taxVerificationReference',i.tax_verification_reference,
    'totalMinor',i.total_minor,
    'settlement',jsonb_build_object('receivedMinor',f.received_minor,'refundedMinor',f.refunded_minor,'chargedBackMinor',f.charged_back_minor,
      'netMinor',f.net_minor,'verifiedNetMinor',f.verified_net_minor,
      'balanceMinor',CASE WHEN i.status = 'ISSUED' THEN greatest(i.total_minor - f.net_minor, 0) END,
      'state',CASE WHEN i.status = 'DRAFT' THEN 'NOT_ISSUED' WHEN i.status = 'VOID' THEN 'VOID'
        WHEN f.verified_net_minor >= i.total_minor THEN 'PAID_VERIFIED' WHEN f.net_minor >= i.total_minor THEN 'PAID_ATTESTED'
        WHEN f.net_minor > 0 THEN 'PARTIALLY_PAID' WHEN f.received_minor > 0 THEN 'REVERSED' ELSE 'UNPAID' END),
    'delivery',i.delivery_status,'collection','DISABLED',
    'createdAt',hon.saas_ts(i.created_at),'issuedAt',hon.saas_ts(i.issued_at),'voidedAt',hon.saas_ts(i.voided_at),'voidReason',i.void_reason,
    'updatedAt',hon.saas_ts(i.updated_at))
    || CASE WHEN p_detail THEN jsonb_build_object(
      'lines',(SELECT coalesce(jsonb_agg(jsonb_build_object('lineNumber',l.line_number,'lineKind',l.line_kind,'description',l.description,
          'amountMinor',l.amount_minor,'reference',l.reference) ORDER BY l.line_number), '[]'::jsonb) FROM hon.saas_invoice_lines l WHERE l.invoice_id = i.id),
      'evidence',(SELECT coalesce(jsonb_agg(hon.saas_evidence_json(e) ORDER BY e.recorded_at, e.id), '[]'::jsonb) FROM hon.saas_payment_evidence e WHERE e.invoice_id = i.id))
      ELSE '{}'::jsonb END
  FROM hon.saas_invoices i CROSS JOIN LATERAL hon.saas_invoice_facts(NULL, i.id) f WHERE i.id = p_invoice
$$;

-- Authoritative standing for future Champions Club qualification (HON_BILLING), in two strengths:
-- "verified" (provider-verified evidence only; empty until a provider exists) and "recorded"
-- (verified plus HQ attestations). Champions must only ever consume "verified".
-- An invoice counts as paid while its net evidence covers its total; a refund or chargeback that
-- reduces the net below the total removes it. Paid-through is the end of the last consecutively
-- paid monthly period of the current subscription.
CREATE FUNCTION hon.saas_payment_standing_strength(p_organization uuid, p_verified boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH cur AS (SELECT * FROM hon.saas_subscriptions s WHERE s.organization_id = p_organization AND s.status <> 'VOIDED'),
  x AS (SELECT f.*, CASE WHEN p_verified THEN f.verified_net_minor >= f.total_minor ELSE f.net_minor >= f.total_minor END AS paid,
      CASE WHEN p_verified THEN f.last_verified_received_at ELSE f.last_received_at END AS paid_at,
      CASE WHEN p_verified THEN f.verified_refunded_minor ELSE f.refunded_minor END AS refunds,
      CASE WHEN p_verified THEN f.verified_charged_back_minor ELSE f.charged_back_minor END AS chargebacks
    FROM hon.saas_invoice_facts(p_organization, NULL) f WHERE f.status = 'ISSUED'),
  gap AS (SELECT cur.id, coalesce((SELECT min(g) FROM generate_series(0, cur.period_index) g
      WHERE NOT EXISTS (SELECT 1 FROM x WHERE x.subscription_id = cur.id AND x.period_index = g AND x.paid)), cur.period_index + 1) AS n
    FROM cur WHERE cur.billing_interval = 'MONTHLY' AND cur.period_index IS NOT NULL)
  SELECT jsonb_build_object(
    'firstPaidAt', hon.saas_ts((SELECT min(x.paid_at) FROM x WHERE x.paid)),
    'paidThroughAt', hon.saas_ts((SELECT x.service_period_end FROM gap JOIN x ON x.subscription_id = gap.id AND x.period_index = gap.n - 1 AND x.paid)),
    'lifetimePaid', EXISTS (SELECT 1 FROM cur JOIN x ON x.subscription_id = cur.id AND x.kind = 'LIFETIME_PURCHASE' AND x.paid
      WHERE cur.billing_interval = 'LIFETIME'),
    'paidInvoiceCount', (SELECT count(*) FROM x WHERE x.paid),
    'refundedInvoiceCount', (SELECT count(*) FROM x WHERE x.refunds > 0),
    'chargebackInvoiceCount', (SELECT count(*) FROM x WHERE x.chargebacks > 0))
$$;

CREATE FUNCTION hon.saas_payment_standing(p_organization uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('organizationId', p_organization,
    'subscriptionId', (SELECT s.id FROM hon.saas_subscriptions s WHERE s.organization_id = p_organization AND s.status <> 'VOIDED'),
    'verified', hon.saas_payment_standing_strength(p_organization, true),
    'recorded', hon.saas_payment_standing_strength(p_organization, false),
    'evidence', (SELECT jsonb_build_object('hqAttested', count(*) FILTER (WHERE e.source = 'HQ_ATTESTATION'),
      'providerVerified', count(*) FILTER (WHERE e.source = 'PROVIDER_VERIFIED')) FROM hon.saas_payment_evidence e WHERE e.organization_id = p_organization),
    'championsPaymentSource', 'NOT_CONNECTED', 'providerVerification', 'NOT_CONFIGURED')
$$;

-- ---------- reads ----------
CREATE FUNCTION hon.read_saas_invoices_from_hq(p_subject text, p_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE rows jsonb;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('DRAFT','ISSUED','VOID') THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT coalesce(jsonb_agg(hon.saas_invoice_json(i.id, false) ORDER BY i.created_at DESC, i.id), '[]'::jsonb) INTO rows
    FROM (SELECT id, created_at FROM hon.saas_invoices WHERE p_status IS NULL OR status = p_status ORDER BY created_at DESC, id LIMIT 200) i;
  RETURN jsonb_build_object('invoices', rows, 'limit', 200, 'collection', 'DISABLED');
END $$;

CREATE FUNCTION hon.read_saas_invoice_from_hq(p_subject text, p_invoice uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE data jsonb;
BEGIN
  IF p_invoice IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  data := hon.saas_invoice_json(p_invoice, true);
  IF data IS NULL THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN data;
END $$;

CREATE FUNCTION hon.read_saas_payment_standing_from_hq(p_subject text, p_organization uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_organization IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = p_organization) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.saas_payment_standing(p_organization);
END $$;

-- ---------- invoice commands ----------
-- Owner or operator. One draft per subscription period (monthly) or per lifetime purchase, only
-- for a catalog subscription whose service has started. Never issued, sent or collected here.
CREATE FUNCTION hon.create_saas_invoice_draft(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; sub hon.saas_subscriptions%ROWTYPE; v_period integer; v_start timestamptz; v_end timestamptz; v_kind text;
  v_label text; v_desc text; created hon.saas_invoices%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['periodIndex','subscriptionId']
    OR coalesce(jsonb_typeof(p->'subscriptionId'), '') <> 'string' OR coalesce(jsonb_typeof(p->'periodIndex'), '') NOT IN ('number','null')
    OR (jsonb_typeof(p->'periodIndex') = 'number' AND (p->>'periodIndex') !~ '^[0-9]{1,4}$') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, false);
  replay := hon.saas_claim_request(actor, p_key, 'saas.invoice.draft', hon.saas_fingerprint(ARRAY['saas.invoice.draft', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO sub FROM hon.saas_subscriptions WHERE id = (p->>'subscriptionId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF sub.source <> 'CATALOG_OFFER' OR sub.status NOT IN ('IN_SERVICE','SUSPENDED') THEN
    RAISE EXCEPTION 'SAAS_INVOICE_NOT_BILLABLE' USING ERRCODE = '23514';
  END IF;
  IF sub.billing_interval = 'MONTHLY' THEN
    IF jsonb_typeof(p->'periodIndex') <> 'number' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
    v_period := (p->>'periodIndex')::integer;
    IF v_period > sub.period_index THEN RAISE EXCEPTION 'SAAS_INVOICE_PERIOD_NOT_STARTED' USING ERRCODE = '23514'; END IF;
    v_kind := 'SUBSCRIPTION_PERIOD';
    v_start := sub.period_anchor_at + make_interval(months => v_period);
    v_end := sub.period_anchor_at + make_interval(months => v_period + 1);
  ELSE
    IF jsonb_typeof(p->'periodIndex') <> 'null' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
    v_kind := 'LIFETIME_PURCHASE'; v_start := sub.service_started_at;
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_invoices i WHERE i.subscription_id = sub.id AND i.status <> 'VOID' AND i.kind = v_kind
      AND i.period_index IS NOT DISTINCT FROM v_period) THEN
    RAISE EXCEPTION 'SAAS_INVOICE_EXISTS' USING ERRCODE = '23514';
  END IF;
  v_label := CASE sub.offer_kind WHEN 'REGULAR_MONTHLY' THEN 'monthly' WHEN 'FOUNDER_MONTHLY' THEN 'founder monthly' ELSE 'founder paid lifetime' END;
  SELECT p.display_name || ' — ' || v_label || CASE WHEN v_kind = 'SUBSCRIPTION_PERIOD'
      THEN ' — service period ' || to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' to ' || to_char(v_end AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      ELSE ' — one-time purchase' END
    INTO v_desc FROM hon.saas_catalog_plans p WHERE p.catalog_id = sub.catalog_id AND p.plan_code = sub.plan_code;
  at := clock_timestamp();
  INSERT INTO hon.saas_invoices(organization_id,subscription_id,kind,period_index,service_period_start,service_period_end,plan_code,offer_kind,
      description,status,version,subtotal_minor,tax_status,created_by_principal_id,created_at,updated_at)
    VALUES (sub.organization_id,sub.id,v_kind,v_period,v_start,v_end,sub.plan_code,sub.offer_kind,v_desc,'DRAFT',1,sub.price_minor,'UNRESOLVED',actor,at,at)
    RETURNING * INTO created;
  INSERT INTO hon.saas_invoice_lines(invoice_id,line_number,line_kind,description,amount_minor,created_by_principal_id,created_at)
    VALUES (created.id,1,'PLAN_FEE',v_desc,sub.price_minor,actor,at);
  snapshot := hon.saas_invoice_json(created.id, true);
  RETURN hon.saas_record(actor, p_key, 'saas.invoice.draft', 'saas.invoice.drafted', 'INVOICE', created.id, sub.organization_id, NULL, snapshot,
    jsonb_build_object('invoice', snapshot), at);
END $$;

-- ADD_ADJUSTMENT: owner or operator. SET_TAX, ISSUE, VOID: owner only.
CREATE FUNCTION hon.command_saas_invoice(p_subject text, p_invoice uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_invoices%ROWTYPE; action text; keys text[]; adj jsonb; t jsonb; at timestamptz; snapshot jsonb;
  next_line integer; v_tax integer; v_year integer; v_seq integer; v_subtotal bigint;
BEGIN
  IF p_invoice IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k); action := p->>'action'; adj := p->'adjustment';
  IF coalesce(jsonb_typeof(p->'action'), '') <> 'string' OR coalesce(jsonb_typeof(p->'expectedVersion'), '') <> 'number'
    OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR NOT coalesce(CASE action
      WHEN 'ADD_ADJUSTMENT' THEN keys = ARRAY['action','adjustment','expectedVersion'] AND jsonb_typeof(adj) = 'object'
        AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(adj) k) = ARRAY['amountMinor','description','kind','reference']
        AND adj->>'kind' IN ('DISCOUNT','CORRECTION') AND jsonb_typeof(adj->'amountMinor') = 'number' AND (adj->>'amountMinor') ~ '^-?[1-9][0-9]{0,8}$'
        AND abs((adj->>'amountMinor')::bigint) <= 100000000 AND (adj->>'kind' <> 'DISCOUNT' OR (adj->>'amountMinor')::bigint < 0)
        AND jsonb_typeof(adj->'description') = 'string' AND length(adj->>'description') BETWEEN 1 AND 300 AND btrim(adj->>'description') = adj->>'description'
        AND jsonb_typeof(adj->'reference') IN ('string','null') AND (jsonb_typeof(adj->'reference') = 'null' OR length(adj->>'reference') BETWEEN 1 AND 200)
      WHEN 'SET_TAX' THEN keys = ARRAY['action','expectedVersion','taxLines','treatment','verificationReference']
        AND p->>'treatment' IN ('NO_TAX_APPLICABLE','TAX_LINES') AND jsonb_typeof(p->'taxLines') = 'array'
        AND ((p->>'treatment' = 'NO_TAX_APPLICABLE' AND jsonb_array_length(p->'taxLines') = 0)
          OR (p->>'treatment' = 'TAX_LINES' AND jsonb_array_length(p->'taxLines') BETWEEN 1 AND 5))
        AND jsonb_typeof(p->'verificationReference') = 'string' AND length(p->>'verificationReference') BETWEEN 1 AND 200
        AND btrim(p->>'verificationReference') = p->>'verificationReference'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p->'taxLines') x WHERE jsonb_typeof(x) <> 'object'
          OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k) IS DISTINCT FROM ARRAY['amountMinor','jurisdiction']
          OR jsonb_typeof(x->'amountMinor') <> 'number' OR (x->>'amountMinor') !~ '^[1-9][0-9]{0,7}$'
          OR jsonb_typeof(x->'jurisdiction') <> 'string' OR length(x->>'jurisdiction') NOT BETWEEN 1 AND 120 OR btrim(x->>'jurisdiction') <> x->>'jurisdiction')
      WHEN 'ISSUE' THEN keys = ARRAY['action','expectedVersion']
      WHEN 'VOID' THEN keys = ARRAY['action','expectedVersion','reasonCode'] AND p->>'reasonCode' IN ('ISSUED_IN_ERROR','DUPLICATE','SUPERSEDED')
      ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, action <> 'ADD_ADJUSTMENT');
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, action <> 'ADD_ADJUSTMENT');
  replay := hon.saas_claim_request(actor, p_key, 'saas.invoice.command', hon.saas_fingerprint(ARRAY['saas.invoice.command', p_invoice::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO prior FROM hon.saas_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF prior.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF NOT ((action IN ('ADD_ADJUSTMENT','SET_TAX') AND prior.status = 'DRAFT' AND prior.tax_status = 'UNRESOLVED')
    OR (action = 'ISSUE' AND prior.status = 'DRAFT') OR (action = 'VOID' AND prior.status IN ('DRAFT','ISSUED'))) THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001';
  END IF;
  at := clock_timestamp();
  SELECT coalesce(max(line_number), 0) + 1 INTO next_line FROM hon.saas_invoice_lines WHERE invoice_id = p_invoice;
  IF action = 'ADD_ADJUSTMENT' THEN
    IF next_line > 20 THEN RAISE EXCEPTION 'SAAS_INVOICE_TOO_MANY_LINES' USING ERRCODE = '23514'; END IF;
    v_subtotal := prior.subtotal_minor + (adj->>'amountMinor')::bigint;
    IF v_subtotal < 0 THEN RAISE EXCEPTION 'SAAS_INVOICE_NEGATIVE_TOTAL' USING ERRCODE = '23514'; END IF;
    INSERT INTO hon.saas_invoice_lines(invoice_id,line_number,line_kind,description,amount_minor,reference,created_by_principal_id,created_at)
      VALUES (p_invoice,next_line,adj->>'kind',adj->>'description',(adj->>'amountMinor')::integer,adj->>'reference',actor,at);
    UPDATE hon.saas_invoices SET subtotal_minor = v_subtotal, version = version + 1, updated_at = at WHERE id = p_invoice;
  ELSIF action = 'SET_TAX' THEN
    v_tax := 0;
    FOR t IN SELECT value FROM jsonb_array_elements(p->'taxLines') LOOP
      INSERT INTO hon.saas_invoice_lines(invoice_id,line_number,line_kind,description,amount_minor,reference,created_by_principal_id,created_at)
        VALUES (p_invoice,next_line,'TAX','Tax — ' || (t->>'jurisdiction'),(t->>'amountMinor')::integer,p->>'verificationReference',actor,at);
      next_line := next_line + 1; v_tax := v_tax + (t->>'amountMinor')::integer;
    END LOOP;
    UPDATE hon.saas_invoices SET tax_status = p->>'treatment', tax_minor = v_tax, tax_verification_reference = p->>'verificationReference',
        total_minor = subtotal_minor + v_tax, version = version + 1, updated_at = at WHERE id = p_invoice;
  ELSIF action = 'ISSUE' THEN
    IF prior.tax_status = 'UNRESOLVED' THEN RAISE EXCEPTION 'SAAS_INVOICE_TAX_UNRESOLVED' USING ERRCODE = '23514'; END IF;
    IF prior.total_minor <= 0 THEN RAISE EXCEPTION 'SAAS_INVOICE_ZERO_TOTAL' USING ERRCODE = '23514'; END IF;
    v_year := extract(year FROM at AT TIME ZONE 'UTC')::integer;
    INSERT INTO hon.saas_invoice_sequences(invoice_year, last_number) VALUES (v_year, 0) ON CONFLICT (invoice_year) DO NOTHING;
    UPDATE hon.saas_invoice_sequences SET last_number = last_number + 1 WHERE invoice_year = v_year RETURNING last_number INTO v_seq;
    UPDATE hon.saas_invoices SET status = 'ISSUED', invoice_number = 'HON-' || v_year || '-' || lpad(v_seq::text, 6, '0'),
        issued_by_principal_id = actor, issued_at = at, version = version + 1, updated_at = at WHERE id = p_invoice;
  ELSE
    IF EXISTS (SELECT 1 FROM hon.saas_payment_evidence e WHERE e.invoice_id = p_invoice) THEN
      RAISE EXCEPTION 'SAAS_INVOICE_HAS_EVIDENCE' USING ERRCODE = '23514';
    END IF;
    UPDATE hon.saas_invoices SET status = 'VOID', voided_at = at, void_reason = p->>'reasonCode', version = version + 1, updated_at = at WHERE id = p_invoice;
  END IF;
  snapshot := hon.saas_invoice_json(p_invoice, true);
  RETURN hon.saas_record(actor, p_key, 'saas.invoice.command', 'saas.invoice.changed', 'INVOICE', p_invoice, prior.organization_id,
    jsonb_build_object('status', prior.status, 'version', prior.version, 'subtotalMinor', prior.subtotal_minor, 'taxStatus', prior.tax_status),
    snapshot || jsonb_build_object('action', action), jsonb_build_object('invoice', snapshot, 'action', action), at);
END $$;

-- HQ owner only. Records that a payment, refund or chargeback happened outside HON. Always
-- HQ_ATTESTATION: it never claims processor confirmation, executes nothing and changes no
-- subscription, founder slot, entitlement or Champions reward.
CREATE FUNCTION hon.record_saas_payment_evidence(p_subject text, p_invoice uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; inv hon.saas_invoices%ROWTYPE; rel hon.saas_payment_evidence%ROWTYPE; created hon.saas_payment_evidence%ROWTYPE;
  facts record; at timestamptz; v_at timestamptz; v_amount integer; reversed bigint; snapshot jsonb;
BEGIN
  IF p_invoice IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['amountMinor','kind','note','occurredAt','reference','relatedEvidenceId']
    OR coalesce(p->>'kind', '') NOT IN ('PAYMENT_RECEIVED','REFUND','CHARGEBACK')
    OR coalesce(jsonb_typeof(p->'amountMinor'), '') <> 'number' OR (p->>'amountMinor') !~ '^[1-9][0-9]{0,8}$' OR (p->>'amountMinor')::bigint > 200000000
    OR coalesce(jsonb_typeof(p->'occurredAt'), '') <> 'string' OR (p->>'occurredAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR coalesce(jsonb_typeof(p->'reference'), '') <> 'string' OR length(p->>'reference') NOT BETWEEN 1 AND 200 OR btrim(p->>'reference') <> p->>'reference'
    OR coalesce(jsonb_typeof(p->'note'), '') NOT IN ('string','null') OR (jsonb_typeof(p->'note') = 'string' AND length(p->>'note') NOT BETWEEN 1 AND 500)
    OR coalesce(jsonb_typeof(p->'relatedEvidenceId'), '') NOT IN ('string','null')
    OR (p->>'kind' = 'PAYMENT_RECEIVED') <> (jsonb_typeof(p->'relatedEvidenceId') = 'null') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_at := (p->>'occurredAt')::timestamptz; v_amount := (p->>'amountMinor')::integer;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.payment.evidence', hon.saas_fingerprint(ARRAY['saas.payment.evidence', p_invoice::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO inv FROM hon.saas_invoices WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF inv.status <> 'ISSUED' THEN RAISE EXCEPTION 'SAAS_INVOICE_NOT_ISSUED' USING ERRCODE = '23514'; END IF;
  at := clock_timestamp();
  IF v_at > at THEN RAISE EXCEPTION 'SAAS_EVIDENCE_IN_FUTURE' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_payment_evidence e WHERE e.invoice_id = p_invoice AND e.kind = p->>'kind' AND e.reference = p->>'reference') THEN
    RAISE EXCEPTION 'SAAS_EVIDENCE_DUPLICATE_REFERENCE' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO facts FROM hon.saas_invoice_facts(NULL, p_invoice);
  IF p->>'kind' = 'PAYMENT_RECEIVED' THEN
    IF v_amount > inv.total_minor - facts.net_minor THEN RAISE EXCEPTION 'SAAS_PAYMENT_EXCEEDS_BALANCE' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT * INTO rel FROM hon.saas_payment_evidence e WHERE e.id = (p->>'relatedEvidenceId')::uuid;
    IF NOT FOUND OR rel.invoice_id <> p_invoice OR rel.kind <> 'PAYMENT_RECEIVED' THEN
      RAISE EXCEPTION 'SAAS_EVIDENCE_RELATED_MISMATCH' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(sum(amount_minor), 0) INTO reversed FROM hon.saas_payment_evidence WHERE related_evidence_id = rel.id;
    IF v_amount > rel.amount_minor - reversed THEN RAISE EXCEPTION 'SAAS_REVERSAL_EXCEEDS_PAYMENT' USING ERRCODE = '23514'; END IF;
    IF v_at < rel.occurred_at THEN RAISE EXCEPTION 'SAAS_EVIDENCE_BEFORE_PAYMENT' USING ERRCODE = '23514'; END IF;
  END IF;
  INSERT INTO hon.saas_payment_evidence(invoice_id,organization_id,subscription_id,kind,source,amount_minor,occurred_at,reference,related_evidence_id,
      note,recorded_by_principal_id,recorded_at)
    VALUES (p_invoice,inv.organization_id,inv.subscription_id,p->>'kind','HQ_ATTESTATION',v_amount,v_at,p->>'reference',
      (p->>'relatedEvidenceId')::uuid,p->>'note',actor,at)
    RETURNING * INTO created;
  snapshot := hon.saas_evidence_json(created);
  RETURN hon.saas_record(actor, p_key, 'saas.payment.evidence', 'saas.payment.evidence_recorded', 'PAYMENT_EVIDENCE', created.id, inv.organization_id,
    NULL, snapshot, jsonb_build_object('evidence', snapshot, 'invoice', hon.saas_invoice_json(p_invoice, false)), at);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_policy_records','saas_invoice_sequences','saas_invoices','saas_invoice_lines','saas_payment_evidence'] LOOP
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
      hon.record_saas_payment_evidence(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
