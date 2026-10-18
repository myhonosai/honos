BEGIN;

-- HON Champions Club Milestone 2: reward ACCOUNTING foundation. Records earned rewards as
-- liabilities only. Nothing here applies a credit, changes billing, starts a free period,
-- activates a membership, buys or ships a prize, or creates an external obligation.
-- financial_activation is pinned to false by constraint; there is no FULFILLED state.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Champions Club reward accounting requires a trusted migration owner';
  END IF;
END $$;

-- Versioned reward terms. The milestone ladder must be complete to publish. Clawback,
-- per-plan substitution rules and the prize budget may stay UNDECIDED after publication:
-- each one blocks only the decisions that depend on it.
CREATE TABLE hon.champions_reward_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version integer NOT NULL UNIQUE CHECK (policy_version > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  referrer_credit_minor integer CHECK (referrer_credit_minor BETWEEN 0 AND 100000),
  referrer_credit_max_rank integer CHECK (referrer_credit_max_rank BETWEEN 0 AND 10),
  welcome_credit_minor integer CHECK (welcome_credit_minor BETWEEN 0 AND 100000),
  first_free_months_count integer CHECK (first_free_months_count BETWEEN 1 AND 100),
  first_free_months_total integer CHECK (first_free_months_total BETWEEN 1 AND 60),
  second_free_months_count integer CHECK (second_free_months_count BETWEEN 1 AND 100),
  second_free_months_total integer CHECK (second_free_months_total BETWEEN 1 AND 60),
  prize_count integer CHECK (prize_count BETWEEN 1 AND 200),
  prize_budget_minor integer CHECK (prize_budget_minor BETWEEN 0 AND 2000000),
  lifetime_count integer CHECK (lifetime_count BETWEEN 1 AND 500),
  clawback_rule text NOT NULL DEFAULT 'UNDECIDED' CHECK (clawback_rule IN ('UNDECIDED','VOID_UNFULFILLED','RETAIN_EARNED')),
  monthly_rule text NOT NULL DEFAULT 'UNDECIDED' CHECK (monthly_rule IN ('UNDECIDED','AS_EARNED','OWNER_SUBSTITUTE')),
  annual_rule text NOT NULL DEFAULT 'UNDECIDED' CHECK (annual_rule IN ('UNDECIDED','AS_EARNED','OWNER_SUBSTITUTE')),
  founder_rule text NOT NULL DEFAULT 'UNDECIDED' CHECK (founder_rule IN ('UNDECIDED','AS_EARNED','OWNER_SUBSTITUTE')),
  -- A member who already paid for lifetime can never receive free months or a second lifetime
  -- as earned; only an owner-recorded substitute is possible.
  paid_lifetime_rule text NOT NULL DEFAULT 'UNDECIDED' CHECK (paid_lifetime_rule IN ('UNDECIDED','OWNER_SUBSTITUTE')),
  ai_allowance text NOT NULL DEFAULT 'FULL_PLAN_ALLOWANCE' CHECK (ai_allowance = 'FULL_PLAN_ALLOWANCE'),
  financial_activation boolean NOT NULL DEFAULT false CHECK (financial_activation = false),
  terms_reference text CHECK (terms_reference IS NULL OR (length(terms_reference) BETWEEN 1 AND 500 AND btrim(terms_reference) = terms_reference)),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  published_at timestamptz,
  retired_at timestamptz,
  CHECK (status = 'DRAFT' OR (referrer_credit_minor IS NOT NULL AND referrer_credit_max_rank IS NOT NULL
    AND welcome_credit_minor IS NOT NULL AND first_free_months_count IS NOT NULL AND first_free_months_total IS NOT NULL
    AND second_free_months_count IS NOT NULL AND second_free_months_total IS NOT NULL AND prize_count IS NOT NULL
    AND lifetime_count IS NOT NULL AND terms_reference IS NOT NULL AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL)),
  -- Ladder order: per-referral credits, then the two free-month milestones, prize, lifetime.
  CHECK (referrer_credit_max_rank IS NULL OR first_free_months_count IS NULL OR referrer_credit_max_rank < first_free_months_count),
  CHECK (first_free_months_count IS NULL OR second_free_months_count IS NULL OR first_free_months_count < second_free_months_count),
  CHECK (second_free_months_count IS NULL OR prize_count IS NULL OR second_free_months_count < prize_count),
  CHECK (prize_count IS NULL OR lifetime_count IS NULL OR prize_count < lifetime_count),
  -- The second milestone's total includes the first (12 total includes the 6 already earned).
  CHECK (first_free_months_total IS NULL OR second_free_months_total IS NULL OR second_free_months_total >= first_free_months_total),
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX champions_one_published_reward_policy ON hon.champions_reward_policies((true)) WHERE status = 'PUBLISHED';

-- Reward liabilities. One row per earned reward, kept separately by kind. Amount columns are
-- fixed at accrual; decisions only record approval, substitution, prize selection or void.
CREATE TABLE hon.champions_reward_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES hon.champions_reward_policies(id) ON DELETE RESTRICT,
  referrer_organization_id uuid NOT NULL,
  referrer_school_id uuid NOT NULL,
  beneficiary_organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  beneficiary_role text NOT NULL CHECK (beneficiary_role IN ('REFERRER','REFERRED')),
  reward_kind text NOT NULL CHECK (reward_kind IN ('REFERRER_CREDIT','WELCOME_CREDIT','FREE_MONTHS','PRIZE','LIFETIME_MEMBERSHIP')),
  milestone_ordinal integer CHECK (milestone_ordinal BETWEEN 1 AND 10),
  milestone_count integer CHECK (milestone_count BETWEEN 1 AND 500),
  attribution_id uuid REFERENCES hon.champions_attributions(id) ON DELETE RESTRICT,
  credit_minor integer CHECK (credit_minor BETWEEN 0 AND 100000),
  free_months integer CHECK (free_months BETWEEN 0 AND 60),
  lifetime_tier hon.plan_tier,
  ai_allowance text CHECK (ai_allowance = 'FULL_PLAN_ALLOWANCE'),
  basis_qualified_count integer NOT NULL CHECK (basis_qualified_count >= 0),
  status text NOT NULL DEFAULT 'ACCRUED' CHECK (status IN ('ACCRUED','APPROVED','REVERSAL_REVIEW','VOIDED')),
  status_before_review text CHECK (status_before_review IN ('ACCRUED','APPROVED')),
  retained boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  plan_basis text CHECK (plan_basis IN ('MONTHLY','ANNUAL','FOUNDER','PAID_LIFETIME')),
  fulfillment_form text CHECK (fulfillment_form IN ('AS_EARNED','OWNER_SUBSTITUTE')),
  substitute_description text CHECK (substitute_description IS NULL OR (length(substitute_description) BETWEEN 1 AND 300 AND btrim(substitute_description) = substitute_description)),
  substitute_value_minor integer CHECK (substitute_value_minor BETWEEN 0 AND 2000000),
  prize_kind text CHECK (prize_kind IN ('ELECTRONICS','EXPERIENCE')),
  prize_description text CHECK (prize_description IS NULL OR (length(prize_description) BETWEEN 1 AND 300 AND btrim(prize_description) = prize_description)),
  prize_cost_minor integer CHECK (prize_cost_minor BETWEEN 0 AND 2000000),
  void_reason text CHECK (void_reason IN ('BASIS_REVERSED','FRAUD_CONFIRMED','DUPLICATE','OWNER_CORRECTION')),
  accrued_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  accrued_at timestamptz NOT NULL,
  approved_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  voided_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  voided_at timestamptz,
  FOREIGN KEY (referrer_school_id, referrer_organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  -- Shape by kind: separate accounting for credits, free periods, lifetime and prizes.
  CHECK (CASE reward_kind
    WHEN 'REFERRER_CREDIT' THEN beneficiary_role = 'REFERRER' AND beneficiary_organization_id = referrer_organization_id
      AND milestone_ordinal IS NOT NULL AND milestone_count = milestone_ordinal AND attribution_id IS NULL
      AND credit_minor IS NOT NULL AND free_months IS NULL AND lifetime_tier IS NULL AND ai_allowance IS NULL
    WHEN 'WELCOME_CREDIT' THEN beneficiary_role = 'REFERRED' AND beneficiary_organization_id <> referrer_organization_id
      AND milestone_ordinal IS NULL AND milestone_count IS NULL AND attribution_id IS NOT NULL
      AND credit_minor IS NOT NULL AND free_months IS NULL AND lifetime_tier IS NULL AND ai_allowance IS NULL
    WHEN 'FREE_MONTHS' THEN beneficiary_role = 'REFERRER' AND beneficiary_organization_id = referrer_organization_id
      AND milestone_ordinal IN (1,2) AND milestone_count IS NOT NULL AND attribution_id IS NULL
      AND credit_minor IS NULL AND free_months IS NOT NULL AND lifetime_tier IS NULL AND ai_allowance = 'FULL_PLAN_ALLOWANCE'
    WHEN 'PRIZE' THEN beneficiary_role = 'REFERRER' AND beneficiary_organization_id = referrer_organization_id
      AND milestone_ordinal = 1 AND milestone_count IS NOT NULL AND attribution_id IS NULL
      AND credit_minor IS NULL AND free_months IS NULL AND lifetime_tier IS NULL AND ai_allowance IS NULL
    ELSE beneficiary_role = 'REFERRER' AND beneficiary_organization_id = referrer_organization_id
      AND milestone_ordinal = 1 AND milestone_count IS NOT NULL AND attribution_id IS NULL
      AND credit_minor IS NULL AND free_months IS NULL AND ai_allowance = 'FULL_PLAN_ALLOWANCE' END),
  CHECK (reward_kind = 'PRIZE' OR (prize_kind IS NULL AND prize_description IS NULL AND prize_cost_minor IS NULL)),
  CHECK ((prize_kind IS NULL) = (prize_description IS NULL) AND (prize_kind IS NULL) = (prize_cost_minor IS NULL)),
  CHECK ((substitute_description IS NULL) = (substitute_value_minor IS NULL)),
  CHECK ((fulfillment_form = 'OWNER_SUBSTITUTE') = (substitute_description IS NOT NULL)),
  CHECK ((plan_basis IS NULL) = (fulfillment_form IS NULL) AND (plan_basis IS NULL) = (approved_at IS NULL)
    AND (approved_at IS NULL) = (approved_by_principal_id IS NULL)),
  CHECK (plan_basis <> 'PAID_LIFETIME' OR fulfillment_form = 'OWNER_SUBSTITUTE'),
  CHECK (status NOT IN ('APPROVED') OR approved_at IS NOT NULL),
  CHECK ((status = 'REVERSAL_REVIEW') = (status_before_review IS NOT NULL)),
  CHECK ((status = 'VOIDED') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (voided_by_principal_id IS NULL)
    AND (voided_at IS NULL) = (void_reason IS NULL))
);
-- No duplicate rewards: one live entry per referrer milestone, one per qualified referral welcome.
CREATE UNIQUE INDEX champions_reward_one_live_milestone ON hon.champions_reward_entries(referrer_school_id, reward_kind, milestone_ordinal)
  WHERE status <> 'VOIDED' AND reward_kind <> 'WELCOME_CREDIT';
CREATE UNIQUE INDEX champions_reward_one_live_welcome ON hon.champions_reward_entries(attribution_id)
  WHERE status <> 'VOIDED' AND reward_kind = 'WELCOME_CREDIT';
CREATE INDEX champions_reward_entries_beneficiary ON hon.champions_reward_entries(beneficiary_organization_id, status);

CREATE TABLE hon.champions_reward_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES hon.champions_reward_entries(id) ON DELETE RESTRICT,
  from_status text CHECK (from_status IN ('ACCRUED','APPROVED','REVERSAL_REVIEW','VOIDED')),
  to_status text NOT NULL CHECK (to_status IN ('ACCRUED','APPROVED','REVERSAL_REVIEW','VOIDED')),
  version integer NOT NULL CHECK (version > 0),
  reason text NOT NULL CHECK (reason IN ('ACCRUED','APPROVED','BASIS_LOST','BASIS_RESTORED','RETAINED',
    'BASIS_REVERSED','FRAUD_CONFIRMED','DUPLICATE','OWNER_CORRECTION')),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  UNIQUE (entry_id, version)
);

-- Shared Champions evidence tables gain the reward command codes (closed lists stay closed).
ALTER TABLE hon.champions_audit DROP CONSTRAINT champions_audit_action_code_check;
ALTER TABLE hon.champions_audit ADD CONSTRAINT champions_audit_action_code_check CHECK (action_code IN ('champions.code.issue',
  'champions.policy.draft','champions.policy.publish','champions.attribution.capture','champions.attribution.decide',
  'champions.reward_policy.draft','champions.reward_policy.publish','champions.rewards.reconcile','champions.reward.decide'));
ALTER TABLE hon.champions_audit DROP CONSTRAINT champions_audit_entity_type_check;
ALTER TABLE hon.champions_audit ADD CONSTRAINT champions_audit_entity_type_check CHECK (entity_type IN ('REFERRAL_CODE','POLICY',
  'ATTRIBUTION','REWARD_POLICY','REWARD_SCHOOL','REWARD_ENTRY'));
ALTER TABLE hon.champions_outbox DROP CONSTRAINT champions_outbox_event_type_check;
ALTER TABLE hon.champions_outbox ADD CONSTRAINT champions_outbox_event_type_check CHECK (event_type IN ('champions.referral_code.issued',
  'champions.policy.drafted','champions.policy.published','champions.attribution.captured','champions.attribution.decided',
  'champions.reward_policy.drafted','champions.reward_policy.published','champions.rewards.reconciled','champions.reward.decided'));

-- Guarded transitions. Identity and accrued amounts never change; nothing is ever deleted.
CREATE FUNCTION hon.guard_champions_rewards() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE mutable constant text[] := ARRAY['status','status_before_review','retained','version','plan_basis','fulfillment_form',
  'substitute_description','substitute_value_minor','prize_kind','prize_description','prize_cost_minor','void_reason',
  'approved_by_principal_id','approved_at','voided_by_principal_id','voided_at'];
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_CHAMPIONS_RECORD' USING ERRCODE = '42501'; END IF;
  IF TG_TABLE_NAME = 'champions_reward_policies' THEN
    IF (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED'
        AND (to_jsonb(NEW) - ARRAY['status','published_by_principal_id','published_at']) = (to_jsonb(OLD) - ARRAY['status','published_by_principal_id','published_at']))
      OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED'
        AND (to_jsonb(NEW) - ARRAY['status','retired_at']) = (to_jsonb(OLD) - ARRAY['status','retired_at'])) THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.version = OLD.version + 1 AND (to_jsonb(NEW) - mutable) = (to_jsonb(OLD) - mutable)
    AND ((OLD.status = 'ACCRUED' AND NEW.status IN ('APPROVED','REVERSAL_REVIEW','VOIDED'))
      OR (OLD.status = 'APPROVED' AND NEW.status IN ('REVERSAL_REVIEW','VOIDED'))
      OR (OLD.status = 'REVERSAL_REVIEW' AND NEW.status IN ('ACCRUED','APPROVED','VOIDED') AND (NEW.status = 'VOIDED' OR NEW.status = OLD.status_before_review)))
    -- Approval details are recorded once, at approval, and never rewritten.
    AND (OLD.approved_at IS NULL OR (NEW.approved_at = OLD.approved_at AND NEW.plan_basis = OLD.plan_basis
      AND NEW.fulfillment_form = OLD.fulfillment_form AND NEW.substitute_description IS NOT DISTINCT FROM OLD.substitute_description
      AND NEW.substitute_value_minor IS NOT DISTINCT FROM OLD.substitute_value_minor AND NEW.prize_kind IS NOT DISTINCT FROM OLD.prize_kind
      AND NEW.prize_description IS NOT DISTINCT FROM OLD.prize_description AND NEW.prize_cost_minor IS NOT DISTINCT FROM OLD.prize_cost_minor))
    AND (NEW.retained OR NOT OLD.retained) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '42501';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_reward_policies','champions_reward_entries'] LOOP
    EXECUTE format('CREATE TRIGGER champions_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_champions_rewards()',t);
    EXECUTE format('CREATE TRIGGER champions_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_champions_rewards()',t);
  END LOOP;
  EXECUTE 'CREATE TRIGGER champions_immutable BEFORE UPDATE OR DELETE ON hon.champions_reward_history FOR EACH ROW EXECUTE FUNCTION hon.guard_champions_evidence()';
  EXECUTE 'CREATE TRIGGER champions_no_truncate BEFORE TRUNCATE ON hon.champions_reward_history FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_champions_evidence()';
END $$;

-- ---------- projections (private) ----------
CREATE FUNCTION hon.champions_reward_policy_json(p hon.champions_reward_policies) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('policyId',p.id,'policyVersion',p.policy_version,'status',p.status,
    'referrerCreditMinor',p.referrer_credit_minor,'referrerCreditMaxRank',p.referrer_credit_max_rank,'welcomeCreditMinor',p.welcome_credit_minor,
    'firstFreeMonthsCount',p.first_free_months_count,'firstFreeMonthsTotal',p.first_free_months_total,
    'secondFreeMonthsCount',p.second_free_months_count,'secondFreeMonthsTotal',p.second_free_months_total,
    'prizeCount',p.prize_count,'prizeBudgetMinor',p.prize_budget_minor,'lifetimeCount',p.lifetime_count,
    'clawbackRule',p.clawback_rule,'monthlyRule',p.monthly_rule,'annualRule',p.annual_rule,'founderRule',p.founder_rule,
    'paidLifetimeRule',p.paid_lifetime_rule,'aiAllowance',p.ai_allowance,'currency','USD','financialActivation','DISABLED',
    'termsReference',p.terms_reference,'createdAt',hon.champions_ts(p.created_at),
    'publishedAt',CASE WHEN p.published_at IS NULL THEN NULL ELSE hon.champions_ts(p.published_at) END)
$$;

CREATE FUNCTION hon.champions_reward_json(e hon.champions_reward_entries) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('entryId',e.id,'rewardKind',e.reward_kind,'beneficiaryRole',e.beneficiary_role,
    'beneficiaryOrganizationId',e.beneficiary_organization_id,'referrerOrganizationId',e.referrer_organization_id,
    'referrerSchoolId',e.referrer_school_id,'attributionId',e.attribution_id,'milestoneOrdinal',e.milestone_ordinal,
    'milestoneCount',e.milestone_count,'creditMinor',e.credit_minor,'freeMonths',e.free_months,'lifetimeTier',e.lifetime_tier,
    'aiAllowance',e.ai_allowance,'basisQualifiedCount',e.basis_qualified_count,'status',e.status,'retained',e.retained,'version',e.version,
    'policyVersion',(SELECT p.policy_version FROM hon.champions_reward_policies p WHERE p.id = e.policy_id),
    'planBasis',e.plan_basis,'fulfillmentForm',e.fulfillment_form,
    'substitute',CASE WHEN e.substitute_description IS NULL THEN NULL ELSE jsonb_build_object('description',e.substitute_description,'valueMinor',e.substitute_value_minor) END,
    'prize',CASE WHEN e.prize_kind IS NULL THEN NULL ELSE jsonb_build_object('kind',e.prize_kind,'description',e.prize_description,'costMinor',e.prize_cost_minor) END,
    'voidReason',e.void_reason,'accruedAt',hon.champions_ts(e.accrued_at),
    'approvedAt',CASE WHEN e.approved_at IS NULL THEN NULL ELSE hon.champions_ts(e.approved_at) END,
    'voidedAt',CASE WHEN e.voided_at IS NULL THEN NULL ELSE hon.champions_ts(e.voided_at) END)
$$;

-- ---------- HQ: reward terms ----------
CREATE FUNCTION hon.read_champions_reward_program_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE published jsonb; drafts jsonb;
BEGIN
  PERFORM hon.require_champions_hq_actor(p_subject, false);
  SELECT hon.champions_reward_policy_json(p) INTO published FROM hon.champions_reward_policies p WHERE p.status = 'PUBLISHED';
  SELECT coalesce(jsonb_agg(hon.champions_reward_policy_json(p) ORDER BY p.policy_version DESC), '[]'::jsonb) INTO drafts
    FROM (SELECT * FROM hon.champions_reward_policies WHERE status = 'DRAFT' ORDER BY policy_version DESC LIMIT 10) p;
  RETURN jsonb_build_object('published', published, 'drafts', drafts, 'financialActivation', 'DISABLED');
END $$;

CREATE FUNCTION hon.create_champions_reward_policy_draft(p_subject text, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; created hon.champions_reward_policies%ROWTYPE; next_version integer; at timestamptz; result jsonb;
  numeric_keys constant text[] := ARRAY['referrerCreditMinor','referrerCreditMaxRank','welcomeCreditMinor','firstFreeMonthsCount',
    'firstFreeMonthsTotal','secondFreeMonthsCount','secondFreeMonthsTotal','prizeCount','prizeBudgetMinor','lifetimeCount'];
  rule_keys constant text[] := ARRAY['clawbackRule','monthlyRule','annualRule','founderRule','paidLifetimeRule'];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)
      IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(numeric_keys || rule_keys || ARRAY['termsReference']) k)
    OR EXISTS (SELECT 1 FROM unnest(numeric_keys) k WHERE jsonb_typeof(p->k) NOT IN ('number','null')
      OR (jsonb_typeof(p->k) = 'number' AND (p->>k) !~ '^[0-9]{1,7}$'))
    OR EXISTS (SELECT 1 FROM unnest(rule_keys) k WHERE jsonb_typeof(p->k) <> 'string')
    OR jsonb_typeof(p->'termsReference') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  actor := hon.require_champions_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, false);
  replay := hon.champions_claim_request(actor, p_key, 'champions.reward_policy.draft',
    hon.champions_fingerprint(ARRAY['champions.reward_policy.draft', p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  LOCK TABLE hon.champions_reward_policies IN SHARE ROW EXCLUSIVE MODE;
  SELECT coalesce(max(policy_version), 0) + 1 INTO next_version FROM hon.champions_reward_policies;
  at := clock_timestamp();
  INSERT INTO hon.champions_reward_policies(policy_version,status,referrer_credit_minor,referrer_credit_max_rank,welcome_credit_minor,
      first_free_months_count,first_free_months_total,second_free_months_count,second_free_months_total,prize_count,prize_budget_minor,
      lifetime_count,clawback_rule,monthly_rule,annual_rule,founder_rule,paid_lifetime_rule,terms_reference,created_by_principal_id,created_at)
    VALUES (next_version,'DRAFT',(p->>'referrerCreditMinor')::integer,(p->>'referrerCreditMaxRank')::integer,(p->>'welcomeCreditMinor')::integer,
      (p->>'firstFreeMonthsCount')::integer,(p->>'firstFreeMonthsTotal')::integer,(p->>'secondFreeMonthsCount')::integer,
      (p->>'secondFreeMonthsTotal')::integer,(p->>'prizeCount')::integer,(p->>'prizeBudgetMinor')::integer,(p->>'lifetimeCount')::integer,
      p->>'clawbackRule',p->>'monthlyRule',p->>'annualRule',p->>'founderRule',p->>'paidLifetimeRule',p->>'termsReference',actor,at)
    RETURNING * INTO created;
  result := jsonb_build_object('policy', hon.champions_reward_policy_json(created));
  RETURN hon.champions_record(actor, p_key, 'champions.reward_policy.draft', 'champions.reward_policy.drafted', 'REWARD_POLICY',
    created.id, NULL, NULL, hon.champions_reward_policy_json(created), result, at);
END $$;

-- HQ owner only. The ladder must be complete. Publishing still activates nothing financial.
CREATE FUNCTION hon.publish_champions_reward_policy(p_subject text, p_policy uuid, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; draft hon.champions_reward_policies%ROWTYPE; prior hon.champions_reward_policies%ROWTYPE; at timestamptz; result jsonb;
BEGIN
  IF p_policy IS NULL THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  actor := hon.require_champions_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, true);
  replay := hon.champions_claim_request(actor, p_key, 'champions.reward_policy.publish',
    hon.champions_fingerprint(ARRAY['champions.reward_policy.publish', p_policy::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  LOCK TABLE hon.champions_reward_policies IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO draft FROM hon.champions_reward_policies WHERE id = p_policy FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF draft.status <> 'DRAFT' THEN RAISE EXCEPTION 'CHAMPIONS_POLICY_NOT_DRAFT' USING ERRCODE = '40001'; END IF;
  IF draft.referrer_credit_minor IS NULL OR draft.referrer_credit_max_rank IS NULL OR draft.welcome_credit_minor IS NULL
    OR draft.first_free_months_count IS NULL OR draft.first_free_months_total IS NULL OR draft.second_free_months_count IS NULL
    OR draft.second_free_months_total IS NULL OR draft.prize_count IS NULL OR draft.lifetime_count IS NULL OR draft.terms_reference IS NULL THEN
    RAISE EXCEPTION 'CHAMPIONS_POLICY_UNDECIDED' USING ERRCODE = '23514';
  END IF;
  at := clock_timestamp();
  SELECT * INTO prior FROM hon.champions_reward_policies WHERE status = 'PUBLISHED' FOR UPDATE;
  IF FOUND THEN UPDATE hon.champions_reward_policies SET status = 'RETIRED', retired_at = at WHERE id = prior.id; END IF;
  UPDATE hon.champions_reward_policies SET status = 'PUBLISHED', published_by_principal_id = actor, published_at = at
    WHERE id = p_policy RETURNING * INTO draft;
  result := jsonb_build_object('policy', hon.champions_reward_policy_json(draft),
    'retiredPolicyId', CASE WHEN prior.id IS NULL THEN NULL ELSE to_jsonb(prior.id) END);
  RETURN hon.champions_record(actor, p_key, 'champions.reward_policy.publish', 'champions.reward_policy.published', 'REWARD_POLICY', draft.id, NULL,
    CASE WHEN prior.id IS NULL THEN NULL ELSE hon.champions_reward_policy_json(prior) END, hon.champions_reward_policy_json(draft), result, at);
END $$;

-- ---------- HQ: reconciliation (liabilities only) ----------
-- Brings one referrer school's reward liabilities in line with its current QUALIFIED count:
-- accrues missing milestone and welcome entries under the published reward policy, moves live
-- entries whose basis is gone to REVERSAL_REVIEW (never voids them), and returns entries whose
-- basis came back. Owner-retained entries are left alone. Entries are keyed by milestone
-- ordinal, so a later policy with a different ladder cannot duplicate an earned milestone.
CREATE FUNCTION hon.reconcile_champions_rewards(p_subject text, p_school uuid, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; school_row hon.schools%ROWTYPE; policy hon.champions_reward_policies%ROWTYPE; qualified integer;
  at timestamptz; result jsonb; entry hon.champions_reward_entries%ROWTYPE; supported boolean; tier hon.plan_tier;
  accrued integer := 0; flagged integer := 0; restored integer := 0; k integer; attribution record;
  wanted record;
BEGIN
  IF p_school IS NULL THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  actor := hon.require_champions_hq_actor(p_subject, false);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, false);
  replay := hon.champions_claim_request(actor, p_key, 'champions.rewards.reconcile',
    hon.champions_fingerprint(ARRAY['champions.rewards.reconcile', p_school::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO school_row FROM hon.schools WHERE id = p_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO policy FROM hon.champions_reward_policies WHERE status = 'PUBLISHED' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_POLICY_UNDECIDED' USING ERRCODE = '23514'; END IF;
  -- Attribution decisions cannot change underneath one reconciliation.
  LOCK TABLE hon.champions_attributions IN SHARE MODE;
  PERFORM pg_advisory_xact_lock(hashtextextended('champions.rewards:' || p_school::text, 0));
  at := clock_timestamp();
  SELECT count(*) INTO qualified FROM hon.champions_attributions a WHERE a.referrer_school_id = p_school AND a.state = 'QUALIFIED';

  -- 1. Live entries whose basis is gone go to review; reviewed entries whose basis returned go back.
  FOR entry IN SELECT * FROM hon.champions_reward_entries e WHERE e.referrer_school_id = p_school AND e.status <> 'VOIDED' ORDER BY e.accrued_at, e.milestone_count NULLS LAST, e.id FOR UPDATE LOOP
    supported := CASE WHEN entry.reward_kind = 'WELCOME_CREDIT'
      THEN EXISTS (SELECT 1 FROM hon.champions_attributions a WHERE a.id = entry.attribution_id AND a.state = 'QUALIFIED')
      ELSE qualified >= entry.milestone_count END;
    IF NOT supported AND entry.status IN ('ACCRUED','APPROVED') AND NOT entry.retained THEN
      UPDATE hon.champions_reward_entries SET status = 'REVERSAL_REVIEW', status_before_review = entry.status, version = version + 1
        WHERE id = entry.id;
      INSERT INTO hon.champions_reward_history(entry_id,from_status,to_status,version,reason,actor_principal_id,occurred_at)
        VALUES (entry.id, entry.status, 'REVERSAL_REVIEW', entry.version + 1, 'BASIS_LOST', actor, at);
      flagged := flagged + 1;
    ELSIF supported AND entry.status = 'REVERSAL_REVIEW' THEN
      UPDATE hon.champions_reward_entries SET status = entry.status_before_review, status_before_review = NULL, version = version + 1
        WHERE id = entry.id;
      INSERT INTO hon.champions_reward_history(entry_id,from_status,to_status,version,reason,actor_principal_id,occurred_at)
        VALUES (entry.id, 'REVERSAL_REVIEW', entry.status_before_review, entry.version + 1, 'BASIS_RESTORED', actor, at);
      restored := restored + 1;
    END IF;
  END LOOP;

  -- 2. Accrue missing referrer milestones under the published ladder.
  SELECT e.tier INTO tier FROM hon.organization_entitlements e WHERE e.organization_id = school_row.organization_id;
  FOR wanted IN
    SELECT 'REFERRER_CREDIT'::text kind, r ordinal, r threshold FROM generate_series(1, policy.referrer_credit_max_rank) r
    UNION ALL SELECT 'FREE_MONTHS', 1, policy.first_free_months_count
    UNION ALL SELECT 'FREE_MONTHS', 2, policy.second_free_months_count
    UNION ALL SELECT 'PRIZE', 1, policy.prize_count
    UNION ALL SELECT 'LIFETIME_MEMBERSHIP', 1, policy.lifetime_count
  LOOP
    CONTINUE WHEN qualified < wanted.threshold;
    CONTINUE WHEN EXISTS (SELECT 1 FROM hon.champions_reward_entries e WHERE e.referrer_school_id = p_school
      AND e.reward_kind = wanted.kind AND e.milestone_ordinal = wanted.ordinal AND e.status <> 'VOIDED');
    INSERT INTO hon.champions_reward_entries(policy_id,referrer_organization_id,referrer_school_id,beneficiary_organization_id,beneficiary_role,
        reward_kind,milestone_ordinal,milestone_count,credit_minor,free_months,lifetime_tier,ai_allowance,basis_qualified_count,
        accrued_by_principal_id,accrued_at)
      VALUES (policy.id, school_row.organization_id, p_school, school_row.organization_id, 'REFERRER', wanted.kind, wanted.ordinal, wanted.threshold,
        CASE WHEN wanted.kind = 'REFERRER_CREDIT' THEN policy.referrer_credit_minor END,
        CASE WHEN wanted.kind = 'FREE_MONTHS' THEN CASE wanted.ordinal WHEN 1 THEN policy.first_free_months_total
          ELSE policy.second_free_months_total - policy.first_free_months_total END END,
        CASE WHEN wanted.kind = 'LIFETIME_MEMBERSHIP' THEN tier END,
        CASE WHEN wanted.kind IN ('FREE_MONTHS','LIFETIME_MEMBERSHIP') THEN 'FULL_PLAN_ALLOWANCE' END,
        qualified, actor, at)
      RETURNING * INTO entry;
    INSERT INTO hon.champions_reward_history(entry_id,from_status,to_status,version,reason,actor_principal_id,occurred_at)
      VALUES (entry.id, NULL, 'ACCRUED', 1, 'ACCRUED', actor, at);
    accrued := accrued + 1;
  END LOOP;

  -- 3. Accrue a welcome credit for each qualified referred organization that has none live.
  FOR attribution IN SELECT a.id, a.referred_organization_id FROM hon.champions_attributions a
    WHERE a.referrer_school_id = p_school AND a.state = 'QUALIFIED'
      AND NOT EXISTS (SELECT 1 FROM hon.champions_reward_entries e WHERE e.attribution_id = a.id AND e.status <> 'VOIDED')
    ORDER BY a.qualified_at, a.id LOOP
    INSERT INTO hon.champions_reward_entries(policy_id,referrer_organization_id,referrer_school_id,beneficiary_organization_id,beneficiary_role,
        reward_kind,attribution_id,credit_minor,basis_qualified_count,accrued_by_principal_id,accrued_at)
      VALUES (policy.id, school_row.organization_id, p_school, attribution.referred_organization_id, 'REFERRED', 'WELCOME_CREDIT',
        attribution.id, policy.welcome_credit_minor, qualified, actor, at)
      RETURNING * INTO entry;
    INSERT INTO hon.champions_reward_history(entry_id,from_status,to_status,version,reason,actor_principal_id,occurred_at)
      VALUES (entry.id, NULL, 'ACCRUED', 1, 'ACCRUED', actor, at);
    accrued := accrued + 1;
  END LOOP;

  SELECT jsonb_build_object('schoolId', p_school, 'qualifiedCount', qualified, 'policyVersion', policy.policy_version,
      'accrued', accrued, 'flaggedForReview', flagged, 'restored', restored,
      'entries', coalesce(jsonb_agg(hon.champions_reward_json(e) ORDER BY e.accrued_at, e.milestone_count NULLS LAST, e.id), '[]'::jsonb),
      'financialActivation', 'DISABLED')
    INTO result FROM hon.champions_reward_entries e WHERE e.referrer_school_id = p_school;
  RETURN hon.champions_record(actor, p_key, 'champions.rewards.reconcile', 'champions.rewards.reconciled', 'REWARD_SCHOOL', p_school,
    school_row.organization_id, NULL, jsonb_build_object('qualifiedCount',qualified,'accrued',accrued,'flaggedForReview',flagged,'restored',restored),
    result, at);
END $$;

-- ---------- HQ owner: reward decisions (recordkeeping only) ----------
-- APPROVE records the beneficiary's plan basis and, where the published rule requires it, an
-- owner substitute; a prize also records its kind, description and cost within the budget.
-- VOID records a reversal; RETAIN keeps an entry under review as earned. Undecided rules refuse.
CREATE FUNCTION hon.decide_champions_reward(p_subject text, p_entry uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; decision text; keys text[]; expected integer; prior hon.champions_reward_entries%ROWTYPE;
  updated hon.champions_reward_entries%ROWTYPE; policy hon.champions_reward_policies%ROWTYPE; rule text; basis text;
  sub jsonb; prize jsonb; reason text; at timestamptz; result jsonb; history_reason text;
BEGIN
  IF p_entry IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(p) k;
  decision := p->>'decision';
  IF jsonb_typeof(p->'decision') <> 'string' OR jsonb_typeof(p->'expectedVersion') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR NOT ((decision = 'APPROVE' AND keys = ARRAY['decision','expectedVersion','planBasis','prize','substitute'])
      OR (decision = 'VOID' AND keys = ARRAY['decision','expectedVersion','reasonCode'])
      OR (decision = 'RETAIN' AND keys = ARRAY['decision','expectedVersion'])) THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  expected := (p->>'expectedVersion')::integer;
  IF decision = 'APPROVE' THEN
    basis := p->>'planBasis'; sub := p->'substitute'; prize := p->'prize';
    IF jsonb_typeof(p->'planBasis') <> 'string' OR basis NOT IN ('MONTHLY','ANNUAL','FOUNDER','PAID_LIFETIME')
      OR jsonb_typeof(sub) NOT IN ('null','object') OR jsonb_typeof(prize) NOT IN ('null','object')
      OR (jsonb_typeof(sub) = 'object' AND ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(sub) k) IS DISTINCT FROM ARRAY['description','valueMinor']
        OR jsonb_typeof(sub->'description') <> 'string' OR jsonb_typeof(sub->'valueMinor') <> 'number' OR (sub->>'valueMinor') !~ '^[0-9]{1,7}$'))
      OR (jsonb_typeof(prize) = 'object' AND ((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(prize) k) IS DISTINCT FROM ARRAY['costMinor','description','kind']
        OR jsonb_typeof(prize->'kind') <> 'string' OR jsonb_typeof(prize->'description') <> 'string'
        OR jsonb_typeof(prize->'costMinor') <> 'number' OR (prize->>'costMinor') !~ '^[0-9]{1,7}$')) THEN
      RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
    END IF;
  ELSIF decision = 'VOID' THEN
    reason := p->>'reasonCode';
    IF jsonb_typeof(p->'reasonCode') <> 'string' OR reason NOT IN ('BASIS_REVERSED','FRAUD_CONFIRMED','DUPLICATE','OWNER_CORRECTION') THEN
      RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
    END IF;
  END IF;
  actor := hon.require_champions_hq_actor(p_subject, true);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, true);
  replay := hon.champions_claim_request(actor, p_key, 'champions.reward.decide',
    hon.champions_fingerprint(ARRAY['champions.reward.decide', p_entry::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO prior FROM hon.champions_reward_entries WHERE id = p_entry FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('champions.rewards:' || prior.referrer_school_id::text, 0));
  IF prior.version <> expected THEN RAISE EXCEPTION 'CHAMPIONS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  -- Decisions follow the owner's current published rules.
  SELECT * INTO policy FROM hon.champions_reward_policies WHERE status = 'PUBLISHED' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_POLICY_UNDECIDED' USING ERRCODE = '23514'; END IF;
  at := clock_timestamp();
  IF decision = 'APPROVE' THEN
    IF prior.status <> 'ACCRUED' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
    rule := CASE basis WHEN 'MONTHLY' THEN policy.monthly_rule WHEN 'ANNUAL' THEN policy.annual_rule
      WHEN 'FOUNDER' THEN policy.founder_rule ELSE policy.paid_lifetime_rule END;
    IF rule = 'UNDECIDED' THEN RAISE EXCEPTION 'CHAMPIONS_REWARD_RULE_UNDECIDED' USING ERRCODE = '23514'; END IF;
    IF (rule = 'AS_EARNED') <> (jsonb_typeof(sub) = 'null') THEN RAISE EXCEPTION 'CHAMPIONS_REWARD_SUBSTITUTE_MISMATCH' USING ERRCODE = '23514'; END IF;
    IF (prior.reward_kind = 'PRIZE') <> (jsonb_typeof(prize) = 'object') THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
    IF prior.reward_kind = 'PRIZE' AND (policy.prize_budget_minor IS NULL) THEN RAISE EXCEPTION 'CHAMPIONS_REWARD_RULE_UNDECIDED' USING ERRCODE = '23514'; END IF;
    IF prior.reward_kind = 'PRIZE' AND (prize->>'costMinor')::integer > policy.prize_budget_minor THEN
      RAISE EXCEPTION 'CHAMPIONS_PRIZE_OVER_BUDGET' USING ERRCODE = '23514';
    END IF;
    IF prior.reward_kind = 'LIFETIME_MEMBERSHIP' AND prior.lifetime_tier IS NULL THEN
      RAISE EXCEPTION 'CHAMPIONS_REWARD_RULE_UNDECIDED' USING ERRCODE = '23514';
    END IF;
    UPDATE hon.champions_reward_entries SET status = 'APPROVED', version = version + 1, plan_basis = basis, fulfillment_form = rule,
        substitute_description = sub->>'description', substitute_value_minor = (sub->>'valueMinor')::integer,
        prize_kind = prize->>'kind', prize_description = prize->>'description', prize_cost_minor = (prize->>'costMinor')::integer,
        approved_by_principal_id = actor, approved_at = at
      WHERE id = p_entry AND version = expected RETURNING * INTO updated;
    history_reason := 'APPROVED';
  ELSIF decision = 'VOID' THEN
    IF prior.status = 'VOIDED' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
    -- Clawing back an earned reward because its basis was refunded or reversed is the owner's
    -- clawback rule; fraud, duplicates and corrections are owner judgment on any live entry.
    IF reason = 'BASIS_REVERSED' THEN
      IF prior.status <> 'REVERSAL_REVIEW' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      IF policy.clawback_rule = 'UNDECIDED' THEN RAISE EXCEPTION 'CHAMPIONS_REWARD_RULE_UNDECIDED' USING ERRCODE = '23514'; END IF;
      IF policy.clawback_rule <> 'VOID_UNFULFILLED' THEN RAISE EXCEPTION 'CHAMPIONS_CLAWBACK_NOT_PERMITTED' USING ERRCODE = '23514'; END IF;
    END IF;
    UPDATE hon.champions_reward_entries SET status = 'VOIDED', status_before_review = NULL, version = version + 1,
        void_reason = reason, voided_by_principal_id = actor, voided_at = at
      WHERE id = p_entry AND version = expected RETURNING * INTO updated;
    history_reason := reason;
  ELSE
    IF prior.status <> 'REVERSAL_REVIEW' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
    IF policy.clawback_rule = 'UNDECIDED' THEN RAISE EXCEPTION 'CHAMPIONS_REWARD_RULE_UNDECIDED' USING ERRCODE = '23514'; END IF;
    IF policy.clawback_rule <> 'RETAIN_EARNED' THEN RAISE EXCEPTION 'CHAMPIONS_CLAWBACK_NOT_PERMITTED' USING ERRCODE = '23514'; END IF;
    UPDATE hon.champions_reward_entries SET status = prior.status_before_review, status_before_review = NULL, retained = true, version = version + 1
      WHERE id = p_entry AND version = expected RETURNING * INTO updated;
    history_reason := 'RETAINED';
  END IF;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'CHAMPIONS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  INSERT INTO hon.champions_reward_history(entry_id,from_status,to_status,version,reason,actor_principal_id,occurred_at)
    VALUES (updated.id, prior.status, updated.status, updated.version, history_reason, actor, at);
  result := jsonb_build_object('entry', hon.champions_reward_json(updated));
  RETURN hon.champions_record(actor, p_key, 'champions.reward.decide', 'champions.reward.decided', 'REWARD_ENTRY', updated.id,
    updated.beneficiary_organization_id, jsonb_build_object('status',prior.status,'version',prior.version),
    jsonb_build_object('status',updated.status,'version',updated.version,'reason',history_reason), result, at);
END $$;

-- ---------- reads ----------
-- HQ liability ledger: newest 200 entries (optionally by status) plus liability totals by
-- status and kind across every non-voided entry.
CREATE FUNCTION hon.read_champions_reward_ledger_from_hq(p_subject text, p_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE rows jsonb; totals jsonb;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('ACCRUED','APPROVED','REVERSAL_REVIEW','VOIDED') THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.require_champions_hq_actor(p_subject, false);
  SELECT coalesce(jsonb_agg(hon.champions_reward_json(e) ORDER BY e.accrued_at DESC, e.milestone_count DESC NULLS FIRST, e.id), '[]'::jsonb) INTO rows
    FROM (SELECT * FROM hon.champions_reward_entries WHERE p_status IS NULL OR status = p_status ORDER BY accrued_at DESC, milestone_count DESC NULLS FIRST, id LIMIT 200) e;
  SELECT coalesce(jsonb_agg(jsonb_build_object('status',t.status,'rewardKind',t.reward_kind,'entries',t.entries,
      'creditMinor',t.credit_minor,'freeMonths',t.free_months,'prizeCostMinor',t.prize_cost_minor,'substituteValueMinor',t.substitute_value_minor)
      ORDER BY t.status, t.reward_kind), '[]'::jsonb) INTO totals
    FROM (SELECT status, reward_kind, count(*)::integer entries, coalesce(sum(credit_minor),0)::bigint credit_minor,
        coalesce(sum(free_months),0)::integer free_months, coalesce(sum(prize_cost_minor),0)::bigint prize_cost_minor,
        coalesce(sum(substitute_value_minor),0)::bigint substitute_value_minor
      FROM hon.champions_reward_entries WHERE status <> 'VOIDED' GROUP BY status, reward_kind) t;
  RETURN jsonb_build_object('entries', rows, 'limit', 200, 'liabilities', totals, 'currency', 'USD', 'financialActivation', 'DISABLED');
END $$;

-- School view: the school's own progress and the rewards recorded for its organization.
-- Referrer milestones for this school, plus welcome credits this organization received as a
-- referred school. Never exposes the other side of a referral.
CREATE FUNCTION hon.read_champions_school_rewards(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; policy hon.champions_reward_policies%ROWTYPE; qualified integer; rewards jsonb; next_milestone jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_champions_school_actor(p_subject, p_school) LIMIT 1;
  SELECT * INTO policy FROM hon.champions_reward_policies WHERE status = 'PUBLISHED';
  SELECT count(*) INTO qualified FROM hon.champions_attributions a WHERE a.referrer_school_id = p_school AND a.state = 'QUALIFIED';
  SELECT coalesce(jsonb_agg(jsonb_build_object('rewardKind',e.reward_kind,'beneficiaryRole',e.beneficiary_role,
      'milestoneCount',e.milestone_count,'creditMinor',e.credit_minor,'freeMonths',e.free_months,'lifetimeTier',e.lifetime_tier,
      'aiAllowance',e.ai_allowance,'status',e.status,'accruedAt',hon.champions_ts(e.accrued_at)) ORDER BY e.accrued_at, e.milestone_count NULLS LAST, e.id), '[]'::jsonb)
    INTO rewards FROM hon.champions_reward_entries e
    WHERE e.status <> 'VOIDED' AND ((e.referrer_school_id = p_school AND e.beneficiary_role = 'REFERRER')
      OR (e.reward_kind = 'WELCOME_CREDIT' AND e.beneficiary_organization_id = scope.organization_id));
  IF policy.id IS NOT NULL THEN
    SELECT jsonb_build_object('rewardKind', m.kind, 'milestoneCount', m.threshold, 'remaining', m.threshold - qualified) INTO next_milestone
      FROM (SELECT 'REFERRER_CREDIT'::text kind, r threshold FROM generate_series(1, policy.referrer_credit_max_rank) r
        UNION ALL SELECT 'FREE_MONTHS', policy.first_free_months_count UNION ALL SELECT 'FREE_MONTHS', policy.second_free_months_count
        UNION ALL SELECT 'PRIZE', policy.prize_count UNION ALL SELECT 'LIFETIME_MEMBERSHIP', policy.lifetime_count) m
      WHERE m.threshold > qualified ORDER BY m.threshold LIMIT 1;
  END IF;
  RETURN jsonb_build_object('schoolId', p_school, 'qualifiedReferrals', qualified,
    'program', CASE WHEN policy.id IS NULL THEN jsonb_build_object('status','POLICY_UNDECIDED','policyVersion',NULL)
      ELSE jsonb_build_object('status','PUBLISHED','policyVersion',policy.policy_version) END,
    'nextMilestone', next_milestone, 'rewards', rewards, 'financialActivation', 'DISABLED');
END $$;

-- ---------- RLS and ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_reward_policies','champions_reward_entries','champions_reward_history'] LOOP
    EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC CASCADE',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I CASCADE',t,r);
    END LOOP;
    FOR col IN SELECT attname FROM pg_attribute WHERE attrelid = ('hon.'||t)::regclass AND attnum > 0 AND NOT attisdropped LOOP
      EXECUTE format('REVOKE ALL (%I) ON hon.%I FROM PUBLIC CASCADE',col,t);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_champions_rewards()','hon.champions_reward_policy_json(hon.champions_reward_policies)',
      'hon.champions_reward_json(hon.champions_reward_entries)','hon.read_champions_reward_program_from_hq(text)',
      'hon.create_champions_reward_policy_draft(text,jsonb,uuid,uuid,uuid)','hon.publish_champions_reward_policy(text,uuid,uuid,uuid,uuid)',
      'hon.reconcile_champions_rewards(text,uuid,uuid,uuid,uuid)','hon.decide_champions_reward(text,uuid,jsonb,uuid,uuid,uuid)',
      'hon.read_champions_reward_ledger_from_hq(text,text)','hon.read_champions_school_rewards(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_champions_reward_program_from_hq(text), hon.create_champions_reward_policy_draft(text,jsonb,uuid,uuid,uuid),
      hon.publish_champions_reward_policy(text,uuid,uuid,uuid,uuid), hon.reconcile_champions_rewards(text,uuid,uuid,uuid,uuid),
      hon.decide_champions_reward(text,uuid,jsonb,uuid,uuid,uuid), hon.read_champions_reward_ledger_from_hq(text,text),
      hon.read_champions_school_rewards(text,uuid)
      TO hon_runtime;
  END IF;
END $$;

COMMIT;
