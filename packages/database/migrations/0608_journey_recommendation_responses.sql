-- 0608 J1b: a family's answer to a journey recommendation (David 2026-11-20, "Both extras").
-- "Not now" hides one recommendation for the whole family for good; "See how to join" records that the family is interested,
-- so staff see it next to the recommendation. One row per family, recommendation and answer; rows never change or go away.
-- Guardians only (a VIEWER grant reads but does not answer for the family). Existing families are not CRM prospects: no lead,
-- message, charge or booking is created. The family read (0603) now leaves out what the family hid; its JSON shape is unchanged.
BEGIN;

CREATE TABLE hon.journey_recommendation_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  family_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('HIDDEN','INTERESTED')),
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recommendation_id, family_id, kind),
  FOREIGN KEY (recommendation_id, organization_id, school_id) REFERENCES hon.journey_recommendations(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (family_id, organization_id, school_id) REFERENCES hon.families(id, organization_id, school_id) ON DELETE RESTRICT
);
CREATE INDEX journey_recommendation_responses_school_idx ON hon.journey_recommendation_responses(school_id, recommendation_id, kind, created_at);
ALTER TABLE hon.journey_recommendation_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.journey_recommendation_responses FORCE ROW LEVEL SECURITY;

CREATE FUNCTION hon.guard_journey_recommendation_response() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'JOURNEY_RECOMMENDATION_RESPONSE_IMMUTABLE' USING ERRCODE='55000';
END $$;
CREATE TRIGGER journey_recommendation_responses_immutable BEFORE UPDATE OR DELETE ON hon.journey_recommendation_responses
  FOR EACH ROW EXECUTE FUNCTION hon.guard_journey_recommendation_response();
CREATE TRIGGER journey_recommendation_responses_no_truncate BEFORE TRUNCATE ON hon.journey_recommendation_responses
  FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_journey_recommendation_response();

-- The family read of 0603, minus the recommendations this family hid. Same JSON shape, same limits.
CREATE OR REPLACE FUNCTION hon.read_parent_journey_recommendations(subject text) RETURNS jsonb
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
          AND NOT EXISTS(SELECT 1 FROM hon.journey_recommendation_responses h WHERE h.recommendation_id=r.id AND h.family_id=sc.family_id AND h.kind='HIDDEN')
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

-- A guardian answers one recommendation the family can see right now. Answering again is the same row (replayed:true).
CREATE FUNCTION hon.respond_parent_journey_recommendation(subject text, p_recommendation uuid, p_kind text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; row_v hon.journey_recommendation_responses%ROWTYPE; visible boolean; request uuid:=gen_random_uuid();
BEGIN
  IF p_recommendation IS NULL OR p_kind IS NULL OR p_kind NOT IN ('HIDDEN','INTERESTED') THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO sc FROM hon.journey_recommendation_parent_scope(subject);
  IF sc.access_level NOT IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN') THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM hon.families f WHERE f.id=sc.family_id AND f.organization_id=sc.organization_id AND f.school_id=sc.school_id FOR SHARE;
  SELECT * INTO row_v FROM hon.journey_recommendation_responses x
    WHERE x.recommendation_id=p_recommendation AND x.family_id=sc.family_id AND x.kind=p_kind AND x.school_id=sc.school_id;
  IF FOUND THEN
    RETURN jsonb_build_object('recommendationId',row_v.recommendation_id,'kind',row_v.kind,'recordedAt',to_char(row_v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'replayed',true);
  END IF;
  -- Only a recommendation the family read shows right now can be answered.
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(hon.read_parent_journey_recommendations(subject)->'children') c,
      jsonb_array_elements(c->'recommendations') r WHERE r->>'recommendationId'=p_recommendation::text) INTO visible;
  IF NOT visible THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  INSERT INTO hon.journey_recommendation_responses(organization_id,school_id,recommendation_id,family_id,kind,principal_id)
    VALUES(sc.organization_id,sc.school_id,p_recommendation,sc.family_id,p_kind,sc.principal_id)
    ON CONFLICT (recommendation_id,family_id,kind) DO NOTHING RETURNING * INTO row_v;
  IF row_v.id IS NULL THEN
    SELECT * INTO row_v FROM hon.journey_recommendation_responses x WHERE x.recommendation_id=p_recommendation AND x.family_id=sc.family_id AND x.kind=p_kind;
    RETURN jsonb_build_object('recommendationId',row_v.recommendation_id,'kind',row_v.kind,'recordedAt',to_char(row_v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'replayed',true);
  END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(sc.organization_id,sc.school_id,sc.principal_id,'HUMAN_UI',CASE p_kind WHEN 'HIDDEN' THEN 'journey.recommendation.hide' ELSE 'journey.recommendation.interest' END,
      'JOURNEY_RECOMMENDATION',p_recommendation,jsonb_build_object('familyId',sc.family_id,'kind',p_kind),'SUCCEEDED',request,request);
  -- The grant is checked again after the write, so an answer never outlives the access it was made with.
  PERFORM 1 FROM hon.journey_recommendation_parent_scope(subject) s WHERE s.family_id=sc.family_id AND s.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN');
  IF NOT FOUND THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('recommendationId',row_v.recommendation_id,'kind',row_v.kind,'recordedAt',to_char(row_v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'replayed',false);
END $$;

-- Staff (curriculum.manage): the families interested in each of the school's recommendations, newest first, at most 500.
-- Family display name, the family's ACTIVE children's names and the date only; no contact details.
CREATE FUNCTION hon.read_journey_recommendation_interest(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
  actor:=hon.require_journey_recommendations_actor(subject);
  SELECT coalesce(jsonb_agg(jsonb_build_object('recommendationId',x.recommendation_id,'familyId',x.family_id,'familyName',x.family_name,
      'children',x.children,'recordedAt',to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY x.created_at DESC, x.id),'[]'::jsonb)
  INTO result FROM (
    SELECT i.id, i.recommendation_id, i.family_id, i.created_at, f.display_name AS family_name,
      coalesce((SELECT jsonb_agg(k.name ORDER BY k.name) FROM (
        SELECT concat_ws(' ',pe.given_name,pe.family_name) AS name FROM hon.student_profiles sp
        JOIN hon.people pe ON pe.id=sp.person_id AND pe.organization_id=sp.organization_id AND pe.school_id=sp.school_id
        WHERE sp.primary_family_id=i.family_id AND sp.organization_id=org AND sp.school_id=school AND sp.status='ACTIVE'
          AND btrim(concat_ws(' ',pe.given_name,pe.family_name))<>'' ORDER BY 1 LIMIT 20) k),'[]'::jsonb) AS children
    FROM hon.journey_recommendation_responses i
    JOIN hon.journey_recommendations r ON r.id=i.recommendation_id AND r.organization_id=i.organization_id AND r.school_id=i.school_id AND r.status<>'REMOVED'
    JOIN hon.families f ON f.id=i.family_id AND f.organization_id=i.organization_id AND f.school_id=i.school_id
    WHERE i.organization_id=org AND i.school_id=school AND i.kind='INTERESTED'
    ORDER BY i.created_at DESC, i.id LIMIT 500) x;
  RETURN jsonb_build_object('interest',result);
END $$;

COMMENT ON TABLE hon.journey_recommendation_responses IS
'0608: a family''s answer to a journey recommendation (HIDDEN = "Not now", INTERESTED = "See how to join"). One row per family, recommendation and answer; never changed or deleted.';
COMMENT ON FUNCTION hon.read_parent_journey_recommendations(text) IS
'0603/0608 parent read: for each ACTIVE child of the one live family grant, the ON journey recommendations whose trigger the child has reached, whose target is live and that the family has not hidden, at most 10 per child. No DML.';
COMMENT ON FUNCTION hon.respond_parent_journey_recommendation(text,uuid,text) IS
'0608 parent command (guardians): hide a recommendation for the family or record interest in it; only one the family read shows now; same answer again is a replay; nothing is sent, charged or booked.';
COMMENT ON FUNCTION hon.read_journey_recommendation_interest(text) IS
'0608 staff read (curriculum.manage): families interested in the school''s journey recommendations, with family and children names and the date only.';

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.respond_parent_journey_recommendation(text,uuid,text)','hon.read_journey_recommendation_interest(text)'];
  fns text[]:=ARRAY['hon.guard_journey_recommendation_response()']||entry; BEGIN
  FOREACH f IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,r); END LOOP;
  END LOOP;
  REVOKE ALL ON TABLE hon.journey_recommendation_responses FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON TABLE hon.journey_recommendation_responses FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    FOREACH f IN ARRAY entry LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO hon_runtime',f); END LOOP;
    IF has_function_privilege('hon_runtime','hon.guard_journey_recommendation_response()','EXECUTE')
      OR has_table_privilege('hon_runtime','hon.journey_recommendation_responses','SELECT') OR has_table_privilege('hon_runtime','hon.journey_recommendation_responses','INSERT') THEN
      RAISE EXCEPTION 'Journey recommendation response helpers and table must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
