BEGIN;
-- No provider, microphone, transcription, invocation, action or work execution.
INSERT INTO hon.permissions(code,description,is_sensitive) VALUES
 ('ai.voice.interact','Manage own Complete voice/text handoff sessions without execution',true) ON CONFLICT DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT id,organization_id,'ai.voice.interact' FROM hon.roles WHERE code='OWNER' AND is_system_role ON CONFLICT DO NOTHING;

ALTER TABLE hon.action_approvals ADD CONSTRAINT action_approvals_voice_scope_unique UNIQUE(id,organization_id,school_id);

CREATE TABLE hon.voice_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES hon.organizations(id), school_id uuid NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id),
 agent_catalog_id text NOT NULL CHECK(agent_catalog_id IN('alex','chad','maya','marcus','jordan','claire','lena')),
 work_item_id uuid, action_request_id uuid, approval_id uuid, resume_session_id uuid,
 state text NOT NULL DEFAULT 'REQUESTED' CHECK(state IN('REQUESTED','VOICE_CONNECTING','VOICE_UNAVAILABLE','TEXT_FALLBACK','ENDED')),
 reason_code text CHECK(reason_code IN('NOT_CONFIGURED','CLIENT_OFFLINE','CLIENT_ERROR','PERMISSION_UNAVAILABLE','PROVIDER_UNAVAILABLE')),
 version integer NOT NULL DEFAULT 1 CHECK(version>=1), draft_text text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 UNIQUE(id,organization_id,school_id,actor_principal_id),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
 FOREIGN KEY(work_item_id,organization_id,school_id) REFERENCES hon.work_items(id,organization_id,school_id),
 FOREIGN KEY(action_request_id,organization_id,school_id) REFERENCES hon.action_requests(id,organization_id,school_id),
 FOREIGN KEY(approval_id,organization_id,school_id) REFERENCES hon.action_approvals(id,organization_id,school_id),
 FOREIGN KEY(resume_session_id,organization_id,school_id,actor_principal_id) REFERENCES hon.voice_sessions(id,organization_id,school_id,actor_principal_id),
 CHECK(approval_id IS NULL OR action_request_id IS NOT NULL),
 CHECK((state='REQUESTED' AND reason_code IS NULL) OR state='ENDED' OR (state IN('VOICE_CONNECTING','VOICE_UNAVAILABLE','TEXT_FALLBACK') AND reason_code IS NOT NULL)),
 CHECK(draft_text IS NULL OR (state IN('TEXT_FALLBACK','ENDED') AND char_length(draft_text) BETWEEN 1 AND 500
  AND draft_text=btrim(draft_text) AND draft_text ~ '^[A-Za-z][A-Za-z .,!?''-]*$'
  AND draft_text !~* '\m(password|credential|secret|token|bearer|api|authorization|transcript|audio|email|phone|address|ssn|card)\M')),
 CHECK(expires_at=created_at+interval '30 minutes' AND updated_at>=created_at)
);
CREATE TABLE hon.voice_session_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, actor_principal_id uuid NOT NULL,
 idempotency_key uuid NOT NULL, request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 session_id uuid NOT NULL, receipt_version integer NOT NULL CHECK(receipt_version>=1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,actor_principal_id,idempotency_key),
 FOREIGN KEY(session_id,organization_id,school_id,actor_principal_id) REFERENCES hon.voice_sessions(id,organization_id,school_id,actor_principal_id)
);
ALTER TABLE hon.voice_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.voice_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.voice_session_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.voice_session_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY voice_sessions_deny_all ON hon.voice_sessions USING(false) WITH CHECK(false);
CREATE POLICY voice_session_requests_deny_all ON hon.voice_session_requests USING(false) WITH CHECK(false);

CREATE FUNCTION hon.guard_voice_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR TG_TABLE_NAME='voice_session_requests' THEN
  RAISE EXCEPTION 'IMMUTABLE_VOICE_EVIDENCE' USING ERRCODE='42501'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','reason_code','version','draft_text','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','reason_code','version','draft_text','updated_at'])
 OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
 OR array_position(ARRAY['REQUESTED','VOICE_CONNECTING','VOICE_UNAVAILABLE','TEXT_FALLBACK','ENDED'],NEW.state)<array_position(ARRAY['REQUESTED','VOICE_CONNECTING','VOICE_UNAVAILABLE','TEXT_FALLBACK','ENDED'],OLD.state)
 OR (NEW.state=OLD.state AND NEW.state<>'TEXT_FALLBACK') OR OLD.state='ENDED' THEN
  RAISE EXCEPTION 'VOICE_TRANSITION_INVALID' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER voice_session_guard BEFORE UPDATE OR DELETE ON hon.voice_sessions FOR EACH ROW EXECUTE FUNCTION hon.guard_voice_history();
CREATE TRIGGER voice_session_no_truncate BEFORE TRUNCATE ON hon.voice_sessions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_voice_history();
CREATE TRIGGER voice_request_guard BEFORE UPDATE OR DELETE ON hon.voice_session_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_voice_history();
CREATE TRIGGER voice_request_no_truncate BEFORE TRUNCATE ON hon.voice_session_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_voice_history();

CREATE FUNCTION hon.require_voice_actor(p_subject text) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
 org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); uid uuid;
BEGIN
 IF actor IS NULL OR org IS NULL OR school IS NULL OR p_subject IS NULL
 OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
 OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
 OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'VOICE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 -- Principal/user UPDATE locks also serialize new FK grants/duplicate-human/HQ insertion.
 PERFORM 1 FROM hon.organizations WHERE id=org FOR SHARE;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org FOR SHARE;
 PERFORM 1 FROM hon.users WHERE external_subject=p_subject FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 SELECT u.id INTO uid FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
 WHERE u.external_subject=p_subject AND p.id=actor AND p.is_active AND p.principal_type='HUMAN_USER';
 IF uid IS NULL OR (SELECT count(*) FROM hon.principals WHERE user_id=uid AND is_active AND principal_type='HUMAN_USER')<>1
 OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)
 OR EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
  WHERE g.principal_id=actor AND r.code='PARENT' AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
 OR NOT hon.principal_has_school_permission(actor,org,school,'ai.voice.interact')
 OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND tier='COMPLETE' AND status='ACTIVE'
  AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN
  RAISE EXCEPTION 'VOICE_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;

CREATE FUNCTION hon.require_voice_references(p_work uuid,p_action uuid,p_approval uuid) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
BEGIN
 IF p_work IS NOT NULL THEN
  IF NOT hon.principal_has_school_permission(actor,org,school,'work_item.read') THEN RAISE EXCEPTION 'VOICE_REFERENCE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM id FROM hon.work_items WHERE id=p_work AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_REFERENCE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 END IF;
 IF p_action IS NOT NULL THEN
  IF NOT hon.principal_has_school_permission(actor,org,school,'action.approve') THEN RAISE EXCEPTION 'VOICE_REFERENCE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM id FROM hon.action_requests WHERE id=p_action AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_REFERENCE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 END IF;
 IF p_approval IS NOT NULL THEN
  PERFORM id FROM hon.action_approvals WHERE id=p_approval AND action_request_id=p_action AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_REFERENCE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 END IF;
END $$;

CREATE FUNCTION hon.voice_session_snapshot(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.voice_sessions; BEGIN
 SELECT * INTO s FROM hon.voice_sessions WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
  AND actor_principal_id=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('id',s.id,'organizationId',s.organization_id,'schoolId',s.school_id,'actorPrincipalId',s.actor_principal_id,
  'agentCatalogId',s.agent_catalog_id,'workItemId',s.work_item_id,'actionRequestId',s.action_request_id,'approvalId',s.approval_id,'resumeSessionId',s.resume_session_id,
  'state',s.state,'reasonCode',s.reason_code,'version',s.version,'draftText',s.draft_text,
  'draftNotice','Text is a private draft. Saving text does not send a command.',
  'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt',to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expired',s.expires_at<=clock_timestamp(),'providerConnected',false,'executionTriggered',false);
END $$;

CREATE FUNCTION hon.read_voice_session(p_subject text,p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s hon.voice_sessions;
BEGIN
 PERFORM hon.require_voice_actor(p_subject);
 SELECT * INTO s FROM hon.voice_sessions WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
 AND actor_principal_id=nullif(current_setting('app.hon_principal_id',true),'')::uuid FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 PERFORM hon.require_voice_references(s.work_item_id,s.action_request_id,s.approval_id);
 PERFORM hon.require_voice_actor(p_subject);
 RETURN hon.voice_session_snapshot(s.id);
END $$;

CREATE FUNCTION hon.mutate_voice_session(p_subject text,p_operation text,p_id uuid,p_input jsonb,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
 s hon.voice_sessions; old hon.voice_session_requests; prior jsonb; fingerprint text; target text; allowed text[]; work uuid; action uuid; approval uuid; resume uuid; at_time timestamptz;
BEGIN
 PERFORM hon.require_voice_actor(p_subject);
 IF p_operation IS NULL OR p_operation NOT IN('create','status','mark-fallback','end') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object'
 OR octet_length(p_input::text)>2048 OR p_key IS NULL OR p_request IS NULL OR p_correlation IS NULL
 OR (p_operation='create')<>(p_id IS NULL) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 allowed:=CASE p_operation WHEN 'create' THEN ARRAY['agentCatalogId','workItemId','actionRequestId','approvalId','resumeSessionId']
  WHEN 'status' THEN ARRAY['expectedVersion','state','reasonCode'] WHEN 'mark-fallback' THEN ARRAY['expectedVersion','reasonCode','draftText'] ELSE ARRAY['expectedVersion'] END;
 IF p_input-allowed<>'{}'::jsonb THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_operation='create' THEN
  IF jsonb_typeof(p_input->'agentCatalogId') IS DISTINCT FROM 'string' OR p_input->>'agentCatalogId' NOT IN('alex','chad','maya','marcus','jordan','claire','lena') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR target IN SELECT unnest(ARRAY['workItemId','actionRequestId','approvalId','resumeSessionId']) LOOP
   IF p_input ? target AND (jsonb_typeof(p_input->target) IS DISTINCT FROM 'string' OR p_input->>target !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  work:=(p_input->>'workItemId')::uuid; action:=(p_input->>'actionRequestId')::uuid; approval:=(p_input->>'approvalId')::uuid; resume:=(p_input->>'resumeSessionId')::uuid;
  IF (approval IS NOT NULL AND action IS NULL) OR (resume IS NOT NULL AND p_input ?| ARRAY['workItemId','actionRequestId','approvalId']) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 ELSE
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion' !~ '^[1-9][0-9]{0,9}$' OR (p_input->>'expectedVersion')::bigint>=2147483647 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_operation<>'end' AND (jsonb_typeof(p_input->'reasonCode') IS DISTINCT FROM 'string' OR p_input->>'reasonCode' NOT IN('NOT_CONFIGURED','CLIENT_OFFLINE','CLIENT_ERROR','PERMISSION_UNAVAILABLE','PROVIDER_UNAVAILABLE')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_operation='status' AND (jsonb_typeof(p_input->'state') IS DISTINCT FROM 'string' OR p_input->>'state' NOT IN('VOICE_CONNECTING','VOICE_UNAVAILABLE')) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p_input ? 'draftText' AND (jsonb_typeof(p_input->'draftText') IS DISTINCT FROM 'string' OR char_length(p_input->>'draftText') NOT BETWEEN 1 AND 500
   OR p_input->>'draftText'<>btrim(p_input->>'draftText') OR p_input->>'draftText' !~ '^[A-Za-z][A-Za-z .,!?''-]*$'
   OR p_input->>'draftText' ~* '\m(password|credential|secret|token|bearer|api|authorization|transcript|audio|email|phone|address|ssn|card)\M') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'id',p_id,'input',p_input)::text,'UTF8')),'hex');
 -- Actor lock serializes receipt creation as well as same-actor sessions.
 SELECT * INTO old FROM hon.voice_session_requests WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF old.request_fingerprint<>fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='40001'; END IF;
  SELECT * INTO s FROM hon.voice_sessions WHERE id=old.session_id FOR UPDATE;
  PERFORM hon.require_voice_references(s.work_item_id,s.action_request_id,s.approval_id);
  PERFORM hon.require_voice_actor(p_subject);
  IF s.expires_at<=clock_timestamp() AND p_operation<>'end' THEN RAISE EXCEPTION 'VOICE_SESSION_EXPIRED' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('session',hon.voice_session_snapshot(s.id),'receiptVersion',old.receipt_version,'replayed',true);
 END IF;
 IF p_operation='create' THEN
  IF resume IS NOT NULL THEN
   SELECT * INTO s FROM hon.voice_sessions WHERE id=resume AND organization_id=org AND school_id=school AND actor_principal_id=actor FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
   work:=s.work_item_id; action:=s.action_request_id; approval:=s.approval_id;
  END IF;
  PERFORM hon.require_voice_references(work,action,approval);
  PERFORM hon.require_voice_actor(p_subject);
  at_time:=clock_timestamp();
  INSERT INTO hon.voice_sessions(organization_id,school_id,actor_principal_id,agent_catalog_id,work_item_id,action_request_id,approval_id,resume_session_id,created_at,updated_at,expires_at)
  VALUES(org,school,actor,p_input->>'agentCatalogId',work,action,approval,resume,at_time,at_time,at_time+interval '30 minutes') RETURNING * INTO s;
 ELSE
  SELECT * INTO s FROM hon.voice_sessions WHERE id=p_id AND organization_id=org AND school_id=school AND actor_principal_id=actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM hon.require_voice_references(s.work_item_id,s.action_request_id,s.approval_id);
  PERFORM hon.require_voice_actor(p_subject);
  IF s.expires_at<=clock_timestamp() AND p_operation<>'end' THEN RAISE EXCEPTION 'VOICE_SESSION_EXPIRED' USING ERRCODE='40001'; END IF;
  IF s.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  target:=CASE p_operation WHEN 'status' THEN p_input->>'state' WHEN 'mark-fallback' THEN 'TEXT_FALLBACK' ELSE 'ENDED' END;
  IF s.state='ENDED' OR array_position(ARRAY['REQUESTED','VOICE_CONNECTING','VOICE_UNAVAILABLE','TEXT_FALLBACK','ENDED'],target)<array_position(ARRAY['REQUESTED','VOICE_CONNECTING','VOICE_UNAVAILABLE','TEXT_FALLBACK','ENDED'],s.state)
   OR (s.state=target AND target<>'TEXT_FALLBACK') THEN RAISE EXCEPTION 'VOICE_TRANSITION_INVALID' USING ERRCODE='40001'; END IF;
  prior:=jsonb_build_object('state',s.state,'version',s.version);
  UPDATE hon.voice_sessions SET state=target,reason_code=CASE WHEN p_operation='end' THEN reason_code ELSE p_input->>'reasonCode' END,
   draft_text=CASE WHEN p_input ? 'draftText' THEN p_input->>'draftText' ELSE draft_text END,version=version+1,updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
 END IF;
 -- Draft, reference payload, health detail and permission facts never enter evidence.
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at)
 VALUES(org,school,actor,'HUMAN_UI','ai.voice.session.'||p_operation,'VOICE_SESSION',s.id,prior,
  jsonb_build_object('sessionId',s.id,'state',s.state,'version',s.version,'reasonCode',s.reason_code,'executionTriggered',false),'SUCCEEDED',p_request,p_correlation,clock_timestamp());
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'ai.voice.session.recorded',1,'VOICE_SESSION',s.id,s.version,p_correlation,p_request,
  jsonb_build_object('sessionId',s.id,'state',s.state,'version',s.version,'reasonCode',s.reason_code,'executionTriggered',false));
 INSERT INTO hon.voice_session_requests(organization_id,school_id,actor_principal_id,idempotency_key,request_fingerprint,session_id,receipt_version)
 VALUES(org,school,actor,p_key,fingerprint,s.id,s.version);
 -- Recheck after evidence lock waits; expiry aborts the entire atomic write.
 PERFORM hon.require_voice_actor(p_subject);
 IF s.expires_at<=clock_timestamp() AND p_operation<>'end' THEN RAISE EXCEPTION 'VOICE_SESSION_EXPIRED' USING ERRCODE='40001'; END IF;
 RETURN jsonb_build_object('session',hon.voice_session_snapshot(s.id),'receiptVersion',s.version,'replayed',false);
END $$;

REVOKE ALL ON hon.voice_sessions,hon.voice_session_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_voice_history(),hon.require_voice_actor(text),hon.require_voice_references(uuid,uuid,uuid),hon.voice_session_snapshot(uuid),hon.read_voice_session(text,uuid),hon.mutate_voice_session(text,text,uuid,jsonb,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON hon.voice_sessions,hon.voice_session_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_voice_history(),hon.require_voice_actor(text),hon.require_voice_references(uuid,uuid,uuid),hon.voice_session_snapshot(uuid),hon.read_voice_session(text,uuid),hon.mutate_voice_session(text,text,uuid,jsonb,uuid,uuid,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_voice_session(text,uuid),hon.mutate_voice_session(text,text,uuid,jsonb,uuid,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
