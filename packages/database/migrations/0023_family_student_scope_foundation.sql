BEGIN;

CREATE TYPE hon.family_member_role AS ENUM ('GUARDIAN', 'STUDENT', 'DEPENDENT', 'OTHER');
CREATE TYPE hon.family_access_level AS ENUM ('PRIMARY_GUARDIAN', 'SECONDARY_GUARDIAN', 'VIEWER');
REVOKE USAGE ON TYPE hon.family_member_role, hon.family_access_level FROM PUBLIC;

CREATE TABLE hon.families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  display_name text NOT NULL,
  status hon.membership_status NOT NULL DEFAULT 'ACTIVE',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id)
);

CREATE TABLE hon.family_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  person_id uuid NOT NULL,
  member_role hon.family_member_role NOT NULL,
  is_billing_contact boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (family_id, organization_id, school_id) REFERENCES hon.families(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (person_id, organization_id, school_id) REFERENCES hon.people(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (family_id, person_id)
);

CREATE TABLE hon.student_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  person_id uuid NOT NULL,
  primary_family_id uuid,
  birth_date date,
  status hon.membership_status NOT NULL DEFAULT 'ACTIVE',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (person_id, organization_id, school_id) REFERENCES hon.people(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (primary_family_id, organization_id, school_id) REFERENCES hon.families(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (person_id, organization_id, school_id)
);

CREATE TABLE hon.family_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  access_level hon.family_access_level NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  granted_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (family_id, organization_id, school_id) REFERENCES hon.families(id, organization_id, school_id) ON DELETE RESTRICT,
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  UNIQUE (family_id, principal_id, effective_from)
);

CREATE INDEX family_members_person_scope_idx ON hon.family_members (organization_id, school_id, person_id);
CREATE INDEX family_access_grants_principal_scope_idx ON hon.family_access_grants (principal_id, organization_id, school_id, effective_from DESC);
CREATE INDEX student_profiles_family_scope_idx ON hon.student_profiles (organization_id, school_id, primary_family_id);

ALTER TABLE hon.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.student_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.family_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.families FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.family_members FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.student_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.family_access_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY families_tenant_isolation ON hon.families
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY family_members_tenant_isolation ON hon.family_members
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY student_profiles_tenant_isolation ON hon.student_profiles
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY family_access_grants_tenant_isolation ON hon.family_access_grants
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

COMMIT;
