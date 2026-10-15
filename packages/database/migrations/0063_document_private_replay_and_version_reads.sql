BEGIN;

-- Full document/evidence responses MUST NOT live in the shared operational
-- idempotency table: its conventional RLS/grants are tenant-wide, not parent-safe.
-- This closed domain request namespace retains standardized scope/key/fingerprint
-- semantics, but only the fixed human command definer can read/write responses.
CREATE TABLE hon.document_command_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), request_fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN('IN_PROGRESS','COMPLETED')), response_status integer, response_body jsonb,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
 UNIQUE(organization_id,school_id,principal_id,idempotency_key)
);
ALTER TABLE hon.document_command_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.document_command_requests FORCE ROW LEVEL SECURITY;
-- Move any earlier foundation responses before removing them from shared storage.
INSERT INTO hon.document_command_requests(id,organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,response_status,response_body,expires_at)
SELECT r.id,r.organization_id,r.school_id,r.principal_id,r.idempotency_key,r.request_fingerprint,r.status::text,r.response_status,r.response_body,r.expires_at
FROM hon.idempotency_records r WHERE EXISTS(SELECT 1 FROM hon.document_templates t
 WHERE t.id::text=r.response_body->>'id' AND t.organization_id=r.organization_id AND t.school_id=r.school_id)
 OR EXISTS(SELECT 1 FROM hon.document_acknowledgements a
 WHERE a.id::text=r.response_body->>'id' AND a.organization_id=r.organization_id AND a.school_id=r.school_id);
DELETE FROM hon.idempotency_records r WHERE EXISTS(SELECT 1 FROM hon.document_command_requests d WHERE d.id=r.id);
REVOKE ALL ON TABLE hon.document_command_requests FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
 REVOKE ALL ON TABLE hon.document_command_requests FROM hon_runtime;
END IF; END $$;

CREATE OR REPLACE FUNCTION hon.mutate_document(p_subject text,p_mode text,p_action text,p_id uuid,p_input jsonb,
 p_key text,p_request uuid,p_correlation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 v_org uuid:=hon.current_organization_id(); v_school uuid:=hon.current_school_id(); v_actor uuid;
 t hon.document_templates%ROWTYPE; v hon.document_versions%ROWTYPE; p hon.document_publications%ROWTYPE;
 a hon.document_acknowledgements%ROWTYPE; v_record uuid; v_previous hon.document_command_requests%ROWTYPE;
 v_fingerprint text; v_data jsonb; v_evidence jsonb; v_entity uuid; v_type text; v_event text;
 v_version integer; v_family uuid; v_now timestamptz;
BEGIN
 IF p_action IS NULL OR p_action NOT IN('document.template.create','document.template.version','document.publish','document.acknowledge')
   OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200
   OR btrim(p_key)<>p_key OR p_key ~ '[[:cntrl:]]' OR p_request IS NULL OR p_correlation IS NULL
   OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
   RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 IF p_mode='PARENT' AND p_action<>'document.acknowledge' THEN RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 -- Same lock order as IAM; locks and fresh permission checks precede any replay.
 PERFORM 1 FROM hon.organizations WHERE id=v_org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.schools WHERE id=v_school AND organization_id=v_org AND status='ACTIVE' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_action='document.acknowledge' THEN
   SELECT * INTO p FROM hon.document_publications WHERE id=p_id AND organization_id=v_org AND school_id=v_school;
   IF NOT FOUND OR p.audience IS DISTINCT FROM p_mode THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
   v_family:=p.family_id;
 END IF;
 v_actor:=hon.require_document_actor(p_subject,p_mode,p_action,v_family,true);
 IF p_action<>'document.template.create' THEN
   SELECT * INTO t FROM hon.document_templates WHERE id=CASE WHEN p_action='document.acknowledge' THEN p.template_id ELSE p_id END
     AND organization_id=v_org AND school_id=v_school FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 END IF;
 IF p_action='document.acknowledge' THEN
   IF t.current_publication_id IS DISTINCT FROM p.id THEN RAISE EXCEPTION 'PUBLICATION_SUPERSEDED' USING ERRCODE='40001'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN('contentHash','choice','attestationText'))
     OR jsonb_typeof(p_input->'contentHash') IS DISTINCT FROM 'string' OR (p_input->>'contentHash') !~ '^[a-f0-9]{64}$'
     OR p_input->>'contentHash' IS DISTINCT FROM p.content_hash OR p_input->>'choice' IS DISTINCT FROM 'ACKNOWLEDGE'
     OR (p_input ? 'attestationText' AND (jsonb_typeof(p_input->'attestationText') IS DISTINCT FROM 'string'
       OR length(btrim(p_input->>'attestationText')) NOT BETWEEN 1 AND 500 OR (p_input->>'attestationText') ~ '[[:cntrl:]]')) THEN
     RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 ELSE
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN(
     CASE WHEN p_action='document.template.create' THEN 'audience' ELSE 'expectedVersion' END,
     CASE WHEN p_action='document.template.create' THEN 'familyId' ELSE 'versionId' END,'title','content')) THEN
     RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   IF p_action<>'document.template.create' AND (jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number'
     OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   IF p_action='document.publish' THEN
     IF p_input ? 'title' OR p_input ? 'content' OR jsonb_typeof(p_input->'versionId') IS DISTINCT FROM 'string' THEN
       RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   ELSE
     IF jsonb_typeof(p_input->'title') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'title')) NOT BETWEEN 1 AND 200
       OR (p_input->>'title') ~ '[[:cntrl:]]' OR jsonb_typeof(p_input->'content') IS DISTINCT FROM 'string'
       OR length(btrim(p_input->>'content')) NOT BETWEEN 1 AND 100000 OR (p_input->>'content') ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
       OR p_input ? 'versionId' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   END IF;
 END IF;
 v_fingerprint:=encode(sha256(convert_to(jsonb_build_object('mode',p_mode,'action',p_action,'id',p_id,'input',p_input)::text,'UTF8')),'hex');
 INSERT INTO hon.document_command_requests(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
 VALUES(v_org,v_school,v_actor,p_key,v_fingerprint,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
 ON CONFLICT DO NOTHING RETURNING id INTO v_record;
 IF v_record IS NULL THEN
   SELECT * INTO v_previous FROM hon.document_command_requests WHERE organization_id=v_org AND school_id=v_school AND principal_id=v_actor AND idempotency_key=p_key FOR UPDATE;
   IF v_previous.request_fingerprint IS DISTINCT FROM v_fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE='23505'; END IF;
   IF v_previous.status='COMPLETED' THEN RETURN jsonb_build_object('record',v_previous.response_body,'replayed',true); END IF;
   RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE='55P03';
 END IF;
 IF p_action='document.template.create' THEN
   IF p_id IS NOT NULL OR p_input->>'audience' IS NULL OR p_input->>'audience' NOT IN('STAFF','PARENT')
     OR (p_input->>'audience'='PARENT') IS DISTINCT FROM (p_input ? 'familyId') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
   v_family:=(p_input->>'familyId')::uuid;
   IF p_input->>'audience'='PARENT' AND (v_family IS NULL OR NOT EXISTS(SELECT 1 FROM hon.families WHERE id=v_family AND organization_id=v_org AND school_id=v_school AND status='ACTIVE')) THEN
     RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
   v.id:=gen_random_uuid();
   INSERT INTO hon.document_templates(organization_id,school_id,audience,family_id,latest_version_id,created_by_principal_id)
     VALUES(v_org,v_school,p_input->>'audience',v_family,v.id,v_actor) RETURNING * INTO t;
   INSERT INTO hon.document_versions(id,organization_id,school_id,template_id,version_number,title,content,content_hash,created_by_principal_id)
     VALUES(v.id,v_org,v_school,t.id,1,p_input->>'title',p_input->>'content',encode(sha256(convert_to((p_input->>'title')||E'\n'||(p_input->>'content'),'UTF8')),'hex'),v_actor) RETURNING * INTO v;
   v_event:='document.template.created';
 ELSIF p_action='document.template.version' THEN
   IF t.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   SELECT * INTO v FROM hon.document_versions WHERE id=t.latest_version_id AND organization_id=v_org AND school_id=v_school;
   INSERT INTO hon.document_versions(organization_id,school_id,template_id,version_number,title,content,content_hash,created_by_principal_id)
     VALUES(v_org,v_school,t.id,v.version_number+1,p_input->>'title',p_input->>'content',encode(sha256(convert_to((p_input->>'title')||E'\n'||(p_input->>'content'),'UTF8')),'hex'),v_actor) RETURNING * INTO v;
   UPDATE hon.document_templates SET latest_version_id=v.id,version=version+1 WHERE id=t.id RETURNING * INTO t;
   v_event:='document.version.created';
 ELSIF p_action='document.publish' THEN
   IF t.version<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   SELECT * INTO v FROM hon.document_versions WHERE id=(p_input->>'versionId')::uuid AND template_id=t.id AND organization_id=v_org AND school_id=v_school;
   IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
   IF v.id<>t.latest_version_id OR EXISTS(SELECT 1 FROM hon.document_publications WHERE version_id=v.id AND template_id=t.id) THEN
     RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
   IF t.audience='PARENT' AND NOT EXISTS(SELECT 1 FROM hon.families WHERE id=t.family_id AND organization_id=v_org AND school_id=v_school AND status='ACTIVE') THEN
     RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
   INSERT INTO hon.document_publications(organization_id,school_id,template_id,version_id,content_hash,audience,family_id,published_by_principal_id)
     VALUES(v_org,v_school,t.id,v.id,v.content_hash,t.audience,t.family_id,v_actor) RETURNING * INTO p;
   UPDATE hon.document_templates SET current_publication_id=p.id,version=version+1 WHERE id=t.id RETURNING * INTO t;
   v_event:='document.published';
 ELSE
   SELECT * INTO a FROM hon.document_acknowledgements WHERE publication_id=p.id AND signer_principal_id=v_actor AND organization_id=v_org AND school_id=v_school;
   IF FOUND THEN
     IF a.choice IS DISTINCT FROM p_input->>'choice' OR a.attestation_text IS DISTINCT FROM p_input->>'attestationText' THEN
       RAISE EXCEPTION 'ACKNOWLEDGEMENT_ALREADY_EXISTS' USING ERRCODE='40001'; END IF;
     v_data:=to_jsonb(a.evidence)||jsonb_build_object('id',a.id,'evidenceHash',a.evidence_hash);
     UPDATE hon.document_command_requests SET status='COMPLETED',response_status=200,response_body=v_data WHERE id=v_record;
     RETURN jsonb_build_object('record',v_data,'replayed',true);
   END IF;
   v_now:=clock_timestamp(); a.id:=gen_random_uuid();
   v_evidence:=jsonb_build_object('schemaVersion',1,'kind','INTERNAL_HUMAN_ACKNOWLEDGEMENT','id',a.id,
     'organizationId',v_org,'schoolId',v_school,'publicationId',p.id,'versionId',p.version_id,'contentHash',p.content_hash,
     'signerPrincipalId',v_actor,'audience',p.audience,'familyId',p.family_id,'choice','ACKNOWLEDGE',
     'attestationText',p_input->>'attestationText','acknowledgedAt',v_now,'source','HUMAN_UI','requestId',p_request,'correlationId',p_correlation);
   INSERT INTO hon.document_acknowledgements(id,organization_id,school_id,publication_id,version_id,content_hash,signer_principal_id,audience,family_id,choice,attestation_text,acknowledged_at,evidence,evidence_hash,request_id,correlation_id)
   VALUES(a.id,v_org,v_school,p.id,p.version_id,p.content_hash,v_actor,p.audience,p.family_id,'ACKNOWLEDGE',p_input->>'attestationText',v_now,v_evidence,
     encode(sha256(convert_to(v_evidence::text,'UTF8')),'hex'),p_request,p_correlation) RETURNING * INTO a;
   v_data:=v_evidence||jsonb_build_object('evidenceHash',a.evidence_hash);
   v_entity:=a.id; v_type:='DOCUMENT_ACKNOWLEDGEMENT'; v_version:=1; v_event:='document.acknowledged';
 END IF;
 IF p_action<>'document.acknowledge' THEN
   v_data:=jsonb_build_object('id',t.id,'audience',t.audience,'familyId',t.family_id,'version',t.version,'latestVersionId',t.latest_version_id,
     'versionId',v.id,'versionNumber',v.version_number,'title',v.title,'content',v.content,'contentHash',v.content_hash,'currentPublicationId',t.current_publication_id);
   v_entity:=t.id; v_type:='DOCUMENT_TEMPLATE'; v_version:=t.version;
 END IF;
 -- Inert evidence metadata only. Never copy content, attestation or family PII
 -- into the generic outbox/audit (which are shared with operational consumers).
 v_evidence:=jsonb_build_object('id',v_entity,'version',v_version,'contentHash',CASE WHEN p_action='document.acknowledge' THEN a.content_hash ELSE v.content_hash END,
   'publicationId',CASE WHEN p_action='document.acknowledge' THEN p.id ELSE t.current_publication_id END,'internalOnly',true);
 INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
   VALUES(v_org,v_school,v_actor,'HUMAN_UI',p_action,v_type,v_entity,v_evidence,'SUCCEEDED',p_request,p_correlation);
 INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
   VALUES(v_org,v_school,v_event,1,v_type,v_entity,v_version,p_correlation,p_request,v_evidence);
 UPDATE hon.document_command_requests SET status='COMPLETED',response_status=200,response_body=v_data WHERE id=v_record;
 RETURN jsonb_build_object('record',v_data,'replayed',false);
END $$;

CREATE OR REPLACE FUNCTION hon.read_documents(p_subject text,p_mode text,p_kind text,p_id uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_actor uuid; v_org uuid:=hon.current_organization_id(); v_school uuid:=hon.current_school_id(); v_data jsonb;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN('TEMPLATE','VERSION','PUBLICATION','LIST','EVIDENCE') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
   OR (p_kind='LIST') IS DISTINCT FROM (p_id IS NULL) OR (p_mode='PARENT' AND p_kind IN('TEMPLATE','VERSION')) THEN
   RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 v_actor:=hon.require_document_actor(p_subject,p_mode,CASE WHEN p_kind='EVIDENCE' THEN 'document.evidence.read' ELSE 'document.read' END,NULL,false);
 IF p_kind='EVIDENCE' THEN
   SELECT a.evidence||jsonb_build_object('evidenceHash',a.evidence_hash) INTO v_data FROM hon.document_acknowledgements a
     WHERE a.id=p_id AND a.organization_id=v_org AND a.school_id=v_school
       AND (p_mode='STAFF' OR a.audience='PARENT' AND a.signer_principal_id=v_actor AND hon.document_family_authorized(p_subject,a.family_id,false));
 ELSIF p_kind='VERSION' THEN
   SELECT jsonb_build_object('id',v.id,'templateId',v.template_id,'versionNumber',v.version_number,'title',v.title,
     'content',v.content,'contentHash',v.content_hash,'createdAt',v.created_at) INTO v_data
   FROM hon.document_versions v WHERE v.id=p_id AND v.organization_id=v_org AND v.school_id=v_school;
 ELSIF p_kind='TEMPLATE' THEN
   SELECT jsonb_build_object('id',t.id,'audience',t.audience,'familyId',t.family_id,'version',t.version,'latestVersionId',t.latest_version_id,
     'versionId',v.id,'versionNumber',v.version_number,'title',v.title,'content',v.content,'contentHash',v.content_hash,'currentPublicationId',t.current_publication_id)
   INTO v_data FROM hon.document_templates t JOIN hon.document_versions v ON v.id=t.latest_version_id AND v.template_id=t.id AND v.organization_id=t.organization_id AND v.school_id=t.school_id
   WHERE t.id=p_id AND t.organization_id=v_org AND t.school_id=v_school;
 ELSE
   SELECT CASE WHEN p_kind='LIST' THEN coalesce(jsonb_agg(row_data ORDER BY published_at DESC,id),'[]'::jsonb) ELSE (jsonb_agg(row_data))->0 END INTO v_data FROM (
     SELECT p.id,p.published_at,jsonb_build_object('id',p.id,'templateId',p.template_id,'versionId',p.version_id,'versionNumber',v.version_number,
       'audience',p.audience,'title',v.title,'content',v.content,'contentHash',p.content_hash,'publishedAt',p.published_at,
       'current',t.current_publication_id=p.id) AS row_data
     FROM hon.document_publications p JOIN hon.document_versions v ON v.id=p.version_id AND v.organization_id=p.organization_id AND v.school_id=p.school_id
     JOIN hon.document_templates t ON t.id=p.template_id AND t.organization_id=p.organization_id AND t.school_id=p.school_id
     WHERE p.organization_id=v_org AND p.school_id=v_school AND (p_id IS NULL OR p.id=p_id)
       AND (p_kind<>'LIST' OR t.current_publication_id=p.id)
       AND (p_mode='STAFF' OR p.audience='PARENT' AND t.current_publication_id=p.id AND hon.document_family_authorized(p_subject,p.family_id,false))
     ORDER BY p.published_at DESC,p.id LIMIT p_limit
   ) rows;
 END IF;
 IF v_data IS NULL THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 RETURN v_data;
END $$;
REVOKE ALL ON FUNCTION hon.mutate_document(text,text,text,uuid,jsonb,text,uuid,uuid),hon.read_documents(text,text,text,uuid,integer) FROM PUBLIC;
COMMIT;
