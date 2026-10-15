BEGIN;
-- Import provenance must retain composite scope even against privileged mistakes.
ALTER TABLE hon.lead_import_rows ADD CONSTRAINT import_row_lead_scope_fk
 FOREIGN KEY(lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id) ON DELETE RESTRICT;
ALTER TABLE hon.lead_import_rows ADD CONSTRAINT import_row_applied_unique UNIQUE(batch_id,row_index,lead_id);
ALTER TABLE hon.lead_import_evidence ADD CONSTRAINT import_evidence_lead_scope_fk
 FOREIGN KEY(lead_id,organization_id,school_id) REFERENCES hon.crm_leads(id,organization_id,school_id) ON DELETE RESTRICT;
ALTER TABLE hon.lead_import_evidence ADD CONSTRAINT import_evidence_applied_row_fk
 FOREIGN KEY(batch_id,row_index,lead_id) REFERENCES hon.lead_import_rows(batch_id,row_index,lead_id) ON DELETE RESTRICT;
COMMIT;
