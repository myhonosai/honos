BEGIN;

-- Maya check-in drafts that send once approved, P8 (0649). Spec: docs/architecture/MAYA_CHECK_IN_DRAFT_SEND.md and
-- /mnt/project-files/ai-agents-switch-on/P7_P8_SEND_APPROVED_DRAFTS.md. Owner decision 2026-11-22 07:13Z (David): "Send
-- automatically once approved", with verbal approval allowed. A staff member asks Maya to write a check-in text or email for one
-- student on the at-risk list (0259). Maya sees the at-risk numbers only (level, score, factor codes and counts; never a name,
-- contact, family or amount) and answers with a draft. The staff member may edit it, picks who gets it (the student, or the
-- billing contact), and now or a time up to 30 days ahead, then approves it by button or by voice. Approval queues exactly one
-- message through the ordinary communication queue (0047, origin AI_APPROVED_DRAFT from 0647); the 0243/0248 delivery worker
-- sends it at its time with its own consent, address, quiet-hours, sender and STOP checks. Nothing is sent without approval.
-- A new kind on the shared AI text proposals (0550), built like Maya renewal prep (0646). The 0550 core, every S4 function and
-- every 0647 object are unchanged.
--   C1 Who asks: a direct human with Maya (retention.review.read, 0259 rules, Complete), communication.message.queue and
--      ai.invocation.plan at the session school, for a membership that is on the at-risk list now. The planner enforces the
--      per-staff Maya switch (0635) on every Maya call.
--   C2 Facts: the channel, an optional note, the school name, the local date and the student's at-risk row without the tuition
--      factor. Fixed when asked.
--   C3 Answer: {summary, message, subject}. A text message is at most 480 characters with no subject; an email is at most 2,000
--      characters with a subject. "[First name]" may appear and becomes the recipient's first name when queued. No links,
--      email addresses or control characters.
--   C4 Approve: the requester only (their own command, as if they wrote the text themselves), with the final text, the
--      recipient, the time and the method (BUTTON, or VOICE with the voice turn id). The recipient must have OPTED_IN consent and
--      an address on that channel now, and at most 3 approved-draft messages per contact per 24 hours (shared with Chad, 0647).
--      A refused check queues nothing and leaves the draft open. An exact retry replays.
--   C5 Cancel: the requester, before the delivery worker claims the message.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Maya check-in drafts require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Maya check-in drafts require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.ai_draft_reachable(uuid,text)') IS NULL OR to_regprocedure('hon.read_maya_at_risk_students(text,jsonb)') IS NULL
    OR to_regprocedure('hon.begin_maya_renewal_prep(text,jsonb,uuid)') IS NULL OR to_regprocedure('hon.alex_plan_line_ok(text,integer)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM hon.permissions WHERE code='communication.message.queue')
    OR to_regprocedure('hon.begin_maya_check_in_draft(text,jsonb,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Maya check-in drafts require migrations 0259, 0639, 0646 and 0647 and must apply once';
  END IF;
END $$;

INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('MAYA_CHECK_IN_DRAFT','maya','DRAFT_FOLLOW_UP',6000,2000,60000,8192,'HUMAN_UI','SCHOOL','RETENTION');

-- The student Maya wrote for, and the at-risk numbers she saw, fixed when asked.
CREATE TABLE hon.maya_check_in_targets (
  proposal_id uuid PRIMARY KEY REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES hon.memberships(id) ON DELETE RESTRICT,
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=4096)
);
-- What approval queued: one message per draft, at most.
CREATE TABLE hon.maya_check_in_sends (
  proposal_id uuid PRIMARY KEY REFERENCES hon.ai_text_proposals(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  recipient text NOT NULL CHECK (recipient IN ('STUDENT','BILLING_CONTACT')),
  recipient_person_id uuid NOT NULL,
  message_id uuid NOT NULL UNIQUE,
  channel text NOT NULL CHECK (channel IN ('SMS','EMAIL')),
  scheduled_at timestamptz NOT NULL,
  edited boolean NOT NULL,
  approved_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approval_method text NOT NULL CHECK (approval_method IN ('BUTTON','VOICE')),
  voice_turn_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  cancelled_by uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  UNIQUE (organization_id, school_id, approved_by, idempotency_key),
  FOREIGN KEY (recipient_person_id, organization_id, school_id) REFERENCES hon.people(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (message_id, organization_id, school_id) REFERENCES hon.communication_messages(id, organization_id, school_id) ON DELETE RESTRICT,
  CHECK ((approval_method='VOICE') = (voice_turn_id IS NOT NULL)),
  CHECK ((cancelled_by IS NULL) = (cancelled_at IS NULL))
);

-- Targets never change; a send row changes only once, from not cancelled to cancelled.
CREATE FUNCTION hon.guard_maya_check_in_rows() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='maya_check_in_sends' THEN
    IF to_jsonb(OLD)->'cancelled_at'='null'::jsonb AND to_jsonb(NEW)->'cancelled_at'<>'null'::jsonb AND to_jsonb(NEW)->'cancelled_by'<>'null'::jsonb
      AND (to_jsonb(NEW)-ARRAY['cancelled_by','cancelled_at'])=(to_jsonb(OLD)-ARRAY['cancelled_by','cancelled_at']) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'MAYA_CHECK_IN_ROWS_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER maya_check_in_targets_guard BEFORE UPDATE OR DELETE ON hon.maya_check_in_targets FOR EACH ROW EXECUTE FUNCTION hon.guard_maya_check_in_rows();
CREATE TRIGGER maya_check_in_targets_no_truncate BEFORE TRUNCATE ON hon.maya_check_in_targets FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_maya_check_in_rows();
CREATE TRIGGER maya_check_in_sends_guard BEFORE UPDATE OR DELETE ON hon.maya_check_in_sends FOR EACH ROW EXECUTE FUNCTION hon.guard_maya_check_in_rows();
CREATE TRIGGER maya_check_in_sends_no_truncate BEFORE TRUNCATE ON hon.maya_check_in_sends FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_maya_check_in_rows();
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.maya_check_in_targets','hon.maya_check_in_sends'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- A message body: 1..n characters, lines allowed (at most one blank line in a row), no other control or invisible characters,
-- no secrets, links or email addresses, and no space or line break at either end.
CREATE FUNCTION hon.maya_check_in_text_ok(v text, n integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT v IS NOT NULL AND v=btrim(v,E' \t\n\r ') AND position(E'\n\n\n' IN v)=0 AND position(E'\r' IN v)=0
    AND replace(v,E'\n','') !~ '[[:cntrl:]​-‏‪-‮⁠-⁯﻿]'
    AND hon.marketing_safe_text(replace(v,E'\n',' '),n)
    AND v !~* '(https?://|www\.|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})'
$$;
-- A one-line field ending in no Unicode edge space (the stricter of 0639 and 0080).
CREATE FUNCTION hon.maya_check_in_line_ok(v text, n integer) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_line_ok(v,n) AND v=btrim(v,E'                  　')
    AND v !~* '(https?://|www\.|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})'
$$;

-- {membershipId: lower-case uuid, channel: SMS | EMAIL, note: 0..300 (empty allowed)}.
CREATE FUNCTION hon.maya_check_in_brief_ok(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(p,ARRAY['channel','membershipId','note'])
    AND jsonb_typeof(p->'membershipId')='string' AND (p->>'membershipId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND jsonb_typeof(p->'channel')='string' AND (p->>'channel') IN ('SMS','EMAIL')
    AND jsonb_typeof(p->'note')='string' AND ((p->>'note')='' OR hon.maya_check_in_line_ok(p->>'note',300))
$$;

-- What an answer may hold for a channel.
CREATE FUNCTION hon.maya_check_in_ok(r jsonb, p_channel text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
  SELECT hon.alex_plan_keys_are(r,ARRAY['message','subject','summary'])
    AND jsonb_typeof(r->'summary')='string' AND hon.maya_check_in_line_ok(r->>'summary',300)
    AND jsonb_typeof(r->'message')='string' AND hon.maya_check_in_text_ok(r->>'message',CASE WHEN p_channel='EMAIL' THEN 2000 ELSE 480 END)
    AND jsonb_typeof(r->'subject')='string'
    AND CASE WHEN p_channel='EMAIL' THEN hon.maya_check_in_line_ok(r->>'subject',120) ELSE (r->>'subject')='' END
    AND octet_length(convert_to(r::text,'UTF8'))<=8192
$$;

-- The reader: Maya's capability (0259 direct-human rules, Complete) and message queueing at the session school.
CREATE FUNCTION hon.maya_check_in_reader(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_maya_actor(p_subject,'retention.review.read');
BEGIN
  IF NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),'communication.message.queue') THEN
    RAISE EXCEPTION 'MAYA_CHECK_IN_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- The requester for a new draft: the reader plus AI planning at the session school.
CREATE FUNCTION hon.maya_check_in_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_check_in_reader(p_subject);
BEGIN
  IF NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),'ai.invocation.plan') THEN
    RAISE EXCEPTION 'MAYA_CHECK_IN_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- The student's row on the at-risk list now (0259 rules, read as the asking person), or NULL. At most 20 pages of 50.
CREATE FUNCTION hon.maya_check_in_at_risk_row(p_subject text, p_membership uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE q jsonb := '{}'; page jsonb; hit jsonb; n integer := 0;
BEGIN
  LOOP
    page := hon.read_maya_at_risk_students(p_subject, q);
    SELECT x INTO hit FROM jsonb_array_elements(page->'items') x WHERE x->>'membershipId'=p_membership::text;
    IF hit IS NOT NULL THEN RETURN hit; END IF;
    n := n+1;
    EXIT WHEN page->>'nextAfter' IS NULL OR n>=20;
    q := jsonb_build_object('after',page->>'nextAfter');
  END LOOP;
  RETURN NULL;
END $$;

-- Who may get the message: the student, and the billing contact when that is someone else. Shown to the requester only.
CREATE FUNCTION hon.maya_check_in_recipient(p_membership uuid, p_recipient text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE p_recipient WHEN 'STUDENT' THEN m.participant_person_id
    WHEN 'BILLING_CONTACT' THEN (SELECT b.responsible_person_id FROM hon.billing_accounts b WHERE b.id=m.billing_account_id
      AND b.organization_id=m.organization_id AND b.school_id=m.school_id AND b.responsible_person_id<>m.participant_person_id) END
  FROM hon.memberships m WHERE m.id=p_membership AND m.organization_id=hon.current_organization_id() AND m.school_id=hon.current_school_id()
$$;

CREATE FUNCTION hon.maya_check_in_view(p_id uuid, p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('id',i.id,'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
    'reason',i.reason,'brief',i.request,
    'studentName',(SELECT left(btrim(coalesce(pp.given_name,'')||' '||coalesce(pp.family_name,'')),120) FROM hon.memberships m JOIN hon.people pp ON pp.id=m.participant_person_id WHERE m.id=t.membership_id),
    'level',t.facts->>'level',
    'summary',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'summary' END,
    'message',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'message' END,
    'subject',CASE WHEN i.status IN ('RESULT_RECORDED','APPLIED') THEN i.result->>'subject' END,
    'recipients',coalesce((SELECT jsonb_agg(jsonb_build_object('recipient',r.k,'name',left(btrim(coalesce(pp.given_name,'')||' '||coalesce(pp.family_name,'')),120),
        'reachable',hon.ai_draft_reachable(pp.id,i.request->>'channel')='OK') ORDER BY r.n)
      FROM (VALUES (1,'STUDENT'),(2,'BILLING_CONTACT')) r(n,k) JOIN hon.people pp ON pp.id=hon.maya_check_in_recipient(t.membership_id,r.k)),'[]'::jsonb),
    'send',(SELECT jsonb_build_object('recipient',s.recipient,'channel',s.channel,
        'scheduledAt',to_char(s.scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'approvedAt',to_char(s.approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'approvalMethod',s.approval_method,'edited',s.edited,'cancelled',s.cancelled_at IS NOT NULL,
        'delivery',(SELECT d.status::text FROM hon.communication_deliveries d WHERE d.message_id=s.message_id))
      FROM hon.maya_check_in_sends s WHERE s.proposal_id=i.id),
    'problems',coalesce(i.result_problems,'[]'::jsonb),
    'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM hon.ai_text_proposals i JOIN hon.maya_check_in_targets t ON t.proposal_id=i.id
  WHERE i.id=p_id AND i.kind='MAYA_CHECK_IN_DRAFT' AND i.requested_by=p_actor
    AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
$$;

-- Entry points (granted to hon_runtime).
CREATE FUNCTION hon.begin_maya_check_in_draft(p_subject text, p_input jsonb, p_key uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_check_in_actor(p_subject); pid uuid; hit jsonb;
BEGIN
  IF p_key IS NULL OR NOT hon.maya_check_in_brief_ok(p_input) THEN RAISE EXCEPTION 'MAYA_CHECK_IN_INVALID' USING ERRCODE='22023'; END IF;
  pid := hon.ai_text_begin('MAYA_CHECK_IN_DRAFT',actor,actor::text||':'||p_key::text,hon.current_school_id(),NULL,p_input);
  IF NOT EXISTS(SELECT 1 FROM hon.maya_check_in_targets WHERE proposal_id=pid) THEN
    hit := hon.maya_check_in_at_risk_row(p_subject,(p_input->>'membershipId')::uuid);
    IF hit IS NULL THEN RAISE EXCEPTION 'MAYA_CHECK_IN_NOT_AT_RISK' USING ERRCODE='P0002'; END IF;
    INSERT INTO hon.maya_check_in_targets(proposal_id,organization_id,school_id,membership_id,facts)
      VALUES(pid,hon.current_organization_id(),hon.current_school_id(),(p_input->>'membershipId')::uuid,
        jsonb_build_object('level',hit->'level','score',hit->'score','membershipState',hit->'membershipState','suggestedNextStep',
          CASE WHEN hit->>'suggestedNextStep'='REVIEW_TUITION_BALANCE' THEN to_jsonb('CALL_TO_CHECK_IN'::text) ELSE hit->'suggestedNextStep' END,
          'factors',coalesce((SELECT jsonb_agg(f) FROM jsonb_array_elements(hit->'factors') f WHERE f->>'code'<>'TUITION_OVERDUE'),'[]'::jsonb)));
  END IF;
  RETURN hon.maya_check_in_view(pid,actor);
END $$;

CREATE FUNCTION hon.plan_maya_check_in_draft(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MAYA_CHECK_IN_DRAFT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(p_id, hon.maya_check_in_actor(p_subject));
END $$;

-- The final claim: the organization budget lock FIRST (0194 order), then authority, the core claim, then the facts.
CREATE FUNCTION hon.prepare_maya_check_in_draft(p_subject text, p_id uuid, p_plan uuid, p_ready boolean) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean := hon.ai_budget_lock(hon.current_organization_id()); actor uuid := hon.maya_check_in_actor(p_subject);
  i hon.ai_text_proposals%ROWTYPE; inv jsonb; facts jsonb;
BEGIN
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'MAYA_CHECK_IN_DRAFT' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  inv := hon.ai_text_prepare(p_id, actor, p_plan, p_ready, NULL);
  IF inv IS NULL THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('brief',jsonb_build_object('channel',i.request->'channel','note',i.request->'note'),'schoolName',left(s.name,120),
      'localToday',to_char(hon.membership_school_today(),'YYYY-MM-DD'),'student',t.facts)
    INTO STRICT facts FROM hon.maya_check_in_targets t JOIN hon.schools s ON s.id=t.school_id AND s.organization_id=t.organization_id WHERE t.proposal_id=i.id;
  RETURN inv || jsonb_build_object('request',facts::text);
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule).
CREATE FUNCTION hon.fail_maya_check_in_draft(p_subject text, p_id uuid, p_outcome text, p_reason text) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MAYA_CHECK_IN_DRAFT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(p_id, actor, p_outcome, p_reason);
END $$;

-- p_result = {usage, proposal, problems}. A proposal outside the closed shape for its channel is stored empty and rejected.
CREATE FUNCTION hon.record_maya_check_in_draft(p_subject text, p_id uuid, p_result jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.ai_evidence_actor(p_subject); proposal jsonb; problems jsonb; status text; ch text;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  SELECT request->>'channel' INTO ch FROM hon.ai_text_proposals WHERE id=p_id AND kind='MAYA_CHECK_IN_DRAFT';
  IF NOT FOUND THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF NOT hon.alex_plan_keys_are(p_result,ARRAY['problems','proposal','usage']) THEN RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  proposal := p_result->'proposal'; problems := p_result->'problems';
  IF NOT hon.maya_check_in_ok(proposal, ch) THEN
    proposal := jsonb_build_object('summary','','message','','subject','');
    problems := CASE WHEN jsonb_typeof(problems)='array' THEN problems ELSE '[]'::jsonb END
      || to_jsonb(CASE WHEN ch='EMAIL' THEN 'The answer was not a check-in email (up to 2,000 characters with a subject, no links).'
        ELSE 'The answer was not a check-in text (up to 480 characters, no links).' END);
  END IF;
  status := hon.ai_text_record(p_id, actor, p_result->'usage', proposal, problems);
  RETURN hon.maya_check_in_view(p_id, actor) || jsonb_build_object('recorded',status);
END $$;

-- The requester's newest 20 drafts, or one by id.
CREATE FUNCTION hon.read_maya_check_in_drafts(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_check_in_reader(p_subject); v jsonb;
BEGIN
  IF p_id IS NOT NULL THEN
    v := hon.maya_check_in_view(p_id, actor);
    IF v IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    RETURN v;
  END IF;
  RETURN coalesce((SELECT jsonb_agg(hon.maya_check_in_view(x.id, actor) ORDER BY x.created_at DESC, x.id)
    FROM (SELECT p.id, p.created_at FROM hon.ai_text_proposals p JOIN hon.maya_check_in_targets t ON t.proposal_id=p.id
      WHERE p.kind='MAYA_CHECK_IN_DRAFT' AND p.requested_by=actor
      AND p.organization_id=hon.current_organization_id() AND p.school_id=hon.current_school_id() ORDER BY p.created_at DESC, p.id LIMIT 20) x),'[]'::jsonb);
END $$;

-- C4. Approve the requester's own draft and queue exactly one message.
-- p = {recipient: STUDENT|BILLING_CONTACT, message, subject ('' for a text), sendAt: ISO ms UTC | null,
--      approvalMethod: BUTTON|VOICE, voiceTurnId: uuid (VOICE) | null (BUTTON)}.
CREATE FUNCTION hon.approve_maya_check_in_draft(p_subject text, p_id uuid, p jsonb, p_key text, p_request uuid, p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_check_in_reader(p_subject); i hon.ai_text_proposals%ROWTYPE; t hon.maya_check_in_targets%ROWTYPE;
  s hon.maya_check_in_sends%ROWTYPE; ch text; person uuid; given text; reach text; at timestamptz; msg uuid; fp text; turn uuid; content text;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 160 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'MAYA_CHECK_IN_INVALID' USING ERRCODE='22023'; END IF;
  i := hon.ai_text_row(p_id, actor);
  IF i.kind<>'MAYA_CHECK_IN_DRAFT' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  fp := encode(sha256(convert_to(coalesce(p::text,''),'UTF8')),'hex');
  SELECT * INTO s FROM hon.maya_check_in_sends WHERE proposal_id=i.id;
  IF FOUND THEN
    IF s.idempotency_key=p_key AND s.request_hash=fp THEN RETURN hon.maya_check_in_view(i.id, actor) || jsonb_build_object('replayed',true); END IF;
    RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001';
  END IF;
  IF i.status<>'RESULT_RECORDED' THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_OPEN' USING ERRCODE='40001'; END IF;
  ch := i.request->>'channel';
  IF NOT hon.alex_plan_keys_are(p,ARRAY['approvalMethod','message','recipient','sendAt','subject','voiceTurnId'])
    OR jsonb_typeof(p->'recipient')<>'string' OR (p->>'recipient') NOT IN ('STUDENT','BILLING_CONTACT')
    OR jsonb_typeof(p->'message')<>'string' OR NOT hon.maya_check_in_text_ok(p->>'message',CASE WHEN ch='EMAIL' THEN 2000 ELSE 480 END)
    OR jsonb_typeof(p->'subject')<>'string' OR NOT (CASE WHEN ch='EMAIL' THEN hon.maya_check_in_line_ok(p->>'subject',120) ELSE (p->>'subject')='' END)
    OR jsonb_typeof(p->'sendAt') NOT IN ('string','null')
    OR (jsonb_typeof(p->'sendAt')='string' AND (p->>'sendAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
    OR jsonb_typeof(p->'approvalMethod')<>'string' OR (p->>'approvalMethod') NOT IN ('BUTTON','VOICE')
    OR NOT ((p->>'approvalMethod'='BUTTON' AND jsonb_typeof(p->'voiceTurnId')='null')
      OR (p->>'approvalMethod'='VOICE' AND jsonb_typeof(p->'voiceTurnId')='string' AND (p->>'voiceTurnId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'MAYA_CHECK_IN_INVALID' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p->'sendAt')='string' THEN
    at := (p->>'sendAt')::timestamptz;
    IF to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>(p->>'sendAt') OR at>clock_timestamp()+interval '30 days' OR at<clock_timestamp()-interval '5 minutes' THEN
      RAISE EXCEPTION 'MAYA_CHECK_IN_INVALID' USING ERRCODE='22023';
    END IF;
  END IF;
  at := greatest(coalesce(at, clock_timestamp()), clock_timestamp());
  turn := nullif(p->>'voiceTurnId','')::uuid;
  SELECT * INTO STRICT t FROM hon.maya_check_in_targets WHERE proposal_id=i.id;
  PERFORM 1 FROM hon.memberships m WHERE m.id=t.membership_id AND m.organization_id=i.organization_id AND m.school_id=i.school_id FOR SHARE;
  person := hon.maya_check_in_recipient(t.membership_id, p->>'recipient');
  IF person IS NULL THEN RAISE EXCEPTION 'MAYA_CHECK_IN_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ai-draft-send-cap:'||person::text,0));
  reach := hon.ai_draft_reachable(person, ch);
  IF reach<>'OK' THEN RAISE EXCEPTION 'MAYA_CHECK_IN_%', reach USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM hon.communication_messages m WHERE m.organization_id=i.organization_id AND m.school_id=i.school_id
      AND m.recipient_person_id=person AND m.origin_kind='AI_APPROVED_DRAFT' AND m.created_at>clock_timestamp()-interval '1 day')>=3 THEN
    RAISE EXCEPTION 'MAYA_CHECK_IN_DAILY_CAP' USING ERRCODE='40001';
  END IF;
  SELECT nullif(btrim(pp.given_name),'') INTO given FROM hon.people pp WHERE pp.id=person;
  content := replace(p->>'message','[First name]',coalesce(left(given,60),'there'));
  INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,scheduled_at,created_by_principal_id,queued_by_principal_id,
      origin_kind,origin_id,email_subject)
    VALUES(i.organization_id,i.school_id,person,ch::hon.communication_message_channel,left(content,4000),'QUEUED',at,actor,actor,
      'AI_APPROVED_DRAFT',i.id,CASE WHEN ch='EMAIL' THEN replace(p->>'subject','[First name]',coalesce(left(given,60),'there')) END)
    RETURNING id INTO msg;
  INSERT INTO hon.maya_check_in_sends(proposal_id,organization_id,school_id,recipient,recipient_person_id,message_id,channel,scheduled_at,edited,approved_by,
      approval_method,voice_turn_id,idempotency_key,request_hash)
    VALUES(i.id,i.organization_id,i.school_id,p->>'recipient',person,msg,ch,at,
      (p->>'message') IS DISTINCT FROM (i.result->>'message') OR (p->>'subject') IS DISTINCT FROM (i.result->>'subject'),
      actor,p->>'approvalMethod',turn,p_key,fp);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(i.organization_id,i.school_id,actor,'HUMAN_UI','maya.check_in_draft.send_queued','MAYA_CHECK_IN_DRAFT',i.id,
      jsonb_build_object('messageId',msg,'channel',ch,'recipient',p->>'recipient','approvalMethod',p->>'approvalMethod',
        'scheduledAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'SUCCEEDED',p_request,p_correlation);
  PERFORM hon.ai_text_close(i.id, actor, 'APPLIED');
  RETURN hon.maya_check_in_view(i.id, actor) || jsonb_build_object('replayed',false);
END $$;

-- C5. Cancel the queued message before the delivery worker has claimed it. The requester only.
CREATE FUNCTION hon.cancel_maya_check_in_send(p_subject text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_check_in_reader(p_subject); s hon.maya_check_in_sends%ROWTYPE;
BEGIN
  IF hon.maya_check_in_view(p_id, actor) IS NULL THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO s FROM hon.maya_check_in_sends WHERE proposal_id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MAYA_CHECK_IN_NOT_CANCELLABLE' USING ERRCODE='40001'; END IF;
  IF s.cancelled_at IS NOT NULL THEN RETURN hon.maya_check_in_view(p_id, actor) || jsonb_build_object('replayed',true); END IF;
  PERFORM 1 FROM hon.communication_messages m WHERE m.id=s.message_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM hon.communication_deliveries d WHERE d.message_id=s.message_id) THEN RAISE EXCEPTION 'MAYA_CHECK_IN_NOT_CANCELLABLE' USING ERRCODE='40001'; END IF;
  UPDATE hon.communication_messages SET lifecycle='CANCELLED', version=version+1, updated_at=now() WHERE id=s.message_id AND lifecycle='QUEUED';
  UPDATE hon.maya_check_in_sends SET cancelled_by=actor, cancelled_at=clock_timestamp() WHERE proposal_id=p_id;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(s.organization_id,s.school_id,actor,'HUMAN_UI','maya.check_in_draft.send_cancelled','MAYA_CHECK_IN_DRAFT',p_id,jsonb_build_object('messageId',s.message_id),'SUCCEEDED',
      nullif(current_setting('app.hon_request_id',true),'')::uuid,nullif(current_setting('app.hon_request_id',true),'')::uuid);
  RETURN hon.maya_check_in_view(p_id, actor) || jsonb_build_object('replayed',false);
END $$;

-- DISMISSED. The requester only.
CREATE FUNCTION hon.close_maya_check_in_draft(p_subject text, p_id uuid, p_status text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.maya_check_in_reader(p_subject);
BEGIN
  IF p_status IS DISTINCT FROM 'DISMISSED' THEN RAISE EXCEPTION 'MAYA_CHECK_IN_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hon.ai_text_proposals WHERE id=p_id AND kind='MAYA_CHECK_IN_DRAFT') THEN RAISE EXCEPTION 'AI_TEXT_PROPOSAL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_close(p_id, actor, p_status);
  RETURN hon.maya_check_in_view(p_id, actor);
END $$;

-- Privileges: deny first, then exactly the nine entry points for the runtime role.
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.guard_maya_check_in_rows()','hon.maya_check_in_text_ok(text,integer)','hon.maya_check_in_line_ok(text,integer)',
    'hon.maya_check_in_brief_ok(jsonb)','hon.maya_check_in_ok(jsonb,text)','hon.maya_check_in_reader(text)','hon.maya_check_in_actor(text)',
    'hon.maya_check_in_at_risk_row(text,uuid)','hon.maya_check_in_recipient(uuid,text)','hon.maya_check_in_view(uuid,uuid)',
    'hon.begin_maya_check_in_draft(text,jsonb,uuid)','hon.plan_maya_check_in_draft(text,uuid)','hon.prepare_maya_check_in_draft(text,uuid,uuid,boolean)',
    'hon.fail_maya_check_in_draft(text,uuid,text,text)','hon.record_maya_check_in_draft(text,uuid,jsonb)','hon.read_maya_check_in_drafts(text,uuid)',
    'hon.approve_maya_check_in_draft(text,uuid,jsonb,text,uuid,uuid)','hon.cancel_maya_check_in_send(text,uuid)','hon.close_maya_check_in_draft(text,uuid,text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_maya_check_in_draft(text,jsonb,uuid), hon.plan_maya_check_in_draft(text,uuid), hon.prepare_maya_check_in_draft(text,uuid,uuid,boolean),
      hon.fail_maya_check_in_draft(text,uuid,text,text), hon.record_maya_check_in_draft(text,uuid,jsonb), hon.read_maya_check_in_drafts(text,uuid),
      hon.approve_maya_check_in_draft(text,uuid,jsonb,text,uuid,uuid), hon.cancel_maya_check_in_send(text,uuid), hon.close_maya_check_in_draft(text,uuid,text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
