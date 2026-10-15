-- HON HQ owner bootstrap
-- Run with the privileged migration/admin connection AFTER the account has first
-- signed into HON and its human user/principal record exists. Replace the
-- placeholder with the exact verified external_subject for the intended owner.
-- This is an ownership/security binding, so it is deliberately not callable by
-- a normal runtime request.

BEGIN;

WITH target AS (
  SELECT principal.id AS principal_id
  FROM hon.users AS app_user
  JOIN hon.principals AS principal
    ON principal.user_id = app_user.id
   AND principal.principal_type = 'HUMAN_USER'
   AND principal.is_active = true
  WHERE app_user.external_subject = '<PASTE_VERIFIED_EXTERNAL_SUBJECT_HERE>'
)
INSERT INTO hon.hq_operator_grants (principal_id, hq_role, permission_codes)
SELECT principal_id, 'HON_HQ_OWNER', ARRAY['hq.dashboard.view']::text[]
FROM target
WHERE NOT EXISTS (
  SELECT 1
  FROM hon.hq_operator_grants AS hq_grant
  WHERE hq_grant.principal_id = target.principal_id
    AND hq_grant.hq_role = 'HON_HQ_OWNER'
    AND hq_grant.effective_from <= now()
    AND (hq_grant.effective_until IS NULL OR hq_grant.effective_until > now())
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM hon.hq_operator_grants AS hq_grant
    JOIN hon.users AS app_user ON app_user.id = (
      SELECT principal.user_id FROM hon.principals AS principal WHERE principal.id = hq_grant.principal_id
    )
    WHERE app_user.external_subject = '<PASTE_VERIFIED_EXTERNAL_SUBJECT_HERE>'
      AND hq_grant.hq_role = 'HON_HQ_OWNER'
  ) THEN
    RAISE EXCEPTION 'No active human principal matched the supplied external subject. Sign in once first and verify the subject before retrying.';
  END IF;
END;
$$;

COMMIT;
