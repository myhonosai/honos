BEGIN;

CREATE FUNCTION hon.validate_testing_candidate_curriculum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_event_curriculum_id uuid;
  v_enrollment_curriculum_id uuid;
  v_target_curriculum_id uuid;
BEGIN
  SELECT curriculum_id INTO v_event_curriculum_id
  FROM hon.testing_events
  WHERE id = NEW.testing_event_id AND organization_id = NEW.organization_id AND school_id = NEW.school_id;
  SELECT curriculum_id INTO v_enrollment_curriculum_id
  FROM hon.student_curriculum_enrollments
  WHERE id = NEW.student_curriculum_enrollment_id AND organization_id = NEW.organization_id AND school_id = NEW.school_id;
  SELECT curriculum_id INTO v_target_curriculum_id
  FROM hon.curriculum_ranks
  WHERE id = NEW.target_rank_id AND organization_id = NEW.organization_id AND school_id = NEW.school_id;
  IF v_event_curriculum_id IS NULL OR v_event_curriculum_id IS DISTINCT FROM v_enrollment_curriculum_id OR v_event_curriculum_id IS DISTINCT FROM v_target_curriculum_id THEN
    RAISE EXCEPTION 'HON testing candidate event, student enrollment, and target rank must use the same curriculum.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER testing_candidates_curriculum_integrity
  BEFORE INSERT OR UPDATE OF testing_event_id, student_curriculum_enrollment_id, target_rank_id, organization_id, school_id
  ON hon.testing_candidates
  FOR EACH ROW EXECUTE FUNCTION hon.validate_testing_candidate_curriculum();

CREATE FUNCTION hon.validate_promotion_decision_curriculum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_candidate_enrollment_id uuid;
  v_candidate_target_rank_id uuid;
  v_enrollment_curriculum_id uuid;
  v_target_curriculum_id uuid;
  v_prior_curriculum_id uuid;
BEGIN
  SELECT student_curriculum_enrollment_id, target_rank_id INTO v_candidate_enrollment_id, v_candidate_target_rank_id
  FROM hon.testing_candidates
  WHERE id = NEW.testing_candidate_id AND organization_id = NEW.organization_id AND school_id = NEW.school_id;
  SELECT curriculum_id INTO v_enrollment_curriculum_id
  FROM hon.student_curriculum_enrollments
  WHERE id = NEW.student_curriculum_enrollment_id AND organization_id = NEW.organization_id AND school_id = NEW.school_id;
  SELECT curriculum_id INTO v_target_curriculum_id
  FROM hon.curriculum_ranks
  WHERE id = NEW.target_rank_id AND organization_id = NEW.organization_id AND school_id = NEW.school_id;
  IF NEW.prior_rank_id IS NOT NULL THEN
    SELECT curriculum_id INTO v_prior_curriculum_id
    FROM hon.curriculum_ranks
    WHERE id = NEW.prior_rank_id AND organization_id = NEW.organization_id AND school_id = NEW.school_id;
  END IF;
  IF v_candidate_enrollment_id IS DISTINCT FROM NEW.student_curriculum_enrollment_id
     OR v_candidate_target_rank_id IS DISTINCT FROM NEW.target_rank_id
     OR v_enrollment_curriculum_id IS NULL
     OR v_enrollment_curriculum_id IS DISTINCT FROM v_target_curriculum_id
     OR (NEW.prior_rank_id IS NOT NULL AND v_enrollment_curriculum_id IS DISTINCT FROM v_prior_curriculum_id) THEN
    RAISE EXCEPTION 'HON promotion decision must match its testing candidate and one school curriculum.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'PENDING_INSTRUCTOR_DECISION' AND (NEW.instructor_principal_id IS NOT NULL OR NEW.decided_at IS NOT NULL) THEN
    RAISE EXCEPTION 'HON pending promotion decision cannot record instructor approval data.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'PENDING_INSTRUCTOR_DECISION' AND (NEW.instructor_principal_id IS NULL OR NEW.decided_at IS NULL) THEN
    RAISE EXCEPTION 'HON final promotion decision requires an instructor principal and decision time.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER promotion_decisions_curriculum_integrity
  BEFORE INSERT OR UPDATE OF testing_candidate_id, student_curriculum_enrollment_id, prior_rank_id, target_rank_id, status, instructor_principal_id, decided_at, organization_id, school_id
  ON hon.promotion_decisions
  FOR EACH ROW EXECUTE FUNCTION hon.validate_promotion_decision_curriculum();

COMMIT;
