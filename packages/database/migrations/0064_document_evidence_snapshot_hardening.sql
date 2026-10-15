BEGIN;

-- Lock the exact verified account and principal before the authoritative write,
-- not just a previously resolved principal UUID. Directory grants remain denied.
CREATE OR REPLACE FUNCTION hon.require_document_actor(p_subject text,p_mode text,p_permission text,p_family uuid,p_lock boolean)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE v_actor uuid; v_org uuid:=hon.current_organization_id(); v_school uuid:=hon.current_school_id();
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN('STAFF','PARENT') OR v_org IS NULL OR v_school IS NULL
   OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'HUMAN_USER'
   OR current_setting('app.hon_source',true) IS DISTINCT FROM 'HUMAN_UI'
   OR nullif(current_setting('app.hon_action_request_id',true),'') IS NOT NULL
   OR nullif(current_setting('app.hon_delegated_by_principal_id',true),'') IS NOT NULL THEN
   RAISE EXCEPTION 'HUMAN_COMMAND_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT p.id INTO v_actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
 WHERE u.external_subject=p_subject AND p.principal_type='HUMAN_USER' AND p.is_active
   AND p.id::text=current_setting('app.hon_principal_id',true)
   AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1;
 IF v_actor IS NULL OR NOT EXISTS(SELECT 1 FROM hon.schools s JOIN hon.organizations o ON o.id=s.organization_id
   WHERE s.id=v_school AND o.id=v_org AND s.status='ACTIVE' AND o.status='ACTIVE') THEN
   RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 IF p_lock THEN
   SELECT p.id INTO v_actor FROM hon.principals p JOIN hon.users u ON u.id=p.user_id
   WHERE u.external_subject=p_subject AND p.principal_type='HUMAN_USER' AND p.is_active
     AND p.id::text=current_setting('app.hon_principal_id',true)
     AND (SELECT count(*) FROM hon.principals x WHERE x.user_id=u.id AND x.principal_type='HUMAN_USER' AND x.is_active)=1
   FOR UPDATE OF p,u;
   IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
   IF p_mode='STAFF' THEN
     PERFORM 1 FROM hon.principal_role_grants WHERE principal_id=v_actor AND organization_id=v_org AND school_id=v_school FOR UPDATE;
     PERFORM 1 FROM hon.roles WHERE id IN(SELECT role_id FROM hon.principal_role_grants WHERE principal_id=v_actor AND organization_id=v_org AND school_id=v_school) ORDER BY id FOR UPDATE;
   ELSE
     PERFORM 1 FROM hon.families WHERE id=p_family AND organization_id=v_org AND school_id=v_school FOR UPDATE;
     PERFORM 1 FROM hon.family_access_grants WHERE principal_id=v_actor AND family_id=p_family AND organization_id=v_org AND school_id=v_school FOR UPDATE;
   END IF;
 END IF;
 IF p_mode='STAFF' THEN
   IF NOT EXISTS(SELECT 1 FROM hon.resolve_authorized_scope(p_subject,v_school,p_permission) s WHERE s.principal_id=v_actor AND s.organization_id=v_org)
     OR NOT hon.principal_has_school_permission(v_actor,v_org,v_school,p_permission) THEN
     RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 ELSE
   IF p_family IS NOT NULL THEN
     IF NOT hon.document_family_authorized(p_subject,p_family,p_permission='document.acknowledge') THEN
       RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
   ELSIF NOT EXISTS(SELECT 1 FROM hon.resolve_parent_family_scope(p_subject,v_school) s
     WHERE s.organization_id=v_org AND hon.document_family_authorized(p_subject,s.family_id,false)) THEN
     RAISE EXCEPTION 'DOCUMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN v_actor;
END $$;

-- A canonical acknowledgement snapshot must agree with every typed column.
-- This catches future trusted-command regressions as well as hash corruption.
ALTER TABLE hon.document_acknowledgements ADD CONSTRAINT document_evidence_snapshot_matches CHECK (
 (evidence->>'schemaVersion') IS NOT DISTINCT FROM '1' AND
 (evidence->>'kind') IS NOT DISTINCT FROM 'INTERNAL_HUMAN_ACKNOWLEDGEMENT' AND
 (evidence->>'id') IS NOT DISTINCT FROM id::text AND
 (evidence->>'organizationId') IS NOT DISTINCT FROM organization_id::text AND
 (evidence->>'schoolId') IS NOT DISTINCT FROM school_id::text AND
 (evidence->>'publicationId') IS NOT DISTINCT FROM publication_id::text AND
 (evidence->>'versionId') IS NOT DISTINCT FROM version_id::text AND
 (evidence->>'contentHash') IS NOT DISTINCT FROM content_hash AND
 (evidence->>'signerPrincipalId') IS NOT DISTINCT FROM signer_principal_id::text AND
 (evidence->>'audience') IS NOT DISTINCT FROM audience AND
 (evidence->>'familyId') IS NOT DISTINCT FROM family_id::text AND
 (evidence->>'choice') IS NOT DISTINCT FROM choice AND
 (evidence->>'attestationText') IS NOT DISTINCT FROM attestation_text AND
 (evidence->>'acknowledgedAt')::timestamptz IS NOT DISTINCT FROM acknowledged_at AND
 (evidence->>'source') IS NOT DISTINCT FROM 'HUMAN_UI' AND
 (evidence->>'requestId') IS NOT DISTINCT FROM request_id::text AND
 (evidence->>'correlationId') IS NOT DISTINCT FROM correlation_id::text
);
REVOKE ALL ON FUNCTION hon.require_document_actor(text,text,text,uuid,boolean) FROM PUBLIC;
COMMIT;
