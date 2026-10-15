BEGIN;

CREATE TABLE hon.hq_operator_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  hq_role text NOT NULL CHECK (hq_role IN ('HON_HQ_OWNER', 'HON_HQ_OPERATOR', 'HON_HQ_SUPPORT')),
  permission_codes text[] NOT NULL DEFAULT '{}'::text[],
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  granted_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_from),
  UNIQUE (principal_id, hq_role, effective_from)
);

ALTER TABLE hon.hq_operator_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.hq_operator_grants FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION hon.resolve_hq_operator_scope(
  p_external_subject text,
  p_permission_code text
)
RETURNS TABLE (
  principal_id uuid,
  hq_role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT DISTINCT principal.id, hq_grant.hq_role
  FROM hon.users AS app_user
  JOIN hon.principals AS principal
    ON principal.user_id = app_user.id
   AND principal.principal_type = 'HUMAN_USER'
   AND principal.is_active = true
  JOIN hon.hq_operator_grants AS hq_grant
    ON hq_grant.principal_id = principal.id
   AND hq_grant.effective_from <= now()
   AND (hq_grant.effective_until IS NULL OR hq_grant.effective_until > now())
  WHERE app_user.external_subject = p_external_subject
    AND (
      hq_grant.hq_role = 'HON_HQ_OWNER'
      OR p_permission_code = ANY (hq_grant.permission_codes)
    )
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION hon.resolve_hq_operator_scope(text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hon.resolve_hq_operator_scope(text, text) TO hon_runtime';
  END IF;
END;
$$;

COMMIT;
