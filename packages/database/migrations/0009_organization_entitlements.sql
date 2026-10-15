BEGIN;

CREATE TYPE hon.plan_tier AS ENUM ('ESSENTIAL', 'CORE', 'COMPLETE');

CREATE TABLE hon.organization_entitlements (
  organization_id uuid PRIMARY KEY REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  tier hon.plan_tier NOT NULL,
  status hon.membership_status NOT NULL DEFAULT 'ACTIVE',
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

ALTER TABLE hon.organization_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.organization_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_entitlements_tenant_isolation ON hon.organization_entitlements
  USING (organization_id = hon.current_organization_id())
  WITH CHECK (organization_id = hon.current_organization_id());

COMMIT;
