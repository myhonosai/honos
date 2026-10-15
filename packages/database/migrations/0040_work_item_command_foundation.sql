BEGIN;

-- Durable human-command fields are added to the existing action-engine work
-- item relation rather than introducing a parallel queue. Existing rows receive
-- a safe optimistic-concurrency baseline.
ALTER TABLE hon.work_items
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN error_reason text;

ALTER TABLE hon.work_items
  ADD CONSTRAINT work_items_version_positive CHECK (version >= 1),
  ADD CONSTRAINT work_items_work_type_valid CHECK (
    btrim(work_type) <> '' AND char_length(work_type) <= 100
  ),
  ADD CONSTRAINT work_items_subject_type_valid CHECK (
    subject_type IS NULL OR (btrim(subject_type) <> '' AND char_length(subject_type) <= 100)
  ),
  ADD CONSTRAINT work_items_payload_object_bounded CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 32768
  ),
  ADD CONSTRAINT work_items_result_object_bounded CHECK (
    result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 32768)
  ),
  ADD CONSTRAINT work_items_error_reason_bounded CHECK (
    error_reason IS NULL OR (btrim(error_reason) <> '' AND char_length(error_reason) <= 1000)
  );

CREATE INDEX work_items_scope_updated_idx
  ON hon.work_items (organization_id, school_id, updated_at DESC, id DESC);

-- Keep the RLS posture explicit in this durable command migration. The original
-- relation is already scoped; reasserting it protects deployments upgraded from
-- older action-engine foundations.
ALTER TABLE hon.work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.work_items FORCE ROW LEVEL SECURITY;

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('work_item.create', 'Create durable school-scoped work items', false),
  ('work_item.read', 'Read limited school-scoped work item summaries', false),
  ('work_item.manage', 'Human-manage durable work item state transitions', true)
ON CONFLICT (code) DO NOTHING;

-- Existing OWNER system roles receive the new authorities. New OWNER roles are
-- granted all current permissions by the tenant provisioning procedure.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission
  ON permission.code IN ('work_item.create', 'work_item.read', 'work_item.manage')
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- The runtime may operate only this work-item table and only through its
-- RLS-scoped transaction context. There is intentionally no DELETE privilege
-- and no grant on principals or any future executor/provider relation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.work_items TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
