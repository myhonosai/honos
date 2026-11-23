BEGIN;

-- Rank chart AI draft (0636). Owner decision 2026-11-22: in Rank setup > Quick setup a school can describe its martial art
-- in its own words and Kai drafts the belt list. It is a kind on the shared AI text proposals of 0550
-- (docs/architecture/AI_TEXT_PROPOSALS.md), built like COMMERCE_REVIEW (0615): one kinds row and its own entry points.
-- The 0550 core, every S4 function and 0622 are unchanged. Spec: docs/architecture/RANK_SETUP_AND_PLAIN_CURRICULUM_PAGES.md (5b).
--   R1 Who: a direct human with curriculum.manage (0070 hon.require_curriculum_actor), teaching.assistant.use, Kai switched
--      on for them (0635 ai.agent.kai.use) and ai.invocation.plan at the session school, and an active Complete entitlement. Only the requester prepares, records or
--      closes; anyone with curriculum.manage reads.
--   R2 Facts: what the person said, the list on their screen when they ask Kai to change it (the same chart shape, at most
--      8,000 bytes of compact JSON), and the names of the school's programs (at most 20, each cut to 60 bytes, so a new name does not clash).
--      A conversation is one request per turn: each turn is its own proposal, plan and counted call.
--      No student, family, staff, attendance or billing data.
--   R3 Result: {name, summary, ranks[1..60] of {name, color, classes, days}}: exactly the 0622 PROGRAM_SETUP input plus a
--      one-line summary. A draft changes nothing. The school checks and edits the list, and saving it is the ordinary 0622
--      PROGRAM_SETUP command by the person. A draft can only be marked used (APPLIED) or dismissed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Rank chart AI draft requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Rank chart AI draft requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.ai_text_begin(text,uuid,text,uuid,integer,jsonb)') IS NULL OR to_regprocedure('hon.shopify_merch_keys_are(jsonb,text[])') IS NULL
    OR to_regprocedure('hon.mutate_rank_setup(text,text,uuid,uuid,jsonb,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.curriculum_app_name_ok(text,integer)') IS NULL
    OR to_regprocedure('hon.shopify_review_clip(text,integer)') IS NULL OR to_regprocedure('hon.ai_agent_switch_permission(text)') IS NULL OR NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='ai.agent.kai.use') OR to_regprocedure('hon.begin_rank_chart_draft(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Rank chart AI draft requires migrations through 0550, 0596, 0605, 0615, 0622 and 0635 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('RANK_CHART','kai','DRAFT_TEACHING',16000,5000,150000,12288,'HUMAN_UI','SCHOOL','RANK_CHART');


-- What a draft may hold: the 0622 PROGRAM_SETUP input and a summary. The contracts validator checks the same shape again.
CREATE FUNCTION hon.rank_chart_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.shopify_merch_keys_are(r,ARRAY['name','ranks','summary'])
    AND jsonb_typeof(r->'name')='string' AND hon.curriculum_app_name_ok(r->>'name',120)
    AND jsonb_typeof(r->'summary')='string' AND hon.marketing_safe_text(r->>'summary',300) AND (r->>'summary') !~ '[<>]'
    AND jsonb_typeof(r->'ranks')='array' AND jsonb_array_length(r->'ranks') BETWEEN 1 AND 60
    AND octet_length(convert_to(r::text,'UTF8'))<=12288
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'ranks') i WHERE NOT (
      hon.shopify_merch_keys_are(i,ARRAY['classes','color','days','name'])
      AND jsonb_typeof(i->'name')='string' AND hon.curriculum_app_name_ok(i->>'name',120)
      AND (jsonb_typeof(i->'color')='null' OR (jsonb_typeof(i->'color')='string' AND (i->>'color') ~ '^#[0-9A-F]{6}$'))
      AND jsonb_typeof(i->'classes')='number' AND (i->>'classes') ~ '^(0|[1-9][0-9]{0,3})$' AND (i->>'classes')::integer<=2000
      AND jsonb_typeof(i->'days')='number' AND (i->>'days') ~ '^(0|[1-9][0-9]{0,3})$' AND (i->>'days')::integer<=3650))
    AND (SELECT count(DISTINCT lower(i->>'name')) FROM jsonb_array_elements(r->'ranks') i)=jsonb_array_length(r->'ranks')
$$;
-- {description: safe text, trimmed, up to 600 characters; current: null, or the list on screen {name, ranks} in the chart
-- shape, when the person asks Kai to change it. The API takes at most 8,000 bytes of compact JSON; jsonb text
-- adds a space after each colon and comma (about 9 bytes a rank), so the same list is at most 8,600 bytes here}.
CREATE FUNCTION hon.rank_chart_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.shopify_merch_keys_are(p,ARRAY['current','description'])
    AND (jsonb_typeof(p->'current')='null' OR (jsonb_typeof(p->'current')='object' AND hon.shopify_merch_keys_are(p->'current',ARRAY['name','ranks'])
      AND octet_length(convert_to((p->'current')::text,'UTF8'))<=8600 AND hon.rank_chart_ok((p->'current')||jsonb_build_object('summary','x'))))
    AND jsonb_typeof(p->'description')='string' AND (p->>'description')=btrim(p->>'description') AND hon.marketing_safe_text(p->>'description',600)
$$;

-- R1: the requester. The curriculum rule first (human, one active principal, curriculum.manage, active school), then Kai.
CREATE FUNCTION hon.rank_chart_ai_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  org := hon.current_organization_id(); school := hon.current_school_id();
  actor := hon.require_curriculum_actor(p_subject,'curriculum.manage');
  IF actor IS NULL OR NOT hon.principal_has_school_permission(actor,org,school,'teaching.assistant.use')
    OR NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
    OR NOT coalesce(hon.principal_has_school_permission(actor,org,school,'ai.agent.kai.use'),false)
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier='COMPLETE' AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'RANK_CHART_AI_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- R2: what Kai sees. The provider request is budgeted in bytes, so program names are cut by bytes (0615 clip), never mid-character.
CREATE FUNCTION hon.rank_chart_facts(p_brief jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('brief',p_brief,'existingPrograms',coalesce((SELECT jsonb_agg(x.name ORDER BY x.name) FROM (
    SELECT hon.shopify_review_clip(regexp_replace(c.name,'[[:cntrl:]<>]','','g'),60) name FROM hon.curricula c
    WHERE c.organization_id=hon.current_organization_id() AND c.school_id=hon.current_school_id() AND c.lifecycle<>'ARCHIVED' ORDER BY c.name,c.id LIMIT 20) x),'[]'::jsonb))
$$;

CREATE FUNCTION hon.rank_chart_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,'mine',i.requested_by=p_actor,
    'draft',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result END,
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='RANK_CHART' AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_rank_chart_draft(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.rank_chart_ai_actor(p_subject); pid uuid;
BEGIN
  IF p_key IS NULL OR NOT hon.rank_chart_brief_ok(p_input) THEN RAISE EXCEPTION 'RANK_CHART_INVALID' USING ERRCODE='22023'; END IF;
  pid := hon.ai_text_begin('RANK_CHART',actor,actor::text||':'||p_key::text,hon.current_school_id(),NULL,p_input);
  RETURN hon.rank_chart_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_rank_chart_draft(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.rank_chart_ai_actor(p_subject);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='RANK_CHART' AND organization_id=hon.current_organization_id()
    AND school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, actor);
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, the core claim, the facts.
CREATE FUNCTION hon.prepare_rank_chart_draft(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.rank_chart_ai_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'RANK_CHART' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  RETURN inv || jsonb_build_object('request',hon.rank_chart_facts(i.request)::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule): a call in flight when access lapsed still records.
CREATE FUNCTION hon.fail_rank_chart_draft(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='RANK_CHART') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}. A proposal outside the closed shape is stored empty and rejected.
CREATE FUNCTION hon.record_rank_chart_draft(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='RANK_CHART') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.shopify_merch_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT coalesce(hon.rank_chart_ok(proposal),false) THEN
    proposal := jsonb_build_object('name','','summary','','ranks','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a rank chart.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.rank_chart_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The school's newest 5 drafts for anyone who may set up ranks, or one by id.
CREATE FUNCTION hon.read_rank_chart_drafts(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_curriculum_actor(p_subject,'curriculum.manage'); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.rank_chart_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.rank_chart_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='RANK_CHART' AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
      ORDER BY created_at DESC, id LIMIT 5) x),'[]'::jsonb);
END $$;

-- APPLIED once the requester saved a program from the draft, or DISMISSED. The requester only; they must still manage ranks.
CREATE FUNCTION hon.close_rank_chart_draft(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_curriculum_actor(p_subject,'curriculum.manage');
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='RANK_CHART') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.rank_chart_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the seven entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.rank_chart_brief_ok(jsonb)','hon.rank_chart_ok(jsonb)','hon.rank_chart_ai_actor(text)','hon.rank_chart_facts(jsonb)','hon.rank_chart_view(uuid,uuid)',
    'hon.begin_rank_chart_draft(text,jsonb,uuid)','hon.plan_rank_chart_draft(text,uuid)','hon.prepare_rank_chart_draft(text,uuid,uuid,boolean)',
    'hon.fail_rank_chart_draft(text,uuid,text,text)','hon.record_rank_chart_draft(text,uuid,jsonb)','hon.read_rank_chart_drafts(text,uuid)',
    'hon.close_rank_chart_draft(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_rank_chart_draft(text,jsonb,uuid), hon.plan_rank_chart_draft(text,uuid),
      hon.prepare_rank_chart_draft(text,uuid,uuid,boolean), hon.fail_rank_chart_draft(text,uuid,text,text),
      hon.record_rank_chart_draft(text,uuid,jsonb), hon.read_rank_chart_drafts(text,uuid), hon.close_rank_chart_draft(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
