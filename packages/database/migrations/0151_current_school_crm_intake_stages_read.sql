BEGIN;

-- A fixed current-school CRM intake projection. It reuses the existing pipeline
-- tables and create permission; it introduces neither a pipeline model nor a
-- lead/contact directory, status history, metric, source, automation, provider,
-- AI, Action Engine, or write boundary.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'CRM intake-stage read requires a trusted migration owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime'
    AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'hon_runtime')) THEN
    RAISE EXCEPTION 'CRM intake-stage read requires a restricted runtime';
  END IF;
END $$;

-- The actor must remain the same direct human that could issue the canonical
-- lead-create command. This repeats the edge resolver's current scope checks
-- inside the tenant transaction before and after the projection.
CREATE FUNCTION hon.require_current_school_crm_intake_stages_actor(p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE org uuid; school uuid; principal uuid; actor uuid;
BEGIN
  IF p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 200 OR btrim(p_subject) <> p_subject
    OR p_subject IS DISTINCT FROM current_setting('app.hon_external_subject', true)
    OR current_setting('app.hon_principal_type', true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source', true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id', true), '') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_INTAKE_STAGES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  BEGIN
    org := hon.current_organization_id(); school := hon.current_school_id();
    principal := nullif(current_setting('app.hon_principal_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'CRM_INTAKE_STAGES_FORBIDDEN' USING ERRCODE = '42501';
  END;
  IF org::text IS DISTINCT FROM current_setting('app.hon_organization_id', true)
    OR school::text IS DISTINCT FROM current_setting('app.hon_school_id', true) THEN
    RAISE EXCEPTION 'CRM_INTAKE_STAGES_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT p.id INTO actor
  FROM hon.users AS u JOIN hon.principals AS p ON p.user_id = u.id
  WHERE u.external_subject = p_subject AND p.id = principal
    AND p.principal_type = 'HUMAN_USER' AND p.is_active
    -- One live principal only: reject nonhuman, delegated and mixed identities.
    AND (SELECT count(*) FROM hon.principals AS other WHERE other.user_id = u.id AND other.is_active) = 1
    AND EXISTS (SELECT 1 FROM hon.organizations AS organization WHERE organization.id = org AND organization.status = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM hon.schools AS current_school
      WHERE current_school.id = school AND current_school.organization_id = org AND current_school.status = 'ACTIVE')
    AND NOT EXISTS (SELECT 1 FROM hon.hq_operator_grants AS hq WHERE hq.principal_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM hon.family_access_grants AS family WHERE family.principal_id = p.id
      AND family.effective_from <= clock_timestamp() AND (family.effective_until IS NULL OR family.effective_until > clock_timestamp()))
    AND NOT EXISTS (
      SELECT 1 FROM hon.principal_role_grants AS mixed
      JOIN hon.roles AS mixed_role ON mixed_role.id = mixed.role_id AND mixed_role.organization_id = mixed.organization_id
      WHERE mixed.principal_id = p.id AND mixed.revoked_at IS NULL
        AND mixed.effective_from <= clock_timestamp() AND (mixed.effective_until IS NULL OR mixed.effective_until > clock_timestamp())
        AND mixed_role.code ~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
    )
    AND hon.staff_member_eligible(p.id, org, school)
    AND EXISTS (
      SELECT 1 FROM hon.principal_role_grants AS role_grant
      JOIN hon.roles AS role ON role.id = role_grant.role_id AND role.organization_id = role_grant.organization_id
      JOIN hon.role_permissions AS role_permission ON role_permission.role_id = role.id AND role_permission.organization_id = role.organization_id
      JOIN hon.permissions AS permission ON permission.code = role_permission.permission_code
      WHERE role_grant.principal_id = p.id AND role_grant.organization_id = org AND role_grant.school_id = school
        AND role_grant.revoked_at IS NULL AND role_grant.effective_from <= clock_timestamp()
        AND (role_grant.effective_until IS NULL OR role_grant.effective_until > clock_timestamp())
        AND (role.management_school_id IS NULL OR role.management_school_id = school)
        AND role.code !~* '^(PARENT|GUARDIAN|STUDENT|FAMILY|HQ|HON_|PLATFORM|SYSTEM)'
        AND permission.code = 'crm.lead.create' AND permission.is_staff_assignable
    )
    -- crm.foundation is currently present on all active tiers accepted by the
    -- canonical create service; this remains a live entitlement recheck.
    AND EXISTS (
      SELECT 1 FROM hon.organization_entitlements AS entitlement
      WHERE entitlement.organization_id = org AND entitlement.status = 'ACTIVE'
        AND entitlement.tier IN ('ESSENTIAL','CORE','COMPLETE')
        AND entitlement.effective_from <= clock_timestamp()
        AND (entitlement.effective_until IS NULL OR entitlement.effective_until > clock_timestamp())
    );
  IF actor IS NULL THEN RAISE EXCEPTION 'CRM_INTAKE_STAGES_FORBIDDEN' USING ERRCODE = '42501'; END IF;
  RETURN actor;
END $$;

-- No selector, search, cursor or range exists. The returned small ordered list
-- has only pipeline/stage IDs and names needed for an explicit intake selection.
CREATE FUNCTION hon.read_current_school_crm_intake_stages(p_subject text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, hon AS $$
DECLARE result jsonb;
BEGIN
  PERFORM hon.require_current_school_crm_intake_stages_actor(p_subject);
  SELECT coalesce(jsonb_agg(item.item ORDER BY item.pipeline_name, item.position, item.stage_id), '[]'::jsonb) INTO result
  FROM (
    SELECT pipeline.name AS pipeline_name, stage.position, stage.id AS stage_id,
      jsonb_build_object('pipelineId', pipeline.id, 'pipelineName', pipeline.name,
        'stageId', stage.id, 'stageName', stage.name) AS item
    FROM hon.crm_pipeline_stages AS stage
    JOIN hon.crm_pipelines AS pipeline ON pipeline.id = stage.pipeline_id
      AND pipeline.organization_id = stage.organization_id AND pipeline.school_id = stage.school_id
    WHERE stage.organization_id = hon.current_organization_id() AND stage.school_id = hon.current_school_id()
      AND stage.terminal_status IS NULL
    ORDER BY pipeline.name, stage.position, stage.id
    LIMIT 25
  ) AS item;
  PERFORM hon.require_current_school_crm_intake_stages_actor(p_subject);
  RETURN result;
END $$;

-- Preserve source-table RLS and deny direct runtime table reads. Only the named
-- projection executes for the restricted runtime role.
ALTER TABLE hon.crm_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_pipelines FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_pipeline_stages FORCE ROW LEVEL SECURITY;
REVOKE SELECT ON TABLE hon.crm_pipelines, hon.crm_pipeline_stages FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE SELECT ON TABLE hon.crm_pipelines, hon.crm_pipeline_stages FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.require_current_school_crm_intake_stages_actor(text) FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION hon.read_current_school_crm_intake_stages(text) FROM %I', role_name);
  END LOOP;
  REVOKE ALL ON FUNCTION hon.require_current_school_crm_intake_stages_actor(text), hon.read_current_school_crm_intake_stages(text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.read_current_school_crm_intake_stages(text) TO hon_runtime;
  END IF;
END $$;

COMMIT;
