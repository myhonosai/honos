BEGIN;

CREATE TABLE hon.membership_payment_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES hon.memberships(id) ON DELETE RESTRICT,
  frequency text NOT NULL CHECK (frequency IN ('WEEKLY', 'MONTHLY', 'ANNUAL', 'CUSTOM')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  next_charge_at timestamptz,
  auto_renew boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id)
);

ALTER TABLE hon.membership_payment_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.membership_payment_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_payment_schedules_tenant_isolation ON hon.membership_payment_schedules
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES ('billing.membership.create', 'Create a draft membership and an optional non-processor payment schedule in an authorized school', false)
ON CONFLICT (code) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE hon.membership_payment_schedules TO hon_runtime';
  END IF;
END;
$$;

COMMIT;
