BEGIN;

-- PARENT_SAFE is an explicit publication audience. Define its narrowly named
-- authority now, but do not expose a parent endpoint in this staff-command
-- foundation; any future projection must resolve this permission independently.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('knowledge.parent.read', 'Read approved PARENT_SAFE school knowledge through an authorized parent projection', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code = 'knowledge.parent.read'
WHERE role.code = 'OWNER' AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

COMMIT;
