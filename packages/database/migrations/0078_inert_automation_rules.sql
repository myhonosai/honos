BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Trusted automation migration owner required'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('automation.rule.read','Human exact school automation configuration read; no execution',true,true),
 ('automation.rule.manage','Human exact school automation configuration revisions; no execution',true,true),
 ('automation.rule.dry_run','Human synthetic automation evaluation plans; no execution or writes',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p WHERE r.is_system_role AND r.code='OWNER'
 AND p.code IN('automation.rule.read','automation.rule.manage','automation.rule.dry_run') ON CONFLICT DO NOTHING;
CREATE TABLE hon.automation_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,school_id), FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE hon.automation_rule_versions (
 rule_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 999999999), payload jsonb NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source='HUMAN_UI'), request_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(rule_id,version), FOREIGN KEY(rule_id,organization_id,school_id) REFERENCES hon.automation_rules(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.automation_rule_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 response jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT
);
ALTER TABLE hon.automation_rules ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.automation_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.automation_rule_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.automation_rule_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.automation_rule_requests ENABLE ROW LEVEL SECURITY; ALTER TABLE hon.automation_rule_requests FORCE ROW LEVEL SECURITY;
-- Deliberately no policies or runtime table ACLs.
CREATE FUNCTION hon.guard_automation_history() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_AUTOMATION_CONFIGURATION' USING ERRCODE='42501'; END $$;
CREATE TRIGGER automation_rules_immutable BEFORE UPDATE OR DELETE ON hon.automation_rules FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_history();
CREATE TRIGGER automation_rules_no_truncate BEFORE TRUNCATE ON hon.automation_rules FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_automation_history();
CREATE TRIGGER automation_versions_immutable BEFORE UPDATE OR DELETE ON hon.automation_rule_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_history();
CREATE TRIGGER automation_versions_no_truncate BEFORE TRUNCATE ON hon.automation_rule_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_automation_history();
CREATE TRIGGER automation_requests_immutable BEFORE UPDATE OR DELETE ON hon.automation_rule_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_history();
CREATE TRIGGER automation_requests_no_truncate BEFORE TRUNCATE ON hon.automation_rule_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_automation_history();
CREATE FUNCTION hon.automation_closed(p jsonb,keys text[]) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,hon AS $$
 SELECT CASE WHEN jsonb_typeof(p)='object' THEN (SELECT count(*) FROM jsonb_object_keys(p))=cardinality(keys) AND p ?& keys ELSE false END
$$;
CREATE FUNCTION hon.validate_automation_input(p jsonb,dry boolean) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE x jsonb; kind text; v text; k text; lo integer; hi integer;
BEGIN
 IF dry IS NULL OR NOT hon.automation_closed(p,CASE WHEN dry THEN ARRAY['expectedVersion','event','simulation'] ELSE ARRAY['expectedVersion','name','enabled','triggerKind','conditions','proposal','posture','schedule'] END)
 OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$'
 OR (p->>'expectedVersion')::numeric NOT BETWEEN (CASE WHEN dry THEN 1 ELSE 0 END) AND (CASE WHEN dry THEN 999999999 ELSE 999999998 END) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF dry THEN
  x:=p->'event'; kind:=x->>'triggerKind';
  IF NOT hon.automation_closed(x,ARRAY['synthetic','triggerKind','schemaVersion','aggregateVersion','source']) OR x->'synthetic' IS DISTINCT FROM 'true'::jsonb OR x->'schemaVersion' IS DISTINCT FROM '1'::jsonb
  OR jsonb_typeof(x->'triggerKind') IS DISTINCT FROM 'string' OR kind NOT IN('LEAD_CREATED','TRIAL_NO_SHOW')
  OR jsonb_typeof(x->'source') IS DISTINCT FROM 'string' OR x->>'source' NOT IN('HUMAN_UI','PUBLIC_API') OR (kind='TRIAL_NO_SHOW' AND x->>'source'<>'HUMAN_UI')
  OR jsonb_typeof(x->'aggregateVersion') IS DISTINCT FROM 'number' OR x->>'aggregateVersion' !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  x:=p->'simulation';
  IF NOT hon.automation_closed(x,ARRAY['localDate','minutesSincePriorPlan']) OR (x->'minutesSincePriorPlan'<>'null'::jsonb AND (jsonb_typeof(x->'minutesSincePriorPlan') IS DISTINCT FROM 'number' OR x->>'minutesSincePriorPlan' !~ '^(0|[1-9][0-9]{0,6})$' OR (x->>'minutesSincePriorPlan')::numeric>5256000)) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  v:=x->>'localDate';
  IF jsonb_typeof(x->'localDate') IS DISTINCT FROM 'string' OR v !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' OR to_char(v::date,'YYYY-MM-DD')<>v THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 ELSE
  kind:=p->>'triggerKind'; v:=p->>'name';
  IF jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR length(v) NOT BETWEEN 1 AND 100 OR btrim(v)<>v OR v ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]'
  OR jsonb_typeof(p->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p->'triggerKind') IS DISTINCT FROM 'string' OR kind NOT IN('LEAD_CREATED','TRIAL_NO_SHOW') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  x:=p->'conditions';
  IF NOT hon.automation_closed(x,ARRAY['source','minimumAggregateVersion']) OR jsonb_typeof(x->'source') IS DISTINCT FROM 'string' OR x->>'source' NOT IN('ANY','HUMAN_UI','PUBLIC_API') OR (kind='TRIAL_NO_SHOW' AND x->>'source'='PUBLIC_API')
  OR jsonb_typeof(x->'minimumAggregateVersion') IS DISTINCT FROM 'number' OR x->>'minimumAggregateVersion' !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  x:=p->'proposal';
  IF NOT hon.automation_closed(x,ARRAY['kind','category','priority']) OR x->'kind' IS DISTINCT FROM '"MANUAL_REVIEW_TEMPLATE"'::jsonb
  OR x->'category' IS DISTINCT FROM to_jsonb(CASE kind WHEN 'LEAD_CREATED' THEN 'LEAD_TRIAGE'::text ELSE 'TRIAL_ATTENDANCE_REVIEW'::text END)
  OR jsonb_typeof(x->'priority') IS DISTINCT FROM 'string' OR x->>'priority' NOT IN('NORMAL','HIGH') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p->'posture' IS DISTINCT FROM '{"authority":"NONE","approval":"HUMAN_REVIEW_REQUIRED"}'::jsonb THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  x:=p->'schedule';
  IF NOT hon.automation_closed(x,ARRAY['mode','effectiveFrom','endsOn','cooldownMinutes']) OR x->'mode' IS DISTINCT FROM '"MANUAL_ONLY"'::jsonb
  OR jsonb_typeof(x->'cooldownMinutes') IS DISTINCT FROM 'number' OR x->>'cooldownMinutes' !~ '^(0|[1-9][0-9]{0,4})$' OR (x->>'cooldownMinutes')::numeric>10080 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  FOR k IN SELECT unnest(ARRAY['effectiveFrom','endsOn']) LOOP
   IF k='endsOn' AND x->k='null'::jsonb THEN CONTINUE; END IF;
   v:=x->>k;
   IF jsonb_typeof(x->k) IS DISTINCT FROM 'string' OR v !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' OR to_char(v::date,'YYYY-MM-DD')<>v THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF x->'endsOn'<>'null'::jsonb AND ((x->>'endsOn')::date-(x->>'effectiveFrom')::date NOT BETWEEN 1 AND 3660) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 END IF;
END $$;
CREATE FUNCTION hon.automation_has_permission(actor uuid,org uuid,school uuid,permission text) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT permission IN('automation.rule.read','automation.rule.manage','automation.rule.dry_run') AND hon.staff_member_eligible(actor,org,school) AND EXISTS(
 SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school AND rp.permission_code=permission AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND (r.management_school_id IS NULL OR r.management_school_id=school) AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
$$;
CREATE FUNCTION hon.resolve_automation_rule_scope(subject text,permission text) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS(SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id JOIN hon.principal_role_grants g ON g.principal_id=p.id WHERE u.external_subject=subject AND hon.automation_has_permission(p.id,g.organization_id,g.school_id,permission))
 SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1
$$;
CREATE FUNCTION hon.require_automation_actor(subject text,permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'HUMAN_UI_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=subject AND p.id::text=current_setting('app.hon_principal_id',true);
 IF actor IS NULL OR hon.automation_has_permission(actor,org,school,permission) IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'AUTOMATION_CONFIGURATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_automation_actor(subject text,permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_CONFIGURATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_CONFIGURATION_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_automation_actor(subject,permission);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_automation_actor(subject,permission);
END $$;
CREATE FUNCTION hon.automation_rule_summary(p_id uuid,v integer) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT payload || jsonb_build_object('ruleId',rule_id,'schoolId',school_id,'version',version,'recordedAt',recorded_at,'configurationOnly',true)
 FROM hon.automation_rule_versions WHERE rule_id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND (v IS NULL OR version=v) ORDER BY version DESC LIMIT 1
$$;
CREATE FUNCTION hon.guard_automation_insert() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; subject text; current_version integer;
BEGIN
 actor:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
 SELECT u.external_subject INTO subject FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE p.id=actor;
 PERFORM hon.require_automation_actor(subject,'automation.rule.manage');
 IF NEW.organization_id IS DISTINCT FROM hon.current_organization_id() OR NEW.school_id IS DISTINCT FROM hon.current_school_id() THEN RAISE EXCEPTION 'INVALID_AUTOMATION_SCOPE' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='automation_rules' THEN
  IF NEW.created_by_principal_id IS DISTINCT FROM actor THEN RAISE EXCEPTION 'INVALID_AUTOMATION_ACTOR' USING ERRCODE='23514'; END IF;
 ELSE
  PERFORM hon.validate_automation_input(NEW.payload,false);
  PERFORM 1 FROM hon.automation_rules WHERE id=NEW.rule_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id FOR UPDATE;
  IF NOT FOUND OR NEW.actor_principal_id IS DISTINCT FROM actor OR NEW.request_id::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'INVALID_AUTOMATION_VERSION' USING ERRCODE='23514'; END IF;
  SELECT coalesce(max(version),0) INTO current_version FROM hon.automation_rule_versions WHERE rule_id=NEW.rule_id;
  IF NEW.version<>current_version+1 OR (NEW.payload->>'expectedVersion')::integer<>current_version THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automation_rule_insert_guard BEFORE INSERT ON hon.automation_rules FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_insert();
CREATE TRIGGER automation_version_insert_guard BEFORE INSERT ON hon.automation_rule_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_automation_insert();
CREATE FUNCTION hon.save_automation_rule(subject text,p_id uuid,p jsonb,key text,request uuid,correlation uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); fp text; previous hon.automation_rule_requests%ROWTYPE; rule uuid:=p_id; current_version integer; result jsonb; evidence jsonb;
BEGIN
 PERFORM hon.validate_automation_input(p,false);
 IF key IS NULL OR length(key) NOT BETWEEN 1 AND 200 OR btrim(key)<>key OR key ~ '[[:cntrl:]]' OR request IS NULL OR correlation IS NULL OR request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_automation_actor(subject,'automation.rule.manage');
 fp:=encode(sha256(convert_to(jsonb_build_object('id',p_id,'input',p)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.automation_rule_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  PERFORM hon.require_automation_actor(subject,'automation.rule.manage'); RETURN jsonb_build_object('rule',previous.response,'replayed',true);
 END IF;
 IF p_id IS NULL THEN
  IF (p->>'expectedVersion')::integer<>0 THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF (SELECT count(*) FROM hon.automation_rules WHERE organization_id=org AND school_id=school)>=100 THEN RAISE EXCEPTION 'RULE_LIMIT' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.automation_rules(organization_id,school_id,created_by_principal_id) VALUES(org,school,actor) RETURNING hon.automation_rules.id INTO rule;
 ELSE
  PERFORM 1 FROM hon.automation_rules WHERE hon.automation_rules.id=p_id AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_RULE_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 END IF;
 SELECT coalesce(max(version),0) INTO current_version FROM hon.automation_rule_versions WHERE rule_id=rule;
 IF current_version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 INSERT INTO hon.automation_rule_versions(rule_id,organization_id,school_id,version,payload,actor_principal_id,source,request_id) VALUES(rule,org,school,current_version+1,p,actor,'HUMAN_UI',request);
 result:=hon.automation_rule_summary(rule,current_version+1);
 PERFORM hon.require_automation_actor(subject,'automation.rule.manage');
 evidence:=jsonb_build_object('ruleId',rule,'version',current_version+1,'enabled',p->'enabled','configurationOnly',true,'executionAllowed',false,'internalOnly',true);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI','automation.rule.manage','AUTOMATION_RULE',rule,CASE WHEN current_version=0 THEN NULL ELSE jsonb_build_object('version',current_version) END,evidence,'SUCCEEDED',request,correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'automation.rule.configuration_revised',1,'AUTOMATION_RULE',rule,current_version+1,correlation,request,evidence);
 INSERT INTO hon.automation_rule_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,key,fp,result);
 RETURN jsonb_build_object('rule',result,'replayed',false);
END $$;
CREATE FUNCTION hon.read_automation_rules(subject text,p_id uuid,v integer) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; result jsonb; school uuid:=hon.current_school_id();
BEGIN
 IF v IS NOT NULL AND (p_id IS NULL OR v NOT BETWEEN 1 AND 999999999) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 actor:=hon.lock_automation_actor(subject,'automation.rule.read');
 IF p_id IS NOT NULL THEN
  result:=hon.automation_rule_summary(p_id,v);
  IF result IS NULL THEN RAISE EXCEPTION 'AUTOMATION_RULE_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 ELSE
  SELECT jsonb_build_object('schoolId',school,'configurationOnly',true,'canManage',hon.automation_has_permission(actor,hon.current_organization_id(),school,'automation.rule.manage'),'canDryRun',hon.automation_has_permission(actor,hon.current_organization_id(),school,'automation.rule.dry_run'),'rules',coalesce(jsonb_agg(hon.automation_rule_summary(r.id,NULL) ORDER BY r.created_at,r.id),'[]'::jsonb)) INTO result
  FROM hon.automation_rules r WHERE r.organization_id=hon.current_organization_id() AND r.school_id=school;
 END IF;
 PERFORM hon.require_automation_actor(subject,'automation.rule.read'); RETURN result;
END $$;
CREATE FUNCTION hon.plan_automation_descriptor(p jsonb,input jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,hon AS $$
DECLARE reason text:='MATCH'; plan jsonb:=NULL;
BEGIN
 PERFORM hon.validate_automation_input(p,false); PERFORM hon.validate_automation_input(input,true);
 IF NOT (p->>'enabled')::boolean THEN reason:='DISABLED';
 ELSIF p->>'triggerKind'<>input->'event'->>'triggerKind' THEN reason:='TRIGGER_MISMATCH';
 ELSIF (p->'conditions'->>'source'<>'ANY' AND p->'conditions'->>'source'<>input->'event'->>'source') OR (input->'event'->>'aggregateVersion')::integer<(p->'conditions'->>'minimumAggregateVersion')::integer THEN reason:='CONDITION_MISMATCH';
 ELSIF input->'simulation'->>'localDate'<p->'schedule'->>'effectiveFrom' OR (p->'schedule'->'endsOn'<>'null'::jsonb AND input->'simulation'->>'localDate'>=p->'schedule'->>'endsOn') THEN reason:='OUTSIDE_SCHEDULE';
 ELSIF input->'simulation'->'minutesSincePriorPlan'<>'null'::jsonb AND (input->'simulation'->>'minutesSincePriorPlan')::integer<(p->'schedule'->>'cooldownMinutes')::integer THEN reason:='COOLDOWN'; END IF;
 IF reason='MATCH' THEN plan:=jsonb_build_object('kind','MANUAL_REVIEW_TEMPLATE_DESCRIPTION','category',p->'proposal'->>'category','priority',p->'proposal'->>'priority','authority','NONE','approval','HUMAN_REVIEW_REQUIRED','requiredPermissions',jsonb_build_array('work_item.create'),'policyRequirements',jsonb_build_array('CURRENT_SCHOOL_PERMISSION','SEPARATE_HUMAN_COMMAND','CURRENT_DOMAIN_POLICY'),'scheduleMetadataOnly',true); END IF;
 RETURN jsonb_build_object('configurationOnly',true,'executionAllowed',false,'status',CASE WHEN reason='MATCH' THEN 'PLANNED' ELSE 'NOT_PLANNED' END,'reason',reason,'plan',plan);
END $$;
-- No writes, event consumption, domain services or execution calls in this boundary.
CREATE FUNCTION hon.dry_run_automation_rule(subject text,p_id uuid,input jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; saved jsonb; descriptor jsonb; result jsonb;
BEGIN
 PERFORM hon.validate_automation_input(input,true);
 actor:=hon.lock_automation_actor(subject,'automation.rule.dry_run');
 saved:=hon.automation_rule_summary(p_id,NULL);
 IF saved IS NULL THEN RAISE EXCEPTION 'AUTOMATION_RULE_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF (saved->>'version')::integer<>(input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
 descriptor:=saved-ARRAY['ruleId','schoolId','version','recordedAt','configurationOnly'];
 result:=hon.plan_automation_descriptor(descriptor,input)||jsonb_build_object('ruleId',p_id,'version',saved->'version');
 PERFORM hon.require_automation_actor(subject,'automation.rule.dry_run'); RETURN result;
END $$;
REVOKE ALL ON TABLE hon.automation_rules,hon.automation_rule_versions,hon.automation_rule_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_automation_history(),hon.automation_closed(jsonb,text[]),hon.validate_automation_input(jsonb,boolean),hon.automation_has_permission(uuid,uuid,uuid,text),hon.require_automation_actor(text,text),hon.lock_automation_actor(text,text),hon.automation_rule_summary(uuid,integer),hon.guard_automation_insert(),hon.plan_automation_descriptor(jsonb,jsonb),hon.resolve_automation_rule_scope(text,text),hon.save_automation_rule(text,uuid,jsonb,text,uuid,uuid),hon.read_automation_rules(text,uuid,integer),hon.dry_run_automation_rule(text,uuid,jsonb) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.automation_rules,hon.automation_rule_versions,hon.automation_rule_requests FROM %I',r);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_automation_history(),hon.automation_closed(jsonb,text[]),hon.validate_automation_input(jsonb,boolean),hon.automation_has_permission(uuid,uuid,uuid,text),hon.require_automation_actor(text,text),hon.lock_automation_actor(text,text),hon.automation_rule_summary(uuid,integer),hon.guard_automation_insert(),hon.plan_automation_descriptor(jsonb,jsonb),hon.resolve_automation_rule_scope(text,text),hon.save_automation_rule(text,uuid,jsonb,text,uuid,uuid),hon.read_automation_rules(text,uuid,integer),hon.dry_run_automation_rule(text,uuid,jsonb) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.resolve_automation_rule_scope(text,text),hon.save_automation_rule(text,uuid,jsonb,text,uuid,uuid),hon.read_automation_rules(text,uuid,integer),hon.dry_run_automation_rule(text,uuid,jsonb) TO hon_runtime; END IF;
END $$;
COMMIT;
