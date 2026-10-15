BEGIN;

-- Global permission definitions are system reference data. Organization roles
-- receive only the subset chosen by an administrator; no role grants are seeded.
INSERT INTO hon.permissions (code, description, is_sensitive) VALUES
  ('school.view', 'View an authorized school operational scope', false),
  ('crm.trial.schedule', 'Schedule a trial within an authorized school', false),
  ('crm.lead.follow_up.send', 'Send an authorized lead follow-up', false),
  ('billing.membership.activate', 'Activate a membership under policy', true),
  ('billing.invoice.issue', 'Issue an invoice under policy', true),
  ('billing.payment.initiate', 'Initiate a payment through an approved provider path', true),
  ('billing.refund.create', 'Create a refund request', true),
  ('marketing.social.publish', 'Publish approved marketing content', true)
ON CONFLICT (code) DO NOTHING;

-- This is the sole deliberate bridge from a verified external subject to a
-- school scope. It is SECURITY DEFINER because normal runtime data-plane roles
-- cannot enumerate global users/principals/role grants. The caller supplies a
-- JWT-verified external subject and a route-selected school ID; the function
-- derives the organization/principal/permission from HON IAM records.
CREATE OR REPLACE FUNCTION hon.resolve_authorized_scope(
  p_external_subject text,
  p_school_id uuid,
  p_permission_code text
)
RETURNS TABLE (
  principal_id uuid,
  organization_id uuid,
  school_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
  SELECT DISTINCT
    principal.id AS principal_id,
    role_grant.organization_id AS organization_id,
    role_grant.school_id AS school_id
  FROM hon.users AS app_user
  JOIN hon.principals AS principal
    ON principal.user_id = app_user.id
   AND principal.principal_type = 'HUMAN_USER'
   AND principal.is_active = true
  JOIN hon.principal_role_grants AS role_grant
    ON role_grant.principal_id = principal.id
   AND role_grant.school_id = p_school_id
   AND role_grant.effective_from <= now()
   AND (role_grant.effective_until IS NULL OR role_grant.effective_until > now())
  JOIN hon.schools AS school
    ON school.id = role_grant.school_id
   AND school.organization_id = role_grant.organization_id
   AND school.status = 'ACTIVE'
  JOIN hon.role_permissions AS role_permission
    ON role_permission.role_id = role_grant.role_id
   AND role_permission.organization_id = role_grant.organization_id
   AND role_permission.permission_code = p_permission_code
  WHERE app_user.external_subject = p_external_subject
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION hon.resolve_authorized_scope(text, uuid, text) FROM PUBLIC;

COMMIT;
