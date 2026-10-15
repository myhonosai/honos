BEGIN;

-- Parent/Eian scope derives from a verified application subject and an active,
-- explicit family grant. Client-supplied family identifiers do not authorize access.
CREATE FUNCTION hon.resolve_parent_family_scope(
  p_external_subject text,
  p_school_id uuid
)
RETURNS TABLE (
  principal_id uuid,
  organization_id uuid,
  school_id uuid,
  family_id uuid,
  access_level hon.family_access_level
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT DISTINCT ON (family_grant.family_id)
    principal.id,
    family_grant.organization_id,
    family_grant.school_id,
    family_grant.family_id,
    family_grant.access_level
  FROM hon.users AS app_user
  JOIN hon.principals AS principal
    ON principal.user_id = app_user.id
   AND principal.principal_type = 'HUMAN_USER'
   AND principal.is_active = true
  JOIN hon.family_access_grants AS family_grant
    ON family_grant.principal_id = principal.id
   AND family_grant.school_id = p_school_id
   AND family_grant.effective_from <= now()
   AND (family_grant.effective_until IS NULL OR family_grant.effective_until > now())
  WHERE app_user.external_subject = p_external_subject
  ORDER BY family_grant.family_id,
    CASE family_grant.access_level
      WHEN 'PRIMARY_GUARDIAN' THEN 3
      WHEN 'SECONDARY_GUARDIAN' THEN 2
      WHEN 'VIEWER' THEN 1
    END DESC,
    family_grant.effective_from DESC;
$$;

REVOKE ALL ON FUNCTION hon.resolve_parent_family_scope(text, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT USAGE ON TYPE hon.family_access_level TO hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.resolve_parent_family_scope(text, uuid) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
