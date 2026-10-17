BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Trusted parent absence migration owner required'; END IF;
END $$;

-- Private helper. Shared canonical resolver owns active topology and human scope.
-- Unlike its historical best-grant selection, mixed live access levels are denied.
CREATE FUNCTION hon.require_parent_planned_absence_scope(p_subject text)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid,family_id uuid,access_level hon.family_access_level)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record;
BEGIN
 IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject)<>p_subject THEN RAISE EXCEPTION 'PARENT_ABSENCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF (SELECT count(*) FROM hon.resolve_parent_journey_scopes(p_subject))<>1 THEN RAISE EXCEPTION 'PARENT_ABSENCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM hon.resolve_parent_journey_scopes(p_subject);
 IF s.access_level NOT IN('PRIMARY_GUARDIAN','SECONDARY_GUARDIAN') OR EXISTS(
   SELECT 1 FROM hon.family_access_grants g WHERE g.principal_id=s.principal_id
   AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
   AND (g.family_id<>s.family_id OR g.organization_id<>s.organization_id OR g.school_id<>s.school_id OR g.access_level<>s.access_level)
 ) THEN RAISE EXCEPTION 'PARENT_ABSENCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT s.principal_id,s.organization_id,s.school_id,s.family_id,s.access_level;
END $$;

CREATE FUNCTION hon.read_parent_planned_absence_request_context(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record; live record; children jsonb;
BEGIN
 SELECT * INTO s FROM hon.require_parent_planned_absence_scope(p_subject);
 SELECT coalesce(jsonb_agg(x.item ORDER BY x.profile_id),'[]'::jsonb) INTO children FROM (
  SELECT profile.id profile_id,jsonb_build_object('studentProfileId',profile.id,'displayName',btrim(left(regexp_replace(concat_ws(' ',child.given_name,child.family_name),'[[:cntrl:]]','','g'),400))) item
  FROM hon.student_profiles profile
  JOIN hon.family_members member ON member.organization_id=profile.organization_id AND member.school_id=profile.school_id AND member.person_id=profile.person_id AND member.family_id=profile.primary_family_id AND member.member_role='STUDENT'
  JOIN hon.people child ON child.id=profile.person_id AND child.organization_id=profile.organization_id AND child.school_id=profile.school_id
  WHERE profile.organization_id=s.organization_id AND profile.school_id=s.school_id AND profile.primary_family_id=s.family_id AND profile.status='ACTIVE'
  AND btrim(regexp_replace(concat_ws(' ',child.given_name,child.family_name),'[[:cntrl:]]','','g'))<>''
  ORDER BY profile.id LIMIT 101
 ) x;
 IF jsonb_array_length(children)>100 THEN RAISE EXCEPTION 'PARENT_ABSENCE_CONTEXT_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 SELECT * INTO live FROM hon.require_parent_planned_absence_scope(p_subject);
 IF to_jsonb(s)<>to_jsonb(live) THEN RAISE EXCEPTION 'PARENT_ABSENCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('children',children);
END $$;

-- Locks only authority dependencies and the selected child, never request/review
-- tables or downstream models. SHARE authority-table locks prevent new-grant or
-- duplicate-principal phantoms until the canonical command transaction commits.
CREATE FUNCTION hon.lock_parent_planned_absence_request(p_subject text,p_child uuid,p_family uuid,p_access text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE s record;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER' OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN RAISE EXCEPTION 'PARENT_ABSENCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 LOCK TABLE hon.users,hon.principals,hon.family_access_grants IN SHARE MODE;
 SELECT * INTO s FROM hon.require_parent_planned_absence_scope(p_subject);
 IF s.family_id IS DISTINCT FROM p_family OR s.access_level::text IS DISTINCT FROM p_access OR s.organization_id IS DISTINCT FROM hon.current_organization_id() OR s.school_id IS DISTINCT FROM hon.current_school_id() OR s.principal_id IS DISTINCT FROM nullif(current_setting('app.hon_principal_id',true),'')::uuid THEN RAISE EXCEPTION 'PARENT_ABSENCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM hon.organizations WHERE id=s.organization_id FOR SHARE;
 PERFORM 1 FROM hon.schools WHERE id=s.school_id AND organization_id=s.organization_id FOR SHARE;
 PERFORM 1 FROM hon.families WHERE id=s.family_id AND organization_id=s.organization_id AND school_id=s.school_id FOR SHARE;
 PERFORM 1 FROM hon.student_profiles profile
 JOIN hon.family_members member ON member.organization_id=profile.organization_id AND member.school_id=profile.school_id AND member.person_id=profile.person_id AND member.family_id=profile.primary_family_id AND member.member_role='STUDENT'
 JOIN hon.people child ON child.id=profile.person_id AND child.organization_id=profile.organization_id AND child.school_id=profile.school_id
 WHERE profile.id=p_child AND profile.organization_id=s.organization_id AND profile.school_id=s.school_id AND profile.primary_family_id=s.family_id AND profile.status='ACTIVE'
 AND btrim(regexp_replace(concat_ws(' ',child.given_name,child.family_name),'[[:cntrl:]]','','g'))<>'' FOR SHARE OF profile,member,child;
 IF NOT FOUND THEN RAISE EXCEPTION 'PARENT_ABSENCE_CHILD_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM hon.require_parent_planned_absence_scope(p_subject) live WHERE to_jsonb(live)=to_jsonb(s)) THEN RAISE EXCEPTION 'PARENT_ABSENCE_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION hon.require_parent_planned_absence_scope(text),hon.read_parent_planned_absence_request_context(text),hon.lock_parent_planned_absence_request(text,uuid,uuid,text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role','hon_runtime') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.require_parent_planned_absence_scope(text),hon.read_parent_planned_absence_request_context(text),hon.lock_parent_planned_absence_request(text,uuid,uuid,text) FROM %I',r);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
  GRANT EXECUTE ON FUNCTION hon.read_parent_planned_absence_request_context(text),hon.lock_parent_planned_absence_request(text,uuid,uuid,text) TO hon_runtime;
 END IF;
END $$;
COMMIT;
