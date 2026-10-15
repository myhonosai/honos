BEGIN;

CREATE TYPE hon.action_request_status AS ENUM ('RECEIVED', 'VALIDATING', 'AWAITING_APPROVAL', 'APPROVED', 'DENIED', 'EXPIRED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'RECONCILING');
CREATE TYPE hon.approval_decision AS ENUM ('APPROVED', 'DENIED', 'EXPIRED');
CREATE TYPE hon.authority_mode AS ENUM ('AUTO', 'CONFIRM', 'RESTRICTED');

CREATE TABLE hon.action_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  action_code text NOT NULL,
  authority_mode hon.authority_mode NOT NULL,
  policy_version integer NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, school_id, action_code, policy_version)
);

CREATE TABLE hon.action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  delegated_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  action_code text NOT NULL,
  normalized_payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  required_permission text NOT NULL REFERENCES hon.permissions(code) ON DELETE RESTRICT,
  effective_authority_mode hon.authority_mode NOT NULL,
  policy_version integer NOT NULL,
  status hon.action_request_status NOT NULL DEFAULT 'RECEIVED',
  approval_expires_at timestamptz,
  provider_idempotency_reference text,
  verified_result jsonb,
  failure_details jsonb,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, school_id, requested_by_principal_id, idempotency_key)
);

CREATE TABLE hon.action_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  action_request_id uuid NOT NULL REFERENCES hon.action_requests(id) ON DELETE RESTRICT,
  reviewer_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  decision hon.approval_decision NOT NULL,
  reviewed_payload_hash text NOT NULL,
  reviewed_policy_version integer NOT NULL,
  reason text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (action_request_id, reviewer_principal_id)
);

CREATE TABLE hon.work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  work_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('READY', 'THINKING', 'WORKING', 'WAITING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'NEEDS_ATTENTION', 'FAILED')),
  assigned_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  parent_work_item_id uuid REFERENCES hon.work_items(id) ON DELETE RESTRICT,
  subject_type text,
  subject_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX action_requests_execution_idx ON hon.action_requests (status, created_at) WHERE status IN ('APPROVED', 'EXECUTING', 'UNKNOWN', 'RECONCILING');
CREATE INDEX work_items_active_idx ON hon.work_items (organization_id, school_id, status, updated_at DESC) WHERE status NOT IN ('COMPLETED', 'FAILED');

ALTER TABLE hon.action_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.action_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.work_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY action_policies_tenant_isolation ON hon.action_policies USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY action_requests_tenant_isolation ON hon.action_requests USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY action_approvals_tenant_isolation ON hon.action_approvals USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY work_items_tenant_isolation ON hon.work_items USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

COMMIT;