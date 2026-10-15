BEGIN;

-- Complete-tier AI Team customization persists presentation only. The fixed
-- catalog remains application configuration; this table cannot represent a
-- principal, an agent creation request, authority, tools, models, providers,
-- payment behavior, audit behavior, or role grants.
CREATE TABLE hon.ai_team_presentation_preferences (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  agent_key text NOT NULL CHECK (agent_key IN (
    'alex', 'chad', 'maya', 'marcus', 'jordan', 'claire', 'lena', 'eian'
  )),
  display_name text,
  avatar_key text,
  voice_profile text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, school_id, agent_key),
  UNIQUE (id),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  CHECK (
    display_name IS NULL
    OR (char_length(display_name) BETWEEN 1 AND 80
        AND display_name ~ '^[A-Za-z0-9][A-Za-z0-9 .,''-]{0,79}$')
  ),
  CHECK (avatar_key IS NULL OR avatar_key IN (
    'hon-agent-alex', 'hon-agent-chad', 'hon-agent-maya', 'hon-agent-marcus',
    'hon-agent-jordan', 'hon-agent-claire', 'hon-agent-lena', 'hon-agent-eian',
    'hon-agent-default'
  )),
  CHECK (voice_profile IS NULL OR voice_profile IN ('CALM', 'CLEAR', 'WARM', 'ENERGETIC')),
  CHECK (display_name IS NOT NULL OR avatar_key IS NOT NULL OR voice_profile IS NOT NULL)
);

ALTER TABLE hon.ai_team_presentation_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.ai_team_presentation_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_team_presentation_preferences_tenant_isolation
  ON hon.ai_team_presentation_preferences
  USING (
    organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id()
  )
  WITH CHECK (
    organization_id = hon.current_organization_id()
    AND school_id = hon.current_school_id()
  );

-- The sole customizer permission is sensitive because it changes a tenant's
-- visible AI Team representation. Existing owners receive it; future system
-- owners inherit it through the provisioning function's permission copy.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES (
  'ai.team.configure',
  'Read and change approved HON AI Team presentation preferences within a Complete-tier school',
  true
)
ON CONFLICT (code) DO UPDATE
SET description = EXCLUDED.description,
    is_sensitive = true;

INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code = 'ai.team.configure'
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Runtime needs only the directory join/upsert transition. Delete and all
-- privileges over unrelated control planes remain absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.ai_team_presentation_preferences FROM hon_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.ai_team_presentation_preferences TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
