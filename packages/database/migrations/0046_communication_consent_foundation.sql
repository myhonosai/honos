BEGIN;

-- Communication consent is a tenant-owned evidence record only. This foundation
-- intentionally does not create a delivery, provider, marketing, AI, or action
-- engine integration.
CREATE TYPE hon.communication_consent_channel AS ENUM ('SMS', 'EMAIL', 'PUSH');
CREATE TYPE hon.communication_consent_status AS ENUM ('OPTED_IN', 'OPTED_OUT');
CREATE TYPE hon.communication_consent_source AS ENUM ('STAFF', 'PARENT', 'IMPORT');
REVOKE USAGE ON TYPE hon.communication_consent_channel, hon.communication_consent_status, hon.communication_consent_source FROM PUBLIC;

CREATE TABLE hon.communication_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  person_id uuid NOT NULL,
  channel hon.communication_consent_channel NOT NULL,
  status hon.communication_consent_status NOT NULL,
  source hon.communication_consent_source NOT NULL,
  captured_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, organization_id, school_id)
    REFERENCES hon.people(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (person_id, channel),
  UNIQUE (id, organization_id, school_id)
);

CREATE INDEX communication_consents_scope_person_idx
  ON hon.communication_consents (organization_id, school_id, person_id, channel);
CREATE INDEX communication_consents_scope_updated_idx
  ON hon.communication_consents (organization_id, school_id, updated_at DESC);

ALTER TABLE hon.communication_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.communication_consents FORCE ROW LEVEL SECURITY;

CREATE POLICY communication_consents_tenant_isolation ON hon.communication_consents
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
  ('communication.consent.manage', 'Record tenant-scoped communication consent evidence', true),
  ('communication.consent.read', 'Read tenant-scoped communication consent evidence', true)
ON CONFLICT (code) DO NOTHING;

-- Existing system owners receive the newly introduced communication capabilities.
-- Future owners receive all permissions through hon.provision_school_from_hq.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission
  ON permission.code IN ('communication.consent.manage', 'communication.consent.read')
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Runtime services can read, create, and version-update consent evidence only.
-- They retain no DELETE authority and no capability for communication delivery.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.communication_consents FROM hon_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.communication_consents TO hon_runtime;
    GRANT USAGE ON TYPE
      hon.communication_consent_channel,
      hon.communication_consent_status,
      hon.communication_consent_source
      TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
