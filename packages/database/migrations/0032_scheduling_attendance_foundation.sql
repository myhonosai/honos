BEGIN;

CREATE TYPE hon.schedule_item_status AS ENUM ('DRAFT', 'SCHEDULED', 'CANCELLED', 'COMPLETED');
CREATE TYPE hon.class_booking_status AS ENUM ('BOOKED', 'WAITLISTED', 'CANCELLED', 'CHECKED_IN', 'NO_SHOW');
CREATE TYPE hon.attendance_status AS ENUM ('PRESENT', 'LATE', 'EXCUSED_ABSENCE', 'UNEXCUSED_ABSENCE', 'MAKEUP');
REVOKE USAGE ON TYPE hon.schedule_item_status, hon.class_booking_status, hon.attendance_status FROM PUBLIC;

CREATE TABLE hon.programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  minimum_age_months integer CHECK (minimum_age_months IS NULL OR minimum_age_months >= 0),
  maximum_age_months integer CHECK (maximum_age_months IS NULL OR maximum_age_months >= minimum_age_months),
  status hon.schedule_item_status NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (organization_id, school_id, name)
);

CREATE TABLE hon.class_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  program_id uuid NOT NULL,
  name text NOT NULL,
  room_name text,
  capacity integer NOT NULL CHECK (capacity > 0),
  booking_policy text NOT NULL CHECK (booking_policy IN ('WALK_IN', 'OPTIONAL_BOOKING', 'REQUIRED_BOOKING')),
  recurrence_rule text,
  status hon.schedule_item_status NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (program_id, organization_id, school_id) REFERENCES hon.programs(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id)
);

CREATE TABLE hon.class_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  class_template_id uuid,
  program_id uuid NOT NULL,
  name text NOT NULL,
  room_name text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  capacity integer NOT NULL CHECK (capacity > 0),
  booking_policy text NOT NULL CHECK (booking_policy IN ('WALK_IN', 'OPTIONAL_BOOKING', 'REQUIRED_BOOKING')),
  status hon.schedule_item_status NOT NULL DEFAULT 'SCHEDULED',
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (class_template_id, organization_id, school_id) REFERENCES hon.class_templates(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (program_id, organization_id, school_id) REFERENCES hon.programs(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  CHECK (ends_at > starts_at),
  CHECK ((status <> 'CANCELLED') OR cancellation_reason IS NOT NULL)
);

CREATE TABLE hon.class_session_instructors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  class_session_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  assignment_role text NOT NULL CHECK (assignment_role IN ('LEAD', 'ASSISTANT', 'SUBSTITUTE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (class_session_id, organization_id, school_id) REFERENCES hon.class_sessions(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (class_session_id, principal_id)
);

CREATE TABLE hon.class_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  class_session_id uuid NOT NULL,
  student_profile_id uuid NOT NULL,
  booking_kind text NOT NULL CHECK (booking_kind IN ('REGULAR', 'TRIAL', 'MAKEUP', 'PRIVATE_LESSON', 'EVENT')),
  status hon.class_booking_status NOT NULL DEFAULT 'BOOKED',
  source text NOT NULL CHECK (source IN ('STAFF', 'PARENT_APP', 'AUTOMATION', 'INTEGRATION')),
  booked_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (class_session_id, organization_id, school_id) REFERENCES hon.class_sessions(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (student_profile_id, organization_id, school_id) REFERENCES hon.student_profiles(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (class_session_id, student_profile_id),
  CHECK ((status <> 'CANCELLED') OR cancelled_at IS NOT NULL)
);

CREATE TABLE hon.attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  class_session_id uuid NOT NULL,
  student_profile_id uuid NOT NULL,
  class_booking_id uuid,
  status hon.attendance_status NOT NULL,
  recorded_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  note text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (class_session_id, organization_id, school_id) REFERENCES hon.class_sessions(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (student_profile_id, organization_id, school_id) REFERENCES hon.student_profiles(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (class_booking_id, organization_id, school_id) REFERENCES hon.class_bookings(id, organization_id, school_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (class_session_id, student_profile_id)
);

CREATE INDEX class_sessions_scope_start_idx ON hon.class_sessions (organization_id, school_id, starts_at);
CREATE INDEX class_bookings_scope_session_idx ON hon.class_bookings (organization_id, school_id, class_session_id, status);
CREATE INDEX attendance_scope_student_idx ON hon.attendance_records (organization_id, school_id, student_profile_id, recorded_at DESC);

ALTER TABLE hon.programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.class_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.class_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.class_session_instructors ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.class_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.programs FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.class_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.class_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.class_session_instructors FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.class_bookings FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.attendance_records FORCE ROW LEVEL SECURITY;

CREATE POLICY programs_tenant_isolation ON hon.programs USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY class_templates_tenant_isolation ON hon.class_templates USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY class_sessions_tenant_isolation ON hon.class_sessions USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY class_session_instructors_tenant_isolation ON hon.class_session_instructors USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY class_bookings_tenant_isolation ON hon.class_bookings USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY attendance_records_tenant_isolation ON hon.attendance_records USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

COMMIT;
