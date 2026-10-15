BEGIN;

-- Draft creation is deliberately distinct from issuing, charging, or any
-- provider/payment authority. The existing invoice relation is unchanged.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES (
  'billing.invoice.create',
  'Create a tenant-scoped DRAFT invoice without issuing it or initiating payment',
  true
)
ON CONFLICT (code) DO NOTHING;

-- Bring existing system owners forward; newly provisioned owners inherit all
-- extant permissions through the HQ provisioning procedure.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission
  ON permission.code = 'billing.invoice.create'
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- The invoice draft command only reads and inserts invoices. Existing grants
-- already supply tenant-scoped reads of billing accounts/memberships and the
-- append-only audit/outbox/idempotency writes. No update/delete/payment grant
-- is needed or allowed here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.invoices FROM hon_runtime;
    GRANT SELECT, INSERT ON TABLE hon.invoices TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
