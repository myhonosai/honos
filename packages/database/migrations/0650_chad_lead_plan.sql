BEGIN;

-- Chad lead next steps, P9 (0650). Spec: docs/architecture/CHAD_LEAD_PLAN.md. Owner request 2026-11-22 ("all ai agent backend
-- done and switch them on"), with the plan's rule for Chad: Chad proposes a booking or a lead change, a person approves it and
-- the existing human command runs it. Chad reads this school's open leads and suggests, for up to ten of them, either a move to
-- another stage of the lead's own pipeline or a trial in one of the school's next classes. Nothing changes from a suggestion. A
-- staff member presses one suggestion; the web then runs the ordinary human command (crm.lead.stage.move, 0417, or the trial
-- scheduling command, crm.trial.schedule) as that person, with that command's own permission, version and idempotency checks,
-- and HON records which record it produced. A new kind on the shared AI text proposals (0550), reusing the 0639 helpers.
--   R1 Who asks or reads: a direct human with Chad's follow-up assistant authority (0107: Complete, crm.lead.read,
--      crm.assistant.follow_up_draft, ai.invocation.plan at the session school). Lists are the requester's own.
--   R2 Facts: the brief, the school name, the local date, up to 15 open leads as L1.. (stage alias, days since created and
--      updated, days to the next follow-up, program interest and source codes, trial counts), their pipelines' open stages as S1..
--      (school-written stage names) and up to 20 scheduled classes in the next 14 days as C1.. (class name, local day and time,
--      length). No name, email, phone, note, attribution or amount is sent.
--   R3 Answer: {summary, suggestions[1..10]}, one per lead: MOVE_STAGE to an open stage of that lead's pipeline other than its
--      current one, or BOOK_TRIAL in a class, for a lead with no upcoming trial; checked here and by the contracts validator.
--   R4 Record: after the human command succeeded, the requester records the step; HON checks the lead is now at that stage by
--      the requester's own audited move, or that the requester's own trial appointment for that lead at that class time exists,
--      both made after the suggestion was written. The list closes APPLIED once every suggestion is recorded.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Chad lead next steps require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Chad lead next steps require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.alex_plan_line_ok(text,integer)') IS NULL OR to_regprocedure('hon.require_chad_follow_up_actor(text)') IS NULL
    OR to_regprocedure('hon.move_crm_lead_stage(text,uuid,jsonb,text,uuid,uuid)') IS NULL OR to_regprocedure('hon.begin_maya_check_in_draft(text,jsonb,uuid)') IS NULL
    OR to_regprocedure('hon.begin_chad_lead_plan(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Chad lead next steps require migrations 0107, 0417, 0639 and 0649 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('CHAD_LEAD_PLAN','chad','DRAFT_FOLLOW_UP',10000,2500,80000,12288,'HUMAN_UI','SCHOOL','CHAD_FOLLOW_UP');

-- What Chad saw, fixed when the facts were built: L<n> a lead at the version read, S<n> a stage, C<n> a class.
CREATE TABLE hon.chad_lead_plan_refs (
  proposal_id uuid NOT NULL REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^(L([1-9]|1[0-5])|S([1-9]|[1-3][0-9]|40)|C([1-9]|1[0-9]|20))$'),
  lead_id uuid REFERENCES hon.crm_leads(id) ON DELETE RESTRICT,
  lead_version integer CHECK (lead_version BETWEEN 1 AND 999999999),
  stage_id uuid REFERENCES hon.crm_pipeline_stages(id) ON DELETE RESTRICT,
  class_session_id uuid REFERENCES hon.class_sessions(id) ON DELETE RESTRICT,
  PRIMARY KEY (proposal_id, ref),
  CHECK (CASE left(ref,1)
    WHEN 'L' THEN lead_id IS NOT NULL AND lead_version IS NOT NULL AND stage_id IS NOT NULL AND class_session_id IS NULL
    WHEN 'S' THEN lead_id IS NULL AND lead_version IS NULL AND stage_id IS NOT NULL AND class_session_id IS NULL
    ELSE lead_id IS NULL AND lead_version IS NULL AND stage_id IS NULL AND class_session_id IS NOT NULL END)
);
-- What the requester's own human command produced for a suggestion: the lead (a stage move) or the trial appointment.
CREATE TABLE hon.chad_lead_plan_applied (
  proposal_id uuid NOT NULL REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  suggestion_index integer NOT NULL CHECK (suggestion_index BETWEEN 0 AND 9),
  action text NOT NULL CHECK (action IN ('MOVE_STAGE','BOOK_TRIAL')),
  lead_id uuid NOT NULL REFERENCES hon.crm_leads(id) ON DELETE RESTRICT,
  appointment_id uuid REFERENCES hon.crm_appointments(id) ON DELETE RESTRICT,
  applied_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (proposal_id, suggestion_index),
  CHECK ((action='BOOK_TRIAL') = (appointment_id IS NOT NULL))
);
CREATE UNIQUE INDEX chad_lead_plan_applied_appointment ON hon.chad_lead_plan_applied(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE TRIGGER chad_lead_plan_refs_guard BEFORE UPDATE OR DELETE ON hon.chad_lead_plan_refs FOR EACH ROW EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER chad_lead_plan_refs_no_truncate BEFORE TRUNCATE ON hon.chad_lead_plan_refs FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER chad_lead_plan_applied_guard BEFORE UPDATE OR DELETE ON hon.chad_lead_plan_applied FOR EACH ROW EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER chad_lead_plan_applied_no_truncate BEFORE TRUNCATE ON hon.chad_lead_plan_applied FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_alex_plan_rows();
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.chad_lead_plan_refs','hon.chad_lead_plan_applied'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- {focus: ALL_OPEN | NO_TRIAL_YET, note: 0..300 (empty allowed)}.
CREATE FUNCTION hon.chad_lead_plan_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(p,ARRAY['focus','note'])
    AND jsonb_typeof(p->'focus')='string' AND (p->>'focus') IN ('ALL_OPEN','NO_TRIAL_YET')
    AND jsonb_typeof(p->'note')='string' AND ((p->>'note')='' OR hon.alex_plan_line_ok(p->>'note',300))
$$;

-- The closed answer shape: one suggestion per lead, MOVE_STAGE with a stage alias or BOOK_TRIAL with a class alias, and why.
CREATE FUNCTION hon.chad_lead_plan_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(r,ARRAY['suggestions','summary'])
    AND jsonb_typeof(r->'summary')='string' AND hon.alex_plan_line_ok(r->>'summary',300)
    AND jsonb_typeof(r->'suggestions')='array' AND jsonb_array_length(r->'suggestions') BETWEEN 1 AND 10 AND octet_length(convert_to(r::text,'UTF8'))<=12288
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'suggestions') t WHERE NOT (
      hon.alex_plan_keys_are(t,ARRAY['action','lead','reason','slot','stage'])
      AND jsonb_typeof(t->'lead')='string' AND (t->>'lead') ~ '^L([1-9]|1[0-5])$'
      AND jsonb_typeof(t->'reason')='string' AND hon.alex_plan_line_ok(t->>'reason',300)
      AND ((t->>'action'='MOVE_STAGE' AND jsonb_typeof(t->'stage')='string' AND (t->>'stage') ~ '^S([1-9]|[1-3][0-9]|40)$' AND jsonb_typeof(t->'slot')='null')
        OR (t->>'action'='BOOK_TRIAL' AND jsonb_typeof(t->'slot')='string' AND (t->>'slot') ~ '^C([1-9]|1[0-9]|20)$' AND jsonb_typeof(t->'stage')='null'))))
    AND (SELECT count(DISTINCT t->>'lead') FROM jsonb_array_elements(r->'suggestions') t)=jsonb_array_length(r->'suggestions')
$$;

-- An upcoming trial for a lead: a SCHEDULED TRIAL appointment that has not started.
CREATE FUNCTION hon.chad_lead_plan_trial_ahead(p_lead uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT EXISTS(SELECT 1 FROM hon.crm_appointments a WHERE a.crm_lead_id=p_lead AND a.organization_id=hon.current_organization_id()
    AND a.school_id=hon.current_school_id() AND a.appointment_type='TRIAL' AND a.status='SCHEDULED' AND a.starts_at>clock_timestamp())
$$;

-- Fix the aliases (once): up to 15 OPEN leads (next follow-up soonest, then newest), the open stages of their pipelines, and
-- up to 20 SCHEDULED classes starting between two hours and 14 days from now.
CREATE FUNCTION hon.chad_lead_plan_fix_refs(p_id uuid, p_focus text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
BEGIN
  IF EXISTS(SELECT 1 FROM hon.chad_lead_plan_refs WHERE proposal_id=p_id) THEN RETURN; END IF;
  INSERT INTO hon.chad_lead_plan_refs(proposal_id,organization_id,school_id,ref,lead_id,lead_version,stage_id)
    SELECT p_id, org, school, 'L'||row_number() OVER (ORDER BY x.next_follow_up_at NULLS LAST, x.created_at DESC, x.id), x.id, x.version, x.pipeline_stage_id
    FROM (SELECT l.id, l.version, l.pipeline_stage_id, l.next_follow_up_at, l.created_at FROM hon.crm_leads l
          WHERE l.organization_id=org AND l.school_id=school AND l.status='OPEN'
            AND (p_focus<>'NO_TRIAL_YET' OR NOT EXISTS(SELECT 1 FROM hon.crm_appointments a WHERE a.crm_lead_id=l.id AND a.organization_id=org AND a.school_id=school AND a.appointment_type='TRIAL'))
          ORDER BY l.next_follow_up_at NULLS LAST, l.created_at DESC, l.id LIMIT 15) x;
  INSERT INTO hon.chad_lead_plan_refs(proposal_id,organization_id,school_id,ref,stage_id)
    SELECT p_id, org, school, 'S'||row_number() OVER (ORDER BY y.pipeline_id, y.position, y.id), y.id
    FROM (SELECT s.id, s.pipeline_id, s.position FROM hon.crm_pipeline_stages s
          WHERE s.organization_id=org AND s.school_id=school AND s.terminal_status IS NULL AND s.hidden_at IS NULL
            AND s.pipeline_id IN (SELECT l.pipeline_id FROM hon.chad_lead_plan_refs r JOIN hon.crm_leads l ON l.id=r.lead_id WHERE r.proposal_id=p_id)
          ORDER BY s.pipeline_id, s.position, s.id LIMIT 40) y;
  INSERT INTO hon.chad_lead_plan_refs(proposal_id,organization_id,school_id,ref,class_session_id)
    SELECT p_id, org, school, 'C'||row_number() OVER (ORDER BY z.starts_at, z.id), z.id
    FROM (SELECT c.id, c.starts_at FROM hon.class_sessions c
          WHERE c.organization_id=org AND c.school_id=school AND c.status='SCHEDULED'
            AND c.starts_at>=clock_timestamp()+interval '2 hours' AND c.starts_at<clock_timestamp()+interval '14 days' AND c.ends_at>c.starts_at
          ORDER BY c.starts_at, c.id LIMIT 20) z;
END $$;

-- The facts Chad sees. Record-derived numbers, codes and school-written stage and class names only.
CREATE FUNCTION hon.chad_lead_plan_facts(p_id uuid, p_brief jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('brief',p_brief,'schoolName',left(s.name,120),'localToday',to_char((clock_timestamp() AT TIME ZONE s.timezone)::date,'YYYY-MM-DD'),
    'leads',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,
        'stage',(SELECT x.ref FROM hon.chad_lead_plan_refs x WHERE x.proposal_id=r.proposal_id AND left(x.ref,1)='S' AND x.stage_id=r.stage_id),
        'daysSinceCreated',floor(extract(epoch FROM clock_timestamp()-l.created_at)/86400)::integer,
        'daysSinceUpdated',floor(extract(epoch FROM clock_timestamp()-l.updated_at)/86400)::integer,
        'nextFollowUpInDays',CASE WHEN l.next_follow_up_at IS NULL THEN NULL ELSE floor(extract(epoch FROM l.next_follow_up_at-clock_timestamp())/86400)::integer END,
        'programInterestCode',CASE WHEN l.program_interest_code ~ '^[A-Z0-9_]{1,40}$' THEN l.program_interest_code END,
        'sourceCode',CASE WHEN l.source_code ~ '^[A-Z0-9_]{1,40}$' THEN l.source_code END,
        'upcomingTrial',hon.chad_lead_plan_trial_ahead(l.id),
        'pastTrials',(SELECT count(*)::integer FROM hon.crm_appointments a WHERE a.crm_lead_id=l.id AND a.organization_id=l.organization_id AND a.school_id=l.school_id
          AND a.appointment_type='TRIAL' AND a.starts_at<=clock_timestamp()),
        'noShows',(SELECT count(*)::integer FROM hon.crm_appointments a WHERE a.crm_lead_id=l.id AND a.organization_id=l.organization_id AND a.school_id=l.school_id
          AND a.appointment_type='TRIAL' AND a.status='NO_SHOW')) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.chad_lead_plan_refs r JOIN hon.crm_leads l ON l.id=r.lead_id WHERE r.proposal_id=p_id AND left(r.ref,1)='L'),'[]'::jsonb),
    'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'name',left(st.name,60),'order',st.position,
        'pipeline','P'||(SELECT count(DISTINCT st2.pipeline_id) FROM hon.chad_lead_plan_refs r2 JOIN hon.crm_pipeline_stages st2 ON st2.id=r2.stage_id
          WHERE r2.proposal_id=p_id AND left(r2.ref,1)='S' AND st2.pipeline_id<=st.pipeline_id)) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.chad_lead_plan_refs r JOIN hon.crm_pipeline_stages st ON st.id=r.stage_id WHERE r.proposal_id=p_id AND left(r.ref,1)='S'),'[]'::jsonb),
    'leadPipelines',coalesce((SELECT jsonb_object_agg(r.ref,'P'||(SELECT count(DISTINCT st2.pipeline_id) FROM hon.chad_lead_plan_refs r2 JOIN hon.crm_pipeline_stages st2 ON st2.id=r2.stage_id
          WHERE r2.proposal_id=p_id AND left(r2.ref,1)='S' AND st2.pipeline_id<=l.pipeline_id))
      FROM hon.chad_lead_plan_refs r JOIN hon.crm_leads l ON l.id=r.lead_id WHERE r.proposal_id=p_id AND left(r.ref,1)='L'),'{}'::jsonb),
    'classes',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'name',left(c.name,80),
        'day',to_char(c.starts_at AT TIME ZONE s.timezone,'FMDay'),'date',to_char((c.starts_at AT TIME ZONE s.timezone)::date,'YYYY-MM-DD'),
        'time',to_char(c.starts_at AT TIME ZONE s.timezone,'HH24:MI'),'minutes',floor(extract(epoch FROM c.ends_at-c.starts_at)/60)::integer) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.chad_lead_plan_refs r JOIN hon.class_sessions c ON c.id=r.class_session_id WHERE r.proposal_id=p_id AND left(r.ref,1)='C'),'[]'::jsonb))
  FROM hon.schools s WHERE s.id=hon.current_school_id() AND s.organization_id=hon.current_organization_id()
$$;

-- Does every alias in a shaped answer fit what Chad was shown?
CREATE FUNCTION hon.chad_lead_plan_fits(p_id uuid, r jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'suggestions') t WHERE NOT EXISTS(
    SELECT 1 FROM hon.chad_lead_plan_refs lr JOIN hon.crm_leads l ON l.id=lr.lead_id
    WHERE lr.proposal_id=p_id AND lr.ref=t->>'lead' AND CASE t->>'action'
      WHEN 'MOVE_STAGE' THEN EXISTS(SELECT 1 FROM hon.chad_lead_plan_refs sr JOIN hon.crm_pipeline_stages st ON st.id=sr.stage_id
        WHERE sr.proposal_id=p_id AND sr.ref=t->>'stage' AND st.pipeline_id=l.pipeline_id AND st.id<>lr.stage_id)
      ELSE EXISTS(SELECT 1 FROM hon.chad_lead_plan_refs cr WHERE cr.proposal_id=p_id AND cr.ref=t->>'slot')
        AND NOT hon.chad_lead_plan_trial_ahead(l.id) END))
$$;

-- The requester's view: lead names, versions and the concrete stage and class are shown to the requester (who can read
-- leads), never sent to Chad. The web uses them to run the ordinary human command.
CREATE FUNCTION hon.chad_lead_plan_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,
    'summary',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'summary' END,
    'suggestions',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->'suggestions' END,
    'leads',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'leadId',r.lead_id,'leadVersion',r.lead_version,
        'name',left(btrim(coalesce(pp.given_name,'')||' '||coalesce(pp.family_name,'')),120)) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.chad_lead_plan_refs r JOIN hon.crm_leads l ON l.id=r.lead_id JOIN hon.people pp ON pp.id=l.primary_person_id
      WHERE r.proposal_id=i.id AND left(r.ref,1)='L'),'[]'::jsonb),
    'stages',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'stageId',r.stage_id,'name',left(st.name,60)) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.chad_lead_plan_refs r JOIN hon.crm_pipeline_stages st ON st.id=r.stage_id WHERE r.proposal_id=i.id AND left(r.ref,1)='S'),'[]'::jsonb),
    'classes',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'classSessionId',r.class_session_id,'name',left(c.name,80),
        'startsAt',to_char(c.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'endsAt',to_char(c.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.chad_lead_plan_refs r JOIN hon.class_sessions c ON c.id=r.class_session_id WHERE r.proposal_id=i.id AND left(r.ref,1)='C'),'[]'::jsonb),
    'applied',coalesce((SELECT jsonb_agg(jsonb_build_object('index',c.suggestion_index,'action',c.action,'leadId',c.lead_id,'appointmentId',c.appointment_id)
        ORDER BY c.suggestion_index) FROM hon.chad_lead_plan_applied c WHERE c.proposal_id=i.id),'[]'::jsonb),
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='CHAD_LEAD_PLAN' AND i.requested_by=p_actor
    AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_chad_lead_plan(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_chad_follow_up_actor(p_subject); pid uuid;
BEGIN
  IF p_key IS NULL OR NOT hon.chad_lead_plan_brief_ok(p_input) THEN RAISE EXCEPTION 'CHAD_LEAD_PLAN_INVALID' USING ERRCODE='22023'; END IF;
  pid := hon.ai_text_begin('CHAD_LEAD_PLAN',actor,actor::text||':'||p_key::text,hon.current_school_id(),NULL,p_input);
  RETURN hon.chad_lead_plan_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_chad_lead_plan(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CHAD_LEAD_PLAN') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, hon.require_chad_follow_up_actor(p_subject));
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, the core claim, then the facts.
CREATE FUNCTION hon.prepare_chad_lead_plan(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.require_chad_follow_up_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'CHAD_LEAD_PLAN' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  PERFORM hon.chad_lead_plan_fix_refs(p_id, i.request->>'focus');
  RETURN inv || jsonb_build_object('request',hon.chad_lead_plan_facts(p_id,i.request)::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule).
CREATE FUNCTION hon.fail_chad_lead_plan(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CHAD_LEAD_PLAN') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}. A proposal outside the closed shape, or naming an alias that does not fit what Chad
-- was shown (an unknown lead, a stage of another pipeline or its current stage, a trial for a lead with one ahead), is stored
-- empty and rejected.
CREATE FUNCTION hon.record_chad_lead_plan(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CHAD_LEAD_PLAN') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.alex_plan_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.chad_lead_plan_ok(proposal) OR NOT hon.chad_lead_plan_fits(p_id, proposal) THEN
    proposal := jsonb_build_object('summary','','suggestions','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a list of next steps for these leads.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.chad_lead_plan_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The requester's newest 20 lists, or one by id.
CREATE FUNCTION hon.read_chad_lead_plans(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_chad_follow_up_actor(p_subject); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.chad_lead_plan_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.chad_lead_plan_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='CHAD_LEAD_PLAN' AND requested_by=actor
      AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY created_at DESC, id LIMIT 20) x),'[]'::jsonb);
END $$;

-- Record what the requester's own human command produced for one suggestion. p = {appointmentId: uuid | null}.
-- MOVE_STAGE: the lead is now at the suggested stage, moved by the requester's own audited crm.lead.stage.move after Chad wrote
-- the list. BOOK_TRIAL: the requester's own TRIAL appointment for that lead at exactly that class's start and end, made after
-- Chad wrote the list and not linked to another suggestion. An exact repeat replays. Once every suggestion is recorded the list
-- closes APPLIED.
CREATE FUNCTION hon.record_chad_lead_plan_step(p_subject text, p_id uuid, p_index integer, p jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_chad_follow_up_actor(p_subject); i hon.ai_text_proposals%ROWTYPE; t jsonb; lr hon.chad_lead_plan_refs%ROWTYPE;
  target uuid; slot hon.class_sessions%ROWTYPE; appt uuid; prior hon.chad_lead_plan_applied%ROWTYPE; l hon.crm_leads%ROWTYPE;
BEGIN
  IF p_index IS NULL OR p_index NOT BETWEEN 0 AND 9 OR NOT hon.alex_plan_keys_are(p,ARRAY['appointmentId'])
    OR NOT (jsonb_typeof(p->'appointmentId')='null' OR (jsonb_typeof(p->'appointmentId')='string'
      AND (p->>'appointmentId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'CHAD_LEAD_PLAN_INVALID' USING ERRCODE='22023';
  END IF;
  appt := nullif(p->>'appointmentId','')::uuid;
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'CHAD_LEAD_PLAN' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO prior FROM hon.chad_lead_plan_applied WHERE proposal_id=i.id AND suggestion_index=p_index;
  IF FOUND THEN
    IF prior.appointment_id IS NOT DISTINCT FROM appt THEN RETURN hon.chad_lead_plan_view(i.id, actor) || jsonb_build_object('replayed',true); END IF;
    RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001';
  END IF;
  IF i.status<>'RESULT_RECORDED' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001'; END IF;
  IF p_index>=jsonb_array_length(i.result->'suggestions') THEN RAISE EXCEPTION 'CHAD_LEAD_PLAN_INVALID' USING ERRCODE='22023'; END IF;
  t := i.result->'suggestions'->p_index;
  SELECT * INTO STRICT lr FROM hon.chad_lead_plan_refs r WHERE r.proposal_id=i.id AND r.ref=t->>'lead';
  SELECT * INTO l FROM hon.crm_leads x WHERE x.id=lr.lead_id AND x.organization_id=i.organization_id AND x.school_id=i.school_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHAD_LEAD_PLAN_NOT_DONE' USING ERRCODE='P0002'; END IF;
  IF t->>'action'='MOVE_STAGE' THEN
    IF appt IS NOT NULL THEN RAISE EXCEPTION 'CHAD_LEAD_PLAN_INVALID' USING ERRCODE='22023'; END IF;
    SELECT r.stage_id INTO STRICT target FROM hon.chad_lead_plan_refs r WHERE r.proposal_id=i.id AND r.ref=t->>'stage';
    IF l.pipeline_stage_id<>target OR NOT EXISTS(SELECT 1 FROM hon.audit_events e WHERE e.organization_id=i.organization_id AND e.school_id=i.school_id
        AND e.action_code='crm.lead.stage.move' AND e.entity_type='CRM_LEAD' AND e.entity_id=l.id AND e.actor_principal_id=actor
        AND e.result='SUCCEEDED' AND e.next_state->>'stageId'=target::text AND e.occurred_at>=i.created_at) THEN
      RAISE EXCEPTION 'CHAD_LEAD_PLAN_NOT_DONE' USING ERRCODE='P0002';
    END IF;
  ELSE
    IF appt IS NULL THEN RAISE EXCEPTION 'CHAD_LEAD_PLAN_INVALID' USING ERRCODE='22023'; END IF;
    SELECT c.* INTO STRICT slot FROM hon.chad_lead_plan_refs r JOIN hon.class_sessions c ON c.id=r.class_session_id WHERE r.proposal_id=i.id AND r.ref=t->>'slot';
    IF NOT EXISTS(SELECT 1 FROM hon.crm_appointments a WHERE a.id=appt AND a.organization_id=i.organization_id AND a.school_id=i.school_id
        AND a.crm_lead_id=l.id AND a.appointment_type='TRIAL' AND a.created_by_principal_id=actor AND a.created_at>=i.created_at
        AND date_trunc('milliseconds',a.starts_at)=date_trunc('milliseconds',slot.starts_at) AND date_trunc('milliseconds',a.ends_at)=date_trunc('milliseconds',slot.ends_at))
      OR EXISTS(SELECT 1 FROM hon.chad_lead_plan_applied c WHERE c.appointment_id=appt) THEN
      RAISE EXCEPTION 'CHAD_LEAD_PLAN_NOT_DONE' USING ERRCODE='P0002';
    END IF;
  END IF;
  INSERT INTO hon.chad_lead_plan_applied(proposal_id,organization_id,school_id,suggestion_index,action,lead_id,appointment_id,applied_by)
    VALUES(i.id,i.organization_id,i.school_id,p_index,t->>'action',l.id,appt,actor);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(i.organization_id,i.school_id,actor,'HUMAN_UI','chad.lead_plan.step_recorded','CHAD_LEAD_PLAN',i.id,
      jsonb_build_object('index',p_index,'action',t->>'action','leadId',l.id,'appointmentId',appt),'SUCCEEDED',
      coalesce(nullif(current_setting('app.hon_request_id',true),'')::uuid,gen_random_uuid()),coalesce(nullif(current_setting('app.hon_request_id',true),'')::uuid,gen_random_uuid()));
  IF (SELECT count(*) FROM hon.chad_lead_plan_applied WHERE proposal_id=i.id)=jsonb_array_length(i.result->'suggestions') THEN
    PERFORM hon.ai_text_close(i.id, actor, 'APPLIED');
  END IF;
  RETURN hon.chad_lead_plan_view(i.id, actor) || jsonb_build_object('replayed',false);
END $$;

-- DISMISSED (the rest of the list). The requester only.
CREATE FUNCTION hon.close_chad_lead_plan(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_chad_follow_up_actor(p_subject);
BEGIN
  IF p_status IS DISTINCT FROM 'DISMISSED' THEN RAISE EXCEPTION 'CHAD_LEAD_PLAN_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CHAD_LEAD_PLAN') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.chad_lead_plan_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the eight entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.chad_lead_plan_brief_ok(jsonb)','hon.chad_lead_plan_ok(jsonb)','hon.chad_lead_plan_trial_ahead(uuid)',
    'hon.chad_lead_plan_fix_refs(uuid,text)','hon.chad_lead_plan_facts(uuid,jsonb)','hon.chad_lead_plan_fits(uuid,jsonb)','hon.chad_lead_plan_view(uuid,uuid)',
    'hon.begin_chad_lead_plan(text,jsonb,uuid)','hon.plan_chad_lead_plan(text,uuid)','hon.prepare_chad_lead_plan(text,uuid,uuid,boolean)',
    'hon.fail_chad_lead_plan(text,uuid,text,text)','hon.record_chad_lead_plan(text,uuid,jsonb)','hon.read_chad_lead_plans(text,uuid)',
    'hon.record_chad_lead_plan_step(text,uuid,integer,jsonb)','hon.close_chad_lead_plan(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_chad_lead_plan(text,jsonb,uuid), hon.plan_chad_lead_plan(text,uuid), hon.prepare_chad_lead_plan(text,uuid,uuid,boolean),
      hon.fail_chad_lead_plan(text,uuid,text,text), hon.record_chad_lead_plan(text,uuid,jsonb), hon.read_chad_lead_plans(text,uuid),
      hon.record_chad_lead_plan_step(text,uuid,integer,jsonb), hon.close_chad_lead_plan(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
