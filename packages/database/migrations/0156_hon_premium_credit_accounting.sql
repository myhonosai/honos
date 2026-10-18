BEGIN;

-- HON Subscription Billing Milestone B3: premium AI credit allowances and usage accounting.
-- Builds on the B1 catalog and subscriptions, and on the existing AI usage ledger
-- (hon.ai_usage_ledger) and AI provider control plane (hon.hq_ai_provider_connections):
-- - Provider cost is recorded in ai_usage_ledger (customer_credits = 0 for premium rows), so
--   premium credits never count against the ordinary-assistant fair-use caps; credits live only
--   in the append-only premium credit ledger below.
-- - Credits are priced per operation by an HQ-owner-published, versioned pricing model whose
--   every price is linked to HQ-owner-verified provider cost evidence. No default price or cost
--   exists; without published pricing nothing can be reserved.
-- - The credit program ships INACTIVE. Only the HQ owner can activate it, with an authorization
--   reference. Inactive means no allowance is opened and no reservation is made.
-- - No purchase, top-up, overage, charge, provider call or payment collection exists here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON premium credits require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON premium credits require a restricted runtime';
  END IF;
END $$;

INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable)
VALUES ('ai.premium.request','Request premium AI operations that draw on the school''s HON premium credit allowance; never purchases credits',true,true);
INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT id, organization_id, 'ai.premium.request' FROM hon.roles WHERE is_system_role AND code = 'OWNER' ON CONFLICT DO NOTHING;

-- ---------- program activation (singleton) ----------
CREATE TABLE hon.saas_credit_program (
  program_id smallint PRIMARY KEY CHECK (program_id = 1),
  status text NOT NULL CHECK (status IN ('INACTIVE','ACTIVE')),
  version integer NOT NULL CHECK (version > 0),
  authorization_reference text CHECK (length(authorization_reference) BETWEEN 1 AND 200),
  changed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL,
  top_ups_enabled boolean NOT NULL DEFAULT false CHECK (top_ups_enabled = false),
  overage_enabled boolean NOT NULL DEFAULT false CHECK (overage_enabled = false),
  CHECK (status = 'INACTIVE' OR (authorization_reference IS NOT NULL AND changed_by_principal_id IS NOT NULL))
);
INSERT INTO hon.saas_credit_program(program_id, status, version, changed_at) VALUES (1, 'INACTIVE', 1, clock_timestamp());

-- ---------- verified provider cost evidence (append-only) ----------
CREATE TABLE hon.saas_provider_cost_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL REFERENCES hon.hq_ai_provider_connections(provider_id) ON DELETE RESTRICT,
  model_code text NOT NULL CHECK (hon.hq_ai_safe_text(model_code, true)),
  cost_unit text NOT NULL CHECK (cost_unit IN ('IMAGE','VIDEO_SECOND','AUDIO_SECOND','TOKEN_1K','REQUEST','TASK')),
  measured_units bigint NOT NULL CHECK (measured_units BETWEEN 1 AND 1000000000000),
  billed_cost_microunits bigint NOT NULL CHECK (billed_cost_microunits BETWEEN 1 AND 1000000000000000),
  fully_loaded_cost_microunits bigint NOT NULL CHECK (fully_loaded_cost_microunits BETWEEN 1 AND 1000000000000000),
  source text NOT NULL DEFAULT 'HQ_OWNER_VERIFIED_PROVIDER_BILLING' CHECK (source = 'HQ_OWNER_VERIFIED_PROVIDER_BILLING'),
  evidence_reference text NOT NULL CHECK (length(evidence_reference) BETWEEN 1 AND 200),
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
  note text CHECK (length(note) BETWEEN 1 AND 500),
  verified_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  verified_at timestamptz NOT NULL,
  CHECK (fully_loaded_cost_microunits >= billed_cost_microunits),
  CHECK (period_end > period_start AND period_end <= verified_at),
  UNIQUE (provider_id, evidence_reference, model_code, cost_unit)
);

-- ---------- versioned premium operation pricing ----------
CREATE TABLE hon.saas_pricing_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pricing_version integer NOT NULL UNIQUE CHECK (pricing_version > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  terms_reference text CHECK (length(terms_reference) BETWEEN 1 AND 500),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  published_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  published_at timestamptz, retired_at timestamptz,
  CHECK ((status = 'DRAFT') = (published_at IS NULL) AND (published_at IS NULL) = (published_by_principal_id IS NULL)),
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX saas_pricing_one_published ON hon.saas_pricing_versions ((true)) WHERE status = 'PUBLISHED';

CREATE TABLE hon.saas_operation_prices (
  pricing_id uuid NOT NULL REFERENCES hon.saas_pricing_versions(id) ON DELETE RESTRICT,
  operation_code text NOT NULL CHECK (operation_code ~ '^[a-z][a-z0-9_.]{2,59}$'),
  category text NOT NULL CHECK (category IN ('IMAGE_GENERATION','VIDEO_GENERATION','VOICE_GENERATION','AI_EMPLOYEE_TASK',
    'DEEP_RESEARCH','CAMPAIGN_OPTIMIZATION','OTHER_APPROVED')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  billing_unit text NOT NULL CHECK (billing_unit IN ('IMAGE','VIDEO_SECOND','AUDIO_SECOND','TOKEN_1K','REQUEST','TASK')),
  -- The approved customer-facing price, in premium credits per billing unit.
  credits_per_unit integer NOT NULL CHECK (credits_per_unit BETWEEN 1 AND 1000000),
  max_units_per_request integer NOT NULL CHECK (max_units_per_request BETWEEN 1 AND 100000),
  -- Plan capability required (B1 canonical capabilities): Complete-only work stays Complete-only.
  required_capability text NOT NULL CHECK (required_capability IN ('ai.premium_metered','ai.workforce','ai.delegated_jobs',
    'ai.orchestration','marketing.campaigns_ai_managed','attribution.ai_insight')),
  cost_evidence_id uuid NOT NULL REFERENCES hon.saas_provider_cost_evidence(id) ON DELETE RESTRICT,
  PRIMARY KEY (pricing_id, operation_code),
  CHECK (category NOT IN ('AI_EMPLOYEE_TASK') OR required_capability IN ('ai.workforce','ai.delegated_jobs','ai.orchestration')),
  CHECK (category <> 'CAMPAIGN_OPTIMIZATION' OR required_capability = 'marketing.campaigns_ai_managed')
);

-- ---------- allowances (one per subscription allowance period) ----------
CREATE TABLE hon.saas_credit_allowances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  period_index integer NOT NULL CHECK (period_index >= 0),
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
  plan_code text NOT NULL CHECK (plan_code IN ('CORE','COMPLETE')),
  allowance_basis text NOT NULL CHECK (allowance_basis IN ('REGULAR','FOUNDER','LIFETIME','LEGACY')),
  -- The full monthly plan allowance; never reduced after opening (guard).
  allowance_credits integer NOT NULL CHECK (allowance_credits BETWEEN 1 AND 1000000),
  status text NOT NULL CHECK (status IN ('OPEN','EXPIRED')),
  version integer NOT NULL CHECK (version > 0),
  opened_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  opened_at timestamptz NOT NULL,
  expired_at timestamptz,
  UNIQUE (subscription_id, period_index),
  CHECK (period_end > period_start),
  CHECK ((status = 'EXPIRED') = (expired_at IS NOT NULL))
);

CREATE TABLE hon.saas_credit_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allowance_id uuid NOT NULL REFERENCES hon.saas_credit_allowances(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  subscription_id uuid NOT NULL REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  operation_code text NOT NULL,
  pricing_id uuid NOT NULL,
  category text NOT NULL,
  credits_per_unit integer NOT NULL CHECK (credits_per_unit > 0),
  estimated_units integer NOT NULL CHECK (estimated_units > 0),
  reserved_credits integer NOT NULL CHECK (reserved_credits > 0),
  status text NOT NULL CHECK (status IN ('RESERVED','FINALIZED','RELEASED','OUTCOME_UNKNOWN')),
  status_reason text NOT NULL CHECK (status_reason IN ('RESERVED','PROVIDER_SUCCEEDED','PROVIDER_FAILED','PROVIDER_OUTCOME_UNKNOWN',
    'HQ_RESOLVED_SUCCEEDED','HQ_RESOLVED_NOT_CHARGED')),
  version integer NOT NULL CHECK (version > 0),
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  employee_key text CHECK (employee_key ~ '^[a-z]{2,20}$'),
  provider_id text NOT NULL REFERENCES hon.hq_ai_provider_connections(provider_id) ON DELETE RESTRICT,
  model_code text NOT NULL,
  action_request_id uuid,
  work_item_id uuid,
  final_units integer CHECK (final_units >= 0),
  final_credits integer CHECK (final_credits >= 0),
  provider_cost_microunits bigint CHECK (provider_cost_microunits >= 0),
  usage_id uuid REFERENCES hon.ai_usage_ledger(id) ON DELETE RESTRICT,
  resolution_reference text CHECK (length(resolution_reference) BETWEEN 1 AND 200),
  reserved_at timestamptz NOT NULL,
  settled_at timestamptz,
  settled_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (pricing_id, operation_code) REFERENCES hon.saas_operation_prices(pricing_id, operation_code) ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id, organization_id, school_id) REFERENCES hon.work_items(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (action_request_id, organization_id, school_id) REFERENCES hon.action_requests(id, organization_id, school_id) ON DELETE RESTRICT,
  CHECK (reserved_credits = credits_per_unit * estimated_units),
  CHECK (CASE status
    WHEN 'RESERVED' THEN final_units IS NULL AND final_credits IS NULL AND settled_at IS NULL
    WHEN 'OUTCOME_UNKNOWN' THEN final_units IS NULL AND final_credits IS NULL AND settled_at IS NULL
    WHEN 'FINALIZED' THEN final_units >= 0 AND final_credits = final_units * credits_per_unit AND final_credits <= reserved_credits
      AND provider_cost_microunits IS NOT NULL AND usage_id IS NOT NULL AND settled_at IS NOT NULL
    ELSE final_credits IS NULL AND settled_at IS NOT NULL END)
);
CREATE INDEX saas_credit_reservations_allowance ON hon.saas_credit_reservations (allowance_id, status);

-- Append-only credit movements. Per reservation: RESERVE r, then FINALIZE f (+ RELEASE r-f) or RELEASE r.
CREATE TABLE hon.saas_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allowance_id uuid NOT NULL REFERENCES hon.saas_credit_allowances(id) ON DELETE RESTRICT,
  reservation_id uuid REFERENCES hon.saas_credit_reservations(id) ON DELETE RESTRICT,
  entry_kind text NOT NULL CHECK (entry_kind IN ('RESERVE','FINALIZE','RELEASE','EXPIRE')),
  credits integer NOT NULL CHECK (credits > 0),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  CHECK ((entry_kind = 'EXPIRE') = (reservation_id IS NULL))
);
CREATE UNIQUE INDEX saas_credit_ledger_one_per_kind ON hon.saas_credit_ledger (reservation_id, entry_kind) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX saas_credit_ledger_one_expiry ON hon.saas_credit_ledger (allowance_id) WHERE entry_kind = 'EXPIRE';

CREATE TABLE hon.saas_credit_threshold_events (
  allowance_id uuid NOT NULL REFERENCES hon.saas_credit_allowances(id) ON DELETE RESTRICT,
  threshold_percent integer NOT NULL CHECK (threshold_percent IN (75,90,100)),
  committed_credits integer NOT NULL CHECK (committed_credits >= 0),
  reached_at timestamptz NOT NULL,
  notification_status text NOT NULL DEFAULT 'NOT_SENT' CHECK (notification_status = 'NOT_SENT'),
  PRIMARY KEY (allowance_id, threshold_percent)
);

-- ---------- vocabularies ----------
ALTER TABLE hon.saas_policy_decisions DROP CONSTRAINT saas_policy_decisions_policy_code_check;
ALTER TABLE hon.saas_policy_decisions ADD CONSTRAINT saas_policy_decisions_policy_code_check CHECK (policy_code IN ('ANNUAL_BILLING','TAXES',
  'PRORATION','PLAN_CHANGE_TIMING','CANCELLATION_TIMING','REFUND_EXECUTION','PAYMENT_PROVIDER','FOUNDER_SLOT_RETURN','CREDIT_ROLLOVER',
  'TOP_UP_PRICING','REFUND_GUARANTEE','FOUNDER_PROGRAM','FOUNDER_RESERVATION_HOLD','FOUNDER_ALLOWANCE','PLAN_ALLOWANCES','PREMIUM_OPERATIONS',
  'SUSPENDED_ALLOWANCE','PAYMENT_ATTESTATION'));
INSERT INTO hon.saas_policy_decisions(policy_code, status, blocks) VALUES
  ('PLAN_ALLOWANCES','UNDECIDED','Allowances are planned amounts only'),
  ('PREMIUM_OPERATIONS','UNDECIDED','No premium operation is priced'),
  ('SUSPENDED_ALLOWANCE','UNDECIDED','No allowance handling is defined for suspension'),
  ('PAYMENT_ATTESTATION','UNDECIDED','Payment attestation authority is not defined');
INSERT INTO hon.saas_policy_records(policy_code, version, status, decision_code, summary, blocks, source_reference, recorded_at) VALUES
  ('PLAN_ALLOWANCES',2,'DECIDED','CORE_5000_COMPLETE_12000_FULL_FOR_FOUNDER_LIFETIME_CHAMPIONS',
    'Core 5,000 and Complete 12,000 premium credits per month; founder, paid lifetime, Champions free months and referral-earned lifetime keep the full allowance; no rollover.',
    'Allowances open only while the HQ owner has activated the credit program.','OWNER_DIRECTION_2026_10_18_B3',clock_timestamp()),
  ('PREMIUM_OPERATIONS',2,'DECIDED','HQ_PUBLISHED_PRICING_LINKED_TO_VERIFIED_COST',
    'Premium operations are priced per operation by HQ-owner-published pricing linked to verified provider cost; ordinary assistant, CRM, scheduling, reporting, deterministic automation and lead sync never consume premium credits.',
    'No operation is priced until the HQ owner records verified provider cost and publishes pricing.','OWNER_DIRECTION_2026_10_18_B3',clock_timestamp()),
  ('SUSPENDED_ALLOWANCE',2,'DECIDED','NO_NEW_GRANTS_OR_JOBS_SETTLE_IN_FLIGHT',
    'Suspended subscriptions receive no new allowance and start no premium job; existing ledgers are kept and in-flight reservations still settle so incurred provider cost is recorded.',
    'Applies once the credit program is active.','OWNER_DIRECTION_2026_10_18_B3',clock_timestamp()),
  ('PAYMENT_ATTESTATION',2,'DECIDED','HQ_OWNER_ONLY',
    'Manual payment attestations are recorded by the HQ owner only.','HQ attestation is never processor confirmation.','OWNER_DIRECTION_2026_10_18_B3',clock_timestamp()),
  ('TAXES',3,'UNDECIDED',NULL,'Tax treatment is unresolved; zero tax is never assumed.',
    'An invoice cannot be issued until the HQ owner records its tax treatment with a documented authoritative verification reference.','OWNER_DIRECTION_2026_10_18_B3',clock_timestamp()),
  ('TOP_UP_PRICING',3,'DECIDED','TWICE_VERIFIED_PROVIDER_COST',
    'Premium top-ups are priced at 2x the independently verified fully loaded provider cost, never a fixed assumed amount.',
    'Top-ups and their purchase stay unavailable until separately authorized; at 100% premium reservations are refused.','OWNER_DIRECTION_2026_10_18_B3',clock_timestamp());

ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_action_code_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_action_code_check CHECK (action_code IN ('saas.catalog.draft','saas.catalog.publish',
  'saas.founder.reserve','saas.founder.release','saas.subscription.record','saas.subscription.command',
  'saas.invoice.draft','saas.invoice.command','saas.payment.evidence',
  'saas.credits.program','saas.credits.cost_evidence','saas.credits.pricing_draft','saas.credits.pricing_publish',
  'saas.credits.allowance','saas.credits.reserve','saas.credits.settle','saas.credits.resolve'));
ALTER TABLE hon.saas_audit DROP CONSTRAINT saas_audit_entity_type_check;
ALTER TABLE hon.saas_audit ADD CONSTRAINT saas_audit_entity_type_check CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION',
  'INVOICE','PAYMENT_EVIDENCE','CREDIT_PROGRAM','COST_EVIDENCE','PRICING','ALLOWANCE','CREDIT_RESERVATION'));
ALTER TABLE hon.saas_outbox DROP CONSTRAINT saas_outbox_event_type_check;
ALTER TABLE hon.saas_outbox ADD CONSTRAINT saas_outbox_event_type_check CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published',
  'saas.founder.reserved','saas.founder.released','saas.subscription.recorded','saas.subscription.changed',
  'saas.invoice.drafted','saas.invoice.changed','saas.payment.evidence_recorded',
  'saas.credits.program_changed','saas.credits.cost_recorded','saas.credits.pricing_drafted','saas.credits.pricing_published',
  'saas.credits.allowance_changed','saas.credits.reserved','saas.credits.settled','saas.credits.resolved'));

-- ---------- guards ----------
CREATE FUNCTION hon.guard_saas_credits() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE before_row jsonb; after_row jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_CREDITS' USING ERRCODE = '42501'; END IF;
  before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'saas_credit_program' THEN
    IF NEW.version = OLD.version + 1 AND NEW.status <> OLD.status
      AND (after_row - ARRAY['status','version','authorization_reference','changed_by_principal_id','changed_at'])
        = (before_row - ARRAY['status','version','authorization_reference','changed_by_principal_id','changed_at']) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'saas_pricing_versions' THEN
    IF (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED'
        AND (after_row - ARRAY['status','published_by_principal_id','published_at']) = (before_row - ARRAY['status','published_by_principal_id','published_at']))
      OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
        AND (after_row - ARRAY['status','retired_at']) = (before_row - ARRAY['status','retired_at'])) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'saas_credit_allowances' THEN
    IF OLD.status = 'OPEN' AND NEW.status = 'EXPIRED' AND NEW.version = OLD.version + 1
      AND (after_row - ARRAY['status','version','expired_at']) = (before_row - ARRAY['status','version','expired_at']) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'saas_credit_reservations' THEN
    IF NEW.version = OLD.version + 1
      AND (after_row - ARRAY['status','status_reason','version','final_units','final_credits','provider_cost_microunits','usage_id',
        'resolution_reference','settled_at','settled_by_principal_id'])
        = (before_row - ARRAY['status','status_reason','version','final_units','final_credits','provider_cost_microunits','usage_id',
        'resolution_reference','settled_at','settled_by_principal_id'])
      AND ((OLD.status = 'RESERVED' AND NEW.status IN ('FINALIZED','RELEASED','OUTCOME_UNKNOWN'))
        OR (OLD.status = 'OUTCOME_UNKNOWN' AND NEW.status IN ('FINALIZED','RELEASED'))) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

-- Operation prices are written once, only into a pricing draft.
CREATE FUNCTION hon.guard_saas_operation_prices() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM hon.saas_pricing_versions v WHERE v.id = NEW.pricing_id AND v.status = 'DRAFT') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_PRICING' USING ERRCODE = '42501';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_provider_cost_evidence','saas_credit_ledger','saas_credit_threshold_events'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['saas_credit_program','saas_pricing_versions','saas_credit_allowances','saas_credit_reservations'] LOOP
    EXECUTE format('CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_credits()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_credits()',t);
  END LOOP;
  CREATE TRIGGER saas_operation_prices_rows BEFORE INSERT OR UPDATE OR DELETE ON hon.saas_operation_prices FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_operation_prices();
  CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.saas_operation_prices FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_operation_prices();
END $$;

-- ---------- authority: school staff requesting premium work ----------
-- Staff with ai.premium.request at the exact school, an active entitlement, and no family, HQ,
-- parent, student or platform role (same resolver shape as the Champions Club school actor).
CREATE FUNCTION hon.require_saas_school_actor(p_subject text, p_school uuid)
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
        AND perm.code = 'ai.premium.request' AND perm.is_staff_assignable
        AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id = s.id)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()))
    AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id AND r.organization_id = g.organization_id
      WHERE g.principal_id = p.id AND g.revoked_at IS NULL AND g.effective_from <= clock_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = s.organization_id
      AND e.status = 'ACTIVE' AND e.tier IN ('CORE','COMPLETE')
      AND e.effective_from <= clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until > clock_timestamp()));
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
END $$;

-- ---------- private helpers ----------
CREATE FUNCTION hon.saas_credit_program_active() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT status = 'ACTIVE' FROM hon.saas_credit_program WHERE program_id = 1
$$;

-- Allowance period for a subscription at a moment: the recorded billing period for monthly plans;
-- calendar months anchored (in UTC) to service start for paid lifetime and legacy records.
CREATE FUNCTION hon.saas_allowance_period(s hon.saas_subscriptions, p_at timestamptz)
RETURNS TABLE (period_index integer, period_start timestamptz, period_end timestamptz)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE anchor timestamp; at_utc timestamp; n integer;
BEGIN
  IF s.service_started_at IS NULL THEN RETURN; END IF;
  IF s.billing_interval = 'MONTHLY' THEN
    period_index := s.period_index; period_start := s.current_period_start; period_end := s.current_period_end; RETURN NEXT; RETURN;
  END IF;
  anchor := s.service_started_at AT TIME ZONE 'UTC'; at_utc := p_at AT TIME ZONE 'UTC';
  n := greatest((extract(year FROM age(at_utc, anchor)) * 12 + extract(month FROM age(at_utc, anchor)))::integer, 0);
  WHILE anchor + make_interval(months => n) > at_utc AND n > 0 LOOP n := n - 1; END LOOP;
  WHILE anchor + make_interval(months => n + 1) <= at_utc LOOP n := n + 1; END LOOP;
  period_index := n;
  period_start := (anchor + make_interval(months => n)) AT TIME ZONE 'UTC';
  period_end := (anchor + make_interval(months => n + 1)) AT TIME ZONE 'UTC';
  RETURN NEXT;
END $$;

-- Committed = consumed (FINALIZE) + still held (RESERVE minus FINALIZE and RELEASE).
CREATE FUNCTION hon.saas_allowance_balance(p_allowance uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH a AS (SELECT * FROM hon.saas_credit_allowances WHERE id = p_allowance),
  l AS (SELECT coalesce(sum(credits) FILTER (WHERE entry_kind = 'RESERVE'), 0) reserved,
      coalesce(sum(credits) FILTER (WHERE entry_kind = 'FINALIZE'), 0) consumed,
      coalesce(sum(credits) FILTER (WHERE entry_kind = 'RELEASE'), 0) released,
      coalesce(sum(credits) FILTER (WHERE entry_kind = 'EXPIRE'), 0) expired
    FROM hon.saas_credit_ledger WHERE allowance_id = p_allowance)
  SELECT jsonb_build_object('allowanceCredits', a.allowance_credits, 'consumedCredits', l.consumed,
    'heldCredits', l.reserved - l.consumed - l.released, 'expiredCredits', l.expired,
    'availableCredits', CASE WHEN a.status = 'OPEN' THEN greatest(a.allowance_credits - l.reserved + l.released, 0) ELSE 0 END,
    'usedPercent', CASE WHEN a.allowance_credits = 0 THEN 0 ELSE least(((l.reserved - l.released) * 100) / a.allowance_credits, 100) END)
  FROM a, l
$$;

CREATE FUNCTION hon.saas_allowance_json(p_allowance uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('allowanceId',a.id,'subscriptionId',a.subscription_id,'organizationId',a.organization_id,'periodIndex',a.period_index,
    'periodStart',hon.saas_ts(a.period_start),'periodEnd',hon.saas_ts(a.period_end),'planCode',a.plan_code,'allowanceBasis',a.allowance_basis,
    'status',a.status,'version',a.version,'balance',hon.saas_allowance_balance(a.id),
    'thresholds',(SELECT coalesce(jsonb_agg(jsonb_build_object('thresholdPercent',t.threshold_percent,'reachedAt',hon.saas_ts(t.reached_at),
        'notification',t.notification_status) ORDER BY t.threshold_percent), '[]'::jsonb) FROM hon.saas_credit_threshold_events t WHERE t.allowance_id = a.id),
    'rollover','NONE','topUps','UNAVAILABLE','openedAt',hon.saas_ts(a.opened_at),'expiredAt',hon.saas_ts(a.expired_at))
  FROM hon.saas_credit_allowances a WHERE a.id = p_allowance
$$;

-- p_internal adds provider and cost fields for HQ; school views never see provider cost.
CREATE FUNCTION hon.saas_credit_reservation_json(r hon.saas_credit_reservations, p_internal boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('reservationId',r.id,'allowanceId',r.allowance_id,'organizationId',r.organization_id,'schoolId',r.school_id,
    'subscriptionId',r.subscription_id,'operationCode',r.operation_code,'category',r.category,'creditsPerUnit',r.credits_per_unit,
    'estimatedUnits',r.estimated_units,'reservedCredits',r.reserved_credits,'status',r.status,'statusReason',r.status_reason,'version',r.version,
    'employeeKey',r.employee_key,'actionRequestId',r.action_request_id,'workItemId',r.work_item_id,
    'finalUnits',r.final_units,'finalCredits',r.final_credits,'reservedAt',hon.saas_ts(r.reserved_at),'settledAt',hon.saas_ts(r.settled_at))
    || CASE WHEN p_internal THEN jsonb_build_object('providerId',r.provider_id,'modelCode',r.model_code,
      'providerCostMicrounits',r.provider_cost_microunits,'usageId',r.usage_id,'resolutionReference',r.resolution_reference) ELSE '{}'::jsonb END
$$;

CREATE FUNCTION hon.saas_pricing_json(p_pricing uuid, p_internal boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('pricingId',v.id,'pricingVersion',v.pricing_version,'status',v.status,'termsReference',v.terms_reference,
    'operations',(SELECT coalesce(jsonb_agg(jsonb_build_object('operationCode',o.operation_code,'category',o.category,'displayName',o.display_name,
        'billingUnit',o.billing_unit,'creditsPerUnit',o.credits_per_unit,'maxUnitsPerRequest',o.max_units_per_request,
        'requiredCapability',o.required_capability)
        || CASE WHEN p_internal THEN jsonb_build_object('costEvidenceId',o.cost_evidence_id,
          'providerId',e.provider_id,'modelCode',e.model_code,
          'fullyLoadedCostMicrounitsPerUnit',(e.fully_loaded_cost_microunits + e.measured_units - 1) / e.measured_units,
          'fullyLoadedCostMicrounitsPerCredit',((e.fully_loaded_cost_microunits + e.measured_units - 1) / e.measured_units + o.credits_per_unit - 1) / o.credits_per_unit)
          ELSE '{}'::jsonb END ORDER BY o.operation_code), '[]'::jsonb)
      FROM hon.saas_operation_prices o JOIN hon.saas_provider_cost_evidence e ON e.id = o.cost_evidence_id WHERE o.pricing_id = v.id),
    'createdAt',hon.saas_ts(v.created_at),'publishedAt',hon.saas_ts(v.published_at),'retiredAt',hon.saas_ts(v.retired_at))
  FROM hon.saas_pricing_versions v WHERE v.id = p_pricing
$$;

CREATE FUNCTION hon.saas_cost_evidence_json(e hon.saas_provider_cost_evidence) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('costEvidenceId',e.id,'providerId',e.provider_id,'modelCode',e.model_code,'costUnit',e.cost_unit,
    'measuredUnits',e.measured_units,'billedCostMicrounits',e.billed_cost_microunits,'fullyLoadedCostMicrounits',e.fully_loaded_cost_microunits,
    'fullyLoadedCostMicrounitsPerUnit',(e.fully_loaded_cost_microunits + e.measured_units - 1) / e.measured_units,
    'source',e.source,'evidenceReference',e.evidence_reference,'periodStart',hon.saas_ts(e.period_start),'periodEnd',hon.saas_ts(e.period_end),
    'note',e.note,'verifiedAt',hon.saas_ts(e.verified_at))
$$;

CREATE FUNCTION hon.saas_credit_program_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('status',p.status,'version',p.version,'authorizationReference',p.authorization_reference,
    'changedAt',hon.saas_ts(p.changed_at),'topUps','UNAVAILABLE','overage','DISABLED','purchases','DISABLED')
  FROM hon.saas_credit_program p WHERE p.program_id = 1
$$;

-- Records reached usage thresholds (75/90/100) once per allowance. Notifications are not sent.
CREATE FUNCTION hon.saas_record_thresholds(p_allowance uuid, p_at timestamptz) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE a hon.saas_credit_allowances%ROWTYPE; committed integer; t integer;
BEGIN
  SELECT * INTO a FROM hon.saas_credit_allowances WHERE id = p_allowance;
  committed := (hon.saas_allowance_balance(p_allowance)->>'consumedCredits')::integer + (hon.saas_allowance_balance(p_allowance)->>'heldCredits')::integer;
  FOREACH t IN ARRAY ARRAY[75,90,100] LOOP
    IF committed * 100 >= t * a.allowance_credits THEN
      INSERT INTO hon.saas_credit_threshold_events(allowance_id, threshold_percent, committed_credits, reached_at)
        VALUES (p_allowance, t, committed, p_at) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- Opens (or returns) the allowance for the subscription's current allowance period, and expires
-- earlier open allowances whose period has ended (no rollover). Callers hold the subscription lock.
CREATE FUNCTION hon.saas_current_allowance(p_subscription uuid, p_actor uuid, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE s hon.saas_subscriptions%ROWTYPE; per record; v_id uuid; v_credits integer; v_basis text; old record; remaining integer;
BEGIN
  SELECT * INTO s FROM hon.saas_subscriptions WHERE id = p_subscription;
  FOR old IN SELECT a.id FROM hon.saas_credit_allowances a WHERE a.subscription_id = p_subscription AND a.status = 'OPEN' AND a.period_end <= p_at LOOP
    remaining := (hon.saas_allowance_balance(old.id)->>'availableCredits')::integer;
    IF remaining > 0 THEN
      INSERT INTO hon.saas_credit_ledger(allowance_id, entry_kind, credits, actor_principal_id, occurred_at) VALUES (old.id, 'EXPIRE', remaining, p_actor, p_at);
    END IF;
    UPDATE hon.saas_credit_allowances SET status = 'EXPIRED', expired_at = p_at, version = version + 1 WHERE id = old.id;
  END LOOP;
  SELECT * INTO per FROM hon.saas_allowance_period(s, p_at);
  IF per.period_index IS NULL OR p_at >= per.period_end OR p_at < per.period_start THEN
    RAISE EXCEPTION 'SAAS_ALLOWANCE_PERIOD_UNAVAILABLE' USING ERRCODE = '23514';
  END IF;
  SELECT a.id INTO v_id FROM hon.saas_credit_allowances a WHERE a.subscription_id = p_subscription AND a.period_index = per.period_index;
  IF v_id IS NOT NULL THEN
    IF (SELECT status FROM hon.saas_credit_allowances WHERE id = v_id) <> 'OPEN' THEN RAISE EXCEPTION 'SAAS_ALLOWANCE_PERIOD_UNAVAILABLE' USING ERRCODE = '23514'; END IF;
    RETURN v_id;
  END IF;
  -- Opening is a grant: only for an in-service subscription while the HQ owner has activated the program.
  IF s.status <> 'IN_SERVICE' THEN RAISE EXCEPTION 'SAAS_SUBSCRIPTION_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF NOT hon.saas_credit_program_active() THEN RAISE EXCEPTION 'SAAS_CREDITS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  IF s.source = 'CATALOG_OFFER' THEN
    SELECT p.planned_monthly_premium_credits INTO v_credits FROM hon.saas_catalog_plans p WHERE p.catalog_id = s.catalog_id AND p.plan_code = s.plan_code;
    v_basis := CASE s.offer_kind WHEN 'REGULAR_MONTHLY' THEN 'REGULAR' WHEN 'FOUNDER_MONTHLY' THEN 'FOUNDER' ELSE 'LIFETIME' END;
  ELSE
    -- Legacy Core/Complete records take the currently published plan allowance for their tier.
    SELECT p.planned_monthly_premium_credits INTO v_credits FROM hon.saas_catalog_plans p JOIN hon.saas_catalog_versions c ON c.id = p.catalog_id
      WHERE c.status = 'PUBLISHED' AND p.plan_code = s.plan_code;
    v_basis := 'LEGACY';
  END IF;
  IF s.plan_code NOT IN ('CORE','COMPLETE') OR v_credits IS NULL OR v_credits < 1 THEN
    RAISE EXCEPTION 'SAAS_NO_PREMIUM_ALLOWANCE' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.saas_credit_allowances(subscription_id, organization_id, period_index, period_start, period_end, plan_code, allowance_basis,
      allowance_credits, status, version, opened_by_principal_id, opened_at)
    VALUES (s.id, s.organization_id, per.period_index, per.period_start, per.period_end, s.plan_code, v_basis, v_credits, 'OPEN', 1, p_actor, p_at)
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION hon.saas_published_operation(p_operation text) RETURNS hon.saas_operation_prices
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT o.* FROM hon.saas_operation_prices o JOIN hon.saas_pricing_versions v ON v.id = o.pricing_id
  WHERE v.status = 'PUBLISHED' AND o.operation_code = p_operation
$$;

-- ---------- HQ reads ----------
CREATE FUNCTION hon.read_saas_credit_program_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE published jsonb; drafts jsonb; evidence jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT hon.saas_pricing_json(v.id, true) INTO published FROM hon.saas_pricing_versions v WHERE v.status = 'PUBLISHED';
  SELECT coalesce(jsonb_agg(hon.saas_pricing_json(d.id, true) ORDER BY d.pricing_version DESC), '[]'::jsonb) INTO drafts
    FROM (SELECT id, pricing_version FROM hon.saas_pricing_versions WHERE status = 'DRAFT' ORDER BY pricing_version DESC LIMIT 10) d;
  SELECT coalesce(jsonb_agg(hon.saas_cost_evidence_json(e) ORDER BY e.verified_at DESC, e.id), '[]'::jsonb) INTO evidence
    FROM (SELECT * FROM hon.saas_provider_cost_evidence ORDER BY verified_at DESC, id LIMIT 50) e;
  RETURN jsonb_build_object('program', hon.saas_credit_program_json(), 'publishedPricing', published, 'pricingDrafts', drafts,
    'costEvidence', evidence, 'premiumCreditsFromOrdinaryUse', false);
END $$;

CREATE FUNCTION hon.read_saas_organization_credits_from_hq(p_subject text, p_organization uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE allowances jsonb; reservations jsonb; ordinary jsonb; cur uuid;
BEGIN
  IF p_organization IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  IF NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = p_organization) THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT s.id INTO cur FROM hon.saas_subscriptions s WHERE s.organization_id = p_organization AND s.status <> 'VOIDED';
  SELECT coalesce(jsonb_agg(hon.saas_allowance_json(a.id) ORDER BY a.period_start DESC, a.id), '[]'::jsonb) INTO allowances
    FROM (SELECT id, period_start FROM hon.saas_credit_allowances WHERE organization_id = p_organization ORDER BY period_start DESC, id LIMIT 12) a;
  SELECT coalesce(jsonb_agg(hon.saas_credit_reservation_json(r, true) ORDER BY r.reserved_at DESC, r.id), '[]'::jsonb) INTO reservations
    FROM (SELECT * FROM hon.saas_credit_reservations WHERE organization_id = p_organization ORDER BY reserved_at DESC, id LIMIT 50) r;
  -- Ordinary (non-premium) AI usage this UTC month: visible for fair-use and cost oversight, never deducted from the allowance.
  SELECT jsonb_build_object('events', count(*), 'providerCostMicrounits', coalesce(sum(u.provider_cost_microunits), 0), 'premiumDeduction', 'NONE')
    INTO ordinary FROM hon.ai_usage_ledger u
    WHERE u.organization_id = p_organization AND NOT EXISTS (SELECT 1 FROM hon.saas_credit_reservations r WHERE r.usage_id = u.id)
      AND u.occurred_at >= (date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
  RETURN jsonb_build_object('organizationId', p_organization, 'subscriptionId', cur, 'program', hon.saas_credit_program_json(),
    'allowances', allowances, 'reservations', reservations, 'ordinaryUsageThisMonth', ordinary);
END $$;

-- ---------- HQ commands ----------
CREATE FUNCTION hon.set_saas_credit_program(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_credit_program%ROWTYPE; at timestamptz; snapshot jsonb;
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
  replay := hon.saas_claim_request(actor, p_key, 'saas.credits.program', hon.saas_fingerprint(ARRAY['saas.credits.program', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO prior FROM hon.saas_credit_program WHERE program_id = 1 FOR UPDATE;
  IF prior.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF (p->>'action' = 'ACTIVATE') = (prior.status = 'ACTIVE') THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  IF p->>'action' = 'ACTIVATE' AND NOT EXISTS (SELECT 1 FROM hon.saas_pricing_versions WHERE status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'SAAS_PRICING_NOT_PUBLISHED' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  UPDATE hon.saas_credit_program SET status = CASE WHEN p->>'action' = 'ACTIVATE' THEN 'ACTIVE' ELSE 'INACTIVE' END, version = version + 1,
      authorization_reference = p->>'authorizationReference', changed_by_principal_id = actor, changed_at = at WHERE program_id = 1;
  snapshot := hon.saas_credit_program_json();
  RETURN hon.saas_record(actor, p_key, 'saas.credits.program', 'saas.credits.program_changed', 'CREDIT_PROGRAM',
    '00000000-0000-4000-8000-000000000001'::uuid, NULL, jsonb_build_object('status', prior.status, 'version', prior.version), snapshot,
    jsonb_build_object('program', snapshot), at);
END $$;

-- HQ owner only. Evidence must come from actual provider usage or billing (reference required).
CREATE FUNCTION hon.record_saas_provider_cost_evidence(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; created hon.saas_provider_cost_evidence%ROWTYPE; at timestamptz; snapshot jsonb;
  iso constant text := '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM
      ARRAY['billedCostMicrounits','costUnit','evidenceReference','fullyLoadedCostMicrounits','measuredUnits','modelCode','note','periodEnd','periodStart','providerId']
    OR coalesce(jsonb_typeof(p->'providerId'), '') <> 'string' OR coalesce(jsonb_typeof(p->'modelCode'), '') <> 'string'
    OR NOT coalesce(hon.hq_ai_safe_text(p->>'modelCode', true), false)
    OR coalesce(p->>'costUnit', '') NOT IN ('IMAGE','VIDEO_SECOND','AUDIO_SECOND','TOKEN_1K','REQUEST','TASK')
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['measuredUnits','billedCostMicrounits','fullyLoadedCostMicrounits']) k
      WHERE coalesce(jsonb_typeof(p->k), '') <> 'number' OR (p->>k) !~ '^[1-9][0-9]{0,14}$')
    OR coalesce(jsonb_typeof(p->'evidenceReference'), '') <> 'string' OR length(p->>'evidenceReference') NOT BETWEEN 1 AND 200
    OR btrim(p->>'evidenceReference') <> p->>'evidenceReference'
    OR coalesce(jsonb_typeof(p->'periodStart'), '') <> 'string' OR (p->>'periodStart') !~ iso
    OR coalesce(jsonb_typeof(p->'periodEnd'), '') <> 'string' OR (p->>'periodEnd') !~ iso
    OR coalesce(jsonb_typeof(p->'note'), '') NOT IN ('string','null') OR (jsonb_typeof(p->'note') = 'string' AND length(p->>'note') NOT BETWEEN 1 AND 500) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.credits.cost_evidence', hon.saas_fingerprint(ARRAY['saas.credits.cost_evidence', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.hq_ai_provider_connections WHERE provider_id = p->>'providerId') THEN
    RAISE EXCEPTION 'SAAS_PROVIDER_UNKNOWN' USING ERRCODE = '23514';
  END IF;
  IF (p->>'fullyLoadedCostMicrounits')::bigint < (p->>'billedCostMicrounits')::bigint THEN
    RAISE EXCEPTION 'SAAS_COST_BELOW_BILLED' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  IF (p->>'periodEnd')::timestamptz <= (p->>'periodStart')::timestamptz OR (p->>'periodEnd')::timestamptz > at THEN
    RAISE EXCEPTION 'SAAS_COST_PERIOD_INVALID' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_provider_cost_evidence e WHERE e.provider_id = p->>'providerId' AND e.evidence_reference = p->>'evidenceReference'
      AND e.model_code = p->>'modelCode' AND e.cost_unit = p->>'costUnit') THEN
    RAISE EXCEPTION 'SAAS_EVIDENCE_DUPLICATE_REFERENCE' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.saas_provider_cost_evidence(provider_id, model_code, cost_unit, measured_units, billed_cost_microunits, fully_loaded_cost_microunits,
      evidence_reference, period_start, period_end, note, verified_by_principal_id, verified_at)
    VALUES (p->>'providerId', p->>'modelCode', p->>'costUnit', (p->>'measuredUnits')::bigint, (p->>'billedCostMicrounits')::bigint,
      (p->>'fullyLoadedCostMicrounits')::bigint, p->>'evidenceReference', (p->>'periodStart')::timestamptz, (p->>'periodEnd')::timestamptz, p->>'note', actor, at)
    RETURNING * INTO created;
  snapshot := hon.saas_cost_evidence_json(created);
  RETURN hon.saas_record(actor, p_key, 'saas.credits.cost_evidence', 'saas.credits.cost_recorded', 'COST_EVIDENCE', created.id, NULL, NULL, snapshot,
    jsonb_build_object('costEvidence', snapshot), at);
END $$;

-- Owner or operator drafts; every operation must cite verified cost evidence in the same unit.
CREATE FUNCTION hon.create_saas_pricing_draft(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; item jsonb; created hon.saas_pricing_versions%ROWTYPE; next_version integer; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['operations','termsReference']
    OR coalesce(jsonb_typeof(p->'termsReference'), '') NOT IN ('string','null')
    OR (jsonb_typeof(p->'termsReference') = 'string' AND (length(p->>'termsReference') NOT BETWEEN 1 AND 500 OR btrim(p->>'termsReference') <> p->>'termsReference'))
    OR coalesce(jsonb_typeof(p->'operations'), '') <> 'array' OR jsonb_array_length(p->'operations') NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'operations') LOOP
    IF jsonb_typeof(item) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k) IS DISTINCT FROM
        ARRAY['billingUnit','category','costEvidenceId','creditsPerUnit','displayName','maxUnitsPerRequest','operationCode','requiredCapability']
      OR coalesce(jsonb_typeof(item->'operationCode'), '') <> 'string' OR (item->>'operationCode') !~ '^[a-z][a-z0-9_.]{2,59}$'
      OR coalesce(item->>'category', '') NOT IN ('IMAGE_GENERATION','VIDEO_GENERATION','VOICE_GENERATION','AI_EMPLOYEE_TASK','DEEP_RESEARCH','CAMPAIGN_OPTIMIZATION','OTHER_APPROVED')
      OR coalesce(jsonb_typeof(item->'displayName'), '') <> 'string' OR length(item->>'displayName') NOT BETWEEN 1 AND 120 OR btrim(item->>'displayName') <> item->>'displayName'
      OR coalesce(item->>'billingUnit', '') NOT IN ('IMAGE','VIDEO_SECOND','AUDIO_SECOND','TOKEN_1K','REQUEST','TASK')
      OR coalesce(jsonb_typeof(item->'creditsPerUnit'), '') <> 'number' OR (item->>'creditsPerUnit') !~ '^[1-9][0-9]{0,6}$' OR (item->>'creditsPerUnit')::integer > 1000000
      OR coalesce(jsonb_typeof(item->'maxUnitsPerRequest'), '') <> 'number' OR (item->>'maxUnitsPerRequest') !~ '^[1-9][0-9]{0,5}$' OR (item->>'maxUnitsPerRequest')::integer > 100000
      OR coalesce(item->>'requiredCapability', '') NOT IN ('ai.premium_metered','ai.workforce','ai.delegated_jobs','ai.orchestration','marketing.campaigns_ai_managed','attribution.ai_insight')
      OR coalesce(jsonb_typeof(item->'costEvidenceId'), '') <> 'string' THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'operationCode') FROM jsonb_array_elements(p->'operations')) <> jsonb_array_length(p->'operations') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, false);
  replay := hon.saas_claim_request(actor, p_key, 'saas.credits.pricing_draft', hon.saas_fingerprint(ARRAY['saas.credits.pricing_draft', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->'operations') x LEFT JOIN hon.saas_provider_cost_evidence e ON e.id = (x->>'costEvidenceId')::uuid
      WHERE e.id IS NULL OR e.cost_unit <> x->>'billingUnit') THEN
    RAISE EXCEPTION 'SAAS_PRICING_COST_EVIDENCE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  LOCK TABLE hon.saas_pricing_versions IN SHARE ROW EXCLUSIVE MODE;
  SELECT coalesce(max(pricing_version), 0) + 1 INTO next_version FROM hon.saas_pricing_versions;
  at := clock_timestamp();
  INSERT INTO hon.saas_pricing_versions(pricing_version, status, terms_reference, created_by_principal_id, created_at)
    VALUES (next_version, 'DRAFT', p->>'termsReference', actor, at) RETURNING * INTO created;
  INSERT INTO hon.saas_operation_prices(pricing_id, operation_code, category, display_name, billing_unit, credits_per_unit, max_units_per_request,
      required_capability, cost_evidence_id)
    SELECT created.id, x->>'operationCode', x->>'category', x->>'displayName', x->>'billingUnit', (x->>'creditsPerUnit')::integer,
      (x->>'maxUnitsPerRequest')::integer, x->>'requiredCapability', (x->>'costEvidenceId')::uuid
    FROM jsonb_array_elements(p->'operations') x;
  snapshot := hon.saas_pricing_json(created.id, true);
  RETURN hon.saas_record(actor, p_key, 'saas.credits.pricing_draft', 'saas.credits.pricing_drafted', 'PRICING', created.id, NULL, NULL, snapshot,
    jsonb_build_object('pricing', snapshot), at);
END $$;

CREATE FUNCTION hon.publish_saas_pricing(p_subject text, p_pricing uuid, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; draft hon.saas_pricing_versions%ROWTYPE; prior hon.saas_pricing_versions%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p_pricing IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.credits.pricing_publish', hon.saas_fingerprint(ARRAY['saas.credits.pricing_publish', p_pricing::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  LOCK TABLE hon.saas_pricing_versions IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO draft FROM hon.saas_pricing_versions WHERE id = p_pricing FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF draft.status <> 'DRAFT' THEN RAISE EXCEPTION 'SAAS_CATALOG_NOT_DRAFT' USING ERRCODE = '40001'; END IF;
  IF draft.terms_reference IS NULL THEN RAISE EXCEPTION 'SAAS_PRICING_UNDECIDED' USING ERRCODE = '23514'; END IF;
  at := clock_timestamp();
  SELECT * INTO prior FROM hon.saas_pricing_versions WHERE status = 'PUBLISHED' FOR UPDATE;
  IF FOUND THEN UPDATE hon.saas_pricing_versions SET status = 'RETIRED', retired_at = at WHERE id = prior.id; END IF;
  UPDATE hon.saas_pricing_versions SET status = 'PUBLISHED', published_by_principal_id = actor, published_at = at WHERE id = p_pricing;
  snapshot := hon.saas_pricing_json(p_pricing, true);
  RETURN hon.saas_record(actor, p_key, 'saas.credits.pricing_publish', 'saas.credits.pricing_published', 'PRICING', p_pricing, NULL,
    CASE WHEN prior.id IS NULL THEN NULL ELSE jsonb_build_object('retiredPricingId', prior.id) END, snapshot,
    jsonb_build_object('pricing', snapshot, 'retiredPricingId', CASE WHEN prior.id IS NULL THEN NULL ELSE to_jsonb(prior.id) END), at);
END $$;

-- OPEN_CURRENT (owner or operator): open the current allowance period for an in-service subscription.
-- EXPIRE (owner or operator): close an allowance whose period has ended; the unused balance expires.
CREATE FUNCTION hon.command_saas_credit_allowance(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; keys text[]; v_sub uuid; v_allowance uuid; a hon.saas_credit_allowances%ROWTYPE; at timestamptz; remaining integer; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k);
  IF NOT coalesce((p->>'action' = 'OPEN_CURRENT' AND keys = ARRAY['action','subscriptionId'] AND jsonb_typeof(p->'subscriptionId') = 'string')
    OR (p->>'action' = 'EXPIRE' AND keys = ARRAY['action','allowanceId','expectedVersion'] AND jsonb_typeof(p->'allowanceId') = 'string'
      AND jsonb_typeof(p->'expectedVersion') = 'number' AND (p->>'expectedVersion') ~ '^[1-9][0-9]{0,8}$'), false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, false);
  replay := hon.saas_claim_request(actor, p_key, 'saas.credits.allowance', hon.saas_fingerprint(ARRAY['saas.credits.allowance', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();
  IF p->>'action' = 'OPEN_CURRENT' THEN
    v_sub := (p->>'subscriptionId')::uuid;
    PERFORM 1 FROM hon.saas_subscriptions WHERE id = v_sub FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('saas.credits:' || v_sub::text, 0));
    v_allowance := hon.saas_current_allowance(v_sub, actor, at);
  ELSE
    SELECT * INTO a FROM hon.saas_credit_allowances WHERE id = (p->>'allowanceId')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
    PERFORM 1 FROM hon.saas_subscriptions WHERE id = a.subscription_id FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtextextended('saas.credits:' || a.subscription_id::text, 0));
    SELECT * INTO a FROM hon.saas_credit_allowances WHERE id = a.id FOR UPDATE;
    IF a.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    IF a.status <> 'OPEN' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
    IF at < a.period_end THEN RAISE EXCEPTION 'SAAS_PERIOD_NOT_ENDED' USING ERRCODE = '23514'; END IF;
    remaining := (hon.saas_allowance_balance(a.id)->>'availableCredits')::integer;
    IF remaining > 0 THEN
      INSERT INTO hon.saas_credit_ledger(allowance_id, entry_kind, credits, actor_principal_id, occurred_at) VALUES (a.id, 'EXPIRE', remaining, actor, at);
    END IF;
    UPDATE hon.saas_credit_allowances SET status = 'EXPIRED', expired_at = at, version = version + 1 WHERE id = a.id;
    v_allowance := a.id;
  END IF;
  snapshot := hon.saas_allowance_json(v_allowance);
  RETURN hon.saas_record(actor, p_key, 'saas.credits.allowance', 'saas.credits.allowance_changed', 'ALLOWANCE', v_allowance,
    (snapshot->>'organizationId')::uuid, NULL, snapshot || jsonb_build_object('action', p->>'action'),
    jsonb_build_object('allowance', snapshot, 'action', p->>'action'), at);
END $$;

-- ---------- school reads ----------
CREATE FUNCTION hon.read_saas_school_credits(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; s hon.saas_subscriptions%ROWTYPE; per record; v_allowance uuid; ops jsonb; recent jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = scope.organization_id AND status <> 'VOIDED';
  IF s.id IS NOT NULL THEN
    SELECT * INTO per FROM hon.saas_allowance_period(s, clock_timestamp());
    SELECT a.id INTO v_allowance FROM hon.saas_credit_allowances a WHERE a.subscription_id = s.id AND a.period_index = per.period_index;
  END IF;
  SELECT coalesce(jsonb_agg(o ORDER BY o->>'operationCode'), '[]'::jsonb) INTO ops
    FROM (SELECT jsonb_array_elements(hon.saas_pricing_json(v.id, false)->'operations') o FROM hon.saas_pricing_versions v WHERE v.status = 'PUBLISHED') x
    WHERE s.id IS NOT NULL AND (o->>'requiredCapability') = ANY(hon.saas_plan_capabilities(s.plan_code));
  SELECT coalesce(jsonb_agg(hon.saas_credit_reservation_json(r, false) ORDER BY r.reserved_at DESC, r.id), '[]'::jsonb) INTO recent
    FROM (SELECT * FROM hon.saas_credit_reservations WHERE school_id = p_school ORDER BY reserved_at DESC, id LIMIT 20) r;
  RETURN jsonb_build_object('schoolId', p_school, 'planCode', s.plan_code, 'subscriptionStatus', s.status,
    'programStatus', (SELECT status FROM hon.saas_credit_program WHERE program_id = 1),
    'currentAllowance', CASE WHEN v_allowance IS NULL THEN NULL ELSE hon.saas_allowance_json(v_allowance) - 'organizationId' END,
    'operations', ops, 'recentReservations', recent, 'ordinaryUseConsumesCredits', false, 'topUps', 'UNAVAILABLE');
END $$;

CREATE FUNCTION hon.estimate_saas_premium_operation(p_subject text, p_school uuid, p_operation text, p_units integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; s hon.saas_subscriptions%ROWTYPE; o hon.saas_operation_prices%ROWTYPE; per record; v_allowance uuid; available integer; credits integer; reason text;
BEGIN
  IF p_operation IS NULL OR p_operation !~ '^[a-z][a-z0-9_.]{2,59}$' OR p_units IS NULL OR p_units NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  o := hon.saas_published_operation(p_operation);
  IF o.operation_code IS NULL THEN RAISE EXCEPTION 'SAAS_OPERATION_NOT_PRICED' USING ERRCODE = '23514'; END IF;
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = scope.organization_id AND status <> 'VOIDED';
  credits := o.credits_per_unit * p_units;
  IF s.id IS NOT NULL THEN
    SELECT * INTO per FROM hon.saas_allowance_period(s, clock_timestamp());
    SELECT a.id INTO v_allowance FROM hon.saas_credit_allowances a WHERE a.subscription_id = s.id AND a.period_index = per.period_index AND a.status = 'OPEN';
  END IF;
  available := CASE WHEN v_allowance IS NULL THEN NULL ELSE (hon.saas_allowance_balance(v_allowance)->>'availableCredits')::integer END;
  reason := CASE WHEN NOT hon.saas_credit_program_active() THEN 'SAAS_CREDITS_NOT_ACTIVE'
    WHEN s.id IS NULL OR s.status <> 'IN_SERVICE' THEN 'SAAS_SUBSCRIPTION_NOT_ACTIVE'
    WHEN NOT (o.required_capability = ANY(hon.saas_plan_capabilities(s.plan_code))) THEN 'SAAS_OPERATION_NOT_IN_PLAN'
    WHEN p_units > o.max_units_per_request THEN 'SAAS_OPERATION_UNITS_EXCEEDED'
    WHEN available IS NOT NULL AND credits > available THEN 'SAAS_CREDITS_EXHAUSTED' END;
  RETURN jsonb_build_object('operationCode', o.operation_code, 'category', o.category, 'units', p_units, 'creditsPerUnit', o.credits_per_unit,
    'estimatedCredits', credits, 'availableCredits', available, 'allowed', reason IS NULL, 'refusal', reason, 'estimateOnly', true);
END $$;

-- ---------- premium job accounting (called by the server-side premium job runtime) ----------
-- RESERVE: requester is the school staff member; idempotent per (requester, key) so a retry
-- returns the original reservation and never holds credits twice.
CREATE FUNCTION hon.reserve_saas_premium_credits(p_subject text, p_school uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; replay jsonb; s hon.saas_subscriptions%ROWTYPE; o hon.saas_operation_prices%ROWTYPE; e hon.saas_provider_cost_evidence%ROWTYPE;
  v_allowance uuid; units integer; credits integer; available integer; created hon.saas_credit_reservations%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM
      ARRAY['actionRequestId','employeeKey','operationCode','units','workItemId']
    OR coalesce(jsonb_typeof(p->'operationCode'), '') <> 'string' OR (p->>'operationCode') !~ '^[a-z][a-z0-9_.]{2,59}$'
    OR coalesce(jsonb_typeof(p->'units'), '') <> 'number' OR (p->>'units') !~ '^[1-9][0-9]{0,5}$' OR (p->>'units')::integer > 100000
    OR coalesce(jsonb_typeof(p->'employeeKey'), '') NOT IN ('string','null') OR (jsonb_typeof(p->'employeeKey') = 'string' AND (p->>'employeeKey') !~ '^[a-z]{2,20}$')
    OR coalesce(jsonb_typeof(p->'actionRequestId'), '') NOT IN ('string','null') OR coalesce(jsonb_typeof(p->'workItemId'), '') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  units := (p->>'units')::integer;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  LOCK TABLE hon.users, hon.principals, hon.principal_role_grants, hon.roles, hon.role_permissions, hon.permissions,
    hon.family_access_grants, hon.hq_operator_grants, hon.organization_entitlements IN SHARE MODE;
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, p_school) LIMIT 1;
  replay := hon.saas_claim_request(scope.principal_id, p_key, 'saas.credits.reserve',
    hon.saas_fingerprint(ARRAY['saas.credits.reserve', p_school::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF NOT hon.saas_credit_program_active() THEN RAISE EXCEPTION 'SAAS_CREDITS_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  SELECT * INTO s FROM hon.saas_subscriptions WHERE organization_id = scope.organization_id AND status <> 'VOIDED' FOR UPDATE;
  IF NOT FOUND OR s.status <> 'IN_SERVICE' THEN RAISE EXCEPTION 'SAAS_SUBSCRIPTION_NOT_ACTIVE' USING ERRCODE = '23514'; END IF;
  -- Serializes every balance check and reservation for this subscription.
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.credits:' || s.id::text, 0));
  o := hon.saas_published_operation(p->>'operationCode');
  IF o.operation_code IS NULL THEN RAISE EXCEPTION 'SAAS_OPERATION_NOT_PRICED' USING ERRCODE = '23514'; END IF;
  IF NOT (o.required_capability = ANY(hon.saas_plan_capabilities(s.plan_code))) THEN RAISE EXCEPTION 'SAAS_OPERATION_NOT_IN_PLAN' USING ERRCODE = '23514'; END IF;
  IF units > o.max_units_per_request THEN RAISE EXCEPTION 'SAAS_OPERATION_UNITS_EXCEEDED' USING ERRCODE = '23514'; END IF;
  at := clock_timestamp();
  v_allowance := hon.saas_current_allowance(s.id, scope.principal_id, at);
  credits := o.credits_per_unit * units;
  available := (hon.saas_allowance_balance(v_allowance)->>'availableCredits')::integer;
  -- No top-up exists and overage is disabled: at or beyond 100% the reservation is refused.
  IF credits > available THEN RAISE EXCEPTION 'SAAS_CREDITS_EXHAUSTED' USING ERRCODE = '23514'; END IF;
  SELECT * INTO e FROM hon.saas_provider_cost_evidence WHERE id = o.cost_evidence_id;
  INSERT INTO hon.saas_credit_reservations(allowance_id, organization_id, school_id, subscription_id, operation_code, pricing_id, category,
      credits_per_unit, estimated_units, reserved_credits, status, status_reason, version, requested_by_principal_id, employee_key, provider_id,
      model_code, action_request_id, work_item_id, reserved_at)
    VALUES (v_allowance, scope.organization_id, p_school, s.id, o.operation_code, o.pricing_id, o.category, o.credits_per_unit, units, credits,
      'RESERVED', 'RESERVED', 1, scope.principal_id, p->>'employeeKey', e.provider_id, e.model_code, (p->>'actionRequestId')::uuid,
      (p->>'workItemId')::uuid, at)
    RETURNING * INTO created;
  INSERT INTO hon.saas_credit_ledger(allowance_id, reservation_id, entry_kind, credits, actor_principal_id, occurred_at)
    VALUES (v_allowance, created.id, 'RESERVE', credits, scope.principal_id, at);
  PERFORM hon.saas_record_thresholds(v_allowance, at);
  snapshot := hon.saas_credit_reservation_json(created, false);
  RETURN hon.saas_record(scope.principal_id, p_key, 'saas.credits.reserve', 'saas.credits.reserved', 'CREDIT_RESERVATION', created.id,
    scope.organization_id, NULL, snapshot, jsonb_build_object('reservation', snapshot, 'allowance', hon.saas_allowance_json(v_allowance) - 'organizationId'), at);
END $$;

-- Writes actual provider usage to the shared AI usage ledger with customer_credits = 0: provider
-- cost is kept separately from premium credits and never counts against ordinary fair-use caps.
CREATE FUNCTION hon.saas_record_provider_usage(r hon.saas_credit_reservations, p_actor uuid, p_cost bigint, p_input bigint, p_output bigint) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE uid uuid;
BEGIN
  INSERT INTO hon.ai_usage_ledger(organization_id, school_id, initiator_principal_id, work_item_id, action_request_id, provider_code, model_code,
      modality, input_units, output_units, provider_cost_microunits, customer_credits, correlation_id)
    VALUES (r.organization_id, r.school_id, p_actor, r.work_item_id, r.action_request_id, r.provider_id, r.model_code,
      CASE r.category WHEN 'IMAGE_GENERATION' THEN 'IMAGE' WHEN 'VIDEO_GENERATION' THEN 'VIDEO' WHEN 'VOICE_GENERATION' THEN 'VOICE_OUTPUT'
        WHEN 'AI_EMPLOYEE_TASK' THEN 'TOOL_EXECUTION' WHEN 'OTHER_APPROVED' THEN 'TOOL_EXECUTION' ELSE 'TEXT' END::hon.ai_modality,
      p_input, p_output, p_cost, 0, r.id)
    RETURNING id INTO uid;
  RETURN uid;
END $$;

-- SETTLE by the requester after the provider call:
-- SUCCEEDED: FINALIZE actual credits (never above the reservation) and RELEASE the remainder.
-- FAILED: RELEASE everything; any provider cost still incurred is recorded, not erased.
-- UNKNOWN: credits stay held, nothing is retried or charged; the HQ owner resolves it with evidence.
CREATE FUNCTION hon.settle_saas_premium_credits(p_subject text, p_reservation uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; replay jsonb; r hon.saas_credit_reservations%ROWTYPE; updated hon.saas_credit_reservations%ROWTYPE; outcome text; keys text[];
  v_units integer; v_credits integer; cost bigint; uid uuid; at timestamptz; snapshot jsonb;
BEGIN
  IF p_reservation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k); outcome := p->>'outcome';
  IF NOT coalesce(keys = ARRAY['expectedVersion','finalUnits','inputUnits','outcome','outputUnits','providerCostMicrounits']
      AND jsonb_typeof(p->'expectedVersion') = 'number' AND (p->>'expectedVersion') ~ '^[1-9][0-9]{0,8}$'
      AND outcome IN ('SUCCEEDED','FAILED','UNKNOWN')
      AND jsonb_typeof(p->'finalUnits') IN ('number','null') AND jsonb_typeof(p->'providerCostMicrounits') IN ('number','null')
      AND jsonb_typeof(p->'inputUnits') IN ('number','null') AND jsonb_typeof(p->'outputUnits') IN ('number','null')
      AND (jsonb_typeof(p->'finalUnits') = 'null' OR (p->>'finalUnits') ~ '^[0-9]{1,6}$')
      AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$')
      AND (jsonb_typeof(p->'inputUnits') = 'null' OR (p->>'inputUnits') ~ '^[0-9]{1,12}$')
      AND (jsonb_typeof(p->'outputUnits') = 'null' OR (p->>'outputUnits') ~ '^[0-9]{1,12}$')
      AND CASE outcome WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'finalUnits') = 'number' AND jsonb_typeof(p->'providerCostMicrounits') = 'number'
        WHEN 'FAILED' THEN jsonb_typeof(p->'finalUnits') = 'null'
        ELSE jsonb_typeof(p->'finalUnits') = 'null' AND jsonb_typeof(p->'providerCostMicrounits') = 'null' END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM hon.saas_credit_reservations WHERE id = p_reservation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  -- Settling never needs a live grant: suspension or deactivation must not strand incurred cost.
  SELECT * INTO scope FROM hon.require_saas_school_actor(p_subject, r.school_id) LIMIT 1;
  IF scope.principal_id <> r.requested_by_principal_id THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  replay := hon.saas_claim_request(scope.principal_id, p_key, 'saas.credits.settle',
    hon.saas_fingerprint(ARRAY['saas.credits.settle', p_reservation::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.credits:' || r.subscription_id::text, 0));
  SELECT * INTO r FROM hon.saas_credit_reservations WHERE id = p_reservation FOR UPDATE;
  IF r.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF r.status <> 'RESERVED' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  cost := (p->>'providerCostMicrounits')::bigint;
  IF outcome = 'SUCCEEDED' THEN
    v_units := (p->>'finalUnits')::integer; v_credits := v_units * r.credits_per_unit;
    IF v_credits > r.reserved_credits THEN RAISE EXCEPTION 'SAAS_FINAL_EXCEEDS_RESERVATION' USING ERRCODE = '23514'; END IF;
    uid := hon.saas_record_provider_usage(r, scope.principal_id, cost, coalesce((p->>'inputUnits')::bigint, 0), coalesce((p->>'outputUnits')::bigint, v_units));
    UPDATE hon.saas_credit_reservations SET status = 'FINALIZED', status_reason = 'PROVIDER_SUCCEEDED', version = version + 1, final_units = v_units,
        final_credits = v_credits, provider_cost_microunits = cost, usage_id = uid, settled_at = at, settled_by_principal_id = scope.principal_id
      WHERE id = r.id RETURNING * INTO updated;
    IF v_credits > 0 THEN
      INSERT INTO hon.saas_credit_ledger(allowance_id, reservation_id, entry_kind, credits, actor_principal_id, occurred_at)
        VALUES (r.allowance_id, r.id, 'FINALIZE', v_credits, scope.principal_id, at);
    END IF;
    IF r.reserved_credits - v_credits > 0 THEN
      INSERT INTO hon.saas_credit_ledger(allowance_id, reservation_id, entry_kind, credits, actor_principal_id, occurred_at)
        VALUES (r.allowance_id, r.id, 'RELEASE', r.reserved_credits - v_credits, scope.principal_id, at);
    END IF;
  ELSIF outcome = 'FAILED' THEN
    IF coalesce(cost, 0) > 0 THEN
      uid := hon.saas_record_provider_usage(r, scope.principal_id, cost, coalesce((p->>'inputUnits')::bigint, 0), coalesce((p->>'outputUnits')::bigint, 0));
    END IF;
    UPDATE hon.saas_credit_reservations SET status = 'RELEASED', status_reason = 'PROVIDER_FAILED', version = version + 1,
        provider_cost_microunits = cost, usage_id = uid, settled_at = at, settled_by_principal_id = scope.principal_id
      WHERE id = r.id RETURNING * INTO updated;
    INSERT INTO hon.saas_credit_ledger(allowance_id, reservation_id, entry_kind, credits, actor_principal_id, occurred_at)
      VALUES (r.allowance_id, r.id, 'RELEASE', r.reserved_credits, scope.principal_id, at);
  ELSE
    UPDATE hon.saas_credit_reservations SET status = 'OUTCOME_UNKNOWN', status_reason = 'PROVIDER_OUTCOME_UNKNOWN', version = version + 1
      WHERE id = r.id RETURNING * INTO updated;
  END IF;
  PERFORM hon.saas_record_thresholds(r.allowance_id, at);
  snapshot := hon.saas_credit_reservation_json(updated, false);
  RETURN hon.saas_record(scope.principal_id, p_key, 'saas.credits.settle', 'saas.credits.settled', 'CREDIT_RESERVATION', r.id, r.organization_id,
    jsonb_build_object('status', r.status, 'version', r.version), snapshot || jsonb_build_object('outcome', outcome),
    jsonb_build_object('reservation', snapshot, 'allowance', hon.saas_allowance_json(r.allowance_id) - 'organizationId'), at);
END $$;

-- HQ owner resolves an OUTCOME_UNKNOWN reservation from provider evidence: SUCCEEDED (finalize
-- actual units and cost) or NOT_CHARGED (release). The evidence reference is required.
CREATE FUNCTION hon.resolve_saas_credit_reservation(p_subject text, p_reservation uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; r hon.saas_credit_reservations%ROWTYPE; updated hon.saas_credit_reservations%ROWTYPE; keys text[]; v_units integer;
  v_credits integer; cost bigint; uid uuid; at timestamptz; snapshot jsonb;
BEGIN
  IF p_reservation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k);
  IF NOT coalesce(keys = ARRAY['evidenceReference','expectedVersion','finalUnits','providerCostMicrounits','resolution']
      AND jsonb_typeof(p->'expectedVersion') = 'number' AND (p->>'expectedVersion') ~ '^[1-9][0-9]{0,8}$'
      AND jsonb_typeof(p->'evidenceReference') = 'string' AND length(p->>'evidenceReference') BETWEEN 1 AND 200 AND btrim(p->>'evidenceReference') = p->>'evidenceReference'
      AND CASE p->>'resolution'
        WHEN 'SUCCEEDED' THEN jsonb_typeof(p->'finalUnits') = 'number' AND (p->>'finalUnits') ~ '^[0-9]{1,6}$'
          AND jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'
        WHEN 'NOT_CHARGED' THEN jsonb_typeof(p->'finalUnits') = 'null'
          AND (jsonb_typeof(p->'providerCostMicrounits') = 'null' OR (jsonb_typeof(p->'providerCostMicrounits') = 'number' AND (p->>'providerCostMicrounits') ~ '^[0-9]{1,15}$'))
        ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.credits.resolve', hon.saas_fingerprint(ARRAY['saas.credits.resolve', p_reservation::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO r FROM hon.saas_credit_reservations WHERE id = p_reservation;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.credits:' || r.subscription_id::text, 0));
  SELECT * INTO r FROM hon.saas_credit_reservations WHERE id = p_reservation FOR UPDATE;
  IF r.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF r.status <> 'OUTCOME_UNKNOWN' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp(); cost := (p->>'providerCostMicrounits')::bigint;
  IF p->>'resolution' = 'SUCCEEDED' THEN
    v_units := (p->>'finalUnits')::integer; v_credits := v_units * r.credits_per_unit;
    IF v_credits > r.reserved_credits THEN RAISE EXCEPTION 'SAAS_FINAL_EXCEEDS_RESERVATION' USING ERRCODE = '23514'; END IF;
    uid := hon.saas_record_provider_usage(r, actor, cost, 0, v_units);
    UPDATE hon.saas_credit_reservations SET status = 'FINALIZED', status_reason = 'HQ_RESOLVED_SUCCEEDED', version = version + 1, final_units = v_units,
        final_credits = v_credits, provider_cost_microunits = cost, usage_id = uid, resolution_reference = p->>'evidenceReference',
        settled_at = at, settled_by_principal_id = actor WHERE id = r.id RETURNING * INTO updated;
    IF v_credits > 0 THEN
      INSERT INTO hon.saas_credit_ledger(allowance_id, reservation_id, entry_kind, credits, actor_principal_id, occurred_at)
        VALUES (r.allowance_id, r.id, 'FINALIZE', v_credits, actor, at);
    END IF;
    IF r.reserved_credits - v_credits > 0 THEN
      INSERT INTO hon.saas_credit_ledger(allowance_id, reservation_id, entry_kind, credits, actor_principal_id, occurred_at)
        VALUES (r.allowance_id, r.id, 'RELEASE', r.reserved_credits - v_credits, actor, at);
    END IF;
  ELSE
    IF coalesce(cost, 0) > 0 THEN uid := hon.saas_record_provider_usage(r, actor, cost, 0, 0); END IF;
    UPDATE hon.saas_credit_reservations SET status = 'RELEASED', status_reason = 'HQ_RESOLVED_NOT_CHARGED', version = version + 1,
        provider_cost_microunits = cost, usage_id = uid, resolution_reference = p->>'evidenceReference', settled_at = at, settled_by_principal_id = actor
      WHERE id = r.id RETURNING * INTO updated;
    INSERT INTO hon.saas_credit_ledger(allowance_id, reservation_id, entry_kind, credits, actor_principal_id, occurred_at)
      VALUES (r.allowance_id, r.id, 'RELEASE', r.reserved_credits, actor, at);
  END IF;
  PERFORM hon.saas_record_thresholds(r.allowance_id, at);
  snapshot := hon.saas_credit_reservation_json(updated, true);
  RETURN hon.saas_record(actor, p_key, 'saas.credits.resolve', 'saas.credits.resolved', 'CREDIT_RESERVATION', r.id, r.organization_id,
    jsonb_build_object('status', r.status, 'version', r.version), snapshot, jsonb_build_object('reservation', snapshot), at);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_credit_program','saas_provider_cost_evidence','saas_pricing_versions','saas_operation_prices','saas_credit_allowances',
    'saas_credit_reservations','saas_credit_ledger','saas_credit_threshold_events'] LOOP
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
      hon.settle_saas_premium_credits(text,uuid,jsonb,uuid,uuid,uuid), hon.resolve_saas_credit_reservation(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
