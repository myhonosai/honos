BEGIN;

-- This is an aggregate-only school reporting authority. It grants no ability to
-- mutate operations, charge/refund, invoke a provider, or inspect raw people,
-- contact, invoice, payment, or attendance records through this endpoint.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('reporting.view', 'Read aggregate-only operational snapshots for an authorized school', true)
ON CONFLICT (code) DO NOTHING;

-- Existing system owners must be brought forward. Newly provisioned OWNER roles
-- already receive every extant permission in hon.provision_school_from_hq.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code = 'reporting.view'
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Reassert the canonical forced-RLS posture for every relation used by the
-- aggregate. These tables already have tenant policies; this protects upgraded
-- deployments whose earlier migrations predate the current verification suite.
ALTER TABLE hon.student_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.student_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_leads FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.class_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.class_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_records FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.payment_attempts FORCE ROW LEVEL SECURITY;

-- Existing reporting inputs already have their reviewed runtime rights. Invoices
-- and payment attempts are the only missing inputs: this read projection needs
-- SELECT and no mutation privilege on either. Do not broaden runtime access.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON TABLE hon.invoices, hon.payment_attempts FROM hon_runtime;
    IF NOT has_table_privilege('hon_runtime', 'hon.invoices', 'SELECT') THEN
      GRANT SELECT ON TABLE hon.invoices TO hon_runtime;
    END IF;
    IF NOT has_table_privilege('hon_runtime', 'hon.payment_attempts', 'SELECT') THEN
      GRANT SELECT ON TABLE hon.payment_attempts TO hon_runtime;
    END IF;
  END IF;
END;
$$;

COMMIT;
