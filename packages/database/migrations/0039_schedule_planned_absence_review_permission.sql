BEGIN;

-- Planned-absence review is a separate staff authority from parent submission,
-- attendance recording, booking, and all downstream operational workflows.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('schedule.planned_absence.review', 'Review submitted planned absence requests', false)
ON CONFLICT (code) DO NOTHING;

-- Existing system owners receive the new authority. Newly provisioned OWNER
-- roles already receive all current permissions in hon.provision_school_from_hq.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code = 'schedule.planned_absence.review'
WHERE role.code = 'OWNER' AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Migration 0038 intentionally limited this table to parent submission. The
-- reviewed command now needs the single additional RLS-bound UPDATE privilege;
-- do not grant DELETE or broaden any unrelated operational table privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT UPDATE ON TABLE hon.planned_absence_requests TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
