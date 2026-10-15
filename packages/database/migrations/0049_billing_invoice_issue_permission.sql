BEGIN;

-- The original invoice lifecycle called the post-draft state OPEN. Issuance is
-- the precise domain event at this boundary, so retain the existing enum slot
-- while renaming it rather than introducing an additional, ambiguous state.
ALTER TYPE hon.invoice_status RENAME VALUE 'OPEN' TO 'ISSUED';
ALTER INDEX hon.invoice_open_scope_idx RENAME TO invoice_issued_scope_idx;

-- Invoice issuance is a sensitive, human-authorized state transition. The
-- permission existed in early reference data; this migration makes its secure
-- posture and operator-facing description explicit for every environment.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES (
  'billing.invoice.issue',
  'Issue a tenant-scoped DRAFT invoice without initiating payment or delivery',
  true
)
ON CONFLICT (code) DO UPDATE
SET description = EXCLUDED.description,
    is_sensitive = true;

-- Existing system owners receive the reviewed issuance capability. Newly
-- provisioned owners inherit all extant permissions through HQ provisioning.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission
  ON permission.code = 'billing.invoice.issue'
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Invoice drafting required SELECT/INSERT only. Issuance is the single reviewed
-- mutable invoice command, so UPDATE is now strictly required; DELETE, payment,
-- provider, communication, membership, and concession privileges remain absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.invoices FROM hon_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.invoices TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
