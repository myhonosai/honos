BEGIN;

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('family.create', 'Create a family within an authorized school', false),
  ('family.read', 'View families within an authorized school', false),
  ('family.member.manage', 'Add a person to a family within an authorized school', false),
  ('student.profile.manage', 'Create or maintain student profile links within an authorized school', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code IN ('family.create', 'family.read', 'family.member.manage', 'student.profile.manage')
WHERE role.code = 'OWNER' AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.families, hon.family_members, hon.student_profiles TO hon_runtime;
    GRANT USAGE ON TYPE hon.family_member_role TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
