BEGIN;

-- Staff class-booking commands have a distinct authority boundary from session
-- administration and attendance recording. Existing and newly provisioned
-- system OWNER roles receive this permission (new owners inherit all current
-- permissions through the provisioning function).
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('schedule.booking.manage', 'Create staff class bookings and waitlist entries', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code = 'schedule.booking.manage'
WHERE role.code = 'OWNER' AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- The runtime needs only tenant-scoped reads (session, student, duplicate and
-- capacity checks) and booking inserts. Audit, outbox, and idempotency grants
-- are established by their owning migrations. Do not broaden this grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    -- Earlier scheduling grants included UPDATE for a broader future boundary.
    -- Booking creation never transitions a booking, so remove that surplus
    -- privilege for existing deployments as well as fresh runtime setup.
    REVOKE UPDATE, DELETE ON TABLE hon.class_bookings FROM hon_runtime;
    GRANT SELECT, INSERT ON TABLE hon.class_bookings TO hon_runtime;
    GRANT USAGE ON TYPE hon.class_booking_status TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
