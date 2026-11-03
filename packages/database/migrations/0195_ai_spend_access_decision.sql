BEGIN;
-- S4-c access source decision (AI-9, AI-1). Owner decision AI-D1 = A (2026-10-31): an HQ access exception grants
-- product access only, never AI spend ("aiCredits: NONE" becomes true for agents, not only for B3). Adds the HQ
-- emergency AI pause and the promotional-access hook. Build authorized 2026-11-01.
-- One decision function, checked before any new spend: at begin (invocation insert), at every hold increase
-- (reserve guard, before the budget lock) and at B3 reservation insert. Evidence (record/fail) is never refused.
-- Legacy organizations with no access-state row and no live exception keep today's behavior.

-- HQ emergency AI pause: append-only record; only the end fields may be filled once. No runtime table access.
CREATE TABLE hon.ai_spend_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  spend_class text NOT NULL CHECK (spend_class IN ('AGENT_INFERENCE','CREATIVE_MEDIA','ALL')),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  pause_key uuid NOT NULL UNIQUE,
  pause_fingerprint text NOT NULL,
  paused_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  paused_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  end_key uuid UNIQUE,
  end_reason text CHECK (end_reason IS NULL OR (end_reason = btrim(end_reason) AND length(end_reason) BETWEEN 10 AND 500)),
  ended_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  ended_at timestamptz,
  CHECK ((ended_at IS NULL) = (end_key IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL) AND (ended_at IS NULL) = (ended_by_principal_id IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= paused_at)
);
-- At most one active pause per scope (an organization, or the whole platform) and spend class.
CREATE UNIQUE INDEX ai_spend_pauses_active_uidx ON hon.ai_spend_pauses (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), spend_class) WHERE ended_at IS NULL;
ALTER TABLE hon.ai_spend_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_spend_pauses FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.ai_spend_pauses FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.ai_spend_pauses FROM %I', r);
  END LOOP;
END $$;

CREATE FUNCTION hon.guard_ai_spend_pauses() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'AI_SPEND_PAUSE_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['end_key','end_reason','ended_by_principal_id','ended_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['end_key','end_reason','ended_by_principal_id','ended_at']) THEN
    RAISE EXCEPTION 'AI_SPEND_PAUSE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_spend_pauses_immutable BEFORE UPDATE OR DELETE ON hon.ai_spend_pauses FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_spend_pauses();
CREATE TRIGGER ai_spend_pauses_no_truncate BEFORE TRUNCATE ON hon.ai_spend_pauses FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_spend_pauses();

-- Hooks: nothing is approved yet, so both return none. Approving promotional AI access or trial AI funding is a
-- separate owner decision with its own explicit records (spend classes, cap, expiry, reason).
CREATE FUNCTION hon.ai_promotional_access(p_org uuid, p_at timestamptz, p_class text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT false;
$$;
CREATE FUNCTION hon.ai_trial_funding_available(p_org uuid, p_at timestamptz, p_class text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT false;
$$;

-- Pure mapping of a paid-access state to a decision, so every current and future value is testable on its own.
CREATE FUNCTION hon.ai_access_state_decision(p_state text, p_entitlement_in_effect boolean, p_trial_funded boolean) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE
    WHEN p_state IN ('PAYMENT_ACTIVE','CANCELLATION_SCHEDULED') THEN CASE WHEN p_entitlement_in_effect THEN NULL ELSE 'AI_ACCESS_LAPSED' END
    WHEN p_state IN ('AWAITING_FIRST_PAYMENT','REGISTERED','TRIAL_ENDED') THEN 'AI_ACCESS_NOT_PAID'
    WHEN p_state = 'TRIAL_ACTIVE' THEN CASE WHEN p_trial_funded AND p_entitlement_in_effect THEN NULL ELSE 'AI_TRIAL_FUNDING_NOT_APPROVED' END
    WHEN p_state = 'PAST_DUE_GRACE' THEN 'AI_ACCESS_PAST_DUE'
    WHEN p_state = 'SUSPENDED_NONPAYMENT' THEN 'AI_ACCESS_SUSPENDED'
    WHEN p_state = 'REVIEW_HOLD' THEN 'AI_ACCESS_REVIEW_HOLD'
    WHEN p_state = 'ENDED' THEN 'AI_ACCESS_ENDED'
    ELSE 'AI_ACCESS_UNKNOWN_STATE'
  END;
$$;

-- The access source decision. NULL = allowed (the existing entitlement/role gate still runs); otherwise a reason.
CREATE FUNCTION hon.ai_spend_allowed(p_org uuid, p_at timestamptz, p_class text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.saas_access_states%ROWTYPE; e hon.organization_entitlements%ROWTYPE; in_effect boolean;
BEGIN
  IF p_org IS NULL OR p_class NOT IN ('AGENT_INFERENCE','CREATIVE_MEDIA','HQ_INTERNAL') THEN RETURN 'AI_ACCESS_UNKNOWN_STATE'; END IF;
  -- 0. HQ emergency pause (organization or platform; this class or all) comes before everything.
  IF EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND (p.organization_id = p_org OR p.organization_id IS NULL)
             AND p.spend_class IN (p_class, 'ALL')) THEN RETURN 'AI_PAUSED_BY_HQ'; END IF;
  -- 1a. Owner-approved promotional AI access (hook only; returns none until approved).
  IF hon.ai_promotional_access(p_org, p_at, p_class) THEN RETURN NULL; END IF;
  -- 1. A live HQ access exception that currently owns the entitlement grants no AI (AI-D1 = A). Exception schools
  --    have no access-state row, so this must come before the legacy rule.
  IF hon.saas_access_exception_live(p_org) THEN RETURN 'AI_EXCEPTION_NO_AI'; END IF;
  SELECT * INTO s FROM hon.saas_access_states WHERE organization_id = p_org;
  -- 7. Legacy: no access-state row and no live exception: unchanged (the existing gate decides).
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO e FROM hon.organization_entitlements WHERE organization_id = p_org;
  in_effect := FOUND AND e.status = 'ACTIVE' AND e.effective_from <= p_at AND (e.effective_until IS NULL OR e.effective_until > p_at);
  RETURN hon.ai_access_state_decision(s.state, in_effect, hon.ai_trial_funding_available(p_org, p_at, p_class));
END $$;

-- Begin guard: no new agent invocation row while the decision denies.
CREATE FUNCTION hon.ai_spend_start_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE why text := hon.ai_spend_allowed(NEW.organization_id, clock_timestamp(), 'AGENT_INFERENCE');
BEGIN
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', why USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_spend_start_guard BEFORE INSERT ON hon.marketing_ai_invocations FOR EACH ROW EXECUTE FUNCTION hon.ai_spend_start_guard();
CREATE TRIGGER ai_spend_start_guard BEFORE INSERT ON hon.teaching_ai_invocations FOR EACH ROW EXECUTE FUNCTION hon.ai_spend_start_guard();
CREATE TRIGGER ai_spend_start_guard BEFORE INSERT ON hon.chad_follow_up_invocations FOR EACH ROW EXECUTE FUNCTION hon.ai_spend_start_guard();

-- Reserve guard (S4-b): the access decision now runs first, before the budget lock.
CREATE OR REPLACE FUNCTION hon.ai_spend_reserve_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE prior bigint := CASE WHEN TG_OP='UPDATE' THEN OLD.reserved_credits ELSE 0 END;
  why text := hon.ai_spend_allowed(NEW.organization_id, clock_timestamp(), 'AGENT_INFERENCE');
BEGIN
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', why USING ERRCODE='42501'; END IF;
  PERFORM hon.ai_budget_lock(NEW.organization_id);
  IF hon.ai_org_committed_credits(NEW.organization_id, clock_timestamp()) - prior + NEW.reserved_credits
     > hon.ai_org_ceiling(NEW.organization_id, clock_timestamp()) THEN
    RAISE EXCEPTION 'AI_ORG_BUDGET_EXCEEDED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

-- B3 creative reservations: the same decision for the creative class (program stays closed; this applies when opened).
CREATE FUNCTION hon.ai_spend_b3_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE why text := hon.ai_spend_allowed(NEW.organization_id, clock_timestamp(), 'CREATIVE_MEDIA');
BEGIN
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', why USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_spend_b3_guard BEFORE INSERT ON hon.saas_credit_reservations FOR EACH ROW EXECUTE FUNCTION hon.ai_spend_b3_guard();

-- HQ owner pause / resume. Human HQ owner only (operators, support, school owners, agents and delegated or tenant
-- contexts refused). Idempotent per key with a fingerprint; applies at the next begin, prepare or reserve.
-- In-flight calls still record. The pause row itself is the durable evidence (actor, reason, timestamps).
CREATE FUNCTION hon.command_ai_spend_pause(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_action text; v_org uuid; v_class text; v_reason text; fp text; p hon.ai_spend_pauses%ROWTYPE;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k), ARRAY[]::text[]) <> ARRAY['action','organizationId','reason','spendClass']
     OR jsonb_typeof(p_input->'action') <> 'string' OR (p_input->>'action') NOT IN ('PAUSE','RESUME')
     OR (jsonb_typeof(p_input->'organizationId') <> 'null' AND (jsonb_typeof(p_input->'organizationId') <> 'string'
         OR (p_input->>'organizationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
     OR jsonb_typeof(p_input->'spendClass') <> 'string' OR (p_input->>'spendClass') NOT IN ('AGENT_INFERENCE','CREATIVE_MEDIA','ALL')
     OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'INVALID_AI_SPEND_PAUSE' USING ERRCODE='22023';
  END IF;
  v_action := p_input->>'action'; v_org := nullif(p_input->>'organizationId','')::uuid; v_class := p_input->>'spendClass'; v_reason := p_input->>'reason';
  fp := encode(sha256(convert_to(jsonb_build_object('a',v_action,'o',v_org,'c',v_class,'r',v_reason,'by',actor)::text,'UTF8')),'hex');
  IF v_org IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hon.organizations WHERE id = v_org) THEN RAISE EXCEPTION 'AI_SPEND_PAUSE_ORGANIZATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- Authority holds through the mutation (the D9/0185 pattern): the shared lock stops any user, principal, HQ grant
  -- or family grant change until this transaction ends, and authority is checked again after every wait, so an owner
  -- revoked or expired while this command waited is refused before any row is read or written.
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- One pause command at a time per scope: replays and races resolve to one row.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.pause:' || coalesce(v_org::text,'platform') || ':' || v_class, 0));
  -- The scope lock can wait behind another pause command: the grant may have lapsed by the clock meanwhile.
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF v_action = 'PAUSE' THEN
    SELECT * INTO p FROM hon.ai_spend_pauses WHERE pause_key = p_key;
    IF FOUND THEN
      IF p.pause_fingerprint <> fp THEN RAISE EXCEPTION 'AI_SPEND_PAUSE_KEY_REUSED' USING ERRCODE='23505'; END IF;
      RETURN jsonb_build_object('pauseId',p.id,'organizationId',p.organization_id,'spendClass',p.spend_class,'status',CASE WHEN p.ended_at IS NULL THEN 'ACTIVE' ELSE 'ENDED' END,'replayed',true);
    END IF;
    IF EXISTS (SELECT 1 FROM hon.ai_spend_pauses WHERE ended_at IS NULL AND organization_id IS NOT DISTINCT FROM v_org AND spend_class = v_class) THEN
      RAISE EXCEPTION 'AI_SPEND_PAUSE_ALREADY_ACTIVE' USING ERRCODE='23514';
    END IF;
    INSERT INTO hon.ai_spend_pauses(organization_id, spend_class, reason, pause_key, pause_fingerprint, paused_by_principal_id)
      VALUES (v_org, v_class, v_reason, p_key, fp, actor) RETURNING * INTO p;
    RETURN jsonb_build_object('pauseId',p.id,'organizationId',p.organization_id,'spendClass',p.spend_class,'status','ACTIVE','replayed',false);
  END IF;
  SELECT * INTO p FROM hon.ai_spend_pauses WHERE end_key = p_key;
  IF FOUND THEN
    IF p.organization_id IS DISTINCT FROM v_org OR p.spend_class <> v_class OR p.end_reason <> v_reason OR p.ended_by_principal_id <> actor THEN
      RAISE EXCEPTION 'AI_SPEND_PAUSE_KEY_REUSED' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('pauseId',p.id,'organizationId',p.organization_id,'spendClass',p.spend_class,'status','ENDED','replayed',true);
  END IF;
  UPDATE hon.ai_spend_pauses SET end_key = p_key, end_reason = v_reason, ended_by_principal_id = actor, ended_at = clock_timestamp()
   WHERE ended_at IS NULL AND organization_id IS NOT DISTINCT FROM v_org AND spend_class = v_class RETURNING * INTO p;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_SPEND_PAUSE_NOT_ACTIVE' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('pauseId',p.id,'organizationId',p.organization_id,'spendClass',p.spend_class,'status','ENDED','replayed',false);
END $$;

CREATE FUNCTION hon.read_ai_spend_pauses_from_hq(p_subject text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false);
BEGIN
  RETURN jsonb_build_object('pauses', coalesce((SELECT jsonb_agg(jsonb_build_object('pauseId',p.id,'organizationId',p.organization_id,'spendClass',p.spend_class,'reason',p.reason,
      'pausedAt',hon.saas_ts(p.paused_at),'pausedByPrincipalId',p.paused_by_principal_id,'status',CASE WHEN p.ended_at IS NULL THEN 'ACTIVE' ELSE 'ENDED' END,
      'endReason',p.end_reason,'endedAt',CASE WHEN p.ended_at IS NULL THEN NULL ELSE hon.saas_ts(p.ended_at) END,'endedByPrincipalId',p.ended_by_principal_id) ORDER BY p.ended_at IS NULL DESC, p.paused_at DESC)
    FROM (SELECT * FROM hon.ai_spend_pauses ORDER BY ended_at IS NULL DESC, paused_at DESC LIMIT 200) p), '[]'::jsonb),
    'asOf', hon.saas_ts(clock_timestamp()));
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOREACH f IN ARRAY ARRAY['hon.guard_ai_spend_pauses()'::regprocedure,'hon.ai_promotional_access(uuid,timestamptz,text)'::regprocedure,
  'hon.ai_trial_funding_available(uuid,timestamptz,text)'::regprocedure,'hon.ai_access_state_decision(text,boolean,boolean)'::regprocedure,
  'hon.ai_spend_allowed(uuid,timestamptz,text)'::regprocedure,'hon.ai_spend_start_guard()'::regprocedure,'hon.ai_spend_b3_guard()'::regprocedure,
  'hon.command_ai_spend_pause(text,jsonb,uuid)'::regprocedure,'hon.read_ai_spend_pauses_from_hq(text)'::regprocedure] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM hon_runtime',f); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon',f); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated',f); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role',f); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.command_ai_spend_pause(text,jsonb,uuid), hon.read_ai_spend_pauses_from_hq(text) TO hon_runtime;
 END IF;
END $$;
COMMIT;
