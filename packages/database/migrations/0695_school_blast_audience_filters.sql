BEGIN;

-- Blast audience filters and hand-picked contacts BL4 (0695, allocated by the coordinator 2026-11-25). Owner ask (David,
-- 2026-11-21): "i need more filters and contact selectors". Builds on 0621 (blasts) and 0623 (Contacts list filters).
-- Spec: docs/architecture/SCHOOL_BLASTS.md (Audience filters and picked contacts). Contract: @hon/contracts school-blasts.ts.
-- Rules:
--   F1  An audience is {groups, tags} as in 0621, plus two optional keys:
--       filters  the Contacts list filters (0623), with the same values: rankId | noBelt, programId, planId, membership
--                (HAS, NONE, ACTIVE, PAUSED, CANCELLING), endsWithinDays (7, 30, 60, 90) | endsFrom/endsTo (school dates),
--                ageMin/ageMax (0-120). At least one key. They narrow the people the groups and tags match.
--       people   1-200 distinct hand-picked contacts (lower-case ids), reached in addition to the groups.
--       groups may then be empty, but only when people are picked.
--   F2  Filters are applied the way the Contacts list applies them (school_contact_facts, the school's own zone for dates
--       and ages, active curriculum enrollments for belts). A picked id that is not a current contact of the school
--       (another school, archived, sample data) reaches nobody. Guardians, consent, addresses and the 2,000 cap are as in 0621.
--   F3  The runtime gains nothing: hon.school_blast_audience_ok and hon.school_blast_resolve keep their signatures and
--       their (empty) grants. Audiences saved before 0695 stay valid as they are.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'Blast audience filters require a restricted runtime'; END IF;
  IF to_regprocedure('hon.school_blast_resolve(uuid,uuid,text,jsonb)') IS NULL OR to_regprocedure('hon.school_blast_audience_ok(jsonb)') IS NULL
    OR to_regprocedure('hon.school_contact_facts(uuid,uuid,timestamptz)') IS NULL OR to_regprocedure('hon.read_school_contact_list(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '0695 requires 0521, 0621 and 0623'; END IF;
END $$;

-- F1: the 0621 shape, plus optional filters and picked people.
CREATE OR REPLACE FUNCTION hon.school_blast_audience_ok(a jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(a)='object'
    AND a ? 'groups' AND a ? 'tags'
    AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(a) k WHERE k NOT IN ('groups','tags','filters','people'))
    AND jsonb_typeof(a->'groups')='array' AND jsonb_array_length(a->'groups')<=5
    AND (jsonb_array_length(a->'groups')>=1 OR a ? 'people')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a->'groups') g WHERE jsonb_typeof(g)<>'string'
      OR (g#>>'{}') NOT IN ('ACTIVE_STUDENTS','PROSPECTS','TRIAL','FORMER_STUDENTS','ALL_CONTACTS'))
    AND (SELECT count(DISTINCT g#>>'{}') FROM jsonb_array_elements(a->'groups') g)=jsonb_array_length(a->'groups')
    AND jsonb_typeof(a->'tags')='array' AND jsonb_array_length(a->'tags')<=10
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a->'tags') t WHERE jsonb_typeof(t)<>'string'
      OR (t#>>'{}') !~ '^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,38}[A-Za-z0-9])?$')
    AND (SELECT count(DISTINCT lower(t#>>'{}')) FROM jsonb_array_elements(a->'tags') t)=jsonb_array_length(a->'tags')
    AND (NOT a ? 'people' OR (jsonb_typeof(a->'people')='array' AND jsonb_array_length(a->'people') BETWEEN 1 AND 200
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a->'people') x WHERE jsonb_typeof(x)<>'string'
        OR (x#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      AND (SELECT count(DISTINCT x#>>'{}') FROM jsonb_array_elements(a->'people') x)=jsonb_array_length(a->'people')))
    AND (NOT a ? 'filters' OR (jsonb_typeof(a->'filters')='object'
      AND EXISTS(SELECT 1 FROM jsonb_object_keys(a->'filters'))
      AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(a->'filters') k WHERE k NOT IN
        ('rankId','noBelt','programId','planId','membership','endsWithinDays','endsFrom','endsTo','ageMin','ageMax'))
      AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['rankId','programId','planId']) k WHERE a->'filters' ? k AND (jsonb_typeof(a->'filters'->k)<>'string'
        OR (a->'filters'->>k) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      AND (NOT a->'filters' ? 'noBelt' OR (a->'filters'->'noBelt'='true'::jsonb AND NOT a->'filters' ? 'rankId'))
      AND (NOT a->'filters' ? 'membership' OR (jsonb_typeof(a->'filters'->'membership')='string'
        AND a->'filters'->>'membership' IN ('HAS','NONE','ACTIVE','PAUSED','CANCELLING')))
      AND (NOT a->'filters' ? 'endsWithinDays' OR (jsonb_typeof(a->'filters'->'endsWithinDays')='number'
        AND a->'filters'->>'endsWithinDays' IN ('7','30','60','90') AND NOT a->'filters' ? 'endsFrom' AND NOT a->'filters' ? 'endsTo'))
      AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['endsFrom','endsTo']) k WHERE a->'filters' ? k AND (jsonb_typeof(a->'filters'->k)<>'string'
        OR (a->'filters'->>k) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR NOT pg_input_is_valid(a->'filters'->>k,'date')))
      AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['ageMin','ageMax']) k WHERE a->'filters' ? k AND (jsonb_typeof(a->'filters'->k)<>'number'
        OR (a->'filters'->>k) !~ '^(0|[1-9][0-9]{0,2})$' OR length(a->'filters'->>k)>3))
      AND (CASE WHEN (a->'filters'->>'ageMin') ~ '^(0|[1-9][0-9]{0,2})$' THEN (a->'filters'->>'ageMin')::integer<=120 ELSE true END)
      AND (CASE WHEN (a->'filters'->>'ageMax') ~ '^(0|[1-9][0-9]{0,2})$' THEN (a->'filters'->>'ageMax')::integer<=120 ELSE true END)
      AND (CASE WHEN (a->'filters'->>'ageMin') ~ '^(0|[1-9][0-9]{0,2})$' AND (a->'filters'->>'ageMax') ~ '^(0|[1-9][0-9]{0,2})$'
        THEN (a->'filters'->>'ageMin')::integer<=(a->'filters'->>'ageMax')::integer ELSE true END)
      AND (CASE WHEN (a->'filters'->>'endsFrom') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND (a->'filters'->>'endsTo') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND pg_input_is_valid(a->'filters'->>'endsFrom','date') AND pg_input_is_valid(a->'filters'->>'endsTo','date')
        THEN (a->'filters'->>'endsFrom')::date<=(a->'filters'->>'endsTo')::date ELSE true END))),false)
$$;

-- F2: everyone the audience reaches on the channel, with what happens to each (0621 rule B3). One row per person.
CREATE OR REPLACE FUNCTION hon.school_blast_resolve(org uuid,school uuid,chan text,aud jsonb) RETURNS TABLE(person_id uuid,outcome text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH g AS (SELECT array_agg(x#>>'{}') AS groups FROM jsonb_array_elements(aud->'groups') x),
  t AS (SELECT coalesce(array_agg(lower(x#>>'{}')),'{}') AS tags FROM jsonb_array_elements(aud->'tags') x),
  current_contact AS (
    SELECT p.id FROM hon.people p
    WHERE p.organization_id=org AND p.school_id=school AND NOT hon.demo_data_is_demo('people',p.id)
      AND NOT EXISTS(SELECT 1 FROM hon.school_contact_archives ar WHERE ar.person_id=p.id AND ar.organization_id=org AND ar.school_id=school AND ar.restored_at IS NULL)
  ),
  grouped AS (
    SELECT c.id FROM current_contact c, g, t
    WHERE ('ALL_CONTACTS'=ANY(g.groups)
        OR ('ACTIVE_STUDENTS'=ANY(g.groups) AND EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school
          AND m.participant_person_id=c.id AND m.state='ACTIVE'))
        OR ('FORMER_STUDENTS'=ANY(g.groups) AND EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school
          AND m.participant_person_id=c.id AND m.state IN ('CANCELLED','EXPIRED'))
          AND NOT EXISTS(SELECT 1 FROM hon.memberships m WHERE m.organization_id=org AND m.school_id=school
          AND m.participant_person_id=c.id AND m.state IN ('ACTIVE','FROZEN','CANCELLATION_PENDING')))
        OR ('PROSPECTS'=ANY(g.groups) AND EXISTS(SELECT 1 FROM hon.crm_leads l WHERE l.organization_id=org AND l.school_id=school
          AND l.primary_person_id=c.id AND l.status='OPEN'))
        OR ('TRIAL'=ANY(g.groups) AND EXISTS(SELECT 1 FROM hon.crm_leads l JOIN hon.crm_appointments a ON a.crm_lead_id=l.id
          AND a.organization_id=l.organization_id AND a.school_id=l.school_id
          WHERE l.organization_id=org AND l.school_id=school AND l.primary_person_id=c.id AND l.status='OPEN'
            AND a.appointment_type='TRIAL' AND a.status IN ('SCHEDULED','COMPLETED'))))
      AND (cardinality(t.tags)=0 OR EXISTS(SELECT 1 FROM hon.contact_tags ct WHERE ct.organization_id=org AND ct.school_id=school
        AND ct.person_id=c.id AND ct.tag_key=ANY(t.tags)))
  ),
  -- The Contacts list filters (0623), with the school's own zone (UTC when it is not a known zone).
  fl AS (
    SELECT aud->'filters' AS f, statement_timestamp() AS as_of,
      coalesce((SELECT z.name FROM hon.schools s JOIN pg_timezone_names z ON z.name=s.timezone WHERE s.id=school AND s.organization_id=org),'UTC') AS tz
  ),
  facts AS MATERIALIZED (
    SELECT x.person_id,x.membership_id,x.plan_id,x.program_id,x.ends_at,
      CASE m.state WHEN 'ACTIVE' THEN 'ACTIVE' WHEN 'FROZEN' THEN 'PAUSED' WHEN 'CANCELLATION_PENDING' THEN 'CANCELLING' END AS m_state,
      CASE WHEN sp.birth_date IS NOT NULL AND sp.birth_date<=(fl.as_of AT TIME ZONE fl.tz)::date
        THEN extract(year FROM age((fl.as_of AT TIME ZONE fl.tz)::date,sp.birth_date))::integer END AS age,
      sp.id AS profile_id
    FROM fl, hon.school_contact_facts(org,school,fl.as_of) x
    LEFT JOIN hon.memberships m ON m.id=x.membership_id AND m.organization_id=org AND m.school_id=school
    LEFT JOIN hon.student_profiles sp ON sp.person_id=x.person_id AND sp.organization_id=org AND sp.school_id=school
    WHERE fl.f IS NOT NULL
  ),
  filtered AS (
    SELECT gr.id FROM grouped gr, fl WHERE fl.f IS NULL
    UNION ALL
    SELECT gr.id FROM grouped gr JOIN facts h ON h.person_id=gr.id, fl
    WHERE fl.f IS NOT NULL
      AND (NOT fl.f ? 'programId' OR h.program_id=(fl.f->>'programId')::uuid)
      AND (NOT fl.f ? 'planId' OR h.plan_id=(fl.f->>'planId')::uuid)
      AND (NOT fl.f ? 'endsWithinDays' OR (h.membership_id IS NOT NULL AND h.ends_at IS NOT NULL
        AND h.ends_at<=fl.as_of+make_interval(days=>(fl.f->>'endsWithinDays')::integer)))
      AND (NOT fl.f ? 'endsFrom' OR (h.ends_at IS NOT NULL AND (h.ends_at AT TIME ZONE fl.tz)::date>=(fl.f->>'endsFrom')::date))
      AND (NOT fl.f ? 'endsTo' OR (h.ends_at IS NOT NULL AND (h.ends_at AT TIME ZONE fl.tz)::date<=(fl.f->>'endsTo')::date))
      AND (NOT fl.f ? 'membership' OR (fl.f->>'membership'='HAS' AND h.membership_id IS NOT NULL)
        OR (fl.f->>'membership'='NONE' AND h.membership_id IS NULL) OR h.m_state=fl.f->>'membership')
      AND (NOT fl.f ? 'ageMin' OR h.age>=(fl.f->>'ageMin')::integer)
      AND (NOT fl.f ? 'ageMax' OR h.age<=(fl.f->>'ageMax')::integer)
      AND (NOT fl.f ? 'noBelt' OR NOT EXISTS(SELECT 1 FROM hon.student_curriculum_enrollments e
        JOIN hon.curriculum_ranks r ON r.id=e.current_rank_id AND r.organization_id=org AND r.school_id=school
        WHERE e.student_profile_id=h.profile_id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE'))
      AND (NOT fl.f ? 'rankId' OR EXISTS(SELECT 1 FROM hon.student_curriculum_enrollments e
        WHERE e.student_profile_id=h.profile_id AND e.organization_id=org AND e.school_id=school AND e.status='ACTIVE'
          AND e.current_rank_id=(fl.f->>'rankId')::uuid))
  ),
  -- Hand-picked contacts, reached in addition; only current contacts of this school.
  picked AS (
    SELECT c.id FROM current_contact c
    WHERE c.id IN (SELECT (x#>>'{}')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(aud->'people')='array' THEN aud->'people' ELSE '[]'::jsonb END) x)
  ),
  matched AS (
    SELECT p.* FROM hon.people p WHERE p.organization_id=org AND p.school_id=school
      AND p.id IN (SELECT id FROM filtered UNION SELECT id FROM picked)
  ),
  -- A child (a STUDENT or DEPENDENT family member with a guardian, unless a birth date shows 18 or over) is always reached
  -- through guardians, and also at their own address when they have one (consent is still checked per person; owner
  -- decision 2026-11-18). Anyone else without an address is reached through guardians if any.
  kids AS (
    SELECT m.id,
      EXISTS(SELECT 1 FROM hon.family_members s JOIN hon.family_members gm ON gm.family_id=s.family_id AND gm.organization_id=org AND gm.school_id=school
          AND gm.member_role='GUARDIAN' AND gm.person_id<>m.id
        WHERE s.person_id=m.id AND s.organization_id=org AND s.school_id=school AND s.member_role IN ('STUDENT','DEPENDENT'))
      AND NOT EXISTS(SELECT 1 FROM hon.student_profiles sp WHERE sp.person_id=m.id AND sp.organization_id=org AND sp.school_id=school
        AND sp.birth_date IS NOT NULL AND sp.birth_date<=current_date-interval '18 years') AS minor
    FROM matched m
  ),
  reach AS (
    SELECT m.id AS matched_id,m.id AS person_id FROM matched m JOIN kids k ON k.id=m.id
    WHERE hon.school_blast_address(m.phone_e164,m.email::text,chan) IS NOT NULL
    UNION
    SELECT m.id,gp.id FROM matched m JOIN kids k ON k.id=m.id
      JOIN hon.family_members s ON s.person_id=m.id AND s.organization_id=org AND s.school_id=school AND s.member_role IN ('STUDENT','DEPENDENT')
      JOIN hon.family_members gm ON gm.family_id=s.family_id AND gm.organization_id=org AND gm.school_id=school AND gm.member_role='GUARDIAN' AND gm.person_id<>m.id
      JOIN hon.people gp ON gp.id=gm.person_id AND gp.organization_id=org AND gp.school_id=school
    WHERE (k.minor OR hon.school_blast_address(m.phone_e164,m.email::text,chan) IS NULL)
      AND hon.school_blast_address(gp.phone_e164,gp.email::text,chan) IS NOT NULL AND NOT hon.demo_data_is_demo('people',gp.id)
      AND NOT EXISTS(SELECT 1 FROM hon.school_contact_archives ar WHERE ar.person_id=gp.id AND ar.organization_id=org AND ar.school_id=school AND ar.restored_at IS NULL)
  ),
  recipients AS (
    SELECT DISTINCT r.person_id,hon.school_blast_address(p.phone_e164,p.email::text,chan) AS address,
      EXISTS(SELECT 1 FROM hon.communication_consents k WHERE k.organization_id=org AND k.school_id=school AND k.person_id=r.person_id
        AND k.channel::text=chan AND k.status='OPTED_IN') AS consent
    FROM reach r JOIN hon.people p ON p.id=r.person_id AND p.organization_id=org AND p.school_id=school
  ),
  ranked AS (SELECT r.*,row_number() OVER (PARTITION BY r.address ORDER BY r.consent DESC,r.person_id) AS n FROM recipients r)
  SELECT r.person_id,CASE WHEN r.n>1 THEN 'DUPLICATE_ADDRESS' WHEN NOT r.consent THEN 'NO_CONSENT' ELSE 'QUEUED' END FROM ranked r
  UNION ALL
  SELECT m.id,'NO_ADDRESS' FROM matched m WHERE NOT EXISTS(SELECT 1 FROM reach r WHERE r.matched_id=m.id)
$$;

-- F3: both stay private helpers (CREATE OR REPLACE keeps the 0621 grants; re-assert them).
DO $$ DECLARE r text; f text;
  helpers text[]:=ARRAY['hon.school_blast_audience_ok(jsonb)','hon.school_blast_resolve(uuid,uuid,text,jsonb)'];
BEGIN
  FOREACH f IN ARRAY helpers LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
END $$;
COMMIT;
