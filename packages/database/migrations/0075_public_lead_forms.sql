BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Forms require trusted migration ownership'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('marketing.form.read','Human school public-form configuration and aggregate counts',true,true),
 ('marketing.form.configure','Human school public-form draft configuration',true,true),
 ('marketing.form.publish','Human school public-form publication',true,true),
 ('marketing.form.disable','Human school public-form disablement',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code LIKE 'marketing.form.%' ON CONFLICT DO NOTHING;
-- No IAM grants, human user, delegation or generic API authority belong to this identity.
INSERT INTO hon.principals(id,principal_type,display_name)
 VALUES('00000000-0000-4000-8000-000000000075','SYSTEM_SERVICE','Code-owned public lead-form intake');
CREATE TABLE hon.public_lead_forms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 public_id text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24),'hex') CHECK(public_id ~ '^[a-f0-9]{48}$'),
 hash_secret text NOT NULL DEFAULT encode(gen_random_bytes(32),'hex'),
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 999999999),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','PUBLISHED','DISABLED')),
 title text NOT NULL, description text NOT NULL, optional_fields jsonb NOT NULL,
 pipeline_id uuid NOT NULL, pipeline_stage_id uuid NOT NULL, campaign_id uuid,
 accepted_count bigint NOT NULL DEFAULT 0 CHECK(accepted_count>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id,school_id),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
 FOREIGN KEY(pipeline_id,organization_id,school_id) REFERENCES hon.crm_pipelines(id,organization_id,school_id),
 FOREIGN KEY(pipeline_stage_id,organization_id,school_id) REFERENCES hon.crm_pipeline_stages(id,organization_id,school_id),
 FOREIGN KEY(campaign_id,organization_id,school_id) REFERENCES hon.marketing_campaigns(id,organization_id,school_id)
);
CREATE TABLE hon.public_lead_form_versions (
 form_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL, version integer NOT NULL,
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), request_id uuid NOT NULL,
 snapshot jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(form_id,version), FOREIGN KEY(form_id,organization_id,school_id) REFERENCES hon.public_lead_forms(id,organization_id,school_id)
);
CREATE TABLE hon.public_lead_form_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
 idempotency_key text NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
-- Bounded 24h duplicate/retry evidence, not a private raw-body inbox. Lead PII remains CRM-owned.
CREATE TABLE hon.public_lead_form_receipts (
 form_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL, lead_id uuid NOT NULL,
 key_hash text NOT NULL, payload_hash text NOT NULL, transaction_id bigint NOT NULL,
 attribution jsonb NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(form_id,key_hash),
 FOREIGN KEY(form_id,organization_id,school_id) REFERENCES hon.public_lead_forms(id,organization_id,school_id),
 FOREIGN KEY(lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hon.public_lead_form_rates (
 form_id uuid NOT NULL REFERENCES hon.public_lead_forms(id), bucket text NOT NULL, window_start timestamptz NOT NULL,
 attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 501), PRIMARY KEY(form_id,bucket)
);
CREATE INDEX public_form_receipts_payload_idx ON hon.public_lead_form_receipts(form_id,payload_hash);
CREATE INDEX public_form_receipts_expiry_idx ON hon.public_lead_form_receipts(form_id,expires_at);
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT unnest(ARRAY['public_lead_forms','public_lead_form_versions','public_lead_form_requests','public_lead_form_receipts','public_lead_form_rates']) LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM PUBLIC',t);
 END LOOP;
END $$;
CREATE TRIGGER public_form_versions_immutable BEFORE UPDATE OR DELETE ON hon.public_lead_form_versions FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER public_form_versions_no_truncate BEFORE TRUNCATE ON hon.public_lead_form_versions FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER public_form_requests_immutable BEFORE UPDATE OR DELETE ON hon.public_lead_form_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER public_form_requests_no_truncate BEFORE TRUNCATE ON hon.public_lead_form_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history();
CREATE TRIGGER public_form_receipts_no_update BEFORE UPDATE ON hon.public_lead_form_receipts FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history();

CREATE FUNCTION hon.validate_public_form_config(p jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE k text; field jsonb;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>4096
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) AS keys(key) WHERE key NOT IN('expectedVersion','title','description','optionalFields','pipelineId','pipelineStageId','campaignId'))
 OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^(0|[1-9][0-9]{0,8})$' OR (p->>'expectedVersion')::integer>999999998 THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['title','description']) LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(p->>k)>(CASE k WHEN 'title' THEN 120 ELSE 500 END)
  OR (k='title' AND length(p->>k)=0) OR regexp_replace(p->>k,'^[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+|[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+$','','g')<>p->>k OR (p->>k) ~ '[[:cntrl:]\u0080-\u009F\u2028-\u2029\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' OR (p->>k) ~ '^[=+@-]' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR k IN SELECT unnest(ARRAY['pipelineId','pipelineStageId']) LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR (p->>k) !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF NOT(p ? 'campaignId') OR (p->'campaignId'<>'null'::jsonb AND (jsonb_typeof(p->'campaignId') IS DISTINCT FROM 'string' OR (p->>'campaignId') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p->'optionalFields') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'optionalFields')>3 THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 FOR field IN SELECT value FROM jsonb_array_elements(p->'optionalFields') LOOP
  IF jsonb_typeof(field) IS DISTINCT FROM 'string' OR field#>>'{}' NOT IN('ageBand','experience','preferredTime') THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(p->'optionalFields'))<>jsonb_array_length(p->'optionalFields') THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION hon.require_public_form_actor(p_subject text,p_permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid;
BEGIN
 IF p_permission IS NULL OR p_permission NOT IN('marketing.form.read','marketing.form.configure','marketing.form.publish','marketing.form.disable')
 OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'FORM_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER' AND p.is_active
 AND (SELECT count(*) FROM hon.principals x JOIN hon.users xu ON xu.id=x.user_id WHERE xu.external_subject=p_subject AND x.principal_type='HUMAN_USER' AND x.is_active)=1;
 IF actor IS NULL OR NOT hon.principal_has_school_permission(actor,hon.current_organization_id(),hon.current_school_id(),p_permission)
 OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=hon.current_organization_id() AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'FORM_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION hon.lock_public_form_actor(p_subject text,p_permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'FORM_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'FORM_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_public_form_actor(p_subject,p_permission);
 PERFORM 1 FROM hon.users WHERE id IN(SELECT user_id FROM hon.principals WHERE id=actor) FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=actor FOR UPDATE;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.role_permissions WHERE role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
 RETURN hon.require_public_form_actor(p_subject,p_permission);
END $$;
CREATE FUNCTION hon.resolve_public_form_scope(p_subject text,p_permission text) RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS (
 SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
 JOIN hon.principal_role_grants g ON g.principal_id=p.id JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
 JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
 JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id JOIN hon.organizations o ON o.id=s.organization_id
 WHERE u.external_subject=p_subject AND p.principal_type='HUMAN_USER' AND p.is_active
 AND (SELECT count(*) FROM hon.principals x JOIN hon.users xu ON xu.id=x.user_id WHERE xu.external_subject=p_subject AND x.principal_type='HUMAN_USER' AND x.is_active)=1
 AND p_permission IN('marketing.form.read','marketing.form.configure','marketing.form.publish','marketing.form.disable') AND rp.permission_code=p_permission
 AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 AND o.status='ACTIVE' AND s.status='ACTIVE' AND (r.management_school_id IS NULL OR r.management_school_id=s.id)
 ) SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1
$$;
CREATE FUNCTION hon.public_form_staff_summary(p_id uuid) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',id,'publicId',public_id,'version',version,'status',status,'title',title,'description',description,'optionalFields',optional_fields,'pipelineId',pipeline_id,'pipelineStageId',pipeline_stage_id,'campaignId',campaign_id,'acceptedCount',accepted_count,'updatedAt',updated_at)
 FROM hon.public_lead_forms WHERE id=p_id AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
$$;
CREATE FUNCTION hon.read_public_forms(p_subject text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE result jsonb;
BEGIN
 PERFORM hon.lock_public_form_actor(p_subject,'marketing.form.read');
 SELECT coalesce(jsonb_agg(hon.public_form_staff_summary(id) ORDER BY updated_at DESC,id),'[]') INTO result FROM hon.public_lead_forms WHERE organization_id=hon.current_organization_id() AND school_id=hon.current_school_id();
 PERFORM hon.require_public_form_actor(p_subject,'marketing.form.read'); RETURN result;
END $$;
CREATE FUNCTION hon.mutate_public_form(p_subject text,p_operation text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); f hon.public_lead_forms%ROWTYPE; previous hon.public_lead_form_requests%ROWTYPE; fp text; result jsonb; expected integer; permission text;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('configure','publish','disable') OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{16,100}$' OR p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 IF p_operation='configure' THEN PERFORM hon.validate_public_form_config(p_input);
 ELSE
  IF p_id IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_input- 'expectedVersion'<>'{}' OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' OR (p_input->>'expectedVersion')::integer>999999998 THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 END IF;
 expected:=(p_input->>'expectedVersion')::integer; permission:='marketing.form.'||p_operation;
 actor:=hon.lock_public_form_actor(p_subject,permission);
 fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'id',p_id,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.public_lead_form_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'FORM_CONFLICT' USING ERRCODE='23505'; END IF; RETURN jsonb_build_object('form',previous.response,'replayed',true); END IF;
 IF p_id IS NOT NULL THEN
  SELECT * INTO f FROM hon.public_lead_forms WHERE id=p_id AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FORM_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF f.version<>expected THEN RAISE EXCEPTION 'FORM_CONFLICT' USING ERRCODE='40001'; END IF;
 ELSIF p_operation<>'configure' OR expected<>0 OR (SELECT count(*) FROM hon.public_lead_forms WHERE organization_id=org AND school_id=school)>=100 THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 IF p_operation='configure' THEN
  IF f.status='PUBLISHED' THEN RAISE EXCEPTION 'DISABLE_BEFORE_CONFIGURE' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM hon.crm_pipeline_stages WHERE id=(p_input->>'pipelineStageId')::uuid AND pipeline_id=(p_input->>'pipelineId')::uuid AND organization_id=org AND school_id=school AND terminal_status IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
  IF p_input->>'campaignId' IS NOT NULL THEN
   IF NOT hon.principal_has_school_permission(actor,org,school,'marketing.campaign.attribute') THEN RAISE EXCEPTION 'FORM_FORBIDDEN' USING ERRCODE='42501'; END IF;
   PERFORM 1 FROM hon.marketing_campaigns WHERE id=(p_input->>'campaignId')::uuid AND organization_id=org AND school_id=school AND status='ACTIVE' FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_id IS NULL THEN
   INSERT INTO hon.public_lead_forms(organization_id,school_id,title,description,optional_fields,pipeline_id,pipeline_stage_id,campaign_id)
   VALUES(org,school,p_input->>'title',p_input->>'description',p_input->'optionalFields',(p_input->>'pipelineId')::uuid,(p_input->>'pipelineStageId')::uuid,(p_input->>'campaignId')::uuid) RETURNING * INTO f;
  ELSE
   UPDATE hon.public_lead_forms SET title=p_input->>'title',description=p_input->>'description',optional_fields=p_input->'optionalFields',pipeline_id=(p_input->>'pipelineId')::uuid,pipeline_stage_id=(p_input->>'pipelineStageId')::uuid,campaign_id=(p_input->>'campaignId')::uuid,version=version+1,updated_at=clock_timestamp() WHERE id=f.id RETURNING * INTO f;
  END IF;
 ELSE
  IF (p_operation='publish' AND f.status NOT IN('DRAFT','DISABLED')) OR (p_operation='disable' AND f.status<>'PUBLISHED') THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
  IF p_operation='publish' THEN
   PERFORM 1 FROM hon.crm_pipeline_stages WHERE id=f.pipeline_stage_id AND pipeline_id=f.pipeline_id AND organization_id=org AND school_id=school AND terminal_status IS NULL FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   IF f.campaign_id IS NOT NULL THEN
    IF NOT hon.principal_has_school_permission(actor,org,school,'marketing.campaign.attribute') THEN RAISE EXCEPTION 'FORM_FORBIDDEN' USING ERRCODE='42501'; END IF;
    PERFORM 1 FROM hon.marketing_campaigns WHERE id=f.campaign_id AND organization_id=org AND school_id=school AND status='ACTIVE' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   END IF;
  END IF;
  UPDATE hon.public_lead_forms SET status=CASE p_operation WHEN 'publish' THEN 'PUBLISHED' ELSE 'DISABLED' END,version=version+1,updated_at=clock_timestamp() WHERE id=f.id RETURNING * INTO f;
 END IF;
 result:=hon.public_form_staff_summary(f.id); PERFORM hon.require_public_form_actor(p_subject,permission);
 INSERT INTO hon.public_lead_form_versions(form_id,organization_id,school_id,version,actor_principal_id,request_id,snapshot) VALUES(f.id,org,school,f.version,actor,p_request,result-'acceptedCount');
 INSERT INTO hon.public_lead_form_requests VALUES(org,school,actor,p_key,fp,result);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI',permission,'PUBLIC_LEAD_FORM',f.id,jsonb_build_object('version',f.version,'status',f.status),'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,'marketing.form.human_changed',1,'PUBLIC_LEAD_FORM',f.id,f.version,p_correlation,p_request,jsonb_build_object('id',f.id,'version',f.version,'internalOnly',true));
 RETURN jsonb_build_object('form',result,'replayed',false);
END $$;

-- Public GET is a pure whitelisted projection; no campaign identifiers, private settings, receipts or statistics.
CREATE FUNCTION hon.read_published_form(p_public_id text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('publicId',f.public_id,'title',f.title,'description',f.description,'optionalFields',f.optional_fields)
 FROM hon.public_lead_forms f JOIN hon.organizations o ON o.id=f.organization_id JOIN hon.schools s ON s.id=f.school_id AND s.organization_id=f.organization_id
 WHERE p_public_id ~ '^[a-f0-9]{48}$' AND f.public_id=p_public_id AND f.status='PUBLISHED' AND o.status='ACTIVE' AND s.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=f.organization_id AND e.tier IN('ESSENTIAL','CORE','COMPLETE') AND e.status='ACTIVE' AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
 AND EXISTS(SELECT 1 FROM hon.crm_pipeline_stages st WHERE st.id=f.pipeline_stage_id AND st.pipeline_id=f.pipeline_id AND st.terminal_status IS NULL)
 AND (f.campaign_id IS NULL OR EXISTS(SELECT 1 FROM hon.marketing_campaigns c WHERE c.id=f.campaign_id AND c.organization_id=f.organization_id AND c.school_id=f.school_id AND c.status='ACTIVE'))
$$;
CREATE FUNCTION hon.validate_public_form_submission(p jsonb,p_fields jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
DECLARE k text; v text; cap integer; result jsonb:='{}';
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>8192 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) AS keys(key) WHERE key NOT IN('name','email','mobile','interest','source','website','acknowledged','ageBand','experience','preferredTime')) THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p->'website') IS DISTINCT FROM 'string' OR p->>'website'<>'' OR jsonb_typeof(p->'acknowledged') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['name','email','mobile','interest','source','ageBand','experience','preferredTime']) LOOP
  IF p ? k THEN
   cap:=CASE k WHEN 'name' THEN 120 WHEN 'email' THEN 254 WHEN 'mobile' THEN 16 WHEN 'interest' THEN 80 WHEN 'source' THEN 80 ELSE 30 END;
   IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(p->>k)>cap OR (p->>k) ~ '[[:cntrl:]\u0080-\u009F\u2028-\u2029\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   v:=regexp_replace(p->>k,'^[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+|[[:space:]\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+$','','g');
   IF k<>'mobile' AND v ~ '^[=+@-]' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   IF k='mobile' AND v<>'' AND v !~ '^\+[1-9][0-9]{6,14}$' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   IF k='email' THEN v:=lower(v); IF v<>'' AND v !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$' THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF; END IF;
   IF k IN('ageBand','experience','preferredTime') THEN
    IF NOT(p_fields ? k) OR (k='ageBand' AND v NOT IN('CHILD','TEEN','ADULT')) OR (k='experience' AND v NOT IN('NEW','SOME','EXPERIENCED')) OR (k='preferredTime' AND v NOT IN('MORNING','AFTERNOON','EVENING','WEEKEND')) THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   END IF;
   result:=result||jsonb_build_object(k,v);
  END IF;
 END LOOP;
 IF coalesce(result->>'name','')='' OR (coalesce(result->>'email','')='' AND coalesce(result->>'mobile','')='') THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('name',result->>'name','email',coalesce(result->>'email',''),'mobile',coalesce(result->>'mobile',''),'interest',coalesce(result->>'interest',''),'source',coalesce(result->>'source',''),'acknowledged',p->'acknowledged')||(result-ARRAY['name','email','mobile','interest','source']);
END $$;
CREATE FUNCTION hon.take_public_form_rate(p_form uuid,p_bucket text,p_limit integer) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n integer; asof timestamptz:=clock_timestamp();
BEGIN
 INSERT INTO hon.public_lead_form_rates(form_id,bucket,window_start,attempts) VALUES(p_form,p_bucket,asof,1)
 ON CONFLICT(form_id,bucket) DO UPDATE SET window_start=CASE WHEN hon.public_lead_form_rates.window_start<=asof-interval '1 hour' THEN asof ELSE hon.public_lead_form_rates.window_start END,
 attempts=CASE WHEN hon.public_lead_form_rates.window_start<=asof-interval '1 hour' THEN 1 ELSE least(hon.public_lead_form_rates.attempts+1,501) END RETURNING attempts INTO n;
 RETURN n<=p_limit;
END $$;
-- Private CRM domain command. Only a fresh private receipt in this transaction can authorize it.
CREATE FUNCTION hon.create_public_form_lead(p_form uuid,p_lead uuid,p_input jsonb,p_request uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE f hon.public_lead_forms%ROWTYPE; r hon.public_lead_form_receipts%ROWTYPE; person uuid;
BEGIN
 SELECT * INTO f FROM hon.public_lead_forms WHERE id=p_form;
 SELECT * INTO r FROM hon.public_lead_form_receipts WHERE form_id=f.id AND lead_id=p_lead AND transaction_id=txid_current();
 IF r.lead_id IS NULL OR f.status<>'PUBLISHED' OR current_setting('app.hon_principal_id',true) IS DISTINCT FROM '00000000-0000-4000-8000-000000000075' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'PUBLIC_API' THEN RAISE EXCEPTION 'FORM_FORBIDDEN' USING ERRCODE='42501'; END IF;
 INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164) VALUES(f.organization_id,f.school_id,p_input->>'name','',nullif(p_input->>'email','')::public.citext,nullif(p_input->>'mobile','')) RETURNING id INTO person;
 INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,source_code,program_interest_code,attribution)
 VALUES(p_lead,f.organization_id,f.school_id,person,f.pipeline_id,f.pipeline_stage_id,'PUBLIC_API',nullif(p_input->>'interest',''),r.attribution);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
 VALUES(f.organization_id,f.school_id,'00000000-0000-4000-8000-000000000075','PUBLIC_API','crm.lead.create','CRM_LEAD',p_lead,jsonb_build_object('formId',f.id,'formVersion',f.version,'source','PUBLIC_API','version',1),'SUCCEEDED',p_request,p_request);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(f.organization_id,f.school_id,'marketing.form.lead_received',1,'CRM_LEAD',p_lead,1,p_request,p_request,jsonb_build_object('leadId',p_lead,'formId',f.id,'formVersion',f.version,'internalOnly',true));
END $$;
CREATE FUNCTION hon.submit_public_form(p_public_id text,p_input jsonb,p_key text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE f hon.public_lead_forms%ROWTYPE; normalized jsonb; kh text; ph text; contact text; previous hon.public_lead_form_receipts%ROWTYPE; lead uuid:=gen_random_uuid(); request uuid:=gen_random_uuid(); facts jsonb;
BEGIN
 IF p_public_id IS NULL OR p_public_id !~ '^[a-f0-9]{48}$' OR p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{16,100}$' THEN RETURN 'INVALID'; END IF;
 SELECT * INTO f FROM hon.public_lead_forms WHERE public_id=p_public_id;
 IF NOT FOUND THEN RETURN 'INVALID'; END IF;
 -- Same lock order as human lifecycle and campaign mutation: org -> school -> form.
 PERFORM 1 FROM hon.organizations WHERE id=f.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN 'INVALID'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=f.school_id AND organization_id=f.organization_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN 'INVALID'; END IF;
 SELECT * INTO f FROM hon.public_lead_forms WHERE id=f.id FOR UPDATE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=f.organization_id AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp()) FOR SHARE;
 IF NOT FOUND OR f.status<>'PUBLISHED' THEN RETURN 'INVALID'; END IF;
 IF f.campaign_id IS NOT NULL THEN
  PERFORM 1 FROM hon.marketing_campaigns WHERE id=f.campaign_id AND organization_id=f.organization_id AND school_id=f.school_id AND status='ACTIVE' FOR SHARE; IF NOT FOUND THEN RETURN 'INVALID'; END IF;
 END IF;
 PERFORM 1 FROM hon.crm_pipeline_stages WHERE id=f.pipeline_stage_id AND pipeline_id=f.pipeline_id AND organization_id=f.organization_id AND school_id=f.school_id AND terminal_status IS NULL FOR SHARE; IF NOT FOUND THEN RETURN 'INVALID'; END IF;
  PERFORM 1 FROM hon.principals WHERE id='00000000-0000-4000-8000-000000000075' AND principal_type='SYSTEM_SERVICE' AND user_id IS NULL AND is_active FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE principal_id='00000000-0000-4000-8000-000000000075')
   OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id='00000000-0000-4000-8000-000000000075')
   OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id='00000000-0000-4000-8000-000000000075') THEN RETURN 'INVALID'; END IF;
  DELETE FROM hon.public_lead_form_receipts WHERE form_id=f.id AND expires_at<=clock_timestamp();
  DELETE FROM hon.public_lead_form_rates WHERE form_id=f.id AND window_start<=clock_timestamp()-interval '1 hour';
  IF NOT hon.take_public_form_rate(f.id,'FORM_ATTEMPTS',500) THEN RETURN 'RATE_LIMITED'; END IF;
 BEGIN normalized:=hon.validate_public_form_submission(p_input,f.optional_fields); EXCEPTION WHEN SQLSTATE '22023' THEN RETURN 'INVALID'; END;
 kh:=encode(sha256(convert_to(f.hash_secret||':key:'||p_key,'UTF8')),'hex'); ph:=encode(sha256(convert_to(f.hash_secret||':payload:'||normalized::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.public_lead_form_receipts WHERE form_id=f.id AND key_hash=kh;
 IF FOUND THEN IF previous.payload_hash=ph THEN RETURN 'ACCEPTED'; ELSE RETURN 'INVALID'; END IF; END IF;
 SELECT * INTO previous FROM hon.public_lead_form_receipts WHERE form_id=f.id AND payload_hash=ph ORDER BY expires_at LIMIT 1;
 IF FOUND THEN
  INSERT INTO hon.public_lead_form_receipts VALUES(f.id,f.organization_id,f.school_id,previous.lead_id,kh,ph,txid_current(),previous.attribution,previous.expires_at);
  RETURN 'ACCEPTED';
 END IF;
 IF NOT hon.take_public_form_rate(f.id,'FORM_ACCEPTS',200) THEN RETURN 'RATE_LIMITED'; END IF;
 FOREACH contact IN ARRAY ARRAY[nullif(normalized->>'email',''),nullif(normalized->>'mobile','')] LOOP
  IF contact IS NOT NULL AND NOT hon.take_public_form_rate(f.id,encode(sha256(convert_to(f.hash_secret||':contact:'||contact,'UTF8')),'hex'),5) THEN RETURN 'RATE_LIMITED'; END IF;
 END LOOP;
 PERFORM set_config('app.hon_organization_id',f.organization_id::text,true),set_config('app.hon_school_id',f.school_id::text,true),set_config('app.hon_principal_id','00000000-0000-4000-8000-000000000075',true),set_config('app.hon_principal_type','SYSTEM_SERVICE',true),set_config('app.hon_source','PUBLIC_API',true),set_config('app.hon_request_id',request::text,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true);
 facts:=jsonb_build_object('publicForm',jsonb_build_object('id',f.id,'version',f.version,'snapshot',jsonb_build_object('title',f.title,'description',f.description,'optionalFields',f.optional_fields)),'source','PUBLIC_API','sourceDetail',normalized->>'source','acknowledged',normalized->'acknowledged','optionalAnswers',normalized-ARRAY['name','email','mobile','interest','source','acknowledged']);
 IF f.campaign_id IS NOT NULL THEN facts:=facts||jsonb_build_object('campaignId',f.campaign_id); END IF;
 INSERT INTO hon.public_lead_form_receipts VALUES(f.id,f.organization_id,f.school_id,lead,kh,ph,txid_current(),facts,clock_timestamp()+interval '24 hours');
 PERFORM hon.create_public_form_lead(f.id,lead,normalized,request);
 UPDATE hon.public_lead_forms SET accepted_count=accepted_count+1 WHERE id=f.id;
 RETURN 'ACCEPTED';
END $$;

-- ACL reconciliation is explicit: no PUBLIC or Supabase client execution, even for intake.
DO $$ DECLARE r text; f record; t text; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname IN('validate_public_form_config','require_public_form_actor','lock_public_form_actor','resolve_public_form_scope','public_form_staff_summary','read_public_forms','mutate_public_form','read_published_form','validate_public_form_submission','take_public_form_rate','create_public_form_lead','submit_public_form') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,r); END LOOP;
 END LOOP;
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOR t IN SELECT unnest(ARRAY['public_lead_forms','public_lead_form_versions','public_lead_form_requests','public_lead_form_receipts','public_lead_form_rates']) LOOP EXECUTE format('REVOKE ALL ON TABLE hon.%I FROM %I',t,r); END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.resolve_public_form_scope(text,text),hon.read_public_forms(text),hon.mutate_public_form(text,text,uuid,jsonb,text,uuid,uuid),hon.read_published_form(text),hon.submit_public_form(text,jsonb,text) TO hon_runtime;
 END IF;
END $$;
COMMIT;
