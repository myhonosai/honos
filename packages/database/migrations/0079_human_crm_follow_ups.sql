BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Trusted follow-up migration owner required'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('crm.follow_up.self_manage','Human own assigned CRM follow-up read/create/revise/lifecycle',true,true),
 ('crm.follow_up.manage','Human exact school team CRM follow-up read/assign/revise/lifecycle',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p WHERE r.is_system_role AND r.code='OWNER'
 AND p.code IN('crm.follow_up.self_manage','crm.follow_up.manage') ON CONFLICT DO NOTHING;
CREATE TABLE hon.crm_follow_ups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL, lead_id uuid NOT NULL,
 created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,school_id), FOREIGN KEY(lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.crm_follow_up_versions (
 follow_up_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL, version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999),
 assignee_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 120), note text NOT NULL CHECK(length(note)<=2000), due_at timestamptz, priority text NOT NULL CHECK(priority IN('LOW','NORMAL','HIGH')),
 status text NOT NULL CHECK(status IN('OPEN','COMPLETED','CANCELLED')), operation text NOT NULL CHECK(operation IN('CREATE','UPDATE','COMPLETE','CANCEL','REOPEN')),
 completed_at timestamptz, cancelled_at timestamptz, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='HUMAN_UI'), request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(follow_up_id,version), FOREIGN KEY(follow_up_id,organization_id,school_id) REFERENCES hon.crm_follow_ups(id,organization_id,school_id) ON DELETE RESTRICT,
 CHECK((status='COMPLETED')=(completed_at IS NOT NULL)), CHECK((status='CANCELLED')=(cancelled_at IS NOT NULL)),
 CHECK(due_at IS NULL OR (due_at>=timestamptz '2000-01-01T00:00:00Z' AND due_at<timestamptz '2100-01-01T00:00:00Z'))
);
CREATE INDEX crm_follow_up_scope ON hon.crm_follow_ups(organization_id,school_id,id);
CREATE TABLE hon.crm_follow_up_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 response jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key), FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.crm_follow_ups ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.crm_follow_ups FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_follow_up_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.crm_follow_up_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_follow_up_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.crm_follow_up_requests FORCE ROW LEVEL SECURITY;
-- No policies: fixed trusted functions are the only data boundary.
CREATE FUNCTION hon.guard_follow_up_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_FOLLOW_UP_HISTORY' USING ERRCODE='42501'; END $$;
CREATE TRIGGER follow_ups_immutable BEFORE UPDATE OR DELETE ON hon.crm_follow_ups FOR EACH ROW EXECUTE FUNCTION hon.guard_follow_up_history();
CREATE TRIGGER follow_ups_no_truncate BEFORE TRUNCATE ON hon.crm_follow_ups FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_follow_up_history();
CREATE TRIGGER follow_up_versions_immutable BEFORE UPDATE OR DELETE ON hon.crm_follow_up_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_follow_up_history();
CREATE TRIGGER follow_up_versions_no_truncate BEFORE TRUNCATE ON hon.crm_follow_up_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_follow_up_history();
CREATE TRIGGER follow_up_requests_immutable BEFORE UPDATE OR DELETE ON hon.crm_follow_up_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_follow_up_history();
CREATE TRIGGER follow_up_requests_no_truncate BEFORE TRUNCATE ON hon.crm_follow_up_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_follow_up_history();
CREATE FUNCTION hon.validate_follow_up_input(op text,p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE keys text[]; k text; v text;
BEGIN
 IF op IS NULL OR op NOT IN('CREATE','UPDATE','COMPLETE','CANCEL','REOPEN') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 keys:=CASE WHEN op IN('CREATE','UPDATE') THEN ARRAY['expectedVersion','leadId','assigneeId','subject','note','dueAt','priority'] ELSE ARRAY['expectedVersion'] END;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) OR NOT p ?& keys
 OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$'
 OR (p->>'expectedVersion')::numeric NOT BETWEEN (CASE WHEN op='CREATE' THEN 0 ELSE 1 END) AND 999999998 OR (op='CREATE' AND p->>'expectedVersion'<>'0') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF op NOT IN('CREATE','UPDATE') THEN RETURN; END IF;
 FOR k IN SELECT unnest(ARRAY['leadId','assigneeId']) LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR p->>k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR k IN SELECT unnest(ARRAY['subject','note']) LOOP
  v:=p->>k;
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(v) NOT BETWEEN (CASE WHEN k='subject' THEN 1 ELSE 0 END) AND (CASE WHEN k='subject' THEN 120 ELSE 2000 END)
  OR btrim(v,E' \t\n\r')<>v OR (CASE WHEN k='note' THEN replace(v,E'\n','') ELSE v END) ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF jsonb_typeof(p->'priority') IS DISTINCT FROM 'string' OR p->>'priority' NOT IN('LOW','NORMAL','HIGH') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p->'dueAt'<>'null'::jsonb THEN
  v:=p->>'dueAt';
  IF jsonb_typeof(p->'dueAt') IS DISTINCT FROM 'string' OR v !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR to_char(v::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>v THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
END $$;
-- Exact permissions must come from live staff-valid SCHOOL grants, not org/HQ/parent roles.
CREATE FUNCTION hon.follow_up_has_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT permission IN('crm.lead.read','crm.follow_up.self_manage','crm.follow_up.manage') AND hon.staff_member_eligible(actor,org,school) AND EXISTS(
 SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=permission
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=school) AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;
CREATE FUNCTION hon.resolve_follow_up_scope(subject text) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS(SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND hon.follow_up_has_permission(p.id,g.organization_id,g.school_id,'crm.lead.read')
 AND (hon.follow_up_has_permission(p.id,g.organization_id,g.school_id,'crm.follow_up.self_manage') OR hon.follow_up_has_permission(p.id,g.organization_id,g.school_id,'crm.follow_up.manage')))
 SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1
$$;
CREATE FUNCTION hon.require_follow_up_actor(subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=subject AND p.id::text=current_setting('app.hon_principal_id',true);
 IF actor IS NULL OR NOT hon.follow_up_has_permission(actor,org,school,'crm.lead.read')
 OR NOT (hon.follow_up_has_permission(actor,org,school,'crm.follow_up.self_manage') OR hon.follow_up_has_permission(actor,org,school,'crm.follow_up.manage'))
 OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_follow_up_actor(subject text,target uuid) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_follow_up_actor(subject);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id IN(actor,target)) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id IN(actor,target) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id IN(actor,target) AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id IN(actor,target) AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id IN(actor,target) AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_follow_up_actor(subject);
END $$;
CREATE FUNCTION hon.follow_up_authorized(actor uuid,assignee uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT hon.follow_up_has_permission(actor,hon.current_organization_id(),hon.current_school_id(),'crm.follow_up.manage') OR (actor=assignee AND hon.follow_up_has_permission(actor,hon.current_organization_id(),hon.current_school_id(),'crm.follow_up.self_manage'))
$$;
CREATE FUNCTION hon.follow_up_summary(p_id uuid,v integer) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('followUpId',f.id,'schoolId',f.school_id,'leadId',f.lead_id,'version',r.version,'assigneeId',r.assignee_id,'subject',r.subject,'note',r.note,
 'dueAt',CASE WHEN r.due_at IS NULL THEN NULL ELSE to_char(r.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'priority',r.priority,'status',r.status,'recordedAt',r.recorded_at,'completedAt',r.completed_at,'cancelledAt',r.cancelled_at,'humanOnly',true)
 FROM hon.crm_follow_ups f JOIN hon.crm_follow_up_versions r ON r.follow_up_id=f.id AND r.organization_id=f.organization_id AND r.school_id=f.school_id
 WHERE f.id=p_id AND f.organization_id=hon.current_organization_id() AND f.school_id=hon.current_school_id() AND (v IS NULL OR r.version=v) ORDER BY r.version DESC LIMIT 1
$$;
CREATE FUNCTION hon.guard_follow_up_insert() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE subject_id text; actor uuid; prior hon.crm_follow_up_versions%ROWTYPE; lead uuid; input jsonb; desired text;
BEGIN
 actor:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
 SELECT u.external_subject INTO subject_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE p.id=actor;
 PERFORM hon.require_follow_up_actor(subject_id);
 IF NEW.organization_id IS DISTINCT FROM hon.current_organization_id() OR NEW.school_id IS DISTINCT FROM hon.current_school_id() THEN RAISE EXCEPTION 'INVALID_FOLLOW_UP_SCOPE' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='crm_follow_ups' THEN
  IF NEW.created_by_principal_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'INVALID_FOLLOW_UP_ACTOR' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT lead_id INTO lead FROM hon.crm_follow_ups WHERE id=NEW.follow_up_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR UPDATE;
  IF lead IS NULL OR NEW.actor_principal_id IS DISTINCT FROM actor OR NEW.request_id::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'INVALID_FOLLOW_UP_VERSION' USING ERRCODE='23514'; END IF;
  SELECT * INTO prior FROM hon.crm_follow_up_versions WHERE follow_up_id=NEW.follow_up_id ORDER BY version DESC LIMIT 1;
  IF NEW.version<>coalesce(prior.version,0)+1 THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF (prior.version IS NULL AND NEW.operation<>'CREATE') OR (prior.version IS NOT NULL AND (NEW.operation='CREATE' OR NOT hon.follow_up_authorized(actor,prior.assignee_id))) THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF (NEW.operation IN('UPDATE','COMPLETE','CANCEL') AND prior.status<>'OPEN') OR (NEW.operation='REOPEN' AND prior.status NOT IN('COMPLETED','CANCELLED')) THEN RAISE EXCEPTION 'LIFECYCLE_CONFLICT' USING ERRCODE='40001'; END IF;
  desired:=CASE NEW.operation WHEN 'COMPLETE' THEN 'COMPLETED' WHEN 'CANCEL' THEN 'CANCELLED' ELSE 'OPEN' END;
  IF NEW.status<>desired THEN RAISE EXCEPTION 'INVALID_FOLLOW_UP_STATE' USING ERRCODE='23514'; END IF;
  IF NEW.operation NOT IN('CREATE','UPDATE') AND (NEW.assignee_id,NEW.subject,NEW.note,NEW.due_at,NEW.priority) IS DISTINCT FROM (prior.assignee_id,prior.subject,prior.note,prior.due_at,prior.priority) THEN RAISE EXCEPTION 'INVALID_FOLLOW_UP_TRANSITION' USING ERRCODE='23514'; END IF;
  IF NEW.operation IN('CREATE','UPDATE') THEN
   IF NOT hon.follow_up_has_permission(NEW.assignee_id,NEW.organization_id,NEW.school_id,'crm.follow_up.self_manage') OR NOT hon.follow_up_has_permission(NEW.assignee_id,NEW.organization_id,NEW.school_id,'crm.lead.read') THEN RAISE EXCEPTION 'ASSIGNEE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  END IF;
  IF (prior.version IS NULL OR NEW.assignee_id IS DISTINCT FROM prior.assignee_id) AND NOT hon.follow_up_authorized(actor,NEW.assignee_id) THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  input:=jsonb_build_object('expectedVersion',coalesce(prior.version,0),'leadId',lead,'assigneeId',NEW.assignee_id,'subject',NEW.subject,'note',NEW.note,'dueAt',CASE WHEN NEW.due_at IS NULL THEN NULL ELSE to_char(NEW.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'priority',NEW.priority);
  PERFORM hon.validate_follow_up_input(CASE WHEN prior.version IS NULL THEN 'CREATE' ELSE 'UPDATE' END,input);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER follow_up_insert_guard BEFORE INSERT ON hon.crm_follow_ups FOR EACH ROW EXECUTE FUNCTION hon.guard_follow_up_insert();
CREATE TRIGGER follow_up_version_insert_guard BEFORE INSERT ON hon.crm_follow_up_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_follow_up_insert();
CREATE FUNCTION hon.mutate_follow_up(subject text,op text,p_id uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); record_id uuid:=p_id; prior hon.crm_follow_up_versions%ROWTYPE;
 receipt hon.crm_follow_up_requests%ROWTYPE; fp text; result jsonb; evidence jsonb; target uuid; linked_lead uuid; new_version integer; state text;
BEGIN
 PERFORM hon.validate_follow_up_input(op,p);
 IF (op='CREATE')<>(p_id IS NULL) OR key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key ~ '[[:cntrl:]]' OR request IS NULL OR correlation IS NULL OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 target:=CASE WHEN op IN('CREATE','UPDATE') THEN (p->>'assigneeId')::uuid ELSE NULL END;
 actor:=hon.lock_follow_up_actor(subject,target);
 fp:=encode(sha256(convert_to(jsonb_build_object('operation',op,'id',p_id,'input',p)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM hon.crm_follow_up_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
 IF FOUND THEN
  IF receipt.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  record_id:=(receipt.response->>'followUpId')::uuid;
 END IF;
 IF record_id IS NOT NULL THEN
  SELECT lead_id INTO linked_lead FROM hon.crm_follow_ups WHERE hon.crm_follow_ups.id=record_id AND organization_id=org AND school_id=school FOR UPDATE;
  IF linked_lead IS NULL THEN RAISE EXCEPTION 'FOLLOW_UP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  SELECT * INTO prior FROM hon.crm_follow_up_versions WHERE follow_up_id=record_id ORDER BY version DESC LIMIT 1;
  IF NOT hon.follow_up_authorized(actor,prior.assignee_id) THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- Lock current assignee even for terminal operations/replays; managers may recover inactive assignments.
  PERFORM hon.lock_follow_up_actor(subject,prior.assignee_id);
  IF NOT hon.follow_up_authorized(actor,prior.assignee_id) THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 END IF;
 IF receipt.fingerprint IS NOT NULL THEN
  IF op IN('CREATE','UPDATE') AND (NOT hon.follow_up_has_permission(target,org,school,'crm.follow_up.self_manage') OR NOT hon.follow_up_has_permission(target,org,school,'crm.lead.read')) THEN RAISE EXCEPTION 'ASSIGNEE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM hon.require_follow_up_actor(subject);
  RETURN jsonb_build_object('followUp',receipt.response,'replayed',true);
 END IF;
 IF coalesce(prior.version,0)<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF op IN('CREATE','UPDATE') THEN
  IF NOT hon.follow_up_has_permission(target,org,school,'crm.follow_up.self_manage') OR NOT hon.follow_up_has_permission(target,org,school,'crm.lead.read') OR NOT hon.follow_up_authorized(actor,target) THEN RAISE EXCEPTION 'ASSIGNEE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  IF op='UPDATE' AND linked_lead IS DISTINCT FROM (p->>'leadId')::uuid THEN RAISE EXCEPTION 'IMMUTABLE_LEAD_LINK' USING ERRCODE='22023'; END IF;
  linked_lead:=(p->>'leadId')::uuid;
  PERFORM 1 FROM hon.crm_leads WHERE hon.crm_leads.id=linked_lead AND organization_id=org AND school_id=school FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FOLLOW_UP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  prior.assignee_id:=target; prior.subject:=p->>'subject'; prior.note:=p->>'note'; prior.due_at:=(p->>'dueAt')::timestamptz; prior.priority:=p->>'priority';
 END IF;
 IF op='CREATE' THEN
  INSERT INTO hon.crm_follow_ups(organization_id,school_id,lead_id,created_by_principal_id) VALUES(org,school,linked_lead,actor) RETURNING hon.crm_follow_ups.id INTO record_id;
 END IF;
 new_version:=coalesce(prior.version,0)+1; state:=CASE op WHEN 'COMPLETE' THEN 'COMPLETED' WHEN 'CANCEL' THEN 'CANCELLED' ELSE 'OPEN' END;
 INSERT INTO hon.crm_follow_up_versions(follow_up_id,organization_id,school_id,version,assignee_id,subject,note,due_at,priority,status,operation,completed_at,cancelled_at,actor_principal_id,source,request_id)
 VALUES(record_id,org,school,new_version,prior.assignee_id,prior.subject,prior.note,prior.due_at,prior.priority,state,op,CASE WHEN op='COMPLETE' THEN clock_timestamp() END,CASE WHEN op='CANCEL' THEN clock_timestamp() END,actor,'HUMAN_UI',request);
 result:=hon.follow_up_summary(record_id,new_version);
 PERFORM hon.require_follow_up_actor(subject);
 IF NOT hon.follow_up_authorized(actor,prior.assignee_id) THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF op IN('CREATE','UPDATE') AND (NOT hon.follow_up_has_permission(prior.assignee_id,org,school,'crm.follow_up.self_manage') OR NOT hon.follow_up_has_permission(prior.assignee_id,org,school,'crm.lead.read')) THEN RAISE EXCEPTION 'ASSIGNEE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 evidence:=jsonb_build_object('followUpId',record_id,'version',new_version,'operation',op,'status',state,'humanOnly',true,'internalOnly',true,'executionAllowed',false);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI',CASE WHEN actor=prior.assignee_id AND hon.follow_up_has_permission(actor,org,school,'crm.follow_up.self_manage') THEN 'crm.follow_up.self_manage' ELSE 'crm.follow_up.manage' END,'CRM_FOLLOW_UP',record_id,CASE WHEN new_version=1 THEN NULL ELSE jsonb_build_object('version',new_version-1) END,evidence,'SUCCEEDED',request,correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'crm.follow_up.human_revised',1,'CRM_FOLLOW_UP',record_id,new_version,correlation,request,evidence);
 INSERT INTO hon.crm_follow_up_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,key,fp,result);
 RETURN jsonb_build_object('followUp',result,'replayed',false);
END $$;
CREATE FUNCTION hon.read_follow_ups(subject text,p_id uuid,queue text,state text,after_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); manager boolean; current_assignee uuid; items jsonb;
BEGIN
 IF queue IS NULL OR queue NOT IN('mine','team') OR state IS NULL OR state NOT IN('OPEN','COMPLETED','CANCELLED','ALL') OR (p_id IS NOT NULL AND after_id IS NOT NULL) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_follow_up_actor(subject,NULL); manager:=hon.follow_up_has_permission(actor,org,school,'crm.follow_up.manage');
 IF queue='team' AND NOT manager THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_id IS NOT NULL THEN
  SELECT r.assignee_id INTO current_assignee FROM hon.crm_follow_ups f JOIN LATERAL(SELECT assignee_id FROM hon.crm_follow_up_versions WHERE follow_up_id=f.id ORDER BY version DESC LIMIT 1) r ON true WHERE f.id=p_id AND f.organization_id=org AND f.school_id=school;
  IF current_assignee IS NULL THEN RAISE EXCEPTION 'FOLLOW_UP_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  PERFORM hon.lock_follow_up_actor(subject,current_assignee);
  IF NOT hon.follow_up_authorized(actor,current_assignee) THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
  result:=hon.follow_up_summary(p_id,NULL);
 ELSE
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.id),'[]'::jsonb) INTO items FROM (
   SELECT f.id,jsonb_build_object('followUpId',f.id,'leadId',f.lead_id,'assigneeId',r.assignee_id,'version',r.version,'status',r.status,'priority',r.priority,'dueAt',CASE WHEN r.due_at IS NULL THEN NULL ELSE to_char(r.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) item
   FROM hon.crm_follow_ups f JOIN LATERAL(SELECT * FROM hon.crm_follow_up_versions WHERE follow_up_id=f.id ORDER BY version DESC LIMIT 1) r ON true
   WHERE f.organization_id=org AND f.school_id=school AND (after_id IS NULL OR f.id>after_id) AND (queue='team' OR r.assignee_id=actor) AND (state='ALL' OR r.status=state) ORDER BY f.id LIMIT 51
  ) x;
  result:=jsonb_build_object('schoolId',school,'principalId',actor,'canManage',manager,'humanOnly',true,'queue',queue,'status',state,'items',CASE WHEN jsonb_array_length(items)>50 THEN items-50 ELSE items END,'nextAfter',CASE WHEN jsonb_array_length(items)>50 THEN items->49->>'followUpId' ELSE NULL END);
 END IF;
 PERFORM hon.require_follow_up_actor(subject);
 IF queue='team' AND NOT hon.follow_up_has_permission(actor,org,school,'crm.follow_up.manage') THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_id IS NOT NULL AND NOT hon.follow_up_authorized(actor,current_assignee) THEN RAISE EXCEPTION 'FOLLOW_UP_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON TABLE hon.crm_follow_ups,hon.crm_follow_up_versions,hon.crm_follow_up_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_follow_up_history(),hon.validate_follow_up_input(text,jsonb),hon.follow_up_has_permission(uuid,uuid,uuid,text),hon.resolve_follow_up_scope(text),hon.require_follow_up_actor(text),hon.lock_follow_up_actor(text,uuid),hon.follow_up_authorized(uuid,uuid),hon.follow_up_summary(uuid,integer),hon.guard_follow_up_insert(),hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid),hon.read_follow_ups(text,uuid,text,text,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.crm_follow_ups,hon.crm_follow_up_versions,hon.crm_follow_up_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_follow_up_history(),hon.validate_follow_up_input(text,jsonb),hon.follow_up_has_permission(uuid,uuid,uuid,text),hon.resolve_follow_up_scope(text),hon.require_follow_up_actor(text),hon.lock_follow_up_actor(text,uuid),hon.follow_up_authorized(uuid,uuid),hon.follow_up_summary(uuid,integer),hon.guard_follow_up_insert(),hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid),hon.read_follow_ups(text,uuid,text,text,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_follow_up_scope(text),hon.mutate_follow_up(text,text,uuid,jsonb,text,uuid,uuid),hon.read_follow_ups(text,uuid,text,text,uuid) TO hon_runtime; END IF;
END $$;
COMMIT;
