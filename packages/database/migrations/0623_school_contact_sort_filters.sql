BEGIN;

-- C4 (0623, allocated by the coordinator 2026-11-21): sort and more filters on the contacts list. Owner (David),
-- 2026-11-21 19:34Z: "contact list ... needs to be able to sort, filter to see the list in different way to figure out
-- different group like by belt, membership, end date, age". Spec: docs/architecture/CONTACTS_SORT_AND_FILTERS.md.
-- One CREATE OR REPLACE of hon.read_school_contact_list (same signature, owner, grants and actor check as 0521/0523).
-- New closed input keys:
--   sort        NAME (default) | ENDS_SOONEST | BELT_HIGH | BELT_LOW | AGE_YOUNGEST | AGE_OLDEST | NEWEST. People without
--               the sort value come last, then name order. Keyset paging stays on the last person id (C4-2).
--   membership  HAS | NONE | ACTIVE | PAUSED | CANCELLING (the current membership and its state).
--   noBelt      true: no active belt. Not with rankId.
--   endsFrom / endsTo  YYYY-MM-DD, current membership ends on or between these school-local days. Not with endsWithinDays.
--   ageMin / ageMax    0..120, min <= max; age today in the school time zone from the student birth date.
--   tag         one contact tag (case-insensitive).
-- Rows add age and membershipState; options add tags. Nothing is written, sent or charged.

CREATE OR REPLACE FUNCTION hon.read_school_contact_list(p_subject text, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); as_of timestamptz:=statement_timestamp();
  seg text:='ALL'; needle text; rank_f uuid; program_f uuid; plan_f uuid; days integer; after_id uuid; with_options boolean:=false;
  sort_by text:='NAME'; member_f text; no_belt boolean:=false; ends_from date; ends_to date; age_min integer; age_max integer; tag_f text;
  tz text; today date; anchored boolean;
  rows_json jsonb; more boolean; counts jsonb; options jsonb:=NULL;
  lim constant integer:=50; uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  day_re constant text:='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; age_re constant text:='^(0|[1-9][0-9]{0,2})$';
  tag_re constant text:='^[A-Za-z0-9]([A-Za-z0-9 _-]{0,38}[A-Za-z0-9])?$';
BEGIN
  PERFORM hon.require_school_contacts_actor(p_subject);
  IF p_input IS NULL OR jsonb_typeof(p_input)<>'object'
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('segment','query','rankId','programId','planId','endsWithinDays','afterId','options',
      'sort','membership','noBelt','endsFrom','endsTo','ageMin','ageMax','tag'))
    OR (p_input ? 'segment' AND (jsonb_typeof(p_input->'segment')<>'string' OR p_input->>'segment' NOT IN ('ALL','STUDENT','TRIAL','PROSPECT','INACTIVE','ARCHIVED')))
    OR (p_input ? 'query' AND (jsonb_typeof(p_input->'query')<>'string' OR length(p_input->>'query') NOT BETWEEN 1 AND 100 OR p_input->>'query' ~ '[[:cntrl:]]'))
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['rankId','programId','planId','afterId']) k WHERE p_input ? k AND (jsonb_typeof(p_input->k)<>'string' OR lower(p_input->>k) !~ uuid_re))
    OR (p_input ? 'endsWithinDays' AND (jsonb_typeof(p_input->'endsWithinDays')<>'number' OR p_input->>'endsWithinDays' NOT IN ('7','30','60','90')))
    OR (p_input ? 'options' AND jsonb_typeof(p_input->'options')<>'boolean')
    OR (p_input ? 'sort' AND (jsonb_typeof(p_input->'sort')<>'string'
      OR p_input->>'sort' NOT IN ('NAME','ENDS_SOONEST','BELT_HIGH','BELT_LOW','AGE_YOUNGEST','AGE_OLDEST','NEWEST')))
    OR (p_input ? 'membership' AND (jsonb_typeof(p_input->'membership')<>'string' OR p_input->>'membership' NOT IN ('HAS','NONE','ACTIVE','PAUSED','CANCELLING')))
    OR (p_input ? 'noBelt' AND (p_input->'noBelt' IS DISTINCT FROM 'true'::jsonb OR p_input ? 'rankId'))
    -- Casts only inside a bracketed CASE (plpgsql ends an IF condition at the first bare THEN), after the shape is proven, so a bad value is a refusal and never a cast error (even when folded).
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['endsFrom','endsTo']) k WHERE p_input ? k AND (jsonb_typeof(p_input->k)<>'string'
      OR p_input->>k !~ day_re OR NOT pg_input_is_valid(p_input->>k,'date') OR p_input ? 'endsWithinDays'))
    OR (CASE WHEN jsonb_typeof(p_input->'endsFrom')='string' AND jsonb_typeof(p_input->'endsTo')='string'
        AND p_input->>'endsFrom' ~ day_re AND p_input->>'endsTo' ~ day_re
        AND pg_input_is_valid(p_input->>'endsFrom','date') AND pg_input_is_valid(p_input->>'endsTo','date')
      THEN (p_input->>'endsFrom')::date > (p_input->>'endsTo')::date ELSE false END)
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['ageMin','ageMax']) k WHERE p_input ? k AND (jsonb_typeof(p_input->k)<>'number'
      OR p_input->>k !~ age_re OR (CASE WHEN p_input->>k ~ age_re THEN (p_input->>k)::integer > 120 ELSE false END)))
    OR (CASE WHEN jsonb_typeof(p_input->'ageMin')='number' AND jsonb_typeof(p_input->'ageMax')='number'
        AND p_input->>'ageMin' ~ age_re AND p_input->>'ageMax' ~ age_re
      THEN (p_input->>'ageMin')::integer > (p_input->>'ageMax')::integer ELSE false END)
    OR (p_input ? 'tag' AND (jsonb_typeof(p_input->'tag')<>'string' OR p_input->>'tag' !~ tag_re)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  seg:=coalesce(p_input->>'segment','ALL'); needle:=nullif(btrim(p_input->>'query'),'');
  rank_f:=(p_input->>'rankId')::uuid; program_f:=(p_input->>'programId')::uuid; plan_f:=(p_input->>'planId')::uuid;
  days:=(p_input->>'endsWithinDays')::integer; after_id:=(p_input->>'afterId')::uuid; with_options:=coalesce((p_input->>'options')::boolean,false);
  sort_by:=coalesce(p_input->>'sort','NAME'); member_f:=p_input->>'membership'; no_belt:=p_input ? 'noBelt';
  ends_from:=(p_input->>'endsFrom')::date; ends_to:=(p_input->>'endsTo')::date;
  age_min:=(p_input->>'ageMin')::integer; age_max:=(p_input->>'ageMax')::integer; tag_f:=lower(p_input->>'tag');
  -- C4-4: the school's own zone, or UTC when it is not a known zone.
  SELECT z.name INTO tz FROM hon.schools s JOIN pg_timezone_names z ON z.name=s.timezone WHERE s.id=school AND s.organization_id=org;
  tz:=coalesce(tz,'UTC'); today:=(as_of AT TIME ZONE tz)::date;

  WITH keyed AS MATERIALIZED (
    SELECT k.*, CASE sort_by WHEN 'ENDS_SOONEST' THEN k.ends_at IS NULL WHEN 'BELT_HIGH' THEN k.belt_hi IS NULL WHEN 'BELT_LOW' THEN k.belt_lo IS NULL
        WHEN 'AGE_YOUNGEST' THEN k.age IS NULL WHEN 'AGE_OLDEST' THEN k.age IS NULL ELSE false END AS s_missing,
      coalesce(CASE sort_by WHEN 'ENDS_SOONEST' THEN extract(epoch FROM k.ends_at) WHEN 'BELT_HIGH' THEN -k.belt_hi WHEN 'BELT_LOW' THEN k.belt_lo
        WHEN 'AGE_YOUNGEST' THEN CASE WHEN k.age IS NOT NULL THEN -(k.birth - date '1900-01-01') END
      WHEN 'AGE_OLDEST' THEN CASE WHEN k.age IS NOT NULL THEN (k.birth - date '1900-01-01') END
        WHEN 'NEWEST' THEN -extract(epoch FROM k.created_at) END, 0)::numeric AS s_key
    FROM (
      SELECT f.person_id, f.segment, f.membership_id, f.plan_id, f.plan_name, f.program_id, f.program_name, f.plan_code, f.ends_at,
        p.given_name, p.family_name, p.email::text AS email, p.phone_e164, p.version, p.created_at,
        CASE m.state WHEN 'ACTIVE' THEN 'ACTIVE' WHEN 'FROZEN' THEN 'PAUSED' WHEN 'CANCELLATION_PENDING' THEN 'CANCELLING' END AS m_state,
        b.hi AS belt_hi, b.lo AS belt_lo, sp.birth_date AS birth,
        CASE WHEN sp.birth_date IS NOT NULL AND sp.birth_date <= today THEN extract(year FROM age(today, sp.birth_date))::integer END AS age
      FROM hon.school_contact_facts(org, school, as_of) f
      JOIN hon.people p ON p.id=f.person_id AND p.organization_id=org AND p.school_id=school
      LEFT JOIN hon.memberships m ON m.id=f.membership_id AND m.organization_id=org AND m.school_id=school
      LEFT JOIN hon.student_profiles sp ON sp.person_id=f.person_id AND sp.organization_id=org AND sp.school_id=school
      LEFT JOIN LATERAL (SELECT max(r.progression_order) AS hi, min(r.progression_order) AS lo
        FROM hon.student_curriculum_enrollments e JOIN hon.curriculum_ranks r ON r.id=e.current_rank_id AND r.organization_id=org AND r.school_id=school
        WHERE e.student_profile_id=sp.id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE') b ON true
    ) k
  ), anchor AS (SELECT k.s_missing, k.s_key, k.family_name, k.given_name, k.created_at FROM keyed k WHERE k.person_id=after_id
  ), hits AS MATERIALIZED (
    SELECT h.* FROM keyed h
    WHERE (needle IS NULL OR concat_ws(' ', h.given_name, h.family_name, h.email, h.phone_e164) ILIKE '%' || needle || '%')
      AND (program_f IS NULL OR h.program_id=program_f) AND (plan_f IS NULL OR h.plan_id=plan_f)
      AND (days IS NULL OR (h.membership_id IS NOT NULL AND h.ends_at IS NOT NULL AND h.ends_at <= as_of + make_interval(days => days)))
      AND (ends_from IS NULL OR (h.ends_at IS NOT NULL AND (h.ends_at AT TIME ZONE tz)::date >= ends_from))
      AND (ends_to IS NULL OR (h.ends_at IS NOT NULL AND (h.ends_at AT TIME ZONE tz)::date <= ends_to))
      AND (member_f IS NULL OR (member_f='HAS' AND h.membership_id IS NOT NULL) OR (member_f='NONE' AND h.membership_id IS NULL)
        OR h.m_state=member_f)
      AND (age_min IS NULL OR h.age >= age_min) AND (age_max IS NULL OR h.age <= age_max)
      AND (NOT no_belt OR h.belt_hi IS NULL)
      AND (tag_f IS NULL OR EXISTS(SELECT 1 FROM hon.contact_tags ct WHERE ct.organization_id=org AND ct.school_id=school AND ct.person_id=h.person_id AND ct.tag_key=tag_f))
      AND (rank_f IS NULL OR EXISTS(SELECT 1 FROM hon.student_profiles sp JOIN hon.student_curriculum_enrollments e
        ON e.student_profile_id=sp.id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE' AND e.current_rank_id=rank_f
        WHERE sp.person_id=h.person_id AND sp.organization_id=org AND sp.school_id=school))
  ), page AS (
    SELECT h.* FROM hits h LEFT JOIN anchor a ON true
    WHERE ((seg='ALL' AND h.segment<>'ARCHIVED') OR h.segment=seg)
      AND (after_id IS NULL OR (h.s_missing, h.s_key, h.family_name, h.given_name, h.created_at, h.person_id) > (a.s_missing, a.s_key, a.family_name, a.given_name, a.created_at, after_id))
    ORDER BY h.s_missing, h.s_key, h.family_name, h.given_name, h.created_at, h.person_id LIMIT lim + 1
  ), shown AS (SELECT * FROM page ORDER BY s_missing, s_key, family_name, given_name, created_at, person_id LIMIT lim)
  SELECT (SELECT jsonb_build_object('ALL', count(*) FILTER (WHERE segment<>'ARCHIVED'), 'STUDENT', count(*) FILTER (WHERE segment='STUDENT'), 'TRIAL', count(*) FILTER (WHERE segment='TRIAL'),
      'PROSPECT', count(*) FILTER (WHERE segment='PROSPECT'), 'INACTIVE', count(*) FILTER (WHERE segment='INACTIVE'),
      'ARCHIVED', count(*) FILTER (WHERE segment='ARCHIVED')) FROM hits),
    (SELECT coalesce(jsonb_agg(jsonb_build_object('personId', s.person_id, 'version', s.version, 'givenName', s.given_name, 'familyName', s.family_name,
      'email', s.email, 'phoneE164', s.phone_e164, 'segment', s.segment, 'planName', s.plan_name, 'planCode', s.plan_code, 'programName', s.program_name,
      'membershipEndsAt', CASE WHEN s.ends_at IS NULL THEN NULL ELSE to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'membershipState', s.m_state, 'age', s.age,
      'ranks', coalesce((SELECT jsonb_agg(jsonb_build_object('rank', btrim(r.name), 'color', CASE WHEN r.display_color ~* '^#[0-9a-f]{3,8}$' THEN r.display_color END)
          ORDER BY btrim(c.name), r.progression_order)
        FROM hon.student_profiles sp JOIN hon.student_curriculum_enrollments e ON e.student_profile_id=sp.id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE'
        JOIN hon.curriculum_ranks r ON r.id=e.current_rank_id AND r.organization_id=org AND r.school_id=school
        JOIN hon.curricula c ON c.id=e.curriculum_id AND c.organization_id=org AND c.school_id=school
        WHERE sp.person_id=s.person_id AND sp.organization_id=org AND sp.school_id=school), '[]'::jsonb))
      ORDER BY s.s_missing, s.s_key, s.family_name, s.given_name, s.created_at, s.person_id), '[]'::jsonb) FROM shown s),
    (SELECT count(*) > lim FROM page), (SELECT count(*)=1 FROM anchor)
    INTO counts, rows_json, more, anchored;
  -- C4-2: the cursor's person must still be in this school's list snapshot.
  IF after_id IS NOT NULL AND NOT anchored THEN RAISE EXCEPTION 'SCHOOL_CONTACTS_STALE_CURSOR' USING ERRCODE='22023'; END IF;

  IF with_options THEN
    options:=jsonb_build_object(
      'ranks', coalesce((SELECT jsonb_agg(jsonb_build_object('rankId', r.id, 'curriculum', btrim(c.name), 'rank', btrim(r.name)) ORDER BY btrim(c.name), c.id, r.progression_order)
        FROM (SELECT r.* FROM hon.curriculum_ranks r WHERE r.organization_id=org AND r.school_id=school ORDER BY r.curriculum_id, r.progression_order LIMIT 200) r
        JOIN hon.curricula c ON c.id=r.curriculum_id AND c.organization_id=org AND c.school_id=school), '[]'::jsonb),
      'programs', coalesce((SELECT jsonb_agg(jsonb_build_object('programId', g.id, 'name', btrim(g.name)) ORDER BY btrim(g.name), g.id)
        FROM (SELECT * FROM hon.programs g WHERE g.organization_id=org AND g.school_id=school ORDER BY btrim(g.name), g.id LIMIT 100) g), '[]'::jsonb),
      'plans', coalesce((SELECT jsonb_agg(jsonb_build_object('planId', v.plan_id, 'name', btrim(v.display_name)) ORDER BY btrim(v.display_name), v.plan_id)
        FROM (SELECT DISTINCT ON (v.plan_id) v.plan_id, v.display_name FROM hon.membership_plan_versions v
          WHERE v.organization_id=org AND v.school_id=school ORDER BY v.plan_id, v.version DESC LIMIT 100) v), '[]'::jsonb),
      'tags', coalesce((SELECT jsonb_agg(t.tag ORDER BY t.tag_key)
        FROM (SELECT DISTINCT ON (ct.tag_key) ct.tag_key, ct.tag FROM hon.contact_tags ct WHERE ct.organization_id=org AND ct.school_id=school
          AND ct.tag ~ tag_re ORDER BY ct.tag_key, ct.added_at, ct.tag LIMIT 100) t), '[]'::jsonb));
  END IF;

  RETURN jsonb_build_object('generatedAt', to_char(as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'segment', seg,
    'counts', counts, 'rows', rows_json, 'hasMore', more, 'options', options);
END $$;

COMMIT;
