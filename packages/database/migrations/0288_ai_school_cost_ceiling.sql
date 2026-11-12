BEGIN;
-- 0288 (R2): per-school internal AI cost ceiling and single-school pause (AI_MODEL_AND_CONNECTION_PLAN.md §3, §6.3).
-- Spec: docs/architecture/AI_SCHOOL_COST_CEILING.md. Internal HON cost only: never a customer balance or credits.
-- - Each school may have an internal monthly ceiling on agent-inference provider cost, HQ-owner editable per school.
--   Owner 2026-11-12: conversations with the AI team have no cap for a paying school, so a paying school has NO default
--   ceiling (its creative and heavier work is limited by its 12,000 monthly creative credits, 0202); while its free trial
--   (0246) owns the organization's access the default is $15 (15,000,000 micro-USD). HQ can still set one or pause. Cost = verified provider cost in the ledger for the budget window plus, for
--   every agent hold that still counts (hon.ai_hold_counts), its plan's maximum provider cost (fail closed).
-- - At or above the ceiling new agent AI work for that school is refused before any provider call, exactly like an
--   HQ pause (reason AI_PAUSED_BY_HQ, so every existing closed reason list and screen stays valid). HQ sees the real
--   level: NORMAL, WARNING_75, WARNING_90 or CEILING_REACHED.
-- - The HQ owner may pause one school's AI (agent and creative) with a reason, and resume it.
-- - Enforced against the row's own school, never only the session setting (SaaS school paths forbid
--   app.hon_school_id): the agent begin guard and reserve guard (after the org budget lock), the B3 credit reservation
--   guard and a new guard on creative wallet reservations (which every creative and studio path inserts). The shared
--   3-argument hon.ai_spend_allowed also applies it for the tenant's current school when that is set (readiness, begins);
--   the 4-argument form takes the school explicitly.
-- - A school pause takes the organization's creative pause gate exclusively, so it waits for in-flight creative
--   reservations (which hold the gate shared until commit) exactly like an organization pause.
-- - The organization budget lock (0194) and the platform/organization HQ pause (0195) are unchanged and still first.

CREATE FUNCTION hon.ai_school_trial_default_ceiling_micros() RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 15000000::bigint $$;
-- The default for one school at one instant: $15 while the organization's trial owns its access, otherwise none (NULL).
CREATE FUNCTION hon.ai_school_default_ceiling_for(p_org uuid, p_at timestamptz) RETURNS bigint LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN hon.hon_os_trial_live(p_org, p_at) THEN hon.ai_school_trial_default_ceiling_micros() END
$$;

CREATE TABLE hon.ai_school_cost_limits (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  ceiling_micros bigint NOT NULL CHECK (ceiling_micros BETWEEN 0 AND 1000000000),
  paused boolean NOT NULL,
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  version integer NOT NULL CHECK (version >= 1),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);
-- Append-only command log: the audit of every HQ change and the idempotency record.
CREATE TABLE hon.ai_school_cost_limit_commands (
  command_key uuid PRIMARY KEY,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  ceiling_micros bigint NOT NULL,
  paused boolean NOT NULL,
  reason text NOT NULL,
  prior_version integer NOT NULL CHECK (prior_version >= 0),
  resulting_version integer NOT NULL CHECK (resulting_version = prior_version + 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);
CREATE FUNCTION hon.guard_ai_school_cost_limit_commands() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'AI_SCHOOL_COST_LIMIT_COMMAND_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER ai_school_cost_limit_commands_immutable BEFORE UPDATE OR DELETE ON hon.ai_school_cost_limit_commands
  FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_school_cost_limit_commands();
CREATE TRIGGER ai_school_cost_limit_commands_no_truncate BEFORE TRUNCATE ON hon.ai_school_cost_limit_commands
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_school_cost_limit_commands();
CREATE FUNCTION hon.guard_ai_school_cost_limits() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.school_id <> OLD.school_id OR NEW.organization_id <> OLD.organization_id OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'AI_SCHOOL_COST_LIMIT_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_school_cost_limits_guard BEFORE UPDATE OR DELETE ON hon.ai_school_cost_limits FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_school_cost_limits();
CREATE TRIGGER ai_school_cost_limits_no_truncate BEFORE TRUNCATE ON hon.ai_school_cost_limits FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_school_cost_limits();
ALTER TABLE hon.ai_school_cost_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_school_cost_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_school_cost_limit_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_school_cost_limit_commands FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.ai_school_cost_limits, hon.ai_school_cost_limit_commands FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.ai_school_cost_limits, hon.ai_school_cost_limit_commands FROM %I', r);
  END LOOP;
END $$;

-- Internal agent-inference cost of one school in its budget window (micro-USD): verified ledger cost plus each counting
-- hold at its plan's maximum (a hold without a readable plan counts the largest plan maximum, 1,000,000).
CREATE FUNCTION hon.ai_school_committed_cost_micros(p_org uuid, p_school uuid, p_at timestamptz) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH w AS (SELECT hon.ai_spend_window(p_org, p_at) AS r)
  SELECT (SELECT coalesce(sum(u.provider_cost_microunits),0) FROM hon.ai_usage_ledger u, w
           WHERE u.organization_id=p_org AND u.school_id=p_school AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at>=lower(w.r) AND u.occurred_at<upper(w.r))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.marketing_ai_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.teaching_ai_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.chad_follow_up_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at))
       + (SELECT coalesce(sum(coalesce(p.max_provider_cost_microunits,1000000)),0) FROM hon.hon_reply_invocations i CROSS JOIN w LEFT JOIN hon.ai_invocation_plans p ON p.id=i.plan_id
           WHERE i.organization_id=p_org AND i.school_id=p_school AND i.reserved_credits>0 AND hon.ai_hold_counts(i.status,i.held_at,w.r,p_at));
$$;

-- Pure level for HQ: basis points of the ceiling used (10000 = 100%). No ceiling: NO_CEILING.
CREATE FUNCTION hon.ai_school_cost_level(p_committed bigint, p_ceiling bigint) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_ceiling IS NULL THEN 'NO_CEILING'
              WHEN p_committed >= p_ceiling THEN 'CEILING_REACHED'
              WHEN p_committed * 10 >= p_ceiling * 9 THEN 'WARNING_90'
              WHEN p_committed * 4 >= p_ceiling * 3 THEN 'WARNING_75'
              ELSE 'NORMAL' END
$$;

-- The school part of the shared spend decision. NULL school (HQ or platform context) adds nothing.
CREATE FUNCTION hon.ai_school_spend_decision(p_org uuid, p_school uuid, p_at timestamptz, p_class text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE l hon.ai_school_cost_limits%ROWTYPE;
BEGIN
  IF p_school IS NULL OR p_class NOT IN ('AGENT_INFERENCE','CREATIVE_MEDIA') THEN RETURN NULL; END IF;
  SELECT * INTO l FROM hon.ai_school_cost_limits WHERE school_id = p_school AND organization_id = p_org;
  IF FOUND AND l.paused THEN RETURN 'AI_PAUSED_BY_HQ'; END IF;
  -- No HQ record and no live trial: no ceiling.
  IF p_class = 'AGENT_INFERENCE' AND coalesce(l.ceiling_micros, hon.ai_school_default_ceiling_for(p_org, p_at)) IS NOT NULL
     AND hon.ai_school_committed_cost_micros(p_org, p_school, p_at)
       >= coalesce(l.ceiling_micros, hon.ai_school_default_ceiling_for(p_org, p_at)) THEN
    RETURN 'AI_PAUSED_BY_HQ';
  END IF;
  RETURN NULL;
END $$;

-- Organization/platform decision: the current (0246, trial-aware) body, unchanged, under a new name.
CREATE FUNCTION hon.ai_org_spend_allowed(p_org uuid, p_at timestamptz, p_class text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.saas_access_states%ROWTYPE; e hon.organization_entitlements%ROWTYPE; in_effect boolean; tr hon.hon_os_trial_enrollments%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_class NOT IN ('AGENT_INFERENCE','CREATIVE_MEDIA','HQ_INTERNAL') THEN RETURN 'AI_ACCESS_UNKNOWN_STATE'; END IF;
  -- 0. HQ emergency pause (organization or platform; this class or all) comes before everything.
  IF EXISTS (SELECT 1 FROM hon.ai_spend_pauses p WHERE p.ended_at IS NULL AND (p.organization_id = p_org OR p.organization_id IS NULL)
             AND p.spend_class IN (p_class, 'ALL')) THEN RETURN 'AI_PAUSED_BY_HQ'; END IF;
  -- 1a. Owner-approved promotional AI access (hook only; returns none until approved).
  IF hon.ai_promotional_access(p_org, p_at, p_class) THEN RETURN NULL; END IF;
  -- 1. A live HQ access exception that currently owns the entitlement grants no AI (AI-D1 = A).
  IF hon.saas_access_exception_live(p_org) THEN RETURN 'AI_EXCEPTION_NO_AI'; END IF;
  SELECT * INTO s FROM hon.saas_access_states WHERE organization_id = p_org;
  SELECT * INTO e FROM hon.organization_entitlements WHERE organization_id = p_org;
  in_effect := e.organization_id IS NOT NULL AND e.status = 'ACTIVE' AND e.effective_from <= p_at AND (e.effective_until IS NULL OR e.effective_until > p_at);
  IF s.organization_id IS NULL THEN
    -- 2. 0246: a free trial that owns the entitlement goes through the trial-funding hook (its HQ-set AI credit);
    --    a trial whose window passed, or a self-registered school with no trial, has no paid AI.
    SELECT * INTO tr FROM hon.hon_os_trial_enrollments WHERE organization_id = p_org;
    IF tr.id IS NOT NULL AND e.version = tr.granted_entitlement_version THEN
      RETURN hon.ai_access_state_decision(CASE WHEN hon.hon_os_trial_live(p_org, p_at) THEN 'TRIAL_ACTIVE' ELSE 'TRIAL_ENDED' END,
        in_effect, hon.ai_trial_funding_available(p_org, p_at, p_class));
    END IF;
    IF tr.id IS NULL AND EXISTS (SELECT 1 FROM hon.hon_os_school_registrations g WHERE g.organization_id = p_org) THEN
      RETURN hon.ai_access_state_decision('REGISTERED', in_effect, false);
    END IF;
    -- 7. Legacy: no access-state row, no exception, no trial: unchanged (the existing gate decides).
    RETURN NULL;
  END IF;
  RETURN hon.ai_access_state_decision(s.state, in_effect, hon.ai_trial_funding_available(p_org, p_at, p_class));
END $$;

-- The shared decision for an explicit school: organization/platform first (0195), then that school.
CREATE FUNCTION hon.ai_spend_allowed(p_org uuid, p_school uuid, p_at timestamptz, p_class text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN coalesce(hon.ai_org_spend_allowed(p_org, p_at, p_class), hon.ai_school_spend_decision(p_org, p_school, p_at, p_class));
END $$;

-- The 0195 signature: the tenant's current school when the session names one. Guards below never rely on it.
CREATE OR REPLACE FUNCTION hon.ai_spend_allowed(p_org uuid, p_at timestamptz, p_class text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN hon.ai_spend_allowed(p_org, hon.current_school_id(), p_at, p_class);
END $$;

-- Agent begin guard (0195 body): the row's own school, whatever the session says.
CREATE OR REPLACE FUNCTION hon.ai_spend_start_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE why text := hon.ai_spend_allowed(NEW.organization_id, NEW.school_id, clock_timestamp(), 'AGENT_INFERENCE');
BEGIN
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', why USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;

-- B3 credit reservations (0195 body): the row's own school.
CREATE OR REPLACE FUNCTION hon.ai_spend_b3_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE why text := hon.ai_spend_allowed(NEW.organization_id, NEW.school_id, clock_timestamp(), 'CREATIVE_MEDIA');
BEGIN
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', why USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;

-- Creative wallet reservations (0202, used by the studio 0216): a paused school cannot reserve. Runs inside
-- reserve_saas_creative_credits after its pause gate and wallet lock, with the same refusal shape as its own S4 check.
CREATE FUNCTION hon.ai_school_creative_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE why text := hon.ai_school_spend_decision(NEW.organization_id, NEW.school_id, clock_timestamp(), 'CREATIVE_MEDIA');
BEGIN
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', 'SAAS_CREATIVE_' || why USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_school_creative_guard BEFORE INSERT ON hon.saas_creative_reservations FOR EACH ROW EXECUTE FUNCTION hon.ai_school_creative_guard();

-- Reserve guard (0195 body): organization decision before the budget lock; the row's own school after the lock, so
-- concurrent prepares of one organization see each other's committed holds.
CREATE OR REPLACE FUNCTION hon.ai_spend_reserve_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE prior bigint := CASE WHEN TG_OP='UPDATE' THEN OLD.reserved_credits ELSE 0 END;
  why text := hon.ai_org_spend_allowed(NEW.organization_id, clock_timestamp(), 'AGENT_INFERENCE');
BEGIN
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', why USING ERRCODE='42501'; END IF;
  PERFORM hon.ai_budget_lock(NEW.organization_id);
  IF hon.ai_org_committed_credits(NEW.organization_id, clock_timestamp()) - prior + NEW.reserved_credits
     > hon.ai_org_ceiling(NEW.organization_id, clock_timestamp()) THEN
    RAISE EXCEPTION 'AI_ORG_BUDGET_EXCEEDED' USING ERRCODE='42501';
  END IF;
  why := hon.ai_school_spend_decision(NEW.organization_id, NEW.school_id, clock_timestamp(), 'AGENT_INFERENCE');
  IF why IS NOT NULL THEN RAISE EXCEPTION '%', why USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;

-- HQ owner command: set one school's ceiling and pause state. Versioned (expectedVersion 0 = no record yet), idempotent
-- by key, authority held and re-checked after every wait (the 0195 pause pattern).
CREATE FUNCTION hon.command_ai_school_cost_limit(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_school uuid; v_org uuid; v_ceiling bigint; v_paused boolean; v_reason text; v_expected integer; fp text;
  l hon.ai_school_cost_limits%ROWTYPE; cmd hon.ai_school_cost_limit_commands%ROWTYPE; cur integer;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k), ARRAY[]::text[]) <> ARRAY['ceilingMicros','expectedVersion','paused','reason','schoolId']
     OR jsonb_typeof(p_input->'schoolId') <> 'string' OR (p_input->>'schoolId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(p_input->'ceilingMicros') <> 'number' OR (p_input->>'ceilingMicros') !~ '^[0-9]{1,10}$' OR (p_input->>'ceilingMicros')::bigint > 1000000000
     OR jsonb_typeof(p_input->'paused') <> 'boolean'
     OR jsonb_typeof(p_input->'expectedVersion') <> 'number' OR (p_input->>'expectedVersion') !~ '^[0-9]{1,9}$'
     OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'INVALID_AI_SCHOOL_COST_LIMIT' USING ERRCODE='22023';
  END IF;
  v_school := (p_input->>'schoolId')::uuid; v_ceiling := (p_input->>'ceilingMicros')::bigint; v_paused := (p_input->>'paused')::boolean;
  v_reason := p_input->>'reason'; v_expected := (p_input->>'expectedVersion')::integer;
  fp := encode(sha256(convert_to(jsonb_build_object('s',v_school,'c',v_ceiling,'p',v_paused,'r',v_reason,'v',v_expected,'by',actor)::text,'UTF8')),'hex');
  SELECT organization_id INTO v_org FROM hon.schools WHERE id = v_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_SCHOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.school-cost.key:' || p_key::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.school-cost:' || v_school::text, 0));
  -- The creative pause gate (0202), exclusively: in-flight creative reservations of this organization finish first.
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.pause:' || v_org::text || ':CREATIVE_MEDIA', 0));
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO cmd FROM hon.ai_school_cost_limit_commands WHERE command_key = p_key;
  IF FOUND THEN
    IF cmd.fingerprint <> fp THEN RAISE EXCEPTION 'AI_SCHOOL_COST_LIMIT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('schoolId',cmd.school_id,'organizationId',cmd.organization_id,'ceilingMicros',cmd.ceiling_micros,'paused',cmd.paused,
      'version',cmd.resulting_version,'replayed',true);
  END IF;
  SELECT * INTO l FROM hon.ai_school_cost_limits WHERE school_id = v_school FOR UPDATE;
  cur := CASE WHEN FOUND THEN l.version ELSE 0 END;
  IF cur <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF cur = 0 THEN
    INSERT INTO hon.ai_school_cost_limits(school_id, organization_id, ceiling_micros, paused, reason, version, updated_by_principal_id)
      VALUES (v_school, v_org, v_ceiling, v_paused, v_reason, 1, actor);
  ELSE
    UPDATE hon.ai_school_cost_limits SET ceiling_micros = v_ceiling, paused = v_paused, reason = v_reason, version = version + 1,
      updated_by_principal_id = actor, updated_at = clock_timestamp() WHERE school_id = v_school;
  END IF;
  INSERT INTO hon.ai_school_cost_limit_commands(command_key, fingerprint, actor_principal_id, school_id, organization_id, ceiling_micros, paused, reason, prior_version, resulting_version)
    VALUES (p_key, fp, actor, v_school, v_org, v_ceiling, v_paused, v_reason, cur, cur + 1);
  RETURN jsonb_build_object('schoolId',v_school,'organizationId',v_org,'ceilingMicros',v_ceiling,'paused',v_paused,'version',cur + 1,'replayed',false);
END $$;

-- HQ read: every school (at most 500, highest use first) with its ceiling, pause, cost and level. HQ readers only.
CREATE FUNCTION hon.read_ai_school_cost_limits_from_hq(p_subject text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false); at timestamptz := clock_timestamp();
BEGIN
  RETURN jsonb_build_object('schools', coalesce((SELECT jsonb_agg(z.v ORDER BY z.bp DESC NULLS LAST, z.committed DESC, z.school_id) FROM (
      SELECT x.school_id, x.committed, CASE WHEN x.ceiling IS NULL THEN NULL WHEN x.ceiling = 0 THEN 10000 ELSE least(x.committed * 10000 / x.ceiling, 1000000) END AS bp,
        jsonb_build_object('schoolId',x.school_id,'organizationId',x.organization_id,'schoolName',x.name,
          'ceilingMicros',x.ceiling,'defaultCeiling',x.version = 0,'trial',x.trial,'paused',x.paused,'reason',x.reason,'version',x.version,
          'recordedCostMicros',x.recorded,'committedCostMicros',x.committed,
          'usedBasisPoints',CASE WHEN x.ceiling IS NULL THEN NULL WHEN x.ceiling = 0 THEN 10000 ELSE least(x.committed * 10000 / x.ceiling, 1000000) END,
          'level',hon.ai_school_cost_level(x.committed, x.ceiling),
          'windowStart',hon.saas_ts(lower(x.w)),'windowEnd',hon.saas_ts(upper(x.w))) AS v
      FROM (SELECT s.id AS school_id, s.organization_id, s.name, coalesce(l.ceiling_micros, hon.ai_school_default_ceiling_for(s.organization_id, at)) AS ceiling,
              hon.hon_os_trial_live(s.organization_id, at) AS trial,
              coalesce(l.paused, false) AS paused, l.reason, coalesce(l.version, 0) AS version, hon.ai_spend_window(s.organization_id, at) AS w,
              hon.ai_school_committed_cost_micros(s.organization_id, s.id, at) AS committed,
              (SELECT coalesce(sum(u.provider_cost_microunits),0) FROM hon.ai_usage_ledger u WHERE u.organization_id=s.organization_id AND u.school_id=s.id
                 AND u.spend_class='AGENT_INFERENCE' AND u.occurred_at >= lower(hon.ai_spend_window(s.organization_id, at)) AND u.occurred_at < upper(hon.ai_spend_window(s.organization_id, at))) AS recorded
            FROM hon.schools s LEFT JOIN hon.ai_school_cost_limits l ON l.school_id = s.id) x
      ORDER BY 3 DESC NULLS LAST, 2 DESC, 1 LIMIT 500) z), '[]'::jsonb),
    'trialDefaultCeilingMicros', hon.ai_school_trial_default_ceiling_micros(), 'asOf', hon.saas_ts(at));
END $$;

DO $$ DECLARE f regprocedure; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.ai_school_trial_default_ceiling_micros()'::regprocedure,
    'hon.ai_school_default_ceiling_for(uuid,timestamptz)'::regprocedure, 'hon.guard_ai_school_cost_limit_commands()'::regprocedure,
    'hon.guard_ai_school_cost_limits()'::regprocedure, 'hon.ai_school_committed_cost_micros(uuid,uuid,timestamptz)'::regprocedure,
    'hon.ai_school_cost_level(bigint,bigint)'::regprocedure, 'hon.ai_school_spend_decision(uuid,uuid,timestamptz,text)'::regprocedure,
    'hon.ai_org_spend_allowed(uuid,timestamptz,text)'::regprocedure, 'hon.ai_spend_allowed(uuid,timestamptz,text)'::regprocedure,
    'hon.ai_spend_allowed(uuid,uuid,timestamptz,text)'::regprocedure, 'hon.ai_spend_start_guard()'::regprocedure,
    'hon.ai_spend_b3_guard()'::regprocedure, 'hon.ai_school_creative_guard()'::regprocedure,
    'hon.command_ai_school_cost_limit(text,jsonb,uuid)'::regprocedure, 'hon.read_ai_school_cost_limits_from_hq(text)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.command_ai_school_cost_limit(text,jsonb,uuid), hon.read_ai_school_cost_limits_from_hq(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
