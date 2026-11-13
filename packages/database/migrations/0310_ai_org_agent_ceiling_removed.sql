BEGIN;
-- 0310: no organization agent budget for a paying organization (owner decision, David, 2026-11-13 04:10Z).
-- Spec: docs/architecture/AI_ORG_AGENT_CEILING_REMOVED.md.
-- - Until now every organization a free trial does not own had an interim 12,000-unit monthly agent budget (0194,
--   OD-23) that every prepare, the reserve guard and the planner compare committed + estimate against. The owner removed
--   it: conversations with HON and the AI team are not capped for a paying school.
-- - hon.ai_org_ceiling and hon.ai_org_display_ceiling now return hon.ai_org_no_ceiling_units() (2,147,483,647, "no
--   ceiling") for such an organization, so every existing caller keeps its shape and its ai.budget:<org> lock order and
--   simply never refuses on the organization total. The trial path (0246, 0272) is unchanged.
-- - An organization ceiling can still be set for one organization in hon.ai_org_agent_ceiling_overrides. It is owned by
--   the migration owner only (no runtime grant, no API): an operator backstop, and what the proofs use to keep testing
--   the budget lock. HQ's app-level tools are the R2 per-school ceiling and pause (0288) and the HQ pause (0195).
-- - Every other S4 protection is unchanged: per-call ceilings, reply budgets, cost verification, UNKNOWN holds, access
--   decisions and pauses.

CREATE FUNCTION hon.ai_org_no_ceiling_units() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 2147483647 $$;

CREATE TABLE hon.ai_org_agent_ceiling_overrides (
  organization_id uuid PRIMARY KEY REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  ceiling_units integer NOT NULL CHECK (ceiling_units BETWEEN 0 AND 2147483646),
  reason text NOT NULL CHECK (reason = btrim(reason) AND length(reason) BETWEEN 10 AND 500),
  set_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE hon.ai_org_agent_ceiling_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_org_agent_ceiling_overrides FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.ai_org_agent_ceiling_overrides FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.ai_org_agent_ceiling_overrides FROM %I', r);
  END LOOP;
END $$;

-- The ceiling for an organization a trial does not own: its override, else none.
CREATE FUNCTION hon.ai_org_paid_ceiling(p_org uuid) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT coalesce((SELECT o.ceiling_units FROM hon.ai_org_agent_ceiling_overrides o WHERE o.organization_id = p_org), hon.ai_org_no_ceiling_units())
$$;

-- 0272 bodies; only the non-trial branch changes (12000 -> hon.ai_org_paid_ceiling).
CREATE OR REPLACE FUNCTION hon.ai_org_ceiling(p_org uuid, p_at timestamptz) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN NOT c.trial_owned THEN hon.ai_org_paid_ceiling(p_org)
    ELSE greatest(0,least(12000::bigint,c.credit_room,c.daily_room,c.request_room))::integer END
  FROM hon.ai_trial_ceiling_terms(p_org,p_at) c;
$$;

CREATE OR REPLACE FUNCTION hon.ai_org_display_ceiling(p_org uuid, p_at timestamptz) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT CASE WHEN NOT c.trial_owned THEN hon.ai_org_paid_ceiling(p_org) ELSE greatest(0,least(12000::bigint,c.credit_room))::integer END
  FROM hon.ai_trial_ceiling_terms(p_org,p_at) c;
$$;

DO $$ DECLARE f regprocedure; r text; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.ai_org_no_ceiling_units()'::regprocedure, 'hon.ai_org_paid_ceiling(uuid)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
  END LOOP;
END $$;
COMMIT;
