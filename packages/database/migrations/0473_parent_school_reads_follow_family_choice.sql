BEGIN;

-- Parent reads that name a school follow the family picker (0473, coordinator-allocated 2026-11-18). 0471 let a parent
-- linked to several families choose one, and every path through hon.resolve_parent_journey_scopes follows that choice.
-- The older reads that name a school (documents, achievements, curriculum progress, testing interest, and the API's
-- per-school parent scope) call 0071 hon.resolve_parent_family_scope(subject, school) directly, so they did not.
--   R1  hon.parent_family_scope_any keeps the exact 0071 body: every live family scope of the parent at one school.
--   R2  hon.parent_live_family_scopes (0471) lists the choices from R1, so the picker itself is unchanged.
--   R3  hon.resolve_parent_family_scope keeps its signature, owner and ACL. With at most one live family it returns
--       exactly what 0071 returned. With several, it returns only the chosen live family, and nothing at any school
--       until the parent chooses, the same rule as every other parent path.
-- No table, grant or runtime entry point is added. Callers keep their own checks and lock-then-recheck order.

-- R1: the 0071 body, unchanged, under a private name.
CREATE FUNCTION hon.parent_family_scope_any(p_external_subject text,p_school_id uuid)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid,family_id uuid,access_level hon.family_access_level)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT DISTINCT ON(g.family_id) p.id,g.organization_id,g.school_id,g.family_id,g.access_level
 FROM hon.users u JOIN hon.principals p ON p.user_id=u.id AND p.principal_type='HUMAN_USER' AND p.is_active
 JOIN hon.family_access_grants g ON g.principal_id=p.id AND g.school_id=p_school_id
 JOIN hon.families f ON f.id=g.family_id AND f.organization_id=g.organization_id AND f.school_id=g.school_id
 JOIN hon.schools s ON s.id=g.school_id AND s.organization_id=g.organization_id
 JOIN hon.organizations o ON o.id=s.organization_id
 WHERE u.external_subject=p_external_subject AND f.status='ACTIVE' AND s.status='ACTIVE' AND o.status='ACTIVE'
 AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.is_active AND x.principal_type='HUMAN_USER')=1
 AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp())
 ORDER BY g.family_id,CASE g.access_level WHEN 'PRIMARY_GUARDIAN' THEN 3 WHEN 'SECONDARY_GUARDIAN' THEN 2 ELSE 1 END DESC,g.effective_from DESC,g.id;
$$;

-- R2: the 0471 body with R1 in place of the school resolver.
CREATE OR REPLACE FUNCTION hon.parent_live_family_scopes(subject text)
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
  FROM candidate_schools c CROSS JOIN LATERAL hon.parent_family_scope_any(subject,c.school_id) s
  ORDER BY s.school_id,s.family_id LIMIT 20;
$$;

-- R3: one live family overall answers as before; several answer only with the live choice.
CREATE OR REPLACE FUNCTION hon.resolve_parent_family_scope(p_external_subject text,p_school_id uuid)
RETURNS TABLE(principal_id uuid,organization_id uuid,school_id uuid,family_id uuid,access_level hon.family_access_level)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 WITH live AS MATERIALIZED (SELECT * FROM hon.parent_live_family_scopes(p_external_subject))
 SELECT a.principal_id,a.organization_id,a.school_id,a.family_id,a.access_level
 FROM hon.parent_family_scope_any(p_external_subject,p_school_id) a
 WHERE (SELECT count(*) FROM live)<=1
   OR EXISTS(SELECT 1 FROM hon.users u JOIN hon.parent_family_selections c ON c.user_id=u.id
     JOIN live l ON l.organization_id=c.organization_id AND l.school_id=c.school_id AND l.family_id=c.family_id
     WHERE u.external_subject=p_external_subject
       AND c.organization_id=a.organization_id AND c.school_id=a.school_id AND c.family_id=a.family_id);
$$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.parent_family_scope_any(text,uuid) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.parent_family_scope_any(text,uuid) FROM %I',r);
  END LOOP;
END $$;

COMMIT;
