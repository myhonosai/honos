BEGIN;

-- Internal discovery only. No client school/family selector, directory grants,
-- domain writes, current-child guesses, or staff/HQ permission fallback.
-- Return at most two scopes so the API can refuse an ambiguous current family.
CREATE FUNCTION hon.resolve_parent_journey_scopes(subject text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid, family_id uuid, access_level hon.family_access_level)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
  WITH candidate_schools AS (
    SELECT DISTINCT g.school_id
    FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
    JOIN hon.family_access_grants g ON g.principal_id=p.id
    WHERE u.external_subject=subject AND length(subject) BETWEEN 1 AND 200
      AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
  )
  SELECT s.principal_id,s.organization_id,s.school_id,s.family_id,s.access_level
  FROM candidate_schools c CROSS JOIN LATERAL hon.resolve_parent_family_scope(subject,c.school_id) s
  ORDER BY s.school_id,s.family_id LIMIT 2;
$$;
REVOKE ALL ON FUNCTION hon.resolve_parent_journey_scopes(text) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('anon','authenticated','service_role','hon_runtime') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.resolve_parent_journey_scopes(text) FROM %I',r);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.resolve_parent_journey_scopes(text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
