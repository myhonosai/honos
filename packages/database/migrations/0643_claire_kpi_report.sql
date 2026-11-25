BEGIN;

-- Claire KPI report, P4 (0643). Spec: docs/architecture/CLAIRE_KPI_REPORT.md. Owner request 2026-11-22 ("all ai agent backend
-- done and switch them on"): a reporting user asks Claire for a KPI report on the last 7 or 30 days. The database counts nine
-- fixed KPIs for that window and the one before it (new, won and lost leads, registrations, new and ended memberships, classes
-- attended, students attending, active memberships now) and keeps those exact numbers with the report. Claire adds a summary,
-- a note per KPI, things to watch and next actions. Text only: nothing is created, sent or changed. A new kind on the shared AI
-- text proposals (0550), built like Alex plans (0639) and reusing its line, key and immutability helpers. The 0550 core and S4
-- are unchanged.
--   C1 Who asks: a direct human with reporting.view (Claire, 0229) and ai.invocation.plan at the session school and an active
--      Complete entitlement. The planner enforces the per-staff Claire switch (0635).
--   C2 Facts: counts only, plus the Command Center metrics Claire already answers from (0229, re-checking reporting.view). No
--      lead, person, family, student, contact or payment row, and no staff name, is sent.
--   C3 Who reads: the requester only (a report holds the requester's own focus).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Claire KPI report requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Claire KPI report requires a restricted runtime';
  END IF;
  IF to_regprocedure('hon.alex_plan_line_ok(text,integer)') IS NULL OR to_regprocedure('hon.begin_marcus_review(text,jsonb,uuid)') IS NULL
    OR to_regprocedure('hon.read_school_command_center(text,uuid,uuid)') IS NULL OR to_regclass('hon.attendance_records') IS NULL
    OR to_regprocedure('hon.begin_claire_kpi_report(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Claire KPI report requires migrations 0639 to 0641 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('CLAIRE_KPI_REPORT','claire','ANALYZE',12000,3000,80000,12288,'HUMAN_UI','SCHOOL','BUSINESS_PERFORMANCE');

-- The exact numbers of one report, counted once when the facts were built. Append-only evidence.
CREATE TABLE hon.claire_kpi_report_numbers (
  proposal_id uuid PRIMARY KEY REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  window_days integer NOT NULL CHECK (window_days IN (7,30)),
  kpis jsonb NOT NULL CHECK (jsonb_typeof(kpis)='array' AND jsonb_array_length(kpis)=9),
  counted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER claire_kpi_report_numbers_guard BEFORE UPDATE OR DELETE ON hon.claire_kpi_report_numbers FOR EACH ROW EXECUTE FUNCTION hon.guard_alex_plan_rows();
CREATE TRIGGER claire_kpi_report_numbers_no_truncate BEFORE TRUNCATE ON hon.claire_kpi_report_numbers FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_alex_plan_rows();
DO $$ DECLARE r text; BEGIN
  ALTER TABLE hon.claire_kpi_report_numbers ENABLE ROW LEVEL SECURITY;
  ALTER TABLE hon.claire_kpi_report_numbers FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE hon.claire_kpi_report_numbers FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.claire_kpi_report_numbers FROM %I', r);
  END LOOP;
END $$;

-- The nine KPI codes, in report order.
CREATE FUNCTION hon.claire_kpi_codes() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT ARRAY['NEW_LEADS','WON_LEADS','LOST_LEADS','REGISTRATIONS','NEW_MEMBERSHIPS','ENDED_MEMBERSHIPS','CLASSES_ATTENDED','STUDENTS_ATTENDING','ACTIVE_MEMBERSHIPS']
$$;

-- {period: LAST_7_DAYS | LAST_30_DAYS, focus: '' or 1..300}.
CREATE FUNCTION hon.claire_kpi_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(p,ARRAY['focus','period'])
    AND jsonb_typeof(p->'period')='string' AND (p->>'period') IN ('LAST_7_DAYS','LAST_30_DAYS')
    AND jsonb_typeof(p->'focus')='string' AND ((p->>'focus')='' OR hon.alex_plan_line_ok(p->>'focus',300))
$$;

-- {summary ≤400, notes 1..9 {kpi code, note ≤200} one per KPI, watch 0..4 {title ≤120, detail ≤300}, actions 1..4 {title ≤120, detail ≤300}}.
CREATE FUNCTION hon.claire_kpi_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(r,ARRAY['actions','notes','summary','watch'])
    AND jsonb_typeof(r->'summary')='string' AND hon.alex_plan_line_ok(r->>'summary',400)
    AND jsonb_typeof(r->'notes')='array' AND jsonb_array_length(r->'notes') BETWEEN 1 AND 9
    AND jsonb_typeof(r->'watch')='array' AND jsonb_array_length(r->'watch') BETWEEN 0 AND 4
    AND jsonb_typeof(r->'actions')='array' AND jsonb_array_length(r->'actions') BETWEEN 1 AND 4
    AND octet_length(convert_to(r::text,'UTF8'))<=12288
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'notes') t WHERE NOT (
      hon.alex_plan_keys_are(t,ARRAY['kpi','note'])
      AND jsonb_typeof(t->'kpi')='string' AND (t->>'kpi')=ANY(hon.claire_kpi_codes())
      AND jsonb_typeof(t->'note')='string' AND hon.alex_plan_line_ok(t->>'note',200)))
    AND (SELECT count(DISTINCT t->>'kpi') FROM jsonb_array_elements(r->'notes') t)=jsonb_array_length(r->'notes')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((r->'watch')||(r->'actions')) t WHERE NOT (
      hon.alex_plan_keys_are(t,ARRAY['detail','title'])
      AND jsonb_typeof(t->'title')='string' AND hon.alex_plan_line_ok(t->>'title',120)
      AND jsonb_typeof(t->'detail')='string' AND hon.alex_plan_line_ok(t->>'detail',300)))
$$;

-- The requester for a command: Claire's capability (reporting.view) and AI planning at the session school, and Complete.
CREATE FUNCTION hon.claire_kpi_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid; school uuid; actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  IF current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI' OR coalesce(current_setting('app.hon_action_request_id',true),'')<>''
    OR coalesce(current_setting('app.hon_delegated_by_principal_id',true),'')<>'' OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN
    RAISE EXCEPTION 'CLAIRE_KPI_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  org := hon.current_organization_id(); school := hon.current_school_id();
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    WHERE u.external_subject=p_subject;
  IF actor IS NULL OR NOT hon.principal_has_school_permission(actor,org,school,'reporting.view')
    OR NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier='COMPLETE' AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'CLAIRE_KPI_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- A reader: reporting.view at the session school; the read itself returns only the reader's own reports.
CREATE FUNCTION hon.claire_kpi_reader(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
  PERFORM hon.require_tenant_context();
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    WHERE u.external_subject=p_subject;
  IF actor IS NULL OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),'reporting.view') THEN
    RAISE EXCEPTION 'CLAIRE_KPI_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- The nine KPIs for this window and the one before it: [{kpi, current, previous}] (ACTIVE_MEMBERSHIPS is now, previous null).
CREATE FUNCTION hon.claire_kpi_count(p_days integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH w AS (
    SELECT hon.current_organization_id() org, hon.current_school_id() school, clock_timestamp() t2,
      clock_timestamp()-make_interval(days=>p_days) t1, clock_timestamp()-make_interval(days=>2*p_days) t0
  ), win AS (
    SELECT 'c' k, t1 a, t2 b, org, school FROM w UNION ALL SELECT 'p', t0, t1, org, school FROM w
  ), n AS (
    SELECT win.k,
      (SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=win.org AND l.school_id=win.school AND l.created_at>=win.a AND l.created_at<win.b) new_leads,
      (SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=win.org AND l.school_id=win.school AND l.status='WON' AND l.won_at>=win.a AND l.won_at<win.b) won_leads,
      (SELECT count(*) FROM hon.crm_leads l WHERE l.organization_id=win.org AND l.school_id=win.school AND l.status='LOST' AND l.lost_at>=win.a AND l.lost_at<win.b) lost_leads,
      (SELECT count(*) FROM hon.crm_lead_registration_conversions c WHERE c.organization_id=win.org AND c.school_id=win.school AND c.created_at>=win.a AND c.created_at<win.b) registrations,
      (SELECT count(*) FROM hon.memberships m WHERE m.organization_id=win.org AND m.school_id=win.school AND m.state<>'DRAFT' AND m.term_started_at>=win.a AND m.term_started_at<win.b) new_memberships,
      (SELECT count(*) FROM hon.memberships m WHERE m.organization_id=win.org AND m.school_id=win.school AND m.state IN ('CANCELLED','EXPIRED') AND m.term_ends_at>=win.a AND m.term_ends_at<win.b) ended_memberships,
      (SELECT count(*) FROM hon.attendance_records r WHERE r.organization_id=win.org AND r.school_id=win.school AND r.status IN ('PRESENT','LATE','MAKEUP') AND r.recorded_at>=win.a AND r.recorded_at<win.b) classes_attended,
      (SELECT count(DISTINCT r.student_profile_id) FROM hon.attendance_records r WHERE r.organization_id=win.org AND r.school_id=win.school AND r.status IN ('PRESENT','LATE','MAKEUP') AND r.recorded_at>=win.a AND r.recorded_at<win.b) students_attending
    FROM win
  ), c AS (SELECT * FROM n WHERE k='c'), p AS (SELECT * FROM n WHERE k='p')
  SELECT jsonb_build_array(
    jsonb_build_object('kpi','NEW_LEADS','current',c.new_leads,'previous',p.new_leads),
    jsonb_build_object('kpi','WON_LEADS','current',c.won_leads,'previous',p.won_leads),
    jsonb_build_object('kpi','LOST_LEADS','current',c.lost_leads,'previous',p.lost_leads),
    jsonb_build_object('kpi','REGISTRATIONS','current',c.registrations,'previous',p.registrations),
    jsonb_build_object('kpi','NEW_MEMBERSHIPS','current',c.new_memberships,'previous',p.new_memberships),
    jsonb_build_object('kpi','ENDED_MEMBERSHIPS','current',c.ended_memberships,'previous',p.ended_memberships),
    jsonb_build_object('kpi','CLASSES_ATTENDED','current',c.classes_attended,'previous',p.classes_attended),
    jsonb_build_object('kpi','STUDENTS_ATTENDING','current',c.students_attending,'previous',p.students_attending),
    jsonb_build_object('kpi','ACTIVE_MEMBERSHIPS','current',(SELECT count(*) FROM hon.memberships m, w WHERE m.organization_id=w.org AND m.school_id=w.school
      AND m.state IN ('ACTIVE','CANCELLATION_PENDING')),'previous',NULL))
  FROM c, p
$$;

-- Count once per report (the numbers are fixed when Claire is asked), then build what Claire sees.
CREATE FUNCTION hon.claire_kpi_facts(p_subject text, p_id uuid, p_brief jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE days integer := CASE WHEN p_brief->>'period'='LAST_30_DAYS' THEN 30 ELSE 7 END; k jsonb;
BEGIN
  INSERT INTO hon.claire_kpi_report_numbers(proposal_id,organization_id,school_id,window_days,kpis)
    VALUES (p_id,hon.current_organization_id(),hon.current_school_id(),days,hon.claire_kpi_count(days)) ON CONFLICT (proposal_id) DO NOTHING;
  SELECT kpis INTO k FROM hon.claire_kpi_report_numbers WHERE proposal_id=p_id;
  RETURN jsonb_build_object('brief',p_brief,'schoolName',(SELECT left(s.name,120) FROM hon.schools s WHERE s.id=hon.current_school_id()),
    'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),'windowDays',days,'kpis',k,
    'commandCenter',hon.read_school_command_center(p_subject,hon.current_organization_id(),hon.current_school_id())->'metrics');
END $$;

CREATE FUNCTION hon.claire_kpi_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,
    'kpis',coalesce(n.kpis,'[]'::jsonb),
    'summary',CASE WHEN i.status='RESULT_RECORDED' THEN i.result->>'summary' END,
    'notes',CASE WHEN i.status='RESULT_RECORDED' THEN i.result->'notes' END,
    'watch',CASE WHEN i.status='RESULT_RECORDED' THEN i.result->'watch' END,
    'actions',CASE WHEN i.status='RESULT_RECORDED' THEN i.result->'actions' END,
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i LEFT JOIN hon.claire_kpi_report_numbers n ON n.proposal_id=i.id
  WHERE i.id=p_id AND i.kind='CLAIRE_KPI_REPORT' AND i.requested_by=p_actor
    AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_claire_kpi_report(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.claire_kpi_actor(p_subject); pid uuid;
BEGIN
  IF p_key IS NULL OR NOT hon.claire_kpi_brief_ok(p_input) THEN RAISE EXCEPTION 'CLAIRE_KPI_INVALID' USING ERRCODE='22023'; END IF;
  pid := hon.ai_text_begin('CLAIRE_KPI_REPORT',actor,actor::text||':'||p_key::text,hon.current_school_id(),NULL,p_input);
  RETURN hon.claire_kpi_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_claire_kpi_report(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CLAIRE_KPI_REPORT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, hon.claire_kpi_actor(p_subject));
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, the core claim, then the facts.
CREATE FUNCTION hon.prepare_claire_kpi_report(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.claire_kpi_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'CLAIRE_KPI_REPORT' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  RETURN inv || jsonb_build_object('request',hon.claire_kpi_facts(p_subject,p_id,i.request)::text);
END $$;

CREATE FUNCTION hon.fail_claire_kpi_report(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CLAIRE_KPI_REPORT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

CREATE FUNCTION hon.record_claire_kpi_report(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CLAIRE_KPI_REPORT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.alex_plan_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.claire_kpi_ok(proposal) THEN
    proposal := jsonb_build_object('summary','','notes','[]'::jsonb,'watch','[]'::jsonb,'actions','[]'::jsonb);
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END || to_jsonb('The answer was not a KPI report.'::text);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.claire_kpi_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The reader's own newest 20 reports, or one of them by id.
CREATE FUNCTION hon.read_claire_kpi_reports(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.claire_kpi_reader(p_subject); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.claire_kpi_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.claire_kpi_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='CLAIRE_KPI_REPORT' AND requested_by=actor
      AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY created_at DESC, id LIMIT 20) x),'[]'::jsonb);
END $$;

-- DISMISSED. The requester only.
CREATE FUNCTION hon.close_claire_kpi_report(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.claire_kpi_reader(p_subject);
BEGIN
  IF p_status IS DISTINCT FROM 'DISMISSED' THEN RAISE EXCEPTION 'CLAIRE_KPI_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CLAIRE_KPI_REPORT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.claire_kpi_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the seven entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.claire_kpi_codes()','hon.claire_kpi_brief_ok(jsonb)','hon.claire_kpi_ok(jsonb)','hon.claire_kpi_actor(text)','hon.claire_kpi_reader(text)',
    'hon.claire_kpi_count(integer)','hon.claire_kpi_facts(text,uuid,jsonb)','hon.claire_kpi_view(uuid,uuid)','hon.begin_claire_kpi_report(text,jsonb,uuid)',
    'hon.plan_claire_kpi_report(text,uuid)','hon.prepare_claire_kpi_report(text,uuid,uuid,boolean)','hon.fail_claire_kpi_report(text,uuid,text,text)',
    'hon.record_claire_kpi_report(text,uuid,jsonb)','hon.read_claire_kpi_reports(text,uuid)','hon.close_claire_kpi_report(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_claire_kpi_report(text,jsonb,uuid), hon.plan_claire_kpi_report(text,uuid), hon.prepare_claire_kpi_report(text,uuid,uuid,boolean),
      hon.fail_claire_kpi_report(text,uuid,text,text), hon.record_claire_kpi_report(text,uuid,jsonb), hon.read_claire_kpi_reports(text,uuid),
      hon.close_claire_kpi_report(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
