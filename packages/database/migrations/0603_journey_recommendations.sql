BEGIN;

-- Journey recommendations (0603, assigned by the coordinator 2026-11-20; docs/architecture/PARENT_APP_PLAYFUL_STYLE.md J1).
-- The owner asked for school-configured recommendations on each child's progress journey in the HON Family app, tied to a
-- rank or to a point along the path, that can point to a program sign-up, a camp or event, the pro shop or the school.
--   R1  Staff with curriculum.manage (the staff who already keep ranks and requirements) add a recommendation to one of the
--       school's curricula: a title (1-80 characters, one line), a message (1-400 characters) and one trigger:
--         RANK_REACHED       the child's current rank in that curriculum is the chosen rank or a later one;
--         REQUIREMENTS_MET   the child is at the chosen rank and has at least N (1-100) of its requirements MET;
--         TEST_BOOKED        the child is a PENDING candidate for the chosen rank at an OPEN or CLOSED test that has not passed;
--         CLASSES_ATTENDED   the child has at least N (1-1000) PRESENT, LATE or MAKEUP classes that have started since the
--                            enrollment began (in the enrollment's program when it has one), optionally only from a rank on.
--       and one target: CHECKOUT (one of the school's sign-up pages), EVENT (one of the school's events), PRO_SHOP or
--       ASK_SCHOOL. "Skip children already signed up" is allowed for CHECKOUT only (a PAID order naming the child).
--   R2  Staff edit a recommendation at its exact version, turn it OFF and ON again, or REMOVE it (final). At most 50 live
--       (not removed) per curriculum. Every change is audited with ids only and carries exact-request idempotency.
--   R3  Families with one live grant at the school (any access level) read, for each ACTIVE child, the ON recommendations
--       whose trigger the child has reached and whose target the family app can still show (a published sign-up page with
--       something on sale today, a published event from today on), at most 10 per child. Staff identity is never shown.
--   R4  Nothing is charged, booked, texted, emailed or pushed by a recommendation. A sign-up goes through the existing
--       guarded checkout. The family "Not now" and "See how to join" actions are a later slice (J1b).
-- School, organization and entitlement must be live, and authority is checked again after the locks and writes. The runtime
-- gains no table privilege: entry points are SECURITY DEFINER.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'Journey recommendations require a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='hon_runtime')) THEN
    RAISE EXCEPTION 'Journey recommendations require a restricted runtime';
  END IF;
  IF to_regprocedure('hon.parent_class_booking_scope(text,boolean)') IS NULL OR to_regprocedure('hon.require_curriculum_actor(text,text)') IS NULL
    OR to_regprocedure('hon.family_message_begin(uuid,text,text)') IS NULL OR to_regprocedure('hon.membership_command_args_ok(text,text,uuid,uuid)') IS NULL
    OR to_regprocedure('hon.guard_membership_activation_evidence()') IS NULL OR to_regprocedure('hon.family_checkout_option_open(jsonb,date)') IS NULL
    OR to_regprocedure('hon.family_checkout_today(uuid)') IS NULL OR to_regprocedure('hon.family_checkout_en(jsonb)') IS NULL
    OR to_regprocedure('hon.family_message_time(timestamp with time zone)') IS NULL
    OR to_regclass('hon.school_events') IS NULL OR to_regclass('hon.curriculum_progress_observations') IS NULL THEN
    RAISE EXCEPTION 'Journey recommendations require 0070, 0329, 0330, 0598 and the school events and checkouts';
  END IF;
END $$;

-- Text a family reads: not blank, no control characters (a message may hold line breaks).
CREATE FUNCTION hon.journey_text_ok(v text, max integer, lines boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND length(v) BETWEEN 1 AND max AND btrim(v,E' \t\r\n')<>''
    AND CASE WHEN lines THEN v !~ E'[\\x01-\\x09\\x0b\\x0c\\x0e-\\x1f\\x7f]' ELSE v !~ E'[\\x01-\\x1f\\x7f]' END
$$;

CREATE TABLE hon.journey_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  curriculum_id uuid NOT NULL,
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('RANK_REACHED','REQUIREMENTS_MET','TEST_BOOKED','CLASSES_ATTENDED')),
  rank_id uuid,
  threshold integer,
  title text NOT NULL CHECK (hon.journey_text_ok(title,80,false)),
  message text NOT NULL CHECK (hon.journey_text_ok(message,400,true)),
  target_kind text NOT NULL CHECK (target_kind IN ('CHECKOUT','EVENT','PRO_SHOP','ASK_SCHOOL')),
  target_checkout_id uuid,
  target_event_id uuid,
  skip_enrolled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ON' CHECK (status IN ('ON','OFF','REMOVED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  updated_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (CASE trigger_kind
    WHEN 'RANK_REACHED' THEN rank_id IS NOT NULL AND threshold IS NULL
    WHEN 'REQUIREMENTS_MET' THEN rank_id IS NOT NULL AND threshold BETWEEN 1 AND 100
    WHEN 'TEST_BOOKED' THEN rank_id IS NOT NULL AND threshold IS NULL
    ELSE threshold BETWEEN 1 AND 1000 END),
  CHECK (CASE target_kind
    WHEN 'CHECKOUT' THEN target_checkout_id IS NOT NULL AND target_event_id IS NULL
    WHEN 'EVENT' THEN target_event_id IS NOT NULL AND target_checkout_id IS NULL
    ELSE target_checkout_id IS NULL AND target_event_id IS NULL END),
  CHECK (NOT skip_enrolled OR target_kind='CHECKOUT'),
  UNIQUE (id,organization_id,school_id),
  FOREIGN KEY (school_id,organization_id) REFERENCES hon.schools(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (curriculum_id,organization_id,school_id) REFERENCES hon.curricula(id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (rank_id,curriculum_id,organization_id,school_id) REFERENCES hon.curriculum_ranks(id,curriculum_id,organization_id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_checkout_id,school_id) REFERENCES hon.school_checkouts(id,school_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_event_id,organization_id,school_id) REFERENCES hon.school_events(id,organization_id,school_id) ON DELETE RESTRICT
);
CREATE INDEX journey_recommendations_curriculum ON hon.journey_recommendations(organization_id,school_id,curriculum_id,status);
ALTER TABLE hon.journey_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.journey_recommendations FORCE ROW LEVEL SECURITY;
CREATE TRIGGER journey_recommendations_no_truncate BEFORE TRUNCATE ON hon.journey_recommendations
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_membership_activation_evidence();

-- A recommendation is never deleted and never moves school or curriculum; every change moves the version on by exactly one,
-- REMOVED is final, and a new one starts ON at version 1.
CREATE FUNCTION hon.guard_journey_recommendation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Journey recommendations are never deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.status<>'ON' THEN RAISE EXCEPTION 'A new journey recommendation starts ON at version 1' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.curriculum_id<>OLD.curriculum_id
    OR NEW.created_by_principal_id<>OLD.created_by_principal_id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
    OR OLD.status='REMOVED' OR (NEW.status='REMOVED' AND (NEW.title,NEW.message,NEW.trigger_kind,NEW.target_kind,NEW.skip_enrolled)
      IS DISTINCT FROM (OLD.title,OLD.message,OLD.trigger_kind,OLD.target_kind,OLD.skip_enrolled)) THEN
    RAISE EXCEPTION 'A journey recommendation changes one version at a time and stays removed once removed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journey_recommendations_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.journey_recommendations
  FOR EACH ROW EXECUTE FUNCTION hon.guard_journey_recommendation();

-- R1/R2 staff side: the 0070 curriculum.manage authority at the current school, with its own refusal code.
CREATE FUNCTION hon.require_journey_recommendations_actor(subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  IF subject IS NULL OR length(subject) NOT BETWEEN 1 AND 200 OR btrim(subject)<>subject
    OR subject IS DISTINCT FROM current_setting('app.hon_external_subject',true) THEN
    RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  BEGIN
    RETURN hon.require_curriculum_actor(subject,'curriculum.manage');
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501';
  END;
END $$;

-- R3 parent side: the 0329 family scope (one live grant, tenant, principal, source, live school and entitlement).
CREATE FUNCTION hon.journey_recommendation_parent_scope(subject text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
  BEGIN
    RETURN QUERY SELECT * FROM hon.parent_class_booking_scope(subject,false);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501';
  END;
END $$;

-- A sign-up page the family app shows today (0598 F1: published, something on sale today) and its English title.
CREATE FUNCTION hon.journey_checkout_title(org uuid, school uuid, checkout uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT coalesce(nullif(btrim(hon.family_checkout_en(c.content->'title')),''),'Sign up') FROM hon.school_checkouts c
  WHERE c.id=checkout AND c.organization_id=org AND c.school_id=school AND c.status='PUBLISHED'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.content->'options') o WHERE hon.family_checkout_option_open(o,hon.family_checkout_today(school)))
$$;
-- An event the family app shows (published, today or later in the school's time zone) and its title.
CREATE FUNCTION hon.journey_event_title(org uuid, school uuid, event uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT e.title FROM hon.school_events e
  WHERE e.id=event AND e.organization_id=org AND e.school_id=school AND e.status='PUBLISHED' AND e.local_date>=hon.family_checkout_today(school)
$$;

-- R1 trigger: whether one ON recommendation applies to one ACTIVE enrollment right now.
CREATE FUNCTION hon.journey_recommendation_reached(r hon.journey_recommendations, e hon.student_curriculum_enrollments) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH cur AS (SELECT k.id, k.progression_order FROM hon.curriculum_ranks k WHERE k.id=e.current_rank_id AND k.curriculum_id=e.curriculum_id),
  target AS (SELECT k.id, k.progression_order FROM hon.curriculum_ranks k WHERE k.id=r.rank_id AND k.curriculum_id=r.curriculum_id)
  SELECT r.curriculum_id=e.curriculum_id AND r.organization_id=e.organization_id AND r.school_id=e.school_id AND CASE r.trigger_kind
    WHEN 'RANK_REACHED' THEN coalesce((SELECT cur.progression_order>=target.progression_order FROM cur, target),false)
    WHEN 'REQUIREMENTS_MET' THEN e.current_rank_id=r.rank_id AND (
      SELECT count(*) FROM hon.curriculum_requirements q
      WHERE q.curriculum_rank_id=r.rank_id AND q.organization_id=e.organization_id AND q.school_id=e.school_id
        AND (SELECT o.status FROM hon.curriculum_progress_observations o WHERE o.enrollment_id=e.id AND o.requirement_id=q.id
          AND o.requirement_version=q.version AND o.enrollment_version=e.version ORDER BY o.version DESC LIMIT 1)='MET')>=r.threshold
    WHEN 'TEST_BOOKED' THEN EXISTS(SELECT 1 FROM hon.testing_candidates c JOIN hon.testing_events t ON t.id=c.testing_event_id
        AND t.organization_id=c.organization_id AND t.school_id=c.school_id
      WHERE c.student_curriculum_enrollment_id=e.id AND c.organization_id=e.organization_id AND c.school_id=e.school_id
        AND c.target_rank_id=r.rank_id AND c.result='PENDING' AND t.status IN ('OPEN','CLOSED')
        AND coalesce(t.ends_at,t.starts_at)>clock_timestamp())
    ELSE (r.rank_id IS NULL OR coalesce((SELECT cur.progression_order>=target.progression_order FROM cur, target),false)) AND (
      SELECT count(*) FROM hon.attendance_records a JOIN hon.class_sessions s ON s.id=a.class_session_id
        AND s.organization_id=a.organization_id AND s.school_id=a.school_id
      WHERE a.organization_id=e.organization_id AND a.school_id=e.school_id AND a.student_profile_id=e.student_profile_id
        AND a.status IN ('PRESENT','LATE','MAKEUP') AND s.starts_at<=clock_timestamp() AND s.starts_at>=e.enrolled_at
        AND (e.program_id IS NULL OR s.program_id=e.program_id))>=r.threshold END
$$;

-- Whether a CHECKOUT recommendation should skip a child already named in a PAID order for that page.
CREATE FUNCTION hon.journey_child_signed_up(r hon.journey_recommendations, child uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT r.skip_enrolled AND EXISTS(SELECT 1 FROM hon.family_checkout_orders o
    WHERE o.organization_id=r.organization_id AND o.school_id=r.school_id AND o.checkout_id=r.target_checkout_id AND o.status='PAID'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(o.participants) x WHERE x->>'studentProfileId'=child::text))
$$;

-- One recommendation as staff see it: no author identity.
CREATE FUNCTION hon.journey_recommendation_staff_json(r hon.journey_recommendations) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  SELECT jsonb_build_object('recommendationId',r.id,'curriculumId',r.curriculum_id,
    'program',(SELECT c.name FROM hon.curricula c WHERE c.id=r.curriculum_id),
    'triggerKind',r.trigger_kind,'rankId',r.rank_id,'rank',(SELECT k.name FROM hon.curriculum_ranks k WHERE k.id=r.rank_id),'threshold',r.threshold,
    'title',r.title,'message',r.message,'targetKind',r.target_kind,'targetCheckoutId',r.target_checkout_id,'targetEventId',r.target_event_id,
    'targetLabel',CASE r.target_kind WHEN 'CHECKOUT' THEN (SELECT hon.family_checkout_en(c.content->'title') FROM hon.school_checkouts c WHERE c.id=r.target_checkout_id)
      WHEN 'EVENT' THEN (SELECT e.title FROM hon.school_events e WHERE e.id=r.target_event_id) END,
    'targetLive',CASE r.target_kind WHEN 'CHECKOUT' THEN hon.journey_checkout_title(r.organization_id,r.school_id,r.target_checkout_id) IS NOT NULL
      WHEN 'EVENT' THEN hon.journey_event_title(r.organization_id,r.school_id,r.target_event_id) IS NOT NULL ELSE true END,
    'skipEnrolled',r.skip_enrolled,'status',r.status,'version',r.version,'updatedAt',hon.family_message_time(r.updated_at))
$$;

-- R3 parent read: for each ACTIVE child (at most 20, by name), the reached ON recommendations with a live target, at most 10.
CREATE FUNCTION hon.read_parent_journey_recommendations(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; children jsonb;
BEGIN
  SELECT * INTO sc FROM hon.journey_recommendation_parent_scope(subject);
  SELECT coalesce(jsonb_agg(jsonb_build_object('name',kid.name,'recommendations',coalesce((
      SELECT jsonb_agg(x.j ORDER BY x.created_at, x.id) FROM (
        SELECT r.id, r.created_at, jsonb_build_object('recommendationId',r.id,'program',cu.name,
          'rank',(SELECT k.name FROM hon.curriculum_ranks k WHERE k.id=r.rank_id),'triggerKind',r.trigger_kind,'threshold',r.threshold,
          'title',r.title,'message',r.message,'targetKind',r.target_kind,'checkoutId',r.target_checkout_id,'eventId',r.target_event_id,
          'targetLabel',CASE r.target_kind WHEN 'CHECKOUT' THEN hon.journey_checkout_title(r.organization_id,r.school_id,r.target_checkout_id)
            WHEN 'EVENT' THEN hon.journey_event_title(r.organization_id,r.school_id,r.target_event_id) END) j
        FROM hon.student_curriculum_enrollments e
        JOIN hon.curricula cu ON cu.id=e.curriculum_id AND cu.organization_id=e.organization_id AND cu.school_id=e.school_id
        JOIN hon.journey_recommendations r ON r.curriculum_id=e.curriculum_id AND r.organization_id=e.organization_id AND r.school_id=e.school_id AND r.status='ON'
        WHERE e.student_profile_id=kid.id AND e.organization_id=sc.organization_id AND e.school_id=sc.school_id AND e.status='ACTIVE'
          AND hon.journey_recommendation_reached(r,e) AND NOT hon.journey_child_signed_up(r,kid.id)
          AND CASE r.target_kind WHEN 'CHECKOUT' THEN hon.journey_checkout_title(r.organization_id,r.school_id,r.target_checkout_id) IS NOT NULL
            WHEN 'EVENT' THEN hon.journey_event_title(r.organization_id,r.school_id,r.target_event_id) IS NOT NULL ELSE true END
        ORDER BY r.created_at, r.id LIMIT 10) x),'[]'::jsonb)) ORDER BY kid.name, kid.id),'[]'::jsonb)
  INTO children FROM (
    SELECT sp.id, concat_ws(' ',pe.given_name,pe.family_name) AS name
    FROM hon.student_profiles sp
    JOIN hon.family_members m ON m.person_id=sp.person_id AND m.organization_id=sp.organization_id AND m.school_id=sp.school_id
      AND m.family_id=sc.family_id AND m.member_role='STUDENT'
    JOIN hon.people pe ON pe.id=sp.person_id AND pe.organization_id=sp.organization_id AND pe.school_id=sp.school_id
    WHERE sp.primary_family_id=sc.family_id AND sp.status='ACTIVE' AND sp.organization_id=sc.organization_id AND sp.school_id=sc.school_id
      AND btrim(concat_ws(' ',pe.given_name,pe.family_name))<>''
    ORDER BY 2, 1 LIMIT 20) kid;
  RETURN jsonb_build_object('children',children);
END $$;

-- R1/R2 staff read: the school's recommendations (not removed), with the choices the editor offers.
CREATE FUNCTION hon.read_journey_recommendations(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); today date; result jsonb;
BEGIN
  actor:=hon.require_journey_recommendations_actor(subject);
  today:=hon.family_checkout_today(school);
  result:=jsonb_build_object(
    'recommendations',coalesce((SELECT jsonb_agg(hon.journey_recommendation_staff_json(r) ORDER BY r.created_at, r.id) FROM (
      SELECT * FROM hon.journey_recommendations x WHERE x.organization_id=org AND x.school_id=school AND x.status<>'REMOVED'
      ORDER BY x.created_at, x.id LIMIT 500) r),'[]'::jsonb),
    'programs',coalesce((SELECT jsonb_agg(jsonb_build_object('curriculumId',c.id,'name',c.name,'ranks',coalesce((
        SELECT jsonb_agg(jsonb_build_object('rankId',k.id,'name',k.name,'order',k.progression_order) ORDER BY k.progression_order)
        FROM hon.curriculum_ranks k WHERE k.curriculum_id=c.id AND k.organization_id=org AND k.school_id=school),'[]'::jsonb)) ORDER BY c.name, c.id)
      FROM (SELECT * FROM hon.curricula y WHERE y.organization_id=org AND y.school_id=school AND y.lifecycle<>'ARCHIVED' ORDER BY y.name, y.id LIMIT 100) c),'[]'::jsonb),
    'checkouts',coalesce((SELECT jsonb_agg(jsonb_build_object('checkoutId',c.id,'title',hon.family_checkout_en(c.content->'title')) ORDER BY c.created_at, c.id)
      FROM (SELECT * FROM hon.school_checkouts y WHERE y.organization_id=org AND y.school_id=school AND y.status='PUBLISHED'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(y.content->'options') o WHERE hon.family_checkout_option_open(o,today)) ORDER BY y.created_at, y.id LIMIT 100) c),'[]'::jsonb),
    'events',coalesce((SELECT jsonb_agg(jsonb_build_object('eventId',e.id,'title',e.title,'localDate',to_char(e.local_date,'YYYY-MM-DD')) ORDER BY e.local_date, e.id)
      FROM (SELECT * FROM hon.school_events y WHERE y.organization_id=org AND y.school_id=school AND y.status='PUBLISHED' AND y.local_date>=today
        ORDER BY y.local_date, y.id LIMIT 100) e),'[]'::jsonb));
  IF hon.require_journey_recommendations_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN result;
END $$;

-- R1/R2 save: a new recommendation (recommendationId and expectedVersion null) or an edit at the exact version of a live one.
CREATE FUNCTION hon.save_journey_recommendation(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; r hon.journey_recommendations; before jsonb; result jsonb; ids jsonb; target uuid; expected integer;
  org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); today date; uuidre text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trig text; tgt text; rank uuid; thr integer; curriculum uuid; checkout uuid; event uuid; ok boolean;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM
      ARRAY['curriculumId','expectedVersion','message','rankId','recommendationId','skipEnrolled','targetCheckoutId','targetEventId','targetKind','threshold','title','triggerKind']
    OR jsonb_typeof(p->'curriculumId') IS DISTINCT FROM 'string' OR p->>'curriculumId' !~ uuidre
    OR jsonb_typeof(p->'recommendationId') NOT IN ('string','null') OR coalesce(p->>'recommendationId','0') !~ ('('||uuidre||')|^0$')
    OR jsonb_typeof(p->'expectedVersion') NOT IN ('number','null') OR coalesce(p->>'expectedVersion','1') !~ '^[1-9][0-9]{0,8}$'
    OR (jsonb_typeof(p->'recommendationId')='null')<>(jsonb_typeof(p->'expectedVersion')='null')
    OR jsonb_typeof(p->'triggerKind') IS DISTINCT FROM 'string' OR p->>'triggerKind' NOT IN ('RANK_REACHED','REQUIREMENTS_MET','TEST_BOOKED','CLASSES_ATTENDED')
    OR jsonb_typeof(p->'rankId') NOT IN ('string','null') OR coalesce(p->>'rankId','0') !~ ('('||uuidre||')|^0$')
    OR jsonb_typeof(p->'threshold') NOT IN ('number','null') OR coalesce(p->>'threshold','1') !~ '^[1-9][0-9]{0,3}$'
    OR jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR NOT hon.journey_text_ok(p->>'title',80,false)
    OR jsonb_typeof(p->'message') IS DISTINCT FROM 'string' OR NOT hon.journey_text_ok(p->>'message',400,true)
    OR jsonb_typeof(p->'targetKind') IS DISTINCT FROM 'string' OR p->>'targetKind' NOT IN ('CHECKOUT','EVENT','PRO_SHOP','ASK_SCHOOL')
    OR jsonb_typeof(p->'targetCheckoutId') NOT IN ('string','null') OR coalesce(p->>'targetCheckoutId','0') !~ ('('||uuidre||')|^0$')
    OR jsonb_typeof(p->'targetEventId') NOT IN ('string','null') OR coalesce(p->>'targetEventId','0') !~ ('('||uuidre||')|^0$')
    OR jsonb_typeof(p->'skipEnrolled') IS DISTINCT FROM 'boolean'
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  trig:=p->>'triggerKind'; tgt:=p->>'targetKind'; rank:=(p->>'rankId')::uuid; thr:=(p->>'threshold')::integer; curriculum:=(p->>'curriculumId')::uuid;
  checkout:=(p->>'targetCheckoutId')::uuid; event:=(p->>'targetEventId')::uuid;
  ok:=(CASE trig WHEN 'RANK_REACHED' THEN rank IS NOT NULL AND thr IS NULL WHEN 'REQUIREMENTS_MET' THEN rank IS NOT NULL AND thr BETWEEN 1 AND 100
      WHEN 'TEST_BOOKED' THEN rank IS NOT NULL AND thr IS NULL ELSE thr BETWEEN 1 AND 1000 END)
    AND (CASE tgt WHEN 'CHECKOUT' THEN checkout IS NOT NULL AND event IS NULL WHEN 'EVENT' THEN event IS NOT NULL AND checkout IS NULL
      ELSE checkout IS NULL AND event IS NULL END);
  IF NOT coalesce(ok,false)
    OR ((p->>'skipEnrolled')::boolean AND tgt<>'CHECKOUT') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=(p->>'recommendationId')::uuid; expected:=(p->>'expectedVersion')::integer;
  actor:=hon.require_journey_recommendations_actor(subject);
  prior:=hon.family_message_begin(actor,key,encode(sha256(convert_to('journey_recommendation.save:'||p::text,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_journey_recommendations_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hon.journey_recommendations:'||school::text,0));
  -- The curriculum, rank and target must be this school's own; a target must be one the family app can show today.
  IF NOT EXISTS(SELECT 1 FROM hon.curricula c WHERE c.id=curriculum AND c.organization_id=org AND c.school_id=school AND c.lifecycle<>'ARCHIVED')
    OR (rank IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hon.curriculum_ranks k WHERE k.id=rank AND k.curriculum_id=curriculum AND k.organization_id=org AND k.school_id=school))
    OR (checkout IS NOT NULL AND hon.journey_checkout_title(org,school,checkout) IS NULL)
    OR (event IS NOT NULL AND hon.journey_event_title(org,school,event) IS NULL) THEN
    RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF target IS NULL THEN
    IF (SELECT count(*) FROM hon.journey_recommendations x WHERE x.organization_id=org AND x.school_id=school AND x.curriculum_id=curriculum AND x.status<>'REMOVED')>=50 THEN
      RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_LIMIT' USING ERRCODE='53400'; END IF;
    INSERT INTO hon.journey_recommendations(organization_id,school_id,curriculum_id,trigger_kind,rank_id,threshold,title,message,target_kind,
        target_checkout_id,target_event_id,skip_enrolled,created_by_principal_id,updated_by_principal_id)
      VALUES(org,school,curriculum,trig,rank,thr,p->>'title',p->>'message',tgt,checkout,event,(p->>'skipEnrolled')::boolean,actor,actor) RETURNING * INTO r;
  ELSE
    SELECT * INTO r FROM hon.journey_recommendations x WHERE x.id=target AND x.organization_id=org AND x.school_id=school FOR UPDATE;
    IF NOT FOUND OR r.status='REMOVED' THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF r.version<>expected OR r.curriculum_id<>curriculum THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
    before:=jsonb_build_object('recommendationId',r.id,'status',r.status,'version',r.version);
    UPDATE hon.journey_recommendations SET trigger_kind=trig,rank_id=rank,threshold=thr,title=p->>'title',message=p->>'message',target_kind=tgt,
        target_checkout_id=checkout,target_event_id=event,skip_enrolled=(p->>'skipEnrolled')::boolean,updated_by_principal_id=actor,
        updated_at=clock_timestamp(),version=version+1
      WHERE id=r.id RETURNING * INTO r;
  END IF;
  result:=jsonb_build_object('recommendation',hon.journey_recommendation_staff_json(r));
  ids:=jsonb_build_object('recommendationId',r.id,'curriculumId',r.curriculum_id,'status',r.status,'version',r.version);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','journey_recommendation.save','JOURNEY_RECOMMENDATION',r.id,before,ids,'SUCCEEDED',request,correlation);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=CASE WHEN target IS NULL THEN 201 ELSE 200 END,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_journey_recommendations_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

-- R2 status: ON, OFF or REMOVED (final) at the exact version. Asking for the status it already has is VERSION_CONFLICT.
CREATE FUNCTION hon.set_journey_recommendation_status(subject text, p jsonb, key text, request uuid, correlation uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; prior jsonb; r hon.journey_recommendations; before jsonb; result jsonb; ids jsonb; target uuid; expected integer; next text;
  org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) IS DISTINCT FROM ARRAY['expectedVersion','recommendationId','status']
    OR jsonb_typeof(p->'recommendationId') IS DISTINCT FROM 'string' OR p->>'recommendationId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$'
    OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR p->>'status' NOT IN ('ON','OFF','REMOVED')
    OR NOT hon.membership_command_args_ok(subject,key,request,correlation) OR key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  target:=(p->>'recommendationId')::uuid; expected:=(p->>'expectedVersion')::integer; next:=p->>'status';
  actor:=hon.require_journey_recommendations_actor(subject);
  prior:=hon.family_message_begin(actor,key,encode(sha256(convert_to('journey_recommendation.status:'||target||':'||expected||':'||next,'UTF8')),'hex'));
  IF prior IS NOT NULL THEN
    IF hon.require_journey_recommendations_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN jsonb_build_object('receipt',prior,'replayed',true);
  END IF;
  SELECT * INTO r FROM hon.journey_recommendations x WHERE x.id=target AND x.organization_id=org AND x.school_id=school FOR UPDATE;
  IF NOT FOUND OR r.status='REMOVED' THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF r.version<>expected OR r.status=next THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  before:=jsonb_build_object('recommendationId',r.id,'status',r.status,'version',r.version);
  UPDATE hon.journey_recommendations SET status=next,updated_by_principal_id=actor,updated_at=clock_timestamp(),version=version+1 WHERE id=r.id RETURNING * INTO r;
  result:=jsonb_build_object('recommendation',hon.journey_recommendation_staff_json(r));
  ids:=jsonb_build_object('recommendationId',r.id,'curriculumId',r.curriculum_id,'status',r.status,'version',r.version);
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(org,school,actor,'HUMAN_UI','journey_recommendation.status','JOURNEY_RECOMMENDATION',r.id,before,ids,'SUCCEEDED',request,correlation);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=result
    WHERE organization_id=org AND school_id=school AND principal_id=actor AND idempotency_key=key;
  IF hon.require_journey_recommendations_actor(subject) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('receipt',result,'replayed',false);
END $$;

COMMENT ON FUNCTION hon.read_parent_journey_recommendations(text) IS
'0603 parent read: for each ACTIVE child of the one live family grant, the ON journey recommendations whose trigger the child has reached and whose target is live, at most 10 per child. No DML.';
COMMENT ON FUNCTION hon.read_journey_recommendations(text) IS
'0603 staff read (curriculum.manage): the school''s journey recommendations that are not removed, with the programs, ranks, sign-up pages and events the editor offers.';
COMMENT ON FUNCTION hon.save_journey_recommendation(text,jsonb,text,uuid,uuid) IS
'0603 staff command (curriculum.manage): add a journey recommendation, or edit one at its exact version; 50 live per curriculum; nothing is sent.';
COMMENT ON FUNCTION hon.set_journey_recommendation_status(text,jsonb,text,uuid,uuid) IS
'0603 staff command (curriculum.manage): turn a journey recommendation ON or OFF, or remove it for good, at its exact version.';

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.read_parent_journey_recommendations(text)','hon.read_journey_recommendations(text)',
    'hon.save_journey_recommendation(text,jsonb,text,uuid,uuid)','hon.set_journey_recommendation_status(text,jsonb,text,uuid,uuid)'];
  fns text[]:=ARRAY['hon.journey_text_ok(text,integer,boolean)','hon.guard_journey_recommendation()','hon.require_journey_recommendations_actor(text)',
    'hon.journey_recommendation_parent_scope(text)','hon.journey_checkout_title(uuid,uuid,uuid)','hon.journey_event_title(uuid,uuid,uuid)',
    'hon.journey_recommendation_reached(hon.journey_recommendations,hon.student_curriculum_enrollments)',
    'hon.journey_child_signed_up(hon.journey_recommendations,uuid)','hon.journey_recommendation_staff_json(hon.journey_recommendations)']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.journey_recommendations FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.journey_recommendations FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
    IF EXISTS(SELECT 1 FROM unnest(fns) f2 WHERE f2<>ALL(entry) AND has_function_privilege('hon_runtime',f2,'EXECUTE'))
      OR has_table_privilege('hon_runtime','hon.journey_recommendations','SELECT') OR has_table_privilege('hon_runtime','hon.journey_recommendations','INSERT') THEN
      RAISE EXCEPTION 'Journey recommendation helpers and table must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
