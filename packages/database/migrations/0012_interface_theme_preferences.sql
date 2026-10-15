BEGIN;

CREATE TABLE hon.principal_interface_preferences (
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  interface_theme text NOT NULL CHECK (interface_theme IN ('big-button', 'modern', 'classic')),
  selected_via text NOT NULL CHECK (selected_via IN ('ONBOARDING', 'SETTINGS')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, school_id, principal_id),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

ALTER TABLE hon.principal_interface_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.principal_interface_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_interface_preferences_tenant_isolation ON hon.principal_interface_preferences
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('settings.interface_theme.read', 'Read a principal interface preference within an authorized school', false),
  ('settings.interface_theme.update', 'Change a principal interface preference within an authorized school', false)
ON CONFLICT (code) DO NOTHING;

COMMIT;
