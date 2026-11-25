BEGIN;

-- Conversation AI "Try it" test chat, piece CE2 (0687, allocated by the coordinator 2026-11-19; 0546 released).
-- Spec: docs/architecture/CONVERSATION_AI_EASY_SETUP.md section 6. A staff member with conversation.ai.configure types a
-- question a family might send and sees how Chad, the school's front-desk AI, would answer from the school's own training
-- (0420 knowledge pack). The answer is shown only to that staff member: nothing is sent, and no conversation, contact or
-- lead is read or touched.
--
-- This is one more kind (CONVERSATION_TEST) on the shared AI text caller (0550 hon.ai_text_proposals), which owns the one
-- S4 wiring: committed credits, school cost, open holds, the HQ UNKNOWN queue and resolution, late expenses and per-school
-- usage all count it already. This migration adds the kind row, its actor gate, its facts reader, its result validator
-- and six entry points. No shared S4 function is rewritten.
--   T1  Actor: hon.require_conversation_ai_actor(subject, true) (0420), plus the planner's own rules checked early so the
--       owner learns before anything is planned: ai.invocation.plan, Chad's capability (crm.assistant.follow_up_draft) and
--       the live Complete entitlement. plan_ai_invocation decides them again.
--   T2  The HQ Conversation AI program switch and the school's channel modes are NOT required: a test reaches no family
--       (owner request 2026-11-19, "make it easy"). S4 still decides pause, access, the school's AI limit and the
--       organization budget in the core prepare.
--   T3  Burst guard: 30 test questions per staff member per rolling 10 minutes, counted under a per-staff lock.
--   T4  Route: agent chad, task DRAFT_FOLLOW_UP (HQ's CHAD_SALES task profile). Fixed budgets in the kind row.
--   T5  Facts: built inside prepare from hon.school_ai_knowledge (0420) only, in a closed trimmed shape under 9,000 bytes.
--       The API sends no facts. The question and the facts are untrusted data to the provider.
--   T6  A recorded answer is closed APPLIED at once (shown is the whole use). A paid answer outside the closed shape is
--       stored empty and RESULT_REJECTED with its usage; it is never turned into UNKNOWN.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.ai_text_proposals') IS NULL OR to_regprocedure('hon.require_conversation_ai_actor(text,boolean)') IS NULL
    OR to_regprocedure('hon.school_ai_knowledge(uuid,uuid)') IS NULL OR to_regprocedure('hon.hon_reply_complete_live(uuid)') IS NULL
    OR EXISTS (SELECT 1 FROM hon.ai_text_kinds WHERE kind='CONVERSATION_TEST') THEN
    RAISE EXCEPTION '0687 requires 0210, 0420 and 0550 and applies once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('CONVERSATION_TEST','chad','DRAFT_FOLLOW_UP',12000,600,20000,4096,'HUMAN_UI','CONVERSATION_AI_TEST','CONVERSATION_TEST');

-- True when the actor may run a test now (T1). Never raises; the caller has already proved the 0420 actor.
CREATE FUNCTION hon.conversation_ai_test_allowed(p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT p_actor IS NOT NULL
    AND hon.principal_has_school_permission(p_actor,hon.current_organization_id(),hon.current_school_id(),'ai.invocation.plan')
    AND hon.principal_has_school_permission(p_actor,hon.current_organization_id(),hon.current_school_id(),'crm.assistant.follow_up_draft')
    AND hon.hon_reply_complete_live(hon.current_organization_id())
$$;

CREATE FUNCTION hon.conversation_ai_test_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_conversation_ai_actor(p_subject, true);
BEGIN
  IF NOT hon.conversation_ai_test_allowed(actor) THEN RAISE EXCEPTION 'CONVERSATION_AI_TEST_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- The facts Chad sees (T5): fixed sections and keys, capped counts and lengths. Documents, then articles, then the
-- oldest answers, then rules and plans are dropped until it fits 9,000 bytes.
CREATE FUNCTION hon.conversation_ai_test_facts(p_org uuid, p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE k jsonb := hon.school_ai_knowledge(p_org, p_school); cap constant integer := 9000;
  s hon.school_conversation_ai_settings%ROWTYPE; pack jsonb; n integer;
BEGIN
  SELECT * INTO s FROM hon.school_conversation_ai_settings x WHERE x.organization_id = p_org AND x.school_id = p_school;
  pack := jsonb_build_object(
    'school', coalesce(k->'school'->>'name', 'the school'),
    'tone', k->>'tone',
    'languages', k->'languages',
    'replyMaxChars', coalesce(s.sms_max_chars, 500),
    'handoffWords', coalesce(to_jsonb(s.handoff_words), '["human","manager","cancel","refund","billing"]'::jsonb),
    'rules', coalesce((SELECT jsonb_agg(left(x->>'text', 300)) FROM (SELECT x FROM jsonb_array_elements(k->'instructions') x LIMIT 12) z), '[]'::jsonb),
    'answers', coalesce((SELECT jsonb_agg(jsonb_build_object('q', left(x->>'question', 200), 'a', left(x->>'answer', 400)))
      FROM (SELECT x FROM jsonb_array_elements(k->'faqs') WITH ORDINALITY e(x, i) ORDER BY i DESC LIMIT 40) z), '[]'::jsonb),
    'plans', coalesce((SELECT jsonb_agg(jsonb_build_object('name', left(x->>'name', 80), 'price', (x->>'priceMinor')::bigint, 'currency', x->>'currency',
        'billing', x->>'billing')) FROM (SELECT x FROM jsonb_array_elements(k->'plans') x LIMIT 12) z), '[]'::jsonb),
    'bookingTypes', coalesce((SELECT jsonb_agg(jsonb_build_object('name', left(x->>'name', 80), 'minutes', (x->>'durationMinutes')::integer))
      FROM (SELECT x FROM jsonb_array_elements(k->'bookingTypes') x LIMIT 8) z), '[]'::jsonb),
    'articles', coalesce((SELECT jsonb_agg(jsonb_build_object('title', left(x->>'title', 100), 'text', left(x->>'text', 500)))
      FROM (SELECT x FROM jsonb_array_elements(k->'articles') x LIMIT 4) z), '[]'::jsonb),
    'documents', coalesce((SELECT jsonb_agg(jsonb_build_object('title', left(x->>'title', 100), 'text', left(x->>'text', 1200)))
      FROM (SELECT x FROM jsonb_array_elements(k->'documents') x LIMIT 3) z), '[]'::jsonb));
  IF octet_length(convert_to(pack::text,'UTF8')) > cap THEN pack := jsonb_set(pack, '{documents}', '[]'::jsonb); END IF;
  IF octet_length(convert_to(pack::text,'UTF8')) > cap THEN pack := jsonb_set(pack, '{articles}', '[]'::jsonb); END IF;
  -- Newest answers are listed first; drop from the end (the oldest) until it fits.
  n := jsonb_array_length(pack->'answers');
  WHILE octet_length(convert_to(pack::text,'UTF8')) > cap AND n > 0 LOOP
    n := n - 1;
    pack := jsonb_set(pack, '{answers}', coalesce((SELECT jsonb_agg(x ORDER BY i) FROM jsonb_array_elements(pack->'answers') WITH ORDINALITY e(x, i) WHERE i <= n), '[]'::jsonb));
  END LOOP;
  IF octet_length(convert_to(pack::text,'UTF8')) > cap THEN pack := jsonb_set(jsonb_set(pack, '{rules}', '[]'::jsonb), '{plans}', '[]'::jsonb); END IF;
  RETURN pack;
END $$;

-- The closed answer shape: {reply: 1..1600 characters, needsStaff: boolean}.
CREATE FUNCTION hon.conversation_ai_test_answer_ok(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT r IS NOT NULL AND jsonb_typeof(r)='object'
    AND coalesce((SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(r) x), ARRAY[]::text[]) = ARRAY['needsStaff','reply']
    AND jsonb_typeof(r->'reply')='string' AND length(btrim(r->>'reply')) BETWEEN 1 AND 1600 AND jsonb_typeof(r->'needsStaff')='boolean'
$$;

-- Why a new test cannot be answered by AI now, or NULL. Closed reasons only; never a ceiling, spend or route name.
CREATE FUNCTION hon.conversation_ai_test_unavailable_reason(p_actor uuid, p_ready boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); at timestamptz := clock_timestamp();
BEGIN
  IF NOT hon.conversation_ai_test_allowed(p_actor) THEN RETURN 'NOT_INCLUDED'; END IF;
  IF hon.ai_spend_allowed(org, hon.current_school_id(), at, 'AGENT_INFERENCE') IS NOT NULL THEN RETURN 'PAUSED'; END IF;
  IF NOT coalesce(p_ready, false) THEN RETURN 'NOT_CONFIGURED'; END IF;
  IF hon.ai_org_committed_credits(org, at) + 13 > hon.ai_org_ceiling(org, at) THEN RETURN 'BUDGET_REACHED'; END IF;
  RETURN NULL;
END $$;

-- One test as the page shows it. Only the requester ever sees it (every reader filters by requester).
CREATE FUNCTION hon.conversation_ai_test_view(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,
    'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN'
      WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN 'ANSWERED'
      WHEN i.status IN ('PENDING','SENDING') THEN 'WORKING'
      WHEN i.status IN ('RESULT_REJECTED','DISMISSED') THEN 'NOT_ANSWERED'
      ELSE i.status END,
    'reason',CASE
      WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'OUTCOME_UNKNOWN'
      WHEN i.status IN ('PENDING','SENDING','RESULT_RECORDED','APPLIED') THEN NULL
      WHEN i.reason='CUSTOMER_BUDGET_EXCEEDED' THEN 'BUDGET_REACHED'
      WHEN i.reason='AI_SPEND_STOPPED' THEN 'PAUSED'
      WHEN i.status='CONFIGURATION_REQUIRED' OR i.reason IN ('NO_ELIGIBLE_ROUTE','UNSUPPORTED_PROVIDER','ROUTE_STALE','CONFIGURATION_REQUIRED') THEN 'NOT_CONFIGURED'
      WHEN i.status='UNKNOWN' THEN 'OUTCOME_UNKNOWN'
      ELSE 'NOT_ANSWERED' END,
    'question',i.request->>'question',
    'reply',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'reply' END,
    'needsStaff',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN (i.result->>'needsStaff')::boolean END,
    'askedAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i
  WHERE i.id=p_id AND i.kind='CONVERSATION_TEST' AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Entry points (granted to hon_runtime). A direct human only; the requester alone sees and moves their own tests.
-- ---------------------------------------------------------------------------------------------------------------
-- p_input = {question}. A new question, or the replay of the same question under the same key (a different question
-- under that key is IDEMPOTENCY_KEY_REUSED through the core's AI_TEXT_PROPOSAL_REPLAY_SWAP).
CREATE FUNCTION hon.begin_conversation_ai_test(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.conversation_ai_test_actor(p_subject); q text; origin text; pid uuid; n integer;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR coalesce((SELECT array_agg(x) FROM jsonb_object_keys(p_input) x), ARRAY[]::text[]) <> ARRAY['question']
    OR jsonb_typeof(p_input->'question')<>'string' THEN RAISE EXCEPTION 'CONVERSATION_AI_TEST_INVALID' USING ERRCODE='22023'; END IF;
  q := p_input->>'question';
  IF q<>btrim(q) OR length(q) NOT BETWEEN 1 AND 500 OR q ~ '[\x01-\x09\x0b-\x1f\x7f]' THEN RAISE EXCEPTION 'CONVERSATION_AI_TEST_INVALID' USING ERRCODE='22023'; END IF;
  origin := actor::text||':'||p_key::text;
  -- T3, counted under one lock per staff member so two tabs cannot both pass at 29.
  PERFORM pg_advisory_xact_lock(hashtextextended('conversation_ai.test.burst:'||actor::text,0));
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE kind='CONVERSATION_TEST' AND origin_key=origin) THEN
    SELECT count(*) INTO n FROM hon.ai_text_proposals WHERE kind='CONVERSATION_TEST' AND requested_by=actor
      AND organization_id=hon.current_organization_id() AND created_at>clock_timestamp()-interval '10 minutes';
    IF n>=30 THEN RAISE EXCEPTION 'CONVERSATION_AI_TEST_BUSY' USING ERRCODE='54000'; END IF;
  END IF;
  pid := hon.ai_text_begin('CONVERSATION_TEST',actor,origin,NULL,NULL,jsonb_build_object('question',q));
  -- Authority again after every lock and write of the command.
  IF hon.conversation_ai_test_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'CONVERSATION_AI_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.conversation_ai_test_view(pid);
END $$;

CREATE FUNCTION hon.conversation_ai_test_planning_reference(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.conversation_ai_test_actor(p_subject);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CONVERSATION_TEST') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, actor);
END $$;

-- The final claim. The budget lock comes first, then authority, then the core claim, then the facts.
CREATE FUNCTION hon.prepare_conversation_ai_test(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.conversation_ai_test_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'CONVERSATION_TEST' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  RETURN inv || jsonb_build_object('request',jsonb_build_object('question',i.request->>'question',
    'school',hon.conversation_ai_test_facts(i.organization_id,i.school_id))::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule): a call in flight when access lapsed still records.
CREATE FUNCTION hon.fail_conversation_ai_test(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CONVERSATION_TEST') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, answer}. An answer outside the closed shape is stored empty and rejected with one problem line.
CREATE FUNCTION hon.record_conversation_ai_test(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); answer jsonb; problems jsonb := '[]'::jsonb; status text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='CONVERSATION_TEST') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object'
    OR coalesce((SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_result) x), ARRAY[]::text[]) <> ARRAY['answer','usage'] THEN
    RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023';
  END IF;
  answer := p_result->'answer';
  IF NOT hon.conversation_ai_test_answer_ok(answer) THEN
    answer := jsonb_build_object('reply','','needsStaff',true);
    problems := to_jsonb(ARRAY['The answer was not a reply.'::text]);
  ELSE
    answer := jsonb_build_object('reply',btrim(answer->>'reply'),'needsStaff',answer->'needsStaff');
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', answer, problems);
  -- T6: shown is the whole use of a test answer.
  IF status='RESULT_RECORDED' THEN PERFORM hon.ai_text_close(p_id, actor, 'APPLIED'); END IF;
  RETURN hon.conversation_ai_test_view(p_id) || jsonb_build_object('recorded',status);
END $$;

-- What the page shows: whether AI can answer now (or why not), and the staff member's own last 10 tests, newest first.
-- Readable by anyone with conversation.ai.configure, so the page can say why the test is not available.
CREATE FUNCTION hon.read_conversation_ai_test(p_subject text, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_conversation_ai_actor(p_subject, true); why text;
BEGIN
  why := hon.conversation_ai_test_unavailable_reason(actor, p_ready);
  RETURN jsonb_build_object('mode',CASE WHEN why IS NULL THEN 'AI' ELSE 'UNAVAILABLE' END,'reason',why,
    'tests',coalesce((SELECT jsonb_agg(hon.conversation_ai_test_view(x.id) ORDER BY x.created_at DESC, x.id DESC)
      FROM (SELECT id, created_at FROM hon.ai_text_proposals WHERE kind='CONVERSATION_TEST' AND requested_by=actor
        AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() ORDER BY created_at DESC, id DESC LIMIT 10) x),'[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: deny first, then exactly the six entry points for the runtime role.
-- ---------------------------------------------------------------------------------------------------------------
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.conversation_ai_test_allowed(uuid)','hon.conversation_ai_test_actor(text)','hon.conversation_ai_test_facts(uuid,uuid)',
    'hon.conversation_ai_test_answer_ok(jsonb)','hon.conversation_ai_test_unavailable_reason(uuid,boolean)','hon.conversation_ai_test_view(uuid)',
    'hon.begin_conversation_ai_test(text,jsonb,uuid)','hon.conversation_ai_test_planning_reference(text,uuid)',
    'hon.prepare_conversation_ai_test(text,uuid,uuid,boolean)','hon.fail_conversation_ai_test(text,uuid,text,text)',
    'hon.record_conversation_ai_test(text,uuid,jsonb)','hon.read_conversation_ai_test(text,boolean)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_conversation_ai_test(text,jsonb,uuid), hon.conversation_ai_test_planning_reference(text,uuid),
      hon.prepare_conversation_ai_test(text,uuid,uuid,boolean), hon.fail_conversation_ai_test(text,uuid,text,text),
      hon.record_conversation_ai_test(text,uuid,jsonb), hon.read_conversation_ai_test(text,boolean) TO hon_runtime;
  END IF;
END $$;

COMMIT;
