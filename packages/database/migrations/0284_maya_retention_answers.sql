BEGIN;

-- 0284 (allocated by the coordinator 2026-11-12): Maya, Retention, part 2. Maya answers in Ask HON about one student
-- on the 0259 at-risk list: why the student is flagged and a suggested check-in message that staff send themselves.
-- Spec: /mnt/project-files/maya/MAYA_AT_RISK_SPEC.md (project files); repo doc docs/architecture/MAYA_AT_RISK_STUDENTS.md.
--
-- Maya joins the 0260 analysis specialists (one DETAILED single-step reply, task class ANALYZE, no history, no
-- suggestions, never continued) through the 0260 plug-in points, plus one typed target:
-- 1. A delegation { agentKey: 'maya', membershipId } (no other key) is a question about that membership. begin_hon_turn
--    (0260 body plus this branch only) refuses a membership that is not this exact school's; the generic analyst branch
--    refuses 'maya' without a membershipId. Target: { question, membershipId }.
-- 2. Capability (0212 binding): retention.review.read, checked by the 0260 turn code at begin, at prepare and in
--    readiness, like the other specialists.
-- 3. Facts: hon.read_specialist_school_facts gains a target argument (5-arg); the 4-arg form keeps its signature and
--    passes '{}' so Alex, Jordan and Lena are unchanged. prepare_hon_reply (0260 body plus this call only) passes the
--    turn's target. Maya's facts are that student's 0259 row read through hon.read_maya_at_risk_students itself (direct
--    human, live permission at this school, COMPLETE entitlement, tuition visibility): factor codes and numbers,
--    membership state, score, level and suggested step, or onAtRiskList=false. Never a name, contact, family, note or
--    amount. sourcePermissions are retention.review.read plus the tuition reader permission when tuition was checked, so
--    the answer is concealed if either lapses.
-- 4. Readiness (0278 body) lists RETENTION (maya), 15 credits like the other analysts. S4 is unchanged.
-- Text only. Maya does not send, schedule, record or change anything; staff copy the suggested message themselves.
-- #201 (0266) also redefines begin_hon_turn; whichever lands second rebuilds it from the merged bodies.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Maya retention answers require a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.read_maya_at_risk_students(text,jsonb)') IS NULL
     OR to_regprocedure('hon.read_specialist_school_facts(text,text,uuid,uuid)') IS NULL
     OR to_regprocedure('hon.hon_analysis_specialist(text)') IS NULL THEN
    RAISE EXCEPTION 'Apply migrations 0259 and 0260 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code = 'retention.review.read' AND is_staff_assignable) THEN
    RAISE EXCEPTION 'retention.review.read must exist as a staff-assignable permission';
  END IF;
END $$;

ALTER TABLE hon.hon_conversation_turns DROP CONSTRAINT hon_conversation_turns_agent_key_check;
ALTER TABLE hon.hon_conversation_turns ADD CONSTRAINT hon_conversation_turns_agent_key_check
  CHECK (agent_key IN ('marcus', 'claire', 'chad', 'hon', 'kai', 'alex', 'jordan', 'lena', 'maya'));
ALTER TABLE hon.hon_reply_invocations DROP CONSTRAINT hon_reply_invocations_specialist_check;
ALTER TABLE hon.hon_reply_invocations ADD CONSTRAINT hon_reply_invocations_specialist_check
  CHECK (specialist IN ('hon', 'claire', 'alex', 'jordan', 'lena', 'maya'));
-- The 0260 column check (unnamed there) is replaced by a named one that also admits Maya's permissions.
DO $$ DECLARE c text; n integer := 0; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'hon.hon_reply_invocations'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%source_permissions%' LOOP
    EXECUTE format('ALTER TABLE hon.hon_reply_invocations DROP CONSTRAINT %I', c); n := n + 1;
  END LOOP;
  IF n <> 1 THEN RAISE EXCEPTION 'Expected exactly one 0260 source_permissions check, found %', n; END IF;
END $$;
ALTER TABLE hon.hon_reply_invocations ADD CONSTRAINT hon_reply_invocations_source_permissions_closed
  CHECK (source_permissions <@ ARRAY['reporting.view', 'schedule.session.manage', 'marketing.campaign.read', 'retention.review.read',
                                     'billing.invoice.payment.record', 'billing.invoice.issue', 'billing.invoice.create']::text[]
         AND (specialist IN ('alex', 'jordan', 'lena', 'maya') OR cardinality(source_permissions) = 0)
         AND (specialist = 'maya' OR NOT source_permissions && ARRAY['retention.review.read', 'billing.invoice.payment.record',
                                                                     'billing.invoice.issue', 'billing.invoice.create']::text[]));
ALTER TABLE hon.ai_invocation_plans ADD CONSTRAINT ai_invocation_plans_maya_analysis_only
  CHECK (agent_key <> 'maya' OR task_class = 'ANALYZE') NOT VALID;
ALTER TABLE hon.ai_invocation_plans VALIDATE CONSTRAINT ai_invocation_plans_maya_analysis_only;

-- 0260 set plus Maya.
CREATE OR REPLACE FUNCTION hon.hon_analysis_specialist(p_agent text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT p_agent IN ('claire', 'alex', 'jordan', 'lena', 'maya')
$$;

-- 0260 mapping plus Maya.
CREATE OR REPLACE FUNCTION hon.ai_agent_capability_permission(p_agent text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE p_agent
    WHEN 'hon' THEN 'ai.invocation.plan'            -- HON replies: school facts still need reporting.view (else NOT_AUTHORIZED)
    WHEN 'kai' THEN 'teaching.assistant.use'        -- Teaching & Curriculum
    WHEN 'marcus' THEN 'marketing.assistant.use'    -- Marketing drafts
    WHEN 'chad' THEN 'crm.assistant.follow_up_draft' -- Lead follow-up drafts (Chad also re-checks crm.lead.read)
    WHEN 'claire' THEN 'reporting.view'             -- Business Performance analysis (K2)
    WHEN 'alex' THEN 'reporting.view'               -- General management analysis (0260)
    WHEN 'jordan' THEN 'schedule.session.manage'    -- Operations analysis (0260)
    WHEN 'lena' THEN 'marketing.campaign.read'      -- Creative & commerce analysis (0260)
    WHEN 'maya' THEN 'retention.review.read'        -- Retention: one at-risk student (0284)
  END
$$;

-- 0260 body plus Maya's branch and a target argument (internal: called by prepare_hon_reply only).
CREATE FUNCTION hon.read_specialist_school_facts(p_subject text, p_agent text, p_org uuid, p_school uuid, p_target jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); at timestamptz := clock_timestamp(); perms text[] := '{}'; f jsonb;
  ops boolean; commerce boolean; m uuid; page jsonb; row_ jsonb; after_ text; tuition text;
BEGIN
  IF p_org IS DISTINCT FROM hon.current_organization_id() OR p_school IS DISTINCT FROM hon.current_school_id()
     OR NOT hon.hon_analysis_specialist(p_agent) OR p_agent = 'claire'
     OR NOT hon.principal_has_school_permission(actor, p_org, p_school, hon.ai_agent_capability_permission(p_agent)) THEN
    RAISE EXCEPTION 'HON_SPECIALIST_CAPABILITY_REQUIRED' USING ERRCODE = '42501';
  END IF;
  ops := hon.principal_has_school_permission(actor, p_org, p_school, 'schedule.session.manage');
  commerce := hon.principal_has_school_permission(actor, p_org, p_school, 'marketing.campaign.read');
  IF p_agent = 'maya' THEN
    -- 0284: one student's 0259 risk row, read through the 0259 reader itself (which re-proves the direct human,
    -- retention.review.read at this exact school, the COMPLETE entitlement and tuition visibility). No name, contact,
    -- family, note or amount leaves this function: only the factor codes, numbers, state, score, level and step.
    IF jsonb_typeof(p_target) IS DISTINCT FROM 'object' OR jsonb_typeof(p_target->'membershipId') IS DISTINCT FROM 'string'
       OR (p_target->>'membershipId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'HON_SPECIALIST_CAPABILITY_REQUIRED' USING ERRCODE = '42501';
    END IF;
    m := lower(p_target->>'membershipId')::uuid;
    IF NOT EXISTS (SELECT 1 FROM hon.memberships x WHERE x.id = m AND x.organization_id = p_org AND x.school_id = p_school) THEN
      RAISE EXCEPTION 'HON_SPECIALIST_CAPABILITY_REQUIRED' USING ERRCODE = '42501';
    END IF;
    -- Every page is read until the student is found or the list ends, so a student anywhere on a long list is exact.
    LOOP
      page := hon.read_maya_at_risk_students(p_subject, CASE WHEN after_ IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('after', after_) END);
      SELECT x INTO row_ FROM jsonb_array_elements(page->'items') x WHERE (x->>'membershipId')::uuid = m;
      EXIT WHEN row_ IS NOT NULL OR page->>'nextAfter' IS NULL;
      after_ := page->>'nextAfter';
    END LOOP;
    f := jsonb_build_object('asOf', page->'asOf', 'localToday', page->'localToday', 'tuitionChecked', page->'tuitionChecked',
      'student', CASE WHEN row_ IS NULL THEN jsonb_build_object('onAtRiskList', false)
        ELSE jsonb_build_object('onAtRiskList', true, 'membershipState', row_->'membershipState', 'score', row_->'score',
          'level', row_->'level', 'suggestedNextStep', row_->'suggestedNextStep', 'factors', row_->'factors') END);
    perms := ARRAY['retention.review.read'];
    IF (page->>'tuitionChecked')::boolean THEN
      tuition := hon.require_tuition_reader(p_subject); perms := perms || ARRAY[tuition];
    END IF;
  ELSIF p_agent = 'jordan' THEN
    f := hon.hon_school_operations_facts(p_org, p_school, at); perms := ARRAY['schedule.session.manage'];
  ELSIF p_agent = 'lena' THEN
    f := hon.hon_school_creative_commerce_facts(p_org, p_school, at); perms := ARRAY['marketing.campaign.read'];
  ELSE
    -- Alex: the Command Center projection re-checks reporting.view itself (a refusal raises insufficient_privilege).
    f := jsonb_build_object('commandCenter', hon.read_school_command_center(p_subject, p_org, p_school)->'metrics',
      'operations', CASE WHEN ops THEN hon.hon_school_operations_facts(p_org, p_school, at) ELSE jsonb_build_object('availability', 'NOT_AUTHORIZED') END,
      'creativeCommerce', CASE WHEN commerce THEN hon.hon_school_creative_commerce_facts(p_org, p_school, at) ELSE jsonb_build_object('availability', 'NOT_AUTHORIZED') END);
    perms := ARRAY['reporting.view'] || CASE WHEN ops THEN ARRAY['schedule.session.manage'] ELSE '{}'::text[] END
                                     || CASE WHEN commerce THEN ARRAY['marketing.campaign.read'] ELSE '{}'::text[] END;
  END IF;
  RETURN jsonb_build_object('facts', f, 'sourcePermissions', to_jsonb(perms));
END $$;

-- 0260 signature kept: no target.
CREATE OR REPLACE FUNCTION hon.read_specialist_school_facts(p_subject text, p_agent text, p_org uuid, p_school uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT hon.read_specialist_school_facts(p_subject, p_agent, p_org, p_school, '{}'::jsonb)
$$;

DO $$ DECLARE r record; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.read_specialist_school_facts(text,text,uuid,uuid,jsonb)'::regprocedure,
                            'hon.read_specialist_school_facts(text,text,uuid,uuid)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r.rolname);
    END LOOP;
  END LOOP;
END $$;

-- 0260 body plus the 'maya' delegation branch (see header 1). Grants are kept by CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION hon.begin_hon_turn(p_subject text, p_conversation uuid, p_input jsonb, p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.hon_conversation_actor(p_subject); c hon.hon_conversations%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  fingerprint text; d jsonb; agent text; target jsonb; v jsonb; handoff boolean; wid uuid;
  mode text; prior hon.hon_reply_invocations%ROWTYPE; step integer := 1;
  src hon.hon_reply_invocations%ROWTYPE; orch uuid;
BEGIN
  IF p_key IS NULL OR p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR NOT p_input ?& ARRAY['text', 'delegation']
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('text', 'delegation', 'replyMode', 'continueTurnId', 'fromSuggestionTurnId', 'summarizeTurnId'))
     -- C2 reply mode and continuation belong to a question for HON only.
     OR ((p_input ? 'replyMode' OR p_input ? 'continueTurnId' OR p_input ? 'summarizeTurnId') AND jsonb_typeof(p_input->'delegation') IS DISTINCT FROM 'null')
     -- C3b: a group summary is a fresh question, never a continuation.
     OR (p_input ? 'summarizeTurnId' AND (p_input ? 'continueTurnId' OR jsonb_typeof(p_input->'summarizeTurnId') <> 'string'
         OR (p_input->>'summarizeTurnId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
     -- C3a: confirming a suggestion belongs to a delegation turn only.
     OR (p_input ? 'fromSuggestionTurnId' AND (jsonb_typeof(p_input->'delegation') IS DISTINCT FROM 'object' OR jsonb_typeof(p_input->'fromSuggestionTurnId') <> 'string'
         OR (p_input->>'fromSuggestionTurnId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
     OR (p_input ? 'replyMode' AND (jsonb_typeof(p_input->'replyMode') <> 'string' OR p_input->>'replyMode' NOT IN ('STANDARD', 'DETAILED')))
     OR (p_input ? 'continueTurnId' AND (jsonb_typeof(p_input->'continueTurnId') <> 'string'
         OR (p_input->>'continueTurnId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
     OR jsonb_typeof(p_input->'text') IS DISTINCT FROM 'string' OR NOT hon.marketing_safe_text(p_input->>'text', 2000)
     OR jsonb_typeof(p_input->'delegation') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023';
  END IF;
  d := p_input->'delegation'; agent := d->>'agentKey';
  -- Each specialist's own typed target only; the specialist re-validates and re-authorizes it.
  IF jsonb_typeof(d) = 'null' THEN
    -- C2: a question for HON. The question is the turn's own text; HON answers it, nothing is handed to a specialist.
    agent := 'hon';
    target := jsonb_build_object('question', btrim(p_input->>'text'));
    IF length(target->>'question') = 0 THEN RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023'; END IF;
  ELSIF agent = 'marcus' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'campaignId')) AND jsonb_typeof(d->'campaignId') = 'string'
     AND (d->>'campaignId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    target := jsonb_build_object('campaignId', lower(d->>'campaignId'), 'request', hon.hon_canonical_request_text(p_input->>'text'));
    IF NOT hon.marketing_safe_text(target->>'request', 2000) OR length(target->>'request') = 0 THEN RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023'; END IF;
  ELSIF agent = 'kai' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'curriculumId')) AND jsonb_typeof(d->'curriculumId') = 'string'
     AND (d->>'curriculumId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND length(btrim(p_input->>'text')) <= 1200 THEN
    -- K2: teaching is Kai's only. The legacy 'claire' teaching alias (K1, one release) is retired and refused below.
    target := jsonb_build_object('curriculumId', lower(d->>'curriculumId'), 'brief', p_input->>'text');
  ELSIF agent = 'maya' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'membershipId')) AND jsonb_typeof(d->'membershipId') = 'string'
     AND (d->>'membershipId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    -- 0284: Maya explains one at-risk student and suggests a check-in message. The target is that membership at this
    -- exact school (another school's or organization's membership is refused here and re-checked when facts are read).
    IF NOT EXISTS (SELECT 1 FROM hon.memberships m WHERE m.id = lower(d->>'membershipId')::uuid
                   AND m.organization_id = hon.current_organization_id() AND m.school_id = hon.current_school_id()) THEN
      RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023';
    END IF;
    target := jsonb_build_object('question', btrim(p_input->>'text'), 'membershipId', lower(d->>'membershipId'));
    IF length(target->>'question') = 0 THEN RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023'; END IF;
  ELSIF agent <> 'maya' AND hon.hon_analysis_specialist(agent) AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k <> 'agentKey') THEN
    -- K2: Claire, Business Performance; 0260: Alex (general management), Jordan (operations), Lena (creative & commerce).
    -- A read-only analysis of the school's own aggregate facts for that specialist; the question is the turn's own text.
    -- Nothing is drafted, sent, approved or changed.
    target := jsonb_build_object('question', btrim(p_input->>'text'));
    IF length(target->>'question') = 0 THEN RAISE EXCEPTION 'INVALID_HON_TURN' USING ERRCODE = '22023'; END IF;
  ELSIF agent = 'chad' AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN ('agentKey', 'leadId', 'expectedLeadVersion', 'purpose'))
     AND jsonb_typeof(d->'leadId') = 'string' AND (d->>'leadId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND jsonb_typeof(d->'expectedLeadVersion') = 'number' AND (d->>'expectedLeadVersion') ~ '^[1-9][0-9]{0,8}$'
     AND d->>'purpose' IN ('INTRODUCTION', 'CHECK_IN', 'TRIAL_REMINDER', 'REENGAGEMENT') THEN
    -- Chad drafts from the lead record; the human text is kept as the conversation note only and is not sent.
    target := jsonb_build_object('leadId', lower(d->>'leadId'), 'expectedLeadVersion', (d->>'expectedLeadVersion')::integer, 'purpose', d->>'purpose');
  ELSE
    RAISE EXCEPTION 'HON_DELEGATION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  fingerprint := encode(sha256(convert_to(p_input::text, 'UTF8')), 'hex');
  SELECT * INTO c FROM hon.hon_conversations WHERE id = p_conversation AND organization_id = hon.current_organization_id() AND school_id = hon.current_school_id() AND owner_principal_id = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  -- The conversation row lock can wait behind another turn: authority is held and checked again before any turn row.
  PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
  SELECT * INTO t FROM hon.hon_conversation_turns WHERE conversation_id = c.id AND idempotency_key = p_key;
  IF FOUND THEN
    IF t.request_hash <> fingerprint THEN RAISE EXCEPTION 'HON_TURN_REPLAY_SWAP' USING ERRCODE = '23505'; END IF;
  ELSE
    IF c.turn_count >= 200 THEN RAISE EXCEPTION 'HON_CONVERSATION_FULL' USING ERRCODE = '23514'; END IF;
    INSERT INTO hon.hon_conversation_turns (organization_id, school_id, conversation_id, requested_by, seq, text, agent_key, delegation, delegation_fingerprint,
        idempotency_key, request_hash)
    VALUES (c.organization_id, c.school_id, c.id, actor, c.turn_count + 1, btrim(p_input->>'text'), agent, target,
        encode(sha256(convert_to(target::text, 'UTF8')), 'hex'), p_key, fingerprint) RETURNING * INTO t;
    handoff := true;
    UPDATE hon.hon_conversations SET turn_count = turn_count + 1, updated_at = clock_timestamp() WHERE id = c.id;
    IF agent = 'hon' THEN
      -- The reply is created with the turn, under the same AI planning access gate and S4 start guard (HQ pause,
      -- exception, access state): a refused question records no turn at all.
      PERFORM hon.require_ai_invocation_plan_access();
      mode := coalesce(p_input->>'replyMode', 'STANDARD');
      IF p_input ? 'continueTurnId' THEN
        -- Continue a cut-off answer: this human's own COMPLETED, truncated HON reply in this conversation, below the
        -- step limit and not yet continued (the conversation row lock above serializes concurrent continuations).
        -- The continuation keeps the answer's mode; it is its own planned, reserved and settled call.
        SELECT * INTO prior FROM hon.hon_reply_invocations WHERE turn_id = lower(p_input->>'continueTurnId')::uuid AND conversation_id = c.id
          AND organization_id = c.organization_id AND school_id = c.school_id AND requested_by = actor FOR UPDATE;
        IF NOT FOUND OR prior.status <> 'COMPLETED' OR NOT prior.truncated OR prior.step >= hon.hon_reply_max_steps()
           OR NOT hon.hon_reply_source_allowed(prior) OR prior.specialist <> 'hon'
           OR EXISTS (SELECT 1 FROM hon.hon_reply_invocations n WHERE n.continues_turn_id = prior.turn_id)
           OR (p_input ? 'replyMode' AND p_input->>'replyMode' <> prior.reply_mode) THEN
          RAISE EXCEPTION 'HON_REPLY_NOT_CONTINUABLE' USING ERRCODE = '22023';
        END IF;
        mode := prior.reply_mode; step := prior.step + 1;
      END IF;
      -- C3b: refuse early (before any reply row references the group); the same check runs again after every write.
      IF p_input ? 'summarizeTurnId'
         AND hon.hon_orchestration_summary_facts(p_subject, c.id, actor, lower(p_input->>'summarizeTurnId')::uuid) IS NULL THEN
        RAISE EXCEPTION 'HON_GROUP_NOT_SUMMARIZABLE' USING ERRCODE = '22023';
      END IF;
      INSERT INTO hon.work_items (organization_id, school_id, work_type, status, subject_type, subject_id, payload, correlation_id)
      VALUES (c.organization_id, c.school_id, 'AI_' || (hon.hon_reply_limits(mode)->>'taskClass'), 'READY', 'HON_CONVERSATION_TURN', t.id, '{}',
        nullif(current_setting('app.hon_request_id', true), '')::uuid)
      RETURNING id INTO wid;
      INSERT INTO hon.hon_reply_invocations (organization_id, school_id, conversation_id, turn_id, requested_by, work_item_id, reply_mode, step, continues_turn_id,
          summarizes_turn_id)
      VALUES (c.organization_id, c.school_id, c.id, t.id, actor, wid, mode, step, prior.turn_id, lower(p_input->>'summarizeTurnId')::uuid);
      -- C3b: a summary of a confirmed group. Checked after every write above (the turn, count, work item and reply rows
      -- can wait on locks): the group of this human's own answer in this conversation, that answer still visible to
      -- them, and every member finished (COMPLETED, FAILED or PARTIAL; never PENDING, NEEDS_REVIEW or UNKNOWN).
      -- A refusal rolls everything back: no turn is recorded.
      IF p_input ? 'summarizeTurnId'
         AND hon.hon_orchestration_summary_facts(p_subject, c.id, actor, lower(p_input->>'summarizeTurnId')::uuid) IS NULL THEN
        RAISE EXCEPTION 'HON_GROUP_NOT_SUMMARIZABLE' USING ERRCODE = '22023';
      END IF;
    ELSIF hon.hon_analysis_specialist(agent) THEN
      -- K2/0260: an analysis specialist is never confirmed from a suggestion here (HON's closed suggestion set has none yet).
      IF p_input ? 'fromSuggestionTurnId' THEN RAISE EXCEPTION 'HON_SUGGESTION_NOT_CONFIRMABLE' USING ERRCODE = '22023'; END IF;
      -- The specialist's capability (0212 binding: Claire and Alex reporting.view, Jordan schedule.session.manage, Lena
      -- marketing.campaign.read), under the same AI planning gate and S4 start guard as HON. Checked before the reply row
      -- and again after it (the work item and reply inserts can wait on locks); a refusal rolls everything back, so no
      -- turn is recorded.
      PERFORM hon.require_ai_invocation_plan_access();
      IF NOT hon.principal_has_school_permission(actor, c.organization_id, c.school_id, hon.ai_agent_capability_permission(agent)) THEN
        RAISE EXCEPTION '%', CASE WHEN agent = 'claire' THEN 'CLAIRE_REPORTING_REQUIRED' ELSE 'HON_SPECIALIST_CAPABILITY_REQUIRED' END USING ERRCODE = '42501';
      END IF;
      INSERT INTO hon.work_items (organization_id, school_id, work_type, status, subject_type, subject_id, payload, correlation_id)
      VALUES (c.organization_id, c.school_id, 'AI_' || (hon.hon_reply_limits('DETAILED')->>'taskClass'), 'READY', 'HON_CONVERSATION_TURN', t.id, '{}',
        nullif(current_setting('app.hon_request_id', true), '')::uuid)
      RETURNING id INTO wid;
      INSERT INTO hon.hon_reply_invocations (organization_id, school_id, conversation_id, turn_id, requested_by, work_item_id, reply_mode, step, specialist)
      VALUES (c.organization_id, c.school_id, c.id, t.id, actor, wid, 'DETAILED', 1, agent);
      PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
      PERFORM hon.require_ai_invocation_plan_access();
      IF NOT hon.principal_has_school_permission(actor, c.organization_id, c.school_id, hon.ai_agent_capability_permission(agent)) THEN
        RAISE EXCEPTION '%', CASE WHEN agent = 'claire' THEN 'CLAIRE_REPORTING_REQUIRED' ELSE 'HON_SPECIALIST_CAPABILITY_REQUIRED' END USING ERRCODE = '42501';
      END IF;
    ELSIF p_input ? 'fromSuggestionTurnId' THEN
      -- C3a: confirm a suggested specialist. The source is this human's own whole, COMPLETED HON answer in this
      -- conversation, visible to them now, whose current suggestions (capability-filtered, 0214) name this agent, and
      -- the agent was not already confirmed from it. The conversation row lock above serializes confirmations.
      SELECT * INTO src FROM hon.hon_reply_invocations WHERE turn_id = lower(p_input->>'fromSuggestionTurnId')::uuid AND conversation_id = c.id
        AND organization_id = c.organization_id AND school_id = c.school_id AND requested_by = actor;
      IF NOT FOUND OR src.status <> 'COMPLETED' OR src.truncated OR NOT hon.hon_reply_visible(p_subject, src.turn_id)
         OR NOT agent = ANY (hon.hon_reply_allowed_suggestions(actor, c.organization_id, c.school_id, src.suggested_agents))
         OR EXISTS (SELECT 1 FROM hon.hon_orchestrations o JOIN hon.hon_orchestration_members m ON m.orchestration_id = o.id
                    WHERE o.source_turn_id = src.turn_id AND m.agent_key = agent) THEN
        RAISE EXCEPTION 'HON_SUGGESTION_NOT_CONFIRMABLE' USING ERRCODE = '22023';
      END IF;
      INSERT INTO hon.hon_orchestrations (organization_id, school_id, conversation_id, requested_by, source_turn_id)
      VALUES (c.organization_id, c.school_id, c.id, actor, src.turn_id) ON CONFLICT (source_turn_id) DO NOTHING;
      SELECT id INTO STRICT orch FROM hon.hon_orchestrations WHERE source_turn_id = src.turn_id;
      INSERT INTO hon.hon_orchestration_members (orchestration_id, organization_id, school_id, agent_key, turn_id)
      VALUES (orch, c.organization_id, c.school_id, agent, t.id);
      -- The group and member writes above can wait on locks, and access, a grant or the answer's visibility can
      -- lapse meanwhile. Re-validate the exact source from a fresh read before handing off: still this human's own
      -- whole COMPLETED answer at this school, visible now (which re-checks the actor), and still suggesting an agent
      -- they may use. A refusal here rolls back the turn, the count, the group and the member together. The
      -- duplicate check is not repeated: the member row this call just wrote would match it.
      IF NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations r WHERE r.turn_id = src.turn_id AND r.conversation_id = c.id
                       AND r.organization_id = c.organization_id AND r.school_id = c.school_id AND r.requested_by = actor
                       AND r.status = 'COMPLETED' AND NOT r.truncated
                       AND agent = ANY (hon.hon_reply_allowed_suggestions(actor, c.organization_id, c.school_id, r.suggested_agents)))
         OR NOT hon.hon_reply_visible(p_subject, src.turn_id) THEN
        RAISE EXCEPTION 'HON_SUGGESTION_NOT_CONFIRMABLE' USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;
  v := hon.hon_turn_view(t);
  -- HON's own answer, or an analysis specialist's (K2, 0260): both are reply invocations. A legacy 'claire' teaching turn has none.
  IF t.agent_key = 'hon' OR EXISTS (SELECT 1 FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id) THEN
    -- Only a reply that never left PENDING is handed to the reply service again; its prepare admits one caller.
    handoff := EXISTS (SELECT 1 FROM hon.hon_reply_invocations r WHERE r.turn_id = t.id AND r.status = 'PENDING');
    RETURN jsonb_build_object('turnId', t.id, 'agentKey', t.agent_key, 'delegation', NULL, 'handOff', handoff);
  END IF;
  IF handoff IS NULL THEN
    handoff := t.failure_reason IS NULL AND v->>'invocationId' IS NULL
      AND (t.handoff_claimed_at IS NULL OR t.handoff_claimed_at <= clock_timestamp() - interval '5 minutes');
  END IF;
  IF handoff THEN UPDATE hon.hon_conversation_turns SET handoff_claimed_at = clock_timestamp() WHERE id = t.id; END IF;
  RETURN jsonb_build_object('turnId', t.id, 'agentKey', hon.hon_presented_agent(t.agent_key), 'delegation', t.delegation, 'handOff', handoff);
END $$;

-- 0260 body plus the turn target passed to the facts reader (see header 3).
CREATE OR REPLACE FUNCTION hon.prepare_hon_reply(p_subject text, p_turn uuid, p_plan uuid, p_ready boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id());
  actor uuid := hon.hon_conversation_actor(p_subject); lim jsonb;
  i hon.hon_reply_invocations%ROWTYPE; p hon.ai_invocation_plans%ROWTYPE; t hon.hon_conversation_turns%ROWTYPE;
  why text; school_facts jsonb; history jsonb; facts jsonb; continuation jsonb; has_reporting boolean; derived boolean := false;
  prior hon.hon_reply_invocations%ROWTYPE; grp jsonb; notes jsonb;
  -- 0260: Alex, Jordan and Lena read their own facts through hon.read_specialist_school_facts.
  analyst boolean; spec jsonb; spec_perms text[] := '{}'; metrics jsonb;
BEGIN
  SELECT * INTO i FROM hon.hon_reply_invocations WHERE turn_id = p_turn AND organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id() AND requested_by = actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF i.status <> 'PENDING' THEN RETURN NULL; END IF;
  lim := hon.hon_reply_limits(i.reply_mode);
  -- Every row this prepare writes is locked before any decision (work item first, as the planner does), so no wait can
  -- fall between the authority checks below and the provider input leaving this function.
  PERFORM 1 FROM hon.work_items WHERE id = i.work_item_id FOR UPDATE;
  -- The row locks can wait behind a concurrent resend: conversation authority is held and checked again first.
  PERFORM hon.hon_conversation_hold_actor(p_subject, actor);
  -- After every wait above: the live-clock access gate (Complete at clock_timestamp(), not the transaction start).
  IF NOT hon.hon_reply_access(p_subject) THEN why := 'AI_ACCESS_REFUSED'; END IF;
  has_reporting := hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view');
  -- A continuation of a reporting-derived answer needs that source authority now; otherwise nothing is reserved.
  IF why IS NULL AND i.continues_turn_id IS NOT NULL THEN
    SELECT * INTO prior FROM hon.hon_reply_invocations WHERE turn_id = i.continues_turn_id AND status = 'COMPLETED';
    IF NOT FOUND OR (prior.used_reporting AND NOT has_reporting) THEN why := 'SOURCE_ACCESS_REFUSED'; END IF;
  END IF;
  -- K2: Claire analyses reporting facts only; without reporting.view now nothing is reserved or sent.
  IF why IS NULL AND i.specialist = 'claire' AND NOT has_reporting THEN why := 'SOURCE_ACCESS_REFUSED'; END IF;
  -- 0260: Alex, Jordan and Lena need their own capability now (0212 binding); without it nothing is reserved or sent.
  analyst := i.specialist NOT IN ('hon', 'claire');
  IF why IS NULL AND analyst
     AND NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, hon.ai_agent_capability_permission(i.specialist)) THEN
    why := 'SOURCE_ACCESS_REFUSED';
  END IF;
  -- C3b: a group summary needs its group still summarizable for this human now; otherwise nothing is reserved.
  IF why IS NULL AND i.summarizes_turn_id IS NOT NULL
     AND hon.hon_orchestration_summary_facts(p_subject, i.conversation_id, actor, i.summarizes_turn_id) IS NULL THEN
    why := 'GROUP_NOT_SUMMARIZABLE';
  END IF;
  IF why IS NULL THEN why := hon.ai_spend_allowed(i.organization_id, clock_timestamp(), 'AGENT_INFERENCE'); END IF;
  IF why IS NULL THEN
    IF p_plan IS NULL THEN why := 'NO_ELIGIBLE_ROUTE';
    ELSE
      SELECT * INTO p FROM hon.ai_invocation_plans WHERE id = p_plan AND organization_id = i.organization_id AND school_id = i.school_id
        AND work_item_id = i.work_item_id AND agent_key = i.specialist AND task_class = lim->>'taskClass' AND input_budget = (lim->>'inputBudget')::integer
        AND output_budget = (lim->>'outputBudget')::integer AND max_provider_cost_microunits = (lim->>'maxProviderCostMicrounits')::bigint;
      IF NOT FOUND THEN RAISE EXCEPTION 'HON_REPLY_PLAN_SWAP' USING ERRCODE = '42501'; END IF;
      IF p.provider_id <> 'OPENROUTER' THEN why := 'UNSUPPORTED_PROVIDER'; ELSIF NOT p_ready THEN why := 'CONFIGURATION_REQUIRED'; END IF;
    END IF;
  END IF;
  -- ai.budget:<org> is already held (first declaration above).
  IF why IS NULL AND hon.ai_org_committed_credits(i.organization_id, clock_timestamp()) + p.customer_credit_estimate
                     > hon.ai_org_ceiling(i.organization_id, clock_timestamp()) THEN
    why := 'CUSTOMER_BUDGET_EXCEEDED';
  END IF;
  UPDATE hon.hon_reply_invocations SET plan_id = p.id,
    status = CASE WHEN why IS NULL THEN 'SENDING' WHEN why = 'CONFIGURATION_REQUIRED' THEN 'CONFIGURATION_REQUIRED' ELSE 'BLOCKED' END,
    reason = why, reserved_credits = CASE WHEN why IS NULL THEN p.customer_credit_estimate ELSE 0 END, updated_at = clock_timestamp()
  WHERE id = i.id;
  UPDATE hon.work_items SET status = CASE WHEN why IS NULL THEN 'WORKING' ELSE 'NEEDS_ATTENTION' END, version = version + 1, updated_at = clock_timestamp()
  WHERE id = i.work_item_id;
  IF why IS NOT NULL THEN RETURN NULL; END IF;
  -- Authorized school context only (see header). The Command Center projection re-checks reporting.view itself.
  IF has_reporting AND NOT analyst THEN
    BEGIN
      school_facts := hon.read_school_command_center(p_subject, i.organization_id, i.school_id)->'metrics';
    -- A refused fresh read means no reporting authority for this whole context: no protected history either.
    EXCEPTION WHEN insufficient_privilege THEN school_facts := NULL; has_reporting := false;
    END;
    metrics := school_facts;
  ELSIF analyst THEN
    -- 0260: the specialist's own aggregate facts, read fresh; the reader re-checks every permission it uses and names
    -- them (sourcePermissions), so the answer is concealed later if any of them lapses.
    BEGIN
      spec := hon.read_specialist_school_facts(p_subject, i.specialist, i.organization_id, i.school_id,
        (SELECT x.delegation FROM hon.hon_conversation_turns x WHERE x.id = i.turn_id));
    EXCEPTION WHEN insufficient_privilege THEN spec := NULL;
    END;
    school_facts := spec->'facts';
    spec_perms := coalesce(ARRAY(SELECT jsonb_array_elements_text(spec->'sourcePermissions')), '{}');
    metrics := school_facts->'commandCenter';
  END IF;
  SELECT * INTO STRICT t FROM hon.hon_conversation_turns WHERE id = i.turn_id;
  -- K2/0260: an analysis specialist gets its facts and the question only (no conversation history).
  IF i.specialist = 'hon' THEN
  SELECT coalesce(jsonb_agg(z.h ORDER BY z.seq), '[]'::jsonb) INTO history FROM (
    SELECT x.seq, jsonb_strip_nulls(jsonb_build_object('question', left(x.text, 400),
        -- A reporting-derived earlier answer is reused only while this human still holds reporting.view.
        'answer', CASE WHEN x.agent_key = 'hon' AND (NOT r.used_reporting OR has_reporting) THEN left(r.reply_text, 600) END,
      -- Owner blueprint: a legacy 'claire' teaching delegate (no reply row) is Kai; a K2 Claire analysis is Claire's.
        'delegatedTo', CASE WHEN x.agent_key = 'claire' AND NOT EXISTS (SELECT 1 FROM hon.hon_reply_invocations c WHERE c.turn_id = x.id) THEN 'kai'
                            WHEN x.agent_key <> 'hon' THEN x.agent_key END)) h
    FROM hon.hon_conversation_turns x
    LEFT JOIN hon.hon_reply_invocations r ON r.turn_id = x.id AND r.status = 'COMPLETED'
    WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq
    ORDER BY x.seq DESC LIMIT 3) z;
  SELECT coalesce(bool_or(r.used_reporting AND has_reporting), false) INTO derived FROM (
    SELECT x.id FROM hon.hon_conversation_turns x WHERE x.conversation_id = t.conversation_id AND x.seq < t.seq ORDER BY x.seq DESC LIMIT 3) z
    JOIN hon.hon_reply_invocations r ON r.turn_id = z.id AND r.status = 'COMPLETED';
  END IF;
  -- A continuation also gets the answer's original question and the end of the part already given (data only).
  IF i.continues_turn_id IS NOT NULL THEN
    WITH RECURSIVE chain AS (
      SELECT r.turn_id, r.continues_turn_id FROM hon.hon_reply_invocations r WHERE r.turn_id = i.continues_turn_id
      UNION ALL
      SELECT r.turn_id, r.continues_turn_id FROM hon.hon_reply_invocations r JOIN chain c ON r.turn_id = c.continues_turn_id)
    SELECT jsonb_build_object('step', i.step, 'maxSteps', hon.hon_reply_max_steps(),
        'originalQuestion', (SELECT left(x.text, 2000) FROM chain c JOIN hon.hon_conversation_turns x ON x.id = c.turn_id WHERE c.continues_turn_id IS NULL),
        'previousAnswerEnd', (SELECT right(r.reply_text, 2500) FROM hon.hon_reply_invocations r WHERE r.turn_id = i.continues_turn_id AND r.status = 'COMPLETED'))
      INTO continuation;
    derived := derived OR prior.used_reporting;
  END IF;
  -- C3b: the group's recorded outcomes, read last (a source answer derived from reporting makes the context derived).
  IF i.summarizes_turn_id IS NOT NULL THEN
    grp := hon.hon_orchestration_summary_facts(p_subject, i.conversation_id, actor, i.summarizes_turn_id);
    derived := derived OR coalesce((SELECT r.used_reporting FROM hon.hon_reply_invocations r WHERE r.turn_id = i.summarizes_turn_id), false);
  END IF;
  -- Final live-clock revalidation before any context leaves prepare: access (Complete at clock_timestamp()) and, when the
  -- context carries reporting-derived material, reporting.view. A lapse here releases the reservation and sends nothing.
  why := CASE WHEN NOT hon.hon_reply_access(p_subject) THEN 'AI_ACCESS_REFUSED'
    WHEN i.summarizes_turn_id IS NOT NULL AND grp IS NULL THEN 'GROUP_NOT_SUMMARIZABLE'
    WHEN i.specialist = 'claire' AND school_facts IS NULL THEN 'SOURCE_ACCESS_REFUSED'
    WHEN analyst AND (spec IS NULL OR cardinality(spec_perms) = 0 OR EXISTS (SELECT 1 FROM unnest(spec_perms) q
      WHERE NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, q))) THEN 'SOURCE_ACCESS_REFUSED'
    WHEN NOT analyst AND (school_facts IS NOT NULL OR derived) AND NOT hon.principal_has_school_permission(actor, i.organization_id, i.school_id, 'reporting.view') THEN 'SOURCE_ACCESS_REFUSED' END;
  IF why IS NOT NULL THEN
    UPDATE hon.hon_reply_invocations SET status = 'BLOCKED', reason = why, reserved_credits = 0, updated_at = clock_timestamp() WHERE id = i.id;
    UPDATE hon.work_items SET status = 'NEEDS_ATTENTION', version = version + 1, updated_at = clock_timestamp() WHERE id = i.work_item_id;
    RETURN NULL;
  END IF;
  -- 0255: the school's saved notes (newest first) for HON answers only; Claire keeps metrics only.
  IF i.specialist = 'hon' THEN
    SELECT nullif(coalesce(jsonb_agg(n.body ORDER BY n.created_at DESC, n.id), '[]'::jsonb), '[]'::jsonb) INTO notes
    FROM hon.hon_school_notes n WHERE n.organization_id = i.organization_id AND n.school_id = i.school_id AND n.deleted_at IS NULL;
  END IF;
  facts := jsonb_strip_nulls(jsonb_build_object('school', coalesce(school_facts, jsonb_build_object('availability', 'NOT_AUTHORIZED')), 'history', history,
    'continuation', continuation, 'group', grp, 'schoolNotes', notes));
  -- 0254: the closed fact areas this context actually carries, for "Based on": AVAILABLE metrics (in the closed key
  -- order), the earlier conversation (history or a continuation) and recorded specialist results (a group).
  UPDATE hon.hon_reply_invocations SET available_sources = ARRAY(
      SELECT k FROM unnest(hon.hon_reply_source_keys()) WITH ORDINALITY s(k, n)
      WHERE (k NOT IN ('conversation', 'specialistResults') AND metrics->k->>'availability' = 'AVAILABLE')
         OR (k = 'conversation' AND (jsonb_array_length(coalesce(history, '[]'::jsonb)) > 0 OR continuation IS NOT NULL))
         OR (k = 'specialistResults' AND grp IS NOT NULL)
         OR (k = 'schoolNotes' AND notes IS NOT NULL)
      ORDER BY n)
  WHERE id = i.id;
  UPDATE hon.hon_reply_invocations SET used_reporting = CASE WHEN analyst THEN 'reporting.view' = ANY (spec_perms) ELSE school_facts IS NOT NULL OR derived END,
    source_permissions = spec_perms, context_digest = encode(sha256(convert_to(jsonb_build_object('question', t.text, 'facts', facts)::text, 'UTF8')), 'hex')
  WHERE id = i.id;
  RETURN jsonb_build_object('providerId', p.provider_id, 'modelId', p.model_id, 'providerRequestId', i.provider_request_id,
    'specialist', i.specialist, 'replyMode', i.reply_mode, 'step', i.step, 'question', t.text, 'facts', facts::text, 'inputBudget', p.input_budget, 'outputBudget', p.output_budget,
    'maxCostMicrounits', p.max_provider_cost_microunits);
END $$;

-- 0278 body plus Maya (RETENTION).
CREATE OR REPLACE FUNCTION hon.read_ai_team_readiness(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid := hon.current_organization_id(); school uuid := hon.current_school_id(); at timestamptz := clock_timestamp();
  actor uuid := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  access text; committed bigint; ceiling integer; complete boolean; agents jsonb := '[]'::jsonb; budget jsonb;
  a record; authorized boolean; denial text; route text; budget_left bigint;
BEGIN
  PERFORM hon.require_tenant_context();
  -- The caller must be the direct human of this transaction and hold AI planning at this exact school; a refusal
  -- here is the same refusal every agent would give, so nothing about the agents is disclosed to others.
  IF p_subject IS NULL OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
     OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
     OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
     OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM hon.users u JOIN hon.principals p ON p.user_id = u.id
                    WHERE u.external_subject = p_subject AND p.id = actor AND p.is_active AND p.principal_type = 'HUMAN_USER')
     OR NOT hon.principal_has_school_permission(actor, org, school, 'ai.invocation.plan') THEN
    RAISE EXCEPTION 'AI_TEAM_READINESS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  complete := EXISTS (SELECT 1 FROM hon.organization_entitlements WHERE organization_id = org AND tier = 'COMPLETE' AND status = 'ACTIVE'
                      AND effective_from <= at AND (effective_until IS NULL OR at < effective_until));
  access := hon.ai_spend_allowed(org, at, 'AGENT_INFERENCE');
  committed := hon.ai_org_committed_credits(org, at);
  ceiling := hon.ai_org_ceiling(org, at);
  FOR a IN SELECT * FROM (VALUES ('marcus', 'MARKETING', 5120::bigint, 100000::bigint, 6), ('kai', 'TEACHING', 5120, 100000, 6),
                                 ('chad', 'CHAD_FOLLOW_UP', 2648, 60000, 3), ('hon', 'HON_REPLY', 9500, 80000, 10),
                                 ('claire', 'BUSINESS_PERFORMANCE', 15000, 80000, 15), ('alex', 'GENERAL_MANAGEMENT', 15000, 80000, 15),
                                 ('jordan', 'OPERATIONS', 15000, 80000, 15), ('lena', 'CREATIVE_COMMERCE', 15000, 80000, 15),
                                 ('maya', 'RETENTION', 15000, 80000, 15)) v(agent_key, agent, units, max_cost, estimate) LOOP
    BEGIN
      IF a.agent_key = 'marcus' THEN PERFORM hon.marketing_owner(p_subject);
      ELSIF a.agent_key = 'kai' THEN PERFORM hon.require_teaching_assistant_actor(p_subject, false);
      ELSIF a.agent_key = 'chad' THEN PERFORM hon.require_chad_follow_up_actor(p_subject);
      ELSIF hon.hon_analysis_specialist(a.agent_key) THEN
        -- K2/0260: an analysis specialist needs the conversation, AI planning and its own capability (0212 binding).
        PERFORM hon.hon_conversation_actor(p_subject); PERFORM hon.require_ai_invocation_plan_access();
        IF NOT hon.principal_has_school_permission(actor, org, school, hon.ai_agent_capability_permission(a.agent_key)) THEN
          RAISE EXCEPTION 'HON_SPECIALIST_CAPABILITY_REQUIRED' USING ERRCODE = '42501';
        END IF;
      ELSE PERFORM hon.hon_conversation_actor(p_subject); PERFORM hon.require_ai_invocation_plan_access(); END IF;
      authorized := true;
    EXCEPTION WHEN insufficient_privilege OR no_data_found THEN authorized := false;
    END;
    route := hon.ai_team_route(org, school, a.units, a.max_cost);
    budget_left := ceiling - committed;
    denial := CASE WHEN NOT authorized THEN 'NOT_AUTHORIZED'
                   WHEN access IS NOT NULL THEN access
                   WHEN route IS NOT NULL THEN route
                   WHEN budget_left < a.estimate THEN 'ORGANIZATION_AI_BUDGET_REACHED'
                   ELSE NULL END;
    agents := agents || jsonb_build_object('agentKey', a.agent_key, 'agent', a.agent, 'authorized', authorized,
      'spendDecision', coalesce(access, 'ALLOWED'), 'route', coalesce(route, 'CONFIGURED'), 'requestCredits', a.estimate,
      'available', denial IS NULL, 'blockedBy', denial);
  END LOOP;
  -- Organization-wide totals only for independently verified organization-wide authority (see header).
  budget := CASE WHEN hon.ai_team_org_budget_authority(actor, org)
                 THEN jsonb_build_object('committedCredits', committed, 'ceilingCredits', hon.ai_org_display_ceiling(org, at)) END;
  RETURN jsonb_build_object('organizationId', org, 'schoolId', school, 'completeEntitlement', complete,
    'agentBudget', budget,
    'agents', agents, 'asOf', hon.saas_ts(at));
END $$;

COMMIT;
