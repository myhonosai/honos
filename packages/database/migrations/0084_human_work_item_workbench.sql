BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Trusted workbench migration owner required'; END IF;
END $$;
-- Preserve every legacy state and row; only explicitly HUMAN_UI records enter this workbench.
ALTER TABLE hon.work_items ADD COLUMN work_origin text NOT NULL DEFAULT 'LEGACY',
 ADD COLUMN title text, ADD COLUMN description text, ADD COLUMN priority text,
 ADD COLUMN due_at timestamptz, ADD COLUMN created_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT;
ALTER TABLE hon.work_items ADD CONSTRAINT human_work_shape CHECK (
 work_origin IN('LEGACY','HUMAN_UI') AND (work_origin='LEGACY' OR (
 title IS NOT NULL AND length(title) BETWEEN 1 AND 120 AND description IS NOT NULL AND length(description)<=2000
 AND priority IS NOT NULL AND priority IN('LOW','NORMAL','HIGH') AND created_by_principal_id IS NOT NULL
 AND work_type='HUMAN_TASK' AND status IN('READY','WORKING','WAITING','NEEDS_ATTENTION','COMPLETED','FAILED')
 AND payload='{}'::jsonb AND result IS NULL AND error_reason IS NULL AND subject_type IS NULL AND subject_id IS NULL AND parent_work_item_id IS NULL
 AND (due_at IS NULL OR (due_at>=timestamptz '2000-01-01Z' AND due_at<timestamptz '2100-01-01Z')))));
CREATE INDEX human_work_queue_idx ON hon.work_items(organization_id,school_id,id) WHERE work_origin='HUMAN_UI';
UPDATE hon.permissions SET is_staff_assignable=true WHERE code IN('work_item.create','work_item.read','work_item.manage');
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
 VALUES('work_item.self_manage','Read current assigned human work and update its state only',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT id,organization_id,'work_item.self_manage' FROM hon.roles WHERE code='OWNER' AND is_system_role ON CONFLICT DO NOTHING;
CREATE TABLE hon.human_work_history (
 work_item_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999), operation text NOT NULL CHECK(operation IN('CREATE','UPDATE','TRANSITION')),
 status text NOT NULL CHECK(status IN('READY','WORKING','WAITING','NEEDS_ATTENTION','COMPLETED','FAILED')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120), description text NOT NULL CHECK(length(description)<=2000),
 priority text NOT NULL CHECK(priority IN('LOW','NORMAL','HIGH')), due_at timestamptz,
 assignee_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT, actor_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(work_item_id,version), FOREIGN KEY(work_item_id,organization_id,school_id) REFERENCES hon.work_items(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.human_work_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 work_item_id uuid NOT NULL, receipt_version integer NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,actor_id,idempotency_key),
 FOREIGN KEY(work_item_id,receipt_version) REFERENCES hon.human_work_history(work_item_id,version) ON DELETE RESTRICT,
 FOREIGN KEY(work_item_id,organization_id,school_id) REFERENCES hon.work_items(id,organization_id,school_id) ON DELETE RESTRICT
);
ALTER TABLE hon.human_work_history ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.human_work_history FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.human_work_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.human_work_requests FORCE ROW LEVEL SECURITY;
DROP POLICY work_items_tenant_isolation ON hon.work_items;
-- Deny-all forced RLS, including legacy rows. Only fixed definer boundaries may read/lock them.
CREATE FUNCTION hon.guard_human_work_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_HUMAN_WORK_HISTORY' USING ERRCODE='42501'; END $$;
CREATE TRIGGER human_work_history_immutable BEFORE UPDATE OR DELETE ON hon.human_work_history FOR EACH ROW EXECUTE FUNCTION hon.guard_human_work_history();
CREATE TRIGGER human_work_history_no_truncate BEFORE TRUNCATE ON hon.human_work_history FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_human_work_history();
CREATE TRIGGER human_work_requests_immutable BEFORE UPDATE OR DELETE ON hon.human_work_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_human_work_history();
CREATE TRIGGER human_work_requests_no_truncate BEFORE TRUNCATE ON hon.human_work_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_human_work_history();
CREATE FUNCTION hon.validate_human_work(op text,p jsonb) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE keys text[]; k text; v text;
BEGIN
 IF op IS NULL OR op NOT IN('CREATE','UPDATE','TRANSITION') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 keys:=CASE WHEN op='TRANSITION' THEN ARRAY['expectedVersion','targetStatus'] ELSE ARRAY['expectedVersion','title','description','priority','dueAt','assigneeId'] END;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p))<>cardinality(keys) OR NOT p ?& keys
 OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR p->>'expectedVersion' !~ '^(0|[1-9][0-9]{0,8})$'
 OR (p->>'expectedVersion')::numeric NOT BETWEEN (CASE WHEN op='CREATE' THEN 0 ELSE 1 END) AND 999999998 OR (op='CREATE' AND p->>'expectedVersion'<>'0') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF op='TRANSITION' THEN
  IF jsonb_typeof(p->'targetStatus') IS DISTINCT FROM 'string' OR p->>'targetStatus' NOT IN('READY','WORKING','WAITING','NEEDS_ATTENTION','COMPLETED','FAILED') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  RETURN;
 END IF;
 FOR k IN SELECT unnest(ARRAY['title','description']) LOOP
  v:=p->>k;
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(v) NOT BETWEEN (CASE WHEN k='title' THEN 1 ELSE 0 END) AND (CASE WHEN k='title' THEN 120 ELSE 2000 END)
  OR btrim(v,E' \t\n\r')<>v OR (CASE WHEN k='description' THEN replace(v,E'\n','') ELSE v END) ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF jsonb_typeof(p->'priority') IS DISTINCT FROM 'string' OR p->>'priority' NOT IN('LOW','NORMAL','HIGH') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p->'assigneeId'<>'null'::jsonb AND (jsonb_typeof(p->'assigneeId') IS DISTINCT FROM 'string' OR p->>'assigneeId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p->'dueAt'<>'null'::jsonb THEN
  v:=p->>'dueAt';
  IF jsonb_typeof(p->'dueAt') IS DISTINCT FROM 'string' OR v !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR to_char(v::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>v THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
END $$;
-- Never borrow organization-wide, HQ, family or another school's authority.
CREATE FUNCTION hon.human_work_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT COALESCE(permission IN('work_item.create','work_item.manage','work_item.self_manage') AND hon.staff_member_eligible(actor,org,school)
 AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id WHERE g.principal_id=actor
  AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY)' AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
 AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=permission
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=school) AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'),false)
$$;
CREATE FUNCTION hon.resolve_human_work_scope(subject text) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS(SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id
 WHERE u.external_subject=subject AND (hon.human_work_permission(p.id,g.organization_id,g.school_id,'work_item.create') OR hon.human_work_permission(p.id,g.organization_id,g.school_id,'work_item.manage') OR hon.human_work_permission(p.id,g.organization_id,g.school_id,'work_item.self_manage')))
 SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1
$$;
CREATE FUNCTION hon.require_human_work_actor(subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=subject AND p.id::text=current_setting('app.hon_principal_id',true);
 IF actor IS NULL OR COALESCE(hon.human_work_permission(actor,org,school,'work_item.create') OR hon.human_work_permission(actor,org,school,'work_item.manage') OR hon.human_work_permission(actor,org,school,'work_item.self_manage'),false) IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'WORK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_human_work_actor(subject text,targets uuid[]) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); locked_principals uuid[];
BEGIN
 -- School serialization bounds concurrency and also closes the insertion/revocation gap.
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_human_work_actor(subject); locked_principals:=array_append(coalesce(targets,ARRAY[]::uuid[]),actor);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=ANY(locked_principals)) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=ANY(locked_principals) ORDER BY id FOR UPDATE;
 -- Include all grants (even other schools) so mixed parent-role eligibility is live and locked.
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=ANY(locked_principals) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=ANY(locked_principals)) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=ANY(locked_principals)) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.hq_operator_grants WHERE principal_id=ANY(locked_principals) ORDER BY principal_id FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_human_work_actor(subject);
END $$;
CREATE FUNCTION hon.human_work_visible(actor uuid,w hon.work_items) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT COALESCE(w.work_origin='HUMAN_UI' AND w.organization_id=hon.current_organization_id() AND w.school_id=hon.current_school_id()
 AND (hon.human_work_permission(actor,w.organization_id,w.school_id,'work_item.manage')
 OR (w.assigned_principal_id IS NOT NULL AND actor IS NOT DISTINCT FROM w.assigned_principal_id AND hon.human_work_permission(actor,w.organization_id,w.school_id,'work_item.self_manage'))
 OR (w.created_by_principal_id IS NOT NULL AND actor IS NOT DISTINCT FROM w.created_by_principal_id AND hon.human_work_permission(actor,w.organization_id,w.school_id,'work_item.create'))),false)
$$;
CREATE FUNCTION hon.human_work_transition_allowed(f text,t text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,hon AS $$
 SELECT CASE f WHEN 'READY' THEN t IN('WORKING','WAITING','NEEDS_ATTENTION','FAILED')
 WHEN 'WORKING' THEN t IN('WAITING','COMPLETED','NEEDS_ATTENTION','FAILED')
 WHEN 'WAITING' THEN t IN('READY','WORKING','NEEDS_ATTENTION','FAILED')
 WHEN 'NEEDS_ATTENTION' THEN t IN('READY','FAILED') ELSE false END
$$;
CREATE FUNCTION hon.human_work_snapshot(p_id uuid,v integer,actor uuid,before_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('workItemId',w.id,'schoolId',w.school_id,'version',h.version,'status',h.status,'title',h.title,'description',h.description,
 'priority',h.priority,'dueAt',CASE WHEN h.due_at IS NULL THEN NULL ELSE to_char(h.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
 'assigneeId',h.assignee_id,'createdBy',w.created_by_principal_id,'createdAt',w.created_at,'updatedAt',h.recorded_at,'humanOnly',true,'executionAllowed',false,
 'canEdit',COALESCE(hon.human_work_permission(actor,w.organization_id,w.school_id,'work_item.manage') AND w.status NOT IN('COMPLETED','FAILED'),false),
 'canTransition',COALESCE((hon.human_work_permission(actor,w.organization_id,w.school_id,'work_item.manage') OR (w.assigned_principal_id IS NOT NULL AND actor IS NOT DISTINCT FROM w.assigned_principal_id AND hon.human_work_permission(actor,w.organization_id,w.school_id,'work_item.self_manage'))) AND w.status NOT IN('COMPLETED','FAILED'),false),
 'aiPlanIds',coalesce((SELECT jsonb_agg(x.id) FROM(SELECT id FROM hon.ai_invocation_plans WHERE work_item_id=w.id AND organization_id=w.organization_id AND school_id=w.school_id ORDER BY created_at DESC,id DESC LIMIT 20)x),'[]'::jsonb),
 'history',coalesce((SELECT jsonb_agg(jsonb_build_object('version',x.version,'operation',x.operation,'status',x.status,'assigneeId',x.assignee_id,'actorId',x.actor_id,'recordedAt',x.recorded_at) ORDER BY x.version DESC)
 FROM(SELECT * FROM hon.human_work_history WHERE work_item_id=w.id AND version<=h.version AND (before_version IS NULL OR version<before_version) ORDER BY version DESC LIMIT 50)x),'[]'::jsonb),
 'nextBeforeVersion',(SELECT CASE WHEN count(*)=51 THEN min(version)+1 ELSE NULL END FROM(SELECT version FROM hon.human_work_history WHERE work_item_id=w.id AND version<=h.version AND (before_version IS NULL OR version<before_version) ORDER BY version DESC LIMIT 51)x))
 FROM hon.work_items w JOIN hon.human_work_history h ON h.work_item_id=w.id AND h.version=coalesce(v,w.version)
 WHERE w.id=p_id AND hon.human_work_visible(actor,w)
$$;
CREATE FUNCTION hon.guard_human_work_row() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP='TRUNCATE' OR (TG_OP='DELETE' AND OLD.work_origin='HUMAN_UI') THEN RAISE EXCEPTION 'WORK_HARD_DELETE_DENIED' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.work_origin='HUMAN_UI' THEN
  PERFORM hon.validate_human_work(CASE WHEN TG_OP='INSERT' THEN 'CREATE' ELSE 'UPDATE' END,
   jsonb_build_object('expectedVersion',CASE WHEN TG_OP='INSERT' THEN 0 ELSE NEW.version-1 END,'title',NEW.title,'description',NEW.description,'priority',NEW.priority,
    'dueAt',CASE WHEN NEW.due_at IS NULL THEN NULL ELSE to_char(NEW.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'assigneeId',NEW.assigned_principal_id));
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'READY' OR NEW.version<>1 THEN RAISE EXCEPTION 'INVALID_WORK_INITIAL_STATE' USING ERRCODE='23514'; END IF;
  ELSE
   IF (to_jsonb(NEW)-ARRAY['title','description','priority','due_at','assigned_principal_id','status','version','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['title','description','priority','due_at','assigned_principal_id','status','version','updated_at']) OR NEW.version<>OLD.version+1
    OR OLD.status IN('COMPLETED','FAILED') OR (NEW.status<>OLD.status AND NOT hon.human_work_transition_allowed(OLD.status,NEW.status)) THEN RAISE EXCEPTION 'INVALID_WORK_REVISION' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF TG_OP='UPDATE' AND OLD.work_origin='HUMAN_UI' THEN RAISE EXCEPTION 'IMMUTABLE_WORK_ORIGIN' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER human_work_row_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.work_items FOR EACH ROW EXECUTE FUNCTION hon.guard_human_work_row();
CREATE TRIGGER human_work_no_truncate BEFORE TRUNCATE ON hon.work_items FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_human_work_row();
CREATE FUNCTION hon.mutate_human_work(subject text,op text,p_id uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); record_id uuid:=p_id; w hon.work_items%ROWTYPE;
 receipt hon.human_work_requests%ROWTYPE; fp text; target uuid; manager boolean; evidence jsonb; result jsonb;
BEGIN
 PERFORM hon.validate_human_work(op,p);
 IF (op='CREATE')<>(p_id IS NULL) OR key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key ~ '[[:cntrl:]]'
 OR request IS NULL OR correlation IS NULL OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_human_work_actor(subject,ARRAY[]::uuid[]);
 fp:=encode(sha256(convert_to(jsonb_build_object('operation',op,'id',p_id,'input',p)::text,'UTF8')),'hex');
 SELECT * INTO receipt FROM hon.human_work_requests WHERE organization_id=org AND school_id=school AND actor_id=actor AND idempotency_key=key;
 IF FOUND THEN
  IF receipt.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  record_id:=receipt.work_item_id;
 END IF;
 IF record_id IS NOT NULL THEN
  SELECT * INTO w FROM hon.work_items WHERE id=record_id AND organization_id=org AND school_id=school AND work_origin='HUMAN_UI' FOR UPDATE;
  IF NOT FOUND OR hon.human_work_visible(actor,w) IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 END IF;
 target:=CASE WHEN op IN('CREATE','UPDATE') THEN (p->>'assigneeId')::uuid ELSE w.assigned_principal_id END;
 actor:=hon.lock_human_work_actor(subject,ARRAY[target,w.assigned_principal_id]);
 manager:=COALESCE(hon.human_work_permission(actor,org,school,'work_item.manage'),false);
 IF op='CREATE' AND hon.human_work_permission(actor,org,school,'work_item.create') IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_CREATE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF op='UPDATE' AND manager IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_MANAGE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF op='TRANSITION' AND COALESCE(manager OR (w.assigned_principal_id IS NOT NULL AND actor IS NOT DISTINCT FROM w.assigned_principal_id AND hon.human_work_permission(actor,org,school,'work_item.self_manage')),false) IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_TRANSITION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF op IN('CREATE','UPDATE') THEN
  IF target IS NOT NULL AND hon.human_work_permission(target,org,school,'work_item.self_manage') IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSIGNEE_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  IF op='CREATE' AND target IS NOT NULL AND target<>actor AND manager IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_ASSIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
 END IF;
 IF receipt.fingerprint IS NOT NULL THEN
  -- Current authorization always precedes replay; response is an explicitly saved revision, not current state.
  result:=hon.human_work_snapshot(record_id,receipt.receipt_version,actor,NULL);
  PERFORM hon.require_human_work_actor(subject);
  manager:=COALESCE(hon.human_work_permission(actor,org,school,'work_item.manage'),false);
  IF (op='UPDATE' OR (op='CREATE' AND target IS NOT NULL AND target<>actor)) AND manager IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF op='TRANSITION' AND COALESCE(manager OR (w.assigned_principal_id IS NOT NULL AND actor IS NOT DISTINCT FROM w.assigned_principal_id AND hon.human_work_permission(actor,org,school,'work_item.self_manage')),false) IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF target IS NOT NULL AND op IN('CREATE','UPDATE') AND hon.human_work_permission(target,org,school,'work_item.self_manage') IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('workItem',result,'replayed',true);
 END IF;
 IF coalesce(w.version,0)<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 IF op<>'CREATE' AND w.status IN('COMPLETED','FAILED') THEN RAISE EXCEPTION 'WORK_TERMINAL_REOPEN_DENIED' USING ERRCODE='40001'; END IF;
 IF op='TRANSITION' AND NOT hon.human_work_transition_allowed(w.status,p->>'targetStatus') THEN RAISE EXCEPTION 'WORK_TRANSITION_DENIED' USING ERRCODE='40001'; END IF;
 IF op='CREATE' THEN
  INSERT INTO hon.work_items(organization_id,school_id,work_origin,work_type,status,title,description,priority,due_at,assigned_principal_id,created_by_principal_id,correlation_id)
  VALUES(org,school,'HUMAN_UI','HUMAN_TASK','READY',p->>'title',p->>'description',p->>'priority',(p->>'dueAt')::timestamptz,target,actor,correlation) RETURNING * INTO w;
 ELSE
  UPDATE hon.work_items SET title=CASE WHEN op='UPDATE' THEN p->>'title' ELSE title END,
   description=CASE WHEN op='UPDATE' THEN p->>'description' ELSE description END, priority=CASE WHEN op='UPDATE' THEN p->>'priority' ELSE priority END,
   due_at=CASE WHEN op='UPDATE' THEN (p->>'dueAt')::timestamptz ELSE due_at END,
   assigned_principal_id=CASE WHEN op='UPDATE' THEN target ELSE assigned_principal_id END,
   status=CASE WHEN op='TRANSITION' THEN p->>'targetStatus' ELSE status END,version=version+1,updated_at=clock_timestamp()
  WHERE id=record_id AND organization_id=org AND school_id=school AND version=(p->>'expectedVersion')::integer RETURNING * INTO w;
 END IF;
 INSERT INTO hon.human_work_history(work_item_id,organization_id,school_id,version,operation,status,title,description,priority,due_at,assignee_id,actor_id,request_id)
 VALUES(w.id,org,school,w.version,op,w.status,w.title,w.description,w.priority,w.due_at,w.assigned_principal_id,actor,request);
 PERFORM hon.require_human_work_actor(subject);
 manager:=COALESCE(hon.human_work_permission(actor,org,school,'work_item.manage'),false);
 IF (op='CREATE' AND hon.human_work_permission(actor,org,school,'work_item.create') IS DISTINCT FROM true) OR (op='UPDATE' AND manager IS DISTINCT FROM true)
 OR (op='TRANSITION' AND COALESCE(manager OR (w.assigned_principal_id IS NOT NULL AND actor IS NOT DISTINCT FROM w.assigned_principal_id AND hon.human_work_permission(actor,org,school,'work_item.self_manage')),false) IS DISTINCT FROM true)
 OR (op='CREATE' AND target IS NOT NULL AND target<>actor AND manager IS DISTINCT FROM true)
 OR (op IN('CREATE','UPDATE') AND target IS NOT NULL AND hon.human_work_permission(target,org,school,'work_item.self_manage') IS DISTINCT FROM true) THEN RAISE EXCEPTION 'WORK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 evidence:=jsonb_build_object('workItemId',w.id,'version',w.version,'operation',op,'status',w.status,'humanOnly',true,'internalOnly',true,'executionAllowed',false);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI',CASE WHEN op='CREATE' THEN 'work_item.create' WHEN op='UPDATE' OR manager THEN 'work_item.manage' ELSE 'work_item.self_manage' END,'HUMAN_WORK_ITEM',w.id,CASE WHEN w.version=1 THEN NULL ELSE jsonb_build_object('version',w.version-1) END,evidence,'SUCCEEDED',request,correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'work_item.human_recorded',1,'HUMAN_WORK_ITEM',w.id,w.version,correlation,request,evidence);
 INSERT INTO hon.human_work_requests(organization_id,school_id,actor_id,idempotency_key,fingerprint,work_item_id,receipt_version) VALUES(org,school,actor,key,fp,w.id,w.version);
 result:=hon.human_work_snapshot(w.id,w.version,actor,NULL);
 RETURN jsonb_build_object('workItem',result,'replayed',false);
END $$;
CREATE FUNCTION hon.read_human_work(subject text,p_id uuid,queue text,state text,after_id uuid,before_version integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); manager boolean; w hon.work_items%ROWTYPE; items jsonb; result jsonb;
BEGIN
 IF queue IS NULL OR queue NOT IN('mine','team') OR state IS NULL OR state NOT IN('ACTIVE','ALL','READY','WORKING','WAITING','NEEDS_ATTENTION','COMPLETED','FAILED')
 OR (p_id IS NOT NULL AND after_id IS NOT NULL) OR (before_version IS NOT NULL AND (p_id IS NULL OR before_version NOT BETWEEN 2 AND 999999999)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_human_work_actor(subject,ARRAY[]::uuid[]); manager:=COALESCE(hon.human_work_permission(actor,org,school,'work_item.manage'),false);
 IF queue='team' AND manager IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_TEAM_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_id IS NOT NULL THEN
  SELECT * INTO w FROM hon.work_items WHERE id=p_id AND organization_id=org AND school_id=school AND work_origin='HUMAN_UI' FOR SHARE;
  IF NOT FOUND OR hon.human_work_visible(actor,w) IS DISTINCT FROM true THEN RAISE EXCEPTION 'WORK_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
  actor:=hon.lock_human_work_actor(subject,ARRAY[w.assigned_principal_id]);
  result:=hon.human_work_snapshot(p_id,NULL,actor,before_version);
 ELSE
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.id),'[]'::jsonb) INTO items FROM (
   SELECT id,jsonb_build_object('title',title,'workItemId',id,'version',version,'status',status,'priority',priority,'dueAt',CASE WHEN due_at IS NULL THEN NULL ELSE to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'assigneeId',assigned_principal_id) item
   FROM hon.work_items wi WHERE work_origin='HUMAN_UI' AND organization_id=org AND school_id=school AND (after_id IS NULL OR id>after_id)
   AND (queue='team' OR assigned_principal_id=actor OR (created_by_principal_id=actor AND hon.human_work_permission(actor,org,school,'work_item.create')))
   AND hon.human_work_visible(actor,wi) AND (state='ALL' OR (state='ACTIVE' AND status NOT IN('COMPLETED','FAILED')) OR status=state) ORDER BY id LIMIT 51)x;
  result:=jsonb_build_object('schoolId',school,'principalId',actor,'canManage',manager,'canCreate',hon.human_work_permission(actor,org,school,'work_item.create'),'humanOnly',true,'executionAllowed',false,'queue',queue,'status',state,
   'items',CASE WHEN jsonb_array_length(items)>50 THEN items-50 ELSE items END,'nextAfter',CASE WHEN jsonb_array_length(items)>50 THEN items->49->>'workItemId' ELSE NULL END);
 END IF;
 PERFORM hon.require_human_work_actor(subject);
 manager:=COALESCE(hon.human_work_permission(actor,org,school,'work_item.manage'),false);
 IF (queue='team' AND manager IS DISTINCT FROM true) OR (p_id IS NOT NULL AND hon.human_work_visible(actor,w) IS DISTINCT FROM true) THEN RAISE EXCEPTION 'WORK_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;
-- Preserve existing decision-only AI planner's reference lock without exposing any work rows.
CREATE FUNCTION hon.lock_ai_planning_work_reference(p_id uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 PERFORM hon.require_ai_invocation_plan_access();
 PERFORM id FROM hon.work_items WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORK_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
END $$;
REVOKE ALL ON TABLE hon.work_items,hon.human_work_history,hon.human_work_requests FROM PUBLIC;
DO $$ DECLARE r text; signature text; BEGIN
 FOR signature IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN(
 'guard_human_work_history','validate_human_work','human_work_permission','resolve_human_work_scope','require_human_work_actor','lock_human_work_actor','human_work_visible','human_work_transition_allowed','human_work_snapshot','guard_human_work_row','mutate_human_work','read_human_work','lock_ai_planning_work_reference') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,r); END LOOP;
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.work_items,hon.human_work_history,hon.human_work_requests FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_human_work_scope(text),hon.mutate_human_work(text,text,uuid,jsonb,text,uuid,uuid),hon.read_human_work(text,uuid,text,text,uuid,integer),hon.lock_ai_planning_work_reference(uuid) TO hon_runtime; END IF;
END $$;
COMMIT;
