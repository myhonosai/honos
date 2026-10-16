BEGIN;
-- A projection, not a promotion model or command. No new tables, locks, receipts,
-- audit/outbox writes or downstream effects. Private evidence stays FORCE RLS.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Readiness requires trusted migration owner'; END IF;
END $$;
INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
 VALUES('testing.promotion.readiness.read','Direct human read of deterministic scoped promotion evidence only',true,true);
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
 SELECT id,organization_id,'testing.promotion.readiness.read' FROM hon.roles WHERE is_system_role AND code='OWNER' ON CONFLICT DO NOTHING;

CREATE FUNCTION hon.read_promotion_readiness(p_subject text,p_curriculum uuid,p_enrollment uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE
 org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
 asof timestamptz:=statement_timestamp(); e hon.student_curriculum_enrollments%ROWTYPE;
 current_rank hon.curriculum_ranks%ROWTYPE; next_rank hon.curriculum_ranks%ROWTYPE;
 policy jsonb; valid boolean:=true; fingerprint text; policy_version integer;
 criteria jsonb:='[]'; blockers jsonb; candidate jsonb; readiness_status text; outcome text;
 rank_since timestamptz; rank_source uuid; transition_rank uuid;
 credit bigint:=0; attendance_count integer:=0; latest_attendance timestamptz;
 days integer; evidence_count integer:=0; min_credit bigint; min_days integer;
 item jsonb; requirement hon.curriculum_requirements%ROWTYPE; observation record;
 doc record; window_record record; recommendation boolean; reason text;
 uuid_pattern constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
 IF org IS NULL OR school IS NULL OR p_subject IS NULL OR p_subject='' OR p_curriculum IS NULL OR p_enrollment IS NULL
  OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
  OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
  OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'PROMOTION_READINESS_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
 WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true)
  AND p.principal_type='HUMAN_USER' AND p.is_active
  AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1;
 IF actor IS NULL OR NOT EXISTS(
  SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
  JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
  JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id JOIN hon.organizations o ON o.id=s.organization_id
  WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school
   AND rp.permission_code='testing.promotion.readiness.read' AND g.revoked_at IS NULL AND g.effective_from<=asof
   AND (g.effective_until IS NULL OR g.effective_until>asof) AND s.status='ACTIVE' AND o.status='ACTIVE'
   AND (r.management_school_id IS NULL OR r.management_school_id=school)
 ) OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=org
  AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=asof AND (effective_until IS NULL OR effective_until>asof)) THEN
  RAISE EXCEPTION 'PROMOTION_READINESS_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.curricula WHERE id=p_curriculum AND organization_id=org AND school_id=school;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROMOTION_READINESS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT * INTO e FROM hon.student_curriculum_enrollments WHERE id=p_enrollment AND curriculum_id=p_curriculum AND organization_id=org AND school_id=school;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROMOTION_READINESS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT * INTO current_rank FROM hon.curriculum_ranks WHERE id=e.current_rank_id AND curriculum_id=p_curriculum AND organization_id=org AND school_id=school;
 SELECT * INTO next_rank FROM hon.curriculum_ranks WHERE curriculum_id=p_curriculum AND organization_id=org AND school_id=school AND progression_order>current_rank.progression_order ORDER BY progression_order,id LIMIT 1;
 outcome:=CASE WHEN e.status='ACTIVE' AND current_rank.id IS NOT NULL AND next_rank.id IS NOT NULL
  AND EXISTS(SELECT 1 FROM hon.student_profiles WHERE id=e.student_profile_id AND organization_id=org AND school_id=school AND status='ACTIVE')
  AND EXISTS(SELECT 1 FROM hon.curricula WHERE id=p_curriculum AND organization_id=org AND school_id=school AND lifecycle='PUBLISHED') THEN 'MET' ELSE 'NOT_MET' END;
 criteria:=criteria||jsonb_build_array(jsonb_build_object('code','ENROLLMENT','sourceId',e.id,'outcome',outcome,'observed',NULL,'required',NULL,'recordedAt',NULL));
 -- Only the school's exact closed object on CURRENT rank is interpreted. All
 -- fields are explicit, including an empty document list and the safe rule.
 policy:=current_rank.promotion_requirement->'promotionReadinessV1';
 IF jsonb_typeof(current_rank.promotion_requirement) IS DISTINCT FROM 'object' THEN valid:=false;
 ELSIF (SELECT count(*) FROM jsonb_object_keys(current_rank.promotion_requirement))<>1 OR jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN valid:=false;
 ELSE
  IF (SELECT count(*) FROM jsonb_object_keys(policy))<>7 OR EXISTS(SELECT 1 FROM jsonb_object_keys(policy) k WHERE k NOT IN(
   'minAttendanceCreditMilli','minDaysInCurrentRank','requiredRequirementIds','instructorRecommendationRequirementIds','documentTemplateIds','documentAcknowledgementRule','requireOpenTestingWindow'))
   OR jsonb_typeof(policy->'minAttendanceCreditMilli') IS DISTINCT FROM 'number'
   OR (policy->>'minAttendanceCreditMilli') !~ '^(0|[1-9][0-9]{0,11})$'
   OR jsonb_typeof(policy->'minDaysInCurrentRank') IS DISTINCT FROM 'number'
   OR (policy->>'minDaysInCurrentRank') !~ '^(0|[1-9][0-9]{0,4})$'
   OR jsonb_typeof(policy->'requireOpenTestingWindow') IS DISTINCT FROM 'boolean'
   OR policy->>'documentAcknowledgementRule' IS DISTINCT FROM 'CURRENT_CALLER_STAFF_CURRENT_PUBLICATION' THEN valid:=false; END IF;
  FOREACH reason IN ARRAY ARRAY['requiredRequirementIds','instructorRecommendationRequirementIds','documentTemplateIds'] LOOP
   IF jsonb_typeof(policy->reason) IS DISTINCT FROM 'array' THEN valid:=false;
   ELSE
    IF jsonb_array_length(policy->reason)>100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(policy->reason) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR (x#>>'{}') !~ uuid_pattern)
     OR (SELECT count(*) FROM jsonb_array_elements(policy->reason))<>(SELECT count(DISTINCT x) FROM jsonb_array_elements(policy->reason) x) THEN valid:=false; END IF;
   END IF;
  END LOOP;
 END IF;
 IF valid THEN
  min_credit:=(policy->>'minAttendanceCreditMilli')::bigint; min_days:=(policy->>'minDaysInCurrentRank')::integer;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(policy->'requiredRequirementIds') x JOIN jsonb_array_elements_text(policy->'instructorRecommendationRequirementIds') y ON x=y)
   OR (min_credit=0 AND min_days=0 AND jsonb_array_length(policy->'requiredRequirementIds')=0 AND jsonb_array_length(policy->'instructorRecommendationRequirementIds')=0
    AND jsonb_array_length(policy->'documentTemplateIds')=0 AND NOT (policy->>'requireOpenTestingWindow')::boolean) THEN valid:=false; END IF;
 END IF;
 -- A configuration reference must be current, exact rank/school/curriculum. A
 -- foreign/missing ID is a visible generic blocker, never a foreign projection.
 IF valid THEN
  FOR item IN SELECT x FROM jsonb_array_elements((policy->'requiredRequirementIds')||(policy->'instructorRecommendationRequirementIds')) x LOOP
   SELECT * INTO requirement FROM hon.curriculum_requirements WHERE id=(item#>>'{}')::uuid AND curriculum_rank_id=current_rank.id AND organization_id=org AND school_id=school;
   IF NOT FOUND OR ((policy->'instructorRecommendationRequirementIds') ? (item#>>'{}') AND requirement.requirement_kind<>'INSTRUCTOR_JUDGMENT') THEN valid:=false; END IF;
  END LOOP;
  FOR item IN SELECT x FROM jsonb_array_elements(policy->'documentTemplateIds') x LOOP
   IF NOT EXISTS(SELECT 1 FROM hon.document_templates WHERE id=(item#>>'{}')::uuid AND organization_id=org AND school_id=school AND audience='STAFF') THEN valid:=false; END IF;
  END LOOP;
 END IF;
 IF valid THEN fingerprint:=encode(sha256(convert_to(policy::text,'UTF8')),'hex'); policy_version:=1; END IF;
 criteria:=criteria||jsonb_build_array(jsonb_build_object('code','POLICY','sourceId',NULL,'outcome',CASE WHEN valid THEN 'MET' ELSE 'CONFIGURATION_BLOCKER' END,'observed',NULL,'required',NULL,'recordedAt',NULL));
 -- Most recent immutable placement OR recorded promotion is authoritative. No
 -- enrollment timestamp or mutable updated_at is a guessed rank-start date.
 SELECT t.id,t.at,t.rank INTO rank_source,rank_since,transition_rank FROM (
  SELECT h.id,h.recorded_at AS at,h.current_rank_id AS rank,'ENROLLMENT_HISTORY'::text AS source_kind FROM hon.curriculum_enrollment_history h
   WHERE h.enrollment_id=e.id AND h.curriculum_id=p_curriculum AND h.organization_id=org AND h.school_id=school AND h.enrollment_version<=e.version AND h.recorded_at<=asof
  UNION ALL SELECT d.id,d.decided_at,d.target_rank_id,'PROMOTION_DECISION'::text AS source_kind FROM hon.promotion_decisions d
   JOIN hon.testing_candidates c ON c.id=d.testing_candidate_id AND c.organization_id=org AND c.school_id=school AND c.student_curriculum_enrollment_id=e.id AND c.target_rank_id=d.target_rank_id AND c.result='PASSED'
   JOIN hon.testing_events ev ON ev.id=c.testing_event_id AND ev.organization_id=org AND ev.school_id=school AND ev.curriculum_id=p_curriculum
   WHERE d.student_curriculum_enrollment_id=e.id AND d.organization_id=org AND d.school_id=school AND d.status='PROMOTED' AND d.decided_at<=asof
 ) t ORDER BY t.at DESC,t.source_kind DESC,t.id DESC LIMIT 1;
 IF transition_rank IS DISTINCT FROM current_rank.id THEN rank_since:=NULL; rank_source:=NULL; END IF;
 IF rank_since IS NOT NULL THEN days:=floor(extract(epoch FROM asof-rank_since)/86400)::integer; END IF;
 IF valid THEN
  IF min_days>0 AND rank_since IS NOT NULL THEN evidence_count:=evidence_count+1; END IF;
  criteria:=criteria||jsonb_build_array(jsonb_build_object('code','TIME_IN_RANK','sourceId',rank_source,'outcome',CASE WHEN min_days=0 THEN 'NOT_REQUIRED' WHEN days>=min_days THEN 'MET' ELSE 'MISSING' END,'observed',days,'required',min_days,'recordedAt',rank_since));
  SELECT coalesce(sum(a.progression_credit_milli),0),count(*),max(a.recorded_at) INTO credit,attendance_count,latest_attendance
   FROM hon.attendance_records a JOIN hon.class_sessions s ON s.id=a.class_session_id AND s.organization_id=org AND s.school_id=school
   WHERE a.organization_id=org AND a.school_id=school AND a.student_profile_id=e.student_profile_id AND a.recorded_at<=asof
    AND s.starts_at>=rank_since AND s.starts_at<=asof AND a.progression_credit_milli>0;
  IF min_credit>0 AND attendance_count>0 THEN evidence_count:=evidence_count+attendance_count; END IF;
  criteria:=criteria||jsonb_build_array(jsonb_build_object('code','ATTENDANCE','sourceId',NULL,'outcome',CASE WHEN min_credit=0 THEN 'NOT_REQUIRED' WHEN credit>=min_credit THEN 'MET' ELSE 'MISSING' END,'observed',credit,'required',min_credit,'recordedAt',latest_attendance));
  FOR recommendation IN SELECT false UNION ALL SELECT true LOOP
   FOR item IN SELECT to_jsonb(x) FROM jsonb_array_elements_text(policy->CASE WHEN recommendation THEN 'instructorRecommendationRequirementIds' ELSE 'requiredRequirementIds' END) x ORDER BY x LOOP
    SELECT * INTO requirement FROM hon.curriculum_requirements WHERE id=(item#>>'{}')::uuid AND curriculum_rank_id=current_rank.id AND organization_id=org AND school_id=school;
    SELECT o.id,o.status,o.recorded_at INTO observation FROM hon.curriculum_progress_observations o
     WHERE o.organization_id=org AND o.school_id=school AND o.enrollment_id=e.id AND o.curriculum_id=p_curriculum AND o.curriculum_rank_id=current_rank.id
      AND o.requirement_id=requirement.id AND o.requirement_version=requirement.version AND o.enrollment_version=e.version AND o.recorded_at<=asof
     ORDER BY o.version DESC,o.recorded_at DESC,o.id DESC LIMIT 1;
    IF observation.id IS NOT NULL THEN evidence_count:=evidence_count+1; END IF;
    criteria:=criteria||jsonb_build_array(jsonb_build_object('code',CASE WHEN recommendation THEN 'INSTRUCTOR_RECOMMENDATION' ELSE 'REQUIREMENT' END,'sourceId',requirement.id,
     'outcome',CASE WHEN observation.status='MET' THEN 'MET' WHEN observation.status='NOT_MET' THEN 'NOT_MET' ELSE 'MISSING' END,'observed',NULL,'required',NULL,'recordedAt',observation.recorded_at));
   END LOOP;
  END LOOP;
  -- Explicitly caller STAFF acknowledgement only: never infer enrollment,
  -- student, family or guardian association from a document or signer.
  FOR item IN SELECT to_jsonb(x) FROM jsonb_array_elements_text(policy->'documentTemplateIds') x ORDER BY x LOOP
   SELECT a.id,a.acknowledged_at INTO doc FROM hon.document_templates t
    JOIN hon.document_publications p ON p.id=t.current_publication_id AND p.template_id=t.id AND p.organization_id=org AND p.school_id=school AND p.audience='STAFF' AND p.published_at<=asof
    JOIN hon.document_acknowledgements a ON a.publication_id=p.id AND a.version_id=p.version_id AND a.organization_id=org AND a.school_id=school
     AND a.signer_principal_id=actor AND a.audience='STAFF' AND a.choice='ACKNOWLEDGE' AND a.acknowledged_at<=asof
    WHERE t.id=(item#>>'{}')::uuid AND t.organization_id=org AND t.school_id=school AND t.audience='STAFF';
   IF doc.id IS NOT NULL THEN evidence_count:=evidence_count+1; END IF;
   criteria:=criteria||jsonb_build_array(jsonb_build_object('code','DOCUMENT','sourceId',(item#>>'{}')::uuid,'outcome',CASE WHEN doc.id IS NOT NULL THEN 'MET' ELSE 'MISSING' END,'observed',NULL,'required',NULL,'recordedAt',doc.acknowledged_at));
  END LOOP;
  SELECT ev.id,ev.registration_opens_at INTO window_record FROM hon.testing_events ev WHERE ev.organization_id=org AND ev.school_id=school AND ev.curriculum_id=p_curriculum
   AND ev.status='OPEN' AND ev.registration_opens_at IS NOT NULL AND ev.registration_closes_at IS NOT NULL
   AND ev.registration_opens_at<=asof AND asof<ev.registration_closes_at AND asof<ev.starts_at
   ORDER BY ev.starts_at,ev.id LIMIT 1;
  IF (policy->>'requireOpenTestingWindow')::boolean AND window_record.id IS NOT NULL THEN evidence_count:=evidence_count+1; END IF;
  criteria:=criteria||jsonb_build_array(jsonb_build_object('code','TESTING_WINDOW','sourceId',window_record.id,'outcome',CASE WHEN NOT (policy->>'requireOpenTestingWindow')::boolean THEN 'NOT_REQUIRED' WHEN window_record.id IS NOT NULL THEN 'MET' ELSE 'MISSING' END,'observed',NULL,'required',NULL,'recordedAt',window_record.registration_opens_at));
 END IF;
 criteria:=criteria||jsonb_build_array(jsonb_build_object('code','EVIDENCE','sourceId',NULL,'outcome',CASE WHEN evidence_count>0 THEN 'MET' ELSE 'NOT_MET' END,'observed',evidence_count,'required',1,'recordedAt',NULL));
 -- Latest SINGLE exact next-target candidate wins, including withdrawn/deferred
 -- final results. Stable ties: updated_at DESC, created_at DESC, UUID DESC.
 SELECT jsonb_build_object('id',c.id,'testingEventId',c.testing_event_id,'result',c.result,'recordedAt',c.updated_at) INTO candidate
  FROM hon.testing_candidates c JOIN hon.testing_events ev ON ev.id=c.testing_event_id AND ev.organization_id=org AND ev.school_id=school AND ev.curriculum_id=p_curriculum
  WHERE c.organization_id=org AND c.school_id=school AND c.student_curriculum_enrollment_id=e.id AND c.target_rank_id=next_rank.id AND c.created_at<=asof AND c.updated_at<=asof
  ORDER BY c.updated_at DESC,c.created_at DESC,c.id DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(x ORDER BY ordinal),'[]') INTO blockers FROM jsonb_array_elements(criteria) WITH ORDINALITY AS r(x,ordinal) WHERE x->>'outcome' NOT IN('MET','NOT_REQUIRED');
 readiness_status:=CASE WHEN candidate IS NOT NULL AND candidate->>'result'<>'PENDING' THEN 'TESTING_COMPLETED'
  WHEN candidate IS NOT NULL THEN 'APPROVED_FOR_TESTING'
  WHEN NOT valid OR EXISTS(SELECT 1 FROM jsonb_array_elements(criteria) x WHERE x->>'outcome' IN('NOT_MET','CONFIGURATION_BLOCKER')) THEN 'NOT_ELIGIBLE'
  WHEN jsonb_array_length(blockers)=0 THEN 'ELIGIBLE_INSTRUCTOR_REVIEW' ELSE 'APPROACHING' END;
 RETURN jsonb_build_object('organizationId',org,'schoolId',school,'curriculumId',p_curriculum,'enrollmentId',e.id,'currentRankId',current_rank.id,'nextRankId',next_rank.id,
  'asOf',asof,'status',readiness_status,'policyVersion',policy_version,'policyFingerprint',fingerprint,'criteria',criteria,'blockers',blockers,'candidate',candidate,'attendanceRecordCount',attendance_count,'evidenceCount',evidence_count);
END $$;
REVOKE ALL ON FUNCTION hon.read_promotion_readiness(text,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.read_promotion_readiness(text,uuid,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN GRANT EXECUTE ON FUNCTION hon.read_promotion_readiness(text,uuid,uuid) TO hon_runtime; END IF;
END $$;
COMMIT;
