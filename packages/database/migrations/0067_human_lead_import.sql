BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Migration Center requires a trusted BYPASSRLS migration owner'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable) VALUES
 ('migration.lead_import.upload','Human staging of bounded CSV leads',true,true),
 ('migration.lead_import.read','Human redacted batch metadata and scoped import options',true,true),
 ('migration.lead_import.review','Human private row review and explicit decisions',true,true),
 ('migration.lead_import.finalize','Human atomic creation of explicitly selected new leads',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT r.id,r.organization_id,p.code FROM hon.roles r CROSS JOIN hon.permissions p
 WHERE r.is_system_role AND r.code='OWNER' AND p.code IN('migration.lead_import.upload','migration.lead_import.read','migration.lead_import.review','migration.lead_import.finalize') ON CONFLICT DO NOTHING;

CREATE TABLE hon.lead_import_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 pipeline_stage_id uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 999999999),
 status text NOT NULL DEFAULT 'STAGED' CHECK(status IN('STAGED','REVIEW','FINALIZED')),
 source_checksum text NOT NULL CHECK(source_checksum ~ '^[a-f0-9]{64}$'),
 headers jsonb NOT NULL CHECK(jsonb_typeof(headers)='array'), mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
 row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 1000), valid_count integer NOT NULL CHECK(valid_count BETWEEN 0 AND row_count),
 created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 review_actor uuid REFERENCES hon.principals(id), review_token uuid, review_expires_at timestamptz, finalized_at timestamptz,
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id),
 FOREIGN KEY(pipeline_stage_id,organization_id,school_id) REFERENCES hon.crm_pipeline_stages(id,organization_id,school_id),
 UNIQUE(id,organization_id,school_id)
);
CREATE TABLE hon.lead_import_rows (
 batch_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL, row_index integer NOT NULL CHECK(row_index BETWEEN 1 AND 1000),
 source_row jsonb NOT NULL CHECK(jsonb_typeof(source_row)='array'), normalized jsonb NOT NULL CHECK(jsonb_typeof(normalized)='object'),
 validation_errors jsonb NOT NULL CHECK(jsonb_typeof(validation_errors)='array'), duplicate_suggestions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(duplicate_suggestions)='array'),
 choice text CHECK(choice IN('IMPORT','SKIP')), lead_id uuid UNIQUE REFERENCES hon.crm_leads(id),
 PRIMARY KEY(batch_id,row_index), FOREIGN KEY(batch_id,organization_id,school_id) REFERENCES hon.lead_import_batches(id,organization_id,school_id),
 CHECK(lead_id IS NULL OR choice='IMPORT' AND validation_errors='[]')
);
CREATE TABLE hon.lead_import_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, organization_id uuid NOT NULL, school_id uuid NOT NULL,
 batch_version integer NOT NULL, row_index integer NOT NULL, kind text NOT NULL CHECK(kind IN('IMPORT','SKIP','APPLIED')),
 actor_principal_id uuid NOT NULL REFERENCES hon.principals(id), lead_id uuid REFERENCES hon.crm_leads(id),
 request_id uuid NOT NULL, correlation_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(batch_id,organization_id,school_id) REFERENCES hon.lead_import_batches(id,organization_id,school_id),
 FOREIGN KEY(batch_id,row_index) REFERENCES hon.lead_import_rows(batch_id,row_index),
 UNIQUE(batch_id,batch_version,row_index), CHECK((kind='APPLIED')=(lead_id IS NOT NULL))
);
CREATE TABLE hon.lead_import_requests (
 organization_id uuid NOT NULL, school_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES hon.principals(id),
 idempotency_key text NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(organization_id,school_id,principal_id,idempotency_key),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id)
);
CREATE INDEX lead_import_scope_idx ON hon.lead_import_batches(organization_id,school_id,created_at DESC,id);
ALTER TABLE hon.lead_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.lead_import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.lead_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.lead_import_rows FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.lead_import_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.lead_import_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.lead_import_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.lead_import_requests FORCE ROW LEVEL SECURITY;

CREATE FUNCTION hon.guard_lead_import_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_TABLE_NAME IN('lead_import_evidence','lead_import_requests') OR TG_OP='DELETE' THEN
  RAISE EXCEPTION 'IMMUTABLE_IMPORT_EVIDENCE' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='lead_import_rows' THEN
  IF NEW.batch_id<>OLD.batch_id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.row_index<>OLD.row_index
    OR NEW.source_row<>OLD.source_row OR NEW.normalized<>OLD.normalized OR NEW.validation_errors<>OLD.validation_errors OR OLD.lead_id IS NOT NULL THEN
   RAISE EXCEPTION 'IMMUTABLE_IMPORT_ROW' USING ERRCODE='42501'; END IF;
 ELSE
  IF OLD.status='FINALIZED' OR NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id
   OR NEW.pipeline_stage_id<>OLD.pipeline_stage_id OR NEW.source_checksum<>OLD.source_checksum OR NEW.headers<>OLD.headers OR NEW.mapping<>OLD.mapping
   OR NEW.row_count<>OLD.row_count OR NEW.valid_count<>OLD.valid_count OR NEW.created_by_principal_id<>OLD.created_by_principal_id
   OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'IMMUTABLE_IMPORT_BATCH' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lead_import_batch_guard BEFORE UPDATE OR DELETE ON hon.lead_import_batches FOR EACH ROW EXECUTE FUNCTION hon.guard_lead_import_evidence();
CREATE TRIGGER lead_import_row_guard BEFORE UPDATE OR DELETE ON hon.lead_import_rows FOR EACH ROW EXECUTE FUNCTION hon.guard_lead_import_evidence();
CREATE TRIGGER lead_import_evidence_guard BEFORE UPDATE OR DELETE ON hon.lead_import_evidence FOR EACH ROW EXECUTE FUNCTION hon.guard_lead_import_evidence();
CREATE TRIGGER lead_import_request_guard BEFORE UPDATE OR DELETE ON hon.lead_import_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_lead_import_evidence();

-- No client tenant selector: return a scope only when exactly one active school
-- authorizes this verified subject with the exact migration permission.
CREATE FUNCTION hon.resolve_lead_import_scope(p_subject text,p_permission text)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid) LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH candidates AS (
  SELECT DISTINCT p.id principal_id,g.organization_id,g.school_id
  FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  JOIN hon.principal_role_grants g ON g.principal_id=p.id
  JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
  JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
  JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id
  JOIN hon.organizations o ON o.id=s.organization_id
  WHERE u.external_subject=p_subject AND p.principal_type='HUMAN_USER' AND p.is_active
   AND (SELECT count(*) FROM hon.principals x JOIN hon.users xu ON xu.id=x.user_id WHERE xu.external_subject=p_subject AND x.principal_type='HUMAN_USER' AND x.is_active)=1
   AND p_permission IN('migration.lead_import.upload','migration.lead_import.read','migration.lead_import.review','migration.lead_import.finalize')
   AND rp.permission_code=p_permission AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp()
   AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()) AND o.status='ACTIVE' AND s.status='ACTIVE'
   AND (r.management_school_id IS NULL OR r.management_school_id=s.id)
 ) SELECT * FROM candidates WHERE (SELECT count(*) FROM candidates)=1
$$;
CREATE FUNCTION hon.require_lead_import_actor(p_subject text,p_permission text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE a uuid;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT s.principal_id INTO a FROM hon.resolve_lead_import_scope(p_subject,p_permission) s
 WHERE s.organization_id=hon.current_organization_id() AND s.school_id=hon.current_school_id() AND s.principal_id::text=current_setting('app.hon_principal_id',true);
 IF a IS NULL THEN RAISE EXCEPTION 'IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN a;
END $$;
CREATE FUNCTION hon.lead_import_summary(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object('id',b.id,'version',b.version,'status',b.status,'rowCount',b.row_count,'validCount',b.valid_count,
  'importedCount',(SELECT count(*) FROM hon.lead_import_rows r WHERE r.batch_id=b.id AND r.lead_id IS NOT NULL),
  'skippedCount',(SELECT count(*) FROM hon.lead_import_rows r WHERE r.batch_id=b.id AND r.choice='SKIP'),
  'checksum',b.source_checksum,'createdAt',b.created_at)
 FROM hon.lead_import_batches b WHERE b.id=p_id AND b.organization_id=hon.current_organization_id() AND b.school_id=hon.current_school_id()
$$;

-- SQL revalidates every raw mapped cell, not an API-supplied valid flag.
CREATE FUNCTION hon.validate_lead_import_row(p_headers jsonb,p_mapping jsonb,p_row jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE n jsonb:='{}'; errors jsonb:='[]'; field text; value text; i integer; maxlen integer;
BEGIN
 IF jsonb_typeof(p_row) IS DISTINCT FROM 'array' OR jsonb_array_length(p_row)<>jsonb_array_length(p_headers) THEN RAISE EXCEPTION 'INVALID_ROW_SHAPE' USING ERRCODE='22023'; END IF;
 FOR i IN 0..jsonb_array_length(p_headers)-1 LOOP
  IF jsonb_typeof(p_row->i) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_CELL' USING ERRCODE='22023'; END IF;
  field:=p_mapping->>(p_headers->>i); value:=btrim(p_row->>i);
  maxlen:=CASE WHEN field='note' THEN 2000 WHEN field='email' THEN 254 WHEN field='mobile' THEN 40 ELSE 200 END;
  IF length(value)>maxlen THEN errors:=errors||jsonb_build_array(field||':TOO_LONG'); END IF;
  IF (p_row->>i) ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]' THEN errors:=errors||jsonb_build_array(field||':CONTROL_CHARACTER'); END IF;
  -- A valid international phone is the only plus-prefixed numeric exception.
  IF value ~ '^[[:space:]]*[=+@-]' AND NOT(field='mobile' AND value ~ '^\+[1-9][0-9 ()-]{6,25}$') THEN errors:=errors||jsonb_build_array(field||':FORMULA_INJECTION'); END IF;
  IF field='email' THEN value:=lower(value); IF value<>'' AND value !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$' THEN errors:=errors||jsonb_build_array('email:INVALID'); END IF; END IF;
  IF field='mobile' AND value<>'' THEN
   value:=regexp_replace(value,'[ ()-]','','g');
   IF value !~ '^\+[1-9][0-9]{6,14}$' THEN errors:=errors||jsonb_build_array('mobile:USE_E164'); END IF;
  END IF;
  n:=n||jsonb_build_object(field,value);
 END LOOP;
 IF coalesce(n->>'givenName','')='' AND coalesce(n->>'displayName','')='' THEN errors:=errors||jsonb_build_array('name:REQUIRED'); END IF;
 IF n ? 'givenName' AND (coalesce(n->>'givenName','')='' OR coalesce(n->>'familyName','')='') THEN errors:=errors||jsonb_build_array('name:FIRST_AND_LAST_REQUIRED'); END IF;
 RETURN jsonb_build_object('normalized',n,'errors',errors);
END $$;

-- Private in-transaction CRM domain boundary: INSERT only, no merges or tools.
CREATE FUNCTION hon.apply_imported_lead(p_batch uuid,p_row integer,p_actor uuid,p_request uuid,p_correlation uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE b hon.lead_import_batches%ROWTYPE; r hon.lead_import_rows%ROWTYPE; pipeline uuid; person uuid; lead uuid; attribution jsonb; payload jsonb;
BEGIN
 SELECT * INTO b FROM hon.lead_import_batches WHERE id=p_batch AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id() AND status='REVIEW';
 SELECT * INTO r FROM hon.lead_import_rows WHERE batch_id=b.id AND row_index=p_row AND choice='IMPORT' AND validation_errors='[]' AND lead_id IS NULL FOR UPDATE;
 IF b.id IS NULL OR r.batch_id IS NULL THEN RAISE EXCEPTION 'INVALID_IMPORT_SELECTION' USING ERRCODE='40001'; END IF;
 SELECT s.pipeline_id INTO pipeline FROM hon.crm_pipeline_stages s WHERE s.id=b.pipeline_stage_id AND s.organization_id=b.organization_id AND s.school_id=b.school_id AND s.terminal_status IS NULL;
 IF pipeline IS NULL THEN RAISE EXCEPTION 'INVALID_PIPELINE_STAGE' USING ERRCODE='22023'; END IF;
 INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164)
 VALUES(b.organization_id,b.school_id,coalesce(nullif(r.normalized->>'givenName',''),r.normalized->>'displayName'),coalesce(r.normalized->>'familyName',''),nullif(r.normalized->>'email',''),nullif(r.normalized->>'mobile','')) RETURNING id INTO person;
 attribution:=jsonb_build_object('migration',jsonb_build_object('batchId',b.id,'rowIndex',p_row,'sourceChecksum',b.source_checksum));
 FOR payload IN SELECT jsonb_build_object(k,r.normalized->>k) FROM unnest(ARRAY['displayName','note','campaign','medium','sourceDetail']) k WHERE coalesce(r.normalized->>k,'')<>'' LOOP attribution:=attribution||payload; END LOOP;
 INSERT INTO hon.crm_leads(organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,source_code,attribution)
 VALUES(b.organization_id,b.school_id,person,pipeline,b.pipeline_stage_id,nullif(r.normalized->>'source',''),attribution) RETURNING id INTO lead;
 UPDATE hon.lead_import_rows SET lead_id=lead WHERE batch_id=b.id AND row_index=p_row;
 INSERT INTO hon.lead_import_evidence(batch_id,organization_id,school_id,batch_version,row_index,kind,actor_principal_id,lead_id,request_id,correlation_id)
 VALUES(b.id,b.organization_id,b.school_id,b.version+1,p_row,'APPLIED',p_actor,lead,p_request,p_correlation);
 payload:=jsonb_build_object('batchId',b.id,'rowIndex',p_row,'leadId',lead,'internalOnly',true);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
 VALUES(b.organization_id,b.school_id,p_actor,'HUMAN_UI','migration.lead_import.row_applied','CRM_LEAD',lead,payload,'SUCCEEDED',p_request,p_correlation);
 -- Deliberately NOT crm.lead.created: migration events are inert evidence only.
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(b.organization_id,b.school_id,'migration.lead_import.row_applied',1,'CRM_LEAD',lead,1,p_correlation,p_request,payload);
 RETURN lead;
END $$;

CREATE FUNCTION hon.mutate_lead_import(p_subject text,p_operation text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text;
 b hon.lead_import_batches%ROWTYPE; previous hon.lead_import_requests%ROWTYPE; fp text; result jsonb; payload jsonb; validation jsonb; cell jsonb;
 headers jsonb; mapping jsonb; rows jsonb; fields text[]; idx integer; stage uuid; item jsonb; choice text; selected jsonb; expected jsonb; v_token uuid; v_expiry timestamptz;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN('upload','open','decide','finalize') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' OR p_request IS NULL OR p_correlation IS NULL
  OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 permission:='migration.lead_import.'||CASE WHEN p_operation IN('open','decide') THEN 'review' ELSE p_operation END;
 -- Same serialization order as IAM; post-wait time/authority revalidation before replay.
 PERFORM 1 FROM hon.organizations WHERE id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 actor:=hon.require_lead_import_actor(p_subject,permission);
 PERFORM 1 FROM hon.principals WHERE id=actor AND is_active FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR UPDATE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school) ORDER BY id FOR UPDATE;
 actor:=hon.require_lead_import_actor(p_subject,permission);
 IF p_operation='finalize' THEN PERFORM hon.require_lead_import_actor(p_subject,'migration.lead_import.review'); END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'ENTITLEMENT_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_operation<>'upload' THEN
  SELECT * INTO b FROM hon.lead_import_batches WHERE id=p_id AND organization_id=org AND school_id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 END IF;
 fp:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'batchId',p_id,'input',p_input)::text,'UTF8')),'hex');
 SELECT * INTO previous FROM hon.lead_import_requests WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=p_key;
 IF FOUND THEN
  IF previous.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
  IF p_operation IN('open','decide') AND (b.status<>'REVIEW' OR b.review_actor IS DISTINCT FROM actor OR b.review_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'REVIEW_EXPIRED' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('record',previous.response,'replayed',true);
 END IF;
 IF p_operation='upload' THEN
  IF p_id IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('csv','headers','mapping','rows','pipelineStageId'))
   OR jsonb_typeof(p_input->'csv') IS DISTINCT FROM 'string' OR octet_length(p_input->>'csv') NOT BETWEEN 1 AND 262144
   OR (p_input->>'csv') ~ '\uFFFD' OR jsonb_typeof(p_input->'headers') IS DISTINCT FROM 'array' OR jsonb_typeof(p_input->'mapping') IS DISTINCT FROM 'object' OR jsonb_typeof(p_input->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_CSV' USING ERRCODE='22023'; END IF;
  headers:=p_input->'headers'; mapping:=p_input->'mapping'; rows:=p_input->'rows';
  IF jsonb_array_length(headers) NOT BETWEEN 1 AND 16 OR jsonb_array_length(rows) NOT BETWEEN 1 AND 1000
   OR (SELECT count(DISTINCT h) FROM jsonb_array_elements_text(headers) h)<>jsonb_array_length(headers)
   OR (SELECT count(*) FROM jsonb_object_keys(mapping))<>jsonb_array_length(headers) THEN RAISE EXCEPTION 'INVALID_MAPPING' USING ERRCODE='22023'; END IF;
  FOR cell IN SELECT * FROM jsonb_array_elements(headers) LOOP
   IF jsonb_typeof(cell)<>'string' OR length(btrim(cell#>>'{}')) NOT BETWEEN 1 AND 80 OR (cell#>>'{}') ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' OR (cell#>>'{}') ~ '^[[:space:]]*[=+@-]' OR NOT mapping ? (cell#>>'{}') THEN RAISE EXCEPTION 'INVALID_HEADER' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT array_agg(v) INTO fields FROM jsonb_each_text(mapping) x(k,v);
  IF NOT fields <@ ARRAY['givenName','familyName','displayName','email','mobile','source','note','campaign','medium','sourceDetail'] OR cardinality(fields)<>(SELECT count(DISTINCT x) FROM unnest(fields) x)
   OR NOT('givenName'=ANY(fields) OR 'displayName'=ANY(fields)) OR ('givenName'=ANY(fields))<>('familyName'=ANY(fields)) THEN RAISE EXCEPTION 'INVALID_MAPPING' USING ERRCODE='22023'; END IF;
  stage:=(p_input->>'pipelineStageId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM hon.crm_pipeline_stages WHERE id=stage AND organization_id=org AND school_id=school AND terminal_status IS NULL) THEN RAISE EXCEPTION 'INVALID_PIPELINE_STAGE' USING ERRCODE='22023'; END IF;
  INSERT INTO hon.lead_import_batches(organization_id,school_id,pipeline_stage_id,source_checksum,headers,mapping,row_count,valid_count,created_by_principal_id)
  VALUES(org,school,stage,encode(sha256(convert_to(p_input->>'csv','UTF8')),'hex'),headers,mapping,jsonb_array_length(rows),
   (SELECT count(*) FROM jsonb_array_elements(rows) x WHERE hon.validate_lead_import_row(headers,mapping,x)->'errors'='[]'),actor) RETURNING * INTO b;
  idx:=0;
  FOR item IN SELECT * FROM jsonb_array_elements(rows) LOOP
   idx:=idx+1; validation:=hon.validate_lead_import_row(headers,mapping,item);
   INSERT INTO hon.lead_import_rows(batch_id,organization_id,school_id,row_index,source_row,normalized,validation_errors)
   VALUES(b.id,org,school,idx,item,validation->'normalized',validation->'errors');
  END LOOP;
 ELSE
  IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' OR (p_input->>'expectedVersion')::integer<>b.version OR b.status='FINALIZED' THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  IF p_operation='open' THEN
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k<>'expectedVersion') THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
   IF b.review_actor IS NOT NULL AND b.review_actor<>actor AND b.review_expires_at>clock_timestamp() THEN RAISE EXCEPTION 'BATCH_ALREADY_REVIEWED' USING ERRCODE='40001'; END IF;
   v_token:=gen_random_uuid(); v_expiry:=clock_timestamp()+interval '15 minutes';
   UPDATE hon.lead_import_batches SET status='REVIEW',version=version+1,review_actor=actor,review_token=v_token,review_expires_at=v_expiry WHERE id=b.id;
   UPDATE hon.lead_import_rows r SET duplicate_suggestions=coalesce((
    SELECT jsonb_agg(suggestion ORDER BY suggestion::text COLLATE "C") FROM (
     SELECT jsonb_build_object('leadId',l.id,'reason','EMAIL') suggestion FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id AND p.organization_id=l.organization_id AND p.school_id=l.school_id
      WHERE l.organization_id=org AND l.school_id=school AND coalesce(r.normalized->>'email','')<>'' AND lower(btrim(p.email::text))=r.normalized->>'email'
     UNION ALL SELECT jsonb_build_object('leadId',l.id,'reason','PHONE') FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id AND p.organization_id=l.organization_id AND p.school_id=l.school_id
      WHERE l.organization_id=org AND l.school_id=school AND coalesce(r.normalized->>'mobile','')<>'' AND regexp_replace(p.phone_e164,'[ ()-]','','g')=r.normalized->>'mobile'
     UNION ALL SELECT jsonb_build_object('rowIndex',x.row_index,'reason','EMAIL') FROM hon.lead_import_rows x WHERE x.batch_id=r.batch_id AND x.row_index<>r.row_index AND coalesce(r.normalized->>'email','')<>'' AND x.normalized->>'email'=r.normalized->>'email'
     UNION ALL SELECT jsonb_build_object('rowIndex',x.row_index,'reason','PHONE') FROM hon.lead_import_rows x WHERE x.batch_id=r.batch_id AND x.row_index<>r.row_index AND coalesce(r.normalized->>'mobile','')<>'' AND x.normalized->>'mobile'=r.normalized->>'mobile'
    ) suggestions),'[]') WHERE r.batch_id=b.id;
  ELSE
   IF b.status<>'REVIEW' OR b.review_actor IS DISTINCT FROM actor OR b.review_expires_at<=clock_timestamp() OR (p_input->>'reviewToken')::uuid IS DISTINCT FROM b.review_token THEN RAISE EXCEPTION 'ACTIVE_REVIEW_REQUIRED' USING ERRCODE='42501'; END IF;
   -- Finalizers must also retain exact live private-review authority.
   PERFORM hon.require_lead_import_actor(p_subject,'migration.lead_import.review');
   IF p_operation='decide' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('expectedVersion','reviewToken','decisions')) OR jsonb_typeof(p_input->'decisions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'decisions') NOT BETWEEN 1 AND 1000
     OR (SELECT count(DISTINCT d->>'index') FROM jsonb_array_elements(p_input->'decisions') d)<>jsonb_array_length(p_input->'decisions') THEN RAISE EXCEPTION 'INVALID_DECISIONS' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(p_input->'decisions') LOOP
     IF jsonb_typeof(item)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN('index','choice')) OR jsonb_typeof(item->'index') IS DISTINCT FROM 'number' OR (item->>'index') !~ '^[1-9][0-9]{0,3}$' OR item->>'choice' IS NULL OR item->>'choice' NOT IN('IMPORT','SKIP') THEN RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE='22023'; END IF;
     idx:=(item->>'index')::integer; choice:=item->>'choice';
     UPDATE hon.lead_import_rows SET choice=mutate_lead_import.choice WHERE batch_id=b.id AND row_index=idx AND lead_id IS NULL AND (mutate_lead_import.choice='SKIP' OR validation_errors='[]');
     IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ROW_SELECTION' USING ERRCODE='22023'; END IF;
     INSERT INTO hon.lead_import_evidence(batch_id,organization_id,school_id,batch_version,row_index,kind,actor_principal_id,request_id,correlation_id)
      VALUES(b.id,org,school,b.version+1,idx,choice,actor,p_request,p_correlation);
    END LOOP;
    UPDATE hon.lead_import_batches SET version=version+1 WHERE id=b.id;
   ELSE
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('expectedVersion','reviewToken','selectedIndices')) OR jsonb_typeof(p_input->'selectedIndices') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_SELECTION' USING ERRCODE='22023'; END IF;
    selected:=p_input->'selectedIndices';
    IF jsonb_array_length(selected)>1000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(selected) x WHERE jsonb_typeof(x)<>'number' OR (x#>>'{}') !~ '^[1-9][0-9]{0,3}$') OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(selected) x)<>jsonb_array_length(selected) THEN RAISE EXCEPTION 'INVALID_SELECTION' USING ERRCODE='22023'; END IF;
    SELECT coalesce(jsonb_agg(row_index ORDER BY row_index),'[]') INTO expected FROM hon.lead_import_rows WHERE batch_id=b.id AND choice='IMPORT';
    SELECT coalesce(jsonb_agg(x ORDER BY (x#>>'{}')::integer),'[]') INTO selected FROM jsonb_array_elements(selected) x;
    IF selected<>expected OR EXISTS(SELECT 1 FROM hon.lead_import_rows WHERE batch_id=b.id AND (choice IS NULL OR choice='IMPORT' AND (validation_errors<>'[]' OR lead_id IS NOT NULL))) THEN RAISE EXCEPTION 'EXPLICIT_SELECTION_REQUIRED' USING ERRCODE='40001'; END IF;
    PERFORM 1 FROM hon.crm_pipeline_stages WHERE id=b.pipeline_stage_id AND organization_id=org AND school_id=school AND terminal_status IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_PIPELINE_STAGE' USING ERRCODE='22023'; END IF;
    FOR idx IN SELECT row_index FROM hon.lead_import_rows WHERE batch_id=b.id AND choice='IMPORT' ORDER BY row_index LOOP PERFORM hon.apply_imported_lead(b.id,idx,actor,p_request,p_correlation); END LOOP;
    UPDATE hon.lead_import_batches SET version=version+1,status='FINALIZED',finalized_at=clock_timestamp(),review_token=NULL,review_expires_at=NULL WHERE id=b.id;
   END IF;
  END IF;
 END IF;
 result:=hon.lead_import_summary(b.id);
 IF p_operation='open' THEN result:=jsonb_build_object('batch',result,'reviewToken',v_token,'expiresAt',v_expiry); END IF;
 payload:=jsonb_build_object('batchId',b.id,'operation',p_operation,'version',CASE WHEN p_operation='open' THEN result->'batch'->'version' ELSE result->'version' END,'internalOnly',true);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
 VALUES(org,school,actor,'HUMAN_UI',permission,'LEAD_IMPORT_BATCH',b.id,payload,'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
 VALUES(org,school,permission,1,'LEAD_IMPORT_BATCH',b.id,CASE WHEN p_operation='open' THEN (result->'batch'->>'version')::integer ELSE (result->>'version')::integer END,p_correlation,p_request,payload);
 INSERT INTO hon.lead_import_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES(org,school,actor,p_key,fp,result);
 RETURN jsonb_build_object('record',result,'replayed',false);
END $$;

CREATE FUNCTION hon.read_lead_import(p_subject text,p_kind text,p_id uuid,p_token uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; b hon.lead_import_batches%ROWTYPE; result jsonb; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('LIST','BATCH','OPTIONS','REVIEW_ROWS') OR ((p_kind IN('LIST','OPTIONS'))<>(p_id IS NULL)) OR (p_kind<>'REVIEW_ROWS' AND p_token IS NOT NULL) THEN RAISE EXCEPTION 'INVALID_READ' USING ERRCODE='22023'; END IF;
 actor:=hon.require_lead_import_actor(p_subject,CASE WHEN p_kind='REVIEW_ROWS' THEN 'migration.lead_import.review' ELSE 'migration.lead_import.read' END);
 IF p_kind='OPTIONS' THEN
  SELECT jsonb_build_object('stages',coalesce(jsonb_agg(jsonb_build_object('id',s.id,'label',left(p.name||' / '||s.name,200)) ORDER BY p.name,s.position,s.id),'[]'),
   'fields',ARRAY['givenName','familyName','displayName','email','mobile','source','note','campaign','medium','sourceDetail'],'maxBytes',262144,'maxRows',1000,'maxColumns',16) INTO result
  FROM hon.crm_pipeline_stages s JOIN hon.crm_pipelines p ON p.id=s.pipeline_id AND p.organization_id=s.organization_id AND p.school_id=s.school_id
  WHERE s.organization_id=org AND s.school_id=school AND s.terminal_status IS NULL;
 ELSIF p_kind='LIST' THEN
  SELECT coalesce(jsonb_agg(hon.lead_import_summary(x.id) ORDER BY x.created_at DESC,x.id),'[]') INTO result FROM (SELECT id,created_at FROM hon.lead_import_batches WHERE organization_id=org AND school_id=school ORDER BY created_at DESC,id LIMIT 25) x;
 ELSE
  SELECT * INTO b FROM hon.lead_import_batches WHERE id=p_id AND organization_id=org AND school_id=school;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  result:=hon.lead_import_summary(b.id);
  IF p_kind='REVIEW_ROWS' THEN
   IF b.status<>'REVIEW' OR b.review_actor IS DISTINCT FROM actor OR b.review_token IS DISTINCT FROM p_token OR b.review_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ACTIVE_REVIEW_REQUIRED' USING ERRCODE='42501'; END IF;
   SELECT jsonb_build_object('batch',result,'headers',b.headers,'mapping',b.mapping,'rows',jsonb_agg(jsonb_build_object('index',r.row_index,'raw',r.source_row,'normalized',r.normalized,'errors',r.validation_errors,'suggestions',r.duplicate_suggestions,'choice',r.choice,'leadId',r.lead_id) ORDER BY r.row_index)) INTO result FROM hon.lead_import_rows r WHERE r.batch_id=b.id;
  END IF;
 END IF;
 RETURN result;
END $$;

REVOKE ALL ON TABLE hon.lead_import_batches,hon.lead_import_rows,hon.lead_import_evidence,hon.lead_import_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.guard_lead_import_evidence(),hon.require_lead_import_actor(text,text),hon.lead_import_summary(uuid),hon.validate_lead_import_row(jsonb,jsonb,jsonb),hon.apply_imported_lead(uuid,integer,uuid,uuid,uuid),hon.resolve_lead_import_scope(text,text),hon.mutate_lead_import(text,text,uuid,jsonb,text,uuid,uuid),hon.read_lead_import(text,text,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  REVOKE ALL ON TABLE hon.lead_import_batches,hon.lead_import_rows,hon.lead_import_evidence,hon.lead_import_requests FROM hon_runtime;
  REVOKE ALL ON FUNCTION hon.guard_lead_import_evidence(),hon.require_lead_import_actor(text,text),hon.lead_import_summary(uuid),hon.validate_lead_import_row(jsonb,jsonb,jsonb),hon.apply_imported_lead(uuid,integer,uuid,uuid,uuid) FROM hon_runtime;
  GRANT EXECUTE ON FUNCTION hon.resolve_lead_import_scope(text,text),hon.mutate_lead_import(text,text,uuid,jsonb,text,uuid,uuid),hon.read_lead_import(text,text,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
