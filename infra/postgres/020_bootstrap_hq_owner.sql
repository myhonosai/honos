-- HON HQ owner bootstrap (first owner of a new environment)
-- Run once in the Supabase SQL Editor / privileged admin connection, AFTER the owner has
-- signed in through /auth/login. HON creates user records only through invitations, so the
-- very first HQ owner is provisioned here (same semantics as `pnpm --filter @hon/database
-- bootstrap:hq-owner`). This is an ownership/security binding: never expose it as a route.
--
-- Fill the three values from the signed-in browser's GET /api/identity/me response
-- ("externalSubject", "email", "displayName"). Never guess a subject from an email address.
-- Re-runnable: an existing user/principal is reused and no second active grant is created.

BEGIN;

DO $$
DECLARE
  owner_subject text := '<PASTE_EXTERNAL_SUBJECT_FROM_API_IDENTITY_ME>';
  owner_email   text := '<PASTE_EMAIL>';
  owner_name    text := '<PASTE_DISPLAY_NAME>';
  v_user uuid;
  v_principal uuid;
BEGIN
  IF owner_subject ~ '[<>\s]' OR owner_subject = '' THEN RAISE EXCEPTION 'Replace the external subject placeholder.'; END IF;
  IF owner_email !~ '^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$' THEN RAISE EXCEPTION 'Replace the email placeholder.'; END IF;
  IF owner_name ~ '[<>]' OR length(trim(owner_name)) = 0 THEN RAISE EXCEPTION 'Replace the display name placeholder.'; END IF;

  SELECT id INTO v_user FROM hon.users WHERE external_subject = owner_subject;
  IF v_user IS NULL THEN
    -- Never link an existing identity just because its email matches.
    IF EXISTS (SELECT 1 FROM hon.users WHERE lower(email::text) = lower(owner_email)) THEN
      RAISE EXCEPTION 'Another HON user already has this email; review before binding HQ ownership.';
    END IF;
    INSERT INTO hon.users (external_subject, email, display_name)
      VALUES (owner_subject, lower(owner_email), owner_name) RETURNING id INTO v_user;
    INSERT INTO hon.principals (principal_type, user_id, display_name)
      VALUES ('HUMAN_USER', v_user, owner_name) RETURNING id INTO v_principal;
  ELSE
    SELECT id INTO v_principal FROM hon.principals
      WHERE user_id = v_user AND principal_type = 'HUMAN_USER' AND is_active;
    IF v_principal IS NULL THEN RAISE EXCEPTION 'User exists without exactly one active human principal; review first.'; END IF;
  END IF;

  INSERT INTO hon.hq_operator_grants (principal_id, hq_role, permission_codes)
  SELECT v_principal, 'HON_HQ_OWNER', ARRAY['hq.dashboard.view']::text[]
  WHERE NOT EXISTS (
    SELECT 1 FROM hon.hq_operator_grants g
    WHERE g.principal_id = v_principal AND g.hq_role = 'HON_HQ_OWNER'
      AND g.effective_from <= now() AND (g.effective_until IS NULL OR g.effective_until > now())
  );

  IF NOT EXISTS (
    SELECT 1 FROM hon.hq_operator_grants g
    WHERE g.principal_id = v_principal AND g.hq_role = 'HON_HQ_OWNER'
      AND g.effective_from <= now() AND (g.effective_until IS NULL OR g.effective_until > now())
  ) THEN
    RAISE EXCEPTION 'HQ owner grant was not present after bootstrap.';
  END IF;
END $$;

COMMIT;
