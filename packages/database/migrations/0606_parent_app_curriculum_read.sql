BEGIN;
-- Parent app curriculum, piece 2 (0606, coordinator-allocated 2026-11-20, was 0578; spec docs/architecture/PARENT_APP_CURRICULUM.md s5).
-- What a family sees in the app: per child and active enrollment in a curriculum shown in the app, the current rank or
-- the current cycle (0605 hon.curriculum_app_cycle_state, school time zone) and its PARENT material in sections.
--   R1  hon.curriculum_app_child_entries: private helper for one student (both reads use it, so staff preview = parent view).
--   R2  hon.read_parent_curriculum_app: the parent read; the family follows the 0471/0473 family choice through
--       hon.resolve_parent_journey_scopes; the same lock-then-recheck and entitlement rule as the 0132 parent read.
--   R3  hon.read_staff_parent_app_curriculum_preview: staff (curriculum.manage) preview of one own-school student.
-- Output is a whitelist: names, dates, kinds, titles, descriptions and URLs. No ids, staff, audit or progress data.
-- No table, write path, external I/O or AI.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Parent app curriculum read requires trusted migration owner'; END IF;
 IF to_regprocedure('hon.curriculum_app_cycle_state(uuid,uuid,uuid)') IS NULL OR to_regprocedure('hon.resolve_parent_journey_scopes(text)') IS NULL THEN RAISE EXCEPTION 'Apply 0605 and 0471 first'; END IF;
END $$;

CREATE FUNCTION hon.curriculum_app_child_entries(p_student uuid,p_organization uuid,p_school uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,hon AS $$
DECLARE e record; out jsonb:='[]'::jsonb; mode text; cur_order integer; next_rank record; state jsonb; sections jsonb; items jsonb; rank_obj jsonb; cycle_obj jsonb; next_obj jsonb;
 shown boolean; s hon.curriculum_app_settings%ROWTYPE; has_settings boolean;
BEGIN
 FOR e IN SELECT en.curriculum_id,en.current_rank_id,c.name curriculum_name,c.model_code
  FROM hon.student_curriculum_enrollments en JOIN hon.curricula c ON c.id=en.curriculum_id AND c.organization_id=en.organization_id AND c.school_id=en.school_id
  WHERE en.student_profile_id=p_student AND en.organization_id=p_organization AND en.school_id=p_school AND en.status='ACTIVE' AND c.lifecycle<>'ARCHIVED'
  ORDER BY c.name,c.id LIMIT 20 LOOP
  SELECT * INTO s FROM hon.curriculum_app_settings WHERE curriculum_id=e.curriculum_id AND organization_id=p_organization AND school_id=p_school;
  has_settings:=FOUND;
  shown:=CASE WHEN has_settings THEN s.show_in_app ELSE true END;
  CONTINUE WHEN NOT shown;
  mode:=CASE WHEN has_settings THEN s.display_mode WHEN e.model_code='ROTATIONAL' THEN 'CYCLE' ELSE 'RANK' END;
  sections:='[]'::jsonb; rank_obj:=NULL; cycle_obj:=NULL; next_obj:=NULL;
  IF mode='RANK' THEN
   SELECT progression_order INTO cur_order FROM hon.curriculum_ranks WHERE id=e.current_rank_id AND curriculum_id=e.curriculum_id;
   IF e.current_rank_id IS NOT NULL THEN
    SELECT jsonb_build_object('name',left(regexp_replace(k.name,'[[:cntrl:]<>]','','g'),160),'color',CASE WHEN k.display_color ~ '^#[0-9A-Fa-f]{6}$' THEN k.display_color ELSE NULL END) INTO rank_obj
     FROM hon.curriculum_ranks k WHERE k.id=e.current_rank_id AND k.curriculum_id=e.curriculum_id;
    items:=(SELECT coalesce(jsonb_agg(jsonb_build_object('title',r.title,'description',r.description,'kind',r.kind,'url',r.url) ORDER BY r.title,r.id),'[]'::jsonb)
     FROM hon.curriculum_resources r WHERE r.curriculum_id=e.curriculum_id AND r.organization_id=p_organization AND r.school_id=p_school AND r.status='ACTIVE' AND r.audience='PARENT' AND r.rank_id=e.current_rank_id);
    IF jsonb_array_length(items)>0 THEN sections:=sections||jsonb_build_array(jsonb_build_object('label','CURRENT','items',items)); END IF;
    IF has_settings AND s.rank_show_earlier AND cur_order IS NOT NULL THEN
     items:=(SELECT coalesce(jsonb_agg(jsonb_build_object('title',r.title,'description',r.description,'kind',r.kind,'url',r.url) ORDER BY k.progression_order DESC,r.title,r.id),'[]'::jsonb)
      FROM hon.curriculum_resources r JOIN hon.curriculum_ranks k ON k.id=r.rank_id AND k.curriculum_id=r.curriculum_id
      WHERE r.curriculum_id=e.curriculum_id AND r.organization_id=p_organization AND r.school_id=p_school AND r.status='ACTIVE' AND r.audience='PARENT' AND k.progression_order<cur_order);
     IF jsonb_array_length(items)>0 THEN sections:=sections||jsonb_build_array(jsonb_build_object('label','REVIEW','items',items)); END IF;
    END IF;
   END IF;
   IF has_settings AND s.rank_show_next THEN
    SELECT k.id,k.name INTO next_rank FROM hon.curriculum_ranks k WHERE k.curriculum_id=e.curriculum_id AND k.organization_id=p_organization AND k.school_id=p_school
     AND (cur_order IS NULL OR k.progression_order>cur_order) ORDER BY k.progression_order,k.id LIMIT 1;
    IF next_rank.id IS NOT NULL THEN
     next_obj:=jsonb_build_object('name',left(regexp_replace(next_rank.name,'[[:cntrl:]<>]','','g'),160),'startsOn',NULL);
     items:=(SELECT coalesce(jsonb_agg(jsonb_build_object('title',r.title,'description',r.description,'kind',r.kind,'url',r.url) ORDER BY r.title,r.id),'[]'::jsonb)
      FROM hon.curriculum_resources r WHERE r.curriculum_id=e.curriculum_id AND r.organization_id=p_organization AND r.school_id=p_school AND r.status='ACTIVE' AND r.audience='PARENT' AND r.rank_id=next_rank.id);
     IF jsonb_array_length(items)>0 THEN sections:=sections||jsonb_build_array(jsonb_build_object('label','NEXT','items',items)); END IF;
    END IF;
   END IF;
  ELSE
   state:=hon.curriculum_app_cycle_state(e.curriculum_id,p_organization,p_school);
   IF jsonb_typeof(state->'current')='object' THEN
    cycle_obj:=jsonb_build_object('name',state#>>'{current,name}','startsOn',state#>'{current,startsOn}','endsOn',state#>'{current,endsOn}',
     'rotation',CASE WHEN has_settings THEN s.cycle_rotation ELSE 'STAFF_PICK' END);
    items:=(SELECT coalesce(jsonb_agg(jsonb_build_object('title',r.title,'description',r.description,'kind',r.kind,'url',r.url) ORDER BY r.title,r.id),'[]'::jsonb)
     FROM hon.curriculum_resources r WHERE r.curriculum_id=e.curriculum_id AND r.organization_id=p_organization AND r.school_id=p_school AND r.status='ACTIVE' AND r.audience='PARENT' AND r.cycle_id=(state#>>'{current,id}')::uuid);
    IF jsonb_array_length(items)>0 THEN sections:=sections||jsonb_build_array(jsonb_build_object('label','CURRENT','items',items)); END IF;
   END IF;
   IF has_settings AND s.cycle_show_next AND jsonb_typeof(state->'next')='object' AND (state#>>'{next,id}') IS DISTINCT FROM (state#>>'{current,id}') THEN
    next_obj:=jsonb_build_object('name',state#>>'{next,name}','startsOn',state#>'{next,startsOn}');
    items:=(SELECT coalesce(jsonb_agg(jsonb_build_object('title',r.title,'description',r.description,'kind',r.kind,'url',r.url) ORDER BY r.title,r.id),'[]'::jsonb)
     FROM hon.curriculum_resources r WHERE r.curriculum_id=e.curriculum_id AND r.organization_id=p_organization AND r.school_id=p_school AND r.status='ACTIVE' AND r.audience='PARENT' AND r.cycle_id=(state#>>'{next,id}')::uuid);
    IF jsonb_array_length(items)>0 THEN sections:=sections||jsonb_build_array(jsonb_build_object('label','NEXT','items',items)); END IF;
   END IF;
  END IF;
  items:=(SELECT coalesce(jsonb_agg(jsonb_build_object('title',r.title,'description',r.description,'kind',r.kind,'url',r.url) ORDER BY r.title,r.id),'[]'::jsonb)
   FROM hon.curriculum_resources r WHERE r.curriculum_id=e.curriculum_id AND r.organization_id=p_organization AND r.school_id=p_school AND r.status='ACTIVE' AND r.audience='PARENT' AND r.rank_id IS NULL AND r.cycle_id IS NULL);
  IF jsonb_array_length(items)>0 THEN sections:=sections||jsonb_build_array(jsonb_build_object('label','ALL','items',items)); END IF;
  out:=out||jsonb_build_array(jsonb_build_object('curriculumName',left(regexp_replace(e.curriculum_name,'[[:cntrl:]<>]','','g'),160),'mode',mode,
   'rank',rank_obj,'cycle',cycle_obj,'next',next_obj,'sections',sections));
 END LOOP;
 RETURN out;
END $$;

-- R2. Caller family argument is server-derived only and must equal the one live (chosen) family for the subject.
CREATE FUNCTION hon.read_parent_curriculum_app(p_subject text,p_family uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE scope record; children jsonb;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
  OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
  OR (SELECT count(*) FROM hon.resolve_parent_journey_scopes(p_subject))<>1 THEN RAISE EXCEPTION 'FAMILY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO scope FROM hon.resolve_parent_journey_scopes(p_subject);
 IF scope.family_id IS DISTINCT FROM p_family OR scope.organization_id IS DISTINCT FROM hon.current_organization_id() OR scope.school_id IS DISTINCT FROM hon.current_school_id() OR scope.principal_id::text IS DISTINCT FROM current_setting('app.hon_principal_id',true) THEN RAISE EXCEPTION 'FAMILY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=scope.organization_id FOR SHARE;
 PERFORM 1 FROM hon.schools WHERE id=scope.school_id AND organization_id=scope.organization_id FOR SHARE;
 PERFORM 1 FROM hon.users WHERE external_subject=p_subject FOR UPDATE;
 PERFORM 1 FROM hon.principals WHERE id=scope.principal_id FOR SHARE;
 PERFORM 1 FROM hon.family_access_grants WHERE principal_id=scope.principal_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.families WHERE id=p_family AND organization_id=scope.organization_id AND school_id=scope.school_id FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=scope.organization_id FOR SHARE;
 PERFORM 1 FROM hon.family_members WHERE family_id=p_family AND organization_id=scope.organization_id AND school_id=scope.school_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.student_profiles WHERE primary_family_id=p_family AND organization_id=scope.organization_id AND school_id=scope.school_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.student_curriculum_enrollments WHERE student_profile_id IN(SELECT id FROM hon.student_profiles WHERE primary_family_id=p_family AND organization_id=scope.organization_id AND school_id=scope.school_id) ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM hon.resolve_parent_journey_scopes(p_subject))<>1 OR NOT EXISTS(SELECT 1 FROM hon.resolve_parent_journey_scopes(p_subject) s WHERE s.family_id=p_family AND s.organization_id=scope.organization_id AND s.school_id=scope.school_id AND s.principal_id=scope.principal_id)
  OR NOT EXISTS(SELECT 1 FROM hon.organization_entitlements WHERE organization_id=scope.organization_id AND tier IN('ESSENTIAL','CORE','COMPLETE') AND status='ACTIVE' AND effective_from<=clock_timestamp() AND (effective_until IS NULL OR effective_until>clock_timestamp())) THEN RAISE EXCEPTION 'FAMILY_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(x.child ORDER BY x.display_name,x.id),'[]'::jsonb) INTO children FROM (
  SELECT student.id,left(regexp_replace(concat_ws(' ',person.given_name,person.family_name),'[[:cntrl:]<>]','','g'),160) display_name,
   jsonb_build_object('childDisplayName',left(regexp_replace(concat_ws(' ',person.given_name,person.family_name),'[[:cntrl:]<>]','','g'),160),
    'curricula',hon.curriculum_app_child_entries(student.id,scope.organization_id,scope.school_id)) child
  FROM hon.family_members member
  JOIN hon.student_profiles student ON student.person_id=member.person_id AND student.primary_family_id=p_family AND student.organization_id=member.organization_id AND student.school_id=member.school_id AND student.status='ACTIVE'
  JOIN hon.people person ON person.id=student.person_id AND person.organization_id=student.organization_id AND person.school_id=student.school_id
  WHERE member.family_id=p_family AND member.member_role='STUDENT' AND member.organization_id=scope.organization_id AND member.school_id=scope.school_id
  LIMIT 20) x;
 RETURN jsonb_build_object('children',children);
END $$;

-- R3. Staff preview of one own-school student, same shape as one parent child.
CREATE FUNCTION hon.read_staff_parent_app_curriculum_preview(p_subject text,p_student uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); result jsonb;
BEGIN
 IF p_student IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
 PERFORM hon.lock_curriculum_resource_actor(p_subject);
 SELECT jsonb_build_object('childDisplayName',left(regexp_replace(concat_ws(' ',person.given_name,person.family_name),'[[:cntrl:]<>]','','g'),160),
  'curricula',hon.curriculum_app_child_entries(student.id,org,school)) INTO result
  FROM hon.student_profiles student JOIN hon.people person ON person.id=student.person_id AND person.organization_id=student.organization_id AND person.school_id=student.school_id
  WHERE student.id=p_student AND student.organization_id=org AND student.school_id=school AND student.status='ACTIVE';
 IF result IS NULL THEN RAISE EXCEPTION 'STUDENT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 PERFORM hon.require_curriculum_actor(p_subject,'curriculum.manage');
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION hon.curriculum_app_child_entries(uuid,uuid,uuid),hon.read_parent_curriculum_app(text,uuid),hon.read_staff_parent_app_curriculum_preview(text,uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.curriculum_app_child_entries(uuid,uuid,uuid),hon.read_parent_curriculum_app(text,uuid),hon.read_staff_parent_app_curriculum_preview(text,uuid) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_parent_curriculum_app(text,uuid),hon.read_staff_parent_app_curriculum_preview(text,uuid) TO hon_runtime;
 END IF;
END $$;
COMMIT;
