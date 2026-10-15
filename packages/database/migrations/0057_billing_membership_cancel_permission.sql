BEGIN;

-- A cancellation is a sensitive, human-authorized ACTIVE-to-CANCELLED lifecycle
-- transition. It records only the membership decision and its evidence; it does
-- not authorize a charge, refund, credit, waiver, proration, schedule change,
-- invoice change, provider call, attendance/booking mutation, communication,
-- delegation, or AI work.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES (
  'billing.membership.cancel',
  'Cancel an ACTIVE tenant-scoped membership without payment, provider, schedule, invoice, attendance, booking, communication, delegation, or AI effects',
  true
)
ON CONFLICT (code) DO UPDATE
SET description = EXCLUDED.description,
    is_sensitive = true;

-- Existing system owners receive this reviewed, sensitive capability. Newly
-- provisioned OWNER roles inherit extant permissions through HQ provisioning.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission
  ON permission.code = 'billing.membership.cancel'
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Cancellation uses the same single, RLS-bound membership UPDATE privilege that
-- migration 0050 granted for the reviewed activation transition. No additional
-- runtime privilege is required or granted by this migration.
-- Reassert the operational relation's canonical forced-RLS posture for upgraded
-- deployments; its existing tenant policy remains the sole data-plane scope.
ALTER TABLE hon.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.memberships FORCE ROW LEVEL SECURITY;

COMMIT;
