BEGIN;

-- HON Subscription Billing Milestone B1: versioned HON plan and offer catalog, founder inventory
-- and per-organization HON subscription records. HON billing schools; this is entirely separate
-- from school-to-family billing (billing_accounts, memberships, invoices, payment schedules).
-- Recordkeeping only. No payment provider, checkout, charge, invoice, refund, credit grant,
-- balance, message or Action Engine effect exists here. charges_enabled, credit_grants_enabled,
-- payment_status = NOT_BILLED and paid_through_at IS NULL are pinned by constraint.
-- organization_entitlements stays the sole functional-access authority and is never written
-- here: a subscription records which plan an organization is on and must match its entitlement
-- (changed only through the existing HQ entitlement transition, 0146).
-- Unresolved commercial policies are rows pinned to UNDECIDED; every action that depends on one
-- is refused with SAAS_POLICY_UNDECIDED until a later reviewed migration records the decision.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HON subscription catalog requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'HON subscription catalog requires a restricted runtime';
  END IF;
END $$;

-- ---------- owner decisions not yet made ----------
CREATE TABLE hon.saas_policy_decisions (
  policy_code text PRIMARY KEY CHECK (policy_code IN ('ANNUAL_BILLING','TAXES','PRORATION','PLAN_CHANGE_TIMING','CANCELLATION_TIMING',
    'REFUND_EXECUTION','PAYMENT_PROVIDER','FOUNDER_SLOT_RETURN','CREDIT_ROLLOVER','TOP_UP_PRICING')),
  status text NOT NULL CHECK (status = 'UNDECIDED'),
  blocks text NOT NULL CHECK (length(blocks) BETWEEN 1 AND 300)
);
INSERT INTO hon.saas_policy_decisions(policy_code, status, blocks) VALUES
  ('ANNUAL_BILLING','UNDECIDED','Annual regular and founder offers cannot be drafted'),
  ('TAXES','UNDECIDED','No tax is calculated or recorded; prices are pre-tax list prices'),
  ('PRORATION','UNDECIDED','No proration is calculated'),
  ('PLAN_CHANGE_TIMING','UNDECIDED','Upgrades, downgrades and offer changes on a subscription are refused'),
  ('CANCELLATION_TIMING','UNDECIDED','Cancelling a subscription in service is refused (suspension is available)'),
  ('REFUND_EXECUTION','UNDECIDED','No refund can be recorded or executed (30-day guarantee mechanics come later)'),
  ('PAYMENT_PROVIDER','UNDECIDED','No checkout, charge, invoice or payment evidence exists'),
  ('FOUNDER_SLOT_RETURN','UNDECIDED','An allocated founder slot is never returned to inventory, except when its never-started subscription is voided'),
  ('CREDIT_ROLLOVER','UNDECIDED','Premium credit allowances are planned amounts only; nothing is granted or rolled over'),
  ('TOP_UP_PRICING','UNDECIDED','No premium top-up can be offered or sold');

-- Canonical functional entitlements per plan (owner-approved). Core is the full conventional
-- operating system plus the ordinary assistant; Complete adds the governed AI workforce.
-- Legacy Essential keeps whatever the existing tier checks grant; it is not redefined here.
CREATE FUNCTION hon.saas_plan_capabilities(p_plan text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE p_plan
    WHEN 'ESSENTIAL' THEN ARRAY['legacy.existing_entitlement']
    WHEN 'CORE' THEN ARRAY['crm.families_students_prospects','operations.classes_scheduling_attendance','operations.memberships_payments',
      'progression.testing_curriculum','marketing.connections_reporting','marketing.campaigns_manual_assisted','attribution.conversion',
      'assistant.ordinary','ai.premium_metered','presentation.all_modes','champions.participation']
    WHEN 'COMPLETE' THEN ARRAY['crm.families_students_prospects','operations.classes_scheduling_attendance','operations.memberships_payments',
      'progression.testing_curriculum','marketing.connections_reporting','marketing.campaigns_manual_assisted','attribution.conversion',
      'assistant.ordinary','ai.premium_metered','presentation.all_modes','champions.participation',
      'marketing.campaigns_ai_managed','attribution.ai_insight','ai.workforce','ai.delegated_jobs','ai.orchestration']
  END
$$;

-- ---------- versioned catalog ----------
CREATE TABLE hon.saas_catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_version integer NOT NULL UNIQUE CHECK (catalog_version > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  terms_reference text CHECK (terms_reference IS NULL OR length(terms_reference) BETWEEN 1 AND 500),
  -- Founder inventory and eligibility are owner configuration; NULL or UNDECIDED blocks founder offers.
  founder_total_limit integer CHECK (founder_total_limit BETWEEN 0 AND 1000),
  founder_lifetime_limit integer CHECK (founder_lifetime_limit BETWEEN 0 AND 1000),
  founder_monthly_limit integer CHECK (founder_monthly_limit BETWEEN 0 AND 1000),
  founder_eligibility text NOT NULL CHECK (founder_eligibility IN ('UNDECIDED','NO_PRIOR_CATALOG_SUBSCRIPTION','ANY_ACTIVE_ORGANIZATION')),
  founder_hold_days integer CHECK (founder_hold_days BETWEEN 1 AND 90),
  founder_opens_at timestamptz, founder_closes_at timestamptz,
  charges_enabled boolean NOT NULL DEFAULT false CHECK (charges_enabled = false),
  credit_grants_enabled boolean NOT NULL DEFAULT false CHECK (credit_grants_enabled = false),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  published_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  published_at timestamptz, retired_at timestamptz,
  CHECK (founder_lifetime_limit IS NULL OR founder_total_limit IS NULL OR founder_lifetime_limit <= founder_total_limit),
  CHECK (founder_monthly_limit IS NULL OR founder_total_limit IS NULL OR founder_monthly_limit <= founder_total_limit),
  CHECK (founder_closes_at IS NULL OR founder_opens_at IS NULL OR founder_closes_at > founder_opens_at),
  CHECK ((status = 'DRAFT') = (published_at IS NULL) AND (published_at IS NULL) = (published_by_principal_id IS NULL)),
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX saas_catalog_one_published ON hon.saas_catalog_versions ((true)) WHERE status = 'PUBLISHED';

CREATE TABLE hon.saas_catalog_plans (
  catalog_id uuid NOT NULL REFERENCES hon.saas_catalog_versions(id) ON DELETE RESTRICT,
  plan_code text NOT NULL CHECK (plan_code IN ('ESSENTIAL','CORE','COMPLETE')),
  entitlement_tier hon.plan_tier NOT NULL CHECK (entitlement_tier::text = plan_code),
  availability text NOT NULL CHECK (availability IN ('PUBLIC','LEGACY_ONLY') AND (plan_code = 'ESSENTIAL') = (availability = 'LEGACY_ONLY')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  -- Planned allowance only (B3 accounts for it). Ordinary operations and assistant use never consume it.
  planned_monthly_premium_credits integer CHECK (planned_monthly_premium_credits BETWEEN 0 AND 1000000),
  capabilities text[] NOT NULL CHECK (capabilities = hon.saas_plan_capabilities(plan_code)),
  PRIMARY KEY (catalog_id, plan_code),
  CHECK (plan_code <> 'ESSENTIAL' OR planned_monthly_premium_credits IS NULL)
);

-- Annual kinds do not exist until ANNUAL_BILLING is decided. Essential has no offer.
CREATE TABLE hon.saas_catalog_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id uuid NOT NULL,
  plan_code text NOT NULL CHECK (plan_code IN ('CORE','COMPLETE')),
  offer_kind text NOT NULL CHECK (offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME')),
  billing_interval text NOT NULL CHECK (billing_interval = CASE WHEN offer_kind = 'FOUNDER_LIFETIME' THEN 'LIFETIME' ELSE 'MONTHLY' END),
  price_minor integer NOT NULL CHECK (price_minor BETWEEN 100 AND 10000000),
  FOREIGN KEY (catalog_id, plan_code) REFERENCES hon.saas_catalog_plans(catalog_id, plan_code) ON DELETE RESTRICT,
  UNIQUE (catalog_id, plan_code, offer_kind),
  UNIQUE (id, catalog_id)
);

-- ---------- founder inventory ----------
-- A slot counts while RESERVED (until its hold expires) or once ALLOCATED to a subscription record.
CREATE TABLE hon.saas_founder_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  catalog_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  pool text NOT NULL CHECK (pool IN ('LIFETIME','MONTHLY')),
  status text NOT NULL CHECK (status IN ('RESERVED','ALLOCATED','RELEASED','EXPIRED')),
  status_reason text NOT NULL CHECK (status_reason IN ('RESERVED','SUBSCRIPTION_RECORDED','OWNER_RELEASED','SCHOOL_DECLINED',
    'NOT_ELIGIBLE','HOLD_EXPIRED','SUBSCRIPTION_VOIDED')),
  version integer NOT NULL CHECK (version > 0),
  hold_expires_at timestamptz NOT NULL,
  subscription_id uuid,
  reserved_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  reserved_at timestamptz NOT NULL,
  decided_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  FOREIGN KEY (offer_id, catalog_id) REFERENCES hon.saas_catalog_offers(id, catalog_id) ON DELETE RESTRICT,
  CHECK (hold_expires_at > reserved_at),
  CHECK ((subscription_id IS NOT NULL) = (status = 'ALLOCATED' OR status_reason = 'SUBSCRIPTION_VOIDED')),
  CHECK ((status = 'RESERVED') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by_principal_id IS NULL))
);
CREATE UNIQUE INDEX saas_founder_one_live_per_organization ON hon.saas_founder_reservations (organization_id)
  WHERE status IN ('RESERVED','ALLOCATED');

-- ---------- subscription records ----------
CREATE TABLE hon.saas_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('CATALOG_OFFER','LEGACY_ENTITLEMENT')),
  catalog_id uuid, offer_id uuid,
  plan_code text NOT NULL CHECK (plan_code IN ('ESSENTIAL','CORE','COMPLETE')),
  entitlement_tier hon.plan_tier NOT NULL CHECK (entitlement_tier::text = plan_code),
  offer_kind text CHECK (offer_kind IN ('REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME')),
  billing_interval text NOT NULL CHECK (billing_interval IN ('MONTHLY','LIFETIME','NONE')),
  price_minor integer CHECK (price_minor BETWEEN 100 AND 10000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  founder_reservation_id uuid UNIQUE REFERENCES hon.saas_founder_reservations(id) ON DELETE RESTRICT,
  entitlement_version_at_record integer NOT NULL CHECK (entitlement_version_at_record > 0),
  status text NOT NULL CHECK (status IN ('PENDING_ACTIVATION','IN_SERVICE','SUSPENDED','VOIDED')),
  status_reason text NOT NULL CHECK (status_reason IN ('RECORDED','SERVICE_STARTED','OWNER_HOLD','ACCOUNT_REVIEW','SCHOOL_REQUEST',
    'REVIEW_RESOLVED','PERIOD_ELAPSED','RECORDED_IN_ERROR')),
  version integer NOT NULL CHECK (version > 0),
  service_started_at timestamptz,
  period_anchor_at timestamptz, period_index integer CHECK (period_index >= 0),
  current_period_start timestamptz, current_period_end timestamptz,
  payment_status text NOT NULL DEFAULT 'NOT_BILLED' CHECK (payment_status = 'NOT_BILLED'),
  paid_through_at timestamptz CHECK (paid_through_at IS NULL),
  charges_enabled boolean NOT NULL DEFAULT false CHECK (charges_enabled = false),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  FOREIGN KEY (offer_id, catalog_id) REFERENCES hon.saas_catalog_offers(id, catalog_id) ON DELETE RESTRICT,
  CHECK (CASE source
    WHEN 'CATALOG_OFFER' THEN catalog_id IS NOT NULL AND offer_id IS NOT NULL AND offer_kind IS NOT NULL AND price_minor IS NOT NULL
      AND plan_code <> 'ESSENTIAL' AND billing_interval = CASE WHEN offer_kind = 'FOUNDER_LIFETIME' THEN 'LIFETIME' ELSE 'MONTHLY' END
    ELSE catalog_id IS NULL AND offer_id IS NULL AND offer_kind IS NULL AND price_minor IS NULL AND billing_interval = 'NONE' END),
  CHECK ((founder_reservation_id IS NOT NULL) = (offer_kind IS NOT NULL AND offer_kind LIKE 'FOUNDER_%')),
  CHECK ((status IN ('IN_SERVICE','SUSPENDED')) = (service_started_at IS NOT NULL)),
  CHECK (CASE
    WHEN service_started_at IS NULL OR billing_interval = 'NONE' THEN period_anchor_at IS NULL AND period_index IS NULL
      AND current_period_start IS NULL AND current_period_end IS NULL
    WHEN billing_interval = 'MONTHLY' THEN period_anchor_at = service_started_at AND period_index IS NOT NULL
      AND current_period_start IS NOT NULL AND current_period_end > current_period_start
    ELSE period_anchor_at = service_started_at AND period_index IS NULL AND current_period_start = service_started_at AND current_period_end IS NULL END)
);
CREATE UNIQUE INDEX saas_subscription_one_live_per_organization ON hon.saas_subscriptions (organization_id) WHERE status <> 'VOIDED';
-- Cycle-closing reference; deferrable only so a disposable fixture can remove both rows in one transaction.
ALTER TABLE hon.saas_founder_reservations ADD FOREIGN KEY (subscription_id) REFERENCES hon.saas_subscriptions(id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE hon.saas_subscription_history (
  subscription_id uuid NOT NULL REFERENCES hon.saas_subscriptions(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL, status_reason text NOT NULL,
  period_index integer, current_period_start timestamptz, current_period_end timestamptz,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (subscription_id, version)
);

-- ---------- private idempotency, audit and inert outbox evidence ----------
CREATE TABLE hon.saas_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  operation text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (actor_principal_id, idempotency_key),
  CHECK ((status = 'IN_PROGRESS' AND response_body IS NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND response_body IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE TABLE hon.saas_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL, request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  action_code text NOT NULL CHECK (action_code IN ('saas.catalog.draft','saas.catalog.publish','saas.founder.reserve','saas.founder.release',
    'saas.subscription.record','saas.subscription.command')),
  entity_type text NOT NULL CHECK (entity_type IN ('CATALOG','FOUNDER_RESERVATION','SUBSCRIPTION')),
  entity_id uuid NOT NULL,
  organization_id uuid REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  prior_state jsonb, next_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (actor_principal_id, idempotency_key) REFERENCES hon.saas_requests(actor_principal_id, idempotency_key) ON DELETE RESTRICT,
  UNIQUE (actor_principal_id, idempotency_key)
);
CREATE TABLE hon.saas_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL UNIQUE REFERENCES hon.saas_audit(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('saas.catalog.drafted','saas.catalog.published','saas.founder.reserved','saas.founder.released',
    'saas.subscription.recorded','saas.subscription.changed')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  request_id uuid NOT NULL, correlation_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (payload->'internalOnly' = 'true'::jsonb AND payload->'executionAllowed' = 'false'::jsonb),
  occurred_at timestamptz NOT NULL
);

-- ---------- guards ----------
CREATE FUNCTION hon.guard_saas_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_TABLE_NAME = 'saas_requests' AND TG_OP = 'UPDATE' THEN
    IF OLD.status = 'IN_PROGRESS' AND NEW.status = 'COMPLETED'
      AND NEW.response_body IS NOT NULL AND NEW.completed_at IS NOT NULL
      AND (to_jsonb(NEW) - ARRAY['status','response_body','completed_at']) = (to_jsonb(OLD) - ARRAY['status','response_body','completed_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_EVIDENCE' USING ERRCODE = '42501';
END $$;

CREATE FUNCTION hon.guard_saas_records() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE before_row jsonb; after_row jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_SAAS_RECORD' USING ERRCODE = '42501'; END IF;
  before_row := to_jsonb(OLD); after_row := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'saas_catalog_versions' THEN
    IF (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED'
        AND (after_row - ARRAY['status','published_by_principal_id','published_at']) = (before_row - ARRAY['status','published_by_principal_id','published_at']))
      OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
        AND (after_row - ARRAY['status','retired_at']) = (before_row - ARRAY['status','retired_at'])) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'saas_founder_reservations' THEN
    IF NEW.version = OLD.version + 1
      AND (after_row - ARRAY['status','status_reason','version','subscription_id','decided_by_principal_id','decided_at'])
        = (before_row - ARRAY['status','status_reason','version','subscription_id','decided_by_principal_id','decided_at'])
      AND ((OLD.status = 'RESERVED' AND NEW.status IN ('ALLOCATED','RELEASED','EXPIRED'))
        OR (OLD.status = 'ALLOCATED' AND NEW.status = 'RELEASED' AND NEW.status_reason = 'SUBSCRIPTION_VOIDED'
          AND NEW.subscription_id = OLD.subscription_id)) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'saas_subscriptions' THEN
    IF NEW.version = OLD.version + 1
      AND (after_row - ARRAY['status','status_reason','version','service_started_at','period_anchor_at','period_index',
        'current_period_start','current_period_end','updated_at'])
        = (before_row - ARRAY['status','status_reason','version','service_started_at','period_anchor_at','period_index',
        'current_period_start','current_period_end','updated_at'])
      AND (OLD.service_started_at IS NULL OR (NEW.service_started_at = OLD.service_started_at AND NEW.period_anchor_at IS NOT DISTINCT FROM OLD.period_anchor_at))
      AND ((OLD.status = 'PENDING_ACTIVATION' AND NEW.status IN ('IN_SERVICE','VOIDED'))
        OR (OLD.status = 'IN_SERVICE' AND NEW.status = 'SUSPENDED' AND NEW.period_index IS NOT DISTINCT FROM OLD.period_index)
        OR (OLD.status = 'SUSPENDED' AND NEW.status = 'IN_SERVICE' AND NEW.period_index IS NOT DISTINCT FROM OLD.period_index)
        OR (OLD.status IN ('IN_SERVICE','SUSPENDED') AND NEW.status = OLD.status AND NEW.period_index = OLD.period_index + 1)) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

-- Plans and offers are written once, only into a catalog that is still a draft.
CREATE FUNCTION hon.guard_saas_catalog_rows() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM hon.saas_catalog_versions c WHERE c.id = NEW.catalog_id AND c.status = 'DRAFT') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_SAAS_CATALOG' USING ERRCODE = '42501';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_policy_decisions','saas_subscription_history','saas_requests','saas_audit','saas_outbox'] LOOP
    EXECUTE format('CREATE TRIGGER saas_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_evidence()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_evidence()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['saas_catalog_versions','saas_founder_reservations','saas_subscriptions'] LOOP
    EXECUTE format('CREATE TRIGGER saas_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_records()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_records()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['saas_catalog_plans','saas_catalog_offers'] LOOP
    EXECUTE format('CREATE TRIGGER saas_catalog_rows BEFORE INSERT OR UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_catalog_rows()',t);
    EXECUTE format('CREATE TRIGGER saas_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_saas_catalog_rows()',t);
  END LOOP;
END $$;

-- ---------- authority ----------
CREATE FUNCTION hon.saas_refuse_context() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['app.hon_organization_id','app.hon_school_id','app.hon_family_id',
      'app.hon_principal_id','app.hon_principal_type','app.hon_source','app.hon_action_request_id','app.hon_delegated_by_principal_id']) setting
      WHERE nullif(current_setting(setting,true),'') IS NOT NULL) THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
END $$;

-- HQ owner, or HQ operator with hq.billing.manage (reads and catalog drafts only). Publishing,
-- founder inventory and subscription records are owner-only. Support and family identities are refused.
CREATE FUNCTION hon.require_saas_hq_actor(p_subject text, p_owner_only boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.saas_refuse_context();
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject OR p_owner_only IS NULL THEN
    RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.is_active AND p.principal_type = 'HUMAN_USER'
    AND (SELECT count(*) FROM hon.principals other WHERE other.user_id = u.id AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.hq_operator_grants g WHERE g.principal_id = p.id
      AND g.effective_from <= clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until > clock_timestamp())
      AND (g.hq_role = 'HON_HQ_OWNER'
        OR (NOT p_owner_only AND g.hq_role = 'HON_HQ_OPERATOR' AND 'hq.billing.manage' = ANY(g.permission_codes))))
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id = p.id
      AND f.effective_from <= clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until > clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- ---------- private helpers ----------
CREATE FUNCTION hon.saas_claim_request(p_actor uuid, p_key uuid, p_operation text, p_fingerprint text,
  p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE receipt hon.saas_requests%ROWTYPE;
BEGIN
  IF p_key IS NULL OR p_request IS NULL OR p_correlation IS NULL THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('saas:' || p_actor::text || ':' || p_key::text, 0)) THEN
    RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  SELECT * INTO receipt FROM hon.saas_requests r WHERE r.actor_principal_id = p_actor AND r.idempotency_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF receipt.operation <> p_operation OR receipt.request_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'SAAS_KEY_REUSED' USING ERRCODE = '23505';
    END IF;
    IF receipt.status <> 'COMPLETED' THEN RAISE EXCEPTION 'SAAS_REQUEST_IN_PROGRESS' USING ERRCODE = '55P03'; END IF;
    RETURN receipt.response_body || jsonb_build_object('replayed', true);
  END IF;
  INSERT INTO hon.saas_requests(actor_principal_id,idempotency_key,operation,request_fingerprint,request_id,correlation_id,status)
    VALUES (p_actor,p_key,p_operation,p_fingerprint,p_request,p_correlation,'IN_PROGRESS');
  RETURN NULL;
END $$;

CREATE FUNCTION hon.saas_record(p_actor uuid, p_key uuid, p_action text, p_event text, p_entity_type text, p_entity uuid,
  p_organization uuid, p_prior jsonb, p_next jsonb, p_response jsonb, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE receipt hon.saas_requests%ROWTYPE; audit uuid;
BEGIN
  SELECT * INTO receipt FROM hon.saas_requests WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  INSERT INTO hon.saas_audit(actor_principal_id,idempotency_key,request_id,correlation_id,action_code,entity_type,entity_id,organization_id,prior_state,next_state,occurred_at)
    VALUES (p_actor,p_key,receipt.request_id,receipt.correlation_id,p_action,p_entity_type,p_entity,p_organization,p_prior,p_next,p_at)
    RETURNING id INTO audit;
  INSERT INTO hon.saas_outbox(audit_id,event_type,request_id,correlation_id,payload,occurred_at)
    VALUES (audit,p_event,receipt.request_id,receipt.correlation_id,
      jsonb_build_object('entityType',p_entity_type,'entityId',p_entity,'next',p_next,'internalOnly',true,'executionAllowed',false),p_at);
  UPDATE hon.saas_requests SET status = 'COMPLETED', response_body = p_response, completed_at = p_at
    WHERE actor_principal_id = p_actor AND idempotency_key = p_key;
  RETURN p_response || jsonb_build_object('replayed', false);
END $$;

CREATE FUNCTION hon.saas_fingerprint(p_parts text[]) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT encode(sha256(convert_to(array_to_string(p_parts, chr(31), ''), 'UTF8')), 'hex')
$$;

CREATE FUNCTION hon.saas_ts(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon AS $$
  SELECT CASE WHEN p_at IS NULL THEN NULL ELSE to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$$;

-- Refuses any action whose owner decision is still UNDECIDED.
CREATE FUNCTION hon.saas_require_policy(p_code text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.saas_policy_decisions d WHERE d.policy_code = p_code AND d.status <> 'UNDECIDED') THEN
    RAISE EXCEPTION 'SAAS_POLICY_UNDECIDED' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION hon.saas_catalog_json(p_catalog uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('catalogId',c.id,'catalogVersion',c.catalog_version,'status',c.status,'currency',c.currency,
    'termsReference',c.terms_reference,
    'plans',(SELECT jsonb_agg(jsonb_build_object('planCode',p.plan_code,'entitlementTier',p.entitlement_tier::text,'availability',p.availability,
        'displayName',p.display_name,'plannedMonthlyPremiumCredits',p.planned_monthly_premium_credits,'capabilities',to_jsonb(p.capabilities),
        'ordinaryUseConsumesCredits',false)
      ORDER BY array_position(ARRAY['CORE','COMPLETE','ESSENTIAL'], p.plan_code)) FROM hon.saas_catalog_plans p WHERE p.catalog_id = c.id),
    'offers',(SELECT coalesce(jsonb_agg(jsonb_build_object('offerId',o.id,'planCode',o.plan_code,'offerKind',o.offer_kind,
        'billingInterval',o.billing_interval,'priceMinor',o.price_minor,'founder',o.offer_kind LIKE 'FOUNDER_%',
        'allowance','FULL_MONTHLY_PLAN_ALLOWANCE')
      ORDER BY array_position(ARRAY['CORE','COMPLETE'], o.plan_code), array_position(ARRAY['REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME'], o.offer_kind)),'[]'::jsonb)
      FROM hon.saas_catalog_offers o WHERE o.catalog_id = c.id),
    'founderProgram',jsonb_build_object('totalLimit',c.founder_total_limit,'lifetimeLimit',c.founder_lifetime_limit,'monthlyLimit',c.founder_monthly_limit,
      'eligibility',c.founder_eligibility,'reservationHoldDays',c.founder_hold_days,'opensAt',hon.saas_ts(c.founder_opens_at),'closesAt',hon.saas_ts(c.founder_closes_at)),
    'chargesEnabled',false,'creditGrantsEnabled',false,
    'createdAt',hon.saas_ts(c.created_at),'publishedAt',hon.saas_ts(c.published_at),'retiredAt',hon.saas_ts(c.retired_at))
  FROM hon.saas_catalog_versions c WHERE c.id = p_catalog
$$;

-- Live founder inventory against the published catalog's owner-configured limits.
CREATE FUNCTION hon.saas_founder_inventory(p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH pub AS (SELECT * FROM hon.saas_catalog_versions WHERE status = 'PUBLISHED'),
  used AS (SELECT
      count(*) FILTER (WHERE pool = 'LIFETIME' AND status = 'ALLOCATED') la,
      count(*) FILTER (WHERE pool = 'LIFETIME' AND status = 'RESERVED' AND hold_expires_at > p_at) lh,
      count(*) FILTER (WHERE pool = 'MONTHLY' AND status = 'ALLOCATED') ma,
      count(*) FILTER (WHERE pool = 'MONTHLY' AND status = 'RESERVED' AND hold_expires_at > p_at) mh
    FROM hon.saas_founder_reservations),
  lim AS (SELECT (SELECT founder_total_limit FROM pub) t, (SELECT founder_lifetime_limit FROM pub) l, (SELECT founder_monthly_limit FROM pub) m,
    (SELECT founder_eligibility FROM pub) e, (SELECT count(*) FROM pub) n)
  SELECT jsonb_build_object(
    'status', CASE WHEN lim.n = 0 THEN 'NOT_PUBLISHED' WHEN lim.t IS NULL OR lim.e = 'UNDECIDED' THEN 'UNDECIDED' ELSE 'CONFIGURED' END,
    'totalLimit', lim.t, 'lifetimeLimit', lim.l, 'monthlyLimit', lim.m,
    'lifetime', jsonb_build_object('allocated', used.la, 'held', used.lh),
    'monthly', jsonb_build_object('allocated', used.ma, 'held', used.mh),
    'remaining', jsonb_build_object(
      'total', CASE WHEN lim.t IS NULL THEN NULL ELSE greatest(lim.t - (used.la + used.lh + used.ma + used.mh), 0) END,
      'lifetime', CASE WHEN lim.t IS NULL OR lim.l IS NULL THEN NULL
        ELSE greatest(least(lim.l - (used.la + used.lh), lim.t - (used.la + used.lh + used.ma + used.mh)), 0) END,
      'monthly', CASE WHEN lim.t IS NULL OR lim.m IS NULL THEN NULL
        ELSE greatest(least(lim.m - (used.ma + used.mh), lim.t - (used.la + used.lh + used.ma + used.mh)), 0) END))
  FROM used, lim
$$;

CREATE FUNCTION hon.saas_reservation_json(r hon.saas_founder_reservations, p_at timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('reservationId',r.id,'organizationId',r.organization_id,
    'organizationName',(SELECT o.display_name FROM hon.organizations o WHERE o.id = r.organization_id),
    'offerId',r.offer_id,'planCode',o.plan_code,'offerKind',o.offer_kind,'pool',r.pool,'status',r.status,'statusReason',r.status_reason,
    'version',r.version,'holdExpiresAt',hon.saas_ts(r.hold_expires_at),'holdExpired',r.status = 'RESERVED' AND r.hold_expires_at <= p_at,
    'subscriptionId',r.subscription_id,'reservedAt',hon.saas_ts(r.reserved_at),'decidedAt',hon.saas_ts(r.decided_at))
  FROM hon.saas_catalog_offers o WHERE o.id = r.offer_id
$$;

CREATE FUNCTION hon.saas_subscription_json(s hon.saas_subscriptions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('subscriptionId',s.id,'organizationId',s.organization_id,
    'organizationName',(SELECT o.display_name FROM hon.organizations o WHERE o.id = s.organization_id),
    'source',s.source,'catalogVersion',(SELECT c.catalog_version FROM hon.saas_catalog_versions c WHERE c.id = s.catalog_id),
    'offerId',s.offer_id,'planCode',s.plan_code,'entitlementTier',s.entitlement_tier::text,'offerKind',s.offer_kind,
    'billingInterval',s.billing_interval,'priceMinor',s.price_minor,'currency',s.currency,'founderReservationId',s.founder_reservation_id,
    'status',s.status,'statusReason',s.status_reason,'version',s.version,'serviceStartedAt',hon.saas_ts(s.service_started_at),
    'currentPeriod',CASE WHEN s.current_period_start IS NULL THEN NULL ELSE jsonb_build_object('index',s.period_index,
      'startsAt',hon.saas_ts(s.current_period_start),'endsAt',hon.saas_ts(s.current_period_end)) END,
    'paymentStatus',s.payment_status,'paidThroughAt',NULL,'chargesEnabled',false,
    'premiumCredits',jsonb_build_object('plannedMonthlyAllowance',
      (SELECT p.planned_monthly_premium_credits FROM hon.saas_catalog_plans p WHERE p.catalog_id = s.catalog_id AND p.plan_code = s.plan_code),
      'status','NOT_GRANTED'),
    'createdAt',hon.saas_ts(s.created_at),'updatedAt',hon.saas_ts(s.updated_at))
$$;

CREATE FUNCTION hon.saas_policies_json() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_agg(jsonb_build_object('policyCode',d.policy_code,'status',d.status,'blocks',d.blocks) ORDER BY d.policy_code COLLATE "C")
  FROM hon.saas_policy_decisions d
$$;

-- ---------- catalog ----------
CREATE FUNCTION hon.read_saas_catalog_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE published jsonb; drafts jsonb;
BEGIN
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT hon.saas_catalog_json(c.id) INTO published FROM hon.saas_catalog_versions c WHERE c.status = 'PUBLISHED';
  SELECT coalesce(jsonb_agg(hon.saas_catalog_json(d.id) ORDER BY d.catalog_version DESC), '[]'::jsonb) INTO drafts
    FROM (SELECT id, catalog_version FROM hon.saas_catalog_versions WHERE status = 'DRAFT' ORDER BY catalog_version DESC LIMIT 10) d;
  RETURN jsonb_build_object('published', published, 'drafts', drafts, 'policies', hon.saas_policies_json(),
    'founderInventory', hon.saas_founder_inventory(clock_timestamp()),
    'chargesEnabled', false, 'creditGrantsEnabled', false, 'paymentProvider', 'NOT_CONFIGURED');
END $$;

-- Drafts are immutable; a revision is a new draft version. Essential is added as LEGACY_ONLY
-- with no offer. Capabilities are canonical and not part of the input.
CREATE FUNCTION hon.create_saas_catalog_draft(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; fp jsonb; item jsonb; created hon.saas_catalog_versions%ROWTYPE; next_version integer; at timestamptz; snapshot jsonb;
  num constant text := '^[0-9]{1,8}$';
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['founderProgram','offers','plans','termsReference']
    OR jsonb_typeof(p->'termsReference') NOT IN ('string','null')
    OR (jsonb_typeof(p->'termsReference') = 'string' AND (length(p->>'termsReference') NOT BETWEEN 1 AND 500 OR btrim(p->>'termsReference') <> p->>'termsReference'))
    OR jsonb_typeof(p->'plans') <> 'array' OR jsonb_array_length(p->'plans') <> 2
    OR jsonb_typeof(p->'offers') <> 'array' OR jsonb_array_length(p->'offers') NOT BETWEEN 1 AND 6
    OR jsonb_typeof(p->'founderProgram') <> 'object' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'plans') LOOP
    IF jsonb_typeof(item) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k) IS DISTINCT FROM ARRAY['displayName','planCode','plannedMonthlyPremiumCredits']
      OR item->>'planCode' NOT IN ('CORE','COMPLETE') OR jsonb_typeof(item->'planCode') <> 'string'
      OR jsonb_typeof(item->'displayName') <> 'string' OR length(item->>'displayName') NOT BETWEEN 1 AND 80 OR btrim(item->>'displayName') <> item->>'displayName'
      OR jsonb_typeof(item->'plannedMonthlyPremiumCredits') NOT IN ('number','null')
      OR (jsonb_typeof(item->'plannedMonthlyPremiumCredits') = 'number' AND ((item->>'plannedMonthlyPremiumCredits') !~ num
        OR (item->>'plannedMonthlyPremiumCredits')::bigint > 1000000)) THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'planCode') FROM jsonb_array_elements(p->'plans')) <> 2 THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'offers') LOOP
    IF jsonb_typeof(item) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k) IS DISTINCT FROM ARRAY['offerKind','planCode','priceMinor']
      OR jsonb_typeof(item->'planCode') <> 'string' OR item->>'planCode' NOT IN ('CORE','COMPLETE')
      OR jsonb_typeof(item->'offerKind') <> 'string'
      OR item->>'offerKind' NOT IN ('REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL','FOUNDER_LIFETIME')
      OR jsonb_typeof(item->'priceMinor') <> 'number' OR (item->>'priceMinor') !~ num
      OR (item->>'priceMinor')::bigint NOT BETWEEN 100 AND 10000000 THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (value->>'planCode') || ':' || (value->>'offerKind')) FROM jsonb_array_elements(p->'offers')) <> jsonb_array_length(p->'offers') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  fp := p->'founderProgram';
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(fp) k) IS DISTINCT FROM ARRAY['closesAt','eligibility','lifetimeLimit','monthlyLimit','opensAt','reservationHoldDays','totalLimit']
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['totalLimit','lifetimeLimit','monthlyLimit','reservationHoldDays']) k
      WHERE jsonb_typeof(fp->k) NOT IN ('number','null') OR (jsonb_typeof(fp->k) = 'number' AND ((fp->>k) !~ '^[0-9]{1,4}$' OR (fp->>k)::integer > 1000)))
    OR (jsonb_typeof(fp->'reservationHoldDays') = 'number' AND (fp->>'reservationHoldDays')::integer NOT BETWEEN 1 AND 90)
    OR jsonb_typeof(fp->'eligibility') <> 'string' OR fp->>'eligibility' NOT IN ('UNDECIDED','NO_PRIOR_CATALOG_SUBSCRIPTION','ANY_ACTIVE_ORGANIZATION')
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['opensAt','closesAt']) k WHERE jsonb_typeof(fp->k) NOT IN ('string','null')
      OR (jsonb_typeof(fp->k) = 'string' AND (fp->>k) !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  -- Annual billing has no owner decision yet.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->'offers') o WHERE o->>'offerKind' LIKE '%_ANNUAL') THEN
    PERFORM hon.saas_require_policy('ANNUAL_BILLING');
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, false);
  replay := hon.saas_claim_request(actor, p_key, 'saas.catalog.draft', hon.saas_fingerprint(ARRAY['saas.catalog.draft', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  LOCK TABLE hon.saas_catalog_versions IN SHARE ROW EXCLUSIVE MODE;
  SELECT coalesce(max(catalog_version), 0) + 1 INTO next_version FROM hon.saas_catalog_versions;
  at := clock_timestamp();
  INSERT INTO hon.saas_catalog_versions(catalog_version,status,terms_reference,founder_total_limit,founder_lifetime_limit,founder_monthly_limit,
      founder_eligibility,founder_hold_days,founder_opens_at,founder_closes_at,created_by_principal_id,created_at)
    VALUES (next_version,'DRAFT',p->>'termsReference',(fp->>'totalLimit')::integer,(fp->>'lifetimeLimit')::integer,(fp->>'monthlyLimit')::integer,
      fp->>'eligibility',(fp->>'reservationHoldDays')::integer,(fp->>'opensAt')::timestamptz,(fp->>'closesAt')::timestamptz,actor,at)
    RETURNING * INTO created;
  INSERT INTO hon.saas_catalog_plans(catalog_id,plan_code,entitlement_tier,availability,display_name,planned_monthly_premium_credits,capabilities)
    SELECT created.id, x->>'planCode', (x->>'planCode')::hon.plan_tier, 'PUBLIC', x->>'displayName',
      (x->>'plannedMonthlyPremiumCredits')::integer, hon.saas_plan_capabilities(x->>'planCode')
    FROM jsonb_array_elements(p->'plans') x
    UNION ALL SELECT created.id, 'ESSENTIAL', 'ESSENTIAL', 'LEGACY_ONLY', 'HON Essential (legacy)', NULL, hon.saas_plan_capabilities('ESSENTIAL');
  INSERT INTO hon.saas_catalog_offers(catalog_id,plan_code,offer_kind,billing_interval,price_minor)
    SELECT created.id, x->>'planCode', x->>'offerKind', CASE WHEN x->>'offerKind' = 'FOUNDER_LIFETIME' THEN 'LIFETIME' ELSE 'MONTHLY' END,
      (x->>'priceMinor')::integer
    FROM jsonb_array_elements(p->'offers') x;
  snapshot := hon.saas_catalog_json(created.id);
  RETURN hon.saas_record(actor, p_key, 'saas.catalog.draft', 'saas.catalog.drafted', 'CATALOG', created.id, NULL, NULL, snapshot,
    jsonb_build_object('catalog', snapshot), at);
END $$;

-- HQ owner only. Every decision a published offer depends on must be set. The previous published
-- catalog retires; existing subscription records keep the offer they were recorded on.
CREATE FUNCTION hon.publish_saas_catalog(p_subject text, p_catalog uuid, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; draft hon.saas_catalog_versions%ROWTYPE; prior hon.saas_catalog_versions%ROWTYPE; at timestamptz;
  inventory jsonb; has_monthly boolean; has_lifetime boolean; snapshot jsonb;
BEGIN
  IF p_catalog IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.catalog.publish', hon.saas_fingerprint(ARRAY['saas.catalog.publish', p_catalog::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  LOCK TABLE hon.saas_catalog_versions IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  SELECT * INTO draft FROM hon.saas_catalog_versions WHERE id = p_catalog FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF draft.status <> 'DRAFT' THEN RAISE EXCEPTION 'SAAS_CATALOG_NOT_DRAFT' USING ERRCODE = '40001'; END IF;
  SELECT bool_or(offer_kind = 'FOUNDER_MONTHLY'), bool_or(offer_kind = 'FOUNDER_LIFETIME') INTO has_monthly, has_lifetime
    FROM hon.saas_catalog_offers WHERE catalog_id = p_catalog;
  IF draft.terms_reference IS NULL
    OR EXISTS (SELECT 1 FROM hon.saas_catalog_plans WHERE catalog_id = p_catalog AND plan_code <> 'ESSENTIAL' AND planned_monthly_premium_credits IS NULL)
    OR (SELECT count(*) FROM hon.saas_catalog_offers WHERE catalog_id = p_catalog AND offer_kind = 'REGULAR_MONTHLY') <> 2
    OR ((has_monthly OR has_lifetime) AND (draft.founder_total_limit IS NULL OR draft.founder_eligibility = 'UNDECIDED'
      OR draft.founder_hold_days IS NULL OR draft.founder_opens_at IS NULL))
    OR (has_monthly AND draft.founder_monthly_limit IS NULL) OR (has_lifetime AND draft.founder_lifetime_limit IS NULL) THEN
    RAISE EXCEPTION 'SAAS_CATALOG_UNDECIDED' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  -- Lowering a limit below slots already held or allocated is refused; nothing is silently revoked.
  inventory := hon.saas_founder_inventory(at);
  IF (draft.founder_total_limit IS NOT NULL AND draft.founder_total_limit < (inventory#>>'{lifetime,allocated}')::int + (inventory#>>'{lifetime,held}')::int
        + (inventory#>>'{monthly,allocated}')::int + (inventory#>>'{monthly,held}')::int)
    OR (draft.founder_lifetime_limit IS NOT NULL AND draft.founder_lifetime_limit < (inventory#>>'{lifetime,allocated}')::int + (inventory#>>'{lifetime,held}')::int)
    OR (draft.founder_monthly_limit IS NOT NULL AND draft.founder_monthly_limit < (inventory#>>'{monthly,allocated}')::int + (inventory#>>'{monthly,held}')::int) THEN
    RAISE EXCEPTION 'SAAS_FOUNDER_LIMIT_BELOW_USAGE' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO prior FROM hon.saas_catalog_versions WHERE status = 'PUBLISHED' FOR UPDATE;
  IF FOUND THEN UPDATE hon.saas_catalog_versions SET status = 'RETIRED', retired_at = at WHERE id = prior.id; END IF;
  UPDATE hon.saas_catalog_versions SET status = 'PUBLISHED', published_by_principal_id = actor, published_at = at WHERE id = p_catalog;
  snapshot := hon.saas_catalog_json(p_catalog);
  RETURN hon.saas_record(actor, p_key, 'saas.catalog.publish', 'saas.catalog.published', 'CATALOG', p_catalog, NULL,
    CASE WHEN prior.id IS NULL THEN NULL ELSE jsonb_build_object('retiredCatalogId', prior.id, 'catalogVersion', prior.catalog_version) END, snapshot,
    jsonb_build_object('catalog', snapshot, 'retiredCatalogId', CASE WHEN prior.id IS NULL THEN NULL ELSE to_jsonb(prior.id) END), at);
END $$;

-- ---------- founder inventory ----------
CREATE FUNCTION hon.read_saas_founder_reservations_from_hq(p_subject text, p_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE rows jsonb; at timestamptz := clock_timestamp();
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('RESERVED','ALLOCATED','RELEASED','EXPIRED') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT coalesce(jsonb_agg(hon.saas_reservation_json(r, at) ORDER BY r.reserved_at DESC, r.id), '[]'::jsonb) INTO rows
    FROM (SELECT * FROM hon.saas_founder_reservations WHERE p_status IS NULL OR status = p_status ORDER BY reserved_at DESC, id LIMIT 200) r;
  RETURN jsonb_build_object('reservations', rows, 'inventory', hon.saas_founder_inventory(at), 'limit', 200);
END $$;

-- HQ owner only. Serialized globally so two concurrent reservations can never oversell a pool.
CREATE FUNCTION hon.reserve_saas_founder_offer(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; v_org uuid; v_offer hon.saas_catalog_offers%ROWTYPE; v_catalog hon.saas_catalog_versions%ROWTYPE;
  v_pool text; stale hon.saas_founder_reservations%ROWTYPE; created hon.saas_founder_reservations%ROWTYPE; at timestamptz; inventory jsonb; snapshot jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['offerId','organizationId']
    OR jsonb_typeof(p->'offerId') <> 'string' OR jsonb_typeof(p->'organizationId') <> 'string' THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_org := (p->>'organizationId')::uuid;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.founder.reserve', hon.saas_fingerprint(ARRAY['saas.founder.reserve', v_org::text, p->>'offerId']), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || v_org::text, 0));
  LOCK TABLE hon.saas_catalog_versions IN SHARE MODE;
  PERFORM 1 FROM hon.organizations o WHERE o.id = v_org AND o.status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT c.* INTO v_catalog FROM hon.saas_catalog_versions c WHERE c.status = 'PUBLISHED';
  SELECT o.* INTO v_offer FROM hon.saas_catalog_offers o WHERE o.id = (p->>'offerId')::uuid AND o.catalog_id = v_catalog.id;
  IF v_catalog.id IS NULL OR v_offer.id IS NULL THEN RAISE EXCEPTION 'SAAS_OFFER_NOT_AVAILABLE' USING ERRCODE = '23514'; END IF;
  IF v_offer.offer_kind NOT LIKE 'FOUNDER_%' THEN RAISE EXCEPTION 'SAAS_OFFER_NOT_FOUNDER' USING ERRCODE = '23514'; END IF;
  v_pool := CASE WHEN v_offer.offer_kind = 'FOUNDER_LIFETIME' THEN 'LIFETIME' ELSE 'MONTHLY' END;
  at := clock_timestamp();
  IF at < v_catalog.founder_opens_at OR (v_catalog.founder_closes_at IS NOT NULL AND at >= v_catalog.founder_closes_at) THEN
    RAISE EXCEPTION 'SAAS_FOUNDER_WINDOW_CLOSED' USING ERRCODE = '23514';
  END IF;
  IF v_catalog.founder_eligibility = 'NO_PRIOR_CATALOG_SUBSCRIPTION' AND EXISTS (SELECT 1 FROM hon.saas_subscriptions s
      WHERE s.organization_id = v_org AND s.source = 'CATALOG_OFFER' AND s.status <> 'VOIDED') THEN
    RAISE EXCEPTION 'SAAS_FOUNDER_NOT_ELIGIBLE' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO stale FROM hon.saas_founder_reservations r WHERE r.organization_id = v_org AND r.status IN ('RESERVED','ALLOCATED') FOR UPDATE;
  IF FOUND THEN
    IF stale.status = 'RESERVED' AND stale.hold_expires_at <= at THEN
      UPDATE hon.saas_founder_reservations SET status = 'EXPIRED', status_reason = 'HOLD_EXPIRED', version = version + 1,
        decided_by_principal_id = actor, decided_at = at WHERE id = stale.id;
    ELSE
      RAISE EXCEPTION 'SAAS_FOUNDER_ALREADY_RESERVED' USING ERRCODE = '23514';
    END IF;
  END IF;
  inventory := hon.saas_founder_inventory(at);
  IF coalesce((inventory#>>'{remaining,total}')::int, 0) < 1
    OR coalesce((inventory#>>ARRAY['remaining', lower(v_pool)])::int, 0) < 1 THEN
    RAISE EXCEPTION 'SAAS_FOUNDER_SOLD_OUT' USING ERRCODE = '23514';
  END IF;
  INSERT INTO hon.saas_founder_reservations(organization_id,catalog_id,offer_id,pool,status,status_reason,version,hold_expires_at,
      reserved_by_principal_id,reserved_at)
    VALUES (v_org,v_catalog.id,v_offer.id,v_pool,'RESERVED','RESERVED',1,at + make_interval(days => v_catalog.founder_hold_days),actor,at)
    RETURNING * INTO created;
  snapshot := hon.saas_reservation_json(created, at);
  RETURN hon.saas_record(actor, p_key, 'saas.founder.reserve', 'saas.founder.reserved', 'FOUNDER_RESERVATION', created.id, v_org,
    CASE WHEN stale.id IS NULL THEN NULL ELSE jsonb_build_object('expiredReservationId', stale.id) END, snapshot,
    jsonb_build_object('reservation', snapshot, 'inventory', hon.saas_founder_inventory(at)), at);
END $$;

-- HQ owner only. Only a held (RESERVED) slot can be released; an allocated slot stays consumed
-- until FOUNDER_SLOT_RETURN is decided.
CREATE FUNCTION hon.release_saas_founder_reservation(p_subject text, p_reservation uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_founder_reservations%ROWTYPE; updated hon.saas_founder_reservations%ROWTYPE; at timestamptz; snapshot jsonb;
BEGIN
  IF p_reservation IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion','reasonCode']
    OR jsonb_typeof(p->'expectedVersion') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'reasonCode') <> 'string' OR p->>'reasonCode' NOT IN ('OWNER_RELEASED','SCHOOL_DECLINED','NOT_ELIGIBLE','HOLD_EXPIRED') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.founder.release', hon.saas_fingerprint(ARRAY['saas.founder.release', p_reservation::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  SELECT * INTO prior FROM hon.saas_founder_reservations WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF prior.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF prior.status <> 'RESERVED' THEN RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
  at := clock_timestamp();
  UPDATE hon.saas_founder_reservations SET status = CASE WHEN p->>'reasonCode' = 'HOLD_EXPIRED' THEN 'EXPIRED' ELSE 'RELEASED' END,
      status_reason = p->>'reasonCode', version = version + 1, decided_by_principal_id = actor, decided_at = at
    WHERE id = p_reservation RETURNING * INTO updated;
  snapshot := hon.saas_reservation_json(updated, at);
  RETURN hon.saas_record(actor, p_key, 'saas.founder.release', 'saas.founder.released', 'FOUNDER_RESERVATION', updated.id, updated.organization_id,
    hon.saas_reservation_json(prior, at), snapshot, jsonb_build_object('reservation', snapshot, 'inventory', hon.saas_founder_inventory(at)), at);
END $$;

-- ---------- subscription records ----------
CREATE FUNCTION hon.read_saas_subscriptions_from_hq(p_subject text, p_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE rows jsonb;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('PENDING_ACTIVATION','IN_SERVICE','SUSPENDED','VOIDED') THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT coalesce(jsonb_agg(hon.saas_subscription_json(s) ORDER BY s.created_at DESC, s.id), '[]'::jsonb) INTO rows
    FROM (SELECT * FROM hon.saas_subscriptions WHERE p_status IS NULL OR status = p_status ORDER BY created_at DESC, id LIMIT 200) s;
  RETURN jsonb_build_object('subscriptions', rows, 'limit', 200, 'chargesEnabled', false);
END $$;

CREATE FUNCTION hon.read_saas_organization_subscription_from_hq(p_subject text, p_organization uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE org hon.organizations%ROWTYPE; ent hon.organization_entitlements%ROWTYPE; cur hon.saas_subscriptions%ROWTYPE; history jsonb; reservations jsonb;
  at timestamptz := clock_timestamp(); alignment text;
BEGIN
  IF p_organization IS NULL THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_saas_hq_actor(p_subject, false);
  SELECT * INTO org FROM hon.organizations WHERE id = p_organization;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO ent FROM hon.organization_entitlements WHERE organization_id = p_organization;
  SELECT * INTO cur FROM hon.saas_subscriptions WHERE organization_id = p_organization AND status <> 'VOIDED';
  alignment := CASE WHEN ent.organization_id IS NULL THEN 'NO_ENTITLEMENT' WHEN cur.id IS NULL THEN 'NO_SUBSCRIPTION'
    WHEN cur.entitlement_tier = ent.tier THEN 'ALIGNED' ELSE 'MISMATCH' END;
  SELECT coalesce(jsonb_agg(jsonb_build_object('subscriptionId',h.subscription_id,'version',h.version,'status',h.status,'statusReason',h.status_reason,
      'periodIndex',h.period_index,'periodStartsAt',hon.saas_ts(h.current_period_start),'periodEndsAt',hon.saas_ts(h.current_period_end),
      'occurredAt',hon.saas_ts(h.occurred_at)) ORDER BY h.occurred_at DESC, h.version DESC), '[]'::jsonb) INTO history
    FROM (SELECT h.* FROM hon.saas_subscription_history h JOIN hon.saas_subscriptions s ON s.id = h.subscription_id
      WHERE s.organization_id = p_organization ORDER BY h.occurred_at DESC, h.version DESC LIMIT 50) h;
  SELECT coalesce(jsonb_agg(hon.saas_reservation_json(r, at) ORDER BY r.reserved_at DESC, r.id), '[]'::jsonb) INTO reservations
    FROM (SELECT * FROM hon.saas_founder_reservations WHERE organization_id = p_organization ORDER BY reserved_at DESC, id LIMIT 20) r;
  RETURN jsonb_build_object('organizationId', org.id, 'organizationName', org.display_name, 'organizationStatus', org.status::text,
    'entitlement', CASE WHEN ent.organization_id IS NULL THEN NULL ELSE jsonb_build_object('tier', ent.tier::text, 'status', ent.status::text,
      'version', ent.version, 'effectiveFrom', hon.saas_ts(ent.effective_from), 'effectiveUntil', hon.saas_ts(ent.effective_until)) END,
    'current', CASE WHEN cur.id IS NULL THEN NULL ELSE hon.saas_subscription_json(cur) END,
    'alignment', alignment, 'history', history, 'founderReservations', reservations, 'chargesEnabled', false);
END $$;

-- Requires the organization's current active entitlement; never writes it. A catalog offer must
-- be in the published catalog and match the entitlement tier. Founder offers consume the
-- organization's live reservation for that exact offer, atomically.
CREATE FUNCTION hon.record_saas_subscription(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; v_org uuid; ent hon.organization_entitlements%ROWTYPE; v_offer hon.saas_catalog_offers%ROWTYPE;
  v_catalog uuid; res hon.saas_founder_reservations%ROWTYPE; created hon.saas_subscriptions%ROWTYPE; at timestamptz; snapshot jsonb;
  keys text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k);
  IF coalesce(jsonb_typeof(p->'organizationId'), '') <> 'string'
    OR NOT coalesce((p->>'source' = 'CATALOG_OFFER' AND keys = ARRAY['founderReservationId','offerId','organizationId','source']
        AND jsonb_typeof(p->'offerId') = 'string' AND jsonb_typeof(p->'founderReservationId') IN ('string','null'))
      OR (p->>'source' = 'LEGACY_ENTITLEMENT' AND keys = ARRAY['organizationId','source']), false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  v_org := (p->>'organizationId')::uuid;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.subscription.record', hon.saas_fingerprint(ARRAY['saas.subscription.record', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.organization:' || v_org::text, 0));
  LOCK TABLE hon.saas_catalog_versions IN SHARE MODE;
  PERFORM 1 FROM hon.organizations o WHERE o.id = v_org AND o.status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  at := clock_timestamp();
  SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = v_org FOR SHARE;
  IF NOT FOUND OR ent.status <> 'ACTIVE' OR ent.effective_from > at OR (ent.effective_until IS NOT NULL AND ent.effective_until <= at) THEN
    RAISE EXCEPTION 'SAAS_ENTITLEMENT_NOT_ACTIVE' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM hon.saas_subscriptions s WHERE s.organization_id = v_org AND s.status <> 'VOIDED') THEN
    RAISE EXCEPTION 'SAAS_SUBSCRIPTION_EXISTS' USING ERRCODE = '23514';
  END IF;
  IF p->>'source' = 'LEGACY_ENTITLEMENT' THEN
    INSERT INTO hon.saas_subscriptions(organization_id,source,plan_code,entitlement_tier,billing_interval,entitlement_version_at_record,
        status,status_reason,version,created_by_principal_id,created_at,updated_at)
      VALUES (v_org,'LEGACY_ENTITLEMENT',ent.tier::text,ent.tier,'NONE',ent.version,'PENDING_ACTIVATION','RECORDED',1,actor,at,at)
      RETURNING * INTO created;
  ELSE
    SELECT c.id INTO v_catalog FROM hon.saas_catalog_versions c WHERE c.status = 'PUBLISHED';
    SELECT o.* INTO v_offer FROM hon.saas_catalog_offers o WHERE o.id = (p->>'offerId')::uuid AND o.catalog_id = v_catalog;
    IF v_catalog IS NULL OR v_offer.id IS NULL THEN RAISE EXCEPTION 'SAAS_OFFER_NOT_AVAILABLE' USING ERRCODE = '23514'; END IF;
    IF v_offer.plan_code <> ent.tier::text THEN RAISE EXCEPTION 'SAAS_ENTITLEMENT_MISMATCH' USING ERRCODE = '23514'; END IF;
    IF v_offer.offer_kind LIKE 'FOUNDER_%' THEN
      IF jsonb_typeof(p->'founderReservationId') <> 'string' THEN RAISE EXCEPTION 'SAAS_FOUNDER_RESERVATION_REQUIRED' USING ERRCODE = '23514'; END IF;
      SELECT * INTO res FROM hon.saas_founder_reservations r WHERE r.id = (p->>'founderReservationId')::uuid FOR UPDATE;
      IF NOT FOUND OR res.organization_id <> v_org OR res.offer_id <> v_offer.id OR res.status <> 'RESERVED' THEN
        RAISE EXCEPTION 'SAAS_FOUNDER_RESERVATION_MISMATCH' USING ERRCODE = '23514';
      END IF;
      IF res.hold_expires_at <= at THEN RAISE EXCEPTION 'SAAS_FOUNDER_RESERVATION_EXPIRED' USING ERRCODE = '23514'; END IF;
    ELSIF jsonb_typeof(p->'founderReservationId') <> 'null' THEN
      RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
    END IF;
    INSERT INTO hon.saas_subscriptions(organization_id,source,catalog_id,offer_id,plan_code,entitlement_tier,offer_kind,billing_interval,price_minor,
        founder_reservation_id,entitlement_version_at_record,status,status_reason,version,created_by_principal_id,created_at,updated_at)
      VALUES (v_org,'CATALOG_OFFER',v_catalog,v_offer.id,v_offer.plan_code,ent.tier,v_offer.offer_kind,v_offer.billing_interval,v_offer.price_minor,
        res.id,ent.version,'PENDING_ACTIVATION','RECORDED',1,actor,at,at)
      RETURNING * INTO created;
    IF res.id IS NOT NULL THEN
      UPDATE hon.saas_founder_reservations SET status = 'ALLOCATED', status_reason = 'SUBSCRIPTION_RECORDED', version = version + 1,
        subscription_id = created.id, decided_by_principal_id = actor, decided_at = at WHERE id = res.id;
    END IF;
  END IF;
  INSERT INTO hon.saas_subscription_history(subscription_id,version,status,status_reason,actor_principal_id,occurred_at)
    VALUES (created.id,1,created.status,created.status_reason,actor,at);
  snapshot := hon.saas_subscription_json(created);
  RETURN hon.saas_record(actor, p_key, 'saas.subscription.record', 'saas.subscription.recorded', 'SUBSCRIPTION', created.id, v_org, NULL,
    snapshot || jsonb_build_object('entitlementVersion', ent.version), jsonb_build_object('subscription', snapshot), at);
END $$;

-- HQ owner only. Lifecycle metadata; nothing here bills, charges, grants credit or changes access.
CREATE FUNCTION hon.command_saas_subscription(p_subject text, p_subscription uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; prior hon.saas_subscriptions%ROWTYPE; updated hon.saas_subscriptions%ROWTYPE; ent hon.organization_entitlements%ROWTYPE;
  at timestamptz; action text; reason text; keys text[]; snapshot jsonb;
BEGIN
  IF p_subscription IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023'; END IF;
  keys := (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k);
  action := p->>'action'; reason := p->>'reasonCode';
  IF coalesce(jsonb_typeof(p->'action'), '') <> 'string' OR coalesce(jsonb_typeof(p->'reasonCode'), '') <> 'string'
    OR coalesce(jsonb_typeof(p->'expectedVersion'), '') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR NOT coalesce(CASE action
      WHEN 'START_SERVICE' THEN keys = ARRAY['action','expectedVersion','reasonCode'] AND reason = 'SERVICE_STARTED'
      WHEN 'SUSPEND' THEN keys = ARRAY['action','expectedVersion','reasonCode'] AND reason IN ('OWNER_HOLD','ACCOUNT_REVIEW','SCHOOL_REQUEST')
      WHEN 'RESUME' THEN keys = ARRAY['action','expectedVersion','reasonCode'] AND reason = 'REVIEW_RESOLVED'
      WHEN 'ADVANCE_PERIOD' THEN keys = ARRAY['action','expectedVersion','reasonCode'] AND reason = 'PERIOD_ELAPSED'
      WHEN 'VOID' THEN keys = ARRAY['action','expectedVersion','reasonCode'] AND reason = 'RECORDED_IN_ERROR'
      WHEN 'CHANGE_OFFER' THEN keys = ARRAY['action','expectedVersion','offerId','reasonCode'] AND reason = 'SCHOOL_REQUEST' AND jsonb_typeof(p->'offerId') = 'string'
      WHEN 'CANCEL' THEN keys = ARRAY['action','expectedVersion','reasonCode'] AND reason = 'SCHOOL_REQUEST'
      ELSE false END, false) THEN
    RAISE EXCEPTION 'INVALID_SAAS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_saas_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_saas_hq_actor(p_subject, true);
  replay := hon.saas_claim_request(actor, p_key, 'saas.subscription.command', hon.saas_fingerprint(ARRAY['saas.subscription.command', p_subscription::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('saas.founder.inventory', 0));
  SELECT * INTO prior FROM hon.saas_subscriptions WHERE id = p_subscription FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SAAS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF prior.version <> (p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  -- Undecided owner policies: plan changes and cancellations stay refused.
  IF action = 'CHANGE_OFFER' THEN PERFORM hon.saas_require_policy('PLAN_CHANGE_TIMING'); PERFORM hon.saas_require_policy('PRORATION'); END IF;
  IF action = 'CANCEL' THEN PERFORM hon.saas_require_policy('CANCELLATION_TIMING'); PERFORM hon.saas_require_policy('REFUND_EXECUTION'); END IF;
  IF NOT ((action IN ('START_SERVICE','VOID') AND prior.status = 'PENDING_ACTIVATION') OR (action = 'SUSPEND' AND prior.status = 'IN_SERVICE')
    OR (action = 'RESUME' AND prior.status = 'SUSPENDED') OR (action = 'ADVANCE_PERIOD' AND prior.status IN ('IN_SERVICE','SUSPENDED'))) THEN
    RAISE EXCEPTION 'SAAS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001';
  END IF;
  at := clock_timestamp();
  IF action IN ('START_SERVICE','RESUME') THEN
    SELECT * INTO ent FROM hon.organization_entitlements e WHERE e.organization_id = prior.organization_id FOR SHARE;
    IF NOT FOUND OR ent.status <> 'ACTIVE' OR ent.effective_from > at OR (ent.effective_until IS NOT NULL AND ent.effective_until <= at) THEN
      RAISE EXCEPTION 'SAAS_ENTITLEMENT_NOT_ACTIVE' USING ERRCODE = '23514';
    END IF;
    IF ent.tier <> prior.entitlement_tier THEN RAISE EXCEPTION 'SAAS_ENTITLEMENT_MISMATCH' USING ERRCODE = '23514'; END IF;
  END IF;
  IF action = 'START_SERVICE' THEN
    UPDATE hon.saas_subscriptions SET status = 'IN_SERVICE', status_reason = reason, version = version + 1, service_started_at = at,
        period_anchor_at = CASE WHEN billing_interval = 'NONE' THEN NULL ELSE at END,
        period_index = CASE WHEN billing_interval = 'MONTHLY' THEN 0 END,
        current_period_start = CASE WHEN billing_interval = 'NONE' THEN NULL ELSE at END,
        current_period_end = CASE WHEN billing_interval = 'MONTHLY' THEN at + interval '1 month' END,
        updated_at = at
      WHERE id = p_subscription RETURNING * INTO updated;
  ELSIF action = 'VOID' THEN
    UPDATE hon.saas_subscriptions SET status = 'VOIDED', status_reason = reason, version = version + 1, updated_at = at
      WHERE id = p_subscription RETURNING * INTO updated;
    -- A record made in error never started service, so its founder slot returns to inventory.
    UPDATE hon.saas_founder_reservations SET status = 'RELEASED', status_reason = 'SUBSCRIPTION_VOIDED', version = version + 1,
        decided_by_principal_id = actor, decided_at = at
      WHERE id = prior.founder_reservation_id AND status = 'ALLOCATED';
  ELSIF action IN ('SUSPEND','RESUME') THEN
    UPDATE hon.saas_subscriptions SET status = CASE WHEN action = 'SUSPEND' THEN 'SUSPENDED' ELSE 'IN_SERVICE' END,
        status_reason = reason, version = version + 1, updated_at = at
      WHERE id = p_subscription RETURNING * INTO updated;
  ELSE
    IF prior.billing_interval <> 'MONTHLY' THEN RAISE EXCEPTION 'SAAS_NO_BILLING_PERIODS' USING ERRCODE = '23514'; END IF;
    IF at < prior.current_period_end THEN RAISE EXCEPTION 'SAAS_PERIOD_NOT_ENDED' USING ERRCODE = '23514'; END IF;
    -- Periods are anchored to service start (no drift): period n is [anchor + n months, anchor + n+1 months).
    UPDATE hon.saas_subscriptions SET status_reason = reason, version = version + 1, period_index = period_index + 1,
        current_period_start = period_anchor_at + make_interval(months => period_index + 1),
        current_period_end = period_anchor_at + make_interval(months => period_index + 2), updated_at = at
      WHERE id = p_subscription RETURNING * INTO updated;
  END IF;
  INSERT INTO hon.saas_subscription_history(subscription_id,version,status,status_reason,period_index,current_period_start,current_period_end,actor_principal_id,occurred_at)
    VALUES (updated.id,updated.version,updated.status,updated.status_reason,updated.period_index,updated.current_period_start,updated.current_period_end,actor,at);
  snapshot := hon.saas_subscription_json(updated);
  RETURN hon.saas_record(actor, p_key, 'saas.subscription.command', 'saas.subscription.changed', 'SUBSCRIPTION', updated.id, updated.organization_id,
    hon.saas_subscription_json(prior), snapshot || jsonb_build_object('action', action), jsonb_build_object('subscription', snapshot, 'action', action), at);
END $$;

-- ---------- ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['saas_policy_decisions','saas_catalog_versions','saas_catalog_plans','saas_catalog_offers','saas_founder_reservations',
    'saas_subscriptions','saas_subscription_history','saas_requests','saas_audit','saas_outbox'] LOOP
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
      hon.record_saas_subscription(text,jsonb,uuid,uuid,uuid), hon.command_saas_subscription(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
