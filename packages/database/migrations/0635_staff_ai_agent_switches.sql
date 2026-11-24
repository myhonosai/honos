BEGIN;

-- 0635 (allocated by the coordinator 2026-11-22): per-staff AI agent switches, HON Staff app phase S2.
-- Owner asks (David, 2026-11-22): "make all agents available but will be given permission per staff"; decision card
-- "Keep today's access" (staff keep exactly the agents their permissions already allow; new staff start with none);
-- "Go" for S2. Spec: docs/architecture/STAFF_MOBILE_HON.md.
--
-- A1  Nine staff-assignable permissions, one per school agent: ai.agent.{hon,kai,alex,chad,maya,marcus,jordan,claire,
--     lena}.use. They live in the existing roles and permissions screen; a person gets an agent through a role.
-- A2  Two keys: an agent works for a person only while they hold BOTH its switch and the capability it already needed
--     (0212/0284 binding: HON ai.invocation.plan, Kai teaching.assistant.use, Marcus marketing.assistant.use, Chad
--     crm.assistant.follow_up_draft, Claire and Alex reporting.view, Jordan schedule.session.manage, Lena
--     marketing.campaign.read, Maya retention.review.read). A switch never gives more than the person could do by hand.
-- A3  Enforced where every school AI request already passes: the AI planner (require_ai_agent_capability before the
--     planner's locks, hold_and_recheck_ai_planning_authority after them, now also holding the switch rows FOR SHARE).
--     That covers HON chat on web and app, the Kai, Marcus and Chad pages, and the features that plan as an agent
--     (paper import plans as HON; website AI, merch ideas and the commerce review plan as Marcus). A refused plan is the
--     existing refusal path (HON replies record AI_ACCESS_REFUSED; specialists record AGENT_NOT_AUTHORIZED).
-- A4  begin_hon_turn refuses a turn for an agent whose switch is off before anything is recorded (42501
--     HON_AGENT_OFF). It is the 0284 function unchanged, renamed to hon.begin_hon_turn_0284 (no runtime grant), behind
--     a wrapper with the same signature, so its existing grant and callers are unchanged.
-- A5  read_ai_team_readiness (the agent list on web and in the app) marks an agent whose switch is off as
--     authorized=false, available=false, blockedBy NOT_AUTHORIZED. Same wrapper pattern (hon.read_ai_team_readiness_0284).
--     hon_reply_allowed_suggestions (0266) suggests only agents the person has switched on.
-- A6  Keep today's access: every role that holds an agent's capability today also gets its switch, and every system
--     OWNER role gets all nine. Roles created later get a switch only when the owner ticks it. New schools' OWNER roles
--     receive every permission at sign-up (0241), so owners always have every agent.
-- Unchanged: budgets, S4 spend guards, plans, providers, Eian (its own family plan path), HQ agents (never plannable at
-- a school). Nothing here calls an AI or outside service, sends, charges or changes an entitlement.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regprocedure('hon.begin_hon_turn(text,uuid,jsonb,uuid)') IS NULL OR to_regprocedure('hon.read_ai_team_readiness(text)') IS NULL
    OR to_regprocedure('hon.hon_reply_allowed_suggestions(uuid,uuid,uuid,text[])') IS NULL OR to_regprocedure('hon.require_ai_agent_capability(text)') IS NULL
    OR to_regprocedure('hon.hold_and_recheck_ai_planning_authority(text)') IS NULL OR to_regprocedure('hon.ai_agent_capability_permission(text)') IS NULL
    OR to_regprocedure('hon.list_assignable_staff_permissions(text)') IS NULL
    OR to_regprocedure('hon.begin_hon_turn_0284(text,uuid,jsonb,uuid)') IS NOT NULL OR to_regprocedure('hon.read_ai_team_readiness_0284(text)') IS NOT NULL
    OR hon.ai_agent_capability_permission('maya') IS DISTINCT FROM 'retention.review.read' THEN
    RAISE EXCEPTION '0635 requires 0212, 0266, 0284 and 0412'; END IF;
END $$;

-- A1: the switch for each school agent. NULL for anything else (HQ agents, Eian, unknown keys).
CREATE FUNCTION hon.ai_agent_switch_permission(p_agent text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_agent IN ('hon','kai','alex','chad','maya','marcus','jordan','claire','lena') THEN 'ai.agent.' || p_agent || '.use' END
$$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
  ('ai.agent.hon.use','Use HON, the school assistant (questions, briefings, paper import reading)',false,true),
  ('ai.agent.kai.use','Use Kai, teaching and curriculum help',false,true),
  ('ai.agent.alex.use','Use Alex, general management answers',false,true),
  ('ai.agent.chad.use','Use Chad, lead follow-up drafts',false,true),
  ('ai.agent.maya.use','Use Maya, at-risk student answers',false,true),
  ('ai.agent.marcus.use','Use Marcus, marketing drafts (also website AI edits and merch ideas)',false,true),
  ('ai.agent.jordan.use','Use Jordan, class and operations answers',false,true),
  ('ai.agent.claire.use','Use Claire, business performance answers',false,true),
  ('ai.agent.lena.use','Use Lena, creative and commerce answers',false,true)
ON CONFLICT (code) DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM hon.permissions WHERE code LIKE 'ai.agent.%.use' AND NOT is_sensitive AND is_staff_assignable
        AND code = hon.ai_agent_switch_permission(split_part(code,'.',3))) <> 9
     OR EXISTS (SELECT 1 FROM hon.permissions WHERE code LIKE 'ai.agent.%' AND hon.ai_agent_switch_permission(split_part(code,'.',3)) IS DISTINCT FROM code) THEN
    RAISE EXCEPTION 'AI agent switch permissions already exist with an unexpected definition'; END IF;
END $$;

-- A6: keep today's access, then every system owner has every agent.
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT DISTINCT rp.role_id, rp.organization_id, hon.ai_agent_switch_permission(a.agent)
  FROM (VALUES ('hon'),('kai'),('alex'),('chad'),('maya'),('marcus'),('jordan'),('claire'),('lena')) a(agent)
  JOIN hon.role_permissions rp ON rp.permission_code = hon.ai_agent_capability_permission(a.agent)
ON CONFLICT DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT r.id, r.organization_id, p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code = 'OWNER' AND p.code LIKE 'ai.agent.%.use' AND p.code = hon.ai_agent_switch_permission(split_part(p.code,'.',3))
ON CONFLICT DO NOTHING;

-- A2: both keys at this exact school, read live through the existing permission reader.
CREATE FUNCTION hon.principal_has_ai_agent(p_principal uuid, p_org uuid, p_school uuid, p_agent text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT hon.ai_agent_capability_permission(p_agent) IS NOT NULL AND hon.ai_agent_switch_permission(p_agent) IS NOT NULL
     AND coalesce(hon.principal_has_school_permission(p_principal, p_org, p_school, hon.ai_agent_capability_permission(p_agent)), false)
     AND coalesce(hon.principal_has_school_permission(p_principal, p_org, p_school, hon.ai_agent_switch_permission(p_agent)), false)
$$;

-- A3: the planner's first check (0212 body, both keys).
CREATE OR REPLACE FUNCTION hon.require_ai_agent_capability(p_agent text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
BEGIN
  IF actor IS NULL OR NOT hon.principal_has_ai_agent(actor, hon.current_organization_id(), hon.current_school_id(), p_agent) THEN
    RAISE EXCEPTION 'AI planning permission denied' USING ERRCODE = '42501';
  END IF;
END $$;

-- A3: the planner's re-check after its last wait (0212 body; the switch rows are held FOR SHARE with the others).
CREATE OR REPLACE FUNCTION hon.hold_and_recheck_ai_planning_authority(p_agent text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
  actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  cap text := hon.ai_agent_capability_permission(p_agent);
  switch_ text := hon.ai_agent_switch_permission(p_agent);
BEGIN
  PERFORM 1 FROM hon.organizations WHERE id = org FOR SHARE;
  PERFORM 1 FROM hon.schools WHERE id = school AND organization_id = org FOR SHARE;
  PERFORM 1 FROM hon.principals WHERE id = actor FOR SHARE;
  PERFORM 1 FROM hon.principal_role_grants WHERE principal_id = actor AND organization_id = org AND school_id = school ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.roles WHERE id IN (SELECT role_id FROM hon.principal_role_grants WHERE principal_id = actor AND organization_id = org AND school_id = school) ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.role_permissions WHERE permission_code IN ('ai.invocation.plan', cap, switch_)
    AND role_id IN (SELECT role_id FROM hon.principal_role_grants WHERE principal_id = actor AND organization_id = org AND school_id = school)
    ORDER BY role_id, permission_code FOR SHARE;
  PERFORM hon.require_ai_invocation_plan_access();
  PERFORM hon.require_ai_agent_capability(p_agent);
  IF NOT EXISTS (SELECT 1 FROM hon.organization_entitlements WHERE organization_id = org AND tier = 'COMPLETE' AND status = 'ACTIVE'
      AND effective_from <= clock_timestamp() AND (effective_until IS NULL OR clock_timestamp() < effective_until)) THEN
    RAISE EXCEPTION 'Active Complete entitlement required for AI planning' USING ERRCODE = '42501';
  END IF;
END $$;

-- A5: suggestions (0266 body, both keys).
CREATE OR REPLACE FUNCTION hon.hon_reply_allowed_suggestions(p_principal uuid, p_org uuid, p_school uuid, p_agents text[]) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(array_agg(a.agent ORDER BY a.ord), '{}'::text[])
  FROM unnest(coalesce(p_agents, '{}'::text[])) WITH ORDINALITY a(agent, ord)
  WHERE a.agent IN ('marcus', 'kai', 'chad', 'claire')
    AND hon.principal_has_ai_agent(p_principal, p_org, p_school, a.agent);
$$;

-- A4: the 0284 turn function, unchanged, behind the switch check. It keeps no runtime or public grant.
ALTER FUNCTION hon.begin_hon_turn(text,uuid,jsonb,uuid) RENAME TO begin_hon_turn_0284;
CREATE FUNCTION hon.begin_hon_turn(p_subject text, p_conversation uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); agent text;
BEGIN
  -- The agent the 0284 function will use: HON for a question (delegation null), else the named agent. Anything else
  -- (a bad shape or an unknown key) goes on to 0284, which refuses it exactly as before.
  IF jsonb_typeof(p_input) = 'object' AND jsonb_typeof(p_input->'delegation') = 'null' THEN agent := 'hon';
  ELSIF jsonb_typeof(p_input) = 'object' AND jsonb_typeof(p_input->'delegation') = 'object' AND jsonb_typeof(p_input->'delegation'->'agentKey') = 'string' THEN
    agent := p_input->'delegation'->>'agentKey';
  END IF;
  IF hon.ai_agent_switch_permission(agent) IS NOT NULL
     AND NOT hon.principal_has_school_permission(actor, hon.current_organization_id(), hon.current_school_id(), hon.ai_agent_switch_permission(agent)) THEN
    RAISE EXCEPTION 'HON_AGENT_OFF' USING ERRCODE = '42501';
  END IF;
  RETURN hon.begin_hon_turn_0284(p_subject, p_conversation, p_input, p_key);
END $$;

-- A5: the 0284 readiness function, unchanged, with each switched-off agent marked as not authorized.
ALTER FUNCTION hon.read_ai_team_readiness(text) RENAME TO read_ai_team_readiness_0284;
CREATE FUNCTION hon.read_ai_team_readiness(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v jsonb := hon.read_ai_team_readiness_0284(p_subject);
  -- 0284 has already proved this transaction's direct human is p_subject's principal at this school.
  actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
BEGIN
  RETURN jsonb_set(v, '{agents}', coalesce((
    SELECT jsonb_agg(CASE WHEN hon.principal_has_school_permission(actor, org, school, hon.ai_agent_switch_permission(e.a->>'agentKey'))
                          THEN e.a
                          ELSE e.a || jsonb_build_object('authorized', false, 'available', false, 'blockedBy', 'NOT_AUTHORIZED') END
                     ORDER BY e.ord)
      FROM jsonb_array_elements(v->'agents') WITH ORDINALITY e(a, ord)), '[]'::jsonb));
END $$;

-- Grants: the wrappers keep the entry points' runtime EXECUTE (010 grants them by signature); the renamed 0284 bodies
-- and the new helpers are internal only.
DO $$
DECLARE f text; r text;
BEGIN
  FOREACH f IN ARRAY ARRAY['hon.begin_hon_turn_0284(text,uuid,jsonb,uuid)','hon.read_ai_team_readiness_0284(text)',
      'hon.principal_has_ai_agent(uuid,uuid,uuid,text)','hon.ai_agent_switch_permission(text)',
      'hon.begin_hon_turn(text,uuid,jsonb,uuid)','hon.read_ai_team_readiness(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','hon_runtime','hon_outbox_worker','hon_communication_worker','hon_automation_worker'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r); END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_hon_turn(text,uuid,jsonb,uuid) TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.read_ai_team_readiness(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
