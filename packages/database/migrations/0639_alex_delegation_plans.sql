BEGIN;

-- Alex delegation plans, P1 (0639). Spec: docs/architecture/ALEX_DELEGATION_PLANS.md. Owner request 2026-11-22 ("all ai agent
-- backend done and switch them on"): Alex turns a goal into up to eight tasks for named staff; a person ticks the ones they want
-- and they become ordinary human work items (0084). A new kind on the shared AI text proposals (0550): one kinds row, its own
-- entry points, a facts reader and a validator. The 0550 core and every S4 function are unchanged.
--   A1 Who asks: a direct human with reporting.view (Alex, 0260), work_item.create and ai.invocation.plan at the session school and
--      an active Complete entitlement. The planner also enforces the per-staff Alex switch (0635) on every Alex call.
--   A2 Facts: the brief, the school name, the local date, Alex's 0260 facts and the staff who can take tasks as aliases only
--      (S1.., role, open task count). No staff name, email or phone and no family, student, lead or payment data is sent.
--   A3 Answer: {summary, tasks[1..8]}; checked in shape here and again by the contracts validator. Text only: nothing changes.
--   A4 Create: the requester ticks tasks; each becomes a 0084 work item created by the requester through hon.mutate_human_work,
--      which re-checks every authority (assigning someone else needs work_item.manage). All or nothing; an exact retry replays.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Alex delegation plans require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Alex delegation plans require a restricted runtime';
  END IF;
  IF to_regclass('hon.ai_text_proposals') IS NULL OR to_regprocedure('hon.ai_text_begin(text,uuid,text,uuid,integer,jsonb)') IS NULL
    OR to_regprocedure('hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.human_work_permission(uuid,uuid,uuid,text)') IS NULL
    OR to_regprocedure('hon.read_specialist_school_facts(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.membership_school_today()') IS NULL OR to_regprocedure('hon.marketing_safe_text(text,integer)') IS NULL
    OR to_regprocedure('hon.begin_alex_plan(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Alex delegation plans require migrations through 0284 and 0550 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('ALEX_DELEGATION_PLAN','alex','ANALYZE',12000,3000,80000,12288,'HUMAN_UI','SCHOOL','GENERAL_MANAGEMENT');

-- The staff aliases Alex saw, fixed when the facts were built, so a task's S<n> always means the same person.
CREATE TABLE hon.alex_plan_staff_refs (
  proposal_id uuid NOT NULL REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  ref text NOT NULL CHECK (ref ~ '^S([1-9]|[12][0-9]|30)$'),
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  PRIMARY KEY (proposal_id, ref), UNIQUE (proposal_id, principal_id)
);
-- The work items a create made, one per ticked task.
CREATE TABLE hon.alex_plan_created_tasks (
  proposal_id uuid NOT NULL REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  task_index integer NOT NULL CHECK (task_index BETWEEN 0 AND 7),
  work_item_id uuid NOT NULL REFERENCES hon.work_items(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (proposal_id, task_index), UNIQUE (work_item_id)
);
-- Both are append-only evidence: a row is never changed or removed.
CREATE FUNCTION hon.guard_alex_plan_rows() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'ALEX_PLAN_ROWS_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER alex_plan_staff_refs_guard BEFORE UPDATE OR DELETE ON hon.alex_plan_staff_refs FOR EACH ROW EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER alex_plan_staff_refs_no_truncate BEFORE TRUNCATE ON hon.alex_plan_staff_refs FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER alex_plan_created_tasks_guard BEFORE UPDATE OR DELETE ON hon.alex_plan_created_tasks FOR EACH ROW EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER alex_plan_created_tasks_no_truncate BEFORE TRUNCATE ON hon.alex_plan_created_tasks FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_alex_plan_rows();
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.alex_plan_staff_refs','hon.alex_plan_created_tasks'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION hon.alex_plan_areas() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['chad','maya','marcus','jordan','claire','lena']
$$;
CREATE FUNCTION hon.alex_plan_keys_are(p jsonb, k text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p)='object'
    AND coalesce((SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p) x), ARRAY[]::text[]) = (SELECT array_agg(y ORDER BY y) FROM unnest(k) y)
$$;
-- One line of safe text: what 0084 accepts as a title or description, and no secrets (0089).
CREATE FUNCTION hon.alex_plan_line_ok(v text, n integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT v IS NOT NULL AND v=btrim(v,E' \t\n\r') AND v !~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' AND hon.marketing_safe_text(v,n)
$$;

-- {goal: 1..500, horizon: WEEK | MONTH}.
CREATE FUNCTION hon.alex_plan_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(p,ARRAY['goal','horizon'])
    AND jsonb_typeof(p->'goal')='string' AND hon.alex_plan_line_ok(p->>'goal',500)
    AND jsonb_typeof(p->'horizon')='string' AND (p->>'horizon') IN ('WEEK','MONTH')
$$;

-- What an answer may hold. The contracts validator checks the same shape again, plus no links or email addresses.
CREATE FUNCTION hon.alex_plan_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(r,ARRAY['summary','tasks'])
    AND jsonb_typeof(r->'summary')='string' AND hon.alex_plan_line_ok(r->>'summary',300)
    AND jsonb_typeof(r->'tasks')='array' AND jsonb_array_length(r->'tasks') BETWEEN 1 AND 8 AND octet_length(convert_to(r::text,'UTF8'))<=12288
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'tasks') t WHERE NOT (
      hon.alex_plan_keys_are(t,ARRAY['area','assignee','description','dueInDays','priority','title'])
      AND jsonb_typeof(t->'title')='string' AND hon.alex_plan_line_ok(t->>'title',120)
      AND jsonb_typeof(t->'description')='string' AND hon.alex_plan_line_ok(t->>'description',600)
      AND jsonb_typeof(t->'priority')='string' AND (t->>'priority') IN ('LOW','NORMAL','HIGH')
      AND (jsonb_typeof(t->'assignee')='null' OR (jsonb_typeof(t->'assignee')='string' AND (t->>'assignee') ~ '^S([1-9]|[12][0-9]|30)$'))
      AND (jsonb_typeof(t->'dueInDays')='null' OR (jsonb_typeof(t->'dueInDays')='number' AND (t->>'dueInDays') ~ '^([0-9]|[12][0-9]|3[01])$'))
      AND (jsonb_typeof(t->'area')='null' OR (jsonb_typeof(t->'area')='string' AND (t->>'area')=ANY(hon.alex_plan_areas())))))
$$;

-- The requester for a command: Alex's capability, task creation and AI planning at the session school, and Complete.
CREATE FUNCTION hon.alex_plan_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  IF current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI' OR coalesce(current_setting('app.hon_action_request_id',true),'')<>''
    OR coalesce(current_setting('app.hon_delegated_by_principal_id',true),'')<>'' OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN
    RAISE EXCEPTION 'ALEX_PLAN_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  org := hon.current_organization_id(); school := hon.current_school_id();
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    WHERE u.external_subject=p_subject;
  IF actor IS NULL OR NOT hon.principal_has_school_permission(actor,org,school,'reporting.view')
    OR NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
    OR hon.human_work_permission(actor,org,school,'work_item.create') IS DISTINCT FROM true
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier='COMPLETE' AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'ALEX_PLAN_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- A reader: reporting.view at the session school.
CREATE FUNCTION hon.alex_plan_reader(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    WHERE u.external_subject=p_subject;
  IF actor IS NULL OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),'reporting.view') THEN
    RAISE EXCEPTION 'ALEX_PLAN_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- Fix the staff aliases for a plan (once): people who can hold a task at this school, earliest school access first, at most 30.
CREATE FUNCTION hon.alex_plan_fix_refs(p_id uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id();
BEGIN
  IF EXISTS(SELECT 1 FROM hon.alex_plan_staff_refs WHERE proposal_id=p_id) THEN RETURN; END IF;
  INSERT INTO hon.alex_plan_staff_refs(proposal_id,organization_id,school_id,ref,principal_id)
    SELECT p_id, org, school, 'S'||row_number() OVER (ORDER BY x.since, x.principal_id), x.principal_id
    FROM (SELECT g.principal_id, min(g.effective_from) since FROM hon.principal_role_grants g
          WHERE g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
          GROUP BY g.principal_id HAVING hon.human_work_permission(g.principal_id,org,school,'work_item.self_manage')
          ORDER BY min(g.effective_from), g.principal_id LIMIT 30) x;
END $$;

-- The facts Alex sees (at most about 10 KB).
CREATE FUNCTION hon.alex_plan_facts(p_subject text, p_id uuid, p_brief jsonb) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('brief',p_brief,'schoolName',left(s.name,120),'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),
    'school',(hon.read_specialist_school_facts(p_subject,'alex',s.organization_id,s.id))->'facts',
    'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,
        'role',CASE WHEN hon.human_work_permission(r.principal_id,r.organization_id,r.school_id,'work_item.manage') THEN 'Manager' ELSE 'Staff' END,
        'openTasks',(SELECT count(*) FROM hon.work_items w WHERE w.organization_id=r.organization_id AND w.school_id=r.school_id AND w.work_origin='HUMAN_UI'
          AND w.assigned_principal_id=r.principal_id AND w.status NOT IN ('COMPLETED','FAILED'))) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.alex_plan_staff_refs r WHERE r.proposal_id=p_id),'[]'::jsonb))
  FROM hon.schools s WHERE s.id=hon.current_school_id() AND s.organization_id=hon.current_organization_id()
$$;

CREATE FUNCTION hon.alex_plan_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,'mine',i.requested_by=p_actor,
    'summary',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'summary' END,
    'tasks',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->'tasks' END,
    'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('ref',r.ref,'principalId',r.principal_id,'name',left(p.display_name,120)) ORDER BY substring(r.ref FROM 2)::integer)
      FROM hon.alex_plan_staff_refs r JOIN hon.principals p ON p.id=r.principal_id WHERE r.proposal_id=i.id),'[]'::jsonb),
    'created',coalesce((SELECT jsonb_agg(jsonb_build_object('index',c.task_index,'workItemId',c.work_item_id) ORDER BY c.task_index)
      FROM hon.alex_plan_created_tasks c WHERE c.proposal_id=i.id),'[]'::jsonb),
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='ALEX_DELEGATION_PLAN' AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_alex_plan(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.alex_plan_actor(p_subject); pid uuid;
BEGIN
  IF p_key IS NULL OR NOT hon.alex_plan_brief_ok(p_input) THEN RAISE EXCEPTION 'ALEX_PLAN_INVALID' USING ERRCODE='22023'; END IF;
  pid := hon.ai_text_begin('ALEX_DELEGATION_PLAN',actor,actor::text||':'||p_key::text,hon.current_school_id(),NULL,p_input);
  RETURN hon.alex_plan_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_alex_plan(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='ALEX_DELEGATION_PLAN') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, hon.alex_plan_actor(p_subject));
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, the core claim, then the facts.
CREATE FUNCTION hon.prepare_alex_plan(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.alex_plan_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'ALEX_DELEGATION_PLAN' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  PERFORM hon.alex_plan_fix_refs(p_id);
  RETURN inv || jsonb_build_object('request',hon.alex_plan_facts(p_subject,p_id,i.request)::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule): a call in flight when access lapsed still records.
CREATE FUNCTION hon.fail_alex_plan(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='ALEX_DELEGATION_PLAN') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}. A proposal outside the closed shape, or naming a staff alias Alex was not given,
-- is stored empty and rejected.
CREATE FUNCTION hon.record_alex_plan(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='ALEX_DELEGATION_PLAN') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.alex_plan_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.alex_plan_ok(proposal) OR EXISTS(SELECT 1 FROM jsonb_array_elements(proposal->'tasks') t
      WHERE jsonb_typeof(t->'assignee')='string' AND NOT EXISTS(SELECT 1 FROM hon.alex_plan_staff_refs r WHERE r.proposal_id=p_id AND r.ref=t->>'assignee')) THEN
    proposal := jsonb_build_object('summary','','tasks','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a task plan for this school.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.alex_plan_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The school's newest 20 plans for anyone with reporting.view, or one by id.
CREATE FUNCTION hon.read_alex_plans(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.alex_plan_reader(p_subject); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.alex_plan_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.alex_plan_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='ALEX_DELEGATION_PLAN' AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
      ORDER BY created_at DESC, id LIMIT 20) x),'[]'::jsonb);
END $$;

-- Create the ticked tasks as human work items, then close the plan APPLIED. The requester only, with current authority.
-- p_input = {tasks: [index, ...]} (1..8 distinct). p_key is the request's Idempotency-Key; each task uses <p_key>:<index>.
CREATE FUNCTION hon.create_alex_plan_tasks(p_subject text, p_id uuid, p_input jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.alex_plan_actor(p_subject); i hon.ai_text_proposals%ROWTYPE; idx integer; t jsonb; target uuid; tz text; due text; made jsonb;
  picked integer[];
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 160 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR NOT hon.alex_plan_keys_are(p_input,ARRAY['tasks']) OR jsonb_typeof(p_input->'tasks')<>'array' OR jsonb_array_length(p_input->'tasks') NOT BETWEEN 1 AND 8
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'tasks') e WHERE jsonb_typeof(e)<>'number' OR (e#>>'{}') !~ '^[0-7]$') THEN
    RAISE EXCEPTION 'ALEX_PLAN_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(DISTINCT (e#>>'{}')::integer ORDER BY (e#>>'{}')::integer) INTO picked FROM jsonb_array_elements(p_input->'tasks') e;
  IF cardinality(picked)<>jsonb_array_length(p_input->'tasks') THEN RAISE EXCEPTION 'ALEX_PLAN_INVALID' USING ERRCODE='22023'; END IF;
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'ALEX_DELEGATION_PLAN' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- An exact retry of a finished create replays it; any other create of an applied plan is refused.
  IF i.status='APPLIED' THEN
    IF (SELECT array_agg(task_index ORDER BY task_index) FROM hon.alex_plan_created_tasks WHERE proposal_id=i.id) IS NOT DISTINCT FROM picked
      AND NOT EXISTS(SELECT 1 FROM hon.alex_plan_created_tasks WHERE proposal_id=i.id AND idempotency_key<>p_key) THEN
      RETURN hon.alex_plan_view(i.id, actor) || jsonb_build_object('replayed',true);
    END IF;
    RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001';
  END IF;
  IF i.status<>'RESULT_RECORDED' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(picked) x WHERE x>=jsonb_array_length(i.result->'tasks')) THEN RAISE EXCEPTION 'ALEX_PLAN_INVALID' USING ERRCODE='22023'; END IF;
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=i.school_id AND s.organization_id=i.organization_id;
  FOREACH idx IN ARRAY picked LOOP
    t := i.result->'tasks'->idx;
    target := NULL;
    IF jsonb_typeof(t->'assignee')='string' THEN
      SELECT r.principal_id INTO target FROM hon.alex_plan_staff_refs r WHERE r.proposal_id=i.id AND r.ref=t->>'assignee';
      IF target IS NULL THEN RAISE EXCEPTION 'ALEX_PLAN_INVALID' USING ERRCODE='22023'; END IF;
    END IF;
    -- Due at 17:00 school time on the day Alex suggested.
    due := CASE WHEN jsonb_typeof(t->'dueInDays')='number' THEN to_char((((hon.membership_school_today()+(t->>'dueInDays')::integer)+time '17:00') AT TIME ZONE tz) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
    made := hon.mutate_human_work(p_subject,'CREATE',NULL,jsonb_build_object('expectedVersion',0,'title',t->>'title',
      'description',left(t->>'description',600)||' Suggested by Alex.','priority',t->>'priority','dueAt',to_jsonb(due),'assigneeId',to_jsonb(target)),
      p_key||':'||idx,p_request,p_correlation);
    INSERT INTO hon.alex_plan_created_tasks(proposal_id,organization_id,school_id,task_index,work_item_id,idempotency_key,created_by)
      VALUES(i.id,i.organization_id,i.school_id,idx,(made->'workItem'->>'workItemId')::uuid,p_key,actor);
  END LOOP;
  PERFORM hon.ai_text_close(i.id, actor, 'APPLIED');
  RETURN hon.alex_plan_view(i.id, actor) || jsonb_build_object('replayed',false);
END $$;

-- DISMISSED. The requester only; they must still be able to read plans.
CREATE FUNCTION hon.close_alex_plan(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.alex_plan_reader(p_subject);
BEGIN
  IF p_status IS DISTINCT FROM 'DISMISSED' THEN RAISE EXCEPTION 'ALEX_PLAN_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='ALEX_DELEGATION_PLAN') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.alex_plan_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the eight entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.guard_alex_plan_rows()','hon.alex_plan_areas()','hon.alex_plan_keys_are(jsonb,text[])','hon.alex_plan_line_ok(text,integer)','hon.alex_plan_brief_ok(jsonb)',
    'hon.alex_plan_ok(jsonb)','hon.alex_plan_actor(text)','hon.alex_plan_reader(text)','hon.alex_plan_fix_refs(uuid)','hon.alex_plan_facts(text,uuid,jsonb)',
    'hon.alex_plan_view(uuid,uuid)','hon.begin_alex_plan(text,jsonb,uuid)','hon.plan_alex_plan(text,uuid)','hon.prepare_alex_plan(text,uuid,uuid,boolean)',
    'hon.fail_alex_plan(text,uuid,text,text)','hon.record_alex_plan(text,uuid,jsonb)','hon.read_alex_plans(text,uuid)',
    'hon.create_alex_plan_tasks(text,uuid,jsonb,text,uuid,uuid)','hon.close_alex_plan(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_alex_plan(text,jsonb,uuid), hon.plan_alex_plan(text,uuid), hon.prepare_alex_plan(text,uuid,uuid,boolean),
      hon.fail_alex_plan(text,uuid,text,text), hon.record_alex_plan(text,uuid,jsonb), hon.read_alex_plans(text,uuid),
      hon.create_alex_plan_tasks(text,uuid,jsonb,text,uuid,uuid), hon.close_alex_plan(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
