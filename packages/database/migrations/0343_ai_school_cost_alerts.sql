BEGIN;

-- 0343: HQ alerts when a school reaches 75%, 90% and 100% of its internal monthly AI cost ceiling (R2, 0288), and an
-- HQ-owner acknowledgement. Spec: docs/architecture/AI_SCHOOL_COST_ALERTS.md. HON's own provider cost, never a school
-- balance or charge. Nothing here changes a spend decision, a ceiling or a pause.
-- Alerts are derived, not written on the spend path: a school with a ceiling above 0 has an alert for every level its
-- committed cost (hon.ai_school_committed_cost_micros) has reached this budget window. crossedAt is the first verified
-- ledger row whose running total reached the level (NULL while only in-flight holds reach it). The only stored state is
-- the immutable acknowledgement, one per school, window and level.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.read_ai_school_cost_limits_from_hq(text)') IS NULL THEN RAISE EXCEPTION 'Apply migration 0288 first'; END IF;
END $$;

CREATE TABLE hon.ai_school_cost_alert_acknowledgements (
  command_key uuid PRIMARY KEY,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  window_start timestamptz NOT NULL,
  level text NOT NULL CHECK (level IN ('WARNING_75','WARNING_90','CEILING_REACHED')),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  ceiling_micros bigint NOT NULL CHECK (ceiling_micros BETWEEN 1 AND 1000000000),
  committed_cost_micros bigint NOT NULL CHECK (committed_cost_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (school_id, window_start, level),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.ai_school_cost_alert_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_school_cost_alert_acknowledgements FORCE ROW LEVEL SECURITY;
CREATE FUNCTION hon.guard_ai_school_cost_alert_acknowledgements() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'AI_SCHOOL_COST_ALERT_ACK_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER ai_school_cost_alert_acknowledgements_immutable BEFORE UPDATE OR DELETE ON hon.ai_school_cost_alert_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_school_cost_alert_acknowledgements();
CREATE TRIGGER ai_school_cost_alert_acknowledgements_no_truncate BEFORE TRUNCATE ON hon.ai_school_cost_alert_acknowledgements
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_school_cost_alert_acknowledgements();

-- Order of the levels (NO_CEILING and NORMAL are 0, never an alert).
CREATE FUNCTION hon.ai_school_cost_level_rank(p_level text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE p_level WHEN 'WARNING_75' THEN 1 WHEN 'WARNING_90' THEN 2 WHEN 'CEILING_REACHED' THEN 3 ELSE 0 END
$$;

-- First verified ledger time in the window at which the school's running agent-inference cost reached the level.
CREATE FUNCTION hon.ai_school_cost_alert_crossed_at(p_org uuid, p_school uuid, p_window tstzrange, p_ceiling bigint, p_level text) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT min(t.occurred_at) FROM (
    SELECT u.occurred_at, (sum(coalesce(u.provider_cost_microunits,0)) OVER (ORDER BY u.occurred_at, u.id ROWS UNBOUNDED PRECEDING))::bigint AS run
    FROM hon.ai_usage_ledger u
    WHERE u.organization_id = p_org AND u.school_id = p_school AND u.spend_class = 'AGENT_INFERENCE'
      AND u.occurred_at >= lower(p_window) AND u.occurred_at < upper(p_window)) t
  WHERE hon.ai_school_cost_level_rank(hon.ai_school_cost_level(t.run, p_ceiling)) >= hon.ai_school_cost_level_rank(p_level)
$$;

-- Every school's alerts at p_at. A ceiling of 0 is an HQ block, not a budget, and raises no alert.
CREATE FUNCTION hon.ai_school_cost_alert_rows(p_at timestamptz)
RETURNS TABLE (school_id uuid, organization_id uuid, school_name text, trial boolean, level text, level_rank integer, ceiling_micros bigint,
  committed_cost_micros bigint, window_start timestamptz, crossed_at timestamptz, acknowledged_at timestamptz, ack_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH x AS (
    SELECT s.id, s.organization_id, s.name, hon.hon_os_trial_live(s.organization_id, p_at) AS trial,
      coalesce(l.ceiling_micros, hon.ai_school_default_ceiling_for(s.organization_id, p_at)) AS ceiling,
      hon.ai_spend_window(s.organization_id, p_at) AS w
    FROM hon.schools s LEFT JOIN hon.ai_school_cost_limits l ON l.school_id = s.id),
  c AS (SELECT x.*, hon.ai_school_committed_cost_micros(x.organization_id, x.id, p_at) AS committed FROM x WHERE x.ceiling > 0)
  SELECT c.id, c.organization_id, c.name, c.trial, lv.level, lv.rank, c.ceiling, c.committed, lower(c.w),
    hon.ai_school_cost_alert_crossed_at(c.organization_id, c.id, c.w, c.ceiling, lv.level), k.created_at, k.reason
  FROM c
  CROSS JOIN (VALUES ('WARNING_75',1), ('WARNING_90',2), ('CEILING_REACHED',3)) lv(level, rank)
  LEFT JOIN hon.ai_school_cost_alert_acknowledgements k ON k.school_id = c.id AND k.window_start = lower(c.w) AND k.level = lv.level
  WHERE hon.ai_school_cost_level_rank(hon.ai_school_cost_level(c.committed, c.ceiling)) >= lv.rank
$$;

-- HQ read: open alerts first (most severe, highest use), then acknowledged ones; at most 500, openCount counts all.
CREATE FUNCTION hon.read_ai_school_cost_alerts_from_hq(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_saas_hq_actor(p_subject, false); at timestamptz := clock_timestamp(); result jsonb;
BEGIN
  WITH a AS (SELECT * FROM hon.ai_school_cost_alert_rows(at))
  SELECT jsonb_build_object(
    'alerts', coalesce((SELECT jsonb_agg(z.v ORDER BY z.ord) FROM (
        SELECT row_number() OVER (ORDER BY (a.acknowledged_at IS NOT NULL), a.level_rank DESC, a.committed_cost_micros * 10000 / a.ceiling_micros DESC, a.school_id) AS ord,
          jsonb_build_object('schoolId',a.school_id,'organizationId',a.organization_id,'schoolName',a.school_name,'trial',a.trial,'level',a.level,
            'ceilingMicros',a.ceiling_micros,'committedCostMicros',a.committed_cost_micros,
            'usedBasisPoints',least(a.committed_cost_micros * 10000 / a.ceiling_micros, 1000000),
            'crossedAt',CASE WHEN a.crossed_at IS NULL THEN NULL ELSE hon.saas_ts(a.crossed_at) END,'windowStart',hon.saas_ts(a.window_start),
            'acknowledgement',CASE WHEN a.acknowledged_at IS NULL THEN NULL ELSE jsonb_build_object('acknowledgedAt',hon.saas_ts(a.acknowledged_at),'reason',a.ack_reason) END) AS v
        FROM a ORDER BY 1 LIMIT 500) z), '[]'::jsonb),
    'openCount', (SELECT count(*)::int FROM a WHERE a.acknowledged_at IS NULL),
    'asOf', hon.saas_ts(at)) INTO result;
  -- Authority after the read, as the other HQ reads do.
  IF hon.require_saas_hq_actor(p_subject, false) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- HQ owner acknowledges one active alert of the current window. Informational only: spend decisions are unchanged.
CREATE FUNCTION hon.command_ai_school_cost_alert_acknowledgement(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; v_school uuid; v_org uuid; v_level text; v_window text; v_reason text; fp text; at timestamptz := clock_timestamp();
  k hon.ai_school_cost_alert_acknowledgements%ROWTYPE; a record;
BEGIN
  actor := hon.require_saas_hq_actor(p_subject, true);
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
     OR coalesce((SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x), ARRAY[]::text[]) <> ARRAY['level','reason','schoolId','windowStart']
     OR jsonb_typeof(p_input->'schoolId') <> 'string' OR (p_input->>'schoolId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(p_input->'level') <> 'string' OR (p_input->>'level') NOT IN ('WARNING_75','WARNING_90','CEILING_REACHED')
     OR jsonb_typeof(p_input->'windowStart') <> 'string' OR length(p_input->>'windowStart') > 40
     OR jsonb_typeof(p_input->'reason') <> 'string' OR (p_input->>'reason') <> btrim(p_input->>'reason') OR length(p_input->>'reason') NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'INVALID_AI_SCHOOL_COST_ALERT_ACK' USING ERRCODE='22023';
  END IF;
  v_school := (p_input->>'schoolId')::uuid; v_level := p_input->>'level'; v_window := p_input->>'windowStart'; v_reason := p_input->>'reason';
  fp := encode(sha256(convert_to(jsonb_build_object('s',v_school,'l',v_level,'w',v_window,'r',v_reason,'by',actor)::text,'UTF8')),'hex');
  SELECT organization_id INTO v_org FROM hon.schools WHERE id = v_school;
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_SCHOOL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  LOCK TABLE hon.users, hon.principals, hon.hq_operator_grants, hon.family_access_grants IN SHARE MODE;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.school-cost-alert.key:' || p_key::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('ai.school-cost-alert:' || v_school::text, 0));
  IF hon.require_saas_hq_actor(p_subject, true) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SAAS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO k FROM hon.ai_school_cost_alert_acknowledgements WHERE command_key = p_key;
  IF FOUND THEN
    IF k.fingerprint <> fp THEN RAISE EXCEPTION 'AI_SCHOOL_COST_ALERT_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('schoolId',k.school_id,'organizationId',k.organization_id,'level',k.level,'windowStart',hon.saas_ts(k.window_start),
      'acknowledgedAt',hon.saas_ts(k.created_at),'replayed',true);
  END IF;
  -- Only an alert that is active now, in the school's current budget window, can be acknowledged.
  SELECT r.* INTO a FROM hon.ai_school_cost_alert_rows(at) r WHERE r.school_id = v_school AND r.level = v_level;
  IF NOT FOUND OR hon.saas_ts(a.window_start) <> v_window THEN RAISE EXCEPTION 'AI_SCHOOL_COST_ALERT_NOT_ACTIVE' USING ERRCODE='22023'; END IF;
  IF a.acknowledged_at IS NOT NULL THEN RAISE EXCEPTION 'AI_SCHOOL_COST_ALERT_ALREADY_ACKNOWLEDGED' USING ERRCODE='23505'; END IF;
  INSERT INTO hon.ai_school_cost_alert_acknowledgements(command_key, fingerprint, actor_principal_id, school_id, organization_id, window_start, level, reason,
      ceiling_micros, committed_cost_micros)
    VALUES (p_key, fp, actor, v_school, v_org, a.window_start, v_level, v_reason, a.ceiling_micros, a.committed_cost_micros)
    RETURNING * INTO k;
  RETURN jsonb_build_object('schoolId',v_school,'organizationId',v_org,'level',v_level,'windowStart',hon.saas_ts(k.window_start),
    'acknowledgedAt',hon.saas_ts(k.created_at),'replayed',false);
END $$;

REVOKE ALL ON TABLE hon.ai_school_cost_alert_acknowledgements FROM PUBLIC;
DO $$ DECLARE f regprocedure; r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.ai_school_cost_alert_acknowledgements FROM %I', r);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_ai_school_cost_alert_acknowledgements()'::regprocedure, 'hon.ai_school_cost_level_rank(text)'::regprocedure,
    'hon.ai_school_cost_alert_crossed_at(uuid,uuid,tstzrange,bigint,text)'::regprocedure, 'hon.ai_school_cost_alert_rows(timestamptz)'::regprocedure,
    'hon.read_ai_school_cost_alerts_from_hq(text)'::regprocedure, 'hon.command_ai_school_cost_alert_acknowledgement(text,jsonb,uuid)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_ai_school_cost_alerts_from_hq(text), hon.command_ai_school_cost_alert_acknowledgement(text,jsonb,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
