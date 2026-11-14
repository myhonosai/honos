BEGIN;
-- 0353: AI for a school on a free HQ access exception, only under a monthly dollar limit the HQ owner sets
-- (owner decision, David, 2026-11-14: "Go ... a", option (a): "Allow AI on free-access schools when you set a monthly
-- dollar limit per school"). Spec: docs/architecture/AI_EXCEPTION_SCHOOL_ALLOWANCE.md.
-- - This narrows AI-D1 (2026-10-31: "HQ access exceptions grant no AI"). An exception still grants no AI by itself:
--   without an allowance every decision stays AI_EXCEPTION_NO_AI, exactly as before.
-- - The HQ owner may set (or clear) one monthly limit for the exception's own school, bound to that exact exception.
--   While that exception is live and has started, the school's agent AI (HON and the AI team, class AGENT_INFERENCE)
--   is decided like any other school's, and the R2 per-school ceiling (0288) enforces the limit: the school's effective
--   ceiling is the lower of its 0288 ceiling (if any) and this limit. A new exception never inherits an old limit.
-- - Creative media (image and video, CREATIVE_MEDIA) stays refused on an exception school: it is paid from the
--   creative wallet, not this limit.
-- - The organization HQ pause, platform pause and the 0288 school pause still come first. Clearing the limit, ending or
--   revoking the exception, or the exception expiring all return the school to AI_EXCEPTION_NO_AI at once.
-- - Suggested default in the HQ screen: $25 a month (hon.ai_exception_default_allowance_micros()). The value is always
--   explicit in the command; nothing is set automatically.
-- - Internal HON provider cost only: never a customer balance, credits or a charge.
-- Shared guard functions from 0341 (saas schedule/access) are not touched.

CREATE FUNCTION hon.ai_exception_default_allowance_micros() RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 25000000::bigint $$;

CREATE TABLE hon.ai_exception_school_allowances (
  school_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  exception_id uuid NOT NULL, -- no FK: saas_access_exceptions must stay un-referenced (its TRUNCATE guard, 0185); the decision joins on id
  -- NULL = cleared (no AI on the exception). Otherwise $1 to $1,000 a month in micro-USD.
  ceiling_micros bigint CHECK (ceiling_micros IS NULL OR ceiling_micros BETWEEN 1000000 AND 1000000000),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  version integer NOT NULL CHECK (version >= 1),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);
-- Append-only command log: the audit of every HQ change (who, when, school, exception, limit, reason) and the
-- idempotency record.
CREATE TABLE hon.ai_exception_school_allowance_commands (
  command_key uuid PRIMARY KEY,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  exception_id uuid NOT NULL, -- no FK: saas_access_exceptions must stay un-referenced (its TRUNCATE guard, 0185); the decision joins on id
  ceiling_micros bigint,
  reason text NOT NULL,
  prior_version integer NOT NULL CHECK (prior_version >= 0),
  resulting_version integer NOT NULL CHECK (resulting_version = prior_version + 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);
CREATE FUNCTION hon.guard_ai_exception_school_allowance_commands() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'AI_EXCEPTION_ALLOWANCE_COMMAND_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER ai_exception_school_allowance_commands_immutable BEFORE UPDATE OR DELETE ON hon.ai_exception_school_allowance_commands
  FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_exception_school_allowance_commands();
CREATE TRIGGER ai_exception_school_allowance_commands_no_truncate BEFORE TRUNCATE ON hon.ai_exception_school_allowance_commands
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_exception_school_allowance_commands();
CREATE FUNCTION hon.guard_ai_exception_school_allowances() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.school_id <> OLD.school_id OR NEW.organization_id <> OLD.organization_id OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'AI_EXCEPTION_ALLOWANCE_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_exception_school_allowances_guard BEFORE UPDATE OR DELETE ON hon.ai_exception_school_allowances FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_exception_school_allowances();
CREATE TRIGGER ai_exception_school_allowances_no_truncate BEFORE TRUNCATE ON hon.ai_exception_school_allowances FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_exception_school_allowances();
ALTER TABLE hon.ai_exception_school_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_exception_school_allowances FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_exception_school_allowance_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_exception_school_allowance_commands FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.ai_exception_school_allowances, hon.ai_exception_school_allowance_commands FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.ai_exception_school_allowances, hon.ai_exception_school_allowance_commands FROM %I', r);
  END LOOP;
END $$;

-- The limit that applies to one school right now: its set allowance, only while the exact exception it was set for is
-- granted, started, unexpired, still owns the organization's entitlement (0185) and is for this school. Else NULL.
CREATE FUNCTION hon.ai_exception_allowance_micros(p_org uuid, p_school uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT a.ceiling_micros FROM hon.ai_exception_school_allowances a
    JOIN hon.saas_access_exceptions x ON x.id = a.exception_id
    JOIN hon.organization_entitlements e ON e.organization_id = x.organization_id
   WHERE a.school_id = p_school AND a.organization_id = p_org AND a.ceiling_micros IS NOT NULL
     AND x.organization_id = p_org AND x.school_id = p_school AND x.status = 'GRANTED'
     AND x.starts_at <= clock_timestamp() AND x.expires_at > clock_timestamp()
     AND e.version = x.granted_entitlement_version AND e.status = 'ACTIVE'
$$;

-- Organization/platform decision for one school: the 0288 organization decision, except that an exception school with
-- a live allowance is not refused for agent AI (the school decision below then enforces the limit).
CREATE FUNCTION hon.ai_org_spend_allowed_for_school(p_org uuid, p_school uuid, p_at timestamptz, p_class text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE why text := hon.ai_org_spend_allowed(p_org, p_at, p_class);
BEGIN
  IF why = 'AI_EXCEPTION_NO_AI' AND p_class = 'AGENT_INFERENCE' AND p_school IS NOT NULL
     AND hon.ai_exception_allowance_micros(p_org, p_school) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN why;
END $$;

-- 0288 body; the agent ceiling is now the lower of the school's 0288 ceiling (or default) and its live exception allowance.
CREATE OR REPLACE FUNCTION hon.ai_school_spend_decision(p_org uuid, p_school uuid, p_at timestamptz, p_class text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE l hon.ai_school_cost_limits%ROWTYPE; ceiling bigint;
BEGIN
  IF p_school IS NULL OR p_class NOT IN ('AGENT_INFERENCE','CREATIVE_MEDIA') THEN RETURN NULL; END IF;
  SELECT * INTO l FROM hon.ai_school_cost_limits WHERE school_id = p_school AND organization_id = p_org;
  IF FOUND AND l.paused THEN RETURN 'AI_PAUSED_BY_HQ'; END IF;
  IF p_class = 'AGENT_INFERENCE' THEN
    -- least() ignores NULLs: no HQ record, no live trial and no allowance means no ceiling.
    ceiling := least(coalesce(l.ceiling_micros, hon.ai_school_default_ceiling_for(p_org, p_at)), hon.ai_exception_allowance_micros(p_org, p_school));
    IF ceiling IS NOT NULL AND hon.ai_school_committed_cost_micros(p_org, p_school, p_at) >= ceiling THEN
      RETURN 'AI_PAUSED_BY_HQ';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- 0288 body: organization/platform first (now school-aware for exception allowances), then that school.
CREATE OR REPLACE FUNCTION hon.ai_spend_allowed(p_org uuid, p_school uuid, p_at timestamptz, p_class text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  RETURN coalesce(hon.ai_org_spend_allowed_for_school(p_org, p_school, p_at, p_class), hon.ai_school_spend_decision(p_org, p_school, p_at, p_class));
END $$;

-- 0288 reserve guard body; only the first decision now names the row's own school.
CREATE OR REPLACE FUNCTION hon.ai_spend_reserve_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE prior bigint := CASE WHEN TG_OP='UPDATE' THEN OLD.reserved_credits ELSE 0 END;
  why text := hon.ai_org_spend_allowed_for_school(NEW.organization_id, NEW.school_id, clock_timestamp(), 'AGENT_INFERENCE');
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

-- HQ owner command: set ({ceilingMicros: n}) or clear ({ceilingMicros: null}) the AI limit of one exception school.
-- Versioned (expectedVersion 0 = no record yet), idempotent by key, authority held and re-checked after every wait
-- (the 0288 pattern; it takes the same per-school lock as the 0288 command). Setting needs a granted, unexpired
-- exception for this exact school that still owns the entitlement; clearing is always allowed.
CREATE FUNCTION hon.command_ai_exception_school_allowance(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_school uuid; v_org uuid; v_ceiling bigint; v_reason text; v_expected integer; fp text; v_exception uuid;
  a hon.ai_exception_school_allowances%ROWTYPE; cmd hon.ai_exception_school_allowance_commands%ROWTYPE; cur integer;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k), ARRAY[]::text[]) <> ARRAY['ceilingMicros','expectedVersion','reason','schoolId']
     OR jsonb_typeof(p_input->'schoolId') <> 'string' OR (p_input->>'schoolId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(p_input->'ceilingMicros') NOT IN ('number','null')
     OR (jsonb_typeof(p_input->'ceilingMicros') = 'number' AND ((p_input->>'ceilingMicros') !~ '^[0-9]{7,10}$'
         OR (p_input->>'ceilingMicros')::bigint NOT BETWEEN 1000000 AND 1000000000))
     OR jsonb_typeof(p_input->'expectedVersion') <> 'number' OR (p_input->>'expectedVersion') !~ '^[0-9]{1,9}$'
     OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'INVALID_AI_EXCEPTION_ALLOWANCE' USING ERRCODE='22023';
  END IF;
  v_school := (p_input->>'schoolId')::uuid; v_ceiling := (p_input->>'ceilingMicros')::bigint;
  v_reason := p_input->>'reason'; v_expected := (p_input->>'expectedVersion')::integer;
  fp := encode(sha256(convert_to(jsonb_build_object('s',v_school,'c',v_ceiling,'r',v_reason,'v',v_expected,'by',actor)::text,'UTF8')),'hex');
  SELECT organization_id INTO v_org FROM hon.schools WHERE id = v_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_SCHOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.exception-allowance.key:' || p_key::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.school-cost:' || v_school::text, 0));
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO cmd FROM hon.ai_exception_school_allowance_commands WHERE command_key = p_key;
  IF FOUND THEN
    IF cmd.fingerprint <> fp THEN RAISE EXCEPTION 'AI_EXCEPTION_ALLOWANCE_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('schoolId',cmd.school_id,'organizationId',cmd.organization_id,'exceptionId',cmd.exception_id,
      'ceilingMicros',cmd.ceiling_micros,'version',cmd.resulting_version,'replayed',true);
  END IF;
  SELECT * INTO a FROM hon.ai_exception_school_allowances WHERE school_id = v_school FOR UPDATE;
  cur := CASE WHEN FOUND THEN a.version ELSE 0 END;
  IF cur <> v_expected THEN RAISE EXCEPTION 'SAAS_VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF v_ceiling IS NULL THEN
    -- Clearing: nothing to clear without a record; the record keeps the exception it was set for.
    IF cur = 0 THEN RAISE EXCEPTION 'AI_EXCEPTION_ALLOWANCE_NOT_SET' USING ERRCODE='23514'; END IF;
    v_exception := a.exception_id;
  ELSE
    -- The organization's granted exception must be for this school, unexpired and still own the entitlement. Its row
    -- is share-locked so a concurrent revoke or close waits for this command (and then makes the limit inert).
    SELECT x.id INTO v_exception FROM hon.saas_access_exceptions x JOIN hon.organization_entitlements e ON e.organization_id = x.organization_id
     WHERE x.organization_id = v_org AND x.school_id = v_school AND x.status = 'GRANTED' AND x.expires_at > clock_timestamp()
       AND e.version = x.granted_entitlement_version AND e.status = 'ACTIVE'
     FOR SHARE OF x;
    IF v_exception IS NULL THEN RAISE EXCEPTION 'AI_EXCEPTION_NOT_LIVE' USING ERRCODE='23514'; END IF;
  END IF;
  IF cur = 0 THEN
    INSERT INTO hon.ai_exception_school_allowances(school_id, organization_id, exception_id, ceiling_micros, reason, version, updated_by_principal_id)
      VALUES (v_school, v_org, v_exception, v_ceiling, v_reason, 1, actor);
  ELSE
    UPDATE hon.ai_exception_school_allowances SET exception_id = v_exception, ceiling_micros = v_ceiling, reason = v_reason, version = version + 1,
      updated_by_principal_id = actor, updated_at = clock_timestamp() WHERE school_id = v_school;
  END IF;
  INSERT INTO hon.ai_exception_school_allowance_commands(command_key, fingerprint, actor_principal_id, school_id, organization_id, exception_id,
      ceiling_micros, reason, prior_version, resulting_version)
    VALUES (p_key, fp, actor, v_school, v_org, v_exception, v_ceiling, v_reason, cur, cur + 1);
  RETURN jsonb_build_object('schoolId',v_school,'organizationId',v_org,'exceptionId',v_exception,'ceilingMicros',v_ceiling,'version',cur + 1,'replayed',false);
END $$;

-- HQ read: every granted, unexpired exception (one per organization, at most 500, soonest to end first) with its
-- school's AI limit, whether it applies now, this month's agent AI cost and level. HQ readers only.
CREATE FUNCTION hon.read_ai_exception_school_allowances_from_hq(p_subject text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false); at timestamptz := clock_timestamp();
BEGIN
  RETURN jsonb_build_object('schools', coalesce((SELECT jsonb_agg(z.v ORDER BY z.expires_at, z.exception_id) FROM (
      SELECT x.id AS exception_id, x.expires_at, jsonb_build_object('organizationId',x.organization_id,'schoolId',x.school_id,'exceptionId',x.id,
          'schoolName',left(s.name,300),'exceptionStartsAt',hon.saas_ts(x.starts_at),'exceptionExpiresAt',hon.saas_ts(x.expires_at),
          'exceptionLive',hon.saas_access_exception_live(x.organization_id),
          'ceilingMicros',CASE WHEN a.exception_id = x.id THEN a.ceiling_micros END,
          'aiAllowed',hon.ai_exception_allowance_micros(x.organization_id, x.school_id) IS NOT NULL,
          'version',coalesce(a.version,0),'reason',a.reason,'updatedAt',hon.saas_ts(a.updated_at),
          'committedCostMicros',hon.ai_school_committed_cost_micros(x.organization_id, x.school_id, at),
          'level',hon.ai_school_cost_level(hon.ai_school_committed_cost_micros(x.organization_id, x.school_id, at), hon.ai_exception_allowance_micros(x.organization_id, x.school_id)),
          'windowStart',hon.saas_ts(lower(hon.ai_spend_window(x.organization_id, at))),'windowEnd',hon.saas_ts(upper(hon.ai_spend_window(x.organization_id, at)))) AS v
        FROM hon.saas_access_exceptions x JOIN hon.schools s ON s.id = x.school_id AND s.organization_id = x.organization_id
        LEFT JOIN hon.ai_exception_school_allowances a ON a.school_id = x.school_id
       WHERE x.status = 'GRANTED' AND x.expires_at > at
       ORDER BY x.expires_at, x.id LIMIT 500) z), '[]'::jsonb),
    'defaultCeilingMicros', hon.ai_exception_default_allowance_micros(), 'asOf', hon.saas_ts(at));
END $$;

DO $$ DECLARE f regprocedure; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.ai_exception_default_allowance_micros()'::regprocedure,
    'hon.guard_ai_exception_school_allowance_commands()'::regprocedure, 'hon.guard_ai_exception_school_allowances()'::regprocedure,
    'hon.ai_exception_allowance_micros(uuid,uuid)'::regprocedure, 'hon.ai_org_spend_allowed_for_school(uuid,uuid,timestamptz,text)'::regprocedure,
    'hon.ai_school_spend_decision(uuid,uuid,timestamptz,text)'::regprocedure, 'hon.ai_spend_allowed(uuid,uuid,timestamptz,text)'::regprocedure,
    'hon.ai_spend_reserve_guard()'::regprocedure,
    'hon.command_ai_exception_school_allowance(text,jsonb,uuid)'::regprocedure, 'hon.read_ai_exception_school_allowances_from_hq(text)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.command_ai_exception_school_allowance(text,jsonb,uuid), hon.read_ai_exception_school_allowances_from_hq(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
