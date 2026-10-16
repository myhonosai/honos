BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Retention acknowledgement requires trusted migration owner'; END IF;
END $$;
-- Compatibility repairs discovered by the first real known-membership local
-- read: entitlements have no id column and PostgreSQL has no min(uuid).
-- Only those expressions change; the 0098 projection, permissions, read-only
-- behavior and response shape are otherwise preserved verbatim. Applied
-- migration files are never edited.
CREATE OR REPLACE FUNCTION hon.lock_retention_review_actor(p_external_subject text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor uuid;
  v_organization_id uuid := hon.current_organization_id();
  v_school_id uuid := hon.current_school_id();
BEGIN
  PERFORM 1 FROM hon.organizations
  WHERE id = v_organization_id AND status = 'ACTIVE'
 ;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETENTION_REVIEW_FORBIDDEN' USING ERRCODE = '42501'; END IF;

  PERFORM 1 FROM hon.schools
  WHERE id = v_school_id AND organization_id = v_organization_id AND status = 'ACTIVE'
 ;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETENTION_REVIEW_FORBIDDEN' USING ERRCODE = '42501'; END IF;

  v_actor := hon.require_retention_review_actor(p_external_subject);
  PERFORM 1 FROM hon.users WHERE id IN (SELECT user_id FROM hon.principals WHERE id = v_actor);
  PERFORM 1 FROM hon.principals WHERE id = v_actor;
  PERFORM 1 FROM hon.principal_role_grants
  WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id
  ORDER BY id;
  PERFORM 1 FROM hon.roles
  WHERE id IN (SELECT role_id FROM hon.principal_role_grants
               WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id)
  ORDER BY id;
  PERFORM 1 FROM hon.role_permissions
  WHERE role_id IN (SELECT role_id FROM hon.principal_role_grants
                    WHERE principal_id = v_actor AND organization_id = v_organization_id AND school_id = v_school_id)
  ORDER BY role_id, permission_code;
  PERFORM 1 FROM hon.organization_entitlements WHERE organization_id = v_organization_id ORDER BY organization_id;
  RETURN hon.require_retention_review_actor(p_external_subject);
END;
$$;

CREATE OR REPLACE FUNCTION hon.read_retention_review_signals(
  p_external_subject text,
  p_membership_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_organization_id uuid := hon.current_organization_id();
  v_school_id uuid := hon.current_school_id();
  v_as_of timestamptz := date_trunc('milliseconds', statement_timestamp());
  v_attendance_from timestamptz := date_trunc('milliseconds', statement_timestamp()) - interval '28 days';
  v_membership hon.memberships%ROWTYPE;
  v_student_profile_id uuid;
  v_student_count bigint;
  v_review_state text;
  v_reviewed_at timestamptz;
  v_attendance_count bigint := 0;
  v_present_count bigint := 0;
  v_late_count bigint := 0;
  v_makeup_count bigint := 0;
  v_excused_absence_count bigint := 0;
  v_unexcused_absence_count bigint := 0;
  v_enrollment_count bigint := 0;
  v_progress_observation_count bigint := 0;
  v_testing_record_count bigint := 0;
  v_term jsonb;
  v_renewal jsonb;
  v_attendance jsonb;
  v_progression jsonb;
BEGIN
  IF p_external_subject IS NULL OR length(p_external_subject) NOT BETWEEN 1 AND 200 OR p_membership_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;

  PERFORM hon.lock_retention_review_actor(p_external_subject);
  SELECT * INTO v_membership
  FROM hon.memberships
  WHERE id = p_membership_id
    AND organization_id = v_organization_id
    AND school_id = v_school_id
 ;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETENTION_REVIEW_UNAVAILABLE' USING ERRCODE = 'P0002'; END IF;

  SELECT review_version.status, review_version.recorded_at
    INTO v_review_state, v_reviewed_at
  FROM hon.membership_renewal_reviews AS review
  JOIN LATERAL (
    SELECT version_row.status, version_row.recorded_at
    FROM hon.membership_renewal_versions AS version_row
    WHERE version_row.renewal_id = review.id
      AND version_row.organization_id = review.organization_id
      AND version_row.school_id = review.school_id
    ORDER BY version_row.version DESC
    LIMIT 1
  ) AS review_version ON true
  WHERE review.membership_id = v_membership.id
    AND review.organization_id = v_organization_id
    AND review.school_id = v_school_id
  ORDER BY review_version.recorded_at DESC, review.id DESC
  LIMIT 1;

  SELECT count(*), (array_agg(profile.id ORDER BY profile.id))[1]
    INTO v_student_count, v_student_profile_id
  FROM hon.student_profiles AS profile
  WHERE profile.organization_id = v_organization_id
    AND profile.school_id = v_school_id
    AND profile.person_id = v_membership.participant_person_id;

  v_term := jsonb_build_object(
    'status', CASE WHEN v_membership.term_started_at IS NULL OR v_membership.term_ends_at IS NULL THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
    'membershipState', v_membership.state::text,
    'termStartedAt', CASE WHEN v_membership.term_started_at IS NULL THEN NULL ELSE to_char(v_membership.term_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'termEndsAt', CASE WHEN v_membership.term_ends_at IS NULL THEN NULL ELSE to_char(v_membership.term_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'endingObservation', CASE
      WHEN v_membership.term_ends_at IS NULL THEN 'TERM_END_NOT_RECORDED'
      WHEN v_membership.term_ends_at < v_as_of THEN 'TERM_ENDED'
      WHEN v_membership.term_ends_at < v_as_of + interval '30 days' THEN 'ENDING_WITHIN_30_DAYS'
      ELSE 'ENDING_AFTER_30_DAYS'
    END,
    'reason', CASE WHEN v_membership.term_started_at IS NULL OR v_membership.term_ends_at IS NULL THEN 'TERM_DATES_NOT_RECORDED' ELSE NULL END
  );

  v_renewal := jsonb_build_object(
    'status', CASE WHEN v_review_state IS NULL THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
    'latestReviewState', v_review_state,
    'recordedAt', CASE WHEN v_reviewed_at IS NULL THEN NULL ELSE to_char(v_reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'reason', CASE WHEN v_review_state IS NULL THEN 'NO_EXPLICIT_RENEWAL_REVIEW_RECORDED' ELSE NULL END
  );

  IF v_student_count <> 1 THEN
    v_attendance := jsonb_build_object(
      'status', 'UNAVAILABLE',
      'windowFrom', to_char(v_attendance_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'windowTo', to_char(v_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'recordedAttendanceCount', 0,
      'presentCount', 0,
      'lateCount', 0,
      'makeupCount', 0,
      'excusedAbsenceCount', 0,
      'unexcusedAbsenceCount', 0,
      'reason', CASE WHEN v_student_count = 0 THEN 'NO_MATCHING_STUDENT_PROFILE' ELSE 'AMBIGUOUS_STUDENT_PROFILE_LINK' END
    );
    v_progression := jsonb_build_object(
      'status', 'UNAVAILABLE',
      'curriculumEnrollmentCount', 0,
      'progressObservationCount', 0,
      'testingRecordCount', 0,
      'progressObservationAvailability', 'UNAVAILABLE',
      'testingObservationAvailability', 'UNAVAILABLE',
      'reason', CASE WHEN v_student_count = 0 THEN 'NO_MATCHING_STUDENT_PROFILE' ELSE 'AMBIGUOUS_STUDENT_PROFILE_LINK' END
    );
  ELSE
    SELECT count(*),
      count(*) FILTER (WHERE record.status = 'PRESENT'),
      count(*) FILTER (WHERE record.status = 'LATE'),
      count(*) FILTER (WHERE record.status = 'MAKEUP'),
      count(*) FILTER (WHERE record.status = 'EXCUSED_ABSENCE'),
      count(*) FILTER (WHERE record.status = 'UNEXCUSED_ABSENCE')
    INTO v_attendance_count, v_present_count, v_late_count, v_makeup_count, v_excused_absence_count, v_unexcused_absence_count
    FROM hon.attendance_records AS record
    WHERE record.organization_id = v_organization_id
      AND record.school_id = v_school_id
      AND record.student_profile_id = v_student_profile_id
      AND record.recorded_at >= v_attendance_from
      AND record.recorded_at < v_as_of;

    v_attendance := jsonb_build_object(
      'status', CASE WHEN v_attendance_count = 0 THEN 'INSUFFICIENT_DATA' ELSE 'AVAILABLE' END,
      'windowFrom', to_char(v_attendance_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'windowTo', to_char(v_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'recordedAttendanceCount', v_attendance_count,
      'presentCount', v_present_count,
      'lateCount', v_late_count,
      'makeupCount', v_makeup_count,
      'excusedAbsenceCount', v_excused_absence_count,
      'unexcusedAbsenceCount', v_unexcused_absence_count,
      'reason', CASE WHEN v_attendance_count = 0 THEN 'NO_RECORDED_ATTENDANCE_IN_WINDOW' ELSE NULL END
    );

    SELECT count(*) INTO v_enrollment_count
    FROM hon.student_curriculum_enrollments AS enrollment
    WHERE enrollment.organization_id = v_organization_id
      AND enrollment.school_id = v_school_id
      AND enrollment.student_profile_id = v_student_profile_id;

    IF v_enrollment_count > 0 THEN
      SELECT count(*) INTO v_progress_observation_count
      FROM hon.curriculum_progress_observations AS observation
      JOIN hon.student_curriculum_enrollments AS enrollment ON enrollment.id = observation.enrollment_id
        AND enrollment.organization_id = observation.organization_id
        AND enrollment.school_id = observation.school_id
      WHERE enrollment.organization_id = v_organization_id
        AND enrollment.school_id = v_school_id
        AND enrollment.student_profile_id = v_student_profile_id;

      SELECT count(*) INTO v_testing_record_count
      FROM hon.testing_candidates AS candidate
      JOIN hon.student_curriculum_enrollments AS enrollment ON enrollment.id = candidate.student_curriculum_enrollment_id
        AND enrollment.organization_id = candidate.organization_id
        AND enrollment.school_id = candidate.school_id
      WHERE enrollment.organization_id = v_organization_id
        AND enrollment.school_id = v_school_id
        AND enrollment.student_profile_id = v_student_profile_id;
    END IF;

    v_progression := jsonb_build_object(
      'status', CASE WHEN v_enrollment_count = 0 THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
      'curriculumEnrollmentCount', v_enrollment_count,
      'progressObservationCount', v_progress_observation_count,
      'testingRecordCount', v_testing_record_count,
      'progressObservationAvailability', CASE WHEN v_progress_observation_count = 0 THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
      'testingObservationAvailability', CASE WHEN v_testing_record_count = 0 THEN 'UNAVAILABLE' ELSE 'AVAILABLE' END,
      'reason', CASE WHEN v_enrollment_count = 0 THEN 'NO_CURRICULUM_ENROLLMENT_RECORDED' ELSE NULL END
    );
  END IF;

  PERFORM hon.require_retention_review_actor(p_external_subject);
  RETURN jsonb_build_object(
    'schemaVersion', 'RETENTION_REVIEW_SIGNALS_V1',
    'membershipId', v_membership.id,
    'observedAt', to_char(v_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'humanOnly', true,
    'readOnly', true,
    'evidenceOnly', true,
    'predictionOrAutomaticAction', false,
    'membershipTerm', v_term,
    'renewalReview', v_renewal,
    'followUp', jsonb_build_object(
      'status', 'UNAVAILABLE',
      'reason', 'NO_UNAMBIGUOUS_MEMBERSHIP_TO_FOLLOW_UP_RELATION'
    ),
    'attendance', v_attendance,
    'progression', v_progression
  );
END;
$$;


INSERT INTO hon.permissions(code,description,is_sensitive,is_staff_assignable)
VALUES('retention.review.acknowledge','Direct human acknowledgement of exact redacted retention evidence only',true,true) ON CONFLICT(code) DO NOTHING;
INSERT INTO hon.role_permissions(role_id,organization_id,permission_code)
SELECT id,organization_id,'retention.review.acknowledge' FROM hon.roles WHERE is_system_role AND code='OWNER' ON CONFLICT DO NOTHING;

CREATE TABLE hon.retention_review_acknowledgements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 membership_id uuid NOT NULL, actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
 evidence_version text NOT NULL CHECK(evidence_version='RETENTION_REVIEW_SIGNALS_V1'),
 evidence_fingerprint text NOT NULL CHECK(evidence_fingerprint ~ '^[0-9a-f]{64}$'),
 observed_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'EVIDENCE_REVIEWED' CHECK(state='EVIDENCE_REVIEWED'),
 CHECK(recorded_at>=observed_at AND recorded_at<=observed_at+interval '5 minutes'),
 UNIQUE(id,organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at),
 FOREIGN KEY(membership_id,organization_id,school_id) REFERENCES hon.memberships(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE TABLE hon.retention_review_acknowledgement_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 membership_id uuid NOT NULL, actor_principal_id uuid NOT NULL, acknowledgement_id uuid NOT NULL UNIQUE,
 idempotency_digest bytea NOT NULL CHECK(octet_length(idempotency_digest)=32),
 evidence_version text NOT NULL, evidence_fingerprint text NOT NULL, observed_at timestamptz NOT NULL,
 UNIQUE(organization_id,school_id,actor_principal_id,idempotency_digest),
 FOREIGN KEY(acknowledgement_id,organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at)
 REFERENCES hon.retention_review_acknowledgements(id,organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at) ON DELETE RESTRICT
);
CREATE TABLE hon.retention_review_acknowledgement_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, school_id uuid NOT NULL,
 membership_id uuid NOT NULL, actor_principal_id uuid NOT NULL, acknowledgement_id uuid NOT NULL UNIQUE,
 evidence_version text NOT NULL, evidence_fingerprint text NOT NULL, observed_at timestamptz NOT NULL,
 event_code text NOT NULL DEFAULT 'retention.evidence_reviewed.v1' CHECK(event_code='retention.evidence_reviewed.v1'),
 state text NOT NULL DEFAULT 'INERT' CHECK(state='INERT'),
 FOREIGN KEY(acknowledgement_id,organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at)
 REFERENCES hon.retention_review_acknowledgements(id,organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at) ON DELETE RESTRICT
);
-- No RLS policy at all: only fixed trusted functions may access these records.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['retention_review_acknowledgements','retention_review_acknowledgement_receipts','retention_review_acknowledgement_outbox'] LOOP
  EXECUTE format('ALTER TABLE hon.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE hon.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON hon.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER retention_ack_immutable BEFORE UPDATE OR DELETE ON hon.%I FOR EACH ROW EXECUTE FUNCTION hon.guard_campaign_history()',t);
  EXECUTE format('CREATE TRIGGER retention_ack_no_truncate BEFORE TRUNCATE ON hon.%I FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_campaign_history()',t);
 END LOOP;
END $$;

CREATE FUNCTION hon.require_retention_acknowledgement_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); instant timestamptz:=clock_timestamp();
BEGIN
 actor:=hon.require_retention_review_actor(p_subject);
 IF p_subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
  OR NOT EXISTS(SELECT 1 FROM hon.organizations WHERE id=org AND status='ACTIVE')
  OR NOT EXISTS(SELECT 1 FROM hon.schools WHERE id=school AND organization_id=org AND status='ACTIVE')
  OR EXISTS(SELECT 1 FROM hon.family_access_grants WHERE principal_id=actor AND effective_from<=instant AND (effective_until IS NULL OR effective_until>instant))
  OR (SELECT count(*) FROM hon.organization_entitlements WHERE organization_id=org AND status='ACTIVE' AND tier IN('ESSENTIAL','CORE','COMPLETE') AND effective_from<=instant AND (effective_until IS NULL OR effective_until>instant))<>1
  OR (SELECT count(DISTINCT rp.permission_code) FROM hon.principal_role_grants g
   JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
   JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id
   WHERE g.principal_id=actor AND g.organization_id=org AND g.school_id=school
    AND g.revoked_at IS NULL AND g.effective_from<=instant AND (g.effective_until IS NULL OR g.effective_until>instant)
    AND (r.management_school_id IS NULL OR r.management_school_id=school)
    AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
    AND rp.permission_code IN('retention.review.read','retention.review.acknowledge'))<>2 THEN
  RAISE EXCEPTION 'RETENTION_ACKNOWLEDGEMENT_FORBIDDEN' USING ERRCODE='42501';
 END IF;
 RETURN actor;
END $$;

-- Exact redacted JSON digest. To recheck the same observation, retain its server
-- observation clock/window labels while comparing all *current* observed facts.
-- New evidence entering/leaving the live 28-day window, term boundaries, renewal,
-- progression or testing counts conflicts. No source identity/PII is hashed.
CREATE FUNCTION hon.retention_review_evidence_fingerprint(p_signals jsonb,p_observed_at timestamptz) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT encode(sha256(convert_to(
  jsonb_set(jsonb_set(jsonb_set(p_signals,'{observedAt}',to_jsonb(to_char(p_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
   '{attendance,windowTo}',to_jsonb(to_char(p_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
   '{attendance,windowFrom}',to_jsonb(to_char((p_observed_at-interval '28 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))::text,'UTF8')),'hex')
$$;
CREATE FUNCTION hon.read_retention_review_acknowledgement_evidence(p_subject text,p_membership uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE signals jsonb;
BEGIN
 PERFORM hon.require_retention_acknowledgement_actor(p_subject);
 signals:=hon.read_retention_review_signals(p_subject,p_membership);
 PERFORM hon.require_retention_acknowledgement_actor(p_subject);
 RETURN jsonb_build_object('signals',signals,'evidenceVersion','RETENTION_REVIEW_SIGNALS_V1',
  'evidenceFingerprint',hon.retention_review_evidence_fingerprint(signals,(signals->>'observedAt')::timestamptz));
END $$;

CREATE FUNCTION hon.acknowledge_retention_review_evidence(p_subject text,p_membership uuid,p_version text,p_fingerprint text,p_observed_at timestamptz,p_key uuid,p_request uuid,p_correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); signals jsonb;
 receipt hon.retention_review_acknowledgement_receipts%ROWTYPE; acknowledgement hon.retention_review_acknowledgements%ROWTYPE;
 key_digest bytea; result jsonb; instant timestamptz;
BEGIN
 actor:=hon.require_retention_acknowledgement_actor(p_subject);
 IF p_membership IS NULL OR p_version IS DISTINCT FROM 'RETENTION_REVIEW_SIGNALS_V1' OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$'
  OR p_observed_at IS NULL OR NOT isfinite(p_observed_at) OR p_observed_at<>date_trunc('milliseconds',p_observed_at)
  OR p_key IS NULL OR p_request IS NULL OR p_correlation IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 -- Stable alphabetic relation locks close INSERT/DELETE phantoms as well as row
 -- changes, including authority revocation. No source row is changed. These
 -- deliberately coarse SHARE locks are limited to this tiny manual command.
 LOCK TABLE hon.attendance_records,hon.curriculum_progress_observations,hon.family_access_grants,hon.hq_operator_grants,
  hon.membership_renewal_reviews,hon.membership_renewal_versions,hon.memberships,hon.organization_entitlements,hon.organizations,
  hon.permissions,hon.principal_role_grants,hon.principals,hon.role_permissions,hon.roles,hon.schools,hon.student_curriculum_enrollments,
  hon.student_profiles,hon.testing_candidates,hon.users IN SHARE MODE;
 actor:=hon.require_retention_acknowledgement_actor(p_subject);
 key_digest:=sha256(convert_to(p_key::text,'UTF8'));
 PERFORM pg_advisory_xact_lock(hashtextextended('retention.ack:'||org::text||':'||school::text||':'||actor::text||':'||p_key::text,0));
 -- Recompute from the unchanged canonical read, never from browser evidence.
 signals:=hon.read_retention_review_signals(p_subject,p_membership);
 PERFORM hon.require_retention_acknowledgement_actor(p_subject);
 instant:=date_trunc('milliseconds',clock_timestamp());
 IF p_observed_at>instant OR p_observed_at<instant-interval '5 minutes'
  OR hon.retention_review_evidence_fingerprint(signals,p_observed_at) IS DISTINCT FROM p_fingerprint THEN
  RAISE EXCEPTION 'RETENTION_EVIDENCE_CONFLICT' USING ERRCODE='40001';
 END IF;
 SELECT * INTO receipt FROM hon.retention_review_acknowledgement_receipts
 WHERE organization_id=org AND school_id=school AND actor_principal_id=actor AND idempotency_digest=key_digest;
 IF receipt.id IS NOT NULL THEN
  IF receipt.membership_id IS DISTINCT FROM p_membership OR receipt.evidence_version IS DISTINCT FROM p_version
   OR receipt.evidence_fingerprint IS DISTINCT FROM p_fingerprint OR receipt.observed_at IS DISTINCT FROM p_observed_at THEN
   RAISE EXCEPTION 'RETENTION_REPLAY_CONFLICT' USING ERRCODE='40001';
  END IF;
  SELECT * INTO acknowledgement FROM hon.retention_review_acknowledgements WHERE id=receipt.acknowledgement_id;
 ELSE
  INSERT INTO hon.retention_review_acknowledgements(organization_id,school_id,membership_id,actor_principal_id,evidence_version,evidence_fingerprint,observed_at,recorded_at)
  VALUES(org,school,p_membership,actor,p_version,p_fingerprint,p_observed_at,instant) RETURNING * INTO acknowledgement;
 END IF;
 result:=jsonb_build_object('schemaVersion','RETENTION_REVIEW_ACKNOWLEDGEMENT_V1','membershipId',p_membership,
  'acknowledgementId',acknowledgement.id,'evidenceVersion',p_version,'evidenceFingerprint',p_fingerprint,
  'observedAt',to_char(p_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'recordedAt',to_char(acknowledgement.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'state','EVIDENCE_REVIEWED','humanOnly',true,'evidenceOnly',true,'noDownstreamEffect',true);
 IF receipt.id IS NULL THEN
  INSERT INTO hon.retention_review_acknowledgement_receipts(organization_id,school_id,membership_id,actor_principal_id,acknowledgement_id,idempotency_digest,evidence_version,evidence_fingerprint,observed_at)
  VALUES(org,school,p_membership,actor,acknowledgement.id,key_digest,p_version,p_fingerprint,p_observed_at);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
  VALUES(org,school,actor,'HUMAN_UI','retention.review.acknowledge','retention_review_acknowledgement',acknowledgement.id,NULL,result,'SUCCEEDED',p_request,p_correlation);
  INSERT INTO hon.retention_review_acknowledgement_outbox(organization_id,school_id,membership_id,actor_principal_id,acknowledgement_id,evidence_version,evidence_fingerprint,observed_at)
  VALUES(org,school,p_membership,actor,acknowledgement.id,p_version,p_fingerprint,p_observed_at);
 END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION hon.require_retention_acknowledgement_actor(text),hon.retention_review_evidence_fingerprint(jsonb,timestamptz),hon.read_retention_review_acknowledgement_evidence(text,uuid),hon.acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE r text; t text; f text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  FOREACH t IN ARRAY ARRAY['retention_review_acknowledgements','retention_review_acknowledgement_receipts','retention_review_acknowledgement_outbox'] LOOP
   EXECUTE format('REVOKE ALL ON hon.%I FROM %I',t,r);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['require_retention_acknowledgement_actor(text)','retention_review_evidence_fingerprint(jsonb,timestamptz)','read_retention_review_acknowledgement_evidence(text,uuid)','acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid)'] LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION hon.%s FROM %I',f,r);
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_retention_review_acknowledgement_evidence(text,uuid),hon.acknowledge_retention_review_evidence(text,uuid,text,text,timestamptz,uuid,uuid,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
