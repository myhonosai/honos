BEGIN;
INSERT INTO hon.permissions (code, description, is_sensitive) VALUES
 ('program.manage','Create and maintain school programs',false),
 ('schedule.session.manage','Create and maintain class sessions',false),
 ('attendance.record','Record student attendance for a class session',false)
ON CONFLICT (code) DO NOTHING;
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT r.id,r.organization_id,p.code FROM hon.roles r JOIN hon.permissions p ON p.code IN ('program.manage','schedule.session.manage','attendance.record') WHERE r.code='OWNER' AND r.is_system_role=true ON CONFLICT(role_id,permission_code) DO NOTHING;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
 GRANT SELECT,INSERT,UPDATE ON TABLE hon.programs,hon.class_templates,hon.class_sessions,hon.class_session_instructors,hon.class_bookings,hon.attendance_records TO hon_runtime;
 GRANT USAGE ON TYPE hon.schedule_item_status,hon.class_booking_status,hon.attendance_status TO hon_runtime;
END IF; END $$;
COMMIT;
