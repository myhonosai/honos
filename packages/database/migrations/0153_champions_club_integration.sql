BEGIN;

-- HON Champions Club Milestone 5: integration and hardening.
-- 1. Attribution decisions (QUALIFY, REJECT, REFUND, REVERSE) now reconcile the referrer school's
--    permanent reward liabilities in the same transaction, through the unchanged M2 logic. Standings
--    (M3) and contest counts (M4) already read live attribution state, so they need no event.
-- 2. One HQ overview read for the Growth & Referrals landing page.
-- Still recordkeeping only: nothing is issued, applied, purchased, messaged or listed publicly.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Champions Club integration requires a trusted migration owner';
  END IF;
END $$;

-- Shared reconciliation core (M2 steps 1-3, unchanged), now also run inside every attribution
-- decision so reward liabilities can never lag a QUALIFY, REFUND, REVERSE or REJECT. Without a
-- published reward policy it changes nothing and returns NULL. Liabilities only.
CREATE FUNCTION hon.champions_reconcile_core(p_actor uuid, p_school uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid := p_actor; at timestamptz := p_at; school_row hon.schools%ROWTYPE; policy hon.champions_reward_policies%ROWTYPE; qualified integer;
  entry hon.champions_reward_entries%ROWTYPE; supported boolean; tier hon.plan_tier;
  accrued integer := 0; flagged integer := 0; restored integer := 0; attribution record; wanted record;
BEGIN
  SELECT * INTO policy FROM hon.champions_reward_policies WHERE status = 'PUBLISHED' FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO school_row FROM hon.schools WHERE id = p_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('champions.rewards:' || p_school::text, 0));
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

  RETURN jsonb_build_object('policyVersion', policy.policy_version, 'qualifiedCount', qualified,
    'accrued', accrued, 'flaggedForReview', flagged, 'restored', restored);
END $$;

CREATE OR REPLACE FUNCTION hon.reconcile_champions_rewards(p_subject text, p_school uuid, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; school_row hon.schools%ROWTYPE; at timestamptz; result jsonb; core jsonb;
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
  IF NOT EXISTS (SELECT 1 FROM hon.champions_reward_policies WHERE status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'CHAMPIONS_POLICY_UNDECIDED' USING ERRCODE = '23514';
  END IF;
  -- Attribution decisions cannot change underneath one reconciliation.
  LOCK TABLE hon.champions_attributions IN SHARE MODE;
  at := clock_timestamp();
  core := hon.champions_reconcile_core(actor, p_school, at);
  SELECT jsonb_build_object('schoolId', p_school, 'qualifiedCount', core->'qualifiedCount', 'policyVersion', core->'policyVersion',
      'accrued', core->'accrued', 'flaggedForReview', core->'flaggedForReview', 'restored', core->'restored',
      'entries', coalesce(jsonb_agg(hon.champions_reward_json(e) ORDER BY e.accrued_at, e.milestone_count NULLS LAST, e.id), '[]'::jsonb),
      'financialActivation', 'DISABLED')
    INTO result FROM hon.champions_reward_entries e WHERE e.referrer_school_id = p_school;
  RETURN hon.champions_record(actor, p_key, 'champions.rewards.reconcile', 'champions.rewards.reconciled', 'REWARD_SCHOOL', p_school,
    school_row.organization_id, NULL, core - 'policyVersion', result, at);
END $$;

CREATE OR REPLACE FUNCTION hon.decide_champions_attribution(p_subject text, p_attribution uuid, p jsonb, p_key uuid, p_request uuid, p_correlation uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; replay jsonb; decision text; reason text; expected integer; prior hon.champions_attributions%ROWTYPE;
  updated hon.champions_attributions%ROWTYPE; policy hon.champions_policies%ROWTYPE; evidence jsonb := NULL; target text;
  first_paid timestamptz; paid_invoices integer; at timestamptz; result jsonb; keys text[]; rewards jsonb;
BEGIN
  IF p_attribution IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023'; END IF;
  SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(p) k;
  decision := p->>'decision'; reason := p->>'reasonCode';
  IF jsonb_typeof(p->'decision') <> 'string' OR jsonb_typeof(p->'reasonCode') <> 'string'
    OR jsonb_typeof(p->'expectedVersion') <> 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR NOT ((decision = 'QUALIFY' AND keys = ARRAY['decision','evidence','expectedVersion','reasonCode'])
      OR (decision IN ('REJECT','REFUND','REVERSE') AND keys = ARRAY['decision','expectedVersion','reasonCode']))
    OR NOT ((decision = 'QUALIFY' AND reason = 'QUALIFICATION_VERIFIED')
      OR (decision = 'REJECT' AND reason IN ('DUPLICATE_ACCOUNT','SELF_REFERRAL','FRAUD_SUSPECTED','NOT_ELIGIBLE','ATTRIBUTION_EXPIRED','DISPUTE_RESOLVED'))
      OR (decision = 'REFUND' AND reason = 'REFUND_ISSUED')
      OR (decision = 'REVERSE' AND reason IN ('PAYMENT_REVERSED','SUBSCRIPTION_CANCELLED','FRAUD_SUSPECTED','DISPUTE_RESOLVED'))) THEN
    RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
  END IF;
  expected := (p->>'expectedVersion')::integer;
  IF decision = 'QUALIFY' THEN
    IF jsonb_typeof(p->'evidence') <> 'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p->'evidence') k) IS DISTINCT FROM ARRAY['firstPaidAt','paidInvoiceCount','reference']
      OR jsonb_typeof(p->'evidence'->'reference') <> 'string' OR length(p->'evidence'->>'reference') NOT BETWEEN 1 AND 200
      OR btrim(p->'evidence'->>'reference') <> p->'evidence'->>'reference'
      OR jsonb_typeof(p->'evidence'->'paidInvoiceCount') <> 'number' OR (p->'evidence'->>'paidInvoiceCount') !~ '^[0-9]{1,3}$'
      OR jsonb_typeof(p->'evidence'->'firstPaidAt') <> 'string'
      OR (p->'evidence'->>'firstPaidAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
      RAISE EXCEPTION 'INVALID_CHAMPIONS_INPUT' USING ERRCODE = '22023';
    END IF;
    first_paid := (p->'evidence'->>'firstPaidAt')::timestamptz;
    paid_invoices := (p->'evidence'->>'paidInvoiceCount')::integer;
  END IF;
  target := CASE decision WHEN 'QUALIFY' THEN 'QUALIFIED' WHEN 'REJECT' THEN 'REJECTED' WHEN 'REFUND' THEN 'REFUNDED' ELSE 'REVERSED' END;
  actor := hon.require_champions_hq_actor(p_subject, decision <> 'REJECT');
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants, hon.principal_role_grants IN SHARE MODE;
  actor := hon.require_champions_hq_actor(p_subject, decision <> 'REJECT');
  replay := hon.champions_claim_request(actor, p_key, 'champions.attribution.decide',
    hon.champions_fingerprint(ARRAY['champions.attribution.decide', p_attribution::text, p::text]), p_request, p_correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO prior FROM hon.champions_attributions WHERE id = p_attribution FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;
  IF prior.version <> expected THEN RAISE EXCEPTION 'CHAMPIONS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  IF NOT ((prior.state = 'PENDING' AND target IN ('QUALIFIED','REJECTED','REFUNDED'))
    OR (prior.state = 'QUALIFIED' AND target IN ('REFUNDED','REVERSED'))) THEN
    RAISE EXCEPTION 'CHAMPIONS_TRANSITION_NOT_ALLOWED' USING ERRCODE = '40001';
  END IF;
  at := clock_timestamp();
  IF target = 'QUALIFIED' THEN
    SELECT * INTO policy FROM hon.champions_policies WHERE status = 'PUBLISHED' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHAMPIONS_POLICY_UNDECIDED' USING ERRCODE = '23514'; END IF;
    IF policy.payment_verification_source <> 'HQ_OWNER_ATTESTATION' THEN
      RAISE EXCEPTION 'CHAMPIONS_PAYMENT_SOURCE_UNAVAILABLE' USING ERRCODE = '23514';
    END IF;
    IF at > prior.captured_at + make_interval(days => policy.attribution_window_days) THEN
      RAISE EXCEPTION 'CHAMPIONS_ATTRIBUTION_EXPIRED' USING ERRCODE = '23514';
    END IF;
    IF first_paid > at OR first_paid < prior.captured_at - interval '1 day'
      OR at < first_paid + make_interval(days => greatest(policy.refund_window_days, policy.minimum_paid_days))
      OR paid_invoices < policy.minimum_paid_invoices THEN
      RAISE EXCEPTION 'CHAMPIONS_QUALIFICATION_NOT_MET' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM hon.organizations o JOIN hon.organization_entitlements e ON e.organization_id = o.id
      WHERE o.id = prior.referred_organization_id AND o.status = 'ACTIVE' AND e.status = 'ACTIVE'
        AND e.effective_from <= at AND (e.effective_until IS NULL OR e.effective_until > at)) THEN
      RAISE EXCEPTION 'CHAMPIONS_QUALIFICATION_NOT_MET' USING ERRCODE = '23514';
    END IF;
    IF hon.champions_orgs_share_user(prior.referrer_organization_id, prior.referred_organization_id) THEN
      RAISE EXCEPTION 'CHAMPIONS_SELF_REFERRAL' USING ERRCODE = '23514';
    END IF;
    evidence := jsonb_build_object('source','HQ_OWNER_ATTESTATION','reference',p->'evidence'->>'reference',
      'paidInvoiceCount',paid_invoices,'firstPaidAt',hon.champions_ts(first_paid));
    UPDATE hon.champions_attributions SET state = target, state_reason = reason, version = version + 1,
      qualified_policy_id = policy.id, qualified_at = at, qualification_evidence = evidence,
      decided_by_principal_id = actor, decided_at = at
      WHERE id = p_attribution AND version = expected RETURNING * INTO updated;
  ELSE
    UPDATE hon.champions_attributions SET state = target, state_reason = reason, version = version + 1,
      decided_by_principal_id = actor, decided_at = at
      WHERE id = p_attribution AND version = expected RETURNING * INTO updated;
  END IF;
  IF updated.id IS NULL THEN RAISE EXCEPTION 'CHAMPIONS_VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
  INSERT INTO hon.champions_attribution_history(attribution_id,from_state,to_state,version,state_reason,actor_principal_id,occurred_at)
    VALUES (updated.id, prior.state, updated.state, updated.version, reason, actor, at);
  -- M5 integration: reward liabilities follow the decision in the same transaction.
  rewards := hon.champions_reconcile_core(actor, updated.referrer_school_id, at);
  result := jsonb_build_object('attribution', hon.champions_attribution_json(updated));
  RETURN hon.champions_record(actor, p_key, 'champions.attribution.decide', 'champions.attribution.decided', 'ATTRIBUTION',
    updated.id, updated.referrer_organization_id, jsonb_build_object('state',prior.state,'version',prior.version),
    jsonb_build_object('state',updated.state,'stateReason',reason,'version',updated.version,'rewardsReconciled',coalesce(rewards,'"POLICY_UNDECIDED"'::jsonb)), result, at);
END $$;

-- HQ overview: one read of the whole program for the HON HQ Growth & Referrals landing page.
-- Aggregates only; no school-level identity beyond counts.
CREATE FUNCTION hon.read_champions_overview_from_hq(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE program hon.champions_policies%ROWTYPE; rewards hon.champions_reward_policies%ROWTYPE;
BEGIN
  PERFORM hon.require_champions_hq_actor(p_subject, false);
  SELECT * INTO program FROM hon.champions_policies WHERE status = 'PUBLISHED';
  SELECT * INTO rewards FROM hon.champions_reward_policies WHERE status = 'PUBLISHED';
  RETURN jsonb_build_object(
    'program', jsonb_build_object('status', CASE WHEN program.id IS NULL THEN 'POLICY_UNDECIDED' ELSE 'PUBLISHED' END, 'policyVersion', program.policy_version,
      'paymentVerificationSource', program.payment_verification_source),
    'rewardProgram', jsonb_build_object('status', CASE WHEN rewards.id IS NULL THEN 'POLICY_UNDECIDED' ELSE 'PUBLISHED' END, 'policyVersion', rewards.policy_version,
      'clawbackRule', rewards.clawback_rule),
    'referralCodes', jsonb_build_object('active', (SELECT count(*) FROM hon.champions_referral_codes WHERE status = 'ACTIVE'),
      'schoolsWithCode', (SELECT count(DISTINCT school_id) FROM hon.champions_referral_codes WHERE status = 'ACTIVE')),
    'attributions', (SELECT jsonb_build_object('pending', count(*) FILTER (WHERE state = 'PENDING'), 'qualified', count(*) FILTER (WHERE state = 'QUALIFIED'),
      'rejected', count(*) FILTER (WHERE state = 'REJECTED'), 'refunded', count(*) FILTER (WHERE state = 'REFUNDED'),
      'reversed', count(*) FILTER (WHERE state = 'REVERSED')) FROM hon.champions_attributions),
    'rankedSchools', (SELECT count(*) FROM hon.champions_standings(NULL)),
    'leaderboardHolds', (SELECT count(*) FROM hon.champions_leaderboard_holds WHERE status = 'ACTIVE'),
    'rewardLiabilities', (SELECT jsonb_build_object('entries', count(*), 'creditMinor', coalesce(sum(credit_minor), 0), 'freeMonths', coalesce(sum(free_months), 0),
      'prizes', count(*) FILTER (WHERE reward_kind = 'PRIZE'), 'lifetimeMemberships', count(*) FILTER (WHERE reward_kind = 'LIFETIME_MEMBERSHIP'),
      'inReview', count(*) FILTER (WHERE status = 'REVERSAL_REVIEW'), 'approved', count(*) FILTER (WHERE status = 'APPROVED'))
      FROM hon.champions_reward_entries WHERE status <> 'VOIDED'),
    'contests', (SELECT jsonb_build_object('draft', count(*) FILTER (WHERE status = 'DRAFT'), 'scheduled', count(*) FILTER (WHERE status = 'SCHEDULED'),
      'active', count(*) FILTER (WHERE status = 'ACTIVE'), 'paused', count(*) FILTER (WHERE status = 'PAUSED'), 'ended', count(*) FILTER (WHERE status = 'ENDED'),
      'pendingWinnerApproval', count(*) FILTER (WHERE status = 'PENDING_WINNER_APPROVAL'), 'completed', count(*) FILTER (WHERE status = 'COMPLETED'),
      'cancelled', count(*) FILTER (WHERE status = 'CANCELLED'),
      'startDue', count(*) FILTER (WHERE status = 'SCHEDULED' AND clock_timestamp() >= starts_at),
      'endDue', count(*) FILTER (WHERE status IN ('ACTIVE','PAUSED') AND clock_timestamp() >= ends_at)) FROM hon.champions_contests),
    'contestLiabilities', jsonb_build_object('pendingWinnerCostMinor', (SELECT coalesce(sum(estimated_cost_minor), 0) FROM hon.champions_contest_winners WHERE status IN ('PROPOSED','TIE_REVIEW','DISPUTED')),
      'approvedWinnerCostMinor', (SELECT coalesce(sum(estimated_cost_minor), 0) FROM hon.champions_contest_winners WHERE status = 'APPROVED')),
    'currency', 'USD', 'financialActivation', 'DISABLED', 'automaticTransitions', 'NOT_CONFIGURED');
END $$;

-- ---------- ACL ----------
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.champions_reconcile_core(uuid,uuid,timestamptz)','hon.read_champions_overview_from_hq(text)',
      'hon.reconcile_champions_rewards(text,uuid,uuid,uuid,uuid)','hon.decide_champions_attribution(text,uuid,jsonb,uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_champions_overview_from_hq(text), hon.reconcile_champions_rewards(text,uuid,uuid,uuid,uuid),
      hon.decide_champions_attribution(text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
