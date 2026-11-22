BEGIN;

-- Marcus marketing performance review, P3 (0641). Spec: docs/architecture/MARCUS_MARKETING_REVIEW.md. Owner request 2026-11-22
-- ("all ai agent backend done and switch them on"): Marcus reads the school's own marketing numbers for the last 30 or 90 days
-- (leads by source and by campaign, how many were won or registered, campaigns and lead forms) and answers with a summary, up to
-- six findings and up to five next steps. Text only: nothing is created, sent, published or spent. A new kind on the shared AI
-- text proposals (0550), built like Alex plans (0639) and reusing its line and key helpers. The 0550 core and S4 are unchanged.
--   M1 Who asks: a direct human with marketing.assistant.use (Marcus, 0212), marketing.campaign.read and ai.invocation.plan at the
--      session school and an active Complete entitlement. The planner enforces the per-staff Marcus switch (0635).
--   M2 Facts: aggregate counts only. Campaign and form names are staff-written and sent as untrusted text. No lead, person,
--      family, student, contact or payment row, and no staff name, is sent.
--   M3 Who reads: the requester only (a review holds the requester's own question).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Marcus marketing review requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Marcus marketing review requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.alex_plan_line_ok(text,integer)') IS NULL OR to_regprocedure('hon.begin_jordan_follow_up(text,jsonb,uuid)') IS NULL
    OR to_regclass('hon.crm_lead_attributions') IS NULL OR to_regclass('hon.public_lead_form_receipts') IS NULL
    OR to_regprocedure('hon.begin_marcus_review(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Marcus marketing review requires migrations 0639 and 0640 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('MARCUS_MARKETING_REVIEW','marcus','DRAFT_MARKETING',12000,3000,80000,12288,'HUMAN_UI','SCHOOL','MARKETING');

-- {period: LAST_30_DAYS | LAST_90_DAYS, question: '' or 1..300}.
CREATE FUNCTION hon.marcus_review_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(p,ARRAY['period','question'])
    AND jsonb_typeof(p->'period')='string' AND (p->>'period') IN ('LAST_30_DAYS','LAST_90_DAYS')
    AND jsonb_typeof(p->'question')='string' AND ((p->>'question')='' OR hon.alex_plan_line_ok(p->>'question',300))
$$;

-- {summary ≤400, findings 1..6 {title ≤120, detail ≤400}, nextSteps 1..5 {title ≤120, detail ≤400, area marcus|chad|lena|null}}.
CREATE FUNCTION hon.marcus_review_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(r,ARRAY['findings','nextSteps','summary'])
    AND jsonb_typeof(r->'summary')='string' AND hon.alex_plan_line_ok(r->>'summary',400)
    AND jsonb_typeof(r->'findings')='array' AND jsonb_array_length(r->'findings') BETWEEN 1 AND 6
    AND jsonb_typeof(r->'nextSteps')='array' AND jsonb_array_length(r->'nextSteps') BETWEEN 1 AND 5
    AND octet_length(convert_to(r::text,'UTF8'))<=12288
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'findings') t WHERE NOT (
      hon.alex_plan_keys_are(t,ARRAY['detail','title'])
      AND jsonb_typeof(t->'title')='string' AND hon.alex_plan_line_ok(t->>'title',120)
      AND jsonb_typeof(t->'detail')='string' AND hon.alex_plan_line_ok(t->>'detail',400)))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'nextSteps') t WHERE NOT (
      hon.alex_plan_keys_are(t,ARRAY['area','detail','title'])
      AND jsonb_typeof(t->'title')='string' AND hon.alex_plan_line_ok(t->>'title',120)
      AND jsonb_typeof(t->'detail')='string' AND hon.alex_plan_line_ok(t->>'detail',400)
      AND (jsonb_typeof(t->'area')='null' OR (jsonb_typeof(t->'area')='string' AND (t->>'area') IN ('marcus','chad','lena')))))
$$;

-- The requester for a command: Marcus's capability, campaign reading and AI planning at the session school, and Complete.
CREATE FUNCTION hon.marcus_review_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  IF current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI' OR coalesce(current_setting('app.hon_action_request_id',true),'')<>''
    OR coalesce(current_setting('app.hon_delegated_by_principal_id',true),'')<>'' OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN
    RAISE EXCEPTION 'MARCUS_REVIEW_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  org := hon.current_organization_id(); school := hon.current_school_id();
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    WHERE u.external_subject=p_subject;
  IF actor IS NULL OR NOT hon.principal_has_school_permission(actor,org,school,'marketing.assistant.use')
    OR NOT hon.principal_has_school_permission(actor,org,school,'marketing.campaign.read')
    OR NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier='COMPLETE' AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'MARCUS_REVIEW_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- A reader: campaign reading at the session school; the read itself returns only the reader's own reviews.
CREATE FUNCTION hon.marcus_review_reader(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    WHERE u.external_subject=p_subject;
  IF actor IS NULL OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),'marketing.campaign.read') THEN
    RAISE EXCEPTION 'MARCUS_REVIEW_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- The facts Marcus sees: aggregate counts for the window, at most 12 sources, 12 campaigns (active or paused, or archived and
-- running inside the window; never a draft) and 10 forms that are not drafts (about 8 KB at most).
CREATE FUNCTION hon.marcus_review_facts(p_brief jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH w AS (
    SELECT s.id school, s.organization_id org, left(s.name,120) school_name, clock_timestamp() now_,
      clock_timestamp() - make_interval(days => CASE WHEN p_brief->>'period'='LAST_90_DAYS' THEN 90 ELSE 30 END) since
    FROM hon.schools s WHERE s.id=hon.current_school_id() AND s.organization_id=hon.current_organization_id()
  ), leads AS (
    SELECT l.id, l.status, coalesce(nullif(left(coalesce(a.source_code,l.source_code),40),''),'UNKNOWN') source, a.campaign_id,
      EXISTS(SELECT 1 FROM hon.crm_lead_registration_conversions c WHERE c.source_lead_id=l.id) registered
    FROM w JOIN hon.crm_leads l ON l.organization_id=w.org AND l.school_id=w.school AND l.created_at>=w.since
    LEFT JOIN hon.crm_lead_attributions a ON a.lead_id=l.id AND a.organization_id=l.organization_id AND a.school_id=l.school_id
  ), camp AS (
    SELECT c.id, c.code, c.name, c.channel, c.status, c.starts_at, c.ends_at, c.planned_budget_minor, c.currency
    FROM w JOIN hon.marketing_campaigns c ON c.organization_id=w.org AND c.school_id=w.school
    WHERE c.status IN ('ACTIVE','PAUSED') OR (c.status='ARCHIVED' AND c.ends_at>=w.since AND c.starts_at<=w.now_)
    ORDER BY (c.status='ACTIVE') DESC, c.ends_at DESC, c.id LIMIT 12
  )
  SELECT jsonb_build_object('brief',p_brief,'schoolName',w.school_name,'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'windowDays',CASE WHEN p_brief->>'period'='LAST_90_DAYS' THEN 90 ELSE 30 END,
    'leads',jsonb_build_object('total',(SELECT count(*) FROM leads),'open',(SELECT count(*) FROM leads WHERE status='OPEN'),
      'won',(SELECT count(*) FROM leads WHERE status='WON'),'lost',(SELECT count(*) FROM leads WHERE status='LOST'),
      'registered',(SELECT count(*) FROM leads WHERE registered)),
    'bySource',coalesce((SELECT jsonb_agg(jsonb_build_object('source',x.source,'leads',x.n,'won',x.won,'registered',x.reg) ORDER BY x.n DESC, x.source)
      FROM (SELECT source, count(*) n, count(*) FILTER (WHERE status='WON') won, count(*) FILTER (WHERE registered) reg FROM leads GROUP BY source ORDER BY count(*) DESC, source LIMIT 12) x),'[]'::jsonb),
    'campaigns',coalesce((SELECT jsonb_agg(jsonb_build_object('code',left(c.code,40),'name',left(c.name,80),'channel',left(c.channel,40),'status',c.status,
        'startedDaysAgo',(w.now_::date - c.starts_at::date),'endsInDays',(c.ends_at::date - w.now_::date),
        'plannedBudget',round(c.planned_budget_minor/100.0,2),'currency',c.currency,
        'leads',(SELECT count(*) FROM leads l WHERE l.campaign_id=c.id),'won',(SELECT count(*) FROM leads l WHERE l.campaign_id=c.id AND l.status='WON'),
        'registered',(SELECT count(*) FROM leads l WHERE l.campaign_id=c.id AND l.registered)) ORDER BY (c.status='ACTIVE') DESC, c.ends_at DESC, c.id)
      FROM camp c),'[]'::jsonb),
    'forms',coalesce((SELECT jsonb_agg(jsonb_build_object('name',left(f.title,80),'status',f.status,
        'leads',(SELECT count(*) FROM hon.public_lead_form_receipts r JOIN leads l ON l.id=r.lead_id WHERE r.form_id=f.id),'allTimeLeads',f.accepted_count) ORDER BY f.status, f.created_at, f.id)
      FROM (SELECT * FROM hon.public_lead_forms f WHERE f.organization_id=w.org AND f.school_id=w.school AND f.status<>'DRAFT' ORDER BY f.status, f.created_at, f.id LIMIT 10) f),'[]'::jsonb))
  FROM w
$$;

CREATE FUNCTION hon.marcus_review_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,
    'summary',CASE WHEN i.status='RESULT_RECORDED' THEN i.result->>'summary' END,
    'findings',CASE WHEN i.status='RESULT_RECORDED' THEN i.result->'findings' END,
    'nextSteps',CASE WHEN i.status='RESULT_RECORDED' THEN i.result->'nextSteps' END,
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='MARCUS_MARKETING_REVIEW' AND i.requested_by=p_actor
    AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_marcus_review(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.marcus_review_actor(p_subject); pid uuid;
BEGIN
  IF p_key IS NULL OR NOT hon.marcus_review_brief_ok(p_input) THEN RAISE EXCEPTION 'MARCUS_REVIEW_INVALID' USING ERRCODE='22023'; END IF;
  pid := hon.ai_text_begin('MARCUS_MARKETING_REVIEW',actor,actor::text||':'||p_key::text,hon.current_school_id(),NULL,p_input);
  RETURN hon.marcus_review_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_marcus_review(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MARCUS_MARKETING_REVIEW') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, hon.marcus_review_actor(p_subject));
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, the core claim, then the facts.
CREATE FUNCTION hon.prepare_marcus_review(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.marcus_review_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'MARCUS_MARKETING_REVIEW' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  RETURN inv || jsonb_build_object('request',hon.marcus_review_facts(i.request)::text);
END $$;

CREATE FUNCTION hon.fail_marcus_review(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MARCUS_MARKETING_REVIEW') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

CREATE FUNCTION hon.record_marcus_review(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MARCUS_MARKETING_REVIEW') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.alex_plan_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.marcus_review_ok(proposal) THEN
    proposal := jsonb_build_object('summary','','findings','[]'::jsonb,'nextSteps','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a marketing review.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.marcus_review_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The reader's own newest 20 reviews, or one of them by id.
CREATE FUNCTION hon.read_marcus_reviews(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.marcus_review_reader(p_subject); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.marcus_review_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.marcus_review_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='MARCUS_MARKETING_REVIEW' AND requested_by=actor
      AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY created_at DESC, id LIMIT 20) x),'[]'::jsonb);
END $$;

-- DISMISSED. The requester only.
CREATE FUNCTION hon.close_marcus_review(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.marcus_review_reader(p_subject);
BEGIN
  IF p_status IS DISTINCT FROM 'DISMISSED' THEN RAISE EXCEPTION 'MARCUS_REVIEW_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MARCUS_MARKETING_REVIEW') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.marcus_review_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the seven entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.marcus_review_brief_ok(jsonb)','hon.marcus_review_ok(jsonb)','hon.marcus_review_actor(text)','hon.marcus_review_reader(text)',
    'hon.marcus_review_facts(jsonb)','hon.marcus_review_view(uuid,uuid)','hon.begin_marcus_review(text,jsonb,uuid)','hon.plan_marcus_review(text,uuid)',
    'hon.prepare_marcus_review(text,uuid,uuid,boolean)','hon.fail_marcus_review(text,uuid,text,text)','hon.record_marcus_review(text,uuid,jsonb)',
    'hon.read_marcus_reviews(text,uuid)','hon.close_marcus_review(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_marcus_review(text,jsonb,uuid), hon.plan_marcus_review(text,uuid), hon.prepare_marcus_review(text,uuid,uuid,boolean),
      hon.fail_marcus_review(text,uuid,text,text), hon.record_marcus_review(text,uuid,jsonb), hon.read_marcus_reviews(text,uuid),
      hon.close_marcus_review(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
