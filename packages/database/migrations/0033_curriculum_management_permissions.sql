BEGIN;

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('curriculum.manage', 'Create and maintain school-defined curriculum structures', false),
  ('curriculum.rank.manage', 'Create and maintain curriculum ranks and requirements', false),
  ('testing.manage', 'Create and manage instructor-led testing events and candidates', false),
  ('testing.promotion.decide', 'Record final human instructor promotion decisions', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code IN ('curriculum.manage', 'curriculum.rank.manage', 'testing.manage', 'testing.promotion.decide')
WHERE role.code = 'OWNER' AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.curricula, hon.curriculum_ranks, hon.curriculum_requirements, hon.student_curriculum_enrollments, hon.testing_events, hon.testing_candidates, hon.promotion_decisions TO hon_runtime;
    GRANT USAGE ON TYPE hon.curriculum_lifecycle, hon.testing_event_status, hon.testing_candidate_result, hon.promotion_decision_status TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
