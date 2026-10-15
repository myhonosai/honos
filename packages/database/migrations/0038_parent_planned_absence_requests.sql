BEGIN;

CREATE TYPE hon.planned_absence_request_status AS ENUM (
  'SUBMITTED',
  'APPROVED',
  'DECLINED',
  'CANCELLED'
);
REVOKE USAGE ON TYPE hon.planned_absence_request_status FROM PUBLIC;

-- This is a request record only. It deliberately has no booking, attendance,
-- makeup, provider, or automatic workflow relation. A later reviewed command
-- boundary may transition it, but cannot manufacture review facts on creation.
CREATE TABLE hon.planned_absence_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  family_id uuid NOT NULL,
  student_profile_id uuid NOT NULL,
  requested_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  status hon.planned_absence_request_status NOT NULL DEFAULT 'SUBMITTED',
  reviewed_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_note text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (family_id, organization_id, school_id)
    REFERENCES hon.families(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (student_profile_id, organization_id, school_id)
    REFERENCES hon.student_profiles(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  CHECK (ends_at > starts_at),
  CHECK (version >= 1),
  CHECK (reason IS NULL OR (btrim(reason) <> '' AND char_length(reason) <= 1000)),
  CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  -- Submitted requests have no review facts. A future human review transition
  -- must attribute approvals and declines; cancellation is intentionally not
  -- treated as a review outcome and keeps review metadata empty.
  CHECK (
    (status = 'SUBMITTED' AND reviewed_by_principal_id IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
    OR
    (status IN ('APPROVED', 'DECLINED') AND reviewed_by_principal_id IS NOT NULL AND reviewed_at IS NOT NULL)
    OR
    (status = 'CANCELLED' AND reviewed_by_principal_id IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
  )
);

-- Composite foreign keys make an unrelated school/family/profile impossible.
-- The trigger additionally proves the profile's person is the exact selected
-- family's STUDENT member and that this is the profile's primary family.
CREATE OR REPLACE FUNCTION hon.enforce_planned_absence_student_family()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, hon
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM hon.student_profiles AS profile
    JOIN hon.family_members AS member
      ON member.organization_id = profile.organization_id
     AND member.school_id = profile.school_id
     AND member.person_id = profile.person_id
     AND member.family_id = NEW.family_id
     AND member.member_role = 'STUDENT'::hon.family_member_role
    WHERE profile.id = NEW.student_profile_id
      AND profile.organization_id = NEW.organization_id
      AND profile.school_id = NEW.school_id
      AND profile.primary_family_id = NEW.family_id
  ) THEN
    RAISE EXCEPTION 'planned absence student must be a STUDENT member of its selected primary family'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hon.enforce_planned_absence_initial_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, hon
AS $$
BEGIN
  IF NEW.status <> 'SUBMITTED'::hon.planned_absence_request_status
     OR NEW.reviewed_by_principal_id IS NOT NULL
     OR NEW.reviewed_at IS NOT NULL
     OR NEW.review_note IS NOT NULL THEN
    RAISE EXCEPTION 'planned absence requests must be created as unreviewed SUBMITTED requests'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER planned_absence_requests_student_family_integrity
  BEFORE INSERT OR UPDATE OF organization_id, school_id, family_id, student_profile_id
  ON hon.planned_absence_requests
  FOR EACH ROW EXECUTE FUNCTION hon.enforce_planned_absence_student_family();

CREATE TRIGGER planned_absence_requests_initial_state
  BEFORE INSERT ON hon.planned_absence_requests
  FOR EACH ROW EXECUTE FUNCTION hon.enforce_planned_absence_initial_state();

CREATE INDEX planned_absence_requests_scope_family_starts_idx
  ON hon.planned_absence_requests (organization_id, school_id, family_id, starts_at DESC);
CREATE INDEX planned_absence_requests_scope_student_starts_idx
  ON hon.planned_absence_requests (organization_id, school_id, student_profile_id, starts_at DESC);
CREATE INDEX planned_absence_requests_requester_scope_created_idx
  ON hon.planned_absence_requests (requested_by_principal_id, organization_id, school_id, created_at DESC);

ALTER TABLE hon.planned_absence_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.planned_absence_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY planned_absence_requests_tenant_isolation ON hon.planned_absence_requests
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- The initial parent command only needs an RLS-bound insert and RETURNING. Do
-- not pre-grant review/update/delete capability before a reviewed workflow exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE ALL ON TABLE hon.planned_absence_requests FROM hon_runtime;
    GRANT SELECT, INSERT ON TABLE hon.planned_absence_requests TO hon_runtime;
    GRANT USAGE ON TYPE hon.planned_absence_request_status TO hon_runtime;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION hon.enforce_planned_absence_student_family() FROM PUBLIC;
REVOKE ALL ON FUNCTION hon.enforce_planned_absence_initial_state() FROM PUBLIC;

COMMIT;
