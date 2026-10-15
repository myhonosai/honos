BEGIN;

-- This is a read-only finance/economics authority. It neither enables model
-- execution nor conveys any ability to write, charge, reset, or block usage.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('ai.usage.read', 'Read aggregated school-scoped AI usage economics', true)
ON CONFLICT (code) DO NOTHING;

-- Existing system owners must be brought forward. Newly provisioned OWNER roles
-- receive all extant permissions in hon.provision_school_from_hq.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code = 'ai.usage.read'
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Reassert the ledger's canonical scoped-RLS posture for upgraded deployments.
ALTER TABLE hon.ai_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_usage_ledger FORCE ROW LEVEL SECURITY;

-- The runtime projection is deliberately a SELECT-only consumer of this ledger.
-- Do not grant access to any provider/request data relation; this table has no
-- raw payload columns and the endpoint selects aggregate projections only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON TABLE hon.ai_usage_ledger FROM hon_runtime;
    IF NOT has_table_privilege('hon_runtime', 'hon.ai_usage_ledger', 'SELECT') THEN
      GRANT SELECT ON TABLE hon.ai_usage_ledger TO hon_runtime;
    END IF;
  END IF;
END;
$$;

COMMIT;
