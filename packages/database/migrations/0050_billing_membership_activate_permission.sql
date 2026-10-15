BEGIN;

-- Membership activation is a sensitive, human-authorized DRAFT-to-ACTIVE
-- lifecycle transition. It is intentionally distinct from invoice issuance,
-- payment initiation, or any provider authority.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES (
  'billing.membership.activate',
  'Activate a tenant-scoped DRAFT membership without issuing an invoice, charging, or initiating payment',
  true
)
ON CONFLICT (code) DO UPDATE
SET description = EXCLUDED.description,
    is_sensitive = true;

-- Existing system owners receive the reviewed activation capability. Newly
-- provisioned owners inherit all extant permissions through HQ provisioning.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission
  ON permission.code = 'billing.membership.activate'
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Membership draft creation already has SELECT/INSERT. Activation needs only
-- UPDATE on the same RLS-protected relation; no payment, invoice, provider,
-- schedule, concession, attendance, booking, communication, or AI grant is
-- added here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT UPDATE ON TABLE hon.memberships TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
