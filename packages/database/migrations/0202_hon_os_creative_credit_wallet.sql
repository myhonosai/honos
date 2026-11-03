BEGIN;

-- CW1: HON OS creative credit wallet (provider-free backend foundation). Provisional migration number:
-- numbers after 0192 are provisional until the owner approves merge order (0193-0200 are the open S4
-- chain and #122; 0201 is the Issue #100 billing-period fix).
--
-- Owner-approved direction (2026-10-31 and 2026-11-03):
-- - Every paid HON OS school gets 12,000 creative credits per monthly window (annual = monthly windows).
--   Only image and video generation deduct; AI team conversations never do.
-- - Creative credits are separate from the internal AI-agent budget: usage is written to the shared
--   hon.ai_usage_ledger with customer_credits = 0, so it never counts against the agent ceiling, and the
--   wallet path never takes an agent budget lock.
-- - Top-up packages: $30 = 3,000; $60 = 6,000 + 1,200 bonus; $120 = 12,000 + 4,800 bonus. Credits are
--   granted only from provider-verified payment. No card is charged here: purchases are recorded intents
--   and fulfillment is an internal contract that is not wired to any webhook in this migration.
-- - The HQ owner can grant, adjust and correct a school's credits with no preset limit; every change is
--   authenticated, idempotent and permanently audited.
--
-- Reuses B3/B5 infrastructure instead of a competing system: HQ and school actor resolvers, the SaaS
-- request/audit/outbox evidence (saas_claim_request / saas_record), verified provider cost evidence,
-- the B3 reservation vocabulary (RESERVED / FINALIZED / RELEASED / OUTCOME_UNKNOWN, HQ resolution of
-- unknown outcomes with evidence), the UTC allowance windows (saas_allowance_period), the B5 payment
-- truth (saas_subscription_payment) and B6A paid access (saas_access_states).
--
-- Not decided by the owner, so NOT invented here: purchased and promotional credits never expire
-- (CW-D1); top-up refunds/chargebacks do not claw back credits and purchased lots cannot be debited
-- (CW-D4); no high-value confirmation threshold (CW-D6); rates are PROVISIONAL until linked to verified
-- provider cost (CW-D5); legacy (non-HON OS) subscriptions get no monthly window (AI-D5); trial schools
-- get no allowance (OD-21). Consumption order (CW-D2 proposal): included first, then promotional and
-- adjustment, then purchased, earliest expiry and oldest first.
-- The program ships INACTIVE. Nothing here calls a provider, charges a card or activates payments.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON creative credits require a trusted migration owner';
  END IF;
END $$;

-- ---------- program (singleton, ships INACTIVE) ----------
CREATE TABLE hon.saas_creative_program (
  program_id smallint PRIMARY KEY CHECK (program_id = 1),
  status text NOT NULL CHECK (status IN ('INACTIVE','ACTIVE')),
  version integer NOT NULL CHECK (version > 0),
  -- Owner-approved monthly included amount; changing it needs a new reviewed migration.
  monthly_included_credits integer NOT NULL CHECK (monthly_included_credits = 12000),
  authorization_reference text CHECK (length(authorization_reference) BETWEEN 1 AND 200),
  changed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL,
  CHECK (status = 'INACTIVE' OR (authorization_reference IS NOT NULL AND changed_by_principal_id IS NOT NULL))
);
INSERT INTO hon.saas_creative_program(program_id, status, version, monthly_included_credits, changed_at)
  VALUES (1, 'INACTIVE', 1, 12000, clock_timestamp());

-- ---------- configurable generation rates (versioned, PROVISIONAL until linked to verified cost) ----------
CREATE TABLE hon.saas_creative_rate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_version integer NOT NULL UNIQUE CHECK (rate_version > 0),
  status text NOT NULL CHECK (status IN ('PUBLISHED','RETIRED')),
  terms_reference text NOT NULL CHECK (length(terms_reference) BETWEEN 1 AND 500),
  published_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL,
  retired_at timestamptz,
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX saas_creative_one_published_rates ON hon.saas_creative_rate_versions ((true)) WHERE status = 'PUBLISHED';

CREATE TABLE hon.saas_creative_rates (
  rate_version_id uuid NOT NULL REFERENCES hon.saas_creative_rate_versions(id) ON DELETE RESTRICT,
  operation_code text NOT NULL CHECK (operation_code ~ '^[a-z][a-z0-9_.]{2,59}$'),
  media_kind text NOT NULL CHECK (media_kind IN ('IMAGE','VIDEO')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120 AND btrim(display_name) = display_name),
  billing_unit text NOT NULL CHECK (billing_unit IN ('IMAGE','VIDEO_SECOND','REQUEST')),
  credits_per_unit integer NOT NULL CHECK (credits_per_unit BETWEEN 1 AND 1000000),
  max_units_per_request integer NOT NULL CHECK (max_units_per_request BETWEEN 1 AND 1000),
  rate_basis text NOT NULL CHECK (rate_basis IN ('PROVISIONAL','VERIFIED_COST')),
  cost_evidence_id uuid REFERENCES hon.saas_provider_cost_evidence(id) ON DELETE RESTRICT,
  PRIMARY KEY (rate_version_id, operation_code),
  CHECK ((rate_basis = 'VERIFIED_COST') = (cost_evidence_id IS NOT NULL)),
  CHECK (media_kind <> 'IMAGE' OR billing_unit IN ('IMAGE','REQUEST'))
);

-- ---------- approved top-up packages (immutable) ----------
CREATE TABLE hon.saas_creative_topup_packages (
  package_code text NOT NULL CHECK (package_code IN ('STARTER','GROWTH','CREATOR')),
  package_version integer NOT NULL CHECK (package_version > 0),
  base_credits integer NOT NULL CHECK (base_credits > 0),
  bonus_credits integer NOT NULL CHECK (bonus_credits >= 0),
  price_minor integer NOT NULL CHECK (price_minor > 0),
  currency text NOT NULL CHECK (currency = 'usd'),
  approval_reference text NOT NULL CHECK (length(approval_reference) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (package_code, package_version)
);
INSERT INTO hon.saas_creative_topup_packages(package_code, package_version, base_credits, bonus_credits, price_minor, currency, approval_reference, created_at) VALUES
  ('STARTER', 1, 3000, 0, 3000, 'usd', 'OWNER_DIRECTION_2026_10_31_TOPUPS', clock_timestamp()),
  ('GROWTH', 1, 6000, 1200, 6000, 'usd', 'OWNER_DIRECTION_2026_10_31_TOPUPS', clock_timestamp()),
  ('CREATOR', 1, 12000, 4800, 12000, 'usd', 'OWNER_DIRECTION_2026_10_31_TOPUPS', clock_timestamp());

-- ---------- wallets, lots and the append-only ledger ----------
-- One wallet per organization (the HON OS paying customer); the row lock serializes every balance change.
CREATE TABLE hon.saas_creative_wallets (
  organization_id uuid PRIMARY KEY REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE hon.saas_creative_topup_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.saas_creative_wallets(organization_id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  package_code text NOT NULL, package_version integer NOT NULL,
  base_credits integer NOT NULL CHECK (base_credits > 0), bonus_credits integer NOT NULL CHECK (bonus_credits >= 0),
  price_minor integer NOT NULL CHECK (price_minor > 0), currency text NOT NULL CHECK (currency = 'usd'),
  status text NOT NULL CHECK (status IN ('PENDING_PAYMENT','FULFILLED','NEEDS_REVIEW')),
  status_reason text NOT NULL CHECK (status_reason IN ('AWAITING_VERIFIED_PAYMENT','PAYMENT_VERIFIED','AMOUNT_MISMATCH','CURRENCY_MISMATCH','DUPLICATE_PAYMENT')),
  version integer NOT NULL CHECK (version > 0),
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  payment_provider text CHECK (payment_provider IN ('STRIPE','STRIPE_SIMULATED')),
  provider_payment_ref text UNIQUE CHECK (provider_payment_ref ~ '^(pi|cs_test|in)_[A-Za-z0-9_]{1,200}$'),
  paid_amount_minor integer CHECK (paid_amount_minor >= 0), paid_currency text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, fulfilled_at timestamptz,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (package_code, package_version) REFERENCES hon.saas_creative_topup_packages(package_code, package_version) ON DELETE RESTRICT,
  CHECK ((status = 'PENDING_PAYMENT') = (provider_payment_ref IS NULL)),
  CHECK ((status = 'FULFILLED') = (fulfilled_at IS NOT NULL)),
  CHECK (status <> 'FULFILLED' OR (paid_amount_minor = price_minor AND paid_currency = currency AND status_reason = 'PAYMENT_VERIFIED'))
);

CREATE TABLE hon.saas_creative_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.saas_creative_wallets(organization_id) ON DELETE RESTRICT,
  adjustment_kind text NOT NULL CHECK (adjustment_kind IN ('PROMOTIONAL_GRANT','ADJUSTMENT_GRANT','CORRECTION_DEBIT')),
  credits integer NOT NULL CHECK (credits BETWEEN 1 AND 1000000000),
  lot_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('PROMOTION','GOODWILL','SERVICE_RECOVERY','BILLING_CORRECTION','RECORDED_IN_ERROR','OTHER')),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 500 AND btrim(note) = note),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE hon.saas_creative_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.saas_creative_wallets(organization_id) ON DELETE RESTRICT,
  lot_kind text NOT NULL CHECK (lot_kind IN ('INCLUDED_MONTHLY','PROMOTIONAL','ADJUSTMENT','PURCHASED_TOPUP')),
  credits integer NOT NULL CHECK (credits BETWEEN 1 AND 1000000000),
  base_credits integer, bonus_credits integer,
  subscription_id uuid REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  window_index integer CHECK (window_index >= 0),
  window_start timestamptz, window_end timestamptz,
  purchase_id uuid UNIQUE REFERENCES hon.saas_creative_topup_purchases(id) ON DELETE RESTRICT,
  adjustment_id uuid UNIQUE REFERENCES hon.saas_creative_adjustments(id) ON DELETE RESTRICT,
  expires_at timestamptz,
  granted_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL,
  CHECK (CASE lot_kind
    WHEN 'INCLUDED_MONTHLY' THEN subscription_id IS NOT NULL AND window_index IS NOT NULL AND window_end > window_start
      AND expires_at = window_end AND purchase_id IS NULL AND adjustment_id IS NULL AND base_credits IS NULL AND bonus_credits IS NULL
    WHEN 'PURCHASED_TOPUP' THEN purchase_id IS NOT NULL AND base_credits > 0 AND bonus_credits >= 0 AND credits = base_credits + bonus_credits
      AND expires_at IS NULL AND subscription_id IS NULL AND window_index IS NULL AND adjustment_id IS NULL
    ELSE adjustment_id IS NOT NULL AND expires_at IS NULL AND subscription_id IS NULL AND window_index IS NULL AND purchase_id IS NULL
      AND base_credits IS NULL AND bonus_credits IS NULL END)
);
-- One included grant per subscription window: a replayed or concurrent open never grants twice.
CREATE UNIQUE INDEX saas_creative_one_window_grant ON hon.saas_creative_lots (subscription_id, window_index) WHERE lot_kind = 'INCLUDED_MONTHLY';
CREATE INDEX saas_creative_lots_org ON hon.saas_creative_lots (organization_id, granted_at);
-- Adjustment and lot cite each other; NO ACTION (not RESTRICT) so the pair is checked at commit. Both tables are
-- append-only evidence (saas_immutable), so no row is ever deleted outside a disposable fixture reset.
ALTER TABLE hon.saas_creative_adjustments ADD CONSTRAINT saas_creative_adjustments_lot_fkey
  FOREIGN KEY (lot_id) REFERENCES hon.saas_creative_lots(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE hon.saas_creative_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.saas_creative_wallets(organization_id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  rate_version_id uuid NOT NULL,
  operation_code text NOT NULL,
  media_kind text NOT NULL CHECK (media_kind IN ('IMAGE','VIDEO')),
  rate_basis text NOT NULL CHECK (rate_basis IN ('PROVISIONAL','VERIFIED_COST')),
  credits_per_unit integer NOT NULL CHECK (credits_per_unit > 0),
  units integer NOT NULL CHECK (units > 0),
  reserved_credits integer NOT NULL CHECK (reserved_credits > 0),
  status text NOT NULL CHECK (status IN ('RESERVED','FINALIZED','RELEASED','OUTCOME_UNKNOWN')),
  status_reason text NOT NULL CHECK (status_reason IN ('RESERVED','PROVIDER_SUCCEEDED','PROVIDER_FAILED','PROVIDER_OUTCOME_UNKNOWN',
    'HQ_RESOLVED_SUCCEEDED','HQ_RESOLVED_NOT_CHARGED')),
  version integer NOT NULL CHECK (version > 0),
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  provider_id text NOT NULL REFERENCES hon.hq_ai_provider_connections(provider_id) ON DELETE RESTRICT,
  model_code text NOT NULL CHECK (hon.hq_ai_safe_text(model_code, true)),
  final_units integer CHECK (final_units >= 0),
  final_credits integer CHECK (final_credits >= 0),
  -- Actual provider expense, recorded independently from the customer credits deducted.
  provider_cost_microunits bigint CHECK (provider_cost_microunits >= 0),
  usage_id uuid UNIQUE REFERENCES hon.ai_usage_ledger(id) ON DELETE RESTRICT,
  resolution_reference text CHECK (length(resolution_reference) BETWEEN 1 AND 200),
  reserved_at timestamptz NOT NULL,
  settled_at timestamptz,
  settled_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (rate_version_id, operation_code) REFERENCES hon.saas_creative_rates(rate_version_id, operation_code) ON DELETE RESTRICT,
  CHECK (reserved_credits = credits_per_unit * units),
  CHECK (CASE status
    WHEN 'RESERVED' THEN final_units IS NULL AND final_credits IS NULL AND settled_at IS NULL AND provider_cost_microunits IS NULL
    WHEN 'OUTCOME_UNKNOWN' THEN final_units IS NULL AND final_credits IS NULL AND settled_at IS NULL AND provider_cost_microunits IS NULL
    WHEN 'FINALIZED' THEN final_units >= 0 AND final_credits = final_units * credits_per_unit AND final_credits <= reserved_credits
      AND provider_cost_microunits IS NOT NULL AND usage_id IS NOT NULL AND settled_at IS NOT NULL
    ELSE final_units IS NULL AND final_credits IS NULL AND settled_at IS NOT NULL END)
);
CREATE INDEX saas_creative_reservations_org ON hon.saas_creative_reservations (organization_id, reserved_at DESC);

-- Per lot: GRANT g; RESERVE r, then FINALIZE f and RELEASE (r - f) per reservation; EXPIRE e; DEBIT d.
-- remaining = g - r + release - d - e; held = r - f - release; available = remaining while unexpired.
CREATE TABLE hon.saas_creative_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.saas_creative_wallets(organization_id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES hon.saas_creative_lots(id) ON DELETE RESTRICT,
  entry_kind text NOT NULL CHECK (entry_kind IN ('GRANT','RESERVE','FINALIZE','RELEASE','EXPIRE','DEBIT')),
  credits integer NOT NULL CHECK (credits BETWEEN 1 AND 1000000000),
  reservation_id uuid REFERENCES hon.saas_creative_reservations(id) ON DELETE RESTRICT,
  adjustment_id uuid REFERENCES hon.saas_creative_adjustments(id) ON DELETE RESTRICT,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  CHECK (entry_kind NOT IN ('RESERVE','FINALIZE','RELEASE') OR reservation_id IS NOT NULL),
  CHECK (entry_kind NOT IN ('GRANT','DEBIT') OR reservation_id IS NULL),
  -- DEBIT always cites its HQ correction; GRANT cites the HQ adjustment for promotional/adjustment lots; nothing else does.
  CHECK (CASE entry_kind WHEN 'DEBIT' THEN adjustment_id IS NOT NULL WHEN 'GRANT' THEN true ELSE adjustment_id IS NULL END)
);
CREATE UNIQUE INDEX saas_creative_ledger_one_grant ON hon.saas_creative_ledger (lot_id) WHERE entry_kind = 'GRANT';
CREATE UNIQUE INDEX saas_creative_ledger_one_per_reservation ON hon.saas_creative_ledger (reservation_id, lot_id, entry_kind) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX saas_creative_ledger_one_expiry ON hon.saas_creative_ledger (lot_id) WHERE entry_kind = 'EXPIRE' AND reservation_id IS NULL;
CREATE INDEX saas_creative_ledger_lot ON hon.saas_creative_ledger (lot_id, entry_kind);
CREATE INDEX saas_creative_ledger_org ON hon.saas_creative_ledger (organization_id, occurred_at DESC);

-- ---------- vocabularies ----------
DO $$ DECLARE def text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_action_code_check';
 ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
 EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR action_code IN (''saas.creative.program'',''saas.creative.rates'',''saas.creative.window'',''saas.creative.reserve'',''saas.creative.settle'',''saas.creative.resolve'',''saas.creative.grant'',''saas.creative.debit'',''saas.creative.purchase'',''saas.creative.fulfill''))';
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_audit'::regclass AND conname='saas_audit_entity_type_check';
 ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
 EXECUTE 'ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR entity_type IN (''CREATIVE_PROGRAM'',''CREATIVE_RATES'',''CREATIVE_LOT'',''CREATIVE_RESERVATION'',''CREATIVE_ADJUSTMENT'',''CREATIVE_PURCHASE''))';
 SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='hon.saas_outbox'::regclass AND conname='saas_outbox_event_type_check';
 ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
 EXECUTE 'ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (('||substring(def FROM 8 FOR length(def)-8)||') OR event_type IN (''saas.creative.program_changed'',''saas.creative.rates_published'',''saas.creative.window_opened'',''saas.creative.reserved'',''saas.creative.settled'',''saas.creative.resolved'',''saas.creative.granted'',''saas.creative.debited'',''saas.creative.purchase_created'',''saas.creative.purchase_fulfilled''))';
END $$;

-- ---------- guards ----------
CREATE FUNCTION hon.guard_saas_creative() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE before_row jsonb; after_row jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_CREATIVE' USING ERRCODE = '42501'; END IF;
  before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'saas_creative_program' THEN
    IF NEW.version = OLD.version + 1 AND NEW.status <> OLD.status
      AND (after_row - ARRAY['status','version','authorization_reference','changed_by_principal_id','changed_at'])
        = (before_row - ARRAY['status','version','authorization_reference','changed_by_principal_id','changed_at']) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'saas_creative_rate_versions' THEN
    IF OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED' AND (after_row - ARRAY['status','retired_at']) = (before_row - ARRAY['status','retired_at']) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'saas_creative_wallets' THEN
    IF NEW.version = OLD.version + 1 AND (after_row - ARRAY['version','updated_at']) = (before_row - ARRAY['version','updated_at']) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'saas_creative_reservations' THEN
    IF NEW.version = OLD.version + 1
      AND (after_row - ARRAY['status','status_reason','version','final_units','final_credits','provider_cost_microunits','usage_id','resolution_reference','settled_at','settled_by_principal_id'])
        = (before_row - ARRAY['status','status_reason','version','final_units','final_credits','provider_cost_microunits','usage_id','resolution_reference','settled_at','settled_by_principal_id'])
      AND ((OLD.status = 'RESERVED' AND NEW.status IN ('FINALIZED','RELEASED','OUTCOME_UNKNOWN'))
        OR (OLD.status = 'OUTCOME_UNKNOWN' AND NEW.status IN ('FINALIZED','RELEASED'))) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'saas_creative_topup_purchases' THEN
    IF OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('FULFILLED','NEEDS_REVIEW') AND NEW.version = OLD.version + 1
      AND (after_row - ARRAY['status','status_reason','version','payment_provider','provider_payment_ref','paid_amount_minor','paid_currency','updated_at','fulfilled_at'])
        = (before_row - ARRAY['status','status_reason','version','payment_provider','provider_payment_ref','paid_amount_minor','paid_currency','updated_at','fulfilled_at']) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_creative_rates','saas_creative_topup_packages','saas_creative_lots','saas_creative_ledger','saas_creative_adjustments'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['saas_creative_program','saas_creative_rate_versions','saas_creative_wallets','saas_creative_reservations','saas_creative_topup_purchases'] LOOP
    EXECUTE format('CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_creative()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_creative()',t);
  END LOOP;
END $$;

-- ---------- private helpers ----------
CREATE FUNCTION hon.saas_creative_program_active() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce((SELECT status = 'ACTIVE' FROM hon.saas_creative_program WHERE program_id = 1), false)
$$;

-- Locks (creating if needed) the organization's wallet. Every grant, reservation, settlement, expiry and
-- HQ change for one organization serializes here, so concurrent spending can never overdraw a lot.
CREATE FUNCTION hon.saas_creative_lock_wallet(p_org uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  INSERT INTO hon.saas_creative_wallets(organization_id, version, created_at, updated_at) VALUES (p_org, 1, p_at, p_at) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM hon.saas_creative_wallets WHERE organization_id = p_org FOR UPDATE;
END $$;

CREATE FUNCTION hon.saas_creative_touch_wallet(p_org uuid, p_at timestamptz) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  UPDATE hon.saas_creative_wallets SET version = version + 1, updated_at = greatest(updated_at, p_at) WHERE organization_id = p_org
$$;

-- Ledger totals for one lot.
CREATE FUNCTION hon.saas_creative_lot_totals(p_lot uuid) RETURNS TABLE (granted bigint, reserved bigint, finalized bigint, released bigint, expired bigint, debited bigint)
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT coalesce(sum(credits) FILTER (WHERE entry_kind = 'GRANT'), 0), coalesce(sum(credits) FILTER (WHERE entry_kind = 'RESERVE'), 0),
    coalesce(sum(credits) FILTER (WHERE entry_kind = 'FINALIZE'), 0), coalesce(sum(credits) FILTER (WHERE entry_kind = 'RELEASE'), 0),
    coalesce(sum(credits) FILTER (WHERE entry_kind = 'EXPIRE'), 0), coalesce(sum(credits) FILTER (WHERE entry_kind = 'DEBIT'), 0)
  FROM hon.saas_creative_ledger WHERE lot_id = p_lot
$$;

CREATE FUNCTION hon.saas_creative_lot_remaining(p_lot uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT (granted - reserved + released - debited - expired)::integer FROM hon.saas_creative_lot_totals(p_lot)
$$;

CREATE FUNCTION hon.saas_creative_lot_available(l hon.saas_creative_lots, p_at timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN l.expires_at IS NOT NULL AND l.expires_at <= p_at THEN 0 ELSE greatest(hon.saas_creative_lot_remaining(l.id), 0) END
$$;

-- Lots in consumption order (CW-D2 proposal): included first, then promotional/adjustment, then purchased;
-- inside a kind the earliest expiry, then the oldest grant.
CREATE FUNCTION hon.saas_creative_lot_rank(p_kind text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE p_kind WHEN 'INCLUDED_MONTHLY' THEN 1 WHEN 'PROMOTIONAL' THEN 2 WHEN 'ADJUSTMENT' THEN 2 ELSE 3 END
$$;

-- Expires the unused part of ended included windows (no rollover). Callers hold the wallet lock.
CREATE FUNCTION hon.saas_creative_expire_lots(p_org uuid, p_actor uuid, p_at timestamptz) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE l record; remaining integer; n integer := 0;
BEGIN
  FOR l IN SELECT x.id FROM hon.saas_creative_lots x WHERE x.organization_id = p_org AND x.expires_at <= p_at
      AND NOT EXISTS (SELECT 1 FROM hon.saas_creative_ledger e WHERE e.lot_id = x.id AND e.entry_kind = 'EXPIRE' AND e.reservation_id IS NULL)
      ORDER BY x.expires_at, x.id LOOP
    remaining := hon.saas_creative_lot_remaining(l.id);
    IF remaining > 0 THEN
      INSERT INTO hon.saas_creative_ledger(organization_id, lot_id, entry_kind, credits, actor_principal_id, occurred_at)
        VALUES (p_org, l.id, 'EXPIRE', remaining, p_actor, p_at);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Whether the organization may receive its included window and spend creative credits right now:
-- the program is ACTIVE, B6A paid access is PAYMENT_ACTIVE (never a trial, a provisioned school or an
-- HQ access exception: AI-D1), the HON OS subscription is in service, and its current paid period is
-- provider-verified. Annual and lifetime terms get monthly UTC windows from service start.
CREATE FUNCTION hon.saas_creative_eligibility(p_org uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE s hon.saas_subscriptions%ROWTYPE; st text; acc jsonb; pay jsonb; per record; reason text; paid_through timestamptz;
BEGIN
  SELECT state INTO st FROM hon.saas_access_states WHERE organization_id = p_org;
  acc := hon.saas_organization_access(p_org);
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = p_org AND status <> 'VOIDED';
  IF s.id IS NOT NULL THEN
    pay := hon.saas_subscription_payment(s);
    SELECT * INTO per FROM hon.saas_allowance_period(s, p_at);
    paid_through := (pay->>'paidThroughAt')::timestamptz;
  END IF;
  reason := CASE
    WHEN NOT hon.saas_creative_program_active() THEN 'PROGRAM_INACTIVE'
    WHEN st IS DISTINCT FROM 'PAYMENT_ACTIVE' THEN 'PAID_ACCESS_REQUIRED'
    WHEN NOT coalesce((acc#>>'{entitlement,inEffect}')::boolean, false) THEN 'ENTITLEMENT_NOT_IN_EFFECT'
    WHEN s.id IS NULL OR s.source <> 'HON_OS_OFFER' THEN 'HON_OS_SUBSCRIPTION_REQUIRED'
    WHEN s.status <> 'IN_SERVICE' THEN 'SUBSCRIPTION_NOT_IN_SERVICE'
    WHEN pay->>'paymentStatus' <> 'PAID' OR pay->>'paymentVerification' <> 'PROVIDER_VERIFIED' THEN 'VERIFIED_PAYMENT_REQUIRED'
    WHEN per.period_index IS NULL OR p_at < per.period_start OR p_at >= per.period_end THEN 'WINDOW_UNAVAILABLE'
    WHEN s.billing_interval IN ('MONTHLY','ANNUAL') AND (paid_through IS NULL OR per.period_start >= paid_through) THEN 'WINDOW_NOT_PAID'
    WHEN s.billing_interval = 'ANNUAL' AND per.period_start >= s.current_period_end THEN 'WINDOW_NOT_PAID' END;
  RETURN jsonb_build_object('eligible', reason IS NULL, 'reason', reason, 'subscriptionId', s.id,
    'window', CASE WHEN reason IS NULL THEN jsonb_build_object('index', per.period_index, 'startsAt', hon.saas_ts(per.period_start), 'endsAt', hon.saas_ts(per.period_end)) END);
END $$;

-- Opens the current included window for an eligible organization (idempotent per subscription window).
-- Callers hold the wallet lock. Returns the lot id, or NULL when the organization is not eligible.
CREATE FUNCTION hon.saas_creative_open_window(p_org uuid, p_actor uuid, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE e jsonb; v_lot uuid; v_credits integer;
BEGIN
  PERFORM hon.saas_creative_expire_lots(p_org, p_actor, p_at);
  e := hon.saas_creative_eligibility(p_org, p_at);
  IF NOT (e->>'eligible')::boolean THEN RETURN NULL; END IF;
  SELECT id INTO v_lot FROM hon.saas_creative_lots WHERE lot_kind = 'INCLUDED_MONTHLY' AND subscription_id = (e->>'subscriptionId')::uuid
    AND window_index = (e#>>'{window,index}')::integer;
  IF v_lot IS NOT NULL THEN RETURN v_lot; END IF;
  SELECT monthly_included_credits INTO v_credits FROM hon.saas_creative_program WHERE program_id = 1;
  INSERT INTO hon.saas_creative_lots(organization_id, lot_kind, credits, subscription_id, window_index, window_start, window_end, expires_at,
      granted_by_principal_id, granted_at)
    VALUES (p_org, 'INCLUDED_MONTHLY', v_credits, (e->>'subscriptionId')::uuid, (e#>>'{window,index}')::integer,
      (e#>>'{window,startsAt}')::timestamptz, (e#>>'{window,endsAt}')::timestamptz, (e#>>'{window,endsAt}')::timestamptz, p_actor, p_at)
    RETURNING id INTO v_lot;
  INSERT INTO hon.saas_creative_ledger(organization_id, lot_id, entry_kind, credits, actor_principal_id, occurred_at)
    VALUES (p_org, v_lot, 'GRANT', v_credits, p_actor, p_at);
  PERFORM hon.saas_creative_touch_wallet(p_org, p_at);
  RETURN v_lot;
END $$;

CREATE FUNCTION hon.saas_creative_lot_json(l hon.saas_creative_lots, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('lotId', l.id, 'kind', l.lot_kind, 'credits', l.credits, 'baseCredits', l.base_credits, 'bonusCredits', l.bonus_credits,
    'window', CASE WHEN l.window_index IS NULL THEN NULL ELSE jsonb_build_object('index', l.window_index, 'startsAt', hon.saas_ts(l.window_start), 'endsAt', hon.saas_ts(l.window_end)) END,
    'purchaseId', l.purchase_id, 'adjustmentId', l.adjustment_id, 'expiresAt', hon.saas_ts(l.expires_at),
    'expired', l.expires_at IS NOT NULL AND l.expires_at <= p_at,
    'availableCredits', hon.saas_creative_lot_available(l, p_at), 'heldCredits', (t.reserved - t.finalized - t.released),
    'consumedCredits', t.finalized, 'expiredCredits', t.expired, 'debitedCredits', t.debited, 'grantedAt', hon.saas_ts(l.granted_at))
  FROM hon.saas_creative_lot_totals(l.id) t
$$;

CREATE FUNCTION hon.saas_creative_balance_json(p_org uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH lots AS (SELECT l.lot_kind, hon.saas_creative_lot_json(l, p_at) j FROM hon.saas_creative_lots l WHERE l.organization_id = p_org),
  k AS (SELECT kind FROM unnest(ARRAY['INCLUDED_MONTHLY','PROMOTIONAL','ADJUSTMENT','PURCHASED_TOPUP']) kind)
  SELECT jsonb_build_object(
    'availableCredits', coalesce((SELECT sum((j->>'availableCredits')::bigint) FROM lots), 0),
    'heldCredits', coalesce((SELECT sum((j->>'heldCredits')::bigint) FROM lots), 0),
    'byKind', (SELECT jsonb_agg(jsonb_build_object('kind', k.kind,
        'grantedCredits', coalesce((SELECT sum((j->>'credits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'availableCredits', coalesce((SELECT sum((j->>'availableCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'heldCredits', coalesce((SELECT sum((j->>'heldCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'consumedCredits', coalesce((SELECT sum((j->>'consumedCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'expiredCredits', coalesce((SELECT sum((j->>'expiredCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0),
        'debitedCredits', coalesce((SELECT sum((j->>'debitedCredits')::bigint) FROM lots WHERE lots.lot_kind = k.kind), 0))
      ORDER BY hon.saas_creative_lot_rank(k.kind), k.kind) FROM k))
$$;

-- p_internal adds provider and actual cost for HQ; school views never see provider cost.
CREATE FUNCTION hon.saas_creative_reservation_json(r hon.saas_creative_reservations, p_internal boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('reservationId', r.id, 'schoolId', r.school_id, 'operationCode', r.operation_code, 'mediaKind', r.media_kind,
    'rateBasis', r.rate_basis, 'creditsPerUnit', r.credits_per_unit, 'units', r.units, 'reservedCredits', r.reserved_credits,
    'status', r.status, 'statusReason', r.status_reason, 'version', r.version, 'finalUnits', r.final_units, 'finalCredits', r.final_credits,
    'lots', (SELECT coalesce(jsonb_agg(jsonb_build_object('lotId', x.lot_id, 'reservedCredits', x.credits)
        ORDER BY hon.saas_creative_lot_rank(l.lot_kind), l.expires_at NULLS LAST, l.granted_at, l.id), '[]'::jsonb)
      FROM hon.saas_creative_ledger x JOIN hon.saas_creative_lots l ON l.id = x.lot_id WHERE x.reservation_id = r.id AND x.entry_kind = 'RESERVE'),
    'reservedAt', hon.saas_ts(r.reserved_at), 'settledAt', hon.saas_ts(r.settled_at))
  || CASE WHEN p_internal THEN jsonb_build_object('providerId', r.provider_id, 'modelCode', r.model_code,
      'providerCostMicrounits', r.provider_cost_microunits, 'usageId', r.usage_id, 'resolutionReference', r.resolution_reference) ELSE '{}'::jsonb END
$$;

CREATE FUNCTION hon.saas_creative_rates_json(p_internal boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN v.id IS NULL THEN NULL ELSE jsonb_build_object('rateVersionId', v.id, 'rateVersion', v.rate_version, 'termsReference', v.terms_reference,
    'publishedAt', hon.saas_ts(v.published_at),
    'rates', (SELECT jsonb_agg(jsonb_build_object('operationCode', r.operation_code, 'mediaKind', r.media_kind, 'displayName', r.display_name,
        'billingUnit', r.billing_unit, 'creditsPerUnit', r.credits_per_unit, 'maxUnitsPerRequest', r.max_units_per_request, 'rateBasis', r.rate_basis)
        || CASE WHEN p_internal THEN jsonb_build_object('costEvidenceId', r.cost_evidence_id) ELSE '{}'::jsonb END ORDER BY r.operation_code)
      FROM hon.saas_creative_rates r WHERE r.rate_version_id = v.id)) END
  FROM (SELECT NULL::uuid) dummy LEFT JOIN hon.saas_creative_rate_versions v ON v.status = 'PUBLISHED'
$$;

CREATE FUNCTION hon.saas_creative_packages_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_agg(jsonb_build_object('packageCode', p.package_code, 'packageVersion', p.package_version, 'baseCredits', p.base_credits,
      'bonusCredits', p.bonus_credits, 'totalCredits', p.base_credits + p.bonus_credits, 'priceMinor', p.price_minor, 'currency', p.currency)
    ORDER BY p.price_minor)
  FROM hon.saas_creative_topup_packages p
  WHERE p.package_version = (SELECT max(q.package_version) FROM hon.saas_creative_topup_packages q WHERE q.package_code = p.package_code)
$$;

CREATE FUNCTION hon.saas_creative_purchase_json(p hon.saas_creative_topup_purchases, p_internal boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('purchaseId', p.id, 'schoolId', p.school_id, 'packageCode', p.package_code, 'packageVersion', p.package_version,
    'baseCredits', p.base_credits, 'bonusCredits', p.bonus_credits, 'priceMinor', p.price_minor, 'currency', p.currency,
    'status', p.status, 'statusReason', p.status_reason, 'version', p.version,
    'lotId', (SELECT l.id FROM hon.saas_creative_lots l WHERE l.purchase_id = p.id),
    'payment', 'NOT_CONNECTED', 'createdAt', hon.saas_ts(p.created_at), 'fulfilledAt', hon.saas_ts(p.fulfilled_at))
  || CASE WHEN p_internal THEN jsonb_build_object('paymentProvider', p.payment_provider, 'providerPaymentRef', p.provider_payment_ref,
      'paidAmountMinor', p.paid_amount_minor, 'paidCurrency', p.paid_currency) ELSE '{}'::jsonb END
$$;

-- Records actual provider usage in the shared AI usage ledger with customer_credits = 0: creative
-- credits never count against the internal agent ceiling, and provider cost stays separate.
CREATE FUNCTION hon.saas_creative_record_usage(r hon.saas_creative_reservations, p_actor uuid, p_cost bigint, p_units integer) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE uid uuid;
BEGIN
  INSERT INTO hon.ai_usage_ledger(organization_id, school_id, initiator_principal_id, provider_code, model_code, modality,
      input_units, output_units, provider_cost_microunits, customer_credits, correlation_id)
    VALUES (r.organization_id, r.school_id, p_actor, r.provider_id, r.model_code, r.media_kind::hon.ai_modality, 0, p_units, p_cost, 0, r.id)
    RETURNING id INTO uid;
  RETURN uid;
END $$;

-- Moves a reservation's held credits: FINALIZE p_final credits in consumption order, RELEASE the rest to
-- the same lots. A release into an included lot whose window has ended expires immediately (no rollover).
CREATE FUNCTION hon.saas_creative_settle_lots(r hon.saas_creative_reservations, p_final integer, p_actor uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE x record; take integer; rest integer; left_to_finalize integer := p_final;
BEGIN
  FOR x IN SELECT e.lot_id, e.credits, l.expires_at FROM hon.saas_creative_ledger e JOIN hon.saas_creative_lots l ON l.id = e.lot_id
      WHERE e.reservation_id = r.id AND e.entry_kind = 'RESERVE'
      ORDER BY hon.saas_creative_lot_rank(l.lot_kind), l.expires_at NULLS LAST, l.granted_at, l.id LOOP
    take := least(x.credits, left_to_finalize); rest := x.credits - take; left_to_finalize := left_to_finalize - take;
    IF take > 0 THEN
      INSERT INTO hon.saas_creative_ledger(organization_id, lot_id, entry_kind, credits, reservation_id, actor_principal_id, occurred_at)
        VALUES (r.organization_id, x.lot_id, 'FINALIZE', take, r.id, p_actor, p_at);
    END IF;
    IF rest > 0 THEN
      INSERT INTO hon.saas_creative_ledger(organization_id, lot_id, entry_kind, credits, reservation_id, actor_principal_id, occurred_at)
        VALUES (r.organization_id, x.lot_id, 'RELEASE', rest, r.id, p_actor, p_at);
      IF x.expires_at IS NOT NULL AND x.expires_at <= p_at THEN
        INSERT INTO hon.saas_creative_ledger(organization_id, lot_id, entry_kind, credits, reservation_id, actor_principal_id, occurred_at)
          VALUES (r.organization_id, x.lot_id, 'EXPIRE', rest, r.id, p_actor, p_at);
      END IF;
    END IF;
  END LOOP;
  IF left_to_finalize <> 0 THEN RAISE EXCEPTION 'SAAS_CREATIVE_LEDGER_MISMATCH' USING ERRCODE = '23514'; END IF;
END $$;

CREATE FUNCTION hon.saas_creative_wallet_json(p_org uuid, p_internal boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE at timestamptz := clock_timestamp(); lots jsonb; history jsonb; reservations jsonb; adjustments jsonb; purchases jsonb; costs jsonb; w hon.saas_creative_wallets%ROWTYPE;
BEGIN
  SELECT * INTO w FROM hon.saas_creative_wallets WHERE organization_id = p_org;
  SELECT coalesce(jsonb_agg(hon.saas_creative_lot_json(l, at) ORDER BY hon.saas_creative_lot_rank(l.lot_kind), l.expires_at NULLS LAST, l.granted_at, l.id), '[]'::jsonb)
    INTO lots FROM hon.saas_creative_lots l WHERE l.organization_id = p_org;
  SELECT coalesce(jsonb_agg(jsonb_build_object('entryId', e.id, 'lotId', e.lot_id, 'lotKind', l.lot_kind, 'entryKind', e.entry_kind, 'credits', e.credits,
      'reservationId', e.reservation_id, 'adjustmentId', e.adjustment_id, 'occurredAt', hon.saas_ts(e.occurred_at)) ORDER BY e.occurred_at DESC, e.id), '[]'::jsonb)
    INTO history FROM (SELECT * FROM hon.saas_creative_ledger WHERE organization_id = p_org ORDER BY occurred_at DESC, id LIMIT 100) e
    JOIN hon.saas_creative_lots l ON l.id = e.lot_id;
  SELECT coalesce(jsonb_agg(hon.saas_creative_reservation_json(r, p_internal) ORDER BY r.reserved_at DESC, r.id), '[]'::jsonb)
    INTO reservations FROM (SELECT * FROM hon.saas_creative_reservations WHERE organization_id = p_org ORDER BY reserved_at DESC, id LIMIT 50) r;
  SELECT coalesce(jsonb_agg(jsonb_build_object('adjustmentId', a.id, 'kind', a.adjustment_kind, 'credits', a.credits, 'lotId', a.lot_id,
      'reasonCode', a.reason_code, 'occurredAt', hon.saas_ts(a.occurred_at))
      || CASE WHEN p_internal THEN jsonb_build_object('note', a.note, 'actorPrincipalId', a.actor_principal_id) ELSE '{}'::jsonb END ORDER BY a.occurred_at DESC, a.id), '[]'::jsonb)
    INTO adjustments FROM (SELECT * FROM hon.saas_creative_adjustments WHERE organization_id = p_org ORDER BY occurred_at DESC, id LIMIT 50) a;
  SELECT coalesce(jsonb_agg(hon.saas_creative_purchase_json(p, p_internal) ORDER BY p.created_at DESC, p.id), '[]'::jsonb)
    INTO purchases FROM (SELECT * FROM hon.saas_creative_topup_purchases WHERE organization_id = p_org ORDER BY created_at DESC, id LIMIT 50) p;
  IF p_internal THEN
    SELECT jsonb_build_object(
      'actualProviderCostMicrounits', coalesce(sum(provider_cost_microunits), 0),
      'finalizedProviderCostMicrounits', coalesce(sum(provider_cost_microunits) FILTER (WHERE status = 'FINALIZED'), 0),
      'failedOrNotChargedProviderCostMicrounits', coalesce(sum(provider_cost_microunits) FILTER (WHERE status = 'RELEASED'), 0),
      'consumedCredits', coalesce(sum(final_credits) FILTER (WHERE status = 'FINALIZED'), 0),
      'generations', jsonb_build_object('finalized', count(*) FILTER (WHERE status = 'FINALIZED'), 'released', count(*) FILTER (WHERE status = 'RELEASED'),
        'reserved', count(*) FILTER (WHERE status = 'RESERVED'), 'outcomeUnknown', count(*) FILTER (WHERE status = 'OUTCOME_UNKNOWN')))
      INTO costs FROM hon.saas_creative_reservations WHERE organization_id = p_org;
  END IF;
  RETURN jsonb_build_object('organizationId', p_org, 'walletVersion', w.version,
    'program', jsonb_build_object('status', (SELECT status FROM hon.saas_creative_program WHERE program_id = 1),
      'monthlyIncludedCredits', (SELECT monthly_included_credits FROM hon.saas_creative_program WHERE program_id = 1)),
    'eligibility', hon.saas_creative_eligibility(p_org, at) - 'subscriptionId',
    'balance', hon.saas_creative_balance_json(p_org, at), 'lots', lots, 'history', history, 'reservations', reservations,
    'adjustments', adjustments, 'purchases', purchases, 'rates', hon.saas_creative_rates_json(p_internal), 'packages', hon.saas_creative_packages_json(),
    'agentConversationsDeductCredits', false, 'paymentsActive', false)
    || CASE WHEN p_internal THEN jsonb_build_object('providerExpense', costs) ELSE '{}'::jsonb END;
END $$;

-- ---------- HQ owner commands ----------
CREATE FUNCTION hon.set_saas_creative_program(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_creative_program%ROWTYPE; at timestamptz; snapshot jsonb;
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
  replay := hon.saas_claim_request(actor, p_key, 'saas.creative.program', hon.saas_fingerprint(ARRAY['saas.creative.program', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO prior FROM hon.saas_creative_program WHERE program_id = 1 FOR UPDATE;
  IF prior.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF (p->>'action' = 'ACTIVATE') = (prior.status = 'ACTIVE') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF p->>'action' = 'ACTIVATE' AND NOT EXISTS (SELECT 1 FROM hon.saas_creative_rate_versions WHERE status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'SAAS_CREATIVE_RATES_NOT_PUBLISHED' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  UPDATE hon.saas_creative_program SET status = CASE WHEN p->>'action' = 'ACTIVATE' THEN 'ACTIVE' ELSE 'INACTIVE' END, version = version + 1,
      authorization_reference = p->>'authorizationReference', changed_by_principal_id = actor, changed_at = at WHERE program_id = 1;
  snapshot := (SELECT jsonb_build_object('status', status, 'version', version, 'monthlyIncludedCredits', monthly_included_credits,
    'authorizationReference', authorization_reference, 'changedAt', hon.saas_ts(changed_at)) FROM hon.saas_creative_program WHERE program_id = 1);
  RETURN hon.saas_record(actor, p_key, 'saas.creative.program', 'saas.creative.program_changed', 'CREATIVE_PROGRAM',
    '00000000-0000-4000-8000-0000000000c1'::uuid, NULL, jsonb_build_object('status', prior.status, 'version', prior.version), snapshot,
    jsonb_build_object('program', snapshot), at);
END $$;

-- Publishes a complete rate card (image/video generation prices) and retires the previous one. Rates are
-- PROVISIONAL unless each cites HQ-owner-verified provider cost evidence in the same unit.
CREATE FUNCTION hon.publish_saas_creative_rates(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; item jsonb; created hon.saas_creative_rate_versions%ROWTYPE; prior uuid; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['rates','termsReference']
    OR coalesce(jsonb_typeof(p->'termsReference'), '') <> 'string' OR length(p->>'termsReference') NOT BETWEEN 1 AND 500 OR btrim(p->>'termsReference') <> p->>'termsReference'
    OR coalesce(jsonb_typeof(p->'rates'), '') <> 'array' OR jsonb_array_length(p->'rates') NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'rates') LOOP
    IF jsonb_typeof(item) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k) IS DISTINCT FROM
        ARRAY['billingUnit','costEvidenceId','creditsPerUnit','displayName','maxUnitsPerRequest','mediaKind','operationCode']
      OR coalesce(jsonb_typeof(item->'operationCode'), '') <> 'string' OR (item->>'operationCode') !~ '^[a-z][a-z0-9_.]{2,59}$'
      OR coalesce(item->>'mediaKind', '') NOT IN ('IMAGE','VIDEO') OR coalesce(item->>'billingUnit', '') NOT IN ('IMAGE','VIDEO_SECOND','REQUEST')
      OR coalesce(jsonb_typeof(item->'displayName'), '') <> 'string' OR length(item->>'displayName') NOT BETWEEN 1 AND 120 OR btrim(item->>'displayName') <> item->>'displayName'
      OR coalesce(jsonb_typeof(item->'creditsPerUnit'), '') <> 'number' OR (item->>'creditsPerUnit') !~ '^[1-9][0-9]{0,6}$' OR (item->>'creditsPerUnit')::integer > 1000000
      OR coalesce(jsonb_typeof(item->'maxUnitsPerRequest'), '') <> 'number' OR (item->>'maxUnitsPerRequest') !~ '^[1-9][0-9]{0,3}$' OR (item->>'maxUnitsPerRequest')::integer > 1000
      OR coalesce(jsonb_typeof(item->'costEvidenceId'), '') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'operationCode') FROM jsonb_array_elements(p->'rates')) <> jsonb_array_length(p->'rates') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.creative.rates', hon.saas_fingerprint(ARRAY['saas.creative.rates', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->'rates') x LEFT JOIN hon.saas_provider_cost_evidence e ON e.id = (x->>'costEvidenceId')::uuid
      WHERE jsonb_typeof(x->'costEvidenceId') = 'string' AND (e.id IS NULL OR e.cost_unit <> x->>'billingUnit')) THEN
    RAISE EXCEPTION 'SAAS_PRICING_COST_EVIDENCE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->'rates') x WHERE x->>'mediaKind' = 'IMAGE' AND x->>'billingUnit' = 'VIDEO_SECOND') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  LOCK TABLE hon.saas_creative_rate_versions IN SHARE ROW EXCLUSIVE MODE;
  at := clock_timestamp();
  SELECT id INTO prior FROM hon.saas_creative_rate_versions WHERE status = 'PUBLISHED' FOR UPDATE;
  IF prior IS NOT NULL THEN UPDATE hon.saas_creative_rate_versions SET status = 'RETIRED', retired_at = at WHERE id = prior; END IF;
  INSERT INTO hon.saas_creative_rate_versions(rate_version, status, terms_reference, published_by_principal_id, published_at)
    VALUES ((SELECT coalesce(max(rate_version), 0) + 1 FROM hon.saas_creative_rate_versions), 'PUBLISHED', p->>'termsReference', actor, at)
    RETURNING * INTO created;
  INSERT INTO hon.saas_creative_rates(rate_version_id, operation_code, media_kind, display_name, billing_unit, credits_per_unit, max_units_per_request, rate_basis, cost_evidence_id)
    SELECT created.id, x->>'operationCode', x->>'mediaKind', x->>'displayName', x->>'billingUnit', (x->>'creditsPerUnit')::integer,
      (x->>'maxUnitsPerRequest')::integer, CASE WHEN jsonb_typeof(x->'costEvidenceId') = 'string' THEN 'VERIFIED_COST' ELSE 'PROVISIONAL' END,
      CASE WHEN jsonb_typeof(x->'costEvidenceId') = 'string' THEN (x->>'costEvidenceId')::uuid END
    FROM jsonb_array_elements(p->'rates') x;
  snapshot := hon.saas_creative_rates_json(true);
  RETURN hon.saas_record(actor, p_key, 'saas.creative.rates', 'saas.creative.rates_published', 'CREATIVE_RATES', created.id, NULL,
    CASE WHEN prior IS NULL THEN NULL ELSE jsonb_build_object('retiredRateVersionId', prior) END, snapshot,
    jsonb_build_object('rates', snapshot, 'retiredRateVersionId', prior), at);
END $$;

-- HQ owner grant (promotional or adjustment): any amount (no preset cap; owner policy), reason required.
-- Adds credits only: spending still requires paid access (AI-D1), so a grant never bypasses access control.
CREATE FUNCTION hon.grant_saas_creative_credits_from_hq(p_subject text, p_org uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; adj uuid := gen_random_uuid(); new_lot uuid := gen_random_uuid(); lot hon.saas_creative_lots%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p_org IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['credits','kind','note','reasonCode']
    OR coalesce(p->>'kind', '') NOT IN ('PROMOTIONAL','ADJUSTMENT')
    OR coalesce(jsonb_typeof(p->'credits'), '') <> 'number' OR (p->>'credits') !~ '^[1-9][0-9]{0,9}$' OR (p->>'credits')::bigint > 1000000000
    OR coalesce(p->>'reasonCode', '') NOT IN ('PROMOTION','GOODWILL','SERVICE_RECOVERY','BILLING_CORRECTION','OTHER')
    OR coalesce(jsonb_typeof(p->'note'), '') <> 'string' OR length(p->>'note') NOT BETWEEN 1 AND 500 OR btrim(p->>'note') <> p->>'note' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.creative.grant', hon.saas_fingerprint(ARRAY['saas.creative.grant', p_org::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = p_org) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  at := clock_timestamp();
  PERFORM hon.saas_creative_lock_wallet(p_org, at);
  -- The adjustment cites its lot (deferred FK) and the lot cites the adjustment: insert the adjustment first.
  INSERT INTO hon.saas_creative_adjustments(id, organization_id, adjustment_kind, credits, lot_id, reason_code, note, actor_principal_id, occurred_at)
    VALUES (adj, p_org, CASE p->>'kind' WHEN 'PROMOTIONAL' THEN 'PROMOTIONAL_GRANT' ELSE 'ADJUSTMENT_GRANT' END, (p->>'credits')::integer, new_lot, p->>'reasonCode', p->>'note', actor, at);
  INSERT INTO hon.saas_creative_lots(id, organization_id, lot_kind, credits, adjustment_id, granted_by_principal_id, granted_at)
    VALUES (new_lot, p_org, p->>'kind', (p->>'credits')::integer, adj, actor, at) RETURNING * INTO lot;
  INSERT INTO hon.saas_creative_ledger(organization_id, lot_id, entry_kind, credits, adjustment_id, actor_principal_id, occurred_at)
    VALUES (p_org, lot.id, 'GRANT', lot.credits, adj, actor, at);
  PERFORM hon.saas_creative_touch_wallet(p_org, at);
  snapshot := jsonb_build_object('adjustmentId', adj, 'lot', hon.saas_creative_lot_json(lot, at), 'reasonCode', p->>'reasonCode', 'note', p->>'note');
  RETURN hon.saas_record(actor, p_key, 'saas.creative.grant', 'saas.creative.granted', 'CREATIVE_ADJUSTMENT', adj, p_org, NULL, snapshot,
    jsonb_build_object('adjustment', snapshot, 'balance', hon.saas_creative_balance_json(p_org, at)), at);
END $$;

-- HQ owner correction: debits unused credits from one named included, promotional or adjustment lot.
-- Purchased credits are never debited here (refund/chargeback handling is undecided, CW-D4).
CREATE FUNCTION hon.debit_saas_creative_lot_from_hq(p_subject text, p_lot uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; adj uuid := gen_random_uuid(); lot hon.saas_creative_lots%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p_lot IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['credits','note','reasonCode']
    OR coalesce(jsonb_typeof(p->'credits'), '') <> 'number' OR (p->>'credits') !~ '^[1-9][0-9]{0,9}$' OR (p->>'credits')::bigint > 1000000000
    OR coalesce(p->>'reasonCode', '') NOT IN ('BILLING_CORRECTION','RECORDED_IN_ERROR','OTHER')
    OR coalesce(jsonb_typeof(p->'note'), '') <> 'string' OR length(p->>'note') NOT BETWEEN 1 AND 500 OR btrim(p->>'note') <> p->>'note' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.creative.debit', hon.saas_fingerprint(ARRAY['saas.creative.debit', p_lot::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO lot FROM hon.saas_creative_lots WHERE id = p_lot;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF lot.lot_kind = 'PURCHASED_TOPUP' THEN RAISE EXCEPTION 'SAAS_CREATIVE_PURCHASED_LOT_PROTECTED' USING ERRCODE = '23514'; END IF;
  at := clock_timestamp();
  PERFORM hon.saas_creative_lock_wallet(lot.organization_id, at);
  PERFORM hon.saas_creative_expire_lots(lot.organization_id, actor, at);
  IF (p->>'credits')::integer > hon.saas_creative_lot_available(lot, at) THEN RAISE EXCEPTION 'SAAS_CREATIVE_DEBIT_EXCEEDS_AVAILABLE' USING ERRCODE = '23514'; END IF;
  INSERT INTO hon.saas_creative_adjustments(id, organization_id, adjustment_kind, credits, lot_id, reason_code, note, actor_principal_id, occurred_at)
    VALUES (adj, lot.organization_id, 'CORRECTION_DEBIT', (p->>'credits')::integer, lot.id, p->>'reasonCode', p->>'note', actor, at);
  INSERT INTO hon.saas_creative_ledger(organization_id, lot_id, entry_kind, credits, adjustment_id, actor_principal_id, occurred_at)
    VALUES (lot.organization_id, lot.id, 'DEBIT', (p->>'credits')::integer, adj, actor, at);
  PERFORM hon.saas_creative_touch_wallet(lot.organization_id, at);
  snapshot := jsonb_build_object('adjustmentId', adj, 'lot', hon.saas_creative_lot_json(lot, at), 'credits', (p->>'credits')::integer,
    'reasonCode', p->>'reasonCode', 'note', p->>'note');
  RETURN hon.saas_record(actor, p_key, 'saas.creative.debit', 'saas.creative.debited', 'CREATIVE_ADJUSTMENT', adj, lot.organization_id, NULL, snapshot,
    jsonb_build_object('adjustment', snapshot, 'balance', hon.saas_creative_balance_json(lot.organization_id, at)), at);
END $$;

-- HQ owner resolves an OUTCOME_UNKNOWN generation with provider evidence (AI-D3): SUCCEEDED finalizes the
-- evidenced units; NOT_CHARGED releases every held credit. Any evidenced provider cost is recorded either way.
-- A still-RESERVED generation can be resolved the same way, so a requester who lost access mid-flight (the
-- settle path needs the B3 school resolver, as in B3) never leaves credits held forever (AI-14 analogue).
-- The version check means only one of the requester's settle and the HQ resolution can ever apply.
CREATE FUNCTION hon.resolve_saas_creative_reservation_from_hq(p_subject text, p_reservation uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; r hon.saas_creative_reservations%ROWTYPE; updated hon.saas_creative_reservations%ROWTYPE; v_units integer; v_credits integer;
  cost bigint; uid uuid; at timestamptz; snapshot jsonb; keys text[];
BEGIN
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k);
  IF p_reservation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' OR keys IS DISTINCT FROM ARRAY['evidenceReference','expectedVersion','finalUnits','providerCostMicrounits','resolution']
    OR coalesce(jsonb_typeof(p->'expectedVersion'), '') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR coalesce(p->>'resolution', '') NOT IN ('SUCCEEDED','NOT_CHARGED')
    OR coalesce(jsonb_typeof(p->'providerCostMicrounits'), '') <> 'number' OR (p->>'providerCostMicrounits') !~ '^[0-9]{1,15}$'
    OR coalesce(jsonb_typeof(p->'evidenceReference'), '') <> 'string' OR length(p->>'evidenceReference') NOT BETWEEN 1 AND 200 OR btrim(p->>'evidenceReference') <> p->>'evidenceReference'
    OR NOT (CASE p->>'resolution' WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'finalUnits') = 'number' AND (p->>'finalUnits') ~ '^[0-9]{1,6}$'
      ELSE jsonb_typeof(p->'finalUnits') = 'null' END) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.creative.resolve', hon.saas_fingerprint(ARRAY['saas.creative.resolve', p_reservation::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO r FROM hon.saas_creative_reservations WHERE id = p_reservation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  at := clock_timestamp();
  PERFORM hon.saas_creative_lock_wallet(r.organization_id, at);
  SELECT * INTO r FROM hon.saas_creative_reservations WHERE id = p_reservation FOR UPDATE;
  IF r.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF r.status NOT IN ('OUTCOME_UNKNOWN','RESERVED') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  cost := (p->>'providerCostMicrounits')::bigint;
  IF p->>'resolution' = 'SUCCEEDED' THEN
    v_units := (p->>'finalUnits')::integer; v_credits := v_units * r.credits_per_unit;
    IF v_units > r.units THEN RAISE EXCEPTION 'SAAS_FINAL_EXCEEDS_RESERVATION' USING ERRCODE = '23514'; END IF;
    uid := hon.saas_creative_record_usage(r, actor, cost, v_units);
    PERFORM hon.saas_creative_settle_lots(r, v_credits, actor, at);
    UPDATE hon.saas_creative_reservations SET status = 'FINALIZED', status_reason = 'HQ_RESOLVED_SUCCEEDED', version = version + 1, final_units = v_units,
        final_credits = v_credits, provider_cost_microunits = cost, usage_id = uid, resolution_reference = p->>'evidenceReference', settled_at = at,
        settled_by_principal_id = actor WHERE id = r.id RETURNING * INTO updated;
  ELSE
    IF cost > 0 THEN uid := hon.saas_creative_record_usage(r, actor, cost, 0); END IF;
    PERFORM hon.saas_creative_settle_lots(r, 0, actor, at);
    UPDATE hon.saas_creative_reservations SET status = 'RELEASED', status_reason = 'HQ_RESOLVED_NOT_CHARGED', version = version + 1,
        provider_cost_microunits = cost, usage_id = uid, resolution_reference = p->>'evidenceReference', settled_at = at, settled_by_principal_id = actor
      WHERE id = r.id RETURNING * INTO updated;
  END IF;
  PERFORM hon.saas_creative_touch_wallet(r.organization_id, at);
  snapshot := hon.saas_creative_reservation_json(updated, true);
  RETURN hon.saas_record(actor, p_key, 'saas.creative.resolve', 'saas.creative.resolved', 'CREATIVE_RESERVATION', r.id, r.organization_id,
    hon.saas_creative_reservation_json(r, true), snapshot, jsonb_build_object('reservation', snapshot), at);
END $$;

-- ---------- HQ reads ----------
CREATE FUNCTION hon.read_saas_creative_wallet_from_hq(p_subject text, p_org uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = p_org) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  RETURN hon.saas_creative_wallet_json(p_org, true);
END $$;

CREATE FUNCTION hon.read_saas_creative_wallets_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE at timestamptz := clock_timestamp(); rows jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT coalesce(jsonb_agg(jsonb_build_object('organizationId', w.organization_id,
      'organizationName', (SELECT o.display_name FROM hon.organizations o WHERE o.id = w.organization_id),
      'availableCredits', (hon.saas_creative_balance_json(w.organization_id, at)->>'availableCredits')::bigint,
      'heldCredits', (hon.saas_creative_balance_json(w.organization_id, at)->>'heldCredits')::bigint,
      'consumedCredits', (SELECT coalesce(sum(final_credits), 0) FROM hon.saas_creative_reservations r WHERE r.organization_id = w.organization_id AND r.status = 'FINALIZED'),
      'actualProviderCostMicrounits', (SELECT coalesce(sum(provider_cost_microunits), 0) FROM hon.saas_creative_reservations r WHERE r.organization_id = w.organization_id),
      'outcomeUnknown', (SELECT count(*) FROM hon.saas_creative_reservations r WHERE r.organization_id = w.organization_id AND r.status = 'OUTCOME_UNKNOWN'),
      'updatedAt', hon.saas_ts(w.updated_at)) ORDER BY w.updated_at DESC, w.organization_id), '[]'::jsonb)
    INTO rows FROM (SELECT * FROM hon.saas_creative_wallets ORDER BY updated_at DESC, organization_id LIMIT 200) w;
  RETURN jsonb_build_object('program', (SELECT jsonb_build_object('status', status, 'version', version, 'monthlyIncludedCredits', monthly_included_credits)
      FROM hon.saas_creative_program WHERE program_id = 1), 'rates', hon.saas_creative_rates_json(true), 'packages', hon.saas_creative_packages_json(), 'wallets', rows);
END $$;

-- ---------- school reads and commands ----------
-- Exact-school staff with ai.premium.request (B3 resolver): balance by kind, lots, history, rates and packages; never provider cost.
CREATE FUNCTION hon.read_saas_creative_wallet(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; w jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  w := hon.saas_creative_wallet_json(scope.organization_id, false);
  RETURN (w - 'organizationId' - 'reservations') || jsonb_build_object('schoolId', p_school,
    'reservations', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'reservedAt' DESC, x->>'reservationId'), '[]'::jsonb) FROM jsonb_array_elements(w->'reservations') x
      WHERE (x->>'schoolId')::uuid = p_school));
END $$;

-- Opens the current included window if the school is eligible (idempotent: one grant per window).
CREATE FUNCTION hon.open_saas_creative_window(p_subject text, p_school uuid, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; replay jsonb; v_lot uuid; e jsonb; at timestamptz; snapshot jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.roles, hon.role_permissions, hon.permissions,
    hon.family_access_grants, hon.hq_operator_grants, hon.organization_entitlements IN SHARE MODE;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  replay := hon.saas_claim_request(scope.principal_id, p_key, 'saas.creative.window', hon.saas_fingerprint(ARRAY['saas.creative.window', p_school::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  PERFORM hon.saas_creative_lock_wallet(scope.organization_id, at);
  v_lot := hon.saas_creative_open_window(scope.organization_id, scope.principal_id, at);
  IF v_lot IS NULL THEN
    e := hon.saas_creative_eligibility(scope.organization_id, at);
    RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || (e->>'reason') USING ERRCODE = '23514';
  END IF;
  snapshot := hon.saas_creative_lot_json((SELECT l FROM hon.saas_creative_lots l WHERE l.id = v_lot), at);
  RETURN hon.saas_record(scope.principal_id, p_key, 'saas.creative.window', 'saas.creative.window_opened', 'CREATIVE_LOT', v_lot, scope.organization_id, NULL, snapshot,
    jsonb_build_object('lot', snapshot, 'balance', hon.saas_creative_balance_json(scope.organization_id, at)), at);
END $$;

-- RESERVE before a provider call: the generation runtime acts for the requesting staff member; idempotent
-- per (requester, key). The wallet row lock makes the balance check and the reservation atomic.
CREATE FUNCTION hon.reserve_saas_creative_credits(p_subject text, p_school uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; replay jsonb; e jsonb; rate hon.saas_creative_rates%ROWTYPE; units integer; credits integer; need integer; take integer;
  created hon.saas_creative_reservations%ROWTYPE; l record; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['modelCode','operationCode','providerId','units']
    OR coalesce(jsonb_typeof(p->'operationCode'), '') <> 'string' OR (p->>'operationCode') !~ '^[a-z][a-z0-9_.]{2,59}$'
    OR coalesce(jsonb_typeof(p->'units'), '') <> 'number' OR (p->>'units') !~ '^[1-9][0-9]{0,3}$'
    OR coalesce(jsonb_typeof(p->'providerId'), '') <> 'string' OR coalesce(jsonb_typeof(p->'modelCode'), '') <> 'string'
    OR NOT coalesce(hon.hq_ai_safe_text(p->>'modelCode', true), false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  units := (p->>'units')::integer;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.roles, hon.role_permissions, hon.permissions,
    hon.family_access_grants, hon.hq_operator_grants, hon.organization_entitlements IN SHARE MODE;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  replay := hon.saas_claim_request(scope.principal_id, p_key, 'saas.creative.reserve',
    hon.saas_fingerprint(ARRAY['saas.creative.reserve', p_school::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.hq_ai_provider_connections WHERE provider_id = p->>'providerId') THEN
    RAISE EXCEPTION 'SAAS_PROVIDER_UNKNOWN' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  PERFORM hon.saas_creative_lock_wallet(scope.organization_id, at);
  PERFORM hon.saas_creative_open_window(scope.organization_id, scope.principal_id, at);
  e := hon.saas_creative_eligibility(scope.organization_id, at);
  IF NOT (e->>'eligible')::boolean THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || (e->>'reason') USING ERRCODE = '23514'; END IF;
  SELECT r.* INTO rate FROM hon.saas_creative_rates r JOIN hon.saas_creative_rate_versions v ON v.id = r.rate_version_id
    WHERE v.status = 'PUBLISHED' AND r.operation_code = p->>'operationCode';
  IF rate.operation_code IS NULL THEN RAISE EXCEPTION 'SAAS_OPERATION_NOT_PRICED' USING ERRCODE = '23514'; END IF;
  IF units > rate.max_units_per_request THEN RAISE EXCEPTION 'SAAS_OPERATION_UNITS_EXCEEDED' USING ERRCODE = '23514'; END IF;
  credits := rate.credits_per_unit * units;
  IF credits > (SELECT coalesce(sum(hon.saas_creative_lot_available(x, at)), 0) FROM hon.saas_creative_lots x WHERE x.organization_id = scope.organization_id) THEN
    RAISE EXCEPTION 'SAAS_CREDITS_EXHAUSTED' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.saas_creative_reservations(organization_id, school_id, rate_version_id, operation_code, media_kind, rate_basis, credits_per_unit, units,
      reserved_credits, status, status_reason, version, requested_by_principal_id, provider_id, model_code, reserved_at)
    VALUES (scope.organization_id, p_school, rate.rate_version_id, rate.operation_code, rate.media_kind, rate.rate_basis, rate.credits_per_unit, units,
      credits, 'RESERVED', 'RESERVED', 1, scope.principal_id, p->>'providerId', p->>'modelCode', at)
    RETURNING * INTO created;
  need := credits;
  FOR l IN SELECT x.*, hon.saas_creative_lot_available(x, at) avail FROM hon.saas_creative_lots x WHERE x.organization_id = scope.organization_id
      ORDER BY hon.saas_creative_lot_rank(x.lot_kind), x.expires_at NULLS LAST, x.granted_at, x.id LOOP
    EXIT WHEN need = 0;
    CONTINUE WHEN l.avail <= 0;
    take := least(l.avail, need); need := need - take;
    INSERT INTO hon.saas_creative_ledger(organization_id, lot_id, entry_kind, credits, reservation_id, actor_principal_id, occurred_at)
      VALUES (scope.organization_id, l.id, 'RESERVE', take, created.id, scope.principal_id, at);
  END LOOP;
  IF need <> 0 THEN RAISE EXCEPTION 'SAAS_CREDITS_EXHAUSTED' USING ERRCODE = '23514'; END IF;
  PERFORM hon.saas_creative_touch_wallet(scope.organization_id, at);
  snapshot := hon.saas_creative_reservation_json(created, false);
  RETURN hon.saas_record(scope.principal_id, p_key, 'saas.creative.reserve', 'saas.creative.reserved', 'CREATIVE_RESERVATION', created.id,
    scope.organization_id, NULL, snapshot, jsonb_build_object('reservation', snapshot, 'balance', hon.saas_creative_balance_json(scope.organization_id, at)), at);
END $$;

-- SETTLE by the requester after the provider call. SUCCEEDED finalizes actual credits (never above the
-- reservation) and releases the rest; FAILED releases everything; UNKNOWN keeps credits held for HQ
-- resolution. Settling never needs live paid access: an in-flight cost is always recorded.
CREATE FUNCTION hon.settle_saas_creative_credits(p_subject text, p_reservation uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; replay jsonb; r hon.saas_creative_reservations%ROWTYPE; updated hon.saas_creative_reservations%ROWTYPE; outcome text; keys text[];
  v_units integer; v_credits integer; cost bigint; uid uuid; at timestamptz; snapshot jsonb;
BEGIN
  IF p_reservation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k); outcome := p->>'outcome';
  IF NOT coalesce(keys = ARRAY['expectedVersion','finalUnits','outcome','providerCostMicrounits']
      AND jsonb_typeof(p->'expectedVersion') = 'number' AND (p->>'expectedVersion') ~ '^[1-9][0-9]{0,8}$'
      AND outcome IN ('SUCCEEDED','FAILED','UNKNOWN')
      AND (jsonb_typeof(p->'finalUnits') = 'null' OR (jsonb_typeof(p->'finalUnits') = 'number' AND (p->>'finalUnits') ~ '^[0-9]{1,4}$'))
      AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'))
      AND CASE outcome WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'finalUnits') = 'number' AND jsonb_typeof(p->'providerCostMicrounits') = 'number'
        WHEN 'FAILED' THEN jsonb_typeof(p->'finalUnits') = 'null'
        ELSE jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null' END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM hon.saas_creative_reservations WHERE id = p_reservation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, r.school_id) LIMIT 1;
  IF scope.principal_id <> r.requested_by_principal_id THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  replay := hon.saas_claim_request(scope.principal_id, p_key, 'saas.creative.settle',
    hon.saas_fingerprint(ARRAY['saas.creative.settle', p_reservation::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  PERFORM hon.saas_creative_lock_wallet(r.organization_id, at);
  SELECT * INTO r FROM hon.saas_creative_reservations WHERE id = p_reservation FOR UPDATE;
  IF r.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF r.status <> 'RESERVED' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  cost := (p->>'providerCostMicrounits')::bigint;
  IF outcome = 'SUCCEEDED' THEN
    v_units := (p->>'finalUnits')::integer; v_credits := v_units * r.credits_per_unit;
    IF v_units > r.units THEN RAISE EXCEPTION 'SAAS_FINAL_EXCEEDS_RESERVATION' USING ERRCODE = '23514'; END IF;
    uid := hon.saas_creative_record_usage(r, scope.principal_id, cost, v_units);
    PERFORM hon.saas_creative_settle_lots(r, v_credits, scope.principal_id, at);
    UPDATE hon.saas_creative_reservations SET status = 'FINALIZED', status_reason = 'PROVIDER_SUCCEEDED', version = version + 1, final_units = v_units,
        final_credits = v_credits, provider_cost_microunits = cost, usage_id = uid, settled_at = at, settled_by_principal_id = scope.principal_id
      WHERE id = r.id RETURNING * INTO updated;
  ELSIF outcome = 'FAILED' THEN
    IF coalesce(cost, 0) > 0 THEN uid := hon.saas_creative_record_usage(r, scope.principal_id, cost, 0); END IF;
    PERFORM hon.saas_creative_settle_lots(r, 0, scope.principal_id, at);
    UPDATE hon.saas_creative_reservations SET status = 'RELEASED', status_reason = 'PROVIDER_FAILED', version = version + 1,
        provider_cost_microunits = cost, usage_id = uid, settled_at = at, settled_by_principal_id = scope.principal_id
      WHERE id = r.id RETURNING * INTO updated;
  ELSE
    UPDATE hon.saas_creative_reservations SET status = 'OUTCOME_UNKNOWN', status_reason = 'PROVIDER_OUTCOME_UNKNOWN', version = version + 1
      WHERE id = r.id RETURNING * INTO updated;
  END IF;
  PERFORM hon.saas_creative_touch_wallet(r.organization_id, at);
  snapshot := hon.saas_creative_reservation_json(updated, false);
  RETURN hon.saas_record(scope.principal_id, p_key, 'saas.creative.settle', 'saas.creative.settled', 'CREATIVE_RESERVATION', r.id, r.organization_id,
    hon.saas_creative_reservation_json(r, false), snapshot, jsonb_build_object('reservation', snapshot, 'balance', hon.saas_creative_balance_json(r.organization_id, at)), at);
END $$;

-- Top-up purchase intent by a school purchaser (billing.hon.purchase at the exact school) of a paid HON OS
-- school. Records the package and price; nothing is charged and no checkout is created here.
CREATE FUNCTION hon.create_saas_creative_topup_purchase(p_subject text, p_school uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; replay jsonb; pkg hon.saas_creative_topup_packages%ROWTYPE; e jsonb; created hon.saas_creative_topup_purchases%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['packageCode']
    OR coalesce(p->>'packageCode', '') NOT IN ('STARTER','GROWTH','CREATOR') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO scope FROM hon.require_saas_school_purchaser(p_subject, p_school) LIMIT 1;
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.roles, hon.role_permissions, hon.permissions,
    hon.family_access_grants, hon.hq_operator_grants, hon.organization_entitlements IN SHARE MODE;
  SELECT * INTO scope FROM hon.require_saas_school_purchaser(p_subject, p_school) LIMIT 1;
  replay := hon.saas_claim_request(scope.principal_id, p_key, 'saas.creative.purchase',
    hon.saas_fingerprint(ARRAY['saas.creative.purchase', p_school::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  PERFORM hon.saas_creative_lock_wallet(scope.organization_id, at);
  e := hon.saas_creative_eligibility(scope.organization_id, at);
  IF NOT (e->>'eligible')::boolean THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || (e->>'reason') USING ERRCODE = '23514'; END IF;
  SELECT * INTO pkg FROM hon.saas_creative_topup_packages WHERE package_code = p->>'packageCode' ORDER BY package_version DESC LIMIT 1;
  INSERT INTO hon.saas_creative_topup_purchases(organization_id, school_id, package_code, package_version, base_credits, bonus_credits, price_minor, currency,
      status, status_reason, version, requested_by_principal_id, created_at, updated_at)
    VALUES (scope.organization_id, p_school, pkg.package_code, pkg.package_version, pkg.base_credits, pkg.bonus_credits, pkg.price_minor, pkg.currency,
      'PENDING_PAYMENT', 'AWAITING_VERIFIED_PAYMENT', 1, scope.principal_id, at, at)
    RETURNING * INTO created;
  snapshot := hon.saas_creative_purchase_json(created, false);
  RETURN hon.saas_record(scope.principal_id, p_key, 'saas.creative.purchase', 'saas.creative.purchase_created', 'CREATIVE_PURCHASE', created.id,
    scope.organization_id, NULL, snapshot, jsonb_build_object('purchase', snapshot), at);
END $$;

-- INTERNAL fulfillment contract for a provider-verified top-up payment. Not executable by the runtime and
-- not wired to webhook ingestion in this migration: wiring it is a separate, owner-approved payments step.
-- Requires the B5 payment program in TEST_MODE with the same provider and refuses live mode. An exact
-- amount/currency match creates one PURCHASED_TOPUP lot (base and bonus recorded separately); a mismatch
-- holds the purchase for review without credits; a replay of the same payment returns the same lot; a
-- second, different payment for an already-settled purchase never grants again.
CREATE FUNCTION hon.saas_fulfill_creative_topup(p_purchase uuid, p_payment jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := hon.saas_payment_actor(); prog hon.saas_payment_program%ROWTYPE; replay jsonb; pur hon.saas_creative_topup_purchases%ROWTYPE;
  updated hon.saas_creative_topup_purchases%ROWTYPE; v_key uuid; lot hon.saas_creative_lots%ROWTYPE; reason text; snapshot jsonb;
BEGIN
  IF p_purchase IS NULL OR p_at IS NULL OR p_payment IS NULL OR jsonb_typeof(p_payment) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_payment) k) IS DISTINCT FROM ARRAY['amountMinor','currency','livemode','paymentRef','provider']
    OR coalesce(p_payment->>'provider', '') NOT IN ('STRIPE','STRIPE_SIMULATED') OR jsonb_typeof(p_payment->'livemode') <> 'boolean'
    OR coalesce(p_payment->>'paymentRef', '') !~ '^(pi|cs_test|in)_[A-Za-z0-9_]{1,200}$'
    OR coalesce(jsonb_typeof(p_payment->'amountMinor'), '') <> 'number' OR (p_payment->>'amountMinor') !~ '^[0-9]{1,9}$'
    OR coalesce(jsonb_typeof(p_payment->'currency'), '') <> 'string' OR length(p_payment->>'currency') NOT BETWEEN 3 AND 3 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF (p_payment->>'livemode')::boolean THEN RAISE EXCEPTION 'SAAS_PROVIDER_LIVE_MODE_REFUSED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO prog FROM hon.saas_payment_program WHERE program_id = 1 FOR SHARE;
  IF prog.status <> 'TEST_MODE' OR prog.provider IS DISTINCT FROM p_payment->>'provider' THEN RAISE EXCEPTION 'SAAS_PAYMENTS_NOT_ACTIVE' USING ERRCODE = '42501'; END IF;
  v_key := md5('saas.creative.fulfill:' || (p_payment->>'provider') || ':' || (p_payment->>'paymentRef'))::uuid;
  replay := hon.saas_claim_request(actor, v_key, 'saas.creative.fulfill',
    hon.saas_fingerprint(ARRAY['saas.creative.fulfill', p_purchase::text, p_payment::text]), gen_random_uuid(), gen_random_uuid());
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO pur FROM hon.saas_creative_topup_purchases WHERE id = p_purchase;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM hon.saas_creative_lock_wallet(pur.organization_id, p_at);
  SELECT * INTO pur FROM hon.saas_creative_topup_purchases WHERE id = p_purchase FOR UPDATE;
  IF pur.status <> 'PENDING_PAYMENT' THEN
    -- A different payment for a purchase already fulfilled or held: evidence only, never a second grant.
    snapshot := hon.saas_creative_purchase_json(pur, true) || jsonb_build_object('outcome', 'DUPLICATE_PAYMENT_REVIEW', 'paymentRef', p_payment->>'paymentRef');
    RETURN hon.saas_record(actor, v_key, 'saas.creative.fulfill', 'saas.creative.purchase_fulfilled', 'CREATIVE_PURCHASE', pur.id, pur.organization_id,
      NULL, snapshot, jsonb_build_object('purchase', hon.saas_creative_purchase_json(pur, true), 'outcome', 'DUPLICATE_PAYMENT_REVIEW', 'lotId', NULL), p_at);
  END IF;
  reason := CASE WHEN lower(p_payment->>'currency') <> pur.currency THEN 'CURRENCY_MISMATCH'
    WHEN (p_payment->>'amountMinor')::integer <> pur.price_minor THEN 'AMOUNT_MISMATCH' END;
  IF reason IS NULL THEN
    INSERT INTO hon.saas_creative_lots(organization_id, lot_kind, credits, base_credits, bonus_credits, purchase_id, granted_by_principal_id, granted_at)
      VALUES (pur.organization_id, 'PURCHASED_TOPUP', pur.base_credits + pur.bonus_credits, pur.base_credits, pur.bonus_credits, pur.id, actor, p_at)
      RETURNING * INTO lot;
    INSERT INTO hon.saas_creative_ledger(organization_id, lot_id, entry_kind, credits, actor_principal_id, occurred_at)
      VALUES (pur.organization_id, lot.id, 'GRANT', lot.credits, actor, p_at);
    PERFORM hon.saas_creative_touch_wallet(pur.organization_id, p_at);
  END IF;
  UPDATE hon.saas_creative_topup_purchases SET status = CASE WHEN reason IS NULL THEN 'FULFILLED' ELSE 'NEEDS_REVIEW' END,
      status_reason = coalesce(reason, 'PAYMENT_VERIFIED'), version = version + 1, payment_provider = p_payment->>'provider',
      provider_payment_ref = p_payment->>'paymentRef', paid_amount_minor = (p_payment->>'amountMinor')::integer, paid_currency = lower(p_payment->>'currency'),
      updated_at = p_at, fulfilled_at = CASE WHEN reason IS NULL THEN p_at END
    WHERE id = pur.id RETURNING * INTO updated;
  snapshot := hon.saas_creative_purchase_json(updated, true);
  RETURN hon.saas_record(actor, v_key, 'saas.creative.fulfill', 'saas.creative.purchase_fulfilled', 'CREATIVE_PURCHASE', pur.id, pur.organization_id,
    hon.saas_creative_purchase_json(pur, true), snapshot,
    jsonb_build_object('purchase', snapshot, 'outcome', CASE WHEN reason IS NULL THEN 'FULFILLED' ELSE 'NEEDS_REVIEW' END, 'lotId', lot.id), p_at);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_creative_program','saas_creative_rate_versions','saas_creative_rates','saas_creative_topup_packages','saas_creative_wallets',
    'saas_creative_topup_purchases','saas_creative_adjustments','saas_creative_lots','saas_creative_reservations','saas_creative_ledger'] LOOP
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
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'hon'::regnamespace AND p.proname ~ 'saas_creative|creative_' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_saas_creative_program(text,jsonb,uuid,uuid,uuid), hon.publish_saas_creative_rates(text,jsonb,uuid,uuid,uuid),
      hon.grant_saas_creative_credits_from_hq(text,uuid,jsonb,uuid,uuid,uuid), hon.debit_saas_creative_lot_from_hq(text,uuid,jsonb,uuid,uuid,uuid),
      hon.resolve_saas_creative_reservation_from_hq(text,uuid,jsonb,uuid,uuid,uuid), hon.read_saas_creative_wallet_from_hq(text,uuid),
      hon.read_saas_creative_wallets_from_hq(text), hon.read_saas_creative_wallet(text,uuid), hon.open_saas_creative_window(text,uuid,uuid,uuid,uuid),
      hon.reserve_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.settle_saas_creative_credits(text,uuid,jsonb,uuid,uuid,uuid),
      hon.create_saas_creative_topup_purchase(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
