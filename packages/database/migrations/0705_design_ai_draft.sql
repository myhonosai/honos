BEGIN;

-- Design AI draft (0705, E4a). Owner decision 2026-11-28: in Creative Studio > New design the school describes the flyer it
-- wants in its own words and Marcus answers with up to three finished options built from the E2 templates. It is a kind on
-- the shared AI text proposals of 0550 (docs/architecture/AI_TEXT_PROPOSALS.md), built like RANK_CHART (0636): one kinds row
-- and its own entry points. The 0550 core, every S4 function and 0617 are unchanged. Spec: docs/architecture/CREATIVE_DESIGN_EDITOR.md (E4).
--   DD1 Who: a direct human with creative.design.manage (0617 hon.require_creative_design_actor), Marcus switched on for them
--      (0635 ai.agent.marcus.use) and ai.invocation.plan at the session school, and an active Complete entitlement. Only the
--      requester prepares, records or closes; anyone with creative.design.manage reads.
--   DD2 Facts: what the person wrote (at most 600 characters), the design size, the editor language and the school's name
--      (cut to 120 bytes). No student, family, staff, attendance or billing data, no photos.
--   DD3 Result: {options[1..3] of {theme, style, words {kicker, head, sub, details, cta}, schedule}}: a template (one of the
--      10 themes in one of the 4 looks) and the words to put on it. The browser builds the design from the template with
--      these words, so a draft can never be a document the 0617 check refuses. A draft changes nothing: the person picks an
--      option and saves it with the ordinary 0617 save command. A draft can only be marked used (APPLIED) or dismissed.
--      Credits come later (E4b): until then this kind is included AI like RANK_CHART.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Design AI draft requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Design AI draft requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.ai_text_begin(text,uuid,text,uuid,integer,jsonb)') IS NULL OR to_regprocedure('hon.shopify_merch_keys_are(jsonb,text[])') IS NULL
    OR to_regprocedure('hon.require_creative_design_actor(text,text)') IS NULL OR to_regprocedure('hon.creative_design_size(text)') IS NULL
    OR to_regprocedure('hon.shopify_review_clip(text,integer)') IS NULL OR to_regprocedure('hon.ai_agent_switch_permission(text)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='ai.agent.marcus.use') OR to_regprocedure('hon.begin_design_draft(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Design AI draft requires migrations through 0550, 0596, 0615, 0617 and 0635 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('DESIGN_DRAFT','marcus','DRAFT_MARKETING',6000,3000,40000,8192,'HUMAN_UI','SCHOOL','DESIGN_DRAFT');

-- One word on a design: at most n characters, trimmed, at most `lines` line breaks and no other control or direction
-- characters (the 0617 text rule), no < or >, and nothing that looks like a secret. Empty only when allowed.
CREATE FUNCTION hon.design_draft_word_ok(v jsonb, n integer, lines integer, may_be_empty boolean) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_typeof(v)='string' AND length(v#>>'{}')<=n AND (v#>>'{}')=btrim(v#>>'{}')
    AND (v#>>'{}' <> '' OR may_be_empty)
    AND (v#>>'{}' = '' OR hon.marketing_safe_text(v#>>'{}',n))
    AND length(v#>>'{}')-length(replace(v#>>'{}',E'\n',''))<=lines
    AND (v#>>'{}') !~ '[\x01-\x09\x0b-\x1f\x7f‎‏‪-‮⁦-⁩﻿<>]'
    AND (v#>>'{}') !~ E'(^|\n)[ \t]|[ \t](\n|$)|\n\n'
$$;

-- What a draft may hold. The contracts validator checks the same shape again.
CREATE FUNCTION hon.design_draft_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.shopify_merch_keys_are(r,ARRAY['options'])
    AND jsonb_typeof(r->'options')='array' AND jsonb_array_length(r->'options') BETWEEN 1 AND 3
    AND octet_length(convert_to(r::text,'UTF8'))<=8192
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'options') o WHERE NOT (
      hon.shopify_merch_keys_are(o,ARRAY['schedule','style','theme','words'])
      AND jsonb_typeof(o->'theme')='string' AND (o->>'theme') IN ('trial','openHouse','camp','promotion','schedule','tournament','referral','afterSchool','birthday','holiday')
      AND jsonb_typeof(o->'style')='string' AND (o->>'style') IN ('bold','clean','fun','elegant')
      AND jsonb_typeof(o->'words')='object' AND hon.shopify_merch_keys_are(o->'words',ARRAY['cta','details','head','kicker','sub'])
      AND hon.design_draft_word_ok(o->'words'->'kicker',60,0,false) AND hon.design_draft_word_ok(o->'words'->'head',40,1,false)
      AND hon.design_draft_word_ok(o->'words'->'sub',140,0,false) AND hon.design_draft_word_ok(o->'words'->'details',160,0,true)
      AND hon.design_draft_word_ok(o->'words'->'cta',80,0,false)
      AND (jsonb_typeof(o->'schedule')='null' OR ((o->>'theme')='schedule' AND jsonb_typeof(o->'schedule')='array'
        AND jsonb_array_length(o->'schedule') BETWEEN 1 AND 6
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o->'schedule') w WHERE NOT (jsonb_typeof(w)='array' AND jsonb_array_length(w)=3
          AND hon.design_draft_word_ok(w->0,30,0,false) AND hon.design_draft_word_ok(w->1,30,0,false) AND hon.design_draft_word_ok(w->2,30,0,false)))))))
$$;
-- {brief: safe text, trimmed, up to 600 characters; size: a 0617 design size; language: en, ko or es (the editor languages)}.
CREATE FUNCTION hon.design_draft_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.shopify_merch_keys_are(p,ARRAY['brief','language','size'])
    AND jsonb_typeof(p->'brief')='string' AND (p->>'brief')=btrim(p->>'brief') AND hon.marketing_safe_text(p->>'brief',600)
    AND jsonb_typeof(p->'size')='string' AND (hon.creative_design_size(p->>'size')).sides IS NOT NULL
    AND jsonb_typeof(p->'language')='string' AND (p->>'language') IN ('en','ko','es')
$$;

-- DD1: the requester. The design rule first (direct human, creative.design.manage at the session school), then Marcus.
CREATE FUNCTION hon.design_draft_ai_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  org := hon.current_organization_id(); school := hon.current_school_id();
  actor := hon.require_creative_design_actor(p_subject,'creative.design.manage');
  IF actor IS NULL OR NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
    OR NOT coalesce(hon.principal_has_school_permission(actor,org,school,'ai.agent.marcus.use'),false)
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier='COMPLETE' AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'DESIGN_DRAFT_AI_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- DD2: what Marcus sees. The school name is cut by bytes (0615 clip), never mid-character.
CREATE FUNCTION hon.design_draft_facts(p_brief jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('brief',p_brief->'brief','size',p_brief->'size','language',p_brief->'language',
    'schoolName',coalesce((SELECT hon.shopify_review_clip(regexp_replace(s.name,'[[:cntrl:]<>]','','g'),120) FROM hon.schools s
      WHERE s.id=hon.current_school_id() AND s.organization_id=hon.current_organization_id()),''))
$$;

CREATE FUNCTION hon.design_draft_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,'mine',i.requested_by=p_actor,
    'draft',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result END,
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='DESIGN_DRAFT' AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_design_draft(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.design_draft_ai_actor(p_subject); pid uuid;
BEGIN
  IF p_key IS NULL OR NOT hon.design_draft_brief_ok(p_input) THEN RAISE EXCEPTION 'DESIGN_DRAFT_INVALID' USING ERRCODE='22023'; END IF;
  pid := hon.ai_text_begin('DESIGN_DRAFT',actor,actor::text||':'||p_key::text,hon.current_school_id(),NULL,p_input);
  RETURN hon.design_draft_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_design_draft(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.design_draft_ai_actor(p_subject);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='DESIGN_DRAFT' AND organization_id=hon.current_organization_id()
    AND school_id=hon.current_school_id()) THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, actor);
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, the core claim, the facts.
CREATE FUNCTION hon.prepare_design_draft(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.design_draft_ai_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'DESIGN_DRAFT' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  RETURN inv || jsonb_build_object('request',hon.design_draft_facts(i.request)::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule): a call in flight when access lapsed still records.
CREATE FUNCTION hon.fail_design_draft(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='DESIGN_DRAFT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}. A proposal outside the closed shape is stored empty and rejected.
CREATE FUNCTION hon.record_design_draft(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='DESIGN_DRAFT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.shopify_merch_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT coalesce(hon.design_draft_ok(proposal),false) THEN
    proposal := jsonb_build_object('options','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a design.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.design_draft_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The school's newest 5 drafts for anyone who may make designs, or one by id.
CREATE FUNCTION hon.read_design_drafts(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_creative_design_actor(p_subject,'creative.design.manage'); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.design_draft_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.design_draft_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='DESIGN_DRAFT' AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
      ORDER BY created_at DESC, id LIMIT 5) x),'[]'::jsonb);
END $$;

-- APPLIED once the requester made a design from the draft, or DISMISSED. The requester only; they must still make designs.
CREATE FUNCTION hon.close_design_draft(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_creative_design_actor(p_subject,'creative.design.manage');
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='DESIGN_DRAFT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.design_draft_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the seven entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.design_draft_word_ok(jsonb,integer,integer,boolean)','hon.design_draft_ok(jsonb)','hon.design_draft_brief_ok(jsonb)',
    'hon.design_draft_ai_actor(text)','hon.design_draft_facts(jsonb)','hon.design_draft_view(uuid,uuid)',
    'hon.begin_design_draft(text,jsonb,uuid)','hon.plan_design_draft(text,uuid)','hon.prepare_design_draft(text,uuid,uuid,boolean)',
    'hon.fail_design_draft(text,uuid,text,text)','hon.record_design_draft(text,uuid,jsonb)','hon.read_design_drafts(text,uuid)',
    'hon.close_design_draft(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_design_draft(text,jsonb,uuid), hon.plan_design_draft(text,uuid),
      hon.prepare_design_draft(text,uuid,uuid,boolean), hon.fail_design_draft(text,uuid,text,text),
      hon.record_design_draft(text,uuid,jsonb), hon.read_design_drafts(text,uuid), hon.close_design_draft(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
