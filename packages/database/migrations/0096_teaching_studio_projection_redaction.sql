BEGIN;

-- Preserve immutable migration history. The Teaching Studio surface returns
-- instructional records only; staff principal identifiers are not a directory
-- feature and are deliberately withheld from every projection.
CREATE OR REPLACE FUNCTION hon.teaching_lesson_projection(p_id uuid,p_version integer DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object(
   'id',r.lesson_plan_id,'version',r.version,'title',r.title,
   'instructionalObjective',r.instructional_objective,'sections',r.sections,
   'durationMinutes',r.duration_minutes,'status',r.status,
   'targetCurriculumId',r.target_curriculum_id,'targetRankId',r.target_rank_id,
   'recordedAt',r.recorded_at,'humanAuthoredOnly',true
 )
 FROM hon.teaching_lesson_plan_revisions r
 WHERE r.lesson_plan_id=p_id AND r.organization_id=hon.current_organization_id()
   AND r.school_id=hon.current_school_id() AND (p_version IS NULL OR r.version=p_version)
 ORDER BY r.version DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION hon.teaching_resource_projection(p_id uuid,p_version integer DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object(
   'id',r.resource_id,'version',r.version,'title',r.title,
   'resourceType',r.resource_type,'description',r.description,'status',r.status,
   'recordedAt',r.recorded_at,'metadataOnly',true
 )
 FROM hon.teaching_resource_revisions r
 WHERE r.resource_id=p_id AND r.organization_id=hon.current_organization_id()
   AND r.school_id=hon.current_school_id() AND (p_version IS NULL OR r.version=p_version)
 ORDER BY r.version DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION hon.teaching_assessment_projection(p_id uuid,p_version integer DEFAULT NULL)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT jsonb_build_object(
   'id',r.assessment_id,'version',r.version,'studentProfileId',a.student_profile_id,
   'observation',r.observation,'assessedSkills',r.assessed_skills,
   'instructorNote',r.instructor_note,'assessedOn',r.assessed_on,'status',r.status,
   'targetCurriculumId',r.target_curriculum_id,'targetRankId',r.target_rank_id,
   'recordedAt',r.recorded_at,'instructionalOnly',true
 )
 FROM hon.instructor_assessment_revisions r
 JOIN hon.instructor_assessments a ON a.id=r.assessment_id
   AND a.organization_id=r.organization_id AND a.school_id=r.school_id
 WHERE r.assessment_id=p_id AND r.organization_id=hon.current_organization_id()
   AND r.school_id=hon.current_school_id() AND (p_version IS NULL OR r.version=p_version)
 ORDER BY r.version DESC LIMIT 1
$$;

DO $$
DECLARE signature regprocedure;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'hon.teaching_lesson_projection(uuid,integer)'::regprocedure,
    'hon.teaching_resource_projection(uuid,integer)'::regprocedure,
    'hon.teaching_assessment_projection(uuid,integer)'::regprocedure
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', signature);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM hon_runtime', signature);
    END IF;
  END LOOP;
END;
$$;

COMMIT;
