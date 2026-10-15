BEGIN;
-- Additive hardening after first fixture execution: unambiguous choice variable,
-- stale review token replay rejection, and 20 exact suggestions per source row.
CREATE OR REPLACE FUNCTION hon.mutate_lead_import(p_subject text,p_operation text,p_id uuid,p_input jsonb,p_key text,p_request uuid,p_correlation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; permission text;
 b hon.lead_import_batches%ROWTYPE; previous hon.lead_import_requests%ROWTYPE; fp text; result jsonb; payload jsonb; validation jsonb; cell jsonb;
 headers jsonb; mapping jsonb; rows jsonb; fields text[]; idx integer; stage uuid; item jsonb; v_choice text; selected jsonb; expected jsonb; v_token uuid; v_expiry timestamptz;
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
  IF p_operation='open' AND (previous.response->>'reviewToken')::uuid IS DISTINCT FROM b.review_token OR p_operation='decide' AND (p_input->>'reviewToken')::uuid IS DISTINCT FROM b.review_token THEN RAISE EXCEPTION 'REVIEW_EXPIRED' USING ERRCODE='40001'; END IF;
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
    SELECT jsonb_agg(suggestion ORDER BY suggestion::text COLLATE "C") FROM (SELECT suggestion FROM (
     SELECT jsonb_build_object('leadId',l.id,'reason','EMAIL') suggestion FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id AND p.organization_id=l.organization_id AND p.school_id=l.school_id
      WHERE l.organization_id=org AND l.school_id=school AND coalesce(r.normalized->>'email','')<>'' AND lower(btrim(p.email::text))=r.normalized->>'email'
     UNION ALL SELECT jsonb_build_object('leadId',l.id,'reason','PHONE') FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id AND p.organization_id=l.organization_id AND p.school_id=l.school_id
      WHERE l.organization_id=org AND l.school_id=school AND coalesce(r.normalized->>'mobile','')<>'' AND regexp_replace(p.phone_e164,'[ ()-]','','g')=r.normalized->>'mobile'
     UNION ALL SELECT jsonb_build_object('rowIndex',x.row_index,'reason','EMAIL') FROM hon.lead_import_rows x WHERE x.batch_id=r.batch_id AND x.row_index<>r.row_index AND coalesce(r.normalized->>'email','')<>'' AND x.normalized->>'email'=r.normalized->>'email'
     UNION ALL SELECT jsonb_build_object('rowIndex',x.row_index,'reason','PHONE') FROM hon.lead_import_rows x WHERE x.batch_id=r.batch_id AND x.row_index<>r.row_index AND coalesce(r.normalized->>'mobile','')<>'' AND x.normalized->>'mobile'=r.normalized->>'mobile'
    ) all_suggestions ORDER BY suggestion::text COLLATE "C" LIMIT 20) suggestions),'[]') WHERE r.batch_id=b.id;
  ELSE
   IF b.status<>'REVIEW' OR b.review_actor IS DISTINCT FROM actor OR b.review_expires_at<=clock_timestamp() OR (p_input->>'reviewToken')::uuid IS DISTINCT FROM b.review_token THEN RAISE EXCEPTION 'ACTIVE_REVIEW_REQUIRED' USING ERRCODE='42501'; END IF;
   -- Finalizers must also retain exact live private-review authority.
   PERFORM hon.require_lead_import_actor(p_subject,'migration.lead_import.review');
   IF p_operation='decide' THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('expectedVersion','reviewToken','decisions')) OR jsonb_typeof(p_input->'decisions') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'decisions') NOT BETWEEN 1 AND 1000
     OR (SELECT count(DISTINCT d->>'index') FROM jsonb_array_elements(p_input->'decisions') d)<>jsonb_array_length(p_input->'decisions') THEN RAISE EXCEPTION 'INVALID_DECISIONS' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(p_input->'decisions') LOOP
     IF jsonb_typeof(item)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN('index','choice')) OR jsonb_typeof(item->'index') IS DISTINCT FROM 'number' OR (item->>'index') !~ '^[1-9][0-9]{0,3}$' OR item->>'choice' IS NULL OR item->>'choice' NOT IN('IMPORT','SKIP') THEN RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE='22023'; END IF;
     idx:=(item->>'index')::integer; v_choice:=item->>'choice';
     UPDATE hon.lead_import_rows SET choice=v_choice WHERE batch_id=b.id AND row_index=idx AND lead_id IS NULL AND (v_choice='SKIP' OR validation_errors='[]');
     IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ROW_SELECTION' USING ERRCODE='22023'; END IF;
     INSERT INTO hon.lead_import_evidence(batch_id,organization_id,school_id,batch_version,row_index,kind,actor_principal_id,request_id,correlation_id)
      VALUES(b.id,org,school,b.version+1,idx,v_choice,actor,p_request,p_correlation);
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

-- No PostgREST/browser/integration role receives private import table/function access.
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON TABLE hon.lead_import_batches,hon.lead_import_rows,hon.lead_import_evidence,hon.lead_import_requests FROM %I',role_name);
  EXECUTE format('REVOKE ALL ON FUNCTION hon.resolve_lead_import_scope(text,text),hon.mutate_lead_import(text,text,uuid,jsonb,text,uuid,uuid),hon.read_lead_import(text,text,uuid,uuid),hon.guard_lead_import_evidence(),hon.require_lead_import_actor(text,text),hon.lead_import_summary(uuid),hon.validate_lead_import_row(jsonb,jsonb,jsonb),hon.apply_imported_lead(uuid,integer,uuid,uuid,uuid) FROM %I',role_name);
 END LOOP;
END $$;
COMMIT;
