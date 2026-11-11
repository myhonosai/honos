BEGIN;

-- M1 (migration number 0259, allocated by the coordinator 2026-11-11 under the owner's delegation): Maya, Retention,
-- part 1. A read-only list of the current school's students at risk of quitting, each with the plain reasons behind
-- the score and one suggested next step. Doc: docs/architecture/MAYA_AT_RISK_STUDENTS.md.
--
-- Rules (fixed in this migration; any change is a new reviewed migration):
--   Checked: ACTIVE, FROZEN and CANCELLATION_PENDING memberships of the school whose participant has a student profile
--   at the school. Attendance counts PRESENT, LATE and MAKEUP at class sessions that have started.
--   LONG_ABSENCE      not FROZEN; last attendance 14+ days ago (45 points at 30+ days, else 30), or never attended and
--                     the membership started 14+ days ago (30 points).
--   ATTENDANCE_DROP   not FROZEN; 4+ attendances 28-56 days ago and the last 28 days under half of that (25 points).
--   NO_RANK_PROGRESS  an ACTIVE curriculum enrollment 180+ days old and no PROMOTED decision in 180 days (15 points).
--   TUITION_OVERDUE   an ISSUED invoice of the membership (or of its billing account with no membership) past its due
--                     time with an unpaid balance after unvoided 0240 payment records (20 points). Billing data: evaluated only when the reader also holds a billing
--                     read permission at this school; otherwise tuitionChecked is false and the factor never appears.
--   TERM_ENDING       CANCELLATION_PENDING, or a term that ends within 30 days (20 points).
--   One row per student: when a student holds more than one checked membership, the membership with the highest score
--   is shown (ties: lowest membership id). Score is the sum, at most 100. HIGH >= 50, MEDIUM 30-49, WATCH 15-29. A ranking aid, not a prediction.
--   The suggested next step comes from the first factor (most points, then the fixed order above with
--   TUITION_OVERDUE and TERM_ENDING before ATTENDANCE_DROP): CALL_TO_CHECK_IN, INVITE_BACK_TO_CLASS,
--   PLAN_PROGRESS_TALK, REVIEW_TUITION_BALANCE, DISCUSS_RENEWAL.
-- Who: a direct human staff member (browser session, no Action Engine request, no delegation, not HQ, no family role)
-- with retention.review.read live at this exact school, active organization and school, and an active paid
-- entitlement; re-checked after the read. Output: names and record-derived numbers only, no contact details, family,
-- notes or amounts. No table is written and the runtime gains EXECUTE on the single read only. No AI is called.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Maya at-risk students require a trusted migration owner';
  END IF;
  IF to_regclass('hon.invoice_payment_records') IS NULL OR to_regprocedure('hon.membership_school_today()') IS NULL
    OR to_regprocedure('hon.staff_member_eligible(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.require_tuition_reader(text)') IS NULL OR to_regprocedure('hon.saas_ts(timestamptz)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM hon.permissions WHERE code='retention.review.read') THEN
    RAISE EXCEPTION 'Maya at-risk students require 0097, 0154, 0224 and 0240';
  END IF;
END $$;

-- The direct human staff member, holding one exact permission live at the current school (0240 rules).
CREATE FUNCTION hon.require_maya_actor(subject text, permission text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF permission IS NULL OR permission <>'retention.review.read'
    OR subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'MAYA_AT_RISK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=subject AND p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid
    AND p.principal_type='HUMAN_USER' AND p.is_active
    AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active)=1
    AND EXISTS(SELECT 1 FROM hon.organizations o WHERE o.id=org AND o.status='ACTIVE')
    AND EXISTS(SELECT 1 FROM hon.schools s WHERE s.id=school AND s.organization_id=org AND s.status='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM hon.family_access_grants f WHERE f.principal_id=p.id AND f.effective_from<=clock_timestamp() AND (f.effective_until IS NULL OR f.effective_until>clock_timestamp()))
    AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      WHERE g.principal_id=p.id AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND r.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)')
    AND hon.staff_member_eligible(p.id,org,school)
    AND EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id
      JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=r.organization_id JOIN hon.permissions x ON x.code=rp.permission_code
      WHERE g.principal_id=p.id AND g.organization_id=org AND g.school_id=school AND g.revoked_at IS NULL
        AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
        AND (r.management_school_id IS NULL OR r.management_school_id=school)
        AND r.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND x.code=permission AND x.is_staff_assignable)
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'MAYA_AT_RISK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- True when the actor may also read tuition balances at the current school (the 0240 reader rule, unchanged).
CREATE FUNCTION hon.maya_reader_sees_tuition(subject text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  PERFORM hon.require_tuition_reader(subject); RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;

CREATE FUNCTION hon.read_maya_at_risk_students(subject text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; tuition boolean;
  at timestamptz:=clock_timestamp(); tz text; today date; after_score integer; after_id uuid;
  rows jsonb; page jsonb; more boolean; counts jsonb; result jsonb;
BEGIN
  actor:=hon.require_maya_actor(subject,'retention.review.read');
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x<>'after')
    OR (p ? 'after' AND (jsonb_typeof(p->'after') IS DISTINCT FROM 'string'
      OR p->>'after' !~* '^(100|[1-9][0-9]|[0-9]):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF p ? 'after' THEN after_score:=split_part(p->>'after',':',1)::integer; after_id:=lower(split_part(p->>'after',':',2))::uuid; END IF;
  tuition:=hon.maya_reader_sees_tuition(subject);
  today:=hon.membership_school_today();
  SELECT s.timezone INTO tz FROM hon.schools s WHERE s.id=school AND s.organization_id=org;

  WITH m AS (
    SELECT ms.id membership_id, ms.billing_account_id, ms.state::text state, ms.term_ends_at, coalesce(ms.term_started_at,ms.created_at) started_at,
      sp.id profile_id, pp.given_name, pp.family_name
    FROM hon.memberships ms
    JOIN hon.people pp ON pp.id=ms.participant_person_id AND pp.organization_id=org AND pp.school_id=school
    JOIN hon.student_profiles sp ON sp.person_id=ms.participant_person_id AND sp.organization_id=org AND sp.school_id=school
    WHERE ms.organization_id=org AND ms.school_id=school AND ms.state IN ('ACTIVE','FROZEN','CANCELLATION_PENDING')),
  att AS (
    SELECT m.membership_id, max(cs.starts_at) last_seen,
      count(*) FILTER (WHERE cs.starts_at>=at-interval '672 hours') recent,
      count(*) FILTER (WHERE cs.starts_at>=at-interval '1344 hours' AND cs.starts_at<at-interval '672 hours') prior
    FROM m JOIN hon.attendance_records a ON a.student_profile_id=m.profile_id AND a.organization_id=org AND a.school_id=school
      AND a.status IN ('PRESENT','LATE','MAKEUP')
    JOIN hon.class_sessions cs ON cs.id=a.class_session_id AND cs.organization_id=org AND cs.school_id=school AND cs.starts_at<=at
    GROUP BY m.membership_id),
  rk AS (
    SELECT m.membership_id, min(e.enrolled_at) first_enrolled,
      (SELECT max(d.decided_at) FROM hon.promotion_decisions d JOIN hon.student_curriculum_enrollments x ON x.id=d.student_curriculum_enrollment_id
        AND x.organization_id=org AND x.school_id=school
       WHERE x.student_profile_id=m.profile_id AND d.organization_id=org AND d.school_id=school AND d.status='PROMOTED' AND d.decided_at<=at) last_promoted
    FROM m JOIN hon.student_curriculum_enrollments e ON e.student_profile_id=m.profile_id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE'
    GROUP BY m.membership_id, m.profile_id),
  tu AS (
    SELECT m.membership_id, count(*) overdue
    FROM m JOIN hon.invoices i ON (i.membership_id=m.membership_id OR (i.membership_id IS NULL AND i.billing_account_id=m.billing_account_id))
      AND i.organization_id=org AND i.school_id=school AND i.status='ISSUED'
      AND i.due_at IS NOT NULL AND i.due_at<at
      AND i.total_minor>(SELECT coalesce(sum(x.amount_minor),0) FROM hon.invoice_payment_records x WHERE x.invoice_id=i.id AND x.voided_at IS NULL)
    WHERE tuition
    GROUP BY m.membership_id),
  f AS (
    SELECT m.*, x.factor
    FROM m LEFT JOIN att ON att.membership_id=m.membership_id LEFT JOIN rk ON rk.membership_id=m.membership_id LEFT JOIN tu ON tu.membership_id=m.membership_id
    CROSS JOIN LATERAL (VALUES
      (CASE WHEN m.state<>'FROZEN' AND att.last_seen IS NOT NULL AND att.last_seen<=at-interval '336 hours' THEN
         jsonb_build_object('code','LONG_ABSENCE','points',CASE WHEN att.last_seen<=at-interval '720 hours' THEN 45 ELSE 30 END,'rank',1,
           'daysSinceLastAttendance',floor(extract(epoch FROM at-att.last_seen)/86400)::integer,'neverAttended',false)
       WHEN m.state<>'FROZEN' AND att.last_seen IS NULL AND m.started_at<=at-interval '336 hours' THEN
         jsonb_build_object('code','LONG_ABSENCE','points',30,'rank',1,'daysSinceLastAttendance',NULL,'neverAttended',true) END),
      (CASE WHEN tu.overdue>0 THEN jsonb_build_object('code','TUITION_OVERDUE','points',20,'rank',2,'overdueInvoiceCount',tu.overdue) END),
      (CASE WHEN m.state='CANCELLATION_PENDING' OR (m.term_ends_at IS NOT NULL AND m.term_ends_at>=at AND m.term_ends_at<at+interval '720 hours') THEN
         jsonb_build_object('code','TERM_ENDING','points',20,'rank',3,'cancellationPending',m.state='CANCELLATION_PENDING',
           'termEndsOn',CASE WHEN m.term_ends_at IS NULL THEN NULL ELSE to_char((m.term_ends_at AT TIME ZONE tz)::date,'YYYY-MM-DD') END) END),
      (CASE WHEN m.state<>'FROZEN' AND coalesce(att.prior,0)>=4 AND coalesce(att.recent,0)*2<att.prior THEN
         jsonb_build_object('code','ATTENDANCE_DROP','points',25,'rank',4,'last28Days',coalesce(att.recent,0),'previous28Days',att.prior) END),
      (CASE WHEN rk.first_enrolled IS NOT NULL AND rk.first_enrolled<=at-interval '4320 hours'
            AND (rk.last_promoted IS NULL OR rk.last_promoted<=at-interval '4320 hours') THEN
         jsonb_build_object('code','NO_RANK_PROGRESS','points',15,'rank',5,
           'daysSinceProgress',floor(extract(epoch FROM at-coalesce(rk.last_promoted,rk.first_enrolled))/86400)::integer) END)
    ) x(factor)
    WHERE x.factor IS NOT NULL),
  per_membership AS (
    SELECT membership_id, profile_id, state, given_name, family_name, least(100,sum((factor->>'points')::integer))::integer score,
      jsonb_agg(factor-'rank' ORDER BY (factor->>'points')::integer DESC,(factor->>'rank')::integer) factors
    FROM f GROUP BY membership_id, profile_id, state, given_name, family_name),
  scored AS (
    SELECT DISTINCT ON (profile_id) * FROM per_membership ORDER BY profile_id, score DESC, membership_id)
  SELECT coalesce(jsonb_agg(jsonb_build_object('membershipId',s.membership_id,'givenName',s.given_name,'familyName',s.family_name,
      'membershipState',s.state,'score',s.score,'level',CASE WHEN s.score>=50 THEN 'HIGH' WHEN s.score>=30 THEN 'MEDIUM' ELSE 'WATCH' END,
      'factors',s.factors,
      'suggestedNextStep',CASE s.factors->0->>'code' WHEN 'LONG_ABSENCE' THEN 'CALL_TO_CHECK_IN' WHEN 'ATTENDANCE_DROP' THEN 'INVITE_BACK_TO_CLASS'
        WHEN 'NO_RANK_PROGRESS' THEN 'PLAN_PROGRESS_TALK' WHEN 'TUITION_OVERDUE' THEN 'REVIEW_TUITION_BALANCE' ELSE 'DISCUSS_RENEWAL' END)
    ORDER BY s.score DESC, s.membership_id),'[]'::jsonb)
  INTO rows FROM scored s WHERE s.score>=15;

  SELECT jsonb_build_object('HIGH',count(*) FILTER (WHERE x->>'level'='HIGH'),'MEDIUM',count(*) FILTER (WHERE x->>'level'='MEDIUM'),
      'WATCH',count(*) FILTER (WHERE x->>'level'='WATCH'))
    INTO counts FROM jsonb_array_elements(rows) x;
  SELECT coalesce(jsonb_agg(x ORDER BY n),'[]'::jsonb), count(*)>50 INTO page, more FROM (
    SELECT x, n FROM jsonb_array_elements(rows) WITH ORDINALITY e(x,n)
    WHERE after_id IS NULL OR (x->>'score')::integer<after_score OR ((x->>'score')::integer=after_score AND (x->>'membershipId')::uuid>after_id)
    ORDER BY n LIMIT 51) z;
  IF more THEN page:=page-50; END IF;
  result:=jsonb_build_object('schemaVersion','MAYA_AT_RISK_V1','asOf',hon.saas_ts(at),'localToday',to_char(today,'YYYY-MM-DD'),
    'tuitionChecked',tuition,'counts',counts,'items',page,
    'nextAfter',CASE WHEN more THEN (page->49->>'score')||':'||(page->49->>'membershipId') END);
  -- Authority is proved again after the read; a lapse during the read returns nothing.
  IF hon.require_maya_actor(subject,'retention.review.read') IS DISTINCT FROM actor
    OR hon.maya_reader_sees_tuition(subject) IS DISTINCT FROM tuition THEN
    RAISE EXCEPTION 'MAYA_AT_RISK_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;
COMMENT ON FUNCTION hon.read_maya_at_risk_students(text,jsonb) IS
'Direct HUMAN_UI read-only list of the current school''s students at risk (Maya M1, 0259): record-derived factors, score, level and suggested next step. No DML, no AI.';

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.require_maya_actor(text,text),hon.maya_reader_sees_tuition(text),hon.read_maya_at_risk_students(text,jsonb) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.require_maya_actor(text,text),hon.maya_reader_sees_tuition(text),hon.read_maya_at_risk_students(text,jsonb) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_maya_at_risk_students(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
