BEGIN;

-- 0559 (allocated 2026-11-19 above the 0550 main ceiling; first drafted as 0389, then 0490 and 0508): HON reads paper import photos on the AI team's text route.
-- Owner decision 2026-11-16: photo reading uses the AI team's provider (OpenRouter), with the same S4 spend controls,
-- the HQ pause and the per-school AI limit. Plan: /mnt/project-files/paper-import/PHOTO_READER_PLAN.md.
--
-- * One kind, PAPER_READING, on the 0550 shared text caller: agent hon, task class READ_DOCUMENT, task category
--   DOCUMENT_READING. A READ_DOCUMENT plan exists only when HQ keeps a DOCUMENT_READING task profile that requires the
--   TEXT and IMAGE modalities and the chosen model is marked IMAGE; any other plan is refused before it is stored, so the
--   policy order can never send a page to a text-only model. With no such profile nothing is planned or sent.
-- * One reading per set: the proposal's origin key is the set id, so a repeat never sends again. The person who
--   started HON's reading owns it. The provider receives the page images (already stripped of metadata) and the column
--   names only; the proposal row keeps counts, never the table; the table goes into the set exactly as staff edits do,
--   checked cell by cell.
-- * Staff can always type the rows themselves (reader NONE, outcome TYPED): no AI, nothing spent. Refused only while a
--   provider call for that set is in flight.
-- * The stand-in reader (SYNTHETIC, 0388) stays for the built-in sample pages; it never reads a real photo.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF to_regclass('hon.ai_text_proposals') IS NULL OR to_regclass('hon.paper_import_sets') IS NULL
    OR to_regprocedure('hon.ai_route_task_category(text,text)') IS NULL THEN RAISE EXCEPTION '0559 requires 0287, 0388 and 0550'; END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Route: READ_DOCUMENT and DOCUMENT_READING
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE hon.ai_invocation_plans DROP CONSTRAINT ai_invocation_plans_task_class_check, DROP CONSTRAINT ai_invocation_plans_check;
ALTER TABLE hon.ai_invocation_plans ADD CONSTRAINT ai_invocation_plans_task_class_check
    CHECK (task_class IN ('SUMMARIZE','ANALYZE','DRAFT_MARKETING','DRAFT_TEACHING','DRAFT_FOLLOW_UP','READ_DOCUMENT')),
  ADD CONSTRAINT ai_invocation_plans_check CHECK ((task_class='SUMMARIZE' AND risk_class='LOW')
    OR (task_class IN ('ANALYZE','DRAFT_MARKETING','DRAFT_TEACHING','DRAFT_FOLLOW_UP','READ_DOCUMENT') AND risk_class='MODERATE'));

-- 0211 body; READ_DOCUMENT is added to the task classes.
CREATE OR REPLACE FUNCTION hon.validate_ai_invocation_plan_input(p_data jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE keys text[]:=ARRAY['expectedVersion','expectedState','agentKey','modality','taskClass','inputBudget','outputBudget','maxProviderCostMicrounits']; f text;
BEGIN
 IF p_data IS NULL OR jsonb_typeof(p_data)<>'object' OR NOT p_data ?& keys OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k<>ALL(keys)) THEN RAISE EXCEPTION 'Invalid AI planning metadata shape' USING ERRCODE='22023'; END IF;
 FOREACH f IN ARRAY ARRAY['expectedVersion','inputBudget','outputBudget','maxProviderCostMicrounits'] LOOP IF jsonb_typeof(p_data->f)<>'number' OR p_data->>f !~ '^[0-9]+$' OR (p_data->>f)::numeric>2147483646 THEN RAISE EXCEPTION 'Invalid AI planning integer' USING ERRCODE='22023'; END IF; END LOOP;
 IF (p_data->>'expectedVersion')::integer<1 OR (p_data->>'inputBudget')::integer NOT BETWEEN 1 AND 128000 OR (p_data->>'outputBudget')::integer NOT BETWEEN 1 AND 16000 OR (p_data->>'maxProviderCostMicrounits')::integer NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'AI planning budget or version out of range' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_data->'expectedState')<>'string' OR jsonb_typeof(p_data->'agentKey')<>'string' OR jsonb_typeof(p_data->'modality')<>'string' OR jsonb_typeof(p_data->'taskClass')<>'string' OR p_data->>'expectedState' NOT IN('READY','THINKING') OR p_data->>'agentKey' NOT IN('alex','chad','maya','marcus','jordan','claire','lena','eian','hon','kai') OR p_data->>'modality'<>'TEXT' OR p_data->>'taskClass' NOT IN('SUMMARIZE','ANALYZE','DRAFT_MARKETING','DRAFT_TEACHING','DRAFT_FOLLOW_UP','READ_DOCUMENT') THEN RAISE EXCEPTION 'Unregistered AI planning metadata' USING ERRCODE='22023'; END IF;
END $$;

-- 0287 body plus hon/READ_DOCUMENT.
CREATE OR REPLACE FUNCTION hon.ai_route_task_category(p_agent text, p_task_class text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN p_agent = 'hon' AND p_task_class = 'SUMMARIZE' THEN 'HON_STANDARD'
    WHEN p_agent = 'hon' AND p_task_class = 'ANALYZE' THEN 'HON_DETAILED'
    WHEN p_agent = 'hon' AND p_task_class = 'READ_DOCUMENT' THEN 'DOCUMENT_READING'
    WHEN p_agent = 'claire' AND p_task_class = 'ANALYZE' THEN 'BUSINESS_PERFORMANCE'
    WHEN p_agent = 'marcus' AND p_task_class = 'DRAFT_MARKETING' THEN 'MARCUS_MARKETING'
    WHEN p_agent = 'chad' AND p_task_class = 'DRAFT_FOLLOW_UP' THEN 'CHAD_SALES'
    WHEN p_agent = 'kai' AND p_task_class = 'DRAFT_TEACHING' THEN 'KAI_TEACHING'
  END $$;

ALTER TABLE hon.hq_ai_task_profiles DROP CONSTRAINT hq_ai_task_profiles_task_category_check;
ALTER TABLE hon.hq_ai_task_profiles ADD CONSTRAINT hq_ai_task_profiles_task_category_check
  CHECK (task_category IN ('GENERAL_ASSISTANT','MARCUS_MARKETING','CHAD_SALES','CLAIRE_TEACHING','RETENTION','COMMAND_CENTER','WORKFLOW_PLANNING',
    'SIMPLE_CLASSIFICATION','HON_STANDARD','HON_DETAILED','BUSINESS_PERFORMANCE','KAI_TEACHING','DOCUMENT_READING'));

-- 0287 body; DOCUMENT_READING is added to the task categories HQ may keep a profile for.
CREATE OR REPLACE FUNCTION hon.hq_ai_validate_write(p_kind text, p_data jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_keys text[];
  v_field text;
  v_allowed text[];
BEGIN
  v_keys := CASE p_kind
    WHEN 'PROVIDER' THEN ARRAY['providerId','displayName','state','credentialSecretRef','expectedVersion']
    WHEN 'CATALOG' THEN ARRAY['catalogId','providerId','modelId','displayName','capabilities','modalities','privacyControls','active','minimumTier','unitCostMicros','costUnit','effectiveFrom','effectiveUntil','expectedVersion']
    WHEN 'POLICY' THEN ARRAY['policyId','organizationId','schoolId','capability','active','minimumTier','maxCostMicros','allowDegraded','catalogIds','effectiveFrom','effectiveUntil','expectedVersion']
    WHEN 'TASK_PROFILE' THEN ARRAY['profileId','routingPolicyId','agentKey','taskCategory','costUnit','active','maxCostMicros','defaultCatalogId','fallbackCatalogIds','advancedCatalogId','requiredCapabilities','requiredModalities','allowedProviderIds','privacyControls','timeoutCategory','retryCategory','effectiveFrom','effectiveUntil','expectedVersion']
    ELSE NULL END;
  IF v_keys IS NULL OR p_data IS NULL OR jsonb_typeof(p_data) <> 'object'
    OR (p_kind = 'CATALOG' AND (
      NOT p_data ?& ARRAY['catalogId','providerId','modelId','displayName','capabilities','modalities','active','minimumTier','unitCostMicros','costUnit','effectiveFrom','effectiveUntil','expectedVersion']
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k <> ALL(v_keys))
    ))
    OR (p_kind <> 'CATALOG' AND (NOT p_data ?& v_keys OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k <> ALL(v_keys)))) THEN
    RAISE EXCEPTION 'Invalid HQ AI configuration shape' USING ERRCODE = '22023';
  END IF;
  FOREACH v_field IN ARRAY CASE p_kind WHEN 'CATALOG' THEN ARRAY['expectedVersion','unitCostMicros'] WHEN 'POLICY' THEN ARRAY['expectedVersion','maxCostMicros'] WHEN 'TASK_PROFILE' THEN ARRAY['expectedVersion','maxCostMicros'] ELSE ARRAY['expectedVersion'] END LOOP
    IF jsonb_typeof(p_data->v_field) <> 'number' OR (p_data->>v_field) !~ '^[0-9]+$'
      OR (p_data->>v_field)::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'Invalid HQ AI integer' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (p_data->>'expectedVersion')::numeric > 2147483646 THEN
    RAISE EXCEPTION 'Invalid HQ AI version' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'TASK_PROFILE' THEN
    FOREACH v_field IN ARRAY ARRAY['profileId','routingPolicyId','defaultCatalogId'] LOOP
      IF jsonb_typeof(p_data->v_field) <> 'string' OR (p_data->>v_field) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Invalid HQ profile identifier' USING ERRCODE='22023';
      END IF;
    END LOOP;
    IF jsonb_typeof(p_data->'agentKey') <> 'string' OR p_data->>'agentKey' NOT IN ('alex','chad','maya','marcus','jordan','claire','lena','eian','hon','kai')
      OR jsonb_typeof(p_data->'taskCategory') <> 'string' OR p_data->>'taskCategory' NOT IN ('GENERAL_ASSISTANT','MARCUS_MARKETING','CHAD_SALES','CLAIRE_TEACHING','RETENTION','COMMAND_CENTER','WORKFLOW_PLANNING','SIMPLE_CLASSIFICATION','HON_STANDARD','HON_DETAILED','BUSINESS_PERFORMANCE','KAI_TEACHING','DOCUMENT_READING')
      OR jsonb_typeof(p_data->'costUnit') <> 'string' OR p_data->>'costUnit' NOT IN ('TOKEN','SECOND','IMAGE','VIDEO','REQUEST')
      OR jsonb_typeof(p_data->'active') <> 'boolean'
      OR jsonb_typeof(p_data->'timeoutCategory') <> 'string' OR p_data->>'timeoutCategory' NOT IN ('QUICK','STANDARD','EXTENDED')
      OR jsonb_typeof(p_data->'retryCategory') <> 'string' OR p_data->>'retryCategory' NOT IN ('NONE','TRANSIENT_ONCE') THEN
      RAISE EXCEPTION 'Invalid HQ profile selection metadata' USING ERRCODE='22023';
    END IF;
    IF NOT hon.hq_ai_valid_list(p_data->'requiredCapabilities',ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING','TOOL_EXECUTION'],1,7)
      OR NOT hon.hq_ai_valid_list(p_data->'requiredModalities',ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING'],1,6)
      OR NOT hon.hq_ai_valid_list(p_data->'allowedProviderIds',ARRAY['OPENROUTER','DIRECT_LLM_API','HEYGEN','HIGGSFIELD'],1,4)
      OR NOT hon.hq_ai_valid_list(p_data->'privacyControls',ARRAY['NO_TRAINING','ZERO_RETENTION'],0,2) THEN
      RAISE EXCEPTION 'Invalid HQ profile restrictions' USING ERRCODE='22023';
    END IF;
    IF jsonb_typeof(p_data->'fallbackCatalogIds') <> 'array' THEN RAISE EXCEPTION 'Invalid HQ profile fallback list' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(p_data->'fallbackCatalogIds') > 7
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'fallbackCatalogIds') x WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      OR (p_data->'advancedCatalogId' <> 'null'::jsonb AND (jsonb_typeof(p_data->'advancedCatalogId') <> 'string' OR p_data->>'advancedCatalogId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) THEN
      RAISE EXCEPTION 'Invalid HQ profile approved IDs' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) <> count(DISTINCT id::uuid) OR count(*) > 8 FROM (
      SELECT p_data->>'defaultCatalogId' id UNION ALL SELECT jsonb_array_elements_text(p_data->'fallbackCatalogIds') UNION ALL SELECT p_data->>'advancedCatalogId' WHERE p_data->'advancedCatalogId' <> 'null'::jsonb
    ) ids) THEN RAISE EXCEPTION 'Duplicate or excessive HQ profile candidates' USING ERRCODE='22023'; END IF;
    IF jsonb_typeof(p_data->'effectiveFrom') <> 'string' OR p_data->>'effectiveFrom' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$'
      OR (p_data->'effectiveUntil' <> 'null'::jsonb AND (jsonb_typeof(p_data->'effectiveUntil') <> 'string' OR p_data->>'effectiveUntil' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$')) THEN
      RAISE EXCEPTION 'Invalid HQ profile effective window' USING ERRCODE='22023';
    END IF;
    RETURN;
  END IF;
  IF p_kind IN ('PROVIDER','CATALOG') AND (jsonb_typeof(p_data->'displayName') <> 'string' OR NOT hon.hq_ai_safe_text(p_data->>'displayName')) THEN
    RAISE EXCEPTION 'Invalid non-secret HQ AI label' USING ERRCODE = '22023';
  END IF;
  IF p_kind IN ('PROVIDER','CATALOG') AND (jsonb_typeof(p_data->'providerId') <> 'string' OR (p_data->>'providerId') NOT IN ('OPENROUTER','DIRECT_LLM_API','HEYGEN','HIGGSFIELD')) THEN
    RAISE EXCEPTION 'Provider is not registered' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'PROVIDER' THEN
    IF jsonb_typeof(p_data->'state') <> 'string' OR (p_data->>'state') NOT IN ('DISABLED','CONFIGURED','HEALTHY','DEGRADED','UNAVAILABLE')
      OR (p_data->'credentialSecretRef' <> 'null'::jsonb AND (jsonb_typeof(p_data->'credentialSecretRef') <> 'string' OR (p_data->>'credentialSecretRef') !~ '^hon-secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
      OR (p_data->>'state' <> 'DISABLED' AND p_data->'credentialSecretRef' = 'null'::jsonb) THEN
      RAISE EXCEPTION 'Only opaque HQ credential references and registered states are allowed' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  IF jsonb_typeof(p_data->'active') <> 'boolean' OR (p_data->>'minimumTier') NOT IN ('ESSENTIAL','CORE','COMPLETE') OR jsonb_typeof(p_data->'minimumTier') <> 'string'
    OR jsonb_typeof(p_data->'effectiveFrom') <> 'string' OR (p_data->>'effectiveFrom') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$'
    OR (p_data->'effectiveUntil' <> 'null'::jsonb AND (jsonb_typeof(p_data->'effectiveUntil') <> 'string' OR (p_data->>'effectiveUntil') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$')) THEN
    RAISE EXCEPTION 'Invalid HQ AI effective window or entitlement' USING ERRCODE = '22023';
  END IF;
  FOREACH v_field IN ARRAY CASE p_kind WHEN 'CATALOG' THEN ARRAY['catalogId'] ELSE ARRAY['policyId','organizationId','schoolId'] END LOOP
    IF jsonb_typeof(p_data->v_field) <> 'string' OR (p_data->>v_field) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid HQ AI identifier' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_kind = 'CATALOG' THEN
    IF p_data ? 'privacyControls' AND NOT hon.hq_ai_valid_list(p_data->'privacyControls',ARRAY['NO_TRAINING','ZERO_RETENTION'],0,2) THEN RAISE EXCEPTION 'Invalid HQ catalog privacy attestations' USING ERRCODE='22023'; END IF;
    IF jsonb_typeof(p_data->'modelId') <> 'string' OR NOT hon.hq_ai_safe_text(p_data->>'modelId', true)
      OR jsonb_typeof(p_data->'costUnit') <> 'string' OR (p_data->>'costUnit') NOT IN ('TOKEN','SECOND','IMAGE','VIDEO','REQUEST') THEN
      RAISE EXCEPTION 'Invalid HQ AI model metadata' USING ERRCODE = '22023';
    END IF;
    FOREACH v_field IN ARRAY ARRAY['capabilities','modalities'] LOOP
      v_allowed := CASE v_field WHEN 'capabilities' THEN ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING','TOOL_EXECUTION'] ELSE ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING'] END;
      IF jsonb_typeof(p_data->v_field) <> 'array' THEN RAISE EXCEPTION 'Invalid HQ AI capability list' USING ERRCODE = '22023'; END IF;
      IF jsonb_array_length(p_data->v_field) NOT BETWEEN 1 AND cardinality(v_allowed)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->v_field) x WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') <> ALL(v_allowed))
        OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(p_data->v_field) x) <> jsonb_array_length(p_data->v_field) THEN
        RAISE EXCEPTION 'Invalid HQ AI capability list' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  ELSE
    IF jsonb_typeof(p_data->'capability') <> 'string' OR (p_data->>'capability') NOT IN ('TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING','TOOL_EXECUTION') OR jsonb_typeof(p_data->'allowDegraded') <> 'boolean' OR jsonb_typeof(p_data->'catalogIds') <> 'array' THEN
      RAISE EXCEPTION 'Invalid HQ AI routing metadata' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_data->'catalogIds') NOT BETWEEN 1 AND 8
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'catalogIds') x WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      OR (SELECT count(DISTINCT lower(x)) FROM jsonb_array_elements_text(p_data->'catalogIds') x) <> jsonb_array_length(p_data->'catalogIds') THEN
      RAISE EXCEPTION 'Invalid HQ approved routing IDs' USING ERRCODE = '22023';
    END IF;
  END IF;
END $$;

-- A READ_DOCUMENT plan carries page images, so it must come from HQ's DOCUMENT_READING profile requiring TEXT and IMAGE,
-- on a model marked IMAGE. The planner's policy-order path (no profile) and any text-only model are refused here, before
-- the plan or its idempotency record is stored, so a later retry re-plans against live HQ configuration.
CREATE FUNCTION hon.ai_plan_document_reading_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF NEW.task_class='READ_DOCUMENT' AND NOT (NEW.agent_key='hon' AND NEW.route_selection IN ('PROFILE_DEFAULT','PROFILE_FALLBACK')
      AND EXISTS(SELECT 1 FROM hon.hq_ai_task_profiles tp WHERE tp.profile_id=NEW.task_profile_id AND tp.version=NEW.task_profile_version
        AND tp.agent_key='hon' AND tp.task_category='DOCUMENT_READING' AND ARRAY['TEXT','IMAGE'] <@ tp.required_modalities
        AND ARRAY['NO_TRAINING','ZERO_RETENTION'] <@ tp.privacy_controls)
      AND EXISTS(SELECT 1 FROM hon.hq_ai_model_catalog c WHERE c.catalog_id=NEW.catalog_id AND c.version=NEW.catalog_version
        AND ARRAY['TEXT','IMAGE'] <@ c.modalities AND ARRAY['NO_TRAINING','ZERO_RETENTION'] <@ c.privacy_controls)) THEN
    RAISE EXCEPTION 'AI_DOCUMENT_ROUTE_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_plan_document_reading_guard BEFORE INSERT ON hon.ai_invocation_plans FOR EACH ROW EXECUTE FUNCTION hon.ai_plan_document_reading_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Kind PAPER_READING
-- ---------------------------------------------------------------------------------------------------------------
-- Input 40,000 tokens covers up to 10 page images and the instructions; output 16,000 covers 200 rows of up to 8 short
-- cells. At most $0.25 per reading. The result kept on the proposal is counts only (the table lives in the set).
INSERT INTO hon.ai_text_kinds(kind,agent_key,task_class,input_budget,output_budget,max_cost_microunits,max_result_bytes,caller,subject_type,usage_agent)
  VALUES ('PAPER_READING','hon','READ_DOCUMENT',40000,16000,250000,256,'HUMAN_UI','PAPER_IMPORT_SET','PAPER_READING');

-- ---------------------------------------------------------------------------------------------------------------
-- Paper import: reader and outcome values
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE hon.paper_import_sets DROP CONSTRAINT paper_import_sets_reader_check, DROP CONSTRAINT paper_import_sets_read_outcome_check;
ALTER TABLE hon.paper_import_sets ADD CONSTRAINT paper_import_sets_reader_check CHECK (reader IN ('SYNTHETIC','AI_ROUTE','NONE')),
  ADD CONSTRAINT paper_import_sets_read_outcome_check CHECK (read_outcome IN ('SAMPLE_READ','NOT_READABLE','AI_READ','TYPED')),
  ADD CONSTRAINT paper_import_sets_reader_outcome_check CHECK (reader IS NULL OR (reader='SYNTHETIC' AND read_outcome IN ('SAMPLE_READ','NOT_READABLE'))
    OR (reader='AI_ROUTE' AND read_outcome IN ('AI_READ','NOT_READABLE')) OR (reader='NONE' AND read_outcome='TYPED'));

-- The one PAPER_READING proposal of a set in this school (no lock), or NULL.
CREATE FUNCTION hon.paper_reading_proposal_id(p_set uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT id FROM hon.ai_text_proposals WHERE kind='PAPER_READING' AND origin_key=p_set::text
    AND organization_id=hon.current_organization_id() AND school_id=hon.current_school_id()
$$;

-- 0388 body plus aiReading: HON's reading of the set on the AI route, as staff may see it (status and reason only).
CREATE OR REPLACE FUNCTION hon.paper_import_detail(s hon.paper_import_sets) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('set',hon.paper_import_summary(s),'columns',to_jsonb(hon.paper_import_columns(s.target)),
    'rows',CASE WHEN x.gone THEN '[]'::jsonb ELSE coalesce(s.table_rows,'[]'::jsonb) END,
    'unsure',CASE WHEN x.gone THEN '[]'::jsonb ELSE coalesce(s.table_unsure,'[]'::jsonb) END,
    'pages',CASE WHEN x.gone THEN '[]'::jsonb ELSE (SELECT coalesce(jsonb_agg(jsonb_build_object('pageNo',p.page_no,'mediaType',p.media_type,
      'bytes',octet_length(p.content),'checksum',p.checksum) ORDER BY p.page_no),'[]'::jsonb) FROM hon.paper_import_pages p WHERE p.set_id=s.id) END,
    'aiReading',(SELECT jsonb_build_object('status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,
      'reason',i.reason) FROM hon.ai_text_proposals i WHERE i.kind='PAPER_READING' AND i.origin_key=s.id::text
      AND i.organization_id=s.organization_id AND i.school_id=s.school_id))
  FROM (SELECT s.status='DELETED' OR s.expires_at<=clock_timestamp() AS gone) x
$$;

-- Ids-only audit and inert outbox for a reading outcome. No live authority re-check: a call in flight when access lapsed
-- still records what it cost (0193 evidence rule).
CREATE FUNCTION hon.paper_import_note(p_actor uuid,p_operation text,p_set uuid,p_request uuid,p_correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); payload jsonb; v integer;
BEGIN
  SELECT version INTO v FROM hon.paper_import_sets WHERE id=p_set;
  payload:=jsonb_build_object('setId',p_set,'operation',p_operation,'version',v,'internalOnly',true);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(org,school,p_actor,'HUMAN_UI','students.paper_import.'||p_operation,'PAPER_IMPORT_SET',p_set,payload,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(org,school,'students.paper_import.'||p_operation,1,'PAPER_IMPORT_SET',p_set,v,p_correlation,p_request,payload);
END $$;

-- The requester of HON's reading: live student import authority (0388) plus the AI team's planning permission
-- (ai.invocation.plan, the hon agent's capability) and an active Complete plan. plan_ai_invocation decides the last two
-- again; they are checked here first so staff learn early and can type the rows instead.
CREATE FUNCTION hon.paper_reading_ai_actor(p_subject text) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.require_paper_import_actor(p_subject); org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF NOT hon.principal_has_school_permission(actor,org,school,'ai.invocation.plan')
    OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.tier='COMPLETE' AND e.status='ACTIVE'
      AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'PAPER_IMPORT_AI_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

-- Step 2 of HON's reading (after 0388 begin_paper_reading fixed the pages and passed the spend decision). Creates or
-- replays the set's one proposal. Input: exactly {readingId}.
CREATE FUNCTION hon.begin_paper_ai_reading(p_subject text,p_set uuid,p_input jsonb,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; r hon.paper_import_sets%ROWTYPE; prior uuid; pid uuid; i hon.ai_text_proposals%ROWTYPE;
BEGIN
  IF p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['readingId']
    OR jsonb_typeof(p_input->'readingId') IS DISTINCT FROM 'string' OR (p_input->>'readingId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.paper_reading_ai_actor(p_subject);
  r:=hon.paper_import_lock(p_set,NULL);
  IF r.status<>'OPEN' THEN RETURN jsonb_build_object('done',true); END IF;
  IF r.reading_id IS DISTINCT FROM (p_input->>'readingId')::uuid OR r.page_count<1 OR r.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'PAPER_IMPORT_READING_STALE' USING ERRCODE='40001'; END IF;
  SELECT requested_by INTO prior FROM hon.ai_text_proposals WHERE id=hon.paper_reading_proposal_id(r.id);
  IF FOUND AND prior IS DISTINCT FROM actor THEN RAISE EXCEPTION 'PAPER_IMPORT_READING_OWNED' USING ERRCODE='40001'; END IF;
  pid:=hon.ai_text_begin('PAPER_READING',actor,r.id::text,r.id,NULL,jsonb_build_object('kind',r.kind,'checksums',to_jsonb(r.page_checksums)));
  IF hon.paper_reading_ai_actor(p_subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'PAPER_IMPORT_AI_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT i FROM hon.ai_text_proposals WHERE id=pid;
  RETURN jsonb_build_object('done',false,'proposalId',i.id,
    'status',CASE WHEN i.status='SENDING' AND i.updated_at<clock_timestamp()-interval '90 seconds' THEN 'UNKNOWN' ELSE i.status END,'reason',i.reason);
END $$;

CREATE FUNCTION hon.paper_ai_reading_planning_reference(p_subject text,p_set uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.paper_reading_ai_actor(p_subject); pid uuid:=hon.paper_reading_proposal_id(p_set);
BEGIN
  IF pid IS NULL THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN hon.ai_text_planning_reference(pid,actor);
END $$;

-- The final claim. The organization budget lock is the first lock, then the proposal row, then the set (shared). The
-- set must still be open with exactly the pages the proposal was made for, and the plan's model must take images.
-- Returns the invocation plus what the API needs to build the request: the kind, the columns and the page checksums.
CREATE FUNCTION hon.prepare_paper_ai_reading(p_subject text,p_set uuid,p_plan uuid,p_ready boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE budget_locked boolean:=hon.ai_budget_lock(hon.current_organization_id()); actor uuid:=hon.paper_reading_ai_actor(p_subject);
  pid uuid:=hon.paper_reading_proposal_id(p_set); i hon.ai_text_proposals%ROWTYPE; s hon.paper_import_sets%ROWTYPE; block text; inv jsonb;
BEGIN
  IF pid IS NULL THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  i:=hon.ai_text_row(pid,actor);
  SELECT * INTO s FROM hon.paper_import_sets WHERE id=p_set AND organization_id=i.organization_id AND school_id=i.school_id FOR SHARE;
  IF NOT FOUND OR s.status<>'OPEN' OR s.expires_at<=clock_timestamp() OR to_jsonb(s.page_checksums) IS DISTINCT FROM i.request->'checksums' THEN block:='SUBJECT_STALE';
  ELSIF p_plan IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hon.ai_invocation_plans p JOIN hon.hq_ai_model_catalog c ON c.catalog_id=p.catalog_id AND c.version=p.catalog_version
      WHERE p.id=p_plan AND p.task_class='READ_DOCUMENT' AND ARRAY['TEXT','IMAGE'] <@ c.modalities
        AND ARRAY['NO_TRAINING','ZERO_RETENTION'] <@ c.privacy_controls) THEN block:='GATE_CLOSED';
  END IF;
  inv:=hon.ai_text_prepare(pid,actor,p_plan,p_ready,block);
  IF inv IS NULL THEN RETURN NULL; END IF;
  RETURN inv||jsonb_build_object('kind',s.kind,'columns',to_jsonb(hon.paper_import_columns(s.target)),'checksums',to_jsonb(s.page_checksums));
END $$;

-- Outcome writers resolve the human requester only (0193 evidence rule).
CREATE FUNCTION hon.fail_paper_ai_reading(p_subject text,p_set uuid,p_outcome text,p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); pid uuid:=hon.paper_reading_proposal_id(p_set);
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF pid IS NULL THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  PERFORM hon.ai_text_fail(pid,actor,p_outcome,p_reason);
END $$;

-- p_result = exactly {usage, rows, unsure}: the API's usage evidence and the table HON read (rows and unsure may be
-- null when the answer was not a table). Usage is recorded first, always. A table that is not exactly the import columns
-- is never kept: the proposal is RESULT_REJECTED and the set becomes READ with an empty table for staff to type into.
-- A set deleted or expired while the call was in flight keeps no table. Returns {recorded, detail}.
CREATE FUNCTION hon.record_paper_ai_reading(p_subject text,p_set uuid,p_result jsonb,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=hon.ai_evidence_actor(p_subject); pid uuid:=hon.paper_reading_proposal_id(p_set); i hon.ai_text_proposals%ROWTYPE;
  s hon.paper_import_sets%ROWTYPE; t_rows jsonb; t_unsure jsonb; problems jsonb:='[]'::jsonb; recorded text; kept boolean:=false;
BEGIN
  IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN RAISE EXCEPTION 'AI_EVIDENCE_HUMAN_REQUIRED' USING ERRCODE='42501'; END IF;
  IF p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_result) x) IS DISTINCT FROM ARRAY['rows','unsure','usage'] THEN
    RAISE EXCEPTION 'INVALID_AI_TEXT_RESULT' USING ERRCODE='22023'; END IF;
  IF pid IS NULL THEN RAISE EXCEPTION 'PAPER_IMPORT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  i:=hon.ai_text_row(pid,actor);
  SELECT * INTO STRICT s FROM hon.paper_import_sets WHERE id=p_set AND organization_id=i.organization_id AND school_id=i.school_id FOR UPDATE;
  t_rows:=p_result->'rows'; t_unsure:=p_result->'unsure';
  IF NOT coalesce(hon.paper_import_table_ok(s.target,t_rows,t_unsure),false) THEN
    t_rows:='[]'::jsonb; t_unsure:='[]'::jsonb; problems:=jsonb_build_array('The answer was not a table in the import columns.');
  END IF;
  recorded:=hon.ai_text_record(pid,actor,p_result->'usage',
    jsonb_build_object('rowCount',jsonb_array_length(t_rows),'unsureCount',(SELECT count(*) FROM jsonb_array_elements(t_unsure) r, jsonb_array_elements(r) c WHERE c='true'::jsonb)),
    problems);
  IF recorded<>'RESULT_RECORDED' THEN t_rows:='[]'::jsonb; t_unsure:='[]'::jsonb; END IF;
  IF s.status='OPEN' AND s.expires_at>clock_timestamp() THEN
    UPDATE hon.paper_import_sets SET version=version+1,status='READ',reading_id=coalesce(reading_id,gen_random_uuid()),
      reading_started_at=coalesce(reading_started_at,clock_timestamp()),reader='AI_ROUTE',
      read_outcome=CASE WHEN jsonb_array_length(t_rows)>0 THEN 'AI_READ' ELSE 'NOT_READABLE' END,read_at=clock_timestamp(),
      table_rows=t_rows,table_unsure=t_unsure WHERE id=s.id RETURNING * INTO s;
    kept:=true;
    PERFORM hon.paper_import_note(actor,'read.record',s.id,p_request,p_correlation);
  END IF;
  IF recorded='RESULT_RECORDED' THEN PERFORM hon.ai_text_close(pid,actor,CASE WHEN kept THEN 'APPLIED' ELSE 'DISMISSED' END);
  ELSIF recorded='RESULT_REJECTED' THEN PERFORM hon.ai_text_close(pid,actor,'DISMISSED'); END IF;
  RETURN jsonb_build_object('recorded',recorded,'detail',hon.paper_import_detail(s));
END $$;

-- "Type the rows myself": an open set with at least one page becomes READ with an empty table (reader NONE, outcome
-- TYPED). No AI, nothing spent; allowed whatever the AI state, except while HON's call for this set is in flight. A set
-- that is already read returns its detail unchanged. Input: exactly {expectedVersion}.
CREATE FUNCTION hon.type_paper_import_rows(p_subject text,p_set uuid,p_input jsonb,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; r hon.paper_import_sets%ROWTYPE; pid uuid; st text; at timestamptz;
BEGIN
  IF p_request IS NULL OR p_correlation IS NULL OR p_request::text IS DISTINCT FROM current_setting('app.hon_request_id',true)
    OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p_input) x) IS DISTINCT FROM ARRAY['expectedVersion'] THEN
    RAISE EXCEPTION 'PAPER_IMPORT_INVALID' USING ERRCODE='22023'; END IF;
  actor:=hon.require_paper_import_actor(p_subject);
  PERFORM hon.paper_import_purge_school(hon.current_organization_id(),hon.current_school_id());
  -- The proposal row before the set (the prepare order), so a claim and this command never cross.
  pid:=hon.paper_reading_proposal_id(p_set);
  IF pid IS NOT NULL THEN
    SELECT status,updated_at INTO st,at FROM hon.ai_text_proposals WHERE id=pid FOR UPDATE;
    IF st='SENDING' AND at>=clock_timestamp()-interval '90 seconds' THEN RAISE EXCEPTION 'PAPER_IMPORT_READING_BUSY' USING ERRCODE='40001'; END IF;
  END IF;
  r:=hon.paper_import_lock(p_set,NULL);
  IF r.status<>'OPEN' THEN RETURN hon.paper_import_detail(r); END IF;
  r:=hon.paper_import_lock(p_set,p_input->'expectedVersion');
  IF r.page_count<1 THEN RAISE EXCEPTION 'PAPER_IMPORT_NO_PAGES' USING ERRCODE='22023'; END IF;
  UPDATE hon.paper_import_sets SET version=version+1,status='READ',reading_id=coalesce(reading_id,gen_random_uuid()),
    reading_started_at=coalesce(reading_started_at,clock_timestamp()),reader='NONE',read_outcome='TYPED',read_at=clock_timestamp(),
    table_rows='[]'::jsonb,table_unsure='[]'::jsonb WHERE id=r.id RETURNING * INTO r;
  PERFORM hon.paper_import_finish(p_subject,actor,'read.type',r.id,NULL,p_request,p_correlation,'{}'::jsonb);
  RETURN hon.paper_import_detail(r);
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: deny first, then exactly the six new entry points for the runtime role.
-- ---------------------------------------------------------------------------------------------------------------
DO $$ DECLARE r text; f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY['hon.ai_plan_document_reading_guard()','hon.paper_reading_proposal_id(uuid)','hon.paper_import_detail(hon.paper_import_sets)',
    'hon.paper_import_note(uuid,text,uuid,uuid,uuid)','hon.paper_reading_ai_actor(text)',
    'hon.begin_paper_ai_reading(text,uuid,jsonb,uuid,uuid)','hon.paper_ai_reading_planning_reference(text,uuid)',
    'hon.prepare_paper_ai_reading(text,uuid,uuid,boolean)','hon.fail_paper_ai_reading(text,uuid,text,text)',
    'hon.record_paper_ai_reading(text,uuid,jsonb,uuid,uuid)','hon.type_paper_import_rows(text,uuid,jsonb,uuid,uuid)']::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r);
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.begin_paper_ai_reading(text,uuid,jsonb,uuid,uuid), hon.paper_ai_reading_planning_reference(text,uuid),
      hon.prepare_paper_ai_reading(text,uuid,uuid,boolean), hon.fail_paper_ai_reading(text,uuid,text,text),
      hon.record_paper_ai_reading(text,uuid,jsonb,uuid,uuid), hon.type_paper_import_rows(text,uuid,jsonb,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
