-- 0608 J1b: a family's answer to a journey recommendation (David 2026-11-20, "Both extras"; lead with the child's name 21:05Z).
-- "Not now" hides one recommendation for the whole family for good. Interest names who it is for: one of the family's own
-- children the recommendation shows for, or a brother or sister whose name the guardian types. Each new interest opens one CRM
-- lead named after that child in the school's first pipeline (none when the school has no pipeline), with the usual
-- crm.lead.create audit and crm.lead.created event. Rows never change or go away. Guardians only (a VIEWER reads but does not
-- answer). No message, charge or booking is created. The family read (0603) now leaves out what the family hid; same JSON shape.
BEGIN;

-- A child's name as the family read shows it or as typed: not blank, at most 200 characters, on one line.
-- A typed brother or sister name is further held to 80 characters with no space at either end (in the command below).
CREATE FUNCTION hon.journey_child_name_ok(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT v IS NOT NULL AND btrim(v)<>'' AND length(v)<=200 AND v !~ '[[:cntrl:]]'
$$;

CREATE TABLE hon.journey_recommendation_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  family_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('HIDDEN','INTERESTED')),
  child_name text,
  sibling boolean,
  lead_id uuid,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='HIDDEN' AND child_name IS NULL AND sibling IS NULL AND lead_id IS NULL)
    OR (kind='INTERESTED' AND sibling IS NOT NULL AND hon.journey_child_name_ok(child_name))),
  FOREIGN KEY (recommendation_id, organization_id, school_id) REFERENCES hon.journey_recommendations(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (family_id, organization_id, school_id) REFERENCES hon.families(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (lead_id, organization_id, school_id) REFERENCES hon.crm_leads(id, organization_id, school_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX journey_recommendation_responses_hidden_once ON hon.journey_recommendation_responses(recommendation_id, family_id) WHERE kind='HIDDEN';
CREATE UNIQUE INDEX journey_recommendation_responses_interest_once ON hon.journey_recommendation_responses(recommendation_id, family_id, lower(child_name)) WHERE kind='INTERESTED';
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

-- The receipt a family gets for one answer: display fields only.
CREATE FUNCTION hon.journey_response_json(r hon.journey_recommendation_responses, replayed boolean) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('recommendationId',r.recommendation_id,'kind',r.kind,'childName',r.child_name,
    'recordedAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'replayed',replayed)
$$;

-- A guardian answers one recommendation the family can see right now. Answering again is the same row (replayed:true).
-- p_input: {"kind":"HIDDEN"} or {"kind":"INTERESTED","childName":"...","sibling":false|true}.
CREATE FUNCTION hon.respond_parent_journey_recommendation(subject text, p_recommendation uuid, p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE sc record; row_v hon.journey_recommendation_responses%ROWTYPE; visible boolean; request uuid:=gen_random_uuid();
  v_kind text; v_name text; v_sibling boolean; v_person uuid; v_stage hon.crm_pipeline_stages%ROWTYPE; l hon.crm_leads%ROWTYPE; v_ids jsonb; shown jsonb; cut integer;
BEGIN
  IF p_recommendation IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR jsonb_typeof(p_input->'kind') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  v_kind:=p_input->>'kind';
  IF v_kind='HIDDEN' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>1 THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  ELSIF v_kind='INTERESTED' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_input))<>3 OR jsonb_typeof(p_input->'childName') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_input->'sibling') IS DISTINCT FROM 'boolean' OR NOT hon.journey_child_name_ok(p_input->>'childName') THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    v_name:=p_input->>'childName'; v_sibling:=(p_input->>'sibling')::boolean;
    IF v_sibling AND (length(v_name)>80 OR btrim(v_name)<>v_name) THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  ELSE RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  SELECT * INTO sc FROM hon.journey_recommendation_parent_scope(subject);
  IF sc.access_level NOT IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN') THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- One answer at a time per family, so the same interest sent twice at once opens one lead.
  PERFORM 1 FROM hon.families f WHERE f.id=sc.family_id AND f.organization_id=sc.organization_id AND f.school_id=sc.school_id FOR UPDATE;
  SELECT * INTO row_v FROM hon.journey_recommendation_responses x
    WHERE x.recommendation_id=p_recommendation AND x.family_id=sc.family_id AND x.kind=v_kind AND x.school_id=sc.school_id
      AND (v_kind='HIDDEN' OR lower(x.child_name)=lower(v_name));
  IF FOUND THEN RETURN hon.journey_response_json(row_v,true); END IF;
  -- Only a recommendation the family read shows right now can be answered; for one of the family's own children it must show for that child.
  shown:=hon.read_parent_journey_recommendations(subject)->'children';
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(shown) c, jsonb_array_elements(c->'recommendations') r
    WHERE r->>'recommendationId'=p_recommendation::text AND (v_kind='HIDDEN' OR v_sibling OR c->>'name'=v_name)) INTO visible;
  IF NOT visible THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_kind='INTERESTED' THEN
    -- A brother or sister is someone the family read does not already show by that name.
    IF v_sibling AND EXISTS(SELECT 1 FROM jsonb_array_elements(shown) c WHERE lower(c->>'name')=lower(v_name)) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
    SELECT st.* INTO v_stage FROM hon.crm_pipeline_stages st
      WHERE st.organization_id=sc.organization_id AND st.school_id=sc.school_id AND st.terminal_status IS NULL AND st.hidden_at IS NULL
        AND st.pipeline_id=(SELECT pl.id FROM hon.crm_pipelines pl WHERE pl.organization_id=sc.organization_id AND pl.school_id=sc.school_id ORDER BY pl.created_at, pl.id LIMIT 1)
      ORDER BY st.position LIMIT 1;
    IF v_stage.id IS NOT NULL THEN
      IF v_sibling THEN
        cut:=length(v_name)-position(' ' IN reverse(v_name));
        INSERT INTO hon.people(organization_id,school_id,given_name,family_name)
          VALUES(sc.organization_id,sc.school_id,CASE WHEN position(' ' IN v_name)>0 THEN btrim(left(v_name,cut)) ELSE v_name END,
            CASE WHEN position(' ' IN v_name)>0 THEN btrim(substr(v_name,cut+1)) ELSE '' END) RETURNING id INTO v_person;
      ELSE
        SELECT sp.person_id INTO v_person FROM hon.student_profiles sp
          JOIN hon.family_members m ON m.person_id=sp.person_id AND m.organization_id=sp.organization_id AND m.school_id=sp.school_id AND m.family_id=sc.family_id AND m.member_role='STUDENT'
          JOIN hon.people pe ON pe.id=sp.person_id AND pe.organization_id=sp.organization_id AND pe.school_id=sp.school_id
          WHERE sp.primary_family_id=sc.family_id AND sp.status='ACTIVE' AND sp.organization_id=sc.organization_id AND sp.school_id=sc.school_id
            AND concat_ws(' ',pe.given_name,pe.family_name)=v_name ORDER BY sp.id LIMIT 1;
        IF v_person IS NULL THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_NOT_FOUND' USING ERRCODE='P0002'; END IF;
      END IF;
      INSERT INTO hon.crm_leads(organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,source_code,attribution)
        VALUES(sc.organization_id,sc.school_id,v_person,v_stage.pipeline_id,v_stage.id,'FAMILY_APP',
          jsonb_build_object('source','FAMILY_APP','journeyRecommendation',jsonb_build_object('recommendationId',p_recommendation,'familyId',sc.family_id,'sibling',v_sibling)))
        RETURNING * INTO l;
      v_ids:=jsonb_build_object('leadId',l.id,'primaryPersonId',v_person,'pipelineId',l.pipeline_id,'pipelineStageId',l.pipeline_stage_id,'sourceCode','FAMILY_APP','programInterestCode',NULL);
      INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
        VALUES(l.organization_id,l.school_id,sc.principal_id,'HUMAN_UI','crm.lead.create','CRM_LEAD',l.id,NULL,v_ids||jsonb_build_object('version',l.version),'SUCCEEDED',request,request);
      INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
        VALUES(l.organization_id,l.school_id,'crm.lead.created',1,'CRM_LEAD',l.id,l.version,request,request,v_ids);
    END IF;
  END IF;
  INSERT INTO hon.journey_recommendation_responses(organization_id,school_id,recommendation_id,family_id,kind,child_name,sibling,lead_id,principal_id)
    VALUES(sc.organization_id,sc.school_id,p_recommendation,sc.family_id,v_kind,v_name,v_sibling,l.id,sc.principal_id) RETURNING * INTO row_v;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,next_state,result,request_id,correlation_id)
    VALUES(sc.organization_id,sc.school_id,sc.principal_id,'HUMAN_UI',CASE v_kind WHEN 'HIDDEN' THEN 'journey.recommendation.hide' ELSE 'journey.recommendation.interest' END,
      'JOURNEY_RECOMMENDATION',p_recommendation,jsonb_build_object('familyId',sc.family_id,'kind',v_kind,'sibling',v_sibling,'leadId',l.id),'SUCCEEDED',request,request);
  -- The grant is checked again after the write, so an answer never outlives the access it was made with.
  PERFORM 1 FROM hon.journey_recommendation_parent_scope(subject) s WHERE s.family_id=sc.family_id AND s.access_level IN ('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN');
  IF NOT FOUND THEN RAISE EXCEPTION 'JOURNEY_RECOMMENDATIONS_FORBIDDEN' USING ERRCODE='42501'; END IF;
  RETURN hon.journey_response_json(row_v,false);
END $$;

-- Staff (curriculum.manage): who each of the school's recommendations interested, newest first, at most 500.
-- The family display name, the child's name, whether it is a brother or sister, the CRM lead and the date; no contact details.
CREATE FUNCTION hon.read_journey_recommendation_interest(subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid; org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
  actor:=hon.require_journey_recommendations_actor(subject);
  SELECT coalesce(jsonb_agg(jsonb_build_object('recommendationId',x.recommendation_id,'familyId',x.family_id,'familyName',x.family_name,
      'childName',x.child_name,'sibling',x.sibling,'leadId',x.lead_id,'recordedAt',to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY x.created_at DESC, x.id),'[]'::jsonb)
  INTO result FROM (
    SELECT i.id, i.recommendation_id, i.family_id, i.created_at, i.child_name, i.sibling, i.lead_id, f.display_name AS family_name
    FROM hon.journey_recommendation_responses i
    JOIN hon.journey_recommendations r ON r.id=i.recommendation_id AND r.organization_id=i.organization_id AND r.school_id=i.school_id AND r.status<>'REMOVED'
    JOIN hon.families f ON f.id=i.family_id AND f.organization_id=i.organization_id AND f.school_id=i.school_id
    WHERE i.organization_id=org AND i.school_id=school AND i.kind='INTERESTED'
    ORDER BY i.created_at DESC, i.id LIMIT 500) x;
  RETURN jsonb_build_object('interest',result);
END $$;

COMMENT ON TABLE hon.journey_recommendation_responses IS
'0608: a family''s answer to a journey recommendation (HIDDEN = "Not now", once per family; INTERESTED once per family and child name, with the CRM lead it opened). Never changed or deleted.';
COMMENT ON FUNCTION hon.read_parent_journey_recommendations(text) IS
'0603/0608 parent read: for each ACTIVE child of the one live family grant, the ON journey recommendations whose trigger the child has reached, whose target is live and that the family has not hidden, at most 10 per child. No DML.';
COMMENT ON FUNCTION hon.respond_parent_journey_recommendation(text,uuid,jsonb) IS
'0608 parent command (guardians): hide a recommendation for the family, or record interest for a named child or sibling and open one CRM lead for it; only one the family read shows now; same answer again is a replay; nothing is sent, charged or booked.';
COMMENT ON FUNCTION hon.read_journey_recommendation_interest(text) IS
'0608 staff read (curriculum.manage): who the school''s journey recommendations interested: family name, child name, sibling flag, CRM lead id and date only.';

DO $$ DECLARE r text; f text;
  entry text[]:=ARRAY['hon.respond_parent_journey_recommendation(text,uuid,jsonb)','hon.read_journey_recommendation_interest(text)'];
  fns text[]:=ARRAY['hon.guard_journey_recommendation_response()','hon.journey_child_name_ok(text)','hon.journey_response_json(hon.journey_recommendation_responses,boolean)']||entry; BEGIN
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
      OR has_function_privilege('hon_runtime','hon.journey_child_name_ok(text)','EXECUTE')
      OR has_function_privilege('hon_runtime','hon.journey_response_json(hon.journey_recommendation_responses,boolean)','EXECUTE')
      OR has_table_privilege('hon_runtime','hon.journey_recommendation_responses','SELECT') OR has_table_privilege('hon_runtime','hon.journey_recommendation_responses','INSERT') THEN
      RAISE EXCEPTION 'Journey recommendation response helpers and table must stay private';
    END IF;
  END IF;
END $$;

COMMIT;
