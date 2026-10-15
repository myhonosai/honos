BEGIN;

-- Fail closed unless the existing trusted HQ definer owner can read forced-RLS
-- global identity/config. Do not add BYPASSRLS or membership to hon_runtime.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'HQ resolver migrations require the reviewed privileged migration owner';
  END IF;
END $$;

CREATE FUNCTION hon.hq_ai_validate_write(p_kind text, p_data jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_keys text[];
  v_field text;
  v_allowed text[];
BEGIN
  v_keys := CASE p_kind
    WHEN 'PROVIDER' THEN ARRAY['providerId','displayName','state','credentialSecretRef','expectedVersion']
    WHEN 'CATALOG' THEN ARRAY['catalogId','providerId','modelId','displayName','capabilities','modalities','active','minimumTier','unitCostMicros','costUnit','effectiveFrom','effectiveUntil','expectedVersion']
    WHEN 'POLICY' THEN ARRAY['policyId','organizationId','schoolId','capability','active','minimumTier','maxCostMicros','allowDegraded','catalogIds','effectiveFrom','effectiveUntil','expectedVersion']
    ELSE NULL END;
  IF v_keys IS NULL OR p_data IS NULL OR jsonb_typeof(p_data) <> 'object'
    OR NOT p_data ?& v_keys OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k <> ALL(v_keys)) THEN
    RAISE EXCEPTION 'Invalid HQ AI configuration shape' USING ERRCODE = '22023';
  END IF;
  FOREACH v_field IN ARRAY CASE p_kind WHEN 'CATALOG' THEN ARRAY['expectedVersion','unitCostMicros'] WHEN 'POLICY' THEN ARRAY['expectedVersion','maxCostMicros'] ELSE ARRAY['expectedVersion'] END LOOP
    IF jsonb_typeof(p_data->v_field) <> 'number' OR (p_data->>v_field) !~ '^[0-9]+$'
      OR (p_data->>v_field)::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'Invalid HQ AI integer' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (p_data->>'expectedVersion')::numeric > 2147483646 THEN
    RAISE EXCEPTION 'Invalid HQ AI version' USING ERRCODE = '22023';
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
REVOKE ALL ON FUNCTION hon.hq_ai_validate_write(text, jsonb) FROM PUBLIC;

-- Internal redacted projection. INVOKER and not executable by runtime/PUBLIC.
CREATE FUNCTION hon.hq_ai_snapshot()
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, hon
AS $$
  SELECT jsonb_build_object(
    'providers', COALESCE((SELECT jsonb_agg(jsonb_build_object('providerId', provider_id, 'displayName', display_name, 'state', state, 'credentialConfigured', credential_secret_ref IS NOT NULL, 'version', version) ORDER BY provider_id) FROM hon.hq_ai_provider_connections), '[]'::jsonb),
    'catalog', COALESCE((SELECT jsonb_agg(jsonb_build_object('catalogId', catalog_id, 'providerId', provider_id, 'modelId', model_id, 'displayName', display_name, 'capabilities', capabilities, 'modalities', modalities, 'active', active, 'minimumTier', minimum_tier, 'unitCostMicros', unit_cost_micros, 'costUnit', cost_unit, 'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'effectiveUntil', CASE WHEN effective_until IS NULL THEN NULL ELSE to_char(effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END, 'version', version) ORDER BY catalog_id) FROM hon.hq_ai_model_catalog), '[]'::jsonb),
    'policies', COALESCE((SELECT jsonb_agg(jsonb_build_object('policyId', policy_id, 'organizationId', organization_id, 'schoolId', school_id, 'capability', capability, 'active', active, 'minimumTier', minimum_tier, 'maxCostMicros', max_cost_micros, 'allowDegraded', allow_degraded, 'catalogIds', (SELECT jsonb_agg(catalog_id ORDER BY ordinal) FROM hon.hq_ai_routing_candidates c WHERE c.policy_id = p.policy_id), 'effectiveFrom', to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'effectiveUntil', CASE WHEN effective_until IS NULL THEN NULL ELSE to_char(effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END, 'version', version) ORDER BY policy_id) FROM hon.hq_ai_routing_policies p), '[]'::jsonb)
  );
$$;
REVOKE ALL ON FUNCTION hon.hq_ai_snapshot() FROM PUBLIC;

CREATE FUNCTION hon.hq_ai_control_plane_read(p_external_subject text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.resolve_hq_operator_scope(p_external_subject, 'hq.ai.providers.read')) THEN
    RAISE EXCEPTION 'HQ AI configuration access denied' USING ERRCODE = '42501';
  END IF;
  RETURN hon.hq_ai_snapshot();
END $$;
REVOKE ALL ON FUNCTION hon.hq_ai_control_plane_read(text) FROM PUBLIC;

CREATE FUNCTION hon.hq_ai_control_plane_write(p_external_subject text, p_kind text, p_data jsonb, p_idempotency_key uuid, p_request_id uuid)
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
  SELECT * INTO v_prior_request FROM hon.hq_ai_control_requests WHERE actor_principal_id = v_actor AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prior_request.request_fingerprint <> v_fingerprint THEN RAISE EXCEPTION 'HQ AI idempotency conflict' USING ERRCODE = '23505'; END IF;
    RETURN v_prior_request.response_body || jsonb_build_object('replayed', true);
  END IF;
  v_expected := (p_data->>'expectedVersion')::integer;
  v_id := CASE p_kind WHEN 'PROVIDER' THEN p_data->>'providerId' WHEN 'CATALOG' THEN lower(p_data->>'catalogId') ELSE lower(p_data->>'policyId') END;
  IF p_kind = 'PROVIDER' THEN
    SELECT version, to_jsonb(p) - 'credential_secret_ref' || jsonb_build_object('credentialConfigured', credential_secret_ref IS NOT NULL) INTO v_version, v_prior FROM hon.hq_ai_provider_connections p WHERE provider_id = v_id;
  ELSIF p_kind = 'CATALOG' THEN
    SELECT version, to_jsonb(c) INTO v_version, v_prior FROM hon.hq_ai_model_catalog c WHERE catalog_id = v_id::uuid;
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
    INSERT INTO hon.hq_ai_model_catalog (catalog_id, provider_id, model_id, display_name, capabilities, modalities, active, minimum_tier, unit_cost_micros, cost_unit, effective_from, effective_until, version)
    VALUES (v_id::uuid, p_data->>'providerId', p_data->>'modelId', p_data->>'displayName', ARRAY(SELECT jsonb_array_elements_text(p_data->'capabilities')), ARRAY(SELECT jsonb_array_elements_text(p_data->'modalities')), (p_data->>'active')::boolean, (p_data->>'minimumTier')::hon.plan_tier, (p_data->>'unitCostMicros')::bigint, p_data->>'costUnit', (p_data->>'effectiveFrom')::timestamptz, (p_data->>'effectiveUntil')::timestamptz, v_version)
    ON CONFLICT (catalog_id) DO UPDATE SET display_name = EXCLUDED.display_name, capabilities = EXCLUDED.capabilities, modalities = EXCLUDED.modalities, active = EXCLUDED.active, minimum_tier = EXCLUDED.minimum_tier, unit_cost_micros = EXCLUDED.unit_cost_micros, effective_from = EXCLUDED.effective_from, effective_until = EXCLUDED.effective_until, version = EXCLUDED.version, updated_at = now();
    SELECT to_jsonb(c) INTO v_next FROM hon.hq_ai_model_catalog c WHERE catalog_id = v_id::uuid;
  ELSE
    IF v_prior IS NOT NULL AND ((v_prior->>'organization_id')::uuid <> (p_data->>'organizationId')::uuid OR (v_prior->>'school_id')::uuid <> (p_data->>'schoolId')::uuid OR v_prior->>'capability' <> p_data->>'capability') THEN
      RAISE EXCEPTION 'Routing scope and capability are immutable' USING ERRCODE = '22023';
    END IF;
    v_catalog_ids := ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_data->'catalogIds'));
    IF EXISTS (SELECT 1 FROM unnest(v_catalog_ids) i WHERE NOT EXISTS (SELECT 1 FROM hon.hq_ai_model_catalog c WHERE c.catalog_id = i AND c.active AND p_data->>'capability' = ANY(c.capabilities))) THEN
      RAISE EXCEPTION 'Routing requires registered approved active catalog IDs with matching capability' USING ERRCODE = '22023';
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
REVOKE ALL ON FUNCTION hon.hq_ai_control_plane_write(text, text, jsonb, uuid, uuid) FROM PUBLIC;

-- HQ-only preview input resolver: exact registered policy plus live server
-- entitlement. No caller tier, credential ref, provider URL, or authority.
CREATE FUNCTION hon.hq_ai_routing_registry(p_external_subject text, p_policy_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon
AS $$
DECLARE v_snapshot jsonb; v_policy jsonb; v_tier hon.plan_tier; v_entitled boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hon.resolve_hq_operator_scope(p_external_subject, 'hq.ai.providers.read')) THEN RAISE EXCEPTION 'HQ AI routing preview denied' USING ERRCODE = '42501'; END IF;
  v_snapshot := hon.hq_ai_snapshot();
  SELECT value INTO v_policy FROM jsonb_array_elements(v_snapshot->'policies') WHERE (value->>'policyId')::uuid = p_policy_id;
  IF v_policy IS NULL THEN RAISE EXCEPTION 'Registered routing policy not found' USING ERRCODE = 'P0002'; END IF;
  SELECT tier, status = 'ACTIVE' AND effective_from <= now() AND (effective_until IS NULL OR now() < effective_until) INTO v_tier, v_entitled FROM hon.organization_entitlements WHERE organization_id = (v_policy->>'organizationId')::uuid;
  RETURN jsonb_build_object('tenant', jsonb_build_object('organizationId', v_policy->>'organizationId', 'schoolId', v_policy->>'schoolId', 'tier', COALESCE(v_tier, 'ESSENTIAL'::hon.plan_tier), 'entitlementActive', COALESCE(v_entitled, false)), 'asOf', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'providers', v_snapshot->'providers', 'catalog', v_snapshot->'catalog', 'policies', jsonb_build_array(v_policy));
END $$;
REVOKE ALL ON FUNCTION hon.hq_ai_routing_registry(text, uuid) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.hq_ai_control_plane_read(text), hon.hq_ai_control_plane_write(text, text, jsonb, uuid, uuid), hon.hq_ai_routing_registry(text, uuid) TO hon_runtime;
    REVOKE ALL ON FUNCTION hon.hq_ai_snapshot(), hon.hq_ai_validate_write(text, jsonb), hon.hq_ai_safe_text(text, boolean) FROM hon_runtime;
  END IF;
END $$;

COMMIT;
