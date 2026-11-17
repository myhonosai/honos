BEGIN;

-- 0452 (allocated by the coordinator 2026-11-17; was 0432, 0438, then 0450): owner ask "choose voice for all AI agents, give few choices each".
-- Each person picks one of three free browser voices for each AI teammate, saved to their own account in this school
-- (not only in the browser). Presentation only: the value is a choice number (1-3) that the web app maps to a browser
-- speech profile (pitch, rate, which of the device's own voices). No provider, no paid voice, no AI call, no spend.
-- Same scope and permissions as the personal interface theme (0012): settings.interface_theme.read / .update.
-- A missing row means choice 1 (the voice each teammate had before this migration).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Agent voice preferences require a trusted migration owner';
  END IF;
  IF to_regclass('hon.principal_interface_preferences') IS NULL THEN RAISE EXCEPTION 'Apply migration 0012 first'; END IF;
END $$;

CREATE TABLE hon.principal_agent_voice_preferences (
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  agent_key text NOT NULL CHECK (agent_key IN ('hon', 'claire', 'alex', 'jordan', 'lena', 'marcus', 'chad', 'maya', 'kai')),
  voice_choice smallint NOT NULL CHECK (voice_choice BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, school_id, principal_id, agent_key),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

ALTER TABLE hon.principal_agent_voice_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.principal_agent_voice_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY principal_agent_voice_preferences_tenant_isolation ON hon.principal_agent_voice_preferences
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON TABLE hon.principal_agent_voice_preferences FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.principal_agent_voice_preferences FROM %I', r);
  END LOOP;
  -- No DELETE: choosing voice 1 again stores 1.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.principal_agent_voice_preferences TO hon_runtime;
  END IF;
END $$;

COMMIT;
