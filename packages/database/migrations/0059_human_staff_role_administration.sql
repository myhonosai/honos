BEGIN;

-- Roles are organization-owned; new tenant custom roles are managed and usable
-- at ONE school only. Legacy organization roles remain grantable, never editable.
ALTER TABLE hon.roles
  ADD COLUMN management_school_id uuid,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD CONSTRAINT roles_management_school_fk FOREIGN KEY (management_school_id, organization_id)
    REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT;
ALTER TABLE hon.principal_role_grants
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  ADD CONSTRAINT role_grant_revocation_pair CHECK ((revoked_at IS NULL) = (revoked_by_principal_id IS NULL));
ALTER TABLE hon.permissions ADD COLUMN is_staff_assignable boolean NOT NULL DEFAULT false;

INSERT INTO hon.permissions(code, description, is_sensitive, is_staff_assignable) VALUES
  ('iam.custom_role.create', 'Human creation of a school-scoped custom role', true, true),
  ('iam.custom_role.update', 'Human versioned update of a school-scoped custom role', true, true),
  ('iam.staff_role.manage', 'Human access to scoped staff role administration', true, true),
  ('iam.staff_role.grant', 'Human granting of an existing permitted staff role', true, true),
  ('iam.staff_role.revoke', 'Human ending of an existing staff role grant', true, true);
-- Closed allowlist: future permission definitions are NOT automatically assignable.
UPDATE hon.permissions SET is_staff_assignable = true WHERE code IN (
  'school.view', 'action.approve', 'ai.invocation.plan', 'ai.team.configure', 'ai.usage.read',
  'attendance.record', 'billing.account.create', 'billing.invoice.create', 'billing.invoice.issue',
  'billing.membership.activate', 'billing.membership.cancel', 'billing.membership.create',
  'billing.payment.initiate', 'billing.refund.create', 'communication.consent.manage',
  'communication.consent.read', 'communication.message.create', 'communication.message.queue',
  'communication.message.read', 'crm.lead.create', 'crm.lead.follow_up.send', 'crm.lead.read',
  'crm.pipeline.manage', 'crm.trial.manage', 'crm.trial.schedule', 'curriculum.manage',
  'curriculum.rank.manage', 'family.create', 'family.member.manage', 'family.read',
  'knowledge.approve', 'knowledge.manage', 'marketing.social.publish', 'people.create',
  'people.read', 'program.manage', 'reporting.view', 'schedule.booking.manage',
  'schedule.planned_absence.review', 'schedule.session.manage', 'student.enroll',
  'testing.candidate.grade', 'testing.candidate.manage', 'testing.event.manage',
  'testing.promotion.decide', 'work_item.manage', 'work_item.read'
);
-- Only existing canonical system OWNER roles are brought forward. No new grants,
-- no non-OWNER role upgrades. HQ bootstrap already SELECTs all current permissions.
INSERT INTO hon.role_permissions(role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code FROM hon.roles role
CROSS JOIN hon.permissions permission
WHERE role.is_system_role AND role.code = 'OWNER'
  AND permission.code IN ('iam.custom_role.create','iam.custom_role.update',
    'iam.staff_role.manage','iam.staff_role.grant','iam.staff_role.revoke')
ON CONFLICT DO NOTHING;

ALTER TABLE hon.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_tenant_isolation ON hon.role_permissions
  USING (organization_id = hon.current_organization_id())
  WITH CHECK (organization_id = hon.current_organization_id());
DROP POLICY roles_tenant_isolation ON hon.roles;
CREATE POLICY roles_tenant_isolation ON hon.roles
  USING (organization_id = hon.current_organization_id()
    AND (management_school_id IS NULL OR management_school_id = hon.current_school_id()))
  WITH CHECK (organization_id = hon.current_organization_id()
    AND (management_school_id IS NULL OR management_school_id = hon.current_school_id()));

-- Canonical resolvers recognize explicit revocation immediately; timestamps use
-- a statement snapshot rather than the start of a potentially long transaction.
CREATE OR REPLACE FUNCTION hon.resolve_authorized_scope(p_external_subject text, p_school_id uuid, p_permission_code text)
RETURNS TABLE(principal_id uuid, organization_id uuid, school_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT DISTINCT principal.id, school.organization_id, school.id
  FROM hon.users app_user JOIN hon.principals principal ON principal.user_id = app_user.id
  JOIN hon.principal_role_grants role_grant ON role_grant.principal_id = principal.id
  JOIN hon.schools school ON school.id = role_grant.school_id AND school.organization_id = role_grant.organization_id
  JOIN hon.organizations organization ON organization.id = school.organization_id
  JOIN hon.role_permissions permission ON permission.role_id = role_grant.role_id AND permission.organization_id = school.organization_id
  WHERE app_user.external_subject = p_external_subject AND principal.principal_type = 'HUMAN_USER' AND principal.is_active
    AND (SELECT count(*) FROM hon.principals p WHERE p.user_id = app_user.id AND p.principal_type = 'HUMAN_USER' AND p.is_active) = 1
    AND school.id = p_school_id AND school.status = 'ACTIVE' AND organization.status = 'ACTIVE'
    AND role_grant.revoked_at IS NULL AND role_grant.effective_from <= statement_timestamp()
    AND (role_grant.effective_until IS NULL OR role_grant.effective_until > statement_timestamp())
    AND permission.permission_code = p_permission_code LIMIT 1
$$;
CREATE OR REPLACE FUNCTION hon.principal_has_school_permission(p_principal_id uuid, p_organization_id uuid, p_school_id uuid, p_permission_code text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
  SELECT EXISTS (SELECT 1 FROM hon.principals principal
    JOIN hon.principal_role_grants role_grant ON role_grant.principal_id = principal.id
    JOIN hon.role_permissions permission ON permission.role_id = role_grant.role_id AND permission.organization_id = p_organization_id
    JOIN hon.schools school ON school.id = role_grant.school_id AND school.organization_id = role_grant.organization_id
    JOIN hon.organizations organization ON organization.id = school.organization_id
    WHERE principal.id = p_principal_id AND principal.is_active
      AND role_grant.organization_id = p_organization_id AND role_grant.school_id = p_school_id
      AND school.status = 'ACTIVE' AND organization.status = 'ACTIVE' AND role_grant.revoked_at IS NULL
      AND role_grant.effective_from <= statement_timestamp()
      AND (role_grant.effective_until IS NULL OR role_grant.effective_until > statement_timestamp())
      AND permission.permission_code = p_permission_code)
$$;

-- INTERNAL exact-match resolver. Requires BOTH an already-known principal UUID
-- and external subject. Never searches contacts, creates users or returns PII.
-- Runtime cannot execute this helper, nor SELECT the directory.
CREATE FUNCTION hon.resolve_staff_role_target(p_principal_id uuid, p_external_subject text, p_actor_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_id uuid;
BEGIN
  SELECT principal.id INTO v_id FROM hon.principals principal
  JOIN hon.users app_user ON app_user.id = principal.user_id
  WHERE principal.id = p_principal_id AND app_user.external_subject = p_external_subject
    AND principal.principal_type = 'HUMAN_USER' AND principal.is_active AND principal.id <> p_actor_id
    AND (SELECT count(*) FROM hon.principals p WHERE p.user_id = app_user.id AND p.is_active AND p.principal_type = 'HUMAN_USER') = 1
    AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants h WHERE h.principal_id = principal.id)
    AND NOT EXISTS (SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id = g.role_id
      WHERE g.principal_id = principal.id AND g.revoked_at IS NULL AND g.effective_from <= statement_timestamp()
        AND (g.effective_until IS NULL OR g.effective_until > statement_timestamp())
        AND (r.is_system_role OR r.code !~ '^CUSTOM_[A-Z][A-Z0-9_]{1,47}$' AND r.code ~ '^(OWNER|HON_|HQ|PLATFORM|SYSTEM)'))
  FOR UPDATE OF principal, app_user;
  IF v_id IS NULL THEN RAISE EXCEPTION 'STAFF_ROLE_TARGET_UNAVAILABLE' USING ERRCODE = '42501'; END IF;
  RETURN v_id;
END $$;

-- Closed operation names are not an Action Engine table-mutation facility.
-- The verified actor subject is supplied ONLY by HonIdentityGuard, and is
-- re-resolved here against identity-derived transaction-local context.
CREATE FUNCTION hon.mutate_staff_role(p_external_subject text, p_action text, p_entity_id uuid,
  p_input jsonb, p_idempotency_key text, p_request_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE
  v_actor uuid; v_org uuid := hon.current_organization_id(); v_school uuid := hon.current_school_id();
  v_role hon.roles%ROWTYPE; v_grant hon.principal_role_grants%ROWTYPE;
  v_role_id uuid; v_target uuid; v_entity uuid; v_version integer; v_codes text[];
  v_now timestamptz; v_until timestamptz; v_prior jsonb; v_data jsonb; v_record uuid;
  v_fingerprint text; v_previous hon.idempotency_records%ROWTYPE; v_type text; v_event text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('iam.custom_role.create','iam.custom_role.update','iam.staff_role.grant','iam.staff_role.revoke')
    OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_idempotency_key IS NULL
    OR length(p_idempotency_key) NOT BETWEEN 1 AND 200 OR btrim(p_idempotency_key) <> p_idempotency_key
    OR p_request_id IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
  END IF;
  IF v_org IS NULL OR v_school IS NULL
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE = '42501';
  END IF;
  -- Serialize IAM commands at the organization, BEFORE any directory/grant lock.
  -- This covers cross-school shared role permissions and prevents subset TOCTOU.
  PERFORM 1 FROM hon.organizations WHERE id = v_org AND status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_ROLE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  SELECT scope.principal_id INTO v_actor FROM hon.resolve_authorized_scope(p_external_subject,v_school,'iam.staff_role.manage') scope
    WHERE scope.organization_id = v_org;
  IF v_actor IS NULL OR v_actor::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
    OR p_request_id::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN
    RAISE EXCEPTION 'STAFF_ROLE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM hon.principals WHERE id = v_actor AND is_active AND principal_type = 'HUMAN_USER' FOR UPDATE;
  PERFORM 1 FROM hon.schools WHERE id = v_school AND organization_id = v_org AND status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_ROLE_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM hon.principal_role_grants WHERE principal_id = v_actor AND organization_id = v_org AND school_id = v_school FOR UPDATE;
  PERFORM 1 FROM hon.roles WHERE id IN (SELECT role_id FROM hon.principal_role_grants
    WHERE principal_id = v_actor AND organization_id = v_org AND school_id = v_school) ORDER BY id FOR UPDATE;
  IF NOT hon.principal_has_school_permission(v_actor,v_org,v_school,p_action)
    OR NOT hon.principal_has_school_permission(v_actor,v_org,v_school,'iam.staff_role.manage') THEN
    RAISE EXCEPTION 'STAFF_ROLE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- Definer explicitly derives and reinstates the same scope, never widens it.
  PERFORM set_config('app.hon_organization_id',v_org::text,true), set_config('app.hon_school_id',v_school::text,true);
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object('action',p_action,'entityId',p_entity_id,'input',p_input)::text,'UTF8')),'hex');
  INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
    VALUES(v_org,v_school,v_actor,p_idempotency_key,v_fingerprint,'IN_PROGRESS',clock_timestamp()+interval '24 hours')
    ON CONFLICT DO NOTHING RETURNING id INTO v_record;
  IF v_record IS NULL THEN
    SELECT * INTO v_previous FROM hon.idempotency_records WHERE organization_id=v_org AND school_id=v_school
      AND principal_id=v_actor AND idempotency_key=p_idempotency_key FOR UPDATE;
    IF v_previous.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505';
    END IF;
    IF v_previous.status = 'COMPLETED' THEN RETURN jsonb_build_object('record',v_previous.response_body,'replayed',true); END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_IN_PROGRESS' USING ERRCODE = '55P03';
  END IF;
  IF p_action IN ('iam.custom_role.create','iam.custom_role.update') THEN
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('code','name','permissionCodes','expectedVersion'))
      OR jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 100
      OR (p_input->>'name') ~ '[[:cntrl:]]' OR jsonb_typeof(p_input->'permissionCodes') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_input->'permissionCodes') NOT BETWEEN 1 AND 100
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'permissionCodes') e WHERE jsonb_typeof(e) <> 'string') THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(code ORDER BY code) INTO v_codes FROM jsonb_array_elements_text(p_input->'permissionCodes') code;
    IF cardinality(v_codes) <> (SELECT count(DISTINCT code) FROM unnest(v_codes) code)
      OR EXISTS(SELECT 1 FROM unnest(v_codes) AS c(code) LEFT JOIN hon.permissions p ON p.code=c.code
        WHERE p.code IS NULL OR NOT p.is_staff_assignable OR c.code ~ '^(hq|platform|system)\.') THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
    END IF;
    IF EXISTS(SELECT 1 FROM unnest(v_codes) code WHERE NOT hon.principal_has_school_permission(v_actor,v_org,v_school,code)) THEN
      RAISE EXCEPTION 'ROLE_PERMISSION_SUBSET_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF p_action = 'iam.custom_role.create' THEN
      IF p_entity_id IS NOT NULL OR p_input ? 'expectedVersion' OR jsonb_typeof(p_input->'code') IS DISTINCT FROM 'string'
        OR (p_input->>'code') !~ '^CUSTOM_[A-Z][A-Z0-9_]{1,47}$' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023';
      END IF;
      INSERT INTO hon.roles(organization_id,management_school_id,code,name)
        VALUES(v_org,v_school,p_input->>'code',btrim(p_input->>'name')) RETURNING * INTO v_role;
      v_event := 'iam.custom_role.created';
    ELSE
      IF p_input ? 'code' THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023'; END IF;
      SELECT * INTO v_role FROM hon.roles WHERE id=p_entity_id AND organization_id=v_org AND management_school_id=v_school FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_ROLE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
      IF v_role.is_system_role OR v_role.code !~ '^CUSTOM_[A-Z][A-Z0-9_]{1,47}$'
        OR EXISTS(SELECT 1 FROM hon.principal_role_grants g WHERE g.role_id=v_role.id AND g.revoked_at IS NULL
          AND (g.effective_until IS NULL OR g.effective_until>statement_timestamp())
          AND (g.principal_id=v_actor OR g.school_id<>v_school))
        OR EXISTS(SELECT 1 FROM hon.roles owner WHERE owner.organization_id=v_org AND owner.is_system_role AND owner.code='OWNER'
          AND NOT EXISTS(SELECT 1 FROM hon.role_permissions op WHERE op.role_id=owner.id
            AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=v_role.id AND rp.permission_code=op.permission_code))) THEN
        RAISE EXCEPTION 'PROTECTED_ROLE' USING ERRCODE = '42501';
      END IF;
      IF EXISTS(SELECT 1 FROM hon.role_permissions p WHERE p.role_id=v_role.id
        AND NOT hon.principal_has_school_permission(v_actor,v_org,v_school,p.permission_code)) THEN
        RAISE EXCEPTION 'ROLE_PERMISSION_SUBSET_REQUIRED' USING ERRCODE = '42501';
      END IF;
      IF jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023'; END IF;
      IF v_role.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
      v_prior := jsonb_build_object('id',v_role.id,'version',v_role.version,'name',v_role.name,
        'permissionCodes',(SELECT jsonb_agg(permission_code ORDER BY permission_code) FROM hon.role_permissions WHERE role_id=v_role.id));
      UPDATE hon.roles SET name=btrim(p_input->>'name'),version=version+1 WHERE id=v_role.id RETURNING * INTO v_role;
      DELETE FROM hon.role_permissions WHERE role_id=v_role.id AND organization_id=v_org;
      v_event := 'iam.custom_role.updated';
    END IF;
    INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT v_role.id,v_org,unnest(v_codes);
    v_entity := v_role.id; v_version := v_role.version; v_type := 'ROLE';
    v_data := jsonb_build_object('id',v_entity,'code',v_role.code,'name',v_role.name,'schoolId',v_school,'version',v_version,'permissionCodes',to_jsonb(v_codes));
  ELSE
    IF p_action = 'iam.staff_role.grant' THEN
      IF p_entity_id IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('roleId','targetPrincipalId','targetExternalSubject','effectiveUntil'))
        OR jsonb_typeof(p_input->'targetExternalSubject') IS DISTINCT FROM 'string'
        OR length(p_input->>'targetExternalSubject') NOT BETWEEN 1 AND 200 OR (p_input->>'targetExternalSubject') ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023'; END IF;
      v_role_id := (p_input->>'roleId')::uuid;
      v_target := hon.resolve_staff_role_target((p_input->>'targetPrincipalId')::uuid,p_input->>'targetExternalSubject',v_actor);
    ELSE
      IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k <> 'expectedVersion')
        OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR (p_input->>'expectedVersion') !~ '^[1-9][0-9]{0,8}$' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023'; END IF;
      SELECT * INTO v_grant FROM hon.principal_role_grants WHERE id=p_entity_id AND organization_id=v_org AND school_id=v_school FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_ROLE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
      v_role_id := v_grant.role_id;
      -- Revocation needs no target subject, but still denies inactive/non-human,
      -- HQ/system targets and self-mutation through the same internal predicate.
      SELECT hon.resolve_staff_role_target(v_grant.principal_id,u.external_subject,v_actor) INTO v_target
        FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE p.id=v_grant.principal_id;
      IF v_target IS NULL THEN RAISE EXCEPTION 'STAFF_ROLE_TARGET_UNAVAILABLE' USING ERRCODE = '42501'; END IF;
    END IF;
    SELECT * INTO v_role FROM hon.roles WHERE id=v_role_id AND organization_id=v_org
      AND (management_school_id IS NULL OR management_school_id=v_school) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'STAFF_ROLE_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
    IF v_role.is_system_role OR v_role.code ~ '^(OWNER|HON_|HQ|PLATFORM|SYSTEM)'
      OR NOT EXISTS(SELECT 1 FROM hon.role_permissions WHERE role_id=v_role.id)
      OR EXISTS(SELECT 1 FROM hon.role_permissions p JOIN hon.permissions d ON d.code=p.permission_code
        WHERE p.role_id=v_role.id AND (NOT d.is_staff_assignable OR NOT hon.principal_has_school_permission(v_actor,v_org,v_school,p.permission_code))) THEN
      RAISE EXCEPTION 'PROTECTED_ROLE_OR_SUBSET_REQUIRED' USING ERRCODE = '42501'; END IF;
    v_now := clock_timestamp();
    IF p_action = 'iam.staff_role.grant' THEN
      IF p_input ? 'effectiveUntil' AND (jsonb_typeof(p_input->'effectiveUntil') IS DISTINCT FROM 'string'
        OR (p_input->>'effectiveUntil') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$') THEN
        RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023'; END IF;
      v_until := (p_input->>'effectiveUntil')::timestamptz;
      IF v_until IS NOT NULL AND (NOT isfinite(v_until) OR v_until<=v_now OR v_until>v_now+interval '90 days') THEN
        RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = '22023'; END IF;
      IF EXISTS(SELECT 1 FROM hon.principal_role_grants WHERE organization_id=v_org AND school_id=v_school AND principal_id=v_target AND role_id=v_role.id
        AND revoked_at IS NULL AND (effective_until IS NULL OR effective_until>v_now)) THEN
        RAISE EXCEPTION 'STAFF_ROLE_ALREADY_GRANTED' USING ERRCODE = '40001'; END IF;
      INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from,effective_until)
        VALUES(v_org,v_school,v_target,v_role.id,v_actor,v_now,v_until) RETURNING * INTO v_grant;
      v_event := 'iam.staff_role.granted';
    ELSE
      -- Already-ended grants are a no-op, even with a new key; no second evidence.
      IF v_grant.revoked_at IS NOT NULL OR (v_grant.effective_until IS NOT NULL AND v_grant.effective_until<=v_now) THEN
        v_data := jsonb_build_object('id',v_grant.id,'roleId',v_role.id,'principalId',v_target,'schoolId',v_school,'version',v_grant.version,'effectiveFrom',v_grant.effective_from,'effectiveUntil',v_grant.effective_until,'revokedAt',v_grant.revoked_at);
        UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=v_data WHERE id=v_record;
        RETURN jsonb_build_object('record',v_data,'replayed',true);
      END IF;
      IF v_grant.effective_from>v_now THEN RAISE EXCEPTION 'STAFF_ROLE_NOT_ACTIVE' USING ERRCODE = '40001'; END IF;
      IF v_grant.version <> (p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001'; END IF;
      -- OWNER is an immutable system role; protect final OWNER-equivalent custom
      -- coverage too, based on the canonical owner's actual permission set.
      IF EXISTS(SELECT 1 FROM hon.roles owner WHERE owner.organization_id=v_org AND owner.is_system_role AND owner.code='OWNER'
        AND NOT EXISTS(SELECT 1 FROM hon.role_permissions op WHERE op.role_id=owner.id
          AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=v_role.id AND rp.permission_code=op.permission_code))
        AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id
          WHERE g.id<>v_grant.id AND g.organization_id=v_org AND g.school_id=v_school AND p.is_active AND p.principal_type='HUMAN_USER'
            AND g.revoked_at IS NULL AND g.effective_from<=v_now AND (g.effective_until IS NULL OR g.effective_until>v_now)
            AND NOT EXISTS(SELECT 1 FROM hon.role_permissions op WHERE op.role_id=owner.id
              AND NOT EXISTS(SELECT 1 FROM hon.role_permissions rp WHERE rp.role_id=g.role_id AND rp.permission_code=op.permission_code)))) THEN
        RAISE EXCEPTION 'FINAL_OWNER_COVERAGE_REQUIRED' USING ERRCODE = '42501'; END IF;
      v_prior := jsonb_build_object('id',v_grant.id,'version',v_grant.version,'effectiveUntil',v_grant.effective_until,'revokedAt',v_grant.revoked_at);
      UPDATE hon.principal_role_grants SET effective_until=v_now,revoked_at=v_now,revoked_by_principal_id=v_actor,version=version+1
        WHERE id=v_grant.id AND organization_id=v_org AND school_id=v_school RETURNING * INTO v_grant;
      v_event := 'iam.staff_role.revoked';
    END IF;
    v_entity := v_grant.id; v_version := v_grant.version; v_type := 'PRINCIPAL_ROLE_GRANT';
    v_data := jsonb_build_object('id',v_entity,'roleId',v_role.id,'principalId',v_target,'schoolId',v_school,'version',v_version,'effectiveFrom',v_grant.effective_from,'effectiveUntil',v_grant.effective_until,'revokedAt',v_grant.revoked_at);
  END IF;
  INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id)
    VALUES(v_org,v_school,v_actor,'HUMAN_UI',p_action,v_type,v_entity,v_prior,v_data,'SUCCEEDED',p_request_id,p_correlation_id);
  INSERT INTO hon.outbox_events(organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
    VALUES(v_org,v_school,v_event,1,v_type,v_entity,v_version,p_correlation_id,p_request_id,v_data);
  UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=v_data WHERE id=v_record;
  RETURN jsonb_build_object('record',v_data,'replayed',false);
END $$;

-- Single-ID read projection; no list/search endpoint and no identity contacts.
CREATE FUNCTION hon.read_staff_role(p_external_subject text,p_kind text,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE v_actor uuid; v_org uuid:=hon.current_organization_id(); v_school uuid:=hon.current_school_id(); v_data jsonb;
BEGIN
  SELECT principal_id INTO v_actor FROM hon.resolve_authorized_scope(p_external_subject,v_school,'iam.staff_role.manage') WHERE organization_id=v_org;
  IF v_actor IS NULL OR v_actor::text IS DISTINCT FROM current_setting('app.hon_principal_id',true)
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI' THEN
    RAISE EXCEPTION 'STAFF_ROLE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_kind='ROLE' THEN
    SELECT jsonb_build_object('id',r.id,'code',r.code,'name',r.name,'schoolId',r.management_school_id,'version',r.version,
      'permissionCodes',(SELECT jsonb_agg(permission_code ORDER BY permission_code) FROM hon.role_permissions WHERE role_id=r.id))
      INTO v_data FROM hon.roles r WHERE r.id=p_id AND r.organization_id=v_org AND NOT r.is_system_role
      AND r.code !~ '^(OWNER|HON_|HQ|PLATFORM|SYSTEM)' AND (r.management_school_id IS NULL OR r.management_school_id=v_school);
  ELSIF p_kind='GRANT' THEN
    SELECT jsonb_build_object('id',g.id,'roleId',g.role_id,'principalId',g.principal_id,'schoolId',g.school_id,'version',g.version,
      'effectiveFrom',g.effective_from,'effectiveUntil',g.effective_until,'revokedAt',g.revoked_at)
      INTO v_data FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id
      WHERE g.id=p_id AND g.organization_id=v_org AND g.school_id=v_school AND NOT r.is_system_role
      AND r.code !~ '^(OWNER|HON_|HQ|PLATFORM|SYSTEM)';
  ELSE RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF v_data IS NULL THEN RAISE EXCEPTION 'STAFF_ROLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN v_data;
END $$;

REVOKE ALL ON FUNCTION hon.resolve_staff_role_target(uuid,text,uuid),
  hon.mutate_staff_role(text,text,uuid,jsonb,text,uuid,uuid), hon.read_staff_role(text,text,uuid),
  hon.resolve_authorized_scope(text,uuid,text), hon.principal_has_school_permission(uuid,uuid,uuid,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    REVOKE ALL ON TABLE hon.users,hon.principals,hon.roles,hon.permissions,hon.role_permissions,hon.principal_role_grants FROM hon_runtime;
    REVOKE ALL ON FUNCTION hon.resolve_staff_role_target(uuid,text,uuid) FROM hon_runtime;
    GRANT EXECUTE ON FUNCTION hon.mutate_staff_role(text,text,uuid,jsonb,text,uuid,uuid),hon.read_staff_role(text,text,uuid) TO hon_runtime;
  END IF;
END $$;

COMMIT;
