BEGIN;

-- Jordan follow-through, P2 (0640). Spec: docs/architecture/JORDAN_FOLLOW_THROUGH.md. Owner request 2026-11-22 ("all ai agent
-- backend done and switch them on"): Jordan reads the school's open (or overdue) team tasks and suggests up to ten follow-ups:
-- move a due date, hand a task to someone else, change its priority, or add a follow-up task. A person ticks the ones they want
-- and each is applied through the ordinary human work path (0084). A new kind on the shared AI text proposals (0550), built
-- like Alex plans (0639) and reusing its line and key helpers. The 0550 core and every S4 function are unchanged.
--   J1 Who asks: a direct human with schedule.session.manage (Jordan, 0260), work_item.manage, work_item.create and
--      ai.invocation.plan at the session school and an active Complete entitlement. The planner enforces the per-staff Jordan
--      switch (0635) on every Jordan call.
--   J2 Facts: the brief, the school name, the local date, Jordan's 0260 operations facts, the staff who can take tasks as
--      aliases only (S1.., role, open task count) and up to 30 open human tasks as W1.. with title, status, priority, alias
--      of the assignee, days until due and days since the last change. No staff name, email or phone, no task description and
--      no family, student, lead or payment record is sent.
--   J3 Answer: {summary, suggestions[1..10]}; one suggestion per task; checked here and by the contracts validator.
--   J4 Apply: the requester ticks suggestions; each runs through hon.mutate_human_work as that person (UPDATE of the task at
--      the version Jordan saw, or CREATE of a follow-up task for the requester). A task changed since Jordan read it is refused
--      (VERSION_CONFLICT); everything is all or nothing; an exact retry replays.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Jordan follow-through requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Jordan follow-through requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.begin_alex_plan(text,jsonb,uuid)') IS NULL OR to_regprocedure('hon.alex_plan_line_ok(text,integer)') IS NULL
    OR to_regprocedure('hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.begin_jordan_follow_up(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Jordan follow-through requires migration 0639 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('JORDAN_FOLLOW_UP','jordan','ANALYZE',12000,3000,80000,12288,'HUMAN_UI','SCHOOL','OPERATIONS');

-- The aliases Jordan saw, fixed when the facts were built: S<n> is a person, W<n> is a task at the version Jordan read.
CREATE TABLE hon.jordan_follow_up_refs (
  proposal_id uuid NOT NULL REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^[SW]([1-9]|[12][0-9]|30)$'),
  principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  work_item_id uuid REFERENCES hon.work_items(id) ON DELETE RESTRICT,
  work_version integer CHECK (work_version BETWEEN 1 AND 999999999),
  PRIMARY KEY (proposal_id, ref),
  CHECK ((ref LIKE 'S%' AND principal_id IS NOT NULL AND work_item_id IS NULL AND work_version IS NULL)
      OR (ref LIKE 'W%' AND principal_id IS NULL AND work_item_id IS NOT NULL AND work_version IS NOT NULL))
);
CREATE UNIQUE INDEX jordan_follow_up_refs_person ON hon.jordan_follow_up_refs(proposal_id, principal_id) WHERE principal_id IS NOT NULL;
CREATE UNIQUE INDEX jordan_follow_up_refs_task ON hon.jordan_follow_up_refs(proposal_id, work_item_id) WHERE work_item_id IS NOT NULL;
-- What an apply changed or created, one row per ticked suggestion.
CREATE TABLE hon.jordan_follow_up_applied (
  proposal_id uuid NOT NULL REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  suggestion_index integer NOT NULL CHECK (suggestion_index BETWEEN 0 AND 9),
  work_item_id uuid NOT NULL REFERENCES hon.work_items(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  applied_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (proposal_id, suggestion_index)
);
CREATE TRIGGER jordan_follow_up_refs_guard BEFORE UPDATE OR DELETE ON hon.jordan_follow_up_refs FOR EACH ROW EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER jordan_follow_up_refs_no_truncate BEFORE TRUNCATE ON hon.jordan_follow_up_refs FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER jordan_follow_up_applied_guard BEFORE UPDATE OR DELETE ON hon.jordan_follow_up_applied FOR EACH ROW EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER jordan_follow_up_applied_no_truncate BEFORE TRUNCATE ON hon.jordan_follow_up_applied FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_alex_plan_rows();
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.jordan_follow_up_refs','hon.jordan_follow_up_applied'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- {focus: OVERDUE | OPEN, note: 0..300 (empty allowed)}.
CREATE FUNCTION hon.jordan_follow_up_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(p,ARRAY['focus','note'])
    AND jsonb_typeof(p->'focus')='string' AND (p->>'focus') IN ('OVERDUE','OPEN')
    AND jsonb_typeof(p->'note')='string' AND ((p->>'note')='' OR hon.alex_plan_line_ok(p->>'note',300))
$$;

-- What an answer may hold. Each action carries exactly the field it changes; one suggestion per task.
CREATE FUNCTION hon.jordan_follow_up_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(r,ARRAY['suggestions','summary'])
    AND jsonb_typeof(r->'summary')='string' AND hon.alex_plan_line_ok(r->>'summary',300)
    AND jsonb_typeof(r->'suggestions')='array' AND jsonb_array_length(r->'suggestions') BETWEEN 1 AND 10 AND octet_length(convert_to(r::text,'UTF8'))<=12288
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'suggestions') t WHERE NOT (
      hon.alex_plan_keys_are(t,ARRAY['action','assignee','dueInDays','item','priority','reason'])
      AND jsonb_typeof(t->'item')='string' AND (t->>'item') ~ '^W([1-9]|[12][0-9]|30)$'
      AND jsonb_typeof(t->'reason')='string' AND hon.alex_plan_line_ok(t->>'reason',300)
      AND jsonb_typeof(t->'action')='string' AND CASE t->>'action'
        WHEN 'RESCHEDULE' THEN jsonb_typeof(t->'dueInDays')='number' AND (t->>'dueInDays') ~ '^([0-9]|[12][0-9]|3[01])$'
          AND jsonb_typeof(t->'assignee')='null' AND jsonb_typeof(t->'priority')='null'
        WHEN 'REASSIGN' THEN jsonb_typeof(t->'assignee')='string' AND (t->>'assignee') ~ '^S([1-9]|[12][0-9]|30)$'
          AND jsonb_typeof(t->'dueInDays')='null' AND jsonb_typeof(t->'priority')='null'
        WHEN 'REPRIORITIZE' THEN jsonb_typeof(t->'priority')='string' AND (t->>'priority') IN ('LOW','NORMAL','HIGH')
          AND jsonb_typeof(t->'dueInDays')='null' AND jsonb_typeof(t->'assignee')='null'
        WHEN 'FOLLOW_UP' THEN (jsonb_typeof(t->'dueInDays')='null' OR (jsonb_typeof(t->'dueInDays')='number' AND (t->>'dueInDays') ~ '^([0-9]|[12][0-9]|3[01])$'))
          AND jsonb_typeof(t->'assignee')='null' AND jsonb_typeof(t->'priority')='null'
        ELSE false END))
    AND (SELECT count(DISTINCT t->>'item') FROM jsonb_array_elements(r->'suggestions') t)=jsonb_array_length(r->'suggestions')
$$;

-- The requester for a command: Jordan's capability, team task management, AI planning at the session school, and Complete.
CREATE FUNCTION hon.jordan_follow_up_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  IF current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI' OR coalesce(current_setting('app.hon_action_request_id',true),'')<>''
    OR coalesce(current_setting('app.hon_delegated_by_principal_id',true),'')<>'' OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN
    RAISE EXCEPTION 'JORDAN_FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  org := hon.current_organization_id(); school := hon.current_school_id();
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    WHERE u.external_subject=p_subject;
  IF actor IS NULL OR NOT hon.principal_has_school_permission(actor,org,school,'schedule.session.manage')
    OR NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
    OR hon.human_work_permission(actor,org,school,'work_item.manage') IS DISTINCT FROM true
    OR hon.human_work_permission(actor,org,school,'work_item.create') IS DISTINCT FROM true
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier='COMPLETE' AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'JORDAN_FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- A reader sees team task titles, so it needs Jordan's capability and team task management at the session school.
CREATE FUNCTION hon.jordan_follow_up_reader(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    WHERE u.external_subject=p_subject;
  IF actor IS NULL OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),'schedule.session.manage')
    OR hon.human_work_permission(actor,hon.current_organization_id(),hon.current_school_id(),'work_item.manage') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'JORDAN_FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- Fix the aliases (once): people who can hold a task (as for Alex), then up to 30 open human tasks, OVERDUE = due before now.
CREATE FUNCTION hon.jordan_follow_up_fix_refs(p_id uuid, p_focus text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
BEGIN
  IF EXISTS(SELECT 1 FROM hon.jordan_follow_up_refs WHERE proposal_id=p_id) THEN RETURN; END IF;
  INSERT INTO hon.jordan_follow_up_refs(proposal_id,organization_id,school_id,ref,principal_id)
    SELECT p_id, org, school, 'S'||row_number() OVER (ORDER BY x.since, x.principal_id), x.principal_id
    FROM (SELECT g.principal_id, min(g.effective_from) since FROM hon.principal_role_grants g
          WHERE g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
          GROUP BY g.principal_id HAVING hon.human_work_permission(g.principal_id,org,school,'work_item.self_manage')
          ORDER BY min(g.effective_from), g.principal_id LIMIT 30) x;
  INSERT INTO hon.jordan_follow_up_refs(proposal_id,organization_id,school_id,ref,work_item_id,work_version)
    SELECT p_id, org, school, 'W'||row_number() OVER (ORDER BY x.due_at NULLS LAST, x.id), x.id, x.version
    FROM (SELECT w.id, w.version, w.due_at FROM hon.work_items w
          WHERE w.organization_id=org AND w.school_id=school AND w.work_origin='HUMAN_UI' AND w.status NOT IN ('COMPLETED','FAILED')
            AND (p_focus='OPEN' OR (w.due_at IS NOT NULL AND w.due_at<clock_timestamp()))
          ORDER BY w.due_at NULLS LAST, w.id LIMIT 30) x;
END $$;

-- The facts Jordan sees (at most about 10 KB). Task titles are staff-written and sent as untrusted text.
CREATE FUNCTION hon.jordan_follow_up_facts(p_subject text, p_id uuid, p_brief jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('brief',p_brief,'schoolName',left(s.name,120),'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'school',(hon.read_specialist_school_facts(p_subject,'jordan',s.organization_id,s.id))->'facts',
    'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,
        'role',CASE WHEN hon.human_work_permission(r.principal_id,r.organization_id,r.school_id,'work_item.manage') THEN 'Manager' ELSE 'Staff' END,
        'openTasks',(SELECT count(*) FROM hon.work_items w WHERE w.organization_id=r.organization_id AND w.school_id=r.school_id AND w.work_origin='HUMAN_UI'
          AND w.assigned_principal_id=r.principal_id AND w.status NOT IN ('COMPLETED','FAILED'))) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.jordan_follow_up_refs r WHERE r.proposal_id=p_id AND r.ref LIKE 'S%'),'[]'::jsonb),
    'tasks',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'title',w.title,'status',w.status,'priority',w.priority,
        'assignee',CASE WHEN w.assigned_principal_id IS NULL THEN NULL
          ELSE coalesce((SELECT a.ref FROM hon.jordan_follow_up_refs a WHERE a.proposal_id=p_id AND a.principal_id=w.assigned_principal_id),'OTHER') END,
        'dueInDays',CASE WHEN w.due_at IS NULL THEN NULL ELSE ((w.due_at AT TIME ZONE s.timezone)::date - hon.membership_school_today()) END,
        'daysSinceChange',(hon.membership_school_today() - (w.updated_at AT TIME ZONE s.timezone)::date))
        ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.jordan_follow_up_refs r JOIN hon.work_items w ON w.id=r.work_item_id WHERE r.proposal_id=p_id AND r.ref LIKE 'W%'),'[]'::jsonb))
  FROM hon.schools s WHERE s.id=hon.current_school_id() AND s.organization_id=hon.current_organization_id()
$$;

CREATE FUNCTION hon.jordan_follow_up_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,'mine',i.requested_by=p_actor,
    'summary',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'summary' END,
    'suggestions',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->'suggestions' END,
    'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'principalId',r.principal_id,'name',left(p.display_name,120)) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.jordan_follow_up_refs r JOIN hon.principals p ON p.id=r.principal_id WHERE r.proposal_id=i.id AND r.ref LIKE 'S%'),'[]'::jsonb),
    'items',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'workItemId',r.work_item_id,'title',w.title) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.jordan_follow_up_refs r JOIN hon.work_items w ON w.id=r.work_item_id WHERE r.proposal_id=i.id AND r.ref LIKE 'W%'),'[]'::jsonb),
    'applied',coalesce((SELECT jsonb_agg(jsonb_build_object('index',c.suggestion_index,'workItemId',c.work_item_id) ORDER BY c.suggestion_index)
      FROM hon.jordan_follow_up_applied c WHERE c.proposal_id=i.id),'[]'::jsonb),
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='JORDAN_FOLLOW_UP' AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_jordan_follow_up(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.jordan_follow_up_actor(p_subject); pid uuid;
BEGIN
  IF p_key IS NULL OR NOT hon.jordan_follow_up_brief_ok(p_input) THEN RAISE EXCEPTION 'JORDAN_FOLLOW_UP_INVALID' USING ERRCODE='22023'; END IF;
  pid := hon.ai_text_begin('JORDAN_FOLLOW_UP',actor,actor::text||':'||p_key::text,hon.current_school_id(),NULL,p_input);
  RETURN hon.jordan_follow_up_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_jordan_follow_up(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='JORDAN_FOLLOW_UP') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, hon.jordan_follow_up_actor(p_subject));
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, the core claim, then the facts.
CREATE FUNCTION hon.prepare_jordan_follow_up(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.jordan_follow_up_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'JORDAN_FOLLOW_UP' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  PERFORM hon.jordan_follow_up_fix_refs(p_id, i.request->>'focus');
  RETURN inv || jsonb_build_object('request',hon.jordan_follow_up_facts(p_subject,p_id,i.request)::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule).
CREATE FUNCTION hon.fail_jordan_follow_up(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='JORDAN_FOLLOW_UP') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}. A proposal outside the closed shape, or naming a task or person alias Jordan was not
-- given, is stored empty and rejected.
CREATE FUNCTION hon.record_jordan_follow_up(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='JORDAN_FOLLOW_UP') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.alex_plan_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.jordan_follow_up_ok(proposal) OR EXISTS(SELECT 1 FROM jsonb_array_elements(proposal->'suggestions') t
      WHERE NOT EXISTS(SELECT 1 FROM hon.jordan_follow_up_refs r WHERE r.proposal_id=p_id AND r.ref=t->>'item')
        OR (jsonb_typeof(t->'assignee')='string' AND NOT EXISTS(SELECT 1 FROM hon.jordan_follow_up_refs r WHERE r.proposal_id=p_id AND r.ref=t->>'assignee'))) THEN
    proposal := jsonb_build_object('summary','','suggestions','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a follow-up list for these tasks.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.jordan_follow_up_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The school's newest 20 follow-up lists, or one by id.
CREATE FUNCTION hon.read_jordan_follow_ups(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.jordan_follow_up_reader(p_subject); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.jordan_follow_up_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.jordan_follow_up_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='JORDAN_FOLLOW_UP' AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
      ORDER BY created_at DESC, id LIMIT 20) x),'[]'::jsonb);
END $$;

-- Apply the ticked suggestions through 0084 as the requester, then close the list APPLIED.
-- p_input = {suggestions: [index, ...]} (1..10 distinct). p_key is the request's Idempotency-Key; each step uses <p_key>:<index>.
CREATE FUNCTION hon.apply_jordan_follow_ups(p_subject text, p_id uuid, p_input jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.jordan_follow_up_actor(p_subject); i hon.ai_text_proposals%ROWTYPE; idx integer; t jsonb; ref hon.jordan_follow_up_refs%ROWTYPE;
  w hon.work_items%ROWTYPE; target uuid; tz text; due text; made jsonb; picked integer[]; iso text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 160 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR NOT hon.alex_plan_keys_are(p_input,ARRAY['suggestions']) OR jsonb_typeof(p_input->'suggestions')<>'array' OR jsonb_array_length(p_input->'suggestions') NOT BETWEEN 1 AND 10
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'suggestions') e WHERE jsonb_typeof(e)<>'number' OR (e#>>'{}') !~ '^[0-9]$') THEN
    RAISE EXCEPTION 'JORDAN_FOLLOW_UP_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(DISTINCT (e#>>'{}')::integer ORDER BY (e#>>'{}')::integer) INTO picked FROM jsonb_array_elements(p_input->'suggestions') e;
  IF cardinality(picked)<>jsonb_array_length(p_input->'suggestions') THEN RAISE EXCEPTION 'JORDAN_FOLLOW_UP_INVALID' USING ERRCODE='22023'; END IF;
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'JORDAN_FOLLOW_UP' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF i.status='APPLIED' THEN
    IF (SELECT array_agg(suggestion_index ORDER BY suggestion_index) FROM hon.jordan_follow_up_applied WHERE proposal_id=i.id) IS NOT DISTINCT FROM picked
      AND NOT EXISTS(SELECT 1 FROM hon.jordan_follow_up_applied WHERE proposal_id=i.id AND idempotency_key<>p_key) THEN
      RETURN hon.jordan_follow_up_view(i.id, actor) || jsonb_build_object('replayed',true);
    END IF;
    RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001';
  END IF;
  IF i.status<>'RESULT_RECORDED' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(picked) x WHERE x>=jsonb_array_length(i.result->'suggestions')) THEN RAISE EXCEPTION 'JORDAN_FOLLOW_UP_INVALID' USING ERRCODE='22023'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=i.school_id AND s.organization_id=i.organization_id;
  FOREACH idx IN ARRAY picked LOOP
    t := i.result->'suggestions'->idx;
    SELECT * INTO ref FROM hon.jordan_follow_up_refs r WHERE r.proposal_id=i.id AND r.ref=t->>'item';
    IF NOT FOUND THEN RAISE EXCEPTION 'JORDAN_FOLLOW_UP_INVALID' USING ERRCODE='22023'; END IF;
    SELECT * INTO w FROM hon.work_items x WHERE x.id=ref.work_item_id AND x.organization_id=i.organization_id AND x.school_id=i.school_id AND x.work_origin='HUMAN_UI';
    IF NOT FOUND THEN RAISE EXCEPTION 'WORK_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
    -- Due at 17:00 school time on the day Jordan suggested.
    due := CASE WHEN jsonb_typeof(t->'dueInDays')='number' THEN to_char((((hon.membership_school_today()+(t->>'dueInDays')::integer)+time '17:00') AT TIME ZONE tz) AT TIME ZONE 'UTC', iso) END;
    IF t->>'action'='FOLLOW_UP' THEN
      made := hon.mutate_human_work(p_subject,'CREATE',NULL,jsonb_build_object('expectedVersion',0,'title',left('Follow up: '||w.title,120),
        'description',(t->>'reason')||' Suggested by Jordan.','priority','NORMAL','dueAt',to_jsonb(due),'assigneeId',to_jsonb(actor)),
        p_key||':'||idx,p_request,p_correlation);
    ELSE
      target := w.assigned_principal_id;
      IF t->>'action'='REASSIGN' THEN
        SELECT r.principal_id INTO target FROM hon.jordan_follow_up_refs r WHERE r.proposal_id=i.id AND r.ref=t->>'assignee';
        IF target IS NULL THEN RAISE EXCEPTION 'JORDAN_FOLLOW_UP_INVALID' USING ERRCODE='22023'; END IF;
      END IF;
      -- Only the field Jordan named changes; the task must still be at the version Jordan read (0084 VERSION_CONFLICT otherwise).
      made := hon.mutate_human_work(p_subject,'UPDATE',w.id,jsonb_build_object('expectedVersion',ref.work_version,'title',w.title,'description',w.description,
        'priority',CASE WHEN t->>'action'='REPRIORITIZE' THEN t->>'priority' ELSE w.priority END,
        'dueAt',CASE WHEN t->>'action'='RESCHEDULE' THEN to_jsonb(due) ELSE to_jsonb(to_char(w.due_at AT TIME ZONE 'UTC', iso)) END,
        'assigneeId',to_jsonb(target)),
        p_key||':'||idx,p_request,p_correlation);
    END IF;
    INSERT INTO hon.jordan_follow_up_applied(proposal_id,organization_id,school_id,suggestion_index,work_item_id,idempotency_key,applied_by)
      VALUES(i.id,i.organization_id,i.school_id,idx,(made->'workItem'->>'workItemId')::uuid,p_key,actor);
  END LOOP;
  PERFORM hon.ai_text_close(i.id, actor, 'APPLIED');
  RETURN hon.jordan_follow_up_view(i.id, actor) || jsonb_build_object('replayed',false);
END $$;

-- DISMISSED. The requester only; they must still be able to read the lists.
CREATE FUNCTION hon.close_jordan_follow_up(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.jordan_follow_up_reader(p_subject);
BEGIN
  IF p_status IS DISTINCT FROM 'DISMISSED' THEN RAISE EXCEPTION 'JORDAN_FOLLOW_UP_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='JORDAN_FOLLOW_UP') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.jordan_follow_up_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the eight entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.jordan_follow_up_brief_ok(jsonb)','hon.jordan_follow_up_ok(jsonb)','hon.jordan_follow_up_actor(text)',
    'hon.jordan_follow_up_reader(text)','hon.jordan_follow_up_fix_refs(uuid,text)','hon.jordan_follow_up_facts(text,uuid,jsonb)',
    'hon.jordan_follow_up_view(uuid,uuid)','hon.begin_jordan_follow_up(text,jsonb,uuid)','hon.plan_jordan_follow_up(text,uuid)',
    'hon.prepare_jordan_follow_up(text,uuid,uuid,boolean)','hon.fail_jordan_follow_up(text,uuid,text,text)','hon.record_jordan_follow_up(text,uuid,jsonb)',
    'hon.read_jordan_follow_ups(text,uuid)','hon.apply_jordan_follow_ups(text,uuid,jsonb,text,uuid,uuid)','hon.close_jordan_follow_up(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_jordan_follow_up(text,jsonb,uuid), hon.plan_jordan_follow_up(text,uuid), hon.prepare_jordan_follow_up(text,uuid,uuid,boolean),
      hon.fail_jordan_follow_up(text,uuid,text,text), hon.record_jordan_follow_up(text,uuid,jsonb), hon.read_jordan_follow_ups(text,uuid),
      hon.apply_jordan_follow_ups(text,uuid,jsonb,text,uuid,uuid), hon.close_jordan_follow_up(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
