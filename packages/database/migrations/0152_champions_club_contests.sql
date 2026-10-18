BEGIN;

-- HON Champions Club Milestone 4: HQ-managed referral contests. Contests are time windows over
-- the same verified QUALIFIED attributions (M1); they never create, consume or change a referral,
-- and the permanent Champions program (M2 rewards, M3 standings) is unaffected by them.
-- Lifecycle: DRAFT -> SCHEDULED -> ACTIVE <-> PAUSED -> ENDED -> PENDING_WINNER_APPROVAL ->
-- COMPLETED, or CANCELLED. There is no scheduler, so transitions are explicit HQ commands and
-- reads report when one is due; standings are computed from the configured window (minus
-- pauses), so they do not depend on when HQ clicks.
-- Prizes are recorded liabilities only: no purchase, gift card, message or public listing.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Champions Club contests require a trusted migration owner';
  END IF;
END $$;

CREATE TABLE hon.champions_contests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 3 AND 120 AND btrim(name) = name),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000 AND btrim(description) = description),
  terms_reference text CHECK (terms_reference IS NULL OR (length(terms_reference) BETWEEN 1 AND 500 AND btrim(terms_reference) = terms_reference)),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SCHEDULED','ACTIVE','PAUSED','ENDED','PENDING_WINNER_APPROVAL','COMPLETED','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- Anti-gaming default: the referral must be captured AND qualified inside the window, so a
  -- school cannot hold back qualifications from before the contest.
  count_basis text NOT NULL CHECK (count_basis IN ('CAPTURED_AND_QUALIFIED_IN_WINDOW','QUALIFIED_IN_WINDOW')),
  minimum_qualified integer NOT NULL CHECK (minimum_qualified BETWEEN 1 AND 1000),
  tie_rule text NOT NULL CHECK (tie_rule IN ('OWNER_RESOLVES','EARLIEST_TO_REACH')),
  eligibility_scope text NOT NULL CHECK (eligibility_scope IN ('ALL_ACTIVE_SCHOOLS','SELECTED_SCHOOLS')),
  eligible_tiers text[] NOT NULL CHECK (cardinality(eligible_tiers) BETWEEN 1 AND 3 AND eligible_tiers <@ ARRAY['ESSENTIAL','CORE','COMPLETE']),
  budget_minor integer CHECK (budget_minor BETWEEN 0 AND 100000000),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  -- Gift cards are offered only where the owner has confirmed they are permitted.
  gift_card_compliance text NOT NULL DEFAULT 'UNDECIDED' CHECK (gift_card_compliance IN ('UNDECIDED','PERMITTED','NOT_PERMITTED')),
  school_visibility text NOT NULL DEFAULT 'HIDDEN' CHECK (school_visibility IN ('HIDDEN','ELIGIBLE_SCHOOLS')),
  public_listing text NOT NULL DEFAULT 'DISABLED' CHECK (public_listing = 'DISABLED'),
  owner_approval_required boolean NOT NULL DEFAULT true CHECK (owner_approval_required),
  financial_activation boolean NOT NULL DEFAULT false CHECK (financial_activation = false),
  duplicated_from uuid REFERENCES hon.champions_contests(id) ON DELETE RESTRICT,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  scheduled_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  scheduled_at timestamptz,
  activated_at timestamptz,
  ended_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IN ('OWNER_DECISION','POLICY_CHANGE','FRAUD_CONCERN','LEGAL_REVIEW')),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '366 days'),
  CHECK (status = 'DRAFT' OR status = 'CANCELLED' OR (scheduled_at IS NOT NULL AND scheduled_by_principal_id IS NOT NULL
    AND terms_reference IS NOT NULL AND budget_minor IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL) AND (cancelled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK (status NOT IN ('ENDED','PENDING_WINNER_APPROVAL','COMPLETED') OR ended_at IS NOT NULL),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);

CREATE TABLE hon.champions_contest_prizes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id uuid NOT NULL REFERENCES hon.champions_contests(id) ON DELETE RESTRICT,
  place_from integer NOT NULL CHECK (place_from BETWEEN 1 AND 100),
  place_to integer NOT NULL CHECK (place_to BETWEEN 1 AND 100),
  prize_kind text NOT NULL CHECK (prize_kind IN ('ELECTRONICS','AMUSEMENT_TICKETS','GIFT_CARD','EXPERIENCE','OTHER_APPROVED')),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 300 AND btrim(description) = description),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  estimated_unit_cost_minor integer NOT NULL CHECK (estimated_unit_cost_minor BETWEEN 0 AND 10000000),
  CHECK (place_to >= place_from),
  UNIQUE (id, contest_id)
);

CREATE TABLE hon.champions_contest_schools (
  contest_id uuid NOT NULL REFERENCES hon.champions_contests(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL REFERENCES hon.schools(id) ON DELETE RESTRICT,
  PRIMARY KEY (contest_id, school_id)
);

CREATE TABLE hon.champions_contest_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id uuid NOT NULL REFERENCES hon.champions_contests(id) ON DELETE RESTRICT,
  paused_at timestamptz NOT NULL,
  resumed_at timestamptz,
  paused_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  resumed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  CHECK (resumed_at IS NULL OR resumed_at >= paused_at),
  CHECK ((resumed_at IS NULL) = (resumed_by_principal_id IS NULL))
);
CREATE UNIQUE INDEX champions_one_open_contest_pause ON hon.champions_contest_pauses(contest_id) WHERE resumed_at IS NULL;

-- Frozen standings, written once when the contest ends. Winners are decided from these rows.
CREATE TABLE hon.champions_contest_results (
  contest_id uuid NOT NULL REFERENCES hon.champions_contests(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL REFERENCES hon.schools(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  qualified_count integer NOT NULL CHECK (qualified_count >= 1),
  reached_at timestamptz NOT NULL,
  eligible boolean NOT NULL,
  ineligible_reason text CHECK (ineligible_reason IN ('NOT_SELECTED','TIER_NOT_ELIGIBLE','SCHOOL_INACTIVE','LEADERBOARD_HOLD','BELOW_MINIMUM')),
  standing_rank integer CHECK (standing_rank >= 1),
  standing_position integer CHECK (standing_position >= 1),
  frozen_at timestamptz NOT NULL,
  PRIMARY KEY (contest_id, school_id),
  CHECK (eligible = (ineligible_reason IS NULL) AND eligible = (standing_rank IS NOT NULL) AND eligible = (standing_position IS NOT NULL))
);

-- Contest prize liabilities, separate from the permanent reward ledger (M2). No FULFILLED state.
CREATE TABLE hon.champions_contest_winners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id uuid NOT NULL,
  prize_id uuid NOT NULL,
  place integer NOT NULL CHECK (place BETWEEN 1 AND 100),
  school_id uuid REFERENCES hon.schools(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('PROPOSED','TIE_REVIEW','DISPUTED','APPROVED','REJECTED')),
  reason_code text CHECK (reason_code IN ('TIE_AT_BOUNDARY','OWNER_TIE_RESOLUTION','DISPUTE_RAISED','DISPUTE_DISMISSED','DISPUTE_UPHELD',
    'FRAUD_CONFIRMED','INELIGIBLE','REASSIGNED','APPROVED')),
  estimated_cost_minor integer NOT NULL CHECK (estimated_cost_minor >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  proposed_at timestamptz NOT NULL,
  decided_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  FOREIGN KEY (prize_id, contest_id) REFERENCES hon.champions_contest_prizes(id, contest_id) ON DELETE RESTRICT,
  UNIQUE (contest_id, place),
  CHECK (status IN ('REJECTED') OR school_id IS NOT NULL)
);
-- A school wins at most one live place per contest.
CREATE UNIQUE INDEX champions_contest_one_live_win ON hon.champions_contest_winners(contest_id, school_id) WHERE status <> 'REJECTED';

CREATE TABLE hon.champions_contest_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contest_id uuid NOT NULL REFERENCES hon.champions_contests(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('CREATE','UPDATE','DUPLICATE','SCHEDULE','ACTIVATE','PAUSE','RESUME','END','PROPOSE_WINNERS',
    'APPROVE_WINNER','DISPUTE_WINNER','REJECT_WINNER','RESOLVE_WINNER','COMPLETE','CANCEL')),
  from_status text NOT NULL,
  to_status text NOT NULL,
  contest_version integer NOT NULL,
  winner_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL
);

ALTER TABLE hon.champions_audit DROP CONSTRAINT champions_audit_action_code_check;
ALTER TABLE hon.champions_audit ADD CONSTRAINT champions_audit_action_code_check CHECK (action_code IN ('champions.code.issue',
  'champions.policy.draft','champions.policy.publish','champions.attribution.capture','champions.attribution.decide',
  'champions.reward_policy.draft','champions.reward_policy.publish','champions.rewards.reconcile','champions.reward.decide',
  'champions.leaderboard.preference','champions.leaderboard.hold','champions.contest.command'));
ALTER TABLE hon.champions_audit DROP CONSTRAINT champions_audit_entity_type_check;
ALTER TABLE hon.champions_audit ADD CONSTRAINT champions_audit_entity_type_check CHECK (entity_type IN ('REFERRAL_CODE','POLICY',
  'ATTRIBUTION','REWARD_POLICY','REWARD_SCHOOL','REWARD_ENTRY','LEADERBOARD_PREFERENCE','LEADERBOARD_HOLD','CONTEST'));
ALTER TABLE hon.champions_outbox DROP CONSTRAINT champions_outbox_event_type_check;
ALTER TABLE hon.champions_outbox ADD CONSTRAINT champions_outbox_event_type_check CHECK (event_type IN ('champions.referral_code.issued',
  'champions.policy.drafted','champions.policy.published','champions.attribution.captured','champions.attribution.decided',
  'champions.reward_policy.drafted','champions.reward_policy.published','champions.rewards.reconciled','champions.reward.decided',
  'champions.leaderboard.preference_set','champions.leaderboard.hold_changed','champions.contest.changed'));

-- Configuration is editable only while DRAFT; afterwards only lifecycle columns move, and the
-- frozen results and history never change. Nothing is ever deleted except draft-only child rows.
CREATE FUNCTION hon.guard_champions_contests() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, hon AS $$
DECLARE parent_status text; lifecycle constant text[] := ARRAY['status','version','scheduled_by_principal_id','scheduled_at','activated_at',
  'ended_at','completed_at','cancelled_at','cancel_reason','school_visibility'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'IMMUTABLE_CHAMPIONS_RECORD' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'INSERT' THEN
    -- Prizes and eligible schools are configuration: added only while the contest is a draft.
    SELECT status INTO parent_status FROM hon.champions_contests WHERE id = NEW.contest_id;
    IF parent_status = 'DRAFT' THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'IMMUTABLE_CHAMPIONS_RECORD' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'champions_contests' THEN
    IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND NEW.id = OLD.id AND NEW.created_at = OLD.created_at
      AND NEW.created_by_principal_id = OLD.created_by_principal_id AND NEW.duplicated_from IS NOT DISTINCT FROM OLD.duplicated_from
      AND (OLD.status = 'DRAFT' OR (to_jsonb(NEW) - lifecycle) = (to_jsonb(OLD) - lifecycle))
      AND (OLD.status = 'DRAFT' OR NEW.school_visibility = OLD.school_visibility)
      AND ((OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT','SCHEDULED','CANCELLED'))
        OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('ACTIVE','CANCELLED'))
        OR (OLD.status = 'ACTIVE' AND NEW.status IN ('PAUSED','ENDED','CANCELLED'))
        OR (OLD.status = 'PAUSED' AND NEW.status IN ('ACTIVE','ENDED','CANCELLED'))
        OR (OLD.status = 'ENDED' AND NEW.status = 'PENDING_WINNER_APPROVAL')
        OR (OLD.status = 'PENDING_WINNER_APPROVAL' AND NEW.status IN ('PENDING_WINNER_APPROVAL','COMPLETED'))) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME IN ('champions_contest_prizes','champions_contest_schools') THEN
    SELECT status INTO parent_status FROM hon.champions_contests WHERE id = OLD.contest_id;
    IF TG_OP = 'DELETE' AND parent_status = 'DRAFT' THEN RETURN OLD; END IF;
  ELSIF TG_TABLE_NAME = 'champions_contest_pauses' THEN
    IF TG_OP = 'UPDATE' AND OLD.resumed_at IS NULL AND NEW.resumed_at IS NOT NULL
      AND (to_jsonb(NEW) - ARRAY['resumed_at','resumed_by_principal_id']) = (to_jsonb(OLD) - ARRAY['resumed_at','resumed_by_principal_id']) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'champions_contest_winners' THEN
    IF TG_OP = 'UPDATE' AND NEW.version = OLD.version + 1 AND NEW.id = OLD.id AND NEW.contest_id = OLD.contest_id
      AND NEW.prize_id = OLD.prize_id AND NEW.place = OLD.place AND NEW.estimated_cost_minor = OLD.estimated_cost_minor
      AND NEW.proposed_at = OLD.proposed_at THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_CHAMPIONS_RECORD' USING ERRCODE = '42501';
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_contests','champions_contest_prizes','champions_contest_schools','champions_contest_pauses','champions_contest_winners'] LOOP
    EXECUTE format('CREATE TRIGGER champions_guarded BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_champions_contests()',t);
    EXECUTE format('CREATE TRIGGER champions_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_champions_contests()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['champions_contest_prizes','champions_contest_schools'] LOOP
    EXECUTE format('CREATE TRIGGER champions_draft_only BEFORE INSERT ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_champions_contests()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['champions_contest_results','champions_contest_history'] LOOP
    EXECUTE format('CREATE TRIGGER champions_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_champions_evidence()',t);
    EXECUTE format('CREATE TRIGGER champions_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_champions_evidence()',t);
  END LOOP;
END $$;

-- ---------- private helpers ----------
-- Live contest counts from verified records. A referral counts once, for its referrer school,
-- when it is QUALIFIED now, qualified inside [starts_at, cutoff), outside every pause, and
-- (by default) also captured inside the window. Eligibility and holds are reported, not hidden.
CREATE FUNCTION hon.champions_contest_counts(p_contest uuid, p_cutoff timestamptz)
RETURNS TABLE (school_id uuid, organization_id uuid, qualified integer, reached_at timestamptz, ineligible_reason text)
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  WITH c AS (SELECT * FROM hon.champions_contests WHERE id = p_contest),
  counted AS (
    SELECT a.referrer_school_id, a.referrer_organization_id, count(*)::integer qualified, max(a.qualified_at) reached_at
    FROM hon.champions_attributions a, c
    WHERE a.state = 'QUALIFIED' AND a.qualified_at >= c.starts_at AND a.qualified_at < least(c.ends_at, p_cutoff)
      AND (c.count_basis = 'QUALIFIED_IN_WINDOW' OR (a.captured_at >= c.starts_at AND a.captured_at < c.ends_at))
      AND NOT EXISTS (SELECT 1 FROM hon.champions_contest_pauses pz WHERE pz.contest_id = c.id
        AND a.qualified_at >= pz.paused_at AND a.qualified_at < coalesce(pz.resumed_at, 'infinity'::timestamptz))
    GROUP BY a.referrer_school_id, a.referrer_organization_id)
  SELECT k.referrer_school_id, k.referrer_organization_id, k.qualified, k.reached_at,
    CASE
      WHEN c.eligibility_scope = 'SELECTED_SCHOOLS' AND NOT EXISTS (SELECT 1 FROM hon.champions_contest_schools cs
        WHERE cs.contest_id = c.id AND cs.school_id = k.referrer_school_id) THEN 'NOT_SELECTED'
      WHEN NOT EXISTS (SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id = s.organization_id
        WHERE s.id = k.referrer_school_id AND s.status = 'ACTIVE' AND o.status = 'ACTIVE') THEN 'SCHOOL_INACTIVE'
      WHEN NOT EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = k.referrer_organization_id
        AND e.status = 'ACTIVE' AND e.tier::text = ANY(c.eligible_tiers)) THEN 'TIER_NOT_ELIGIBLE'
      WHEN EXISTS (SELECT 1 FROM hon.champions_leaderboard_holds h WHERE h.school_id = k.referrer_school_id AND h.status = 'ACTIVE') THEN 'LEADERBOARD_HOLD'
      WHEN k.qualified < c.minimum_qualified THEN 'BELOW_MINIMUM'
    END
  FROM counted k, c
$$;

-- Ranked view over counts (live) or frozen results. Ties share a rank; position breaks ties
-- by who reached the count first, then school id.
CREATE FUNCTION hon.champions_contest_standings(p_contest uuid)
RETURNS TABLE (school_id uuid, organization_id uuid, qualified integer, reached_at timestamptz, eligible boolean, ineligible_reason text,
  standing_rank integer, standing_position integer, frozen boolean)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, hon AS $$
DECLARE c hon.champions_contests%ROWTYPE;
BEGIN
  SELECT * INTO c FROM hon.champions_contests WHERE id = p_contest;
  IF EXISTS (SELECT 1 FROM hon.champions_contest_results r WHERE r.contest_id = p_contest) OR c.status IN ('ENDED','PENDING_WINNER_APPROVAL','COMPLETED') THEN
    RETURN QUERY SELECT r.school_id, r.organization_id, r.qualified_count, r.reached_at, r.eligible, r.ineligible_reason, r.standing_rank, r.standing_position, true
      FROM hon.champions_contest_results r WHERE r.contest_id = p_contest;
    RETURN;
  END IF;
  IF c.status NOT IN ('ACTIVE','PAUSED') THEN RETURN; END IF;
  RETURN QUERY
    WITH k AS (SELECT * FROM hon.champions_contest_counts(p_contest, clock_timestamp()))
    SELECT k.school_id, k.organization_id, k.qualified, k.reached_at, k.ineligible_reason IS NULL, k.ineligible_reason,
      CASE WHEN k.ineligible_reason IS NULL THEN (rank() OVER (PARTITION BY k.ineligible_reason IS NULL ORDER BY k.qualified DESC))::integer END,
      CASE WHEN k.ineligible_reason IS NULL THEN (row_number() OVER (PARTITION BY k.ineligible_reason IS NULL ORDER BY k.qualified DESC, k.reached_at, k.school_id))::integer END,
      false
    FROM k;
END $$;

CREATE FUNCTION hon.champions_contest_json(c hon.champions_contests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, hon AS $$
  SELECT jsonb_build_object('contestId', c.id, 'name', c.name, 'description', c.description, 'termsReference', c.terms_reference,
    'status', c.status, 'version', c.version, 'startsAt', hon.champions_ts(c.starts_at), 'endsAt', hon.champions_ts(c.ends_at),
    'countBasis', c.count_basis, 'minimumQualified', c.minimum_qualified, 'tieRule', c.tie_rule,
    'eligibility', jsonb_build_object('scope', c.eligibility_scope, 'tiers', to_jsonb(c.eligible_tiers),
      'schoolIds', coalesce((SELECT jsonb_agg(cs.school_id ORDER BY cs.school_id) FROM hon.champions_contest_schools cs WHERE cs.contest_id = c.id), '[]'::jsonb)),
    'budgetMinor', c.budget_minor, 'currency', c.currency, 'giftCardCompliance', c.gift_card_compliance, 'schoolVisibility', c.school_visibility,
    'publicListing', 'DISABLED', 'financialActivation', 'DISABLED', 'automaticTransitions', 'NOT_CONFIGURED',
    'prizes', coalesce((SELECT jsonb_agg(jsonb_build_object('prizeId', p.id, 'placeFrom', p.place_from, 'placeTo', p.place_to, 'kind', p.prize_kind,
        'description', p.description, 'quantity', p.quantity, 'estimatedUnitCostMinor', p.estimated_unit_cost_minor) ORDER BY p.place_from)
      FROM hon.champions_contest_prizes p WHERE p.contest_id = c.id), '[]'::jsonb),
    'estimatedPrizeCostMinor', (SELECT coalesce(sum((p.place_to - p.place_from + 1) * p.quantity * p.estimated_unit_cost_minor), 0)
      FROM hon.champions_contest_prizes p WHERE p.contest_id = c.id),
    'due', CASE WHEN c.status = 'SCHEDULED' AND clock_timestamp() >= c.starts_at THEN 'START_DUE'
      WHEN c.status IN ('ACTIVE','PAUSED') AND clock_timestamp() >= c.ends_at THEN 'END_DUE' ELSE 'NONE' END,
    'duplicatedFrom', c.duplicated_from, 'createdAt', hon.champions_ts(c.created_at),
    'scheduledAt', CASE WHEN c.scheduled_at IS NULL THEN NULL ELSE hon.champions_ts(c.scheduled_at) END,
    'activatedAt', CASE WHEN c.activated_at IS NULL THEN NULL ELSE hon.champions_ts(c.activated_at) END,
    'endedAt', CASE WHEN c.ended_at IS NULL THEN NULL ELSE hon.champions_ts(c.ended_at) END,
    'completedAt', CASE WHEN c.completed_at IS NULL THEN NULL ELSE hon.champions_ts(c.completed_at) END,
    'cancelledAt', CASE WHEN c.cancelled_at IS NULL THEN NULL ELSE hon.champions_ts(c.cancelled_at) END,
    'cancelReason', c.cancel_reason)
$$;

-- Validates and writes a full draft configuration (CREATE, UPDATE, DUPLICATE). Child rows are
-- replaced while the contest is a draft.
CREATE FUNCTION hon.champions_contest_write_config(p_contest uuid, p jsonb, p_update_fields boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE prize jsonb; school text; elig jsonb;
BEGIN
  elig := p->'eligibility';
  IF jsonb_typeof(elig) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(elig) k) IS DISTINCT FROM ARRAY['schoolIds','scope','tiers']
    OR jsonb_typeof(elig->'tiers') <> 'array' OR jsonb_typeof(elig->'schoolIds') <> 'array' OR jsonb_array_length(elig->'schoolIds') > 500
    OR jsonb_typeof(p->'prizes') <> 'array' OR jsonb_array_length(p->'prizes') NOT BETWEEN 0 AND 20
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(elig->'tiers') t WHERE jsonb_typeof(t) <> 'string')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(elig->'schoolIds') s WHERE jsonb_typeof(s) <> 'string'
      OR s #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR ((elig->>'scope') = 'SELECTED_SCHOOLS') <> (jsonb_array_length(elig->'schoolIds') > 0) THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p_update_fields THEN
  UPDATE hon.champions_contests SET name = p->>'name', description = p->>'description', terms_reference = p->>'termsReference',
      starts_at = (p->>'startsAt')::timestamptz, ends_at = (p->>'endsAt')::timestamptz, count_basis = p->>'countBasis',
      minimum_qualified = (p->>'minimumQualified')::integer, tie_rule = p->>'tieRule', eligibility_scope = elig->>'scope',
      eligible_tiers = ARRAY(SELECT DISTINCT t FROM jsonb_array_elements_text(elig->'tiers') t ORDER BY t),
      budget_minor = (p->>'budgetMinor')::integer, gift_card_compliance = p->>'giftCardCompliance', version = version + 1
    WHERE id = p_contest AND status = 'DRAFT';
  END IF;
  DELETE FROM hon.champions_contest_prizes WHERE contest_id = p_contest;
  DELETE FROM hon.champions_contest_schools WHERE contest_id = p_contest;
  FOR prize IN SELECT * FROM jsonb_array_elements(p->'prizes') LOOP
    IF jsonb_typeof(prize) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(prize) k)
        IS DISTINCT FROM ARRAY['description','estimatedUnitCostMinor','kind','placeFrom','placeTo','quantity']
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['placeFrom','placeTo','quantity','estimatedUnitCostMinor']) k
        WHERE jsonb_typeof(prize->k) <> 'number' OR (prize->>k) !~ '^[0-9]{1,8}$')
      OR jsonb_typeof(prize->'kind') <> 'string' OR jsonb_typeof(prize->'description') <> 'string' THEN
      RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
    END IF;
    INSERT INTO hon.champions_contest_prizes(contest_id,place_from,place_to,prize_kind,description,quantity,estimated_unit_cost_minor)
      VALUES (p_contest, (prize->>'placeFrom')::integer, (prize->>'placeTo')::integer, prize->>'kind', prize->>'description',
        (prize->>'quantity')::integer, (prize->>'estimatedUnitCostMinor')::integer);
  END LOOP;
  IF EXISTS (SELECT 1 FROM hon.champions_contest_prizes a JOIN hon.champions_contest_prizes b ON a.contest_id = b.contest_id AND a.id < b.id
      AND a.place_from <= b.place_to AND b.place_from <= a.place_to WHERE a.contest_id = p_contest) THEN
    RAISE EXCEPTION 'CHAMPIONS_CONTEST_PRIZES_OVERLAP' USING ERRCODE = '23514';
  END IF;
  FOR school IN SELECT DISTINCT s FROM jsonb_array_elements_text(elig->'schoolIds') s LOOP
    IF NOT EXISTS (SELECT 1 FROM hon.schools WHERE id = school::uuid) THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
    INSERT INTO hon.champions_contest_schools(contest_id, school_id) VALUES (p_contest, school::uuid);
  END LOOP;
END $$;

-- ---------- the one contest command ----------
-- Actions and authority (HQ only; never school staff, families or AI):
--   CREATE, UPDATE, DUPLICATE, ACTIVATE, PAUSE, END (at or after endsAt), PROPOSE_WINNERS,
--   DISPUTE_WINNER: HQ owner or operator.
--   SCHEDULE (owner approval of the whole configuration, budget and visibility), RESUME,
--   early END, APPROVE_WINNER, REJECT_WINNER, RESOLVE_WINNER, COMPLETE, CANCEL: HQ owner.
CREATE FUNCTION hon.command_champions_contest(p_subject text, p_contest uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE action text; keys text[]; config_keys constant text[] := ARRAY['budgetMinor','countBasis','description','eligibility','endsAt',
    'giftCardCompliance','minimumQualified','name','prizes','startsAt','termsReference','tieRule'];
  owner_only boolean; actor uuid; replay jsonb; c hon.champions_contests%ROWTYPE; prior_status text; at timestamptz;
  w hon.champions_contest_winners%ROWTYPE; target uuid; expected integer; detail jsonb := '{}'::jsonb; prize record; place integer;
  cand record; result jsonb; winner_id uuid := NULL;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR jsonb_typeof(p->'action') <> 'string' THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  action := p->>'action';
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(p) k;
  -- Closed shapes per action.
  IF NOT (
    (action = 'CREATE' AND p_contest IS NULL AND keys = (SELECT array_agg(k ORDER BY k) FROM unnest(config_keys || ARRAY['action']) k))
    OR (action = 'UPDATE' AND p_contest IS NOT NULL AND keys = (SELECT array_agg(k ORDER BY k) FROM unnest(config_keys || ARRAY['action','expectedVersion']) k))
    OR (action = 'DUPLICATE' AND p_contest IS NOT NULL AND keys = ARRAY['action','endsAt','name','startsAt'])
    OR (action = 'SCHEDULE' AND p_contest IS NOT NULL AND keys = ARRAY['action','expectedVersion','schoolVisibility'])
    OR (action IN ('ACTIVATE','PAUSE','RESUME','END','PROPOSE_WINNERS','COMPLETE') AND p_contest IS NOT NULL AND keys = ARRAY['action','expectedVersion'])
    OR (action = 'CANCEL' AND p_contest IS NOT NULL AND keys = ARRAY['action','expectedVersion','reasonCode'])
    OR (action IN ('APPROVE_WINNER') AND p_contest IS NOT NULL AND keys = ARRAY['action','expectedVersion','winnerId'])
    OR (action IN ('DISPUTE_WINNER','REJECT_WINNER') AND p_contest IS NOT NULL AND keys = ARRAY['action','expectedVersion','reasonCode','winnerId'])
    OR (action = 'RESOLVE_WINNER' AND p_contest IS NOT NULL AND keys = ARRAY['action','expectedVersion','schoolId','winnerId'])) THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF p ? 'expectedVersion' AND (jsonb_typeof(p->'expectedVersion') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$') THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  IF (p ? 'winnerId' AND (jsonb_typeof(p->'winnerId') <> 'string' OR (p->>'winnerId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR (p ? 'schoolId' AND (jsonb_typeof(p->'schoolId') <> 'string' OR (p->>'schoolId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    OR (p ? 'schoolVisibility' AND p->>'schoolVisibility' NOT IN ('HIDDEN','ELIGIBLE_SCHOOLS'))
    OR (action = 'CANCEL' AND p->>'reasonCode' NOT IN ('OWNER_DECISION','POLICY_CHANGE','FRAUD_CONCERN','LEGAL_REVIEW'))
    OR (action = 'DISPUTE_WINNER' AND p->>'reasonCode' NOT IN ('DISPUTE_RAISED'))
    OR (action = 'REJECT_WINNER' AND p->>'reasonCode' NOT IN ('DISPUTE_UPHELD','FRAUD_CONFIRMED','INELIGIBLE'))
    OR (action IN ('CREATE','UPDATE','DUPLICATE') AND (jsonb_typeof(p->'name') <> 'string' OR jsonb_typeof(p->'startsAt') <> 'string'
      OR jsonb_typeof(p->'endsAt') <> 'string'
      OR (p->>'startsAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      OR (p->>'endsAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'))
    OR (action IN ('CREATE','UPDATE') AND (jsonb_typeof(p->'description') <> 'string' OR jsonb_typeof(p->'termsReference') NOT IN ('string','null')
      OR jsonb_typeof(p->'countBasis') <> 'string' OR jsonb_typeof(p->'tieRule') <> 'string' OR jsonb_typeof(p->'giftCardCompliance') <> 'string'
      OR jsonb_typeof(p->'minimumQualified') <> 'number' OR (p->>'minimumQualified') !~ '^[0-9]{1,4}$'
      OR jsonb_typeof(p->'budgetMinor') NOT IN ('number','null') OR (jsonb_typeof(p->'budgetMinor') = 'number' AND (p->>'budgetMinor') !~ '^[0-9]{1,9}$'))) THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  owner_only := action IN ('SCHEDULE','RESUME','APPROVE_WINNER','REJECT_WINNER','RESOLVE_WINNER','COMPLETE','CANCEL');
  actor := hon.require_champions_hq_actor(p_subject, owner_only);
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, owner_only);
  replay := hon.champions_claim_request(actor, p_key, 'champions.contest.command',
    hon.champions_fingerprint(ARRAY['champions.contest.command', coalesce(p_contest::text, ''), p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  at := clock_timestamp();

  IF action = 'CREATE' THEN
    IF jsonb_typeof(p->'eligibility') <> 'object' OR jsonb_typeof(p->'eligibility'->'tiers') <> 'array'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p->'eligibility'->'tiers') t WHERE jsonb_typeof(t) <> 'string') THEN
      RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
    END IF;
    INSERT INTO hon.champions_contests(name,description,terms_reference,starts_at,ends_at,count_basis,minimum_qualified,tie_rule,eligibility_scope,
        eligible_tiers,budget_minor,gift_card_compliance,created_by_principal_id,created_at)
      VALUES (p->>'name', p->>'description', p->>'termsReference', (p->>'startsAt')::timestamptz, (p->>'endsAt')::timestamptz, p->>'countBasis',
        (p->>'minimumQualified')::integer, p->>'tieRule', p->'eligibility'->>'scope',
        ARRAY(SELECT DISTINCT t FROM jsonb_array_elements_text(p->'eligibility'->'tiers') t ORDER BY t),
        (p->>'budgetMinor')::integer, p->>'giftCardCompliance', actor, at) RETURNING * INTO c;
    PERFORM hon.champions_contest_write_config(c.id, p, false);
    prior_status := 'NONE';
  ELSIF action = 'DUPLICATE' THEN
    SELECT * INTO c FROM hon.champions_contests WHERE id = p_contest;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
    -- A copy is a fresh DRAFT: same rules, prizes and eligibility; new name and dates; never scheduled.
    INSERT INTO hon.champions_contests(name,description,terms_reference,starts_at,ends_at,count_basis,minimum_qualified,tie_rule,eligibility_scope,
        eligible_tiers,budget_minor,gift_card_compliance,duplicated_from,created_by_principal_id,created_at)
      VALUES (p->>'name', c.description, c.terms_reference, (p->>'startsAt')::timestamptz, (p->>'endsAt')::timestamptz, c.count_basis,
        c.minimum_qualified, c.tie_rule, c.eligibility_scope, c.eligible_tiers, c.budget_minor, c.gift_card_compliance, c.id, actor, at)
      RETURNING * INTO c;
    INSERT INTO hon.champions_contest_prizes(contest_id,place_from,place_to,prize_kind,description,quantity,estimated_unit_cost_minor)
      SELECT c.id, place_from, place_to, prize_kind, description, quantity, estimated_unit_cost_minor FROM hon.champions_contest_prizes WHERE contest_id = p_contest;
    INSERT INTO hon.champions_contest_schools(contest_id, school_id) SELECT c.id, school_id FROM hon.champions_contest_schools WHERE contest_id = p_contest;
    prior_status := 'NONE'; detail := jsonb_build_object('duplicatedFrom', p_contest);
  ELSE
    SELECT * INTO c FROM hon.champions_contests WHERE id = p_contest FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
    expected := (p->>'expectedVersion')::integer;
    IF c.version <> expected THEN RAISE EXCEPTION 'CHAMPIONS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
    prior_status := c.status;
    IF action = 'UPDATE' THEN
      IF c.status <> 'DRAFT' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      PERFORM hon.champions_contest_write_config(c.id, p, true);
    ELSIF action = 'SCHEDULE' THEN
      IF c.status <> 'DRAFT' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      -- Owner approval of a complete, budgeted, compliant configuration.
      IF c.terms_reference IS NULL OR c.budget_minor IS NULL OR NOT EXISTS (SELECT 1 FROM hon.champions_contest_prizes WHERE contest_id = c.id) THEN
        RAISE EXCEPTION 'CHAMPIONS_CONTEST_INCOMPLETE' USING ERRCODE = '23514';
      END IF;
      IF c.ends_at <= at THEN RAISE EXCEPTION 'CHAMPIONS_CONTEST_WINDOW_PASSED' USING ERRCODE = '23514'; END IF;
      IF (SELECT sum((place_to - place_from + 1) * quantity * estimated_unit_cost_minor) FROM hon.champions_contest_prizes WHERE contest_id = c.id) > c.budget_minor THEN
        RAISE EXCEPTION 'CHAMPIONS_CONTEST_OVER_BUDGET' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM hon.champions_contest_prizes WHERE contest_id = c.id AND prize_kind = 'GIFT_CARD') AND c.gift_card_compliance <> 'PERMITTED' THEN
        RAISE EXCEPTION 'CHAMPIONS_GIFT_CARDS_NOT_PERMITTED' USING ERRCODE = '23514';
      END IF;
      UPDATE hon.champions_contests SET status = 'SCHEDULED', version = version + 1, scheduled_by_principal_id = actor, scheduled_at = at,
          school_visibility = p->>'schoolVisibility' WHERE id = c.id;
      detail := jsonb_build_object('schoolVisibility', p->>'schoolVisibility');
    ELSIF action = 'ACTIVATE' THEN
      IF c.status <> 'SCHEDULED' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      IF at < c.starts_at THEN RAISE EXCEPTION 'CHAMPIONS_CONTEST_NOT_STARTED' USING ERRCODE = '23514'; END IF;
      IF at >= c.ends_at THEN RAISE EXCEPTION 'CHAMPIONS_CONTEST_WINDOW_PASSED' USING ERRCODE = '23514'; END IF;
      UPDATE hon.champions_contests SET status = 'ACTIVE', version = version + 1, activated_at = at WHERE id = c.id;
    ELSIF action = 'PAUSE' THEN
      IF c.status <> 'ACTIVE' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      INSERT INTO hon.champions_contest_pauses(contest_id, paused_at, paused_by_principal_id) VALUES (c.id, at, actor);
      UPDATE hon.champions_contests SET status = 'PAUSED', version = version + 1 WHERE id = c.id;
    ELSIF action = 'RESUME' THEN
      IF c.status <> 'PAUSED' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      IF at >= c.ends_at THEN RAISE EXCEPTION 'CHAMPIONS_CONTEST_WINDOW_PASSED' USING ERRCODE = '23514'; END IF;
      UPDATE hon.champions_contest_pauses SET resumed_at = at, resumed_by_principal_id = actor WHERE contest_id = c.id AND resumed_at IS NULL;
      UPDATE hon.champions_contests SET status = 'ACTIVE', version = version + 1 WHERE id = c.id;
    ELSIF action = 'END' THEN
      IF c.status NOT IN ('ACTIVE','PAUSED') THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      -- Ending before endsAt cuts the window short and is the owner's call alone.
      IF at < c.ends_at THEN
        PERFORM hon.require_champions_hq_actor(p_subject, true);
        detail := jsonb_build_object('earlyEnd', true);
      END IF;
      UPDATE hon.champions_contest_pauses SET resumed_at = least(at, c.ends_at), resumed_by_principal_id = actor WHERE contest_id = c.id AND resumed_at IS NULL;
      -- Attribution decisions cannot change underneath the freeze.
      LOCK TABLE hon.champions_attributions, hon.champions_leaderboard_holds IN SHARE MODE;
      INSERT INTO hon.champions_contest_results(contest_id,school_id,organization_id,qualified_count,reached_at,eligible,ineligible_reason,standing_rank,standing_position,frozen_at)
        SELECT c.id, k.school_id, k.organization_id, k.qualified, k.reached_at, k.ineligible_reason IS NULL, k.ineligible_reason,
          CASE WHEN k.ineligible_reason IS NULL THEN (rank() OVER (PARTITION BY k.ineligible_reason IS NULL ORDER BY k.qualified DESC))::integer END,
          CASE WHEN k.ineligible_reason IS NULL THEN (row_number() OVER (PARTITION BY k.ineligible_reason IS NULL ORDER BY k.qualified DESC, k.reached_at, k.school_id))::integer END,
          at
        FROM hon.champions_contest_counts(c.id, at) k;
      UPDATE hon.champions_contests SET status = 'ENDED', version = version + 1, ended_at = at WHERE id = c.id;
      detail := detail || jsonb_build_object('frozenResults', (SELECT count(*) FROM hon.champions_contest_results WHERE contest_id = c.id));
    ELSIF action = 'PROPOSE_WINNERS' THEN
      IF c.status <> 'ENDED' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      FOR prize IN SELECT * FROM hon.champions_contest_prizes WHERE contest_id = c.id ORDER BY place_from LOOP
        FOR place IN prize.place_from..prize.place_to LOOP
          SELECT * INTO cand FROM hon.champions_contest_results r WHERE r.contest_id = c.id AND r.eligible AND r.standing_position = place;
          CONTINUE WHEN NOT FOUND;
          -- Under OWNER_RESOLVES, a tie whose schools fall on different prize outcomes needs the owner.
          INSERT INTO hon.champions_contest_winners(contest_id,prize_id,place,school_id,status,reason_code,estimated_cost_minor,proposed_at)
            VALUES (c.id, prize.id, place, cand.school_id,
              CASE WHEN c.tie_rule = 'OWNER_RESOLVES' AND EXISTS (SELECT 1 FROM hon.champions_contest_results o WHERE o.contest_id = c.id AND o.eligible
                AND o.school_id <> cand.school_id AND o.standing_rank = cand.standing_rank
                AND coalesce((SELECT pp.id FROM hon.champions_contest_prizes pp WHERE pp.contest_id = c.id AND o.standing_position BETWEEN pp.place_from AND pp.place_to), '00000000-0000-0000-0000-000000000000'::uuid) <> prize.id)
                THEN 'TIE_REVIEW' ELSE 'PROPOSED' END,
              CASE WHEN c.tie_rule = 'OWNER_RESOLVES' AND EXISTS (SELECT 1 FROM hon.champions_contest_results o WHERE o.contest_id = c.id AND o.eligible
                AND o.school_id <> cand.school_id AND o.standing_rank = cand.standing_rank
                AND coalesce((SELECT pp.id FROM hon.champions_contest_prizes pp WHERE pp.contest_id = c.id AND o.standing_position BETWEEN pp.place_from AND pp.place_to), '00000000-0000-0000-0000-000000000000'::uuid) <> prize.id)
                THEN 'TIE_AT_BOUNDARY' END,
              prize.quantity * prize.estimated_unit_cost_minor, at);
        END LOOP;
      END LOOP;
      UPDATE hon.champions_contests SET status = 'PENDING_WINNER_APPROVAL', version = version + 1 WHERE id = c.id;
      detail := jsonb_build_object('winners', (SELECT count(*) FROM hon.champions_contest_winners WHERE contest_id = c.id),
        'tieReview', (SELECT count(*) FROM hon.champions_contest_winners WHERE contest_id = c.id AND status = 'TIE_REVIEW'));
    ELSIF action IN ('APPROVE_WINNER','DISPUTE_WINNER','REJECT_WINNER','RESOLVE_WINNER') THEN
      IF c.status <> 'PENDING_WINNER_APPROVAL' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      SELECT * INTO w FROM hon.champions_contest_winners WHERE id = (p->>'winnerId')::uuid AND contest_id = c.id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
      winner_id := w.id;
      IF action = 'APPROVE_WINNER' THEN
        IF w.status <> 'PROPOSED' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
        UPDATE hon.champions_contest_winners SET status = 'APPROVED', reason_code = 'APPROVED', version = version + 1, decided_by_principal_id = actor, decided_at = at WHERE id = w.id;
      ELSIF action = 'DISPUTE_WINNER' THEN
        IF w.status NOT IN ('PROPOSED','APPROVED') THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
        UPDATE hon.champions_contest_winners SET status = 'DISPUTED', reason_code = 'DISPUTE_RAISED', version = version + 1, decided_by_principal_id = actor, decided_at = at WHERE id = w.id;
      ELSIF action = 'REJECT_WINNER' THEN
        IF w.status NOT IN ('PROPOSED','DISPUTED','TIE_REVIEW') THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
        UPDATE hon.champions_contest_winners SET status = 'REJECTED', reason_code = p->>'reasonCode', version = version + 1, decided_by_principal_id = actor, decided_at = at WHERE id = w.id;
      ELSE
        -- Resolve a tie, dismiss a dispute (same school) or reassign a rejected place, always to
        -- an eligible frozen result that does not already hold a live win in this contest.
        IF w.status NOT IN ('TIE_REVIEW','DISPUTED','REJECTED') THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
        target := (p->>'schoolId')::uuid;
        IF NOT EXISTS (SELECT 1 FROM hon.champions_contest_results r WHERE r.contest_id = c.id AND r.school_id = target AND r.eligible) THEN
          RAISE EXCEPTION 'CHAMPIONS_CONTEST_WINNER_NOT_ELIGIBLE' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM hon.champions_contest_winners o WHERE o.contest_id = c.id AND o.school_id = target AND o.status <> 'REJECTED' AND o.id <> w.id) THEN
          RAISE EXCEPTION 'CHAMPIONS_CONTEST_WINNER_NOT_ELIGIBLE' USING ERRCODE = '23514';
        END IF;
        UPDATE hon.champions_contest_winners SET status = 'PROPOSED', school_id = target, version = version + 1, decided_by_principal_id = actor, decided_at = at,
            reason_code = CASE w.status WHEN 'TIE_REVIEW' THEN 'OWNER_TIE_RESOLUTION' WHEN 'DISPUTED' THEN CASE WHEN target = w.school_id THEN 'DISPUTE_DISMISSED' ELSE 'REASSIGNED' END ELSE 'REASSIGNED' END
          WHERE id = w.id;
      END IF;
      SELECT * INTO w FROM hon.champions_contest_winners WHERE id = w.id;
      detail := jsonb_build_object('winnerId', w.id, 'place', w.place, 'status', w.status, 'reasonCode', w.reason_code);
      UPDATE hon.champions_contests SET version = version + 1 WHERE id = c.id;
    ELSIF action = 'COMPLETE' THEN
      IF c.status <> 'PENDING_WINNER_APPROVAL' THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      IF EXISTS (SELECT 1 FROM hon.champions_contest_winners WHERE contest_id = c.id AND status IN ('PROPOSED','TIE_REVIEW','DISPUTED')) THEN
        RAISE EXCEPTION 'CHAMPIONS_CONTEST_WINNERS_UNRESOLVED' USING ERRCODE = '23514';
      END IF;
      UPDATE hon.champions_contests SET status = 'COMPLETED', version = version + 1, completed_at = at WHERE id = c.id;
    ELSIF action = 'CANCEL' THEN
      IF c.status NOT IN ('DRAFT','SCHEDULED','ACTIVE','PAUSED') THEN RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001'; END IF;
      UPDATE hon.champions_contest_pauses SET resumed_at = at, resumed_by_principal_id = actor WHERE contest_id = c.id AND resumed_at IS NULL;
      UPDATE hon.champions_contests SET status = 'CANCELLED', version = version + 1, cancelled_at = at, cancel_reason = p->>'reasonCode' WHERE id = c.id;
    END IF;
  END IF;
  SELECT * INTO c FROM hon.champions_contests WHERE id = c.id;
  INSERT INTO hon.champions_contest_history(contest_id,action,from_status,to_status,contest_version,winner_id,detail,actor_principal_id,occurred_at)
    VALUES (c.id, action, prior_status, c.status, c.version, winner_id, detail, actor, at);
  result := jsonb_build_object('contest', hon.champions_contest_json(c), 'action', action);
  RETURN hon.champions_record(actor, p_key, 'champions.contest.command', 'champions.contest.changed', 'CONTEST', c.id, NULL,
    CASE WHEN prior_status = 'NONE' THEN NULL ELSE jsonb_build_object('status', prior_status) END,
    jsonb_build_object('status', c.status, 'version', c.version, 'action', action), result, at);
END $$;

-- ---------- reads ----------
CREATE FUNCTION hon.read_champions_contests_from_hq(p_subject text, p_status text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE rows jsonb;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('DRAFT','SCHEDULED','ACTIVE','PAUSED','ENDED','PENDING_WINNER_APPROVAL','COMPLETED','CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM hon.require_champions_hq_actor(p_subject, false);
  SELECT coalesce(jsonb_agg(hon.champions_contest_json(c) ORDER BY c.starts_at DESC, c.id), '[]'::jsonb) INTO rows
    FROM (SELECT * FROM hon.champions_contests WHERE p_status IS NULL OR status = p_status ORDER BY starts_at DESC, id LIMIT 100) c;
  RETURN jsonb_build_object('contests', rows, 'limit', 100);
END $$;

CREATE FUNCTION hon.read_champions_contest_from_hq(p_subject text, p_contest uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE c hon.champions_contests%ROWTYPE; standings jsonb; winners jsonb; history jsonb; pauses jsonb;
BEGIN
  IF p_contest IS NULL THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  PERFORM hon.require_champions_hq_actor(p_subject, false);
  SELECT * INTO c FROM hon.champions_contests WHERE id = p_contest;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('schoolId', s.school_id, 'schoolName', sc.name, 'organizationId', s.organization_id,
      'qualifiedReferrals', s.qualified, 'reachedAt', hon.champions_ts(s.reached_at), 'eligible', s.eligible, 'ineligibleReason', s.ineligible_reason,
      'rank', s.standing_rank, 'position', s.standing_position) ORDER BY s.eligible DESC, s.standing_position NULLS LAST, s.qualified DESC, s.school_id), '[]'::jsonb)
    INTO standings FROM hon.champions_contest_standings(p_contest) s JOIN hon.schools sc ON sc.id = s.school_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('winnerId', w.id, 'place', w.place, 'prizeId', w.prize_id, 'schoolId', w.school_id,
      'schoolName', (SELECT name FROM hon.schools WHERE id = w.school_id), 'status', w.status, 'reasonCode', w.reason_code,
      'estimatedCostMinor', w.estimated_cost_minor, 'version', w.version,
      'decidedAt', CASE WHEN w.decided_at IS NULL THEN NULL ELSE hon.champions_ts(w.decided_at) END) ORDER BY w.place), '[]'::jsonb)
    INTO winners FROM hon.champions_contest_winners w WHERE w.contest_id = p_contest;
  SELECT coalesce(jsonb_agg(jsonb_build_object('pausedAt', hon.champions_ts(z.paused_at),
      'resumedAt', CASE WHEN z.resumed_at IS NULL THEN NULL ELSE hon.champions_ts(z.resumed_at) END) ORDER BY z.paused_at), '[]'::jsonb)
    INTO pauses FROM hon.champions_contest_pauses z WHERE z.contest_id = p_contest;
  SELECT coalesce(jsonb_agg(jsonb_build_object('action', h.action, 'fromStatus', h.from_status, 'toStatus', h.to_status, 'contestVersion', h.contest_version,
      'detail', h.detail, 'occurredAt', hon.champions_ts(h.occurred_at)) ORDER BY h.occurred_at, h.contest_version), '[]'::jsonb)
    INTO history FROM (SELECT * FROM hon.champions_contest_history WHERE contest_id = p_contest ORDER BY occurred_at DESC, contest_version DESC LIMIT 200) h;
  RETURN jsonb_build_object('contest', hon.champions_contest_json(c),
    'standings', standings, 'standingsFrozen', EXISTS (SELECT 1 FROM hon.champions_contest_results r WHERE r.contest_id = p_contest),
    'pauses', pauses, 'winners', winners,
    'liabilities', jsonb_build_object('currency', 'USD', 'budgetMinor', c.budget_minor,
      'estimatedPrizeCostMinor', (SELECT coalesce(sum((pp.place_to - pp.place_from + 1) * pp.quantity * pp.estimated_unit_cost_minor), 0) FROM hon.champions_contest_prizes pp WHERE pp.contest_id = p_contest),
      'pendingWinnerCostMinor', (SELECT coalesce(sum(estimated_cost_minor), 0) FROM hon.champions_contest_winners WHERE contest_id = p_contest AND status IN ('PROPOSED','TIE_REVIEW','DISPUTED')),
      'approvedWinnerCostMinor', (SELECT coalesce(sum(estimated_cost_minor), 0) FROM hon.champions_contest_winners WHERE contest_id = p_contest AND status = 'APPROVED'),
      'financialActivation', 'DISABLED'),
    'history', history, 'countsOnly', 'QUALIFIED');
END $$;

-- School view: only contests the owner made visible to eligible schools, and only if this
-- school is eligible. Other schools appear by rank and count, named only with M3 opt-in.
CREATE FUNCTION hon.read_champions_contests_for_school(p_subject text, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE scope record; rows jsonb;
BEGIN
  SELECT * INTO scope FROM hon.require_champions_school_actor(p_subject, p_school) LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('contestId', c.id, 'name', c.name, 'description', c.description, 'termsReference', c.terms_reference,
      'status', c.status, 'startsAt', hon.champions_ts(c.starts_at), 'endsAt', hon.champions_ts(c.ends_at), 'minimumQualified', c.minimum_qualified,
      'prizes', coalesce((SELECT jsonb_agg(jsonb_build_object('placeFrom', p.place_from, 'placeTo', p.place_to, 'kind', p.prize_kind, 'description', p.description, 'quantity', p.quantity)
        ORDER BY p.place_from) FROM hon.champions_contest_prizes p WHERE p.contest_id = c.id), '[]'::jsonb),
      'standings', coalesce((SELECT jsonb_agg(jsonb_build_object('rank', s.standing_rank,
          'displayName', CASE WHEN s.school_id = p_school OR pref.display_mode = 'SCHOOL_NAME' THEN sc.name END,
          'anonymous', NOT (s.school_id = p_school OR coalesce(pref.display_mode, 'ANONYMOUS') = 'SCHOOL_NAME'),
          'qualifiedReferrals', s.qualified, 'isYou', s.school_id = p_school) ORDER BY s.standing_position)
        FROM (SELECT * FROM hon.champions_contest_standings(c.id) x WHERE x.eligible ORDER BY x.standing_position LIMIT 10) s
        JOIN hon.schools sc ON sc.id = s.school_id LEFT JOIN hon.champions_leaderboard_preferences pref ON pref.school_id = s.school_id), '[]'::jsonb),
      'you', (SELECT jsonb_build_object('qualifiedReferrals', coalesce(max(s.qualified), 0),
          'status', CASE WHEN bool_or(s.eligible) THEN 'RANKED' ELSE 'NOT_RANKED' END,
          'rank', max(s.standing_rank)) FROM hon.champions_contest_standings(c.id) s WHERE s.school_id = p_school),
      'won', EXISTS (SELECT 1 FROM hon.champions_contest_winners w WHERE w.contest_id = c.id AND w.school_id = p_school AND w.status = 'APPROVED' AND c.status = 'COMPLETED'))
      ORDER BY c.starts_at DESC, c.id), '[]'::jsonb) INTO rows
    FROM hon.champions_contests c
    WHERE c.school_visibility = 'ELIGIBLE_SCHOOLS' AND c.status IN ('SCHEDULED','ACTIVE','PAUSED','ENDED','PENDING_WINNER_APPROVAL','COMPLETED')
      AND (c.eligibility_scope = 'ALL_ACTIVE_SCHOOLS' OR EXISTS (SELECT 1 FROM hon.champions_contest_schools cs WHERE cs.contest_id = c.id AND cs.school_id = p_school))
      AND EXISTS (SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id = scope.organization_id AND e.status = 'ACTIVE' AND e.tier::text = ANY(c.eligible_tiers));
  RETURN jsonb_build_object('schoolId', p_school, 'contests', rows, 'countsOnly', 'QUALIFIED');
END $$;

-- ---------- RLS and ACL ----------
DO $$ DECLARE t text; r text; col text; f text; BEGIN
  FOREACH t IN ARRAY ARRAY['champions_contests','champions_contest_prizes','champions_contest_schools','champions_contest_pauses',
      'champions_contest_results','champions_contest_winners','champions_contest_history'] LOOP
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
  FOREACH f IN ARRAY ARRAY['hon.guard_champions_contests()','hon.champions_contest_counts(uuid,timestamptz)','hon.champions_contest_standings(uuid)',
      'hon.champions_contest_json(hon.champions_contests)','hon.champions_contest_write_config(uuid,jsonb,boolean)',
      'hon.command_champions_contest(text,uuid,jsonb,uuid,uuid,uuid)','hon.read_champions_contests_from_hq(text,text)',
      'hon.read_champions_contest_from_hq(text,uuid)','hon.read_champions_contests_for_school(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.command_champions_contest(text,uuid,jsonb,uuid,uuid,uuid), hon.read_champions_contests_from_hq(text,text),
      hon.read_champions_contest_from_hq(text,uuid), hon.read_champions_contests_for_school(text,uuid)
      TO hon_runtime;
  END IF;
END $$;

COMMIT;
