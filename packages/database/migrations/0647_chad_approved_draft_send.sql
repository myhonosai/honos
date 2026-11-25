BEGIN;

-- Chad approved-draft sending, P7 (0647). Spec: /mnt/project-files/ai-agents-switch-on/P7_P8_SEND_APPROVED_DRAFTS.md and
-- docs/architecture/CHAD_APPROVED_DRAFT_SEND.md. Owner decision 2026-11-22 07:13Z (David): "Send automatically once approved",
-- with verbal approval allowed. Before review the requester sets a send plan on a Chad follow-up draft (text or email, now or a
-- time up to 30 days ahead). When a reviewer approves the draft (button or voice) the 0108 transition, in the same transaction,
-- queues exactly one message to the lead's contact through the ordinary communication queue (0047). The 0243/0248 delivery worker
-- sends it at its time with its own consent, address, quiet-hours, sender and STOP checks. Nothing is sent without a plan and an
-- approval; a draft without a plan behaves exactly as before.
--   S1 Plan: the requester only (0107 Chad actor), while the draft awaits approval, for a lead whose contact has OPTED_IN consent
--      and an address on that channel now. A plan is append-only (versioned); the newest counts. Removing it is a plan with
--      channel NONE.
--   S2 Queue: on APPROVED with a current plan, consent and address are checked again; then one QUEUED communication_message
--      (origin AI_APPROVED_DRAFT, scheduled_at = the plan time, at least now) is created by the reviewer, at most 3 approved-draft
--      messages per contact per 24 hours. A check that fails records the outcome and sends nothing.
--   S3 Evidence: hon.ai_draft_sends records who approved, when and how (BUTTON or VOICE with the voice turn id, from
--      app.hon_approval_method / app.hon_voice_turn_id set by the API for this decision only), the plan version and the message.
--   S4 Cancel: the requester or the reviewer may cancel a queued approved-draft message before the worker claims it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Chad approved-draft sending requires a trusted migration owner';
  END IF;
  IF to_regprocedure('hon.transition_chad_follow_up_draft(uuid,text)') IS NULL OR to_regclass('hon.communication_deliveries') IS NULL
    OR to_regprocedure('hon.begin_maya_renewal_prep(text,jsonb,uuid)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hon.communication_messages'::regclass AND conname='communication_messages_origin_kind_check'
      AND pg_get_constraintdef(oid) LIKE '%MEMBERSHIP_AGREEMENT%')
    OR to_regclass('hon.ai_draft_sends') IS NOT NULL THEN
    RAISE EXCEPTION 'Chad approved-draft sending requires migrations 0108, 0243, 0499 and 0646 and must apply once';
  END IF;
END $$;

ALTER TABLE hon.communication_messages DROP CONSTRAINT communication_messages_origin_kind_check;
ALTER TABLE hon.communication_messages ADD CONSTRAINT communication_messages_origin_kind_check
  CHECK (origin_kind IN ('STAFF','CONVERSATION_AI','CAMPAIGN','AUTOMATION','MEMBERSHIP_AGREEMENT','AI_APPROVED_DRAFT'));

-- The send plan the requester set before review. Append-only; the newest version counts.
CREATE TABLE hon.ai_draft_send_plans (
  source text NOT NULL CHECK (source='CHAD_FOLLOW_UP'),
  source_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  recipient_person_id uuid,
  channel text NOT NULL CHECK (channel IN ('SMS','EMAIL','NONE')),
  send_at timestamptz,
  set_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  PRIMARY KEY (source, source_id, version),
  UNIQUE (organization_id, school_id, set_by, idempotency_key),
  FOREIGN KEY (source_id, organization_id, school_id) REFERENCES hon.chad_follow_up_invocations(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (recipient_person_id, organization_id, school_id) REFERENCES hon.people(id, organization_id, school_id) ON DELETE RESTRICT,
  CHECK ((channel='NONE' AND recipient_person_id IS NULL AND send_at IS NULL) OR (channel<>'NONE' AND recipient_person_id IS NOT NULL))
);
-- What happened when the draft was approved: one row per draft, at most.
CREATE TABLE hon.ai_draft_sends (
  source text NOT NULL CHECK (source='CHAD_FOLLOW_UP'),
  source_id uuid NOT NULL,
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  plan_version integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('QUEUED','NO_CONSENT','NO_ADDRESS','DAILY_CAP')),
  message_id uuid,
  channel text NOT NULL CHECK (channel IN ('SMS','EMAIL')),
  scheduled_at timestamptz NOT NULL,
  approved_by uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approval_method text NOT NULL CHECK (approval_method IN ('BUTTON','VOICE')),
  voice_turn_id uuid,
  cancelled_by uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  PRIMARY KEY (source, source_id),
  UNIQUE (message_id),
  FOREIGN KEY (source, source_id, plan_version) REFERENCES hon.ai_draft_send_plans(source, source_id, version) ON DELETE RESTRICT,
  FOREIGN KEY (message_id, organization_id, school_id) REFERENCES hon.communication_messages(id, organization_id, school_id) ON DELETE RESTRICT,
  CHECK ((outcome='QUEUED') = (message_id IS NOT NULL)),
  CHECK ((approval_method='VOICE') = (voice_turn_id IS NOT NULL)),
  CHECK ((cancelled_by IS NULL) = (cancelled_at IS NULL) AND (cancelled_by IS NULL OR outcome='QUEUED'))
);
CREATE INDEX ai_draft_sends_cap ON hon.ai_draft_sends(organization_id, school_id, approved_at);

-- Plans never change; a send row changes only once, from not cancelled to cancelled.
CREATE FUNCTION hon.guard_ai_draft_send_rows() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='ai_draft_sends' THEN
    IF to_jsonb(OLD)->'cancelled_at'='null'::jsonb AND to_jsonb(NEW)->'cancelled_at'<>'null'::jsonb AND to_jsonb(NEW)->'cancelled_by'<>'null'::jsonb
      AND (to_jsonb(NEW)-ARRAY['cancelled_by','cancelled_at'])=(to_jsonb(OLD)-ARRAY['cancelled_by','cancelled_at']) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'AI_DRAFT_SEND_ROWS_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER ai_draft_send_plans_guard BEFORE UPDATE OR DELETE ON hon.ai_draft_send_plans FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_draft_send_rows();
CREATE TRIGGER ai_draft_send_plans_no_truncate BEFORE TRUNCATE ON hon.ai_draft_send_plans FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_draft_send_rows();
CREATE TRIGGER ai_draft_sends_guard BEFORE UPDATE OR DELETE ON hon.ai_draft_sends FOR EACH ROW EXECUTE FUNCTION hon.guard_ai_draft_send_rows();
CREATE TRIGGER ai_draft_sends_no_truncate BEFORE TRUNCATE ON hon.ai_draft_sends FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_ai_draft_send_rows();
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['hon.ai_draft_send_plans','hon.ai_draft_sends'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
    END LOOP;
  END LOOP;
END $$;

-- Whether a person can be reached on a channel now: OPTED_IN consent at this school and an address.
CREATE FUNCTION hon.ai_draft_reachable(p_person uuid, p_channel text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT CASE
    WHEN NOT EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.organization_id=hon.current_organization_id() AND k.school_id=hon.current_school_id()
      AND k.person_id=p_person AND k.channel::text=p_channel AND k.status='OPTED_IN') THEN 'NO_CONSENT'
    WHEN NOT EXISTS(SELECT 1 FROM hon.people p WHERE p.id=p_person AND p.organization_id=hon.current_organization_id() AND p.school_id=hon.current_school_id()
      AND ((p_channel='SMS' AND p.phone_e164 IS NOT NULL) OR (p_channel='EMAIL' AND p.email IS NOT NULL))) THEN 'NO_ADDRESS'
    ELSE 'OK' END
$$;

CREATE FUNCTION hon.chad_draft_send_view(p_invocation uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('invocationId',p_invocation,
    'plan',(SELECT jsonb_build_object('version',p.version,'channel',p.channel,
        'sendAt',CASE WHEN p.send_at IS NULL THEN NULL ELSE to_char(p.send_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
      FROM hon.ai_draft_send_plans p WHERE p.source='CHAD_FOLLOW_UP' AND p.source_id=p_invocation
        AND p.organization_id=hon.current_organization_id() AND p.school_id=hon.current_school_id() ORDER BY p.version DESC LIMIT 1),
    'send',(SELECT jsonb_build_object('outcome',s.outcome,'messageId',s.message_id,'channel',s.channel,
        'scheduledAt',to_char(s.scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'approvedBy',s.approved_by,'approvedAt',to_char(s.approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'approvalMethod',s.approval_method,'cancelled',s.cancelled_at IS NOT NULL,
        'delivery',(SELECT d.status::text FROM hon.communication_deliveries d WHERE d.message_id=s.message_id))
      FROM hon.ai_draft_sends s WHERE s.source='CHAD_FOLLOW_UP' AND s.source_id=p_invocation
        AND s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id()))
$$;

-- S1. Set (or clear with channel NONE) the send plan on the requester's own draft while it awaits approval.
-- p = {channel: SMS|EMAIL|NONE, sendAt: ISO ms UTC | null}.
CREATE FUNCTION hon.set_chad_draft_send_plan(p_subject text, p_invocation uuid, p jsonb, p_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_chad_follow_up_actor(p_subject); i hon.chad_follow_up_invocations%ROWTYPE; person uuid; at timestamptz; v integer;
  prior hon.ai_draft_send_plans%ROWTYPE; reach text;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR jsonb_typeof(p)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['channel','sendAt']
    OR jsonb_typeof(p->'channel')<>'string' OR (p->>'channel') NOT IN ('SMS','EMAIL','NONE')
    OR jsonb_typeof(p->'sendAt') NOT IN ('string','null')
    OR (jsonb_typeof(p->'sendAt')='string' AND ((p->>'sendAt') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' OR p->>'channel'='NONE')) THEN
    RAISE EXCEPTION 'CHAD_SEND_PLAN_INVALID' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p->'sendAt')='string' THEN
    at := (p->>'sendAt')::timestamptz;
    IF to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>(p->>'sendAt') OR at>clock_timestamp()+interval '30 days' OR at<clock_timestamp()-interval '5 minutes' THEN
      RAISE EXCEPTION 'CHAD_SEND_PLAN_INVALID' USING ERRCODE='22023';
    END IF;
  END IF;
  SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE id=p_invocation AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
  IF NOT FOUND OR i.requested_by<>actor THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO prior FROM hon.ai_draft_send_plans WHERE organization_id=i.organization_id AND school_id=i.school_id AND set_by=actor AND idempotency_key=p_key;
  IF FOUND THEN
    IF prior.source_id<>i.id OR prior.channel<>(p->>'channel') OR prior.send_at IS DISTINCT FROM at THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
    RETURN hon.chad_draft_send_view(i.id) || jsonb_build_object('replayed',true);
  END IF;
  IF i.status<>'AWAITING_APPROVAL' THEN RAISE EXCEPTION 'CHAD_SEND_PLAN_CLOSED' USING ERRCODE='40001'; END IF;
  IF p->>'channel'<>'NONE' THEN
    SELECT l.primary_person_id INTO person FROM hon.crm_leads l WHERE l.id=i.lead_id AND l.organization_id=i.organization_id AND l.school_id=i.school_id;
    reach := hon.ai_draft_reachable(person, p->>'channel');
    IF reach<>'OK' THEN RAISE EXCEPTION 'CHAD_SEND_PLAN_%', reach USING ERRCODE='22023'; END IF;
  END IF;
  SELECT coalesce(max(version),0)+1 INTO v FROM hon.ai_draft_send_plans WHERE source='CHAD_FOLLOW_UP' AND source_id=i.id;
  INSERT INTO hon.ai_draft_send_plans(source,source_id,version,organization_id,school_id,recipient_person_id,channel,send_at,set_by,idempotency_key)
    VALUES('CHAD_FOLLOW_UP',i.id,v,i.organization_id,i.school_id,person,p->>'channel',at,actor,p_key);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(i.organization_id,i.school_id,actor,'HUMAN_UI','chad.follow_up_draft.send_plan_set','CHAD_FOLLOW_UP',i.id,
      jsonb_build_object('version',v,'channel',p->>'channel','sendAt',p->'sendAt'),'SUCCEEDED',
      nullif(current_setting('app.hon_request_id',true),'')::uuid,nullif(current_setting('app.hon_request_id',true),'')::uuid);
  RETURN hon.chad_draft_send_view(i.id) || jsonb_build_object('replayed',false);
END $$;

-- S2. The 0108 body unchanged, then: on APPROVED with a current send plan, queue exactly one message (or record why not).
CREATE OR REPLACE FUNCTION hon.transition_chad_follow_up_draft(p_action uuid,p_decision text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE i hon.chad_follow_up_invocations%ROWTYPE; plan hon.ai_draft_send_plans%ROWTYPE; d hon.chad_follow_up_drafts%ROWTYPE; reviewer uuid;
  method text; turn uuid; reach text; msg uuid; at timestamptz; has_plan boolean; seen text;
BEGIN
 IF p_decision NOT IN('APPROVED','DENIED') OR NOT hon.human_action_reviewer() THEN RAISE EXCEPTION 'REVIEW_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE action_request_id=p_action AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
 IF NOT FOUND OR i.status<>'AWAITING_APPROVAL' OR NOT EXISTS(SELECT 1 FROM hon.action_requests a JOIN hon.action_approvals ap ON ap.action_request_id=a.id WHERE a.id=p_action AND a.status=p_decision::hon.action_request_status AND ap.decision=p_decision::hon.approval_decision AND ap.reviewed_payload_hash=a.payload_hash AND ap.reviewed_policy_version=a.policy_version AND ap.reviewer_principal_id<>i.requested_by) THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_DECISION_BINDING' USING ERRCODE='42501'; END IF;
 UPDATE hon.chad_follow_up_invocations SET status=CASE WHEN p_decision='APPROVED' THEN 'APPROVED' ELSE 'REJECTED' END,updated_at=clock_timestamp() WHERE id=i.id;
 UPDATE hon.work_items SET status=CASE WHEN p_decision='APPROVED' THEN 'COMPLETED' ELSE 'FAILED' END,version=version+1,result=jsonb_build_object('invocationId',i.id,'leadId',i.lead_id,'contentProposalOnly',true,'delivery','NOT_CREATED_OR_SENT') WHERE id=i.work_item_id;
 PERFORM hon.chad_follow_up_event(i.id,CASE WHEN p_decision='APPROVED' THEN 'chad.follow_up_draft.approved' ELSE 'chad.follow_up_draft.rejected' END);
 IF p_decision<>'APPROVED' THEN RETURN; END IF;
 SELECT * INTO plan FROM hon.ai_draft_send_plans WHERE source='CHAD_FOLLOW_UP' AND source_id=i.id ORDER BY version DESC LIMIT 1;
 has_plan := FOUND;
 -- The approval is bound to the send plan the reviewer saw (app.hon_send_plan_version, set by the API for this decision only:
 -- the plan version, NONE for no plan, or empty when the client sent none). A plan changed after review refuses the decision;
 -- a decision that did not see a plan never queues a message.
 seen := coalesce(current_setting('app.hon_send_plan_version',true),'');
 IF (seen<>'' AND seen<>CASE WHEN has_plan THEN plan.version::text ELSE 'NONE' END) OR (seen='' AND has_plan AND plan.channel<>'NONE') THEN
   RAISE EXCEPTION 'CHAD_SEND_PLAN_CHANGED' USING ERRCODE='40001';
 END IF;
 IF NOT has_plan OR plan.channel='NONE' THEN RETURN; END IF;
 SELECT ap.reviewer_principal_id INTO reviewer FROM hon.action_approvals ap WHERE ap.action_request_id=p_action AND ap.decision='APPROVED' ORDER BY ap.id LIMIT 1;
 method := coalesce(nullif(current_setting('app.hon_approval_method',true),''),'BUTTON');
 turn := nullif(current_setting('app.hon_voice_turn_id',true),'')::uuid;
 IF method NOT IN ('BUTTON','VOICE') OR ((method='VOICE') <> (turn IS NOT NULL)) THEN RAISE EXCEPTION 'CHAD_APPROVAL_METHOD_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT d FROM hon.chad_follow_up_drafts WHERE invocation_id=i.id AND organization_id=i.organization_id AND school_id=i.school_id;
 at := greatest(coalesce(plan.send_at, clock_timestamp()), clock_timestamp());
 PERFORM pg_advisory_xact_lock(hashtextextended('ai-draft-send-cap:'||plan.recipient_person_id::text,0));
 reach := hon.ai_draft_reachable(plan.recipient_person_id, plan.channel);
 IF reach='OK' AND (SELECT count(*) FROM hon.communication_messages m WHERE m.organization_id=i.organization_id AND m.school_id=i.school_id
     AND m.recipient_person_id=plan.recipient_person_id AND m.origin_kind='AI_APPROVED_DRAFT' AND m.created_at>clock_timestamp()-interval '1 day')>=3 THEN reach := 'DAILY_CAP'; END IF;
 IF reach='OK' THEN
   INSERT INTO hon.communication_messages(organization_id,school_id,recipient_person_id,channel,content,lifecycle,scheduled_at,created_by_principal_id,queued_by_principal_id,
       origin_kind,origin_id,email_subject)
     VALUES(i.organization_id,i.school_id,plan.recipient_person_id,plan.channel::hon.communication_message_channel,left(d.content,4000),'QUEUED',at,reviewer,reviewer,
       'AI_APPROVED_DRAFT',i.id,CASE WHEN plan.channel='EMAIL' THEN left(btrim(d.subject),150) END)
     RETURNING id INTO msg;
 END IF;
 INSERT INTO hon.ai_draft_sends(source,source_id,organization_id,school_id,plan_version,outcome,message_id,channel,scheduled_at,approved_by,approval_method,voice_turn_id)
   VALUES('CHAD_FOLLOW_UP',i.id,i.organization_id,i.school_id,plan.version,CASE WHEN reach='OK' THEN 'QUEUED' ELSE reach END,msg,plan.channel,at,reviewer,method,turn);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id,action_request_id)
   VALUES(i.organization_id,i.school_id,reviewer,'HUMAN_UI','chad.follow_up_draft.send_queued','CHAD_FOLLOW_UP',i.id,
     jsonb_build_object('outcome',CASE WHEN reach='OK' THEN 'QUEUED' ELSE reach END,'messageId',msg,'channel',plan.channel,'approvalMethod',method),
     (CASE WHEN reach='OK' THEN 'SUCCEEDED' ELSE 'FAILED' END)::hon.audit_result,nullif(current_setting('app.hon_request_id',true),'')::uuid,
     nullif(current_setting('app.hon_request_id',true),'')::uuid,p_action);
END $$;

-- The requester's or reviewer's view of the plan and send for one draft. A qualified reviewer sees the plan before approving,
-- so the review screen can say that approving queues this message.
CREATE FUNCTION hon.read_chad_draft_send(p_subject text, p_invocation uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_chad_follow_up_actor(p_subject);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.chad_follow_up_invocations i WHERE i.id=p_invocation AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id()
      AND (i.requested_by=actor OR EXISTS(SELECT 1 FROM hon.ai_draft_sends s WHERE s.source='CHAD_FOLLOW_UP' AND s.source_id=i.id AND s.approved_by=actor)
        OR (i.status='AWAITING_APPROVAL' AND hon.principal_has_school_permission(actor,i.organization_id,i.school_id,'action.approve')))) THEN
    RAISE EXCEPTION 'CHAD_FOLLOW_UP_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  RETURN hon.chad_draft_send_view(p_invocation);
END $$;

-- The same view for the approvals screen: a qualified reviewer (0074 human_action_reviewer: direct human, action.approve at this
-- school) reads the plan of the Chad draft bound to one action request, without needing Chad access.
CREATE FUNCTION hon.read_chad_draft_send_for_review(p_action uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE inv uuid;
BEGIN
  IF NOT hon.human_action_reviewer() OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'REVIEW_REQUIRED' USING ERRCODE='42501'; END IF;
  SELECT i.id INTO inv FROM hon.chad_follow_up_invocations i WHERE i.action_request_id=p_action
    AND i.organization_id=hon.current_organization_id() AND i.school_id=hon.current_school_id();
  IF inv IS NULL THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.chad_draft_send_view(inv);
END $$;

-- S4. Cancel a queued approved-draft message before the delivery worker has claimed it.
CREATE FUNCTION hon.cancel_chad_draft_send(p_subject text, p_invocation uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid := hon.require_chad_follow_up_actor(p_subject); s hon.ai_draft_sends%ROWTYPE; i hon.chad_follow_up_invocations%ROWTYPE;
BEGIN
  SELECT * INTO i FROM hon.chad_follow_up_invocations WHERE id=p_invocation AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
  SELECT * INTO s FROM hon.ai_draft_sends WHERE source='CHAD_FOLLOW_UP' AND source_id=p_invocation AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR UPDATE;
  IF i.id IS NULL OR s.source_id IS NULL OR (i.requested_by<>actor AND s.approved_by<>actor) THEN RAISE EXCEPTION 'CHAD_FOLLOW_UP_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF s.cancelled_at IS NOT NULL THEN RETURN hon.chad_draft_send_view(p_invocation) || jsonb_build_object('replayed',true); END IF;
  IF s.outcome<>'QUEUED' THEN RAISE EXCEPTION 'CHAD_SEND_NOT_CANCELLABLE' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM hon.communication_messages m WHERE m.id=s.message_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM hon.communication_deliveries d WHERE d.message_id=s.message_id) THEN RAISE EXCEPTION 'CHAD_SEND_NOT_CANCELLABLE' USING ERRCODE='40001'; END IF;
  UPDATE hon.communication_messages SET lifecycle='CANCELLED', version=version+1, updated_at=now() WHERE id=s.message_id AND lifecycle='QUEUED';
  UPDATE hon.ai_draft_sends SET cancelled_by=actor, cancelled_at=clock_timestamp() WHERE source='CHAD_FOLLOW_UP' AND source_id=p_invocation;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(i.organization_id,i.school_id,actor,'HUMAN_UI','chad.follow_up_draft.send_cancelled','CHAD_FOLLOW_UP',i.id,jsonb_build_object('messageId',s.message_id),'SUCCEEDED',
      nullif(current_setting('app.hon_request_id',true),'')::uuid,nullif(current_setting('app.hon_request_id',true),'')::uuid);
  RETURN hon.chad_draft_send_view(p_invocation) || jsonb_build_object('replayed',false);
END $$;

DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.guard_ai_draft_send_rows()','hon.ai_draft_reachable(uuid,text)','hon.chad_draft_send_view(uuid)',
    'hon.set_chad_draft_send_plan(text,uuid,jsonb,text)','hon.read_chad_draft_send(text,uuid)','hon.cancel_chad_draft_send(text,uuid)',
    'hon.transition_chad_follow_up_draft(uuid,text)','hon.read_chad_draft_send_for_review(uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.set_chad_draft_send_plan(text,uuid,jsonb,text), hon.read_chad_draft_send(text,uuid), hon.cancel_chad_draft_send(text,uuid),
      hon.transition_chad_follow_up_draft(uuid,text), hon.read_chad_draft_send_for_review(uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
