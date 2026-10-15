BEGIN;

CREATE TYPE hon.ai_modality AS ENUM ('TEXT', 'VOICE_INPUT', 'VOICE_OUTPUT', 'IMAGE', 'VIDEO', 'EMBEDDING', 'TOOL_EXECUTION');

CREATE TABLE hon.ai_usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  initiator_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  agent_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  work_item_id uuid,
  action_request_id uuid,
  provider_code text NOT NULL,
  model_code text NOT NULL,
  modality hon.ai_modality NOT NULL,
  input_units bigint NOT NULL DEFAULT 0 CHECK (input_units >= 0),
  output_units bigint NOT NULL DEFAULT 0 CHECK (output_units >= 0),
  provider_cost_microunits bigint NOT NULL DEFAULT 0 CHECK (provider_cost_microunits >= 0),
  customer_credits bigint NOT NULL DEFAULT 0 CHECK (customer_credits >= 0),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id, organization_id, school_id) REFERENCES hon.work_items(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (action_request_id, organization_id, school_id) REFERENCES hon.action_requests(id, organization_id, school_id) ON DELETE RESTRICT
);

CREATE INDEX ai_usage_ledger_scope_time_idx ON hon.ai_usage_ledger (organization_id, school_id, occurred_at DESC);
CREATE INDEX ai_usage_ledger_agent_time_idx ON hon.ai_usage_ledger (agent_principal_id, occurred_at DESC) WHERE agent_principal_id IS NOT NULL;

ALTER TABLE hon.ai_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_usage_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_usage_ledger_tenant_isolation ON hon.ai_usage_ledger
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

COMMIT;
