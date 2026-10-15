BEGIN;

-- A UUID alone is never sufficient to relate operational records. These composite
-- constraints make cross-school or cross-organization references structurally invalid.
ALTER TABLE hon.people ADD CONSTRAINT people_id_tenant_unique UNIQUE (id, organization_id, school_id);
ALTER TABLE hon.crm_leads ADD CONSTRAINT crm_leads_id_tenant_unique UNIQUE (id, organization_id, school_id);
ALTER TABLE hon.billing_accounts ADD CONSTRAINT billing_accounts_id_tenant_unique UNIQUE (id, organization_id, school_id);
ALTER TABLE hon.memberships ADD CONSTRAINT memberships_id_tenant_unique UNIQUE (id, organization_id, school_id);
ALTER TABLE hon.invoices ADD CONSTRAINT invoices_id_tenant_unique UNIQUE (id, organization_id, school_id);
ALTER TABLE hon.action_requests ADD CONSTRAINT action_requests_id_tenant_unique UNIQUE (id, organization_id, school_id);
ALTER TABLE hon.work_items ADD CONSTRAINT work_items_id_tenant_unique UNIQUE (id, organization_id, school_id);

ALTER TABLE hon.crm_leads
  ADD CONSTRAINT crm_leads_primary_person_tenant_fk
  FOREIGN KEY (primary_person_id, organization_id, school_id)
  REFERENCES hon.people (id, organization_id, school_id) ON DELETE RESTRICT;
ALTER TABLE hon.crm_activities
  ADD CONSTRAINT crm_activities_lead_tenant_fk
  FOREIGN KEY (lead_id, organization_id, school_id)
  REFERENCES hon.crm_leads (id, organization_id, school_id) ON DELETE RESTRICT;
ALTER TABLE hon.billing_accounts
  ADD CONSTRAINT billing_accounts_responsible_person_tenant_fk
  FOREIGN KEY (responsible_person_id, organization_id, school_id)
  REFERENCES hon.people (id, organization_id, school_id) ON DELETE RESTRICT;
ALTER TABLE hon.memberships
  ADD CONSTRAINT memberships_billing_account_tenant_fk
  FOREIGN KEY (billing_account_id, organization_id, school_id)
  REFERENCES hon.billing_accounts (id, organization_id, school_id) ON DELETE RESTRICT,
  ADD CONSTRAINT memberships_participant_tenant_fk
  FOREIGN KEY (participant_person_id, organization_id, school_id)
  REFERENCES hon.people (id, organization_id, school_id) ON DELETE RESTRICT;
ALTER TABLE hon.invoices
  ADD CONSTRAINT invoices_billing_account_tenant_fk
  FOREIGN KEY (billing_account_id, organization_id, school_id)
  REFERENCES hon.billing_accounts (id, organization_id, school_id) ON DELETE RESTRICT,
  ADD CONSTRAINT invoices_membership_tenant_fk
  FOREIGN KEY (membership_id, organization_id, school_id)
  REFERENCES hon.memberships (id, organization_id, school_id) ON DELETE RESTRICT;
ALTER TABLE hon.payment_attempts
  ADD CONSTRAINT payment_attempts_invoice_tenant_fk
  FOREIGN KEY (invoice_id, organization_id, school_id)
  REFERENCES hon.invoices (id, organization_id, school_id) ON DELETE RESTRICT;
ALTER TABLE hon.action_approvals
  ADD CONSTRAINT action_approvals_request_tenant_fk
  FOREIGN KEY (action_request_id, organization_id, school_id)
  REFERENCES hon.action_requests (id, organization_id, school_id) ON DELETE RESTRICT;
ALTER TABLE hon.work_items
  ADD CONSTRAINT work_items_parent_tenant_fk
  FOREIGN KEY (parent_work_item_id, organization_id, school_id)
  REFERENCES hon.work_items (id, organization_id, school_id) ON DELETE RESTRICT;

-- The migration owner is not implicitly allowed around school RLS. Production
-- runtime credentials must also be non-superuser/non-BYPASSRLS principals.
ALTER TABLE hon.schools FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.roles FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.principal_role_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.idempotency_records FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.people FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_pipelines FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_pipeline_stages FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_leads FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_activities FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.payment_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.action_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.action_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.action_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE hon.work_items FORCE ROW LEVEL SECURITY;

COMMIT;