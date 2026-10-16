BEGIN;

-- Selection metadata only. Extend the reviewed HQ gateway; no second store,
-- provider execution, prompt, output, tool/authority or tenant selector exists.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'HQ resolver migrations require the reviewed privileged migration owner';
  END IF;
END $$;

CREATE FUNCTION hon.hq_ai_valid_list(p_value jsonb, p_allowed text[], p_min integer, p_max integer)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, hon
AS $$ SELECT CASE WHEN p_value IS NULL OR jsonb_typeof(p_value) <> 'array' THEN false ELSE
  jsonb_array_length(p_value) BETWEEN p_min AND p_max
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) x WHERE jsonb_typeof(x) <> 'string' OR (x #>> '{}') <> ALL(p_allowed))
  AND (SELECT count(DISTINCT x) FROM jsonb_array_elements(p_value) x) = jsonb_array_length(p_value) END;
$$;
REVOKE ALL ON FUNCTION hon.hq_ai_valid_list(jsonb,text[],integer,integer) FROM PUBLIC;

-- Old rows carry no privacy assertion. Future full writes MUST provide an exact,
-- closed, unique list; this is not a claim of vendor-side enforcement.
ALTER TABLE hon.hq_ai_model_catalog ADD COLUMN privacy_controls text[] NOT NULL DEFAULT '{}'
  CHECK (hon.hq_ai_valid_list(to_jsonb(privacy_controls), ARRAY['NO_TRAINING','ZERO_RETENTION'],0,2));
ALTER TABLE hon.hq_ai_control_audit DROP CONSTRAINT hq_ai_control_audit_kind_check;
ALTER TABLE hon.hq_ai_control_audit ADD CONSTRAINT hq_ai_control_audit_kind_check
  CHECK (kind IN ('PROVIDER','CATALOG','POLICY','TASK_PROFILE'));

CREATE TABLE hon.hq_ai_task_profiles (
  profile_id uuid PRIMARY KEY,
  routing_policy_id uuid NOT NULL REFERENCES hon.hq_ai_routing_policies(policy_id) ON DELETE RESTRICT,
  agent_key text NOT NULL CHECK (agent_key IN ('alex','chad','maya','marcus','jordan','claire','lena','eian')),
  task_category text NOT NULL CHECK (task_category IN ('GENERAL_ASSISTANT','MARCUS_MARKETING','CHAD_SALES','CLAIRE_TEACHING','RETENTION','COMMAND_CENTER','WORKFLOW_PLANNING','SIMPLE_CLASSIFICATION')),
  cost_unit text NOT NULL CHECK (cost_unit IN ('TOKEN','SECOND','IMAGE','VIDEO','REQUEST')),
  active boolean NOT NULL,
  max_cost_micros bigint NOT NULL CHECK (max_cost_micros BETWEEN 0 AND 9007199254740991),
  required_capabilities text[] NOT NULL CHECK (hon.hq_ai_valid_list(to_jsonb(required_capabilities),ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING','TOOL_EXECUTION'],1,7)),
  required_modalities text[] NOT NULL CHECK (hon.hq_ai_valid_list(to_jsonb(required_modalities),ARRAY['TEXT','VOICE_INPUT','VOICE_OUTPUT','IMAGE','VIDEO','EMBEDDING'],1,6)),
  allowed_provider_ids text[] NOT NULL CHECK (hon.hq_ai_valid_list(to_jsonb(allowed_provider_ids),ARRAY['OPENROUTER','DIRECT_LLM_API','HEYGEN','HIGGSFIELD'],1,4)),
  privacy_controls text[] NOT NULL CHECK (hon.hq_ai_valid_list(to_jsonb(privacy_controls),ARRAY['NO_TRAINING','ZERO_RETENTION'],0,2)),
  timeout_category text NOT NULL CHECK (timeout_category IN ('QUICK','STANDARD','EXTENDED')),
  retry_category text NOT NULL CHECK (retry_category IN ('NONE','TRANSIENT_ONCE')),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id,routing_policy_id),
  CHECK (isfinite(effective_from) AND (effective_until IS NULL OR (isfinite(effective_until) AND effective_until > effective_from)))
);
CREATE INDEX hq_ai_task_profiles_policy_idx ON hon.hq_ai_task_profiles(routing_policy_id);
CREATE TABLE hon.hq_ai_task_profile_candidates (
  profile_id uuid NOT NULL,
  routing_policy_id uuid NOT NULL,
  selection text NOT NULL CHECK (selection IN ('DEFAULT','FALLBACK','ADVANCED')),
  ordinal smallint NOT NULL CHECK ((selection IN ('DEFAULT','ADVANCED') AND ordinal=0) OR (selection='FALLBACK' AND ordinal BETWEEN 1 AND 7)),
  catalog_id uuid NOT NULL REFERENCES hon.hq_ai_model_catalog(catalog_id) ON DELETE RESTRICT,
  PRIMARY KEY (profile_id,selection,ordinal),
  UNIQUE (profile_id,catalog_id),
  FOREIGN KEY (profile_id,routing_policy_id) REFERENCES hon.hq_ai_task_profiles(profile_id,routing_policy_id) ON DELETE RESTRICT,
  -- Deferred only so an existing POLICY full rewrite can delete/reinsert its
  -- unchanged approved candidates. The write gateway explicitly denies removal.
  FOREIGN KEY (routing_policy_id,catalog_id) REFERENCES hon.hq_ai_routing_candidates(policy_id,catalog_id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE hon.hq_ai_task_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_task_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_task_profile_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_task_profile_candidates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE hon.hq_ai_task_profiles, hon.hq_ai_task_profile_candidates FROM PUBLIC;

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
    IF jsonb_typeof(p_data->'agentKey') <> 'string' OR p_data->>'agentKey' NOT IN ('alex','chad','maya','marcus','jordan','claire','lena','eian')
      OR jsonb_typeof(p_data->'taskCategory') <> 'string' OR p_data->>'taskCategory' NOT IN ('GENERAL_ASSISTANT','MARCUS_MARKETING','CHAD_SALES','CLAIRE_TEACHING','RETENTION','COMMAND_CENTER','WORKFLOW_PLANNING','SIMPLE_CLASSIFICATION')
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

CREATE FUNCTION hon.hq_ai_task_profile_snapshot(p_profile_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, hon
AS $$
  SELECT jsonb_build_object('profileId',p.profile_id,'routingPolicyId',p.routing_policy_id,'agentKey',p.agent_key,'taskCategory',p.task_category,'costUnit',p.cost_unit,'active',p.active,'maxCostMicros',p.max_cost_micros,
    'defaultCatalogId',(SELECT catalog_id FROM hon.hq_ai_task_profile_candidates c WHERE c.profile_id=p.profile_id AND selection='DEFAULT'),
    'fallbackCatalogIds',COALESCE((SELECT jsonb_agg(catalog_id ORDER BY ordinal) FROM hon.hq_ai_task_profile_candidates c WHERE c.profile_id=p.profile_id AND selection='FALLBACK'),'[]'::jsonb),
    'advancedCatalogId',(SELECT catalog_id FROM hon.hq_ai_task_profile_candidates c WHERE c.profile_id=p.profile_id AND selection='ADVANCED'),
    'requiredCapabilities',p.required_capabilities,'requiredModalities',p.required_modalities,'allowedProviderIds',p.allowed_provider_ids,'privacyControls',p.privacy_controls,'timeoutCategory',p.timeout_category,'retryCategory',p.retry_category,
    'effectiveFrom',to_char(p.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'effectiveUntil',CASE WHEN p.effective_until IS NULL THEN NULL ELSE to_char(p.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'version',p.version)
  FROM hon.hq_ai_task_profiles p WHERE p.profile_id=p_profile_id;
$$;
REVOKE ALL ON FUNCTION hon.hq_ai_task_profile_snapshot(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hon.hq_ai_snapshot()
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, hon
AS $$
  SELECT jsonb_build_object(
    'providers', COALESCE((SELECT jsonb_agg(jsonb_build_object('providerId', provider_id, 'displayName', display_name, 'state', state, 'credentialConfigured', credential_secret_ref IS NOT NULL, 'version', version) ORDER BY provider_id) FROM hon.hq_ai_provider_connections), '[]'::jsonb),
    'catalog', COALESCE((SELECT jsonb_agg(jsonb_build_object('catalogId', catalog_id, 'providerId', provider_id, 'modelId', model_id, 'displayName', display_name, 'capabilities', capabilities, 'modalities', modalities, 'privacyControls', privacy_controls, 'active', active, 'minimumTier', minimum_tier, 'unitCostMicros', unit_cost_micros, 'costUnit', cost_unit, 'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'effectiveUntil', CASE WHEN effective_until IS NULL THEN NULL ELSE to_char(effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END, 'version', version) ORDER BY catalog_id) FROM hon.hq_ai_model_catalog), '[]'::jsonb),
    'policies', COALESCE((SELECT jsonb_agg(jsonb_build_object('policyId', policy_id, 'organizationId', organization_id, 'schoolId', school_id, 'capability', capability, 'active', active, 'minimumTier', minimum_tier, 'maxCostMicros', max_cost_micros, 'allowDegraded', allow_degraded, 'catalogIds', (SELECT jsonb_agg(catalog_id ORDER BY ordinal) FROM hon.hq_ai_routing_candidates c WHERE c.policy_id = p.policy_id), 'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'effectiveUntil', CASE WHEN effective_until IS NULL THEN NULL ELSE to_char(effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END, 'version', version) ORDER BY policy_id) FROM hon.hq_ai_routing_policies p), '[]'::jsonb)
    , 'taskProfiles', COALESCE((SELECT jsonb_agg(hon.hq_ai_task_profile_snapshot(profile_id) ORDER BY profile_id) FROM hon.hq_ai_task_profiles),'[]'::jsonb)
  );
$$;
CREATE OR REPLACE FUNCTION hon.hq_ai_control_plane_read(p_external_subject text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.resolve_hq_operator_scope(p_external_subject, 'hq.ai.providers.read')) THEN
    RAISE EXCEPTION 'HQ AI configuration access denied' USING ERRCODE = '42501';
  END IF;
  RETURN hon.hq_ai_snapshot();
END $$;
CREATE OR REPLACE FUNCTION hon.hq_ai_control_plane_write(p_external_subject text, p_kind text, p_data jsonb, p_idempotency_key uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid; v_fingerprint text; v_prior_request hon.hq_ai_control_requests%ROWTYPE;
  v_id text; v_expected integer; v_version integer; v_prior jsonb; v_next jsonb;
  v_response jsonb; v_audit_id uuid; v_catalog_ids uuid[];
BEGIN
  SELECT principal_id INTO v_actor FROM hon.resolve_hq_operator_scope(p_external_subject, 'hq.ai.providers.manage');
  IF v_actor IS NULL THEN RAISE EXCEPTION 'HQ AI configuration mutation denied' USING ERRCODE = '42501'; END IF;
  IF p_idempotency_key IS NULL OR p_request_id IS NULL THEN RAISE EXCEPTION 'HQ AI idempotency and request IDs required' USING ERRCODE = '22023'; END IF;
  PERFORM hon.hq_ai_validate_write(p_kind, p_data);
  v_fingerprint := encode(sha256(convert_to(p_kind || ':' || p_data::text, 'UTF8')), 'hex');
  -- Low-volume global control plane: serialize mutations to preserve referential
  -- approval checks and idempotent replay even across concurrent connections.
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.hq.ai.control-plane', 0));
  -- A lock wait must not preserve an HQ grant revoked while this call waited.
  IF NOT EXISTS (SELECT 1 FROM hon.resolve_hq_operator_scope(p_external_subject, 'hq.ai.providers.manage') WHERE principal_id = v_actor) THEN
    RAISE EXCEPTION 'HQ AI configuration mutation denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_prior_request FROM hon.hq_ai_control_requests WHERE actor_principal_id = v_actor AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior_request.request_fingerprint <> v_fingerprint THEN RAISE EXCEPTION 'HQ AI idempotency conflict' USING ERRCODE = '23505'; END IF;
    RETURN v_prior_request.response_body || jsonb_build_object('replayed', true);
  END IF;
  v_expected := (p_data->>'expectedVersion')::integer;
  v_id := CASE p_kind WHEN 'PROVIDER' THEN p_data->>'providerId' WHEN 'CATALOG' THEN lower(p_data->>'catalogId') WHEN 'TASK_PROFILE' THEN lower(p_data->>'profileId') ELSE lower(p_data->>'policyId') END;
  IF p_kind = 'PROVIDER' THEN
    SELECT version, to_jsonb(p) - 'credential_secret_ref' || jsonb_build_object('credentialConfigured', credential_secret_ref IS NOT NULL) INTO v_version, v_prior FROM hon.hq_ai_provider_connections p WHERE provider_id = v_id;
  ELSIF p_kind = 'CATALOG' THEN
    SELECT version, to_jsonb(c) INTO v_version, v_prior FROM hon.hq_ai_model_catalog c WHERE catalog_id = v_id::uuid;
  ELSIF p_kind = 'TASK_PROFILE' THEN
    SELECT version, hon.hq_ai_task_profile_snapshot(profile_id) INTO v_version, v_prior FROM hon.hq_ai_task_profiles WHERE profile_id=v_id::uuid;
  ELSE
    SELECT version, to_jsonb(p) || jsonb_build_object('catalogIds', (SELECT jsonb_agg(catalog_id ORDER BY ordinal) FROM hon.hq_ai_routing_candidates c WHERE c.policy_id = p.policy_id)) INTO v_version, v_prior FROM hon.hq_ai_routing_policies p WHERE policy_id = v_id::uuid;
  END IF;
  IF COALESCE(v_version, 0) <> v_expected THEN RAISE EXCEPTION 'HQ AI version conflict' USING ERRCODE = '40001'; END IF;
  v_version := v_expected + 1;
  IF p_kind = 'PROVIDER' THEN
    INSERT INTO hon.hq_ai_provider_connections (provider_id, display_name, state, credential_secret_ref, version)
    VALUES (v_id, p_data->>'displayName', p_data->>'state', p_data->>'credentialSecretRef', v_version)
    ON CONFLICT (provider_id) DO UPDATE SET display_name = EXCLUDED.display_name, state = EXCLUDED.state, credential_secret_ref = EXCLUDED.credential_secret_ref, version = EXCLUDED.version, updated_at = now();
    SELECT to_jsonb(p) - 'credential_secret_ref' || jsonb_build_object('credentialConfigured', credential_secret_ref IS NOT NULL) INTO v_next FROM hon.hq_ai_provider_connections p WHERE provider_id = v_id;
  ELSIF p_kind = 'CATALOG' THEN
    IF v_prior IS NOT NULL AND (v_prior->>'provider_id' <> p_data->>'providerId' OR v_prior->>'model_id' <> p_data->>'modelId' OR v_prior->>'cost_unit' <> p_data->>'costUnit') THEN
      RAISE EXCEPTION 'Approved catalog identity and billable unit are immutable; register a new catalog ID' USING ERRCODE = '22023';
    END IF;
    INSERT INTO hon.hq_ai_model_catalog (catalog_id, provider_id, model_id, display_name, capabilities, modalities, privacy_controls, active, minimum_tier, unit_cost_micros, cost_unit, effective_from, effective_until, version)
    VALUES (v_id::uuid, p_data->>'providerId', p_data->>'modelId', p_data->>'displayName', ARRAY(SELECT jsonb_array_elements_text(p_data->'capabilities')), ARRAY(SELECT jsonb_array_elements_text(p_data->'modalities')), CASE WHEN p_data ? 'privacyControls' THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'privacyControls')) ELSE ARRAY[]::text[] END, (p_data->>'active')::boolean, (p_data->>'minimumTier')::hon.plan_tier, (p_data->>'unitCostMicros')::bigint, p_data->>'costUnit', (p_data->>'effectiveFrom')::timestamptz, (p_data->>'effectiveUntil')::timestamptz, v_version)
    ON CONFLICT (catalog_id) DO UPDATE SET display_name = EXCLUDED.display_name, capabilities = EXCLUDED.capabilities, modalities = EXCLUDED.modalities, privacy_controls = CASE WHEN p_data ? 'privacyControls' THEN EXCLUDED.privacy_controls ELSE hon.hq_ai_model_catalog.privacy_controls END, active = EXCLUDED.active, minimum_tier = EXCLUDED.minimum_tier, unit_cost_micros = EXCLUDED.unit_cost_micros, effective_from = EXCLUDED.effective_from, effective_until = EXCLUDED.effective_until, version = EXCLUDED.version, updated_at = now();
    SELECT to_jsonb(c) INTO v_next FROM hon.hq_ai_model_catalog c WHERE catalog_id = v_id::uuid;
  ELSIF p_kind = 'TASK_PROFILE' THEN
    IF v_prior IS NOT NULL AND ((v_prior->>'routingPolicyId')::uuid <> (p_data->>'routingPolicyId')::uuid OR v_prior->>'agentKey' <> p_data->>'agentKey' OR v_prior->>'taskCategory' <> p_data->>'taskCategory' OR v_prior->>'costUnit' <> p_data->>'costUnit') THEN
      RAISE EXCEPTION 'Approved task profile identity is immutable' USING ERRCODE='22023';
    END IF;
    v_catalog_ids := ARRAY(SELECT id::uuid FROM (
      SELECT p_data->>'defaultCatalogId' id UNION ALL SELECT jsonb_array_elements_text(p_data->'fallbackCatalogIds') UNION ALL SELECT p_data->>'advancedCatalogId' WHERE p_data->'advancedCatalogId' <> 'null'::jsonb
    ) ids);
    IF NOT EXISTS(SELECT 1 FROM hon.hq_ai_routing_policies p WHERE p.policy_id=(p_data->>'routingPolicyId')::uuid AND p_data->'requiredCapabilities' ? p.capability)
      OR EXISTS(SELECT 1 FROM unnest(v_catalog_ids) id WHERE NOT EXISTS(SELECT 1 FROM hon.hq_ai_routing_candidates c JOIN hon.hq_ai_model_catalog m ON m.catalog_id=c.catalog_id WHERE c.policy_id=(p_data->>'routingPolicyId')::uuid AND c.catalog_id=id AND m.cost_unit=p_data->>'costUnit')) THEN
      RAISE EXCEPTION 'Profile requires candidates already approved by its exact policy and billable unit' USING ERRCODE='22023';
    END IF;
    INSERT INTO hon.hq_ai_task_profiles(profile_id,routing_policy_id,agent_key,task_category,cost_unit,active,max_cost_micros,required_capabilities,required_modalities,allowed_provider_ids,privacy_controls,timeout_category,retry_category,effective_from,effective_until,version)
    VALUES(v_id::uuid,(p_data->>'routingPolicyId')::uuid,p_data->>'agentKey',p_data->>'taskCategory',p_data->>'costUnit',(p_data->>'active')::boolean,(p_data->>'maxCostMicros')::bigint,ARRAY(SELECT jsonb_array_elements_text(p_data->'requiredCapabilities')),ARRAY(SELECT jsonb_array_elements_text(p_data->'requiredModalities')),ARRAY(SELECT jsonb_array_elements_text(p_data->'allowedProviderIds')),ARRAY(SELECT jsonb_array_elements_text(p_data->'privacyControls')),p_data->>'timeoutCategory',p_data->>'retryCategory',(p_data->>'effectiveFrom')::timestamptz,(p_data->>'effectiveUntil')::timestamptz,v_version)
    ON CONFLICT(profile_id) DO UPDATE SET active=EXCLUDED.active,max_cost_micros=EXCLUDED.max_cost_micros,required_capabilities=EXCLUDED.required_capabilities,required_modalities=EXCLUDED.required_modalities,allowed_provider_ids=EXCLUDED.allowed_provider_ids,privacy_controls=EXCLUDED.privacy_controls,timeout_category=EXCLUDED.timeout_category,retry_category=EXCLUDED.retry_category,effective_from=EXCLUDED.effective_from,effective_until=EXCLUDED.effective_until,version=EXCLUDED.version,updated_at=now();
    DELETE FROM hon.hq_ai_task_profile_candidates WHERE profile_id=v_id::uuid;
    INSERT INTO hon.hq_ai_task_profile_candidates(profile_id,routing_policy_id,selection,ordinal,catalog_id)
    VALUES(v_id::uuid,(p_data->>'routingPolicyId')::uuid,'DEFAULT',0,(p_data->>'defaultCatalogId')::uuid);
    INSERT INTO hon.hq_ai_task_profile_candidates(profile_id,routing_policy_id,selection,ordinal,catalog_id)
    SELECT v_id::uuid,(p_data->>'routingPolicyId')::uuid,'FALLBACK',ordinality::smallint,value::uuid FROM jsonb_array_elements_text(p_data->'fallbackCatalogIds') WITH ORDINALITY;
    IF p_data->'advancedCatalogId' <> 'null'::jsonb THEN
      INSERT INTO hon.hq_ai_task_profile_candidates(profile_id,routing_policy_id,selection,ordinal,catalog_id)
      VALUES(v_id::uuid,(p_data->>'routingPolicyId')::uuid,'ADVANCED',0,(p_data->>'advancedCatalogId')::uuid);
    END IF;
    SELECT hon.hq_ai_task_profile_snapshot(v_id::uuid) INTO v_next;
  ELSE
    IF v_prior IS NOT NULL AND ((v_prior->>'organization_id')::uuid <> (p_data->>'organizationId')::uuid OR (v_prior->>'school_id')::uuid <> (p_data->>'schoolId')::uuid OR v_prior->>'capability' <> p_data->>'capability') THEN
      RAISE EXCEPTION 'Routing scope and capability are immutable' USING ERRCODE = '22023';
    END IF;
    v_catalog_ids := ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_data->'catalogIds'));
    IF EXISTS (SELECT 1 FROM unnest(v_catalog_ids) i WHERE NOT EXISTS (SELECT 1 FROM hon.hq_ai_model_catalog c WHERE c.catalog_id = i AND c.active AND p_data->>'capability' = ANY(c.capabilities))) THEN
      RAISE EXCEPTION 'Routing requires registered approved active catalog IDs with matching capability' USING ERRCODE = '22023';
    END IF;
    IF EXISTS(SELECT 1 FROM hon.hq_ai_task_profile_candidates c WHERE c.routing_policy_id=v_id::uuid AND NOT c.catalog_id=ANY(v_catalog_ids)) THEN
      RAISE EXCEPTION 'Policy catalog removal denied while referenced by a task profile' USING ERRCODE='22023';
    END IF;
    INSERT INTO hon.hq_ai_routing_policies (policy_id, organization_id, school_id, capability, active, minimum_tier, max_cost_micros, allow_degraded, effective_from, effective_until, version)
    VALUES (v_id::uuid, (p_data->>'organizationId')::uuid, (p_data->>'schoolId')::uuid, p_data->>'capability', (p_data->>'active')::boolean, (p_data->>'minimumTier')::hon.plan_tier, (p_data->>'maxCostMicros')::bigint, (p_data->>'allowDegraded')::boolean, (p_data->>'effectiveFrom')::timestamptz, (p_data->>'effectiveUntil')::timestamptz, v_version)
    ON CONFLICT (policy_id) DO UPDATE SET active = EXCLUDED.active, minimum_tier = EXCLUDED.minimum_tier, max_cost_micros = EXCLUDED.max_cost_micros, allow_degraded = EXCLUDED.allow_degraded, effective_from = EXCLUDED.effective_from, effective_until = EXCLUDED.effective_until, version = EXCLUDED.version, updated_at = now();
    DELETE FROM hon.hq_ai_routing_candidates WHERE policy_id = v_id::uuid;
    INSERT INTO hon.hq_ai_routing_candidates (policy_id, ordinal, catalog_id) SELECT v_id::uuid, (ordinality - 1)::smallint, value::uuid FROM jsonb_array_elements_text(p_data->'catalogIds') WITH ORDINALITY;
    SELECT to_jsonb(p) || jsonb_build_object('catalogIds', to_jsonb(v_catalog_ids)) INTO v_next FROM hon.hq_ai_routing_policies p WHERE policy_id = v_id::uuid;
  END IF;
  v_response := jsonb_build_object('recordId', v_id, 'version', v_version, 'replayed', false);
  INSERT INTO hon.hq_ai_control_audit (actor_principal_id, request_id, kind, record_id, prior_state, next_state) VALUES (v_actor, p_request_id, p_kind, v_id, v_prior, v_next) RETURNING id INTO v_audit_id;
  INSERT INTO hon.hq_ai_control_outbox (audit_id, event_type, request_id, payload) VALUES (v_audit_id, 'hq.ai.configuration.changed', p_request_id, jsonb_build_object('kind', p_kind, 'recordId', v_id, 'version', v_version));
  INSERT INTO hon.hq_ai_control_requests (actor_principal_id, idempotency_key, request_fingerprint, response_body) VALUES (v_actor, p_idempotency_key, v_fingerprint, v_response);
  RETURN v_response;
END $$;

-- HQ read-only resolver derives policy/scope/entitlement exclusively from the
-- registered profile. STABLE means one live statement snapshot; no writes.
CREATE FUNCTION hon.hq_ai_task_profile_registry(p_external_subject text,p_profile_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
DECLARE v_profile jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM hon.resolve_hq_operator_scope(p_external_subject,'hq.ai.providers.read')) THEN
    RAISE EXCEPTION 'HQ task profile preview denied' USING ERRCODE='42501';
  END IF;
  v_profile := hon.hq_ai_task_profile_snapshot(p_profile_id);
  IF v_profile IS NULL THEN RAISE EXCEPTION 'Registered task profile not found' USING ERRCODE='P0002'; END IF;
  RETURN hon.hq_ai_routing_registry(p_external_subject,(v_profile->>'routingPolicyId')::uuid) || jsonb_build_object('profile',v_profile);
END $$;
REVOKE ALL ON FUNCTION hon.hq_ai_task_profile_registry(text,uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION hon.hq_ai_validate_write(text,jsonb), hon.hq_ai_snapshot(),
  hon.hq_ai_control_plane_read(text), hon.hq_ai_control_plane_write(text,text,jsonb,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    REVOKE ALL ON TABLE hon.hq_ai_task_profiles,hon.hq_ai_task_profile_candidates FROM hon_runtime;
    REVOKE ALL ON FUNCTION hon.hq_ai_valid_list(jsonb,text[],integer,integer),hon.hq_ai_task_profile_snapshot(uuid),hon.hq_ai_snapshot(),hon.hq_ai_validate_write(text,jsonb) FROM hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.hq_ai_control_plane_read(text),hon.hq_ai_control_plane_write(text,text,jsonb,uuid,uuid),hon.hq_ai_task_profile_registry(text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
