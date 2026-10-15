BEGIN;

-- Keep 0065 immutable after development application. Trim again AFTER the
-- 160-character clip, which may fall exactly on a word separator. Same fixed
-- source/permission/route/ACL boundary; no writes or generic dynamic SQL.
CREATE OR REPLACE FUNCTION hon.search_school(
  p_external_subject text, p_organization_id uuid, p_school_id uuid,
  p_q text, p_types text[], p_entity_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, hon AS $$
DECLARE
  v_as_of timestamptz := statement_timestamp();
  v_principal uuid;
  v_count bigint;
  v_q text;
  v_results jsonb;
  v_types constant text[] := ARRAY['STUDENT','LEAD','CLASS_SESSION','PROGRAM','CURRICULUM'];
BEGIN
  -- Verified session subject is supplied only by the server guard. Route IDs,
  -- tier, principal and tenant GUCs are never authority; reject ambiguous humans.
  SELECT count(*),(array_agg(p.id))[1] INTO v_count,v_principal
  FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_external_subject AND p.principal_type='HUMAN_USER' AND p.is_active;
  IF v_count<>1 OR NOT EXISTS (
    SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id
    JOIN hon.principal_role_grants g ON g.organization_id=o.id AND g.school_id=s.id
    JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=o.id
    JOIN hon.role_permissions rp ON rp.role_id=r.id AND rp.organization_id=o.id AND rp.permission_code='search.global'
    WHERE o.id=p_organization_id AND s.id=p_school_id AND o.status='ACTIVE' AND s.status='ACTIVE'
      AND (r.management_school_id IS NULL OR r.management_school_id=s.id)
      AND g.principal_id=v_principal AND g.revoked_at IS NULL
      AND g.effective_from<=v_as_of AND (g.effective_until IS NULL OR g.effective_until>v_as_of)
  ) THEN
    RAISE EXCEPTION 'SEARCH_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  -- No entitlement lookup/upgrade gate: Essential, Core and Complete are equal.
  -- Normalize common Unicode spaces exactly as the API; controls/bidi are invalid.
  IF p_q IS NULL OR char_length(p_q)>120 OR p_q ~ '[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;
  v_q := lower(btrim(regexp_replace(p_q,'[ \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+',' ','g')));
  IF v_q='' OR p_types IS NULL OR cardinality(p_types) NOT BETWEEN 1 AND 5
    OR array_ndims(p_types)<>1 OR array_position(p_types,NULL) IS NOT NULL
    OR NOT p_types <@ v_types OR cardinality(p_types)<>(SELECT count(DISTINCT t) FROM unnest(p_types) t)
    OR (p_entity_id IS NOT NULL AND cardinality(p_types)<>1) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023';
  END IF;

  WITH candidates AS (
    SELECT 'STUDENT'::text AS kind,s.id AS entity_id,concat_ws(' ',p.given_name,p.family_name) AS name,
      'Student · '||s.status::text AS subtitle
    FROM hon.student_profiles s JOIN hon.people p ON p.id=s.person_id AND p.organization_id=s.organization_id AND p.school_id=s.school_id
    WHERE s.organization_id=p_organization_id AND s.school_id=p_school_id AND 'STUDENT'=ANY(p_types)
      AND (p_entity_id IS NULL OR s.id=p_entity_id)
      AND (p_entity_id IS NOT NULL OR strpos(lower(concat_ws(' ',p.given_name,p.family_name)),v_q)>0)
    UNION ALL
    SELECT 'LEAD',l.id,concat_ws(' ',p.given_name,p.family_name),'Lead · '||l.status::text
    FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id AND p.organization_id=l.organization_id AND p.school_id=l.school_id
    WHERE l.organization_id=p_organization_id AND l.school_id=p_school_id AND 'LEAD'=ANY(p_types)
      AND (p_entity_id IS NULL OR l.id=p_entity_id)
      -- Contact matching is deliberate; no email/phone/contact value is returned.
      AND (p_entity_id IS NOT NULL OR strpos(lower(concat_ws(' ',p.given_name,p.family_name)),v_q)>0
        OR strpos(lower(coalesce(p.email::text,'')),v_q)>0 OR strpos(coalesce(p.phone_e164,''),v_q)>0)
    UNION ALL
    SELECT 'CLASS_SESSION',s.id,s.name,'Class session · '||s.status::text
    FROM hon.class_sessions s WHERE s.organization_id=p_organization_id AND s.school_id=p_school_id AND 'CLASS_SESSION'=ANY(p_types)
      AND (p_entity_id IS NULL OR s.id=p_entity_id) AND (p_entity_id IS NOT NULL OR strpos(lower(s.name),v_q)>0)
    UNION ALL
    SELECT 'PROGRAM',p.id,p.name,'Program · '||p.status::text
    FROM hon.programs p WHERE p.organization_id=p_organization_id AND p.school_id=p_school_id AND 'PROGRAM'=ANY(p_types)
      AND (p_entity_id IS NULL OR p.id=p_entity_id) AND (p_entity_id IS NOT NULL OR strpos(lower(p.name),v_q)>0)
    UNION ALL
    SELECT 'CURRICULUM',c.id,c.name,'Curriculum · '||c.lifecycle::text
    FROM hon.curricula c WHERE c.organization_id=p_organization_id AND c.school_id=p_school_id AND 'CURRICULUM'=ANY(p_types)
      AND (p_entity_id IS NULL OR c.id=p_entity_id) AND (p_entity_id IS NOT NULL OR strpos(lower(c.name),v_q)>0)
  ), display AS (
    SELECT kind,entity_id,
      coalesce(nullif(btrim(left(btrim(regexp_replace(regexp_replace(name,'[[:cntrl:]\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]','','g'),
        '[ \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+',' ','g')),160)),''),'Unnamed record') AS title,
      subtitle FROM candidates
  ), ranked AS (
    SELECT *,CASE WHEN lower(title)=v_q THEN 0 WHEN strpos(lower(title),v_q)=1 THEN 1 ELSE 2 END AS relevance
    FROM display
    ORDER BY relevance,lower(title) COLLATE "C",kind COLLATE "C",entity_id LIMIT 20
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'entityId',entity_id,'title',title,'subtitle',subtitle,
    'route','/staff/search/'||p_organization_id::text||'/'||p_school_id::text||'/'||kind||'/'||entity_id::text)
    ORDER BY relevance,lower(title) COLLATE "C",kind COLLATE "C",entity_id),'[]'::jsonb) INTO v_results FROM ranked;
  RETURN jsonb_build_object('organizationId',p_organization_id,'schoolId',p_school_id,'results',v_results);
END $$;
REVOKE ALL ON FUNCTION hon.search_school(text,uuid,uuid,text,text[],uuid) FROM PUBLIC;
COMMIT;
