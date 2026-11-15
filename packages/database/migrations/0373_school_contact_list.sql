BEGIN;

-- C1 (0373, allocated by the coordinator 2026-11-15): the contacts list with segments and filters. Owner (David),
-- 2026-11-15 08:23Z, on the Manus CRM ideas: "Apply all." Idea #13: segment chips with counts, filters for belt, program,
-- membership plan and membership end date, and an end-date badge on each row.
-- One read-only entry point, hon.read_school_contact_list(subject, input), for the session school only. Authority: a direct
-- human at the session school with live people.read, an active school and organization and an active HON entitlement;
-- HQ, family, delegated and automated callers are refused. It returns names, email and phone (as the people directory
-- already does for people.read) plus segment, ranks, current plan and its end date. Nothing is written, sent or charged.
-- Segments, one per person, first match wins:
--   STUDENT   a membership (not a draft) counts now: from its term start until the first of its term end or its recorded
--             cancellation (the 0331 rule; paused memberships count).
--   TRIAL     the main person on an open lead with a trial appointment that is not cancelled.
--   PROSPECT  the main person on an open lead.
--   INACTIVE  had a membership (not a draft) that no longer counts.
--   OTHER     anyone else (guardians, payers); listed under All only.
-- Staff are school users, not people records, so they stay on the Team page.
-- Filters (rank, program, plan, ends within N days) apply to the current membership and active rank, so they narrow to
-- students. Counts per segment use the search and filters but not the segment choice.

-- Direct human at the session school with people.read, or an error.
CREATE FUNCTION hon.require_school_contacts_actor(subject text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid;
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
    OR org IS NULL OR school IS NULL THEN RAISE EXCEPTION 'SCHOOL_CONTACTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
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
        AND x.code='people.read')
    AND EXISTS(SELECT 1 FROM hon.organization_entitlements e WHERE e.organization_id=org AND e.status='ACTIVE'
      AND e.tier IN ('ESSENTIAL','CORE','COMPLETE') AND e.effective_from<=clock_timestamp() AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()));
  IF actor IS NULL THEN RAISE EXCEPTION 'SCHOOL_CONTACTS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN actor;
END $$;

-- One row per person of the school with its segment and current membership facts (private; callers proved authority).
CREATE FUNCTION hon.school_contact_facts(org uuid, school uuid, as_of timestamptz)
RETURNS TABLE(person_id uuid, segment text, membership_id uuid, plan_id uuid, plan_name text, program_id uuid, program_name text, plan_code text, ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH counted AS (
    SELECT x.participant_person_id AS person_id, x.id AS membership_id, x.plan_code, x.term_started_at, x.term_ends_at,
      CASE WHEN c.at IS NULL THEN x.term_ends_at WHEN x.term_ends_at IS NULL THEN c.at ELSE least(c.at, x.term_ends_at) END AS ended
    FROM hon.memberships x
    LEFT JOIN LATERAL (SELECT min(a.occurred_at) AS at FROM hon.audit_events a
      WHERE a.organization_id=org AND a.school_id=school AND a.entity_id=x.id AND a.action_code='billing.membership.cancel'
        AND a.result='SUCCEEDED' AND a.entity_type='MEMBERSHIP') c ON true
    WHERE x.organization_id=org AND x.school_id=school AND x.state<>'DRAFT' AND x.term_started_at IS NOT NULL
      AND NOT (x.state='CANCELLED' AND c.at IS NULL)
  ),
  cur AS (
    SELECT DISTINCT ON (m.person_id) m.person_id, m.membership_id, m.plan_code, m.term_ends_at
    FROM counted m WHERE m.term_started_at <= as_of AND (m.ended IS NULL OR m.ended > as_of)
    ORDER BY m.person_id, m.term_started_at DESC, m.membership_id
  ),
  former AS (SELECT DISTINCT x.participant_person_id AS person_id FROM hon.memberships x
    WHERE x.organization_id=org AND x.school_id=school AND x.state<>'DRAFT' AND x.term_started_at IS NOT NULL),
  open_leads AS (SELECT l.primary_person_id AS person_id,
      bool_or(EXISTS(SELECT 1 FROM hon.crm_appointments a WHERE a.organization_id=org AND a.school_id=school AND a.crm_lead_id=l.id
        AND a.appointment_type='TRIAL' AND a.status<>'CANCELLED')) AS trial
    FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school AND l.status='OPEN' GROUP BY l.primary_person_id)
  SELECT p.id,
    CASE WHEN c.person_id IS NOT NULL THEN 'STUDENT' WHEN o.trial THEN 'TRIAL' WHEN o.person_id IS NOT NULL THEN 'PROSPECT'
      WHEN f.person_id IS NOT NULL THEN 'INACTIVE' ELSE 'OTHER' END,
    c.membership_id, v.plan_id, btrim(v.display_name), v.program_id, btrim(g.name), c.plan_code, c.term_ends_at
  FROM hon.people p
  LEFT JOIN cur c ON c.person_id=p.id
  LEFT JOIN open_leads o ON o.person_id=p.id
  LEFT JOIN former f ON f.person_id=p.id
  LEFT JOIN hon.membership_plan_selections s ON s.membership_id=c.membership_id AND s.organization_id=org AND s.school_id=school
  LEFT JOIN hon.membership_plan_versions v ON v.plan_id=s.plan_id AND v.version=s.plan_version AND v.organization_id=org AND v.school_id=school
  LEFT JOIN hon.programs g ON g.id=v.program_id AND g.organization_id=org AND g.school_id=school
  WHERE p.organization_id=org AND p.school_id=school
$$;

-- The session school's contacts page. Input keys (all optional): segment ALL|STUDENT|TRIAL|PROSPECT|INACTIVE, query (text,
-- 1..100), rankId, programId, planId (uuid), endsWithinDays (7|30|60|90: the current membership ends within that many days),
-- afterId (uuid: continue after this person in name order), options (true: also list the rank, program and plan choices).
CREATE FUNCTION hon.read_school_contact_list(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); as_of timestamptz:=statement_timestamp();
  seg text:='ALL'; needle text; rank_f uuid; program_f uuid; plan_f uuid; days integer; after_id uuid; with_options boolean:=false;
  a_family text; a_given text; a_created timestamptz; rows_json jsonb; more boolean; counts jsonb; options jsonb:=NULL;
  lim constant integer:=50; uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  PERFORM hon.require_school_contacts_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('segment','query','rankId','programId','planId','endsWithinDays','afterId','options'))
    OR (p_input ? 'segment' AND (jsonb_typeof(p_input->'segment')<>'string' OR p_input->>'segment' NOT IN ('ALL','STUDENT','TRIAL','PROSPECT','INACTIVE')))
    OR (p_input ? 'query' AND (jsonb_typeof(p_input->'query')<>'string' OR length(p_input->>'query') NOT BETWEEN 1 AND 100 OR p_input->>'query' ~ '[[:cntrl:]]'))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['rankId','programId','planId','afterId']) k WHERE p_input ? k AND (jsonb_typeof(p_input->k)<>'string' OR lower(p_input->>k) !~ uuid_re))
    OR (p_input ? 'endsWithinDays' AND (jsonb_typeof(p_input->'endsWithinDays')<>'number' OR p_input->>'endsWithinDays' NOT IN ('7','30','60','90')))
    OR (p_input ? 'options' AND jsonb_typeof(p_input->'options')<>'boolean') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  seg:=coalesce(p_input->>'segment','ALL'); needle:=nullif(btrim(p_input->>'query'),'');
  rank_f:=(p_input->>'rankId')::uuid; program_f:=(p_input->>'programId')::uuid; plan_f:=(p_input->>'planId')::uuid;
  days:=(p_input->>'endsWithinDays')::integer; after_id:=(p_input->>'afterId')::uuid; with_options:=coalesce((p_input->>'options')::boolean,false);
  IF after_id IS NOT NULL THEN
    SELECT family_name, given_name, created_at INTO a_family, a_given, a_created FROM hon.people WHERE id=after_id AND organization_id=org AND school_id=school;
    IF NOT FOUND THEN RAISE EXCEPTION 'SCHOOL_CONTACTS_STALE_CURSOR' USING ERRCODE='22023'; END IF;
  END IF;

  WITH hits AS MATERIALIZED (
    SELECT f.*, p.given_name, p.family_name, p.email::text AS email, p.phone_e164, p.version, p.created_at
    FROM hon.school_contact_facts(org, school, as_of) f JOIN hon.people p ON p.id=f.person_id AND p.organization_id=org AND p.school_id=school
    WHERE (needle IS NULL OR concat_ws(' ', p.given_name, p.family_name, p.email::text, p.phone_e164) ILIKE '%' || needle || '%')
      AND (program_f IS NULL OR f.program_id=program_f) AND (plan_f IS NULL OR f.plan_id=plan_f)
      AND (days IS NULL OR (f.membership_id IS NOT NULL AND f.ends_at IS NOT NULL AND f.ends_at <= as_of + make_interval(days => days)))
      AND (rank_f IS NULL OR EXISTS(SELECT 1 FROM hon.student_profiles sp JOIN hon.student_curriculum_enrollments e
        ON e.student_profile_id=sp.id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE' AND e.current_rank_id=rank_f
        WHERE sp.person_id=f.person_id AND sp.organization_id=org AND sp.school_id=school))
  ), page AS (
    SELECT h.* FROM hits h
    WHERE (seg='ALL' OR h.segment=seg)
      AND (after_id IS NULL OR (h.family_name, h.given_name, h.created_at, h.person_id) > (a_family, a_given, a_created, after_id))
    ORDER BY h.family_name, h.given_name, h.created_at, h.person_id LIMIT lim + 1
  ), shown AS (SELECT * FROM page ORDER BY family_name, given_name, created_at, person_id LIMIT lim)
  SELECT (SELECT jsonb_build_object('ALL', count(*), 'STUDENT', count(*) FILTER (WHERE segment='STUDENT'), 'TRIAL', count(*) FILTER (WHERE segment='TRIAL'),
      'PROSPECT', count(*) FILTER (WHERE segment='PROSPECT'), 'INACTIVE', count(*) FILTER (WHERE segment='INACTIVE')) FROM hits),
    (SELECT coalesce(jsonb_agg(jsonb_build_object('personId', s.person_id, 'version', s.version, 'givenName', s.given_name, 'familyName', s.family_name,
      'email', s.email, 'phoneE164', s.phone_e164, 'segment', s.segment, 'planName', s.plan_name, 'planCode', s.plan_code, 'programName', s.program_name,
      'membershipEndsAt', CASE WHEN s.ends_at IS NULL THEN NULL ELSE to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'ranks', coalesce((SELECT jsonb_agg(jsonb_build_object('rank', btrim(r.name), 'color', CASE WHEN r.display_color ~* '^#[0-9a-f]{3,8}$' THEN r.display_color END)
          ORDER BY btrim(c.name), r.progression_order)
        FROM hon.student_profiles sp JOIN hon.student_curriculum_enrollments e ON e.student_profile_id=sp.id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE'
        JOIN hon.curriculum_ranks r ON r.id=e.current_rank_id AND r.organization_id=org AND r.school_id=school
        JOIN hon.curricula c ON c.id=e.curriculum_id AND c.organization_id=org AND c.school_id=school
        WHERE sp.person_id=s.person_id AND sp.organization_id=org AND sp.school_id=school), '[]'::jsonb))
      ORDER BY s.family_name, s.given_name, s.created_at, s.person_id), '[]'::jsonb) FROM shown s),
    (SELECT count(*) > lim FROM page)
    INTO counts, rows_json, more;

  IF with_options THEN
    options:=jsonb_build_object(
      'ranks', coalesce((SELECT jsonb_agg(jsonb_build_object('rankId', r.id, 'curriculum', btrim(c.name), 'rank', btrim(r.name)) ORDER BY btrim(c.name), c.id, r.progression_order)
        FROM (SELECT r.* FROM hon.curriculum_ranks r WHERE r.organization_id=org AND r.school_id=school ORDER BY r.curriculum_id, r.progression_order LIMIT 200) r
        JOIN hon.curricula c ON c.id=r.curriculum_id AND c.organization_id=org AND c.school_id=school), '[]'::jsonb),
      'programs', coalesce((SELECT jsonb_agg(jsonb_build_object('programId', g.id, 'name', btrim(g.name)) ORDER BY btrim(g.name), g.id)
        FROM (SELECT * FROM hon.programs g WHERE g.organization_id=org AND g.school_id=school ORDER BY btrim(g.name), g.id LIMIT 100) g), '[]'::jsonb),
      'plans', coalesce((SELECT jsonb_agg(jsonb_build_object('planId', v.plan_id, 'name', btrim(v.display_name)) ORDER BY btrim(v.display_name), v.plan_id)
        FROM (SELECT DISTINCT ON (v.plan_id) v.plan_id, v.display_name FROM hon.membership_plan_versions v
          WHERE v.organization_id=org AND v.school_id=school ORDER BY v.plan_id, v.version DESC LIMIT 100) v), '[]'::jsonb));
  END IF;

  RETURN jsonb_build_object('generatedAt', to_char(as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'segment', seg,
    'counts', counts, 'rows', rows_json, 'hasMore', more, 'options', options);
END $$;

REVOKE ALL ON FUNCTION hon.require_school_contacts_actor(text), hon.school_contact_facts(uuid,uuid,timestamptz), hon.read_school_contact_list(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_school_contact_list(text,jsonb) TO hon_runtime;
  END IF;
END $$;

COMMIT;
