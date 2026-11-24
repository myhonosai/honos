BEGIN;

-- 0629 CRM trial authority hold (coordinator-allocated 2026-11-22; launch-readiness review P1, docs/architecture/CRM_TRIAL_AUTHORITY_HOLD.md).
-- Owner request (David, 2026-11-22): fix the review's findings before more features, starting with the P1.
-- The review found that trial scheduling re-checks staff authority after the per-lead lock, but later statements in the
-- same transaction (the idempotency reservation and its FOR UPDATE read) can still wait, and a revocation or suspension
-- can commit during that wait. Tenant-only RLS does not refuse the later write, so the trial committed on stale authority.
--   TA1  hon.hold_crm_trial_authority(subject) takes FOR SHARE row locks, in the platform's IAM lock order (organization,
--        school, user, the user's human principals, the actor's grants at this school, their roles and role permissions,
--        the organization's entitlements), on every row the CRM authority and entitlement checks read. Until the trial
--        transaction ends, a revocation (UPDATE or DELETE of a grant, role permission or principal), a school or
--        organization suspension, or an entitlement change waits; one that committed first is seen by the re-check that
--        follows the hold. New grants are INSERTs and only add authority, so they are not held.
--   TA2  The hold proves nothing by itself: the API runs its exact-school re-check (hon.resolve_authorized_scope) and the
--        entitlement check right after it, and once more just before it returns. A missing tenant context, a non-human
--        command, or a subject that is not the transaction's principal is refused with 42501 before any row is locked.
--   TA3  SECURITY DEFINER with a fixed search path; the runtime gains EXECUTE on this one function only.
-- Nothing here changes data, grants table access, sends, charges or calls an outside service.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)
    AND rolname NOT IN ('hon_runtime','anon','authenticated','service_role')) THEN RAISE EXCEPTION 'Trusted migration owner required'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hon_runtime' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'CRM trial authority hold requires a restricted runtime'; END IF;
  IF to_regprocedure('hon.resolve_authorized_scope(text,uuid,text)') IS NULL OR to_regprocedure('hon.current_organization_id()') IS NULL
    OR to_regprocedure('hon.current_school_id()') IS NULL OR to_regclass('hon.crm_appointments') IS NULL THEN
    RAISE EXCEPTION '0629 requires 0059 and the CRM trial appointment migrations'; END IF;
END $$;

CREATE FUNCTION hon.hold_crm_trial_authority(p_subject text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); actor uuid; holder uuid;
BEGIN
  IF org IS NULL OR school IS NULL OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 512
    OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
    OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
    OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
    OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_TRIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  -- The subject must be the transaction's own principal; nobody can hold another person's rows.
  SELECT u.id, p.id INTO holder, actor FROM hon.users u JOIN hon.principals p ON p.user_id=u.id
  WHERE u.external_subject=p_subject AND p.id::text=current_setting('app.hon_principal_id',true) AND p.principal_type='HUMAN_USER';
  IF actor IS NULL THEN RAISE EXCEPTION 'CRM_TRIAL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM hon.organizations WHERE id=org FOR SHARE;
  PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org FOR SHARE;
  PERFORM 1 FROM hon.users WHERE id=holder FOR SHARE;
  PERFORM 1 FROM hon.principals WHERE user_id=holder AND principal_type='HUMAN_USER' ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.roles WHERE id IN (SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school)
    ORDER BY id FOR SHARE;
  PERFORM 1 FROM hon.role_permissions WHERE role_id IN (SELECT role_id FROM hon.principal_role_grants WHERE principal_id=actor AND organization_id=org AND school_id=school)
    ORDER BY role_id, permission_code FOR SHARE;
  PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org FOR SHARE;
END $$;

DO $$ DECLARE r text; BEGIN
  REVOKE ALL ON FUNCTION hon.hold_crm_trial_authority(text) FROM PUBLIC;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('hon_runtime','anon','authenticated','service_role','hon_outbox_worker','hon_communication_worker','hon_automation_worker') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION hon.hold_crm_trial_authority(text) FROM %I',r); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
    GRANT EXECUTE ON FUNCTION hon.hold_crm_trial_authority(text) TO hon_runtime;
  END IF;
END $$;
COMMIT;
