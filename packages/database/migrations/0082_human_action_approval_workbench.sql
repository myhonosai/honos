BEGIN;
-- Existing request/approval/policy state machines are retained. No execution function.
CREATE FUNCTION hon.human_action_reviewer() RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
 SELECT current_setting('app.hon_principal_type',true)='HUMAN_USER' AND current_setting('app.hon_source',true)='HUMAN_UI'
 AND EXISTS(SELECT 1 FROM hon.principals p WHERE p.id=nullif(current_setting('app.hon_principal_id',true),'')::uuid AND p.principal_type='HUMAN_USER' AND p.is_active
 AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=p.user_id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
 AND NOT EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id WHERE g.principal_id=p.id AND r.code='PARENT' AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
 AND hon.principal_has_school_permission(p.id,hon.current_organization_id(),hon.current_school_id(),'action.approve'))
$$;
REVOKE ALL ON FUNCTION hon.human_action_reviewer() FROM PUBLIC;
CREATE POLICY action_approvals_qualified_read ON hon.action_approvals AS RESTRICTIVE FOR SELECT USING(hon.human_action_reviewer());
CREATE FUNCTION hon.require_human_action_review(p_external_subject text,p_requester uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE actor uuid:=nullif(current_setting('app.hon_principal_id',true),'')::uuid;
 org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id(); uid uuid;
BEGIN
 IF current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
 OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
 OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
 OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL
 OR actor IS NULL OR org IS NULL OR school IS NULL OR p_external_subject IS NULL THEN
 RAISE EXCEPTION 'HUMAN_REVIEW_REQUIRED' USING ERRCODE='42501'; END IF;
 -- Shared locks serialize IAM/topology revocation while allowing different reviews.
 PERFORM 1 FROM hon.organizations WHERE id=org FOR SHARE;
 PERFORM 1 FROM hon.schools WHERE id=school AND organization_id=org FOR SHARE;
 PERFORM 1 FROM hon.users WHERE external_subject=p_external_subject FOR SHARE;
 PERFORM 1 FROM hon.principals WHERE id IN(actor,p_requester) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.principal_role_grants WHERE organization_id=org AND school_id=school AND principal_id IN(actor,p_requester) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE organization_id=org AND school_id=school AND principal_id IN(actor,p_requester)) ORDER BY id FOR SHARE;
 PERFORM 1 FROM hon.role_permissions WHERE organization_id=org AND role_id IN(SELECT role_id FROM hon.principal_role_grants WHERE organization_id=org AND school_id=school AND principal_id IN(actor,p_requester)) ORDER BY role_id,permission_code FOR SHARE;
 PERFORM 1 FROM hon.organization_entitlements WHERE organization_id=org ORDER BY organization_id FOR SHARE;
 PERFORM 1 FROM hon.action_policies WHERE organization_id=org AND school_id=school ORDER BY id FOR SHARE;
 SELECT u.id INTO uid FROM hon.users u JOIN hon.principals p ON p.user_id=u.id WHERE u.external_subject=p_external_subject AND p.id=actor AND p.principal_type='HUMAN_USER' AND p.is_active;
 IF uid IS NULL OR (SELECT count(*) FROM hon.principals WHERE user_id=uid AND principal_type='HUMAN_USER' AND is_active)<>1
 OR EXISTS(SELECT 1 FROM hon.hq_operator_grants WHERE principal_id=actor)
 OR EXISTS(SELECT 1 FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.organization_id=g.organization_id WHERE g.principal_id=actor AND r.code='PARENT' AND g.revoked_at IS NULL AND g.effective_from<=clock_timestamp() AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()))
 OR NOT hon.principal_has_school_permission(actor,org,school,'action.approve') THEN
 RAISE EXCEPTION 'HUMAN_REVIEW_FORBIDDEN' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION hon.require_human_action_review(text,uuid) FROM PUBLIC;
-- CRM target revalidation is boolean-only: callers receive no target rows and
-- cannot select a tenant. The transaction-bound tenant scope is required.
CREATE FUNCTION hon.crm_lead_target_is_current(p_pipeline uuid,p_stage uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE org uuid:=hon.current_organization_id(); school uuid:=hon.current_school_id();
BEGIN
 IF org IS NULL OR school IS NULL OR p_pipeline IS NULL OR p_stage IS NULL THEN RETURN false; END IF;
 PERFORM 1 FROM hon.crm_pipeline_stages stage JOIN hon.crm_pipelines pipeline
  ON pipeline.id=stage.pipeline_id AND pipeline.organization_id=stage.organization_id AND pipeline.school_id=stage.school_id
  WHERE stage.id=p_stage AND stage.pipeline_id=p_pipeline AND stage.organization_id=org AND stage.school_id=school
   AND stage.terminal_status IS NULL FOR SHARE OF stage,pipeline;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION hon.crm_lead_target_is_current(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION hon.guard_action_review_immutability() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') OR TG_TABLE_NAME='action_approvals' THEN RAISE EXCEPTION 'IMMUTABLE_ACTION_REVIEW_EVIDENCE' USING ERRCODE='42501'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','updated_at','provider_idempotency_reference','verified_result','failure_details']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['status','updated_at','provider_idempotency_reference','verified_result','failure_details']) THEN
 RAISE EXCEPTION 'IMMUTABLE_ACTION_PROPOSAL_BINDING' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION hon.guard_action_review_immutability() FROM PUBLIC;
CREATE TRIGGER action_request_immutable BEFORE UPDATE OR DELETE ON hon.action_requests FOR EACH ROW EXECUTE FUNCTION hon.guard_action_review_immutability();
CREATE TRIGGER action_request_no_truncate BEFORE TRUNCATE ON hon.action_requests FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_action_review_immutability();
CREATE TRIGGER action_approval_immutable BEFORE UPDATE OR DELETE ON hon.action_approvals FOR EACH ROW EXECUTE FUNCTION hon.guard_action_review_immutability();
CREATE TRIGGER action_approval_no_truncate BEFORE TRUNCATE ON hon.action_approvals FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_action_review_immutability();
CREATE INDEX action_requests_review_queue_idx ON hon.action_requests(organization_id,school_id,status,id);
-- Already forced tenant RLS and scoped FK remain in effect. Only evidence SELECT is added.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hon_runtime') THEN
 GRANT SELECT ON hon.action_approvals TO hon_runtime;
 GRANT EXECUTE ON FUNCTION hon.require_human_action_review(text,uuid),hon.human_action_reviewer(),hon.crm_lead_target_is_current(uuid,uuid) TO hon_runtime;
END IF; END $$;
COMMIT;
