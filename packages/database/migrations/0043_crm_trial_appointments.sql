BEGIN;

-- Appointment types and outcomes are intentionally separate: a TRIAL may later
-- be completed, cancelled, or recorded as a no-show without changing its type.
CREATE TYPE hon.crm_appointment_type AS ENUM ('TRIAL', 'CONSULTATION');
CREATE TYPE hon.crm_appointment_status AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW');
REVOKE USAGE ON TYPE hon.crm_appointment_type FROM PUBLIC;
REVOKE USAGE ON TYPE hon.crm_appointment_status FROM PUBLIC;

-- This is a CRM appointment record only. It deliberately does not create a
-- class booking, attendance record, membership, provider operation, message,
-- or AI/action-engine side effect.
CREATE TABLE hon.crm_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  crm_lead_id uuid NOT NULL,
  appointment_type hon.crm_appointment_type NOT NULL,
  status hon.crm_appointment_status NOT NULL DEFAULT 'SCHEDULED',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  location text,
  notes text,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  -- crm_leads_id_tenant_unique was established in 0004; this makes a lead from
  -- another school or organization structurally impossible to reference.
  FOREIGN KEY (crm_lead_id, organization_id, school_id)
    REFERENCES hon.crm_leads(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  CHECK (ends_at > starts_at),
  CHECK (version >= 1),
  CHECK (location IS NULL OR (btrim(location) <> '' AND char_length(location) <= 160)),
  CHECK (notes IS NULL OR (btrim(notes) <> '' AND char_length(notes) <= 2000))
);

CREATE INDEX crm_appointments_scope_lead_starts_idx
  ON hon.crm_appointments (organization_id, school_id, crm_lead_id, starts_at DESC);
CREATE INDEX crm_appointments_scope_status_starts_idx
  ON hon.crm_appointments (organization_id, school_id, status, starts_at DESC);

ALTER TABLE hon.crm_appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_appointments FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_appointments_tenant_isolation ON hon.crm_appointments
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES ('crm.trial.schedule', 'Schedule a CRM lead trial appointment within an authorized school', false)
ON CONFLICT (code) DO NOTHING;

-- Existing system owners must be brought forward. Future OWNER roles receive
-- all permissions through hon.provision_school_from_hq.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code = 'crm.trial.schedule'
WHERE role.code = 'OWNER'
  AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- The runtime command needs only RLS-bound lookup/insert capability. There is
-- intentionally no UPDATE or DELETE grant before a dedicated lifecycle command
-- exists, and enum usage is granted explicitly rather than through PUBLIC.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.crm_appointments FROM hon_runtime;
    GRANT SELECT, INSERT ON TABLE hon.crm_appointments TO hon_runtime;
    GRANT USAGE ON TYPE hon.crm_appointment_type, hon.crm_appointment_status TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
