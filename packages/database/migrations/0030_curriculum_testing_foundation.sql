BEGIN;

CREATE TYPE hon.curriculum_lifecycle AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE hon.testing_event_status AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'COMPLETED', 'CANCELLED');
CREATE TYPE hon.testing_candidate_result AS ENUM ('PENDING', 'PASSED', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN');
CREATE TYPE hon.promotion_decision_status AS ENUM ('PENDING_INSTRUCTOR_DECISION', 'PROMOTED', 'DEFERRED', 'NOT_PROMOTED');
REVOKE USAGE ON TYPE hon.curriculum_lifecycle, hon.testing_event_status, hon.testing_candidate_result, hon.promotion_decision_status FROM PUBLIC;

CREATE TABLE hon.curricula (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  lifecycle hon.curriculum_lifecycle NOT NULL DEFAULT 'DRAFT',
  model_code text NOT NULL CHECK (model_code IN ('LINEAR', 'ROTATIONAL', 'HYBRID', 'SKILL_BASED', 'MODULE_BASED', 'ATTENDANCE_PLUS_APPROVAL', 'CUSTOM')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (organization_id, school_id, name)
);

CREATE TABLE hon.curriculum_ranks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  curriculum_id uuid NOT NULL,
  name text NOT NULL,
  display_color text,
  progression_order integer NOT NULL CHECK (progression_order > 0),
  exposure_requirement jsonb NOT NULL DEFAULT '{}'::jsonb,
  mastery_requirement jsonb NOT NULL DEFAULT '{}'::jsonb,
  promotion_requirement jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (curriculum_id, organization_id, school_id) REFERENCES hon.curricula(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (curriculum_id, progression_order),
  UNIQUE (curriculum_id, name)
);

CREATE TABLE hon.curriculum_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  curriculum_rank_id uuid NOT NULL,
  requirement_code text NOT NULL,
  requirement_kind text NOT NULL CHECK (requirement_kind IN ('TECHNIQUE', 'KNOWLEDGE', 'CHARACTER', 'ATTENDANCE', 'PRACTICE', 'INSTRUCTOR_JUDGMENT', 'CUSTOM')),
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_required boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (curriculum_rank_id, organization_id, school_id) REFERENCES hon.curriculum_ranks(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (curriculum_rank_id, requirement_code)
);

CREATE TABLE hon.student_curriculum_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  student_profile_id uuid NOT NULL,
  curriculum_id uuid NOT NULL,
  current_rank_id uuid,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  status hon.membership_status NOT NULL DEFAULT 'ACTIVE',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (student_profile_id, organization_id, school_id) REFERENCES hon.student_profiles(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (curriculum_id, organization_id, school_id) REFERENCES hon.curricula(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (current_rank_id, organization_id, school_id) REFERENCES hon.curriculum_ranks(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (student_profile_id, curriculum_id)
);

CREATE TABLE hon.testing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  curriculum_id uuid NOT NULL,
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  status hon.testing_event_status NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (curriculum_id, organization_id, school_id) REFERENCES hon.curricula(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (registration_closes_at IS NULL OR registration_opens_at IS NULL OR registration_closes_at > registration_opens_at)
);

CREATE TABLE hon.testing_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  testing_event_id uuid NOT NULL,
  student_curriculum_enrollment_id uuid NOT NULL,
  target_rank_id uuid NOT NULL,
  result hon.testing_candidate_result NOT NULL DEFAULT 'PENDING',
  instructor_notes text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (testing_event_id, organization_id, school_id) REFERENCES hon.testing_events(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (student_curriculum_enrollment_id, organization_id, school_id) REFERENCES hon.student_curriculum_enrollments(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_rank_id, organization_id, school_id) REFERENCES hon.curriculum_ranks(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (testing_event_id, student_curriculum_enrollment_id)
);

CREATE TABLE hon.promotion_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  testing_candidate_id uuid NOT NULL,
  student_curriculum_enrollment_id uuid NOT NULL,
  prior_rank_id uuid,
  target_rank_id uuid NOT NULL,
  status hon.promotion_decision_status NOT NULL DEFAULT 'PENDING_INSTRUCTOR_DECISION',
  instructor_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  rationale text,
  decided_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (testing_candidate_id, organization_id, school_id) REFERENCES hon.testing_candidates(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (student_curriculum_enrollment_id, organization_id, school_id) REFERENCES hon.student_curriculum_enrollments(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_rank_id, organization_id, school_id) REFERENCES hon.curriculum_ranks(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_rank_id, organization_id, school_id) REFERENCES hon.curriculum_ranks(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (testing_candidate_id)
);

CREATE INDEX curriculum_rank_scope_idx ON hon.curriculum_ranks (organization_id, school_id, curriculum_id, progression_order);
CREATE INDEX student_curriculum_scope_idx ON hon.student_curriculum_enrollments (organization_id, school_id, student_profile_id);
CREATE INDEX testing_event_scope_idx ON hon.testing_events (organization_id, school_id, starts_at);
CREATE INDEX testing_candidate_scope_idx ON hon.testing_candidates (organization_id, school_id, testing_event_id, result);

ALTER TABLE hon.curricula ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_ranks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.student_curriculum_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.promotion_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.curricula FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_ranks FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.curriculum_requirements FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.student_curriculum_enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.testing_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.promotion_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY curricula_tenant_isolation ON hon.curricula USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY curriculum_ranks_tenant_isolation ON hon.curriculum_ranks USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY curriculum_requirements_tenant_isolation ON hon.curriculum_requirements USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY student_curriculum_enrollments_tenant_isolation ON hon.student_curriculum_enrollments USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY testing_events_tenant_isolation ON hon.testing_events USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY testing_candidates_tenant_isolation ON hon.testing_candidates USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY promotion_decisions_tenant_isolation ON hon.promotion_decisions USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

COMMIT;
