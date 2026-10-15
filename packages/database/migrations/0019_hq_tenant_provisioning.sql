BEGIN;

-- HQ onboarding writes tenant topology only through this fixed, audited,
-- SECURITY DEFINER boundary. The normal runtime role never receives direct
-- access to HON's global identity, role, or role-grant directory tables.
CREATE TABLE hon.hq_onboarding_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (actor_principal_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION hon.provision_school_from_hq(
  p_external_subject text,
  p_legal_name text,
  p_display_name text,
  p_school_name text,
  p_school_slug text,
  p_timezone text,
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
    RAISE EXCEPTION 'HON HQ tenant provisioning requires non-blank organization, school, timezone, and idempotency fields.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT principal.id INTO v_actor_principal_id
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
    AND (hq_grant.hq_role = 'HON_HQ_OWNER' OR 'hq.onboarding.manage' = ANY (hq_grant.permission_codes))
  LIMIT 1;

  IF v_actor_principal_id IS NULL THEN
    RAISE EXCEPTION 'HON HQ tenant provisioning is not authorized for this account.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO hon.hq_onboarding_requests (actor_principal_id, idempotency_key, request_fingerprint, status)
  VALUES (v_actor_principal_id, p_idempotency_key, p_request_fingerprint, 'IN_PROGRESS')
  ON CONFLICT (actor_principal_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_request_id;

  IF v_request_id IS NULL THEN
    SELECT request_fingerprint, status, response_body
      INTO v_prior_fingerprint, v_prior_status, v_prior_response
    FROM hon.hq_onboarding_requests
    WHERE actor_principal_id = v_actor_principal_id AND idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF v_prior_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION 'HON HQ idempotency key was already used for a different tenant-provisioning request.'
        USING ERRCODE = '23505';
    END IF;
    IF v_prior_status = 'COMPLETED' AND v_prior_response IS NOT NULL THEN
      RETURN QUERY SELECT
        (v_prior_response->>'organizationId')::uuid,
        (v_prior_response->>'schoolId')::uuid,
        (v_prior_response->>'ownerRoleId')::uuid,
        true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Matching HON HQ tenant-provisioning request is still in progress.' USING ERRCODE = '55P03';
  END IF;

  INSERT INTO hon.organizations (legal_name, display_name)
  VALUES (btrim(p_legal_name), btrim(p_display_name))
  RETURNING id INTO v_organization_id;

  INSERT INTO hon.schools (organization_id, name, slug, timezone)
  VALUES (v_organization_id, btrim(p_school_name), lower(btrim(p_school_slug)), btrim(p_timezone))
  RETURNING id INTO v_school_id;

  INSERT INTO hon.roles (organization_id, code, name, is_system_role)
  VALUES (v_organization_id, 'OWNER', 'School Owner', true)
  RETURNING id INTO v_owner_role_id;

  INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
  SELECT v_owner_role_id, v_organization_id, permission.code
  FROM hon.permissions AS permission;

  INSERT INTO hon.principal_role_grants (
    organization_id, school_id, principal_id, role_id, granted_by_principal_id
  ) VALUES (
    v_organization_id, v_school_id, v_actor_principal_id, v_owner_role_id, v_actor_principal_id
  );

  v_response := jsonb_build_object(
    'organizationId', v_organization_id,
    'schoolId', v_school_id,
    'ownerRoleId', v_owner_role_id
  );

  INSERT INTO hon.audit_events (
    organization_id, school_id, actor_principal_id, source, action_code,
    entity_type, entity_id, prior_state, next_state, result,
    request_id, correlation_id, occurred_at
  ) VALUES (
    v_organization_id, v_school_id, v_actor_principal_id, 'HON_HQ', 'hq.organization.provision',
    'ORGANIZATION', v_organization_id, NULL, v_response, 'SUCCEEDED',
    p_request_id, p_correlation_id, now()
  );

  INSERT INTO hon.outbox_events (
    organization_id, school_id, event_type, schema_version, aggregate_type,
    aggregate_id, aggregate_version, correlation_id, causation_id, payload
  ) VALUES (
    v_organization_id, v_school_id, 'organization.provisioned', 1, 'ORGANIZATION',
    v_organization_id, 1, p_correlation_id, p_request_id, v_response
  );

  UPDATE hon.hq_onboarding_requests
  SET status = 'COMPLETED', response_body = v_response, completed_at = now()
  WHERE id = v_request_id;

  RETURN QUERY SELECT v_organization_id, v_school_id, v_owner_role_id, false;
END;
$$;

REVOKE ALL ON FUNCTION hon.provision_school_from_hq(text, text, text, text, text, text, text, text, uuid, uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.provision_school_from_hq(text, text, text, text, text, text, text, text, uuid, uuid) TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
