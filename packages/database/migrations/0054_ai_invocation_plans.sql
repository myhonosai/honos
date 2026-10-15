BEGIN;

-- Immutable metadata-only decisions. No prompt, output, credentials, arbitrary
-- JSON, principal/authority grants, or execution lifecycle can be stored here.
CREATE TABLE hon.ai_invocation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  work_item_version integer NOT NULL CHECK (work_item_version >= 1),
  work_item_state text NOT NULL CHECK (work_item_state IN ('READY', 'THINKING')),
  agent_key text NOT NULL CHECK (agent_key IN ('alex','chad','maya','marcus','jordan','claire','lena','eian')),
  modality text NOT NULL CHECK (modality = 'TEXT'),
  task_class text NOT NULL CHECK (task_class IN ('SUMMARIZE','ANALYZE')),
  risk_class text NOT NULL CHECK ((task_class = 'SUMMARIZE' AND risk_class = 'LOW') OR (task_class = 'ANALYZE' AND risk_class = 'MODERATE')),
  input_budget integer NOT NULL CHECK (input_budget BETWEEN 1 AND 128000),
  output_budget integer NOT NULL CHECK (output_budget BETWEEN 1 AND 16000),
  max_provider_cost_microunits bigint NOT NULL CHECK (max_provider_cost_microunits BETWEEN 0 AND 1000000),
  estimated_provider_cost_microunits bigint NOT NULL CHECK (estimated_provider_cost_microunits BETWEEN 0 AND max_provider_cost_microunits),
  customer_credit_estimate integer NOT NULL CHECK (customer_credit_estimate = (input_budget + output_budget + 999) / 1000),
  provider_id text NOT NULL CHECK (provider_id IN ('OPENROUTER','DIRECT_LLM_API','HEYGEN','HIGGSFIELD')),
  model_id text NOT NULL CHECK (hon.hq_ai_safe_text(model_id, true)),
  catalog_id uuid NOT NULL,
  catalog_version integer NOT NULL CHECK (catalog_version >= 1),
  routing_policy_id uuid NOT NULL,
  routing_policy_version integer NOT NULL CHECK (routing_policy_version >= 1),
  provider_version integer NOT NULL CHECK (provider_version >= 1),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status = 'PLANNED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (work_item_id, organization_id, school_id)
    REFERENCES hon.work_items(id, organization_id, school_id) ON DELETE RESTRICT
);
-- Selected HQ IDs/versions are sanitized historical snapshots, not live config
-- projections. The only relational dependency is the composite durable item.
CREATE INDEX ai_invocation_plans_scope_work_idx
  ON hon.ai_invocation_plans (organization_id, school_id, work_item_id, created_at DESC, id DESC);
ALTER TABLE hon.ai_invocation_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_invocation_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_invocation_plans_read ON hon.ai_invocation_plans FOR SELECT
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
-- No INSERT/UPDATE/DELETE policy: only the reviewed fixed definer may append.
CREATE FUNCTION hon.reject_ai_invocation_plan_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $$ BEGIN RAISE EXCEPTION 'AI invocation plans are immutable' USING ERRCODE = '55000'; END $$;
REVOKE ALL ON FUNCTION hon.reject_ai_invocation_plan_mutation() FROM PUBLIC;
CREATE TRIGGER ai_invocation_plans_immutable BEFORE UPDATE OR DELETE ON hon.ai_invocation_plans
  FOR EACH ROW EXECUTE FUNCTION hon.reject_ai_invocation_plan_mutation();

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES ('ai.invocation.plan', 'Human-only metadata planning for durable AI work; never execution', true)
ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT id, organization_id, 'ai.invocation.plan' FROM hon.roles
WHERE code = 'OWNER' AND is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;
REVOKE ALL ON TABLE hon.ai_invocation_plans FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.ai_invocation_plans FROM hon_runtime;
    GRANT SELECT ON TABLE hon.ai_invocation_plans TO hon_runtime;
    REVOKE ALL ON FUNCTION hon.reject_ai_invocation_plan_mutation() FROM hon_runtime;
  END IF;
END $$;

COMMIT;
