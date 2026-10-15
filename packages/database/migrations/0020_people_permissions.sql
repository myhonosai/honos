BEGIN;

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('people.create', 'Create a person/contact within an authorized school', false),
  ('people.read', 'View people/contacts within an authorized school', false)
ON CONFLICT (code) DO NOTHING;

-- System owners retain newly introduced in-scope operational permissions.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code IN ('people.create', 'people.read')
WHERE role.code = 'OWNER' AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

COMMIT;
