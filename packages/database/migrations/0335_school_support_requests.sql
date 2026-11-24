BEGIN;

-- Onboarding PR 4 (0335, coordinator-allocated 2026-11-13): a school asks HON for help, and the request lands in the HQ
-- support queue (0232) as an OPEN case for that exact school.
-- - Only a direct human with support.request at the session school can ask, read the school's requests or add a message.
--   Like 0323 and on purpose, no active entitlement is needed (owner decision D3: before access starts a school may still
--   contact support).
-- - A request is an hq_support_cases row (NORMAL priority, opened by the school person) with the school's words as the
--   OPENED note, linked one-to-one from hon.school_support_requests. HQ works it with the 0232 tools, and answers through
--   0281 communications. A school reads its own requests' status and its own messages only, never HQ notes or assignees.
-- - A school message on a RESOLVED or WAITING_ON_SCHOOL case moves it back to OPEN (a recorded CHANGED event); a CLOSED
--   case takes no more messages.
-- - Limits: 10 new requests per school and 30 messages per request in any 24 hours.
-- - Identifier-only audit and inert outbox. No message is sent, and nothing touches billing, access, credits or AI.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.hq_support_cases') IS NULL OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.require_onboarding_actor(text)') IS NULL THEN RAISE EXCEPTION '0335 requires 0204, 0232 and 0323'; END IF;
END $$;

INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
  VALUES('support.request','Ask HON support for help and follow the school''s support requests',false,true)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
  SELECT r.id,r.organization_id,'support.request' FROM hon.roles r WHERE r.code='OWNER' AND r.is_system_role
  ON CONFLICT (role_id,permission_code) DO NOTHING;

CREATE TABLE hon.school_support_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, school_id uuid NOT NULL,
  case_id uuid NOT NULL UNIQUE REFERENCES hon.hq_support_cases(id),
  topic text NOT NULL CHECK (topic IN ('GETTING_STARTED','IMPORTING_DATA','BILLING','ACCOUNT_ACCESS','PROBLEM','IDEA','OTHER')),
  page_hint text CHECK (page_hint IS NULL OR page_hint ~ '^/[a-z0-9/_-]{0,119}$'),
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE INDEX school_support_requests_school_idx ON hon.school_support_requests (organization_id,school_id,created_at DESC,id DESC);
CREATE TABLE hon.school_support_commands (
  organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation text NOT NULL CHECK (operation IN ('SUBMIT','MESSAGE')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  PRIMARY KEY (organization_id,school_id,principal_id,idempotency_key),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id),
  CHECK ((response IS NULL)=(completed_at IS NULL))
);
ALTER TABLE hon.school_support_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_support_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.school_support_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.school_support_commands FORCE ROW LEVEL SECURITY;

-- A request link never changes; a command records its response once.
CREATE FUNCTION hon.guard_school_support() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  -- Nested on purpose: a school_support_requests row has no response column to look at.
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='school_support_commands' THEN
    IF OLD.response IS NULL AND NEW.response IS NOT NULL
      AND (NEW.organization_id,NEW.school_id,NEW.principal_id,NEW.idempotency_key,NEW.operation,NEW.fingerprint,NEW.created_at)
        IS NOT DISTINCT FROM (OLD.organization_id,OLD.school_id,OLD.principal_id,OLD.idempotency_key,OLD.operation,OLD.fingerprint,OLD.created_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'SUPPORT_REQUEST_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_support_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_school_support();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_support_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_support();
CREATE TRIGGER guarded BEFORE UPDATE OR DELETE ON hon.school_support_commands FOR EACH ROW EXECUTE FUNCTION hon.guard_school_support();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON hon.school_support_commands FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_school_support();

-- The direct human with live support.request at the session school: the 0323 checks, a different permission, and on
-- purpose no active entitlement (D3).
CREATE FUNCTION hon.require_support_request_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 2048 OR btrim(p_subject)<>p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SUPPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code='support.request' AND x.is_staff_assignable);
  IF actor IS NULL THEN RAISE EXCEPTION 'SUPPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- Free text the school wrote: trimmed, p_min..p_max characters, no control characters except tab and line breaks.
CREATE FUNCTION hon.support_request_text(p_value jsonb,p_min integer,p_max integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value)<>'string' OR (p_value#>>'{}')<>btrim(p_value#>>'{}')
    OR length(p_value#>>'{}') NOT BETWEEN p_min AND p_max OR (p_value#>>'{}') ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
    RAISE EXCEPTION 'SUPPORT_INVALID' USING ERRCODE='22023'; END IF;
  RETURN p_value#>>'{}';
END $$;

-- What a school may see of one request: its own topic, subject and messages, and the case status. Never an HQ note,
-- an assignee, a priority or an HQ person's name.
CREATE FUNCTION hon.school_support_request_json(r hon.school_support_requests) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('requestId',r.id,'topic',r.topic,'subject',c.subject,'status',c.status,'pageHint',r.page_hint,
    'openedAt',hon.saas_ts(c.opened_at),'updatedAt',hon.saas_ts(c.updated_at),'closedAt',hon.saas_ts(c.closed_at),
    'messages',coalesce((SELECT jsonb_agg(jsonb_build_object('seq',e.seq,'note',e.note,'at',hon.saas_ts(e.occurred_at),
        'author',left(coalesce(nullif(btrim(u.display_name),''),'School staff'),120)) ORDER BY e.seq)
      FROM hon.hq_support_case_events e JOIN hon.principals p ON p.id=e.actor_principal_id JOIN hon.users u ON u.id=p.user_id
      -- Every HQ support note is written by someone holding an HQ grant (0232), and no school actor ever holds one.
      WHERE e.case_id=c.id AND e.note IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=e.actor_principal_id)),'[]'::jsonb))
  FROM hon.hq_support_cases c WHERE c.id=r.case_id;
$$;

-- Claims this person's key at this school: replays the first answer, refuses other content, or returns NULL to proceed.
CREATE FUNCTION hon.school_support_claim(p_org uuid,p_school uuid,p_actor uuid,p_key text,p_operation text,p_fp text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE prior hon.school_support_commands%ROWTYPE;
BEGIN
  INSERT INTO hon.school_support_commands(organization_id,school_id,principal_id,idempotency_key,operation,fingerprint)
    VALUES(p_org,p_school,p_actor,p_key,p_operation,p_fp) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT * INTO prior FROM hon.school_support_commands WHERE organization_id=p_org AND school_id=p_school AND principal_id=p_actor AND idempotency_key=p_key FOR UPDATE;
  IF prior.operation<>p_operation OR prior.fingerprint<>p_fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF prior.response IS NULL THEN RAISE EXCEPTION 'SUPPORT_BUSY' USING ERRCODE='55P03'; END IF;
  RETURN jsonb_build_object('record',prior.response,'replayed',true);
END $$;

CREATE FUNCTION hon.school_support_check_call(p_key text,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]'
    OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'SUPPORT_INVALID' USING ERRCODE='22023'; END IF;
END $$;

-- SUBMIT {topic, subject, message, pageHint|null}
CREATE FUNCTION hon.submit_school_support_request(p_subject text,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; fp text;
  v_topic text; v_title text; v_note text; v_hint text; c hon.hq_support_cases%ROWTYPE; r hon.school_support_requests%ROWTYPE;
  at timestamptz:=clock_timestamp(); result jsonb;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k)
      IS DISTINCT FROM ARRAY['message','pageHint','subject','topic']
    OR jsonb_typeof(p_input->'topic') IS DISTINCT FROM 'string'
    OR (p_input->>'topic') NOT IN ('GETTING_STARTED','IMPORTING_DATA','BILLING','ACCOUNT_ACCESS','PROBLEM','IDEA','OTHER')
    OR jsonb_typeof(p_input->'pageHint') NOT IN ('string','null')
    OR (jsonb_typeof(p_input->'pageHint')='string' AND (p_input->>'pageHint') !~ '^/[a-z0-9/_-]{0,119}$') THEN
    RAISE EXCEPTION 'SUPPORT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_support_check_call(p_key,p_request,p_correlation);
  v_topic:=p_input->>'topic'; v_hint:=p_input->>'pageHint';
  v_title:=hon.support_request_text(p_input->'subject',3,200); v_note:=hon.support_request_text(p_input->'message',1,4000);
  actor:=hon.require_support_request_actor(p_subject);
  fp:=encode(sha256(convert_to('support.request.submit:'||p_input::text,'UTF8')),'hex');
  replay:=hon.school_support_claim(org,school,actor,p_key,'SUBMIT',fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  -- One school's requests at a time, so the daily limit cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('school-support:'||school::text,0));
  IF (SELECT count(*) FROM hon.school_support_requests WHERE organization_id=org AND school_id=school AND created_at>at-interval '24 hours')>=10 THEN
    RAISE EXCEPTION 'SUPPORT_RATE_LIMITED' USING ERRCODE='54000'; END IF;
  INSERT INTO hon.hq_support_cases(organization_id,school_id,subject,category,priority,status,opened_by,opened_at,updated_at)
    VALUES(org,school,v_title,CASE v_topic WHEN 'GETTING_STARTED' THEN 'ONBOARDING' WHEN 'IMPORTING_DATA' THEN 'DATA_REQUEST' WHEN 'BILLING' THEN 'BILLING'
      WHEN 'ACCOUNT_ACCESS' THEN 'ACCOUNT_ACCESS' WHEN 'PROBLEM' THEN 'PRODUCT_ISSUE' WHEN 'IDEA' THEN 'FEEDBACK' ELSE 'OTHER' END,
      'NORMAL','OPEN',actor,at,at) RETURNING * INTO c;
  INSERT INTO hon.hq_support_case_events(case_id,seq,kind,actor_principal_id,note,occurred_at) VALUES(c.id,1,'OPENED',actor,v_note,at);
  INSERT INTO hon.school_support_requests(organization_id,school_id,case_id,topic,page_hint,requested_by_principal_id,created_at)
    VALUES(org,school,c.id,v_topic,v_hint,actor,at) RETURNING * INTO r;
  result:=hon.school_support_request_json(r);
  -- Identifier-only evidence: the school's words stay in the case history, not in audit or outbox payloads.
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','support.request.submitted','SCHOOL_SUPPORT_REQUEST',r.id,jsonb_build_object('caseId',c.id,'topic',v_topic,'internalOnly',true),'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'support.request.submitted',1,'SCHOOL_SUPPORT_REQUEST',r.id,1,p_correlation,p_request,jsonb_build_object('caseId',c.id,'internalOnly',true));
  UPDATE hon.school_support_commands SET response=result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
  IF hon.require_support_request_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SUPPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- MESSAGE {message} on one of this school's requests.
CREATE FUNCTION hon.add_school_support_message(p_subject text,p_request_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; replay jsonb; fp text; v_note text;
  r hon.school_support_requests%ROWTYPE; c hon.hq_support_cases%ROWTYPE; seq integer; at timestamptz:=clock_timestamp(); result jsonb;
BEGIN
  IF p_request_id IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['message'] THEN
    RAISE EXCEPTION 'SUPPORT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM hon.school_support_check_call(p_key,p_request,p_correlation);
  v_note:=hon.support_request_text(p_input->'message',1,4000);
  actor:=hon.require_support_request_actor(p_subject);
  fp:=encode(sha256(convert_to('support.request.message:'||p_request_id::text||':'||p_input::text,'UTF8')),'hex');
  replay:=hon.school_support_claim(org,school,actor,p_key,'MESSAGE',fp);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  SELECT * INTO r FROM hon.school_support_requests WHERE id=p_request_id AND organization_id=org AND school_id=school;
  IF r.id IS NULL THEN RAISE EXCEPTION 'SUPPORT_REQUEST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO c FROM hon.hq_support_cases WHERE id=r.case_id FOR UPDATE;
  IF c.status='CLOSED' THEN RAISE EXCEPTION 'SUPPORT_REQUEST_CLOSED' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM hon.hq_support_case_events e WHERE e.case_id=c.id AND e.kind='NOTE' AND e.occurred_at>at-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=e.actor_principal_id))>=30 THEN
    RAISE EXCEPTION 'SUPPORT_RATE_LIMITED' USING ERRCODE='54000'; END IF;
  SELECT coalesce(max(e.seq),0)+1 INTO seq FROM hon.hq_support_case_events e WHERE e.case_id=c.id;
  INSERT INTO hon.hq_support_case_events(case_id,seq,kind,actor_principal_id,note,occurred_at) VALUES(c.id,seq,'NOTE',actor,v_note,at);
  IF c.status IN ('RESOLVED','WAITING_ON_SCHOOL') THEN
    -- The school wrote back: the case goes back to HQ's open queue, recorded like any status change.
    INSERT INTO hon.hq_support_case_events(case_id,seq,kind,actor_principal_id,status_from,status_to,occurred_at) VALUES(c.id,seq+1,'CHANGED',actor,c.status,'OPEN',at);
    UPDATE hon.hq_support_cases SET status='OPEN',updated_at=at,version=version+1 WHERE id=c.id;
  ELSE
    UPDATE hon.hq_support_cases SET updated_at=at,version=version+1 WHERE id=c.id;
  END IF;
  result:=hon.school_support_request_json(r);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','support.request.messaged','SCHOOL_SUPPORT_REQUEST',r.id,jsonb_build_object('caseId',c.id,'seq',seq,'internalOnly',true),'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'support.request.messaged',1,'SCHOOL_SUPPORT_REQUEST',r.id,seq,p_correlation,p_request,jsonb_build_object('caseId',c.id,'internalOnly',true));
  UPDATE hon.school_support_commands SET response=result,completed_at=clock_timestamp()
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
  IF hon.require_support_request_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'SUPPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

-- This school's 50 most recent requests, newest first.
CREATE FUNCTION hon.read_school_support_requests(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  PERFORM hon.require_support_request_actor(p_subject);
  RETURN jsonb_build_object('requests',coalesce((SELECT jsonb_agg(hon.school_support_request_json(x) ORDER BY x.created_at DESC,x.id DESC)
      FROM (SELECT * FROM hon.school_support_requests WHERE organization_id=org AND school_id=school ORDER BY created_at DESC,id DESC LIMIT 50) x),'[]'::jsonb),
    'limits',jsonb_build_object('requestsPerDay',10,'messagesPerDay',30,'subjectMax',200,'messageMax',4000),
    'checkedAt',hon.saas_ts(clock_timestamp()));
END $$;

DO $$ DECLARE r text; t text; f regprocedure; BEGIN
  FOREACH t IN ARRAY ARRAY['school_support_requests','school_support_commands'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r);
    END LOOP;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['hon.guard_school_support()','hon.require_support_request_actor(text)','hon.support_request_text(jsonb,integer,integer)',
    'hon.school_support_request_json(hon.school_support_requests)','hon.school_support_claim(uuid,uuid,uuid,text,text,text)',
    'hon.school_support_check_call(text,uuid,uuid)','hon.submit_school_support_request(text,jsonb,text,uuid,uuid)',
    'hon.add_school_support_message(text,uuid,jsonb,text,uuid,uuid)','hon.read_school_support_requests(text)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.submit_school_support_request(text,jsonb,text,uuid,uuid),
      hon.add_school_support_message(text,uuid,jsonb,text,uuid,uuid),hon.read_school_support_requests(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
