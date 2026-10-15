BEGIN;

-- Configuration only. No endpoints, raw credentials, tool grants, Action
-- Engine policy, tenant DML, or provider execution is representable here.
CREATE FUNCTION hon.hq_ai_safe_text(p_value text, p_model boolean DEFAULT false)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$
  SELECT p_value IS NOT NULL
    AND CASE WHEN p_model THEN p_value ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
      ELSE p_value ~ '^[A-Za-z0-9][A-Za-z0-9 .,''()-]{0,79}$' END
    AND p_value !~* '(sk[-_]|pk[-_]|gh[pousr]_|xox[baprs]-|AKIA|AIza|eyJ|bearer|api[ _-]?key|access[ _-]?token|password|passwd|jwt|private[ _-]?key|-----BEGIN|https?:|[A-Za-z0-9_+/-]{32,})';
$$;
REVOKE ALL ON FUNCTION hon.hq_ai_safe_text(text, boolean) FROM PUBLIC;

CREATE TABLE hon.hq_ai_provider_connections (
  provider_id text PRIMARY KEY CHECK (provider_id IN ('OPENROUTER', 'DIRECT_LLM_API', 'HEYGEN', 'HIGGSFIELD')),
  display_name text NOT NULL CHECK (hon.hq_ai_safe_text(display_name)),
  state text NOT NULL CHECK (state IN ('DISABLED', 'CONFIGURED', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE')),
  credential_secret_ref text CHECK (credential_secret_ref ~ '^hon-secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state = 'DISABLED' OR credential_secret_ref IS NOT NULL)
);

CREATE TABLE hon.hq_ai_model_catalog (
  catalog_id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES hon.hq_ai_provider_connections(provider_id) ON DELETE RESTRICT,
  model_id text NOT NULL CHECK (hon.hq_ai_safe_text(model_id, true)),
  display_name text NOT NULL CHECK (hon.hq_ai_safe_text(display_name)),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) BETWEEN 1 AND 7 AND capabilities <@ ARRAY['TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING', 'TOOL_EXECUTION']::text[] AND array_position(capabilities, NULL) IS NULL),
  modalities text[] NOT NULL CHECK (cardinality(modalities) BETWEEN 1 AND 6 AND modalities <@ ARRAY['TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING']::text[] AND array_position(modalities, NULL) IS NULL),
  active boolean NOT NULL,
  minimum_tier hon.plan_tier NOT NULL,
  unit_cost_micros bigint NOT NULL CHECK (unit_cost_micros BETWEEN 0 AND 9007199254740991),
  cost_unit text NOT NULL CHECK (cost_unit IN ('TOKEN', 'SECOND', 'IMAGE', 'VIDEO', 'REQUEST')),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (isfinite(effective_from) AND (effective_until IS NULL OR (isfinite(effective_until) AND effective_until > effective_from)))
);

CREATE TABLE hon.hq_ai_routing_policies (
  policy_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability IN ('TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING', 'TOOL_EXECUTION')),
  active boolean NOT NULL,
  minimum_tier hon.plan_tier NOT NULL,
  max_cost_micros bigint NOT NULL CHECK (max_cost_micros BETWEEN 0 AND 9007199254740991),
  allow_degraded boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CHECK (isfinite(effective_from) AND (effective_until IS NULL OR (isfinite(effective_until) AND effective_until > effective_from)))
);
-- Normalized, referentially constrained fallback order. An arbitrary model ID
-- can never stand in for an approved catalog UUID.
CREATE TABLE hon.hq_ai_routing_candidates (
  policy_id uuid NOT NULL REFERENCES hon.hq_ai_routing_policies(policy_id) ON DELETE RESTRICT,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  catalog_id uuid NOT NULL REFERENCES hon.hq_ai_model_catalog(catalog_id) ON DELETE RESTRICT,
  PRIMARY KEY (policy_id, ordinal),
  UNIQUE (policy_id, catalog_id)
);
CREATE INDEX hq_ai_routing_policies_scope_idx ON hon.hq_ai_routing_policies (organization_id, school_id);

CREATE TABLE hon.hq_ai_control_requests (
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_principal_id, idempotency_key)
);
-- Global HQ evidence must NOT be appended to school-visible audit/outbox.
-- Append-only through the fixed write function; no delivery worker is added.
CREATE TABLE hon.hq_ai_control_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PROVIDER', 'CATALOG', 'POLICY')),
  record_id text NOT NULL,
  prior_state jsonb,
  next_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hon.hq_ai_control_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL UNIQUE REFERENCES hon.hq_ai_control_audit(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type = 'hq.ai.configuration.changed'),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  request_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- No tenant-context or self-set GUC can authorize HQ configuration access.
-- Forced RLS with no policies is deny-all; reviewed SECURITY DEFINER functions
-- use the same privileged migration-owner boundary as the HQ scope resolver.
ALTER TABLE hon.hq_ai_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_provider_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_model_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_model_catalog FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_routing_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_routing_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_routing_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_control_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_control_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_control_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_control_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_control_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_ai_control_outbox FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE hon.hq_ai_provider_connections, hon.hq_ai_model_catalog,
  hon.hq_ai_routing_policies, hon.hq_ai_routing_candidates, hon.hq_ai_control_requests,
  hon.hq_ai_control_audit, hon.hq_ai_control_outbox FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.hq_ai_provider_connections, hon.hq_ai_model_catalog,
      hon.hq_ai_routing_policies, hon.hq_ai_routing_candidates, hon.hq_ai_control_requests,
      hon.hq_ai_control_audit, hon.hq_ai_control_outbox FROM hon_runtime;
  END IF;
END $$;

COMMIT;
