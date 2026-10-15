BEGIN;
CREATE OR REPLACE FUNCTION hon.capture_lead_attribution() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
DECLARE c hon.marketing_campaigns%ROWTYPE; batch hon.lead_import_batches%ROWTYPE; rowdata hon.lead_import_rows%ROWTYPE;
 receipt hon.public_lead_form_receipts%ROWTYPE; form hon.public_lead_forms%ROWTYPE; cid uuid; ccode text; actor uuid; subject text; b_id uuid; r_index integer; checksum text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF EXISTS(SELECT 1 FROM hon.crm_lead_attributions WHERE lead_id=OLD.id) AND (NEW.source_code IS DISTINCT FROM OLD.source_code OR NEW.attribution IS DISTINCT FROM OLD.attribution OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.created_at<>OLD.created_at OR NEW.id<>OLD.id) THEN RAISE EXCEPTION 'IMMUTABLE_LEAD_ATTRIBUTION' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 -- Public provenance cannot be forged with GUCs: only the private ingress can
 -- reserve this lead's exact immutable facts under the current transaction ID.
 IF NEW.attribution ? 'publicForm' THEN
  SELECT * INTO receipt FROM hon.public_lead_form_receipts WHERE lead_id=NEW.id AND organization_id=NEW.organization_id AND school_id=NEW.school_id AND transaction_id=txid_current();
  SELECT * INTO form FROM hon.public_lead_forms WHERE id=receipt.form_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id;
  IF receipt.lead_id IS NULL OR form.id IS NULL OR form.status<>'PUBLISHED' OR NEW.attribution IS DISTINCT FROM receipt.attribution
   OR NEW.source_code IS DISTINCT FROM 'PUBLIC_API' OR NEW.pipeline_id<>form.pipeline_id OR NEW.pipeline_stage_id<>form.pipeline_stage_id
   OR current_setting('app.hon_source',true) IS DISTINCT FROM 'PUBLIC_API' OR current_setting('app.hon_principal_type',true) IS DISTINCT FROM 'SYSTEM_SERVICE'
   OR current_setting('app.hon_principal_id',true) IS DISTINCT FROM '00000000-0000-4000-8000-000000000075'
   OR NEW.attribution->'publicForm'->>'id' IS DISTINCT FROM form.id::text OR NEW.attribution->'publicForm'->>'version' IS DISTINCT FROM form.version::text
   OR (NEW.attribution->>'campaignId')::uuid IS DISTINCT FROM form.campaign_id THEN RAISE EXCEPTION 'INVALID_PUBLIC_FORM_PROVENANCE' USING ERRCODE='42501'; END IF;
  IF form.campaign_id IS NOT NULL THEN
   SELECT * INTO c FROM hon.marketing_campaigns WHERE id=form.campaign_id AND organization_id=form.organization_id AND school_id=form.school_id AND status='ACTIVE' FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVE_SCHOOL_CAMPAIGN_REQUIRED' USING ERRCODE='22023'; END IF;
  END IF;
  INSERT INTO hon.crm_lead_attributions(lead_id,organization_id,school_id,campaign_id,campaign_version,campaign_snapshot,source_code,source_facts)
  VALUES(NEW.id,NEW.organization_id,NEW.school_id,c.id,c.version,CASE WHEN c.id IS NULL THEN NULL ELSE hon.campaign_summary(c.id) END,NEW.source_code,NEW.attribution);
  RETURN NEW;
 END IF;
 IF jsonb_typeof(NEW.attribution) IS DISTINCT FROM 'object' OR octet_length(NEW.attribution::text)>16384 OR (NEW.source_code IS NOT NULL AND (length(NEW.source_code)>80 OR NEW.source_code ~ '[[:cntrl:]]')) THEN RAISE EXCEPTION 'INVALID_SOURCE_FACTS' USING ERRCODE='22023'; END IF;
 IF NEW.attribution ? 'campaignId' THEN
  IF jsonb_typeof(NEW.attribution->'campaignId') IS DISTINCT FROM 'string' OR (NEW.attribution->>'campaignId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RAISE EXCEPTION 'INVALID_CAMPAIGN_REFERENCE' USING ERRCODE='22023'; END IF;
  cid:=(NEW.attribution->>'campaignId')::uuid;
 END IF;
 IF NEW.attribution ? 'campaignCode' THEN
  ccode:=NEW.attribution->>'campaignCode';
  IF jsonb_typeof(NEW.attribution->'campaignCode') IS DISTINCT FROM 'string' OR ccode !~ '^[A-Z0-9][A-Z0-9_-]{0,39}$' THEN RAISE EXCEPTION 'INVALID_CAMPAIGN_REFERENCE' USING ERRCODE='22023'; END IF;
 END IF;
 IF cid IS NOT NULL OR ccode IS NOT NULL THEN
  SELECT u.external_subject INTO subject FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE p.id::text=current_setting('app.hon_principal_id',true);
  actor:=hon.lock_campaign_actor(subject,'marketing.campaign.attribute');
  IF NEW.organization_id<>hon.current_organization_id() OR NEW.school_id<>hon.current_school_id() THEN RAISE EXCEPTION 'CAMPAIGN_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM hon.marketing_campaigns WHERE organization_id=NEW.organization_id AND school_id=NEW.school_id AND status='ACTIVE' AND (cid IS NULL OR id=cid) AND (ccode IS NULL OR code=ccode) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACTIVE_SCHOOL_CAMPAIGN_REQUIRED' USING ERRCODE='22023'; END IF;
 END IF;
 IF NEW.attribution ? 'migration' THEN
  b_id:=(NEW.attribution->'migration'->>'batchId')::uuid; r_index:=(NEW.attribution->'migration'->>'rowIndex')::integer;
  SELECT * INTO batch FROM hon.lead_import_batches WHERE id=b_id AND organization_id=NEW.organization_id AND school_id=NEW.school_id AND status='REVIEW' AND review_actor::text=current_setting('app.hon_principal_id',true) AND review_expires_at>clock_timestamp();
  SELECT * INTO rowdata FROM hon.lead_import_rows WHERE batch_id=batch.id AND row_index=r_index AND choice='IMPORT' AND validation_errors='[]' AND lead_id IS NULL;
  IF batch.id IS NULL OR rowdata.batch_id IS NULL OR NEW.attribution->'migration'->>'sourceChecksum' IS DISTINCT FROM batch.source_checksum OR NEW.source_code IS DISTINCT FROM nullif(rowdata.normalized->>'source','') THEN RAISE EXCEPTION 'INVALID_IMPORT_PROVENANCE' USING ERRCODE='22023'; END IF;
  checksum:=batch.source_checksum;
 END IF;
 INSERT INTO hon.crm_lead_attributions(lead_id,organization_id,school_id,campaign_id,campaign_version,campaign_snapshot,source_code,source_facts,import_batch_id,import_row_index,import_checksum)
 VALUES(NEW.id,NEW.organization_id,NEW.school_id,c.id,c.version,CASE WHEN c.id IS NULL THEN NULL ELSE hon.campaign_summary(c.id) END,NEW.source_code,NEW.attribution,b_id,r_index,checksum);
 RETURN NEW;
END $$;

CREATE FUNCTION hon.guard_public_form_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'IMMUTABLE_FORM_IDENTITY' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'DRAFT' OR NEW.version<>1 OR NEW.accepted_count<>0 THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 ELSE
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.school_id<>OLD.school_id OR NEW.public_id<>OLD.public_id OR NEW.hash_secret<>OLD.hash_secret OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'IMMUTABLE_FORM_IDENTITY' USING ERRCODE='42501'; END IF;
  IF NEW.version=OLD.version THEN
   IF (to_jsonb(NEW)-'accepted_count') IS DISTINCT FROM (to_jsonb(OLD)-'accepted_count') OR NEW.accepted_count<>OLD.accepted_count+1 OR current_setting('app.hon_source',true) IS DISTINCT FROM 'PUBLIC_API'
    OR NOT EXISTS(SELECT 1 FROM hon.public_lead_form_receipts WHERE form_id=NEW.id AND transaction_id=txid_current()) THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
   RETURN NEW;
  END IF;
  IF NEW.version<>OLD.version+1 OR NEW.accepted_count<>OLD.accepted_count OR (OLD.status='PUBLISHED' AND NEW.status<>'DISABLED') OR (OLD.status<>'PUBLISHED' AND NEW.status NOT IN(OLD.status,'PUBLISHED')) THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
  IF NEW.status<>OLD.status AND (to_jsonb(NEW)-ARRAY['version','status','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','status','updated_at']) THEN RAISE EXCEPTION 'FORM_INVALID' USING ERRCODE='22023'; END IF;
 END IF;
 PERFORM hon.validate_public_form_config(jsonb_build_object('expectedVersion',NEW.version-1,'title',NEW.title,'description',NEW.description,'optionalFields',NEW.optional_fields,'pipelineId',NEW.pipeline_id,'pipelineStageId',NEW.pipeline_stage_id,'campaignId',NEW.campaign_id));
 RETURN NEW;
END $$;
CREATE TRIGGER public_form_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON hon.public_lead_forms FOR EACH ROW EXECUTE FUNCTION hon.guard_public_form_record();
CREATE TRIGGER public_form_no_truncate BEFORE TRUNCATE ON hon.public_lead_forms FOR EACH STATEMENT EXECUTE FUNCTION hon.guard_public_form_record();
CREATE FUNCTION hon.check_public_form_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hon AS $$
BEGIN
 IF TG_TABLE_NAME='public_lead_form_versions' THEN
  IF NEW.snapshot IS DISTINCT FROM (hon.public_form_staff_summary(NEW.form_id)-'acceptedCount') OR NEW.actor_principal_id::text IS DISTINCT FROM current_setting('app.hon_principal_id',true) OR NEW.request_id::text IS DISTINCT FROM current_setting('app.hon_request_id',true) THEN RAISE EXCEPTION 'INCOHERENT_FORM_VERSION' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM hon.public_lead_forms f JOIN hon.public_lead_form_versions v ON v.form_id=f.id AND v.version=f.version AND v.organization_id=f.organization_id AND v.school_id=f.school_id WHERE f.id=NEW.id) THEN RAISE EXCEPTION 'MISSING_FORM_VERSION' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER public_form_version_coherent BEFORE INSERT ON hon.public_lead_form_versions FOR EACH ROW EXECUTE FUNCTION hon.check_public_form_version();
CREATE CONSTRAINT TRIGGER public_form_current_version AFTER INSERT OR UPDATE ON hon.public_lead_forms DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hon.check_public_form_version();
REVOKE ALL ON FUNCTION hon.guard_public_form_record(),hon.check_public_form_version() FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN('hon_runtime','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION hon.guard_public_form_record(),hon.check_public_form_version() FROM %I',r);
 END LOOP;
END $$;
COMMIT;
