BEGIN;

-- Organization metadata is tenant-owned. The runtime role must not be able to
-- enumerate organizations merely because the school-scoped tables are protected.
ALTER TABLE hon.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_isolation ON hon.organizations
  USING (id = hon.current_organization_id())
  WITH CHECK (id = hon.current_organization_id());

COMMIT;