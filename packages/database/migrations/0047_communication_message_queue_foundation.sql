BEGIN;
-- Provider-neutral message queue foundation. This migration intentionally does
-- not create delivery, provider credentials, contact-data mutation, CRM lead,
-- AI, or action-engine behavior.
CREATE TYPE hon.communication_message_channel AS ENUM ('SMS', 'EMAIL', 'PUSH');
CREATE TYPE hon.communication_message_lifecycle AS ENUM ('DRAFT', 'QUEUED', 'CANCELLED');
REVOKE USAGE ON TYPE hon.communication_message_channel, hon.communication_message_lifecycle FROM PUBLIC;

CREATE TABLE hon.communication_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  recipient_person_id uuid NOT NULL,
  channel hon.communication_message_channel NOT NULL,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  lifecycle hon.communication_message_lifecycle NOT NULL DEFAULT 'DRAFT',
  scheduled_at timestamptz,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  queued_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (recipient_person_id, organization_id, school_id)
    REFERENCES hon.people(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  CHECK (
    (lifecycle = 'DRAFT' AND queued_by_principal_id IS NULL)
    OR (lifecycle IN ('QUEUED', 'CANCELLED'))
  )
);
CREATE INDEX communication_messages_scope_recipient_created_idx
  ON hon.communication_messages (organization_id, school_id, recipient_person_id, created_at DESC);
CREATE INDEX communication_messages_scope_lifecycle_schedule_idx
  ON hon.communication_messages (organization_id, school_id, lifecycle, scheduled_at, created_at);

ALTER TABLE hon.communication_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.communication_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY communication_messages_tenant_isolation ON hon.communication_messages
  USING (
    organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id()
  )
  WITH CHECK (
    organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id()
  );

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('communication.message.create', 'Create provider-neutral communication message drafts', true),
  ('communication.message.queue', 'Queue consent-gated communication message drafts', true),
  ('communication.message.read', 'Read tenant-scoped communication message queue records', true)
ON CONFLICT (code) DO NOTHING;
-- Existing system owners receive the new queue capabilities. Future owners
-- inherit them through hon.provision_school_from_hq.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission
  ON permission.code IN (
    'communication.message.create',
    'communication.message.queue',
    'communication.message.read'
  )
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Runtime has only the queue foundation's required data access. It has no
-- DELETE capability and this grant does not confer any external delivery role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.communication_messages FROM hon_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.communication_messages TO hon_runtime;
    GRANT USAGE ON TYPE
      hon.communication_message_channel,
      hon.communication_message_lifecycle
      TO hon_runtime;
  END IF;
END;
$$;
COMMIT;
