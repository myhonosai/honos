BEGIN;

-- Recording a trial outcome is a separate staff authority from scheduling. It
-- records only the appointment lifecycle result; it does not move the lead,
-- create a booking, enroll a student, mutate a family, or invoke AI/providers.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('crm.trial.manage', 'Record final outcomes for scheduled CRM trial appointments', true)
ON CONFLICT (code) DO NOTHING;

-- Bring existing system owners forward. Future OWNER roles receive all current
-- permissions through hon.provision_school_from_hq.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code = 'crm.trial.manage'
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Reassert the canonical tenant boundary for deployments upgraded from prior
-- CRM scheduling migrations before granting the dedicated lifecycle command.
ALTER TABLE hon.crm_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_appointments FORCE ROW LEVEL SECURITY;

-- The runtime command needs exactly scoped lookup, schedule insert, and
-- outcome update access. It receives neither DELETE nor rights to any lead,
-- booking, people, family, enrollment, membership, provider, message, or AI
-- relation. Revoke first so a drifted deployment is restored to this minimum.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.crm_appointments FROM hon_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.crm_appointments TO hon_runtime;
    GRANT USAGE ON TYPE hon.crm_appointment_type, hon.crm_appointment_status TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
