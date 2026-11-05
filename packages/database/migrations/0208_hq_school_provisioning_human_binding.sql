BEGIN;

-- HQ school provisioning: expected-principal binding and authority order (provisional number 0208; the owner allocates
-- the final number).
-- 0185 resolved the provisioning actor once, on now(), and then wrote the organization, entitlement, school, OWNER role,
-- grant, audit and outbox rows. Two gaps follow for the direct-human HQ "create school" screen (Codex #112):
-- - Nothing bound the command to the HQ principal the screen had verified. A browser whose session changed between the
--   screen's authority check and the POST created the school as whoever the cookie now named.
-- - An HQ grant that ended (or was removed) while the rows were being written still produced a committed school.
-- This migration:
-- - Adds hon.hq_provisioning_actor(subject): the 0185 authority rule (active human principal, HQ owner or an HQ grant
--   carrying hq.onboarding.manage) judged on clock_timestamp(), with the identity rows share-locked so the grant cannot
--   be revoked or edited under the command. Exactly one active principal per user is required.
-- - Replaces hon.provision_school_from_hq (same signature) so it uses that actor rule, and re-checks it after the last
--   durable write and before a replay is returned. Any failure raises and rolls the whole statement back.
-- - Adds hon.provision_school_from_hq_human(subject, expected principal, ...), the only runtime entry point. It refuses
--   (42501 HQ_EXPECTED_PRINCIPAL_MISMATCH) before any write unless the resolved actor is exactly the expected principal,
--   then returns the IDs, replay flag, actor echo and the school's current entitlement status.
-- - Runtime may no longer execute the 11-argument function directly.
-- Unchanged: tables, request-claim rules, fingerprint and replay rules, D9 SUSPENDED placeholder entitlement (no access,
-- no capabilities, no credits), audit and outbox shapes. 0185 itself is not edited. Nothing here is deployed.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'HQ provisioning binding requires a trusted migration owner';
  END IF;
END $$;

CREATE FUNCTION hon.hq_provisioning_actor(p_external_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid;
BEGIN
  IF p_external_subject IS NULL OR length(p_external_subject) NOT BETWEEN 1 AND 200 OR btrim(p_external_subject) <> p_external_subject THEN
    RETURN NULL;
  END IF;
  SELECT principal.id INTO actor
  FROM hon.users AS app_user
  JOIN hon.principals AS principal ON principal.user_id = app_user.id AND principal.principal_type = 'HUMAN_USER' AND principal.is_active
  JOIN hon.hq_operator_grants AS hq_grant ON hq_grant.principal_id = principal.id
    AND hq_grant.effective_from <= clock_timestamp() AND (hq_grant.effective_until IS NULL OR hq_grant.effective_until > clock_timestamp())
  WHERE app_user.external_subject = p_external_subject
    AND (SELECT count(*) FROM hon.principals AS other WHERE other.user_id = app_user.id AND other.is_active) = 1
    AND (hq_grant.hq_role = 'HON_HQ_OWNER' OR 'hq.onboarding.manage' = ANY (hq_grant.permission_codes))
  ORDER BY hq_grant.id
  LIMIT 1
  FOR SHARE OF app_user, principal, hq_grant;
  RETURN actor;
END $$;

CREATE OR REPLACE FUNCTION hon.provision_school_from_hq(
  p_external_subject text,
  p_legal_name text,
  p_display_name text,
  p_school_name text,
  p_school_slug text,
  p_timezone text,
  p_initial_tier hon.plan_tier,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_request_id uuid,
  p_correlation_id uuid
)
RETURNS TABLE (
  organization_id uuid,
  school_id uuid,
  owner_role_id uuid,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hon
AS $$
DECLARE
  v_actor_principal_id uuid;
  v_request_id uuid;
  v_prior_fingerprint text;
  v_prior_status text;
  v_prior_response jsonb;
  v_organization_id uuid;
  v_school_id uuid;
  v_owner_role_id uuid;
  v_response jsonb;
BEGIN
  IF btrim(p_legal_name) = '' OR btrim(p_display_name) = '' OR btrim(p_school_name) = ''
    OR btrim(p_school_slug) = '' OR btrim(p_timezone) = '' OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning requires non-blank organization, school, timezone, and idempotency fields.' USING ERRCODE = 'P0001';
  END IF;

  v_actor_principal_id := hon.hq_provisioning_actor(p_external_subject);
  IF v_actor_principal_id IS NULL THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning is not authorized for this account.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO hon.hq_onboarding_requests (actor_principal_id, idempotency_key, request_fingerprint, status)
  VALUES (v_actor_principal_id, p_idempotency_key, p_request_fingerprint, 'IN_PROGRESS')
  ON CONFLICT (actor_principal_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_request_id;
  IF v_request_id IS NULL THEN
    SELECT request_fingerprint, status, response_body INTO v_prior_fingerprint, v_prior_status, v_prior_response
    FROM hon.hq_onboarding_requests
    WHERE actor_principal_id = v_actor_principal_id AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF v_prior_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION 'HON HQ idempotency key was already used for a different tenant-provisioning request.' USING ERRCODE = '23505';
    END IF;
    IF v_prior_status = 'COMPLETED' AND v_prior_response IS NOT NULL THEN
      -- A replay discloses the prior IDs only while the same actor still holds provisioning authority.
      IF hon.hq_provisioning_actor(p_external_subject) IS DISTINCT FROM v_actor_principal_id THEN
        RAISE EXCEPTION 'HON HQ tenant provisioning is not authorized for this account.' USING ERRCODE = '42501';
      END IF;
      RETURN QUERY SELECT (v_prior_response->>'organizationId')::uuid, (v_prior_response->>'schoolId')::uuid, (v_prior_response->>'ownerRoleId')::uuid, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Matching HON HQ tenant-provisioning request is still in progress.' USING ERRCODE = '55P03';
  END IF;

  INSERT INTO hon.organizations (legal_name, display_name)
  VALUES (btrim(p_legal_name), btrim(p_display_name))
  RETURNING id INTO v_organization_id;
  -- D9: provisioning grants no operating access (SUSPENDED placeholder entitlement), unchanged from 0185.
  INSERT INTO hon.organization_entitlements (organization_id, tier, status)
  VALUES (v_organization_id, p_initial_tier, 'SUSPENDED');
  INSERT INTO hon.schools (organization_id, name, slug, timezone)
  VALUES (v_organization_id, btrim(p_school_name), lower(btrim(p_school_slug)), btrim(p_timezone))
  RETURNING id INTO v_school_id;
  INSERT INTO hon.roles (organization_id, code, name, is_system_role)
  VALUES (v_organization_id, 'OWNER', 'School Owner', true)
  RETURNING id INTO v_owner_role_id;
  INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
  SELECT v_owner_role_id, v_organization_id, permission.code FROM hon.permissions AS permission;
  INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id)
  VALUES (v_organization_id, v_school_id, v_actor_principal_id, v_owner_role_id, v_actor_principal_id);

  v_response := jsonb_build_object('organizationId', v_organization_id, 'schoolId', v_school_id, 'ownerRoleId', v_owner_role_id, 'tier', p_initial_tier::text,
    'entitlementStatus', 'SUSPENDED', 'access', 'NONE');
  INSERT INTO hon.audit_events (organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id, prior_state, next_state, result, request_id, correlation_id, occurred_at)
  VALUES (v_organization_id, v_school_id, v_actor_principal_id, 'HON_HQ', 'hq.organization.provision', 'ORGANIZATION', v_organization_id, NULL, v_response, 'SUCCEEDED', p_request_id, p_correlation_id, now());
  INSERT INTO hon.outbox_events (organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, causation_id, payload)
  VALUES (v_organization_id, v_school_id, 'organization.provisioned', 1, 'ORGANIZATION', v_organization_id, 1, p_correlation_id, p_request_id, v_response);
  UPDATE hon.hq_onboarding_requests SET status = 'COMPLETED', response_body = v_response, completed_at = now() WHERE id = v_request_id;

  -- Final authority decision point: after the last durable write, so a grant that ended meanwhile rolls everything back.
  IF hon.hq_provisioning_actor(p_external_subject) IS DISTINCT FROM v_actor_principal_id THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning is not authorized for this account.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_organization_id, v_school_id, v_owner_role_id, false;
END;
$$;

CREATE FUNCTION hon.provision_school_from_hq_human(
  p_external_subject text,
  p_expected_principal_id uuid,
  p_legal_name text,
  p_display_name text,
  p_school_name text,
  p_school_slug text,
  p_timezone text,
  p_initial_tier hon.plan_tier,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_request_id uuid,
  p_correlation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE actor uuid; r record; v_status text;
BEGIN
  IF p_expected_principal_id IS NULL THEN
    RAISE EXCEPTION 'HQ_EXPECTED_PRINCIPAL_REQUIRED' USING ERRCODE = '22023';
  END IF;
  actor := hon.hq_provisioning_actor(p_external_subject);
  IF actor IS NULL THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning is not authorized for this account.' USING ERRCODE = '42501';
  END IF;
  IF actor <> p_expected_principal_id THEN
    RAISE EXCEPTION 'HQ_EXPECTED_PRINCIPAL_MISMATCH' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO STRICT r FROM hon.provision_school_from_hq(p_external_subject, p_legal_name, p_display_name, p_school_name,
    p_school_slug, p_timezone, p_initial_tier, p_idempotency_key, p_request_fingerprint, p_request_id, p_correlation_id);
  SELECT e.status::text INTO STRICT v_status FROM hon.organization_entitlements AS e WHERE e.organization_id = r.organization_id;
  IF hon.hq_provisioning_actor(p_external_subject) IS DISTINCT FROM p_expected_principal_id THEN
    RAISE EXCEPTION 'HQ_EXPECTED_PRINCIPAL_MISMATCH' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('organizationId', r.organization_id, 'schoolId', r.school_id, 'ownerRoleId', r.owner_role_id,
    'replayed', r.replayed, 'actorPrincipalId', actor, 'entitlementStatus', v_status);
END $$;


DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY['hq_provisioning_actor(text)',
    'provision_school_from_hq(text,text,text,text,text,text,hon.plan_tier,text,text,uuid,uuid)',
    'provision_school_from_hq_human(text,uuid,text,text,text,text,text,hon.plan_tier,text,text,uuid,uuid)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM PUBLIC';
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
      EXECUTE 'REVOKE ALL ON FUNCTION hon.'||f||' FROM '||quote_ident(r);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.provision_school_from_hq_human(text,uuid,text,text,text,text,text,hon.plan_tier,text,text,uuid,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
