BEGIN;

CREATE TYPE hon.lead_status AS ENUM ('OPEN', 'WON', 'LOST', 'ARCHIVED');
CREATE TYPE hon.membership_state AS ENUM ('DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED');
CREATE TYPE hon.invoice_status AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');
CREATE TYPE hon.payment_state AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'UNKNOWN', 'REFUNDED');

CREATE TABLE hon.people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  given_name text NOT NULL,
  family_name text NOT NULL,
  email citext,
  phone_e164 text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE hon.crm_pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id)
);

CREATE TABLE hon.crm_pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  school_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  name text NOT NULL,
  position integer NOT NULL,
  terminal_status hon.lead_status,
  FOREIGN KEY (pipeline_id, organization_id, school_id) REFERENCES hon.crm_pipelines(id, organization_id, school_id) ON DELETE CASCADE,
  UNIQUE (id, organization_id, school_id),
  UNIQUE (pipeline_id, position)
);

CREATE TABLE hon.crm_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  primary_person_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  pipeline_stage_id uuid NOT NULL,
  status hon.lead_status NOT NULL DEFAULT 'OPEN',
  source_code text,
  program_interest_code text,
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_follow_up_at timestamptz,
  won_at timestamptz,
  lost_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (primary_person_id) REFERENCES hon.people(id) ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_id, organization_id, school_id) REFERENCES hon.crm_pipelines(id, organization_id, school_id) ON DELETE RESTRICT,
  FOREIGN KEY (pipeline_stage_id, organization_id, school_id) REFERENCES hon.crm_pipeline_stages(id, organization_id, school_id) ON DELETE RESTRICT
);

CREATE TABLE hon.crm_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES hon.crm_leads(id) ON DELETE RESTRICT,
  activity_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE hon.billing_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  responsible_person_id uuid NOT NULL REFERENCES hon.people(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL DEFAULT 'USD',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE hon.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  billing_account_id uuid NOT NULL REFERENCES hon.billing_accounts(id) ON DELETE RESTRICT,
  participant_person_id uuid NOT NULL REFERENCES hon.people(id) ON DELETE RESTRICT,
  plan_code text NOT NULL,
  state hon.membership_state NOT NULL DEFAULT 'DRAFT',
  term_started_at timestamptz,
  term_ends_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE hon.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  billing_account_id uuid NOT NULL REFERENCES hon.billing_accounts(id) ON DELETE RESTRICT,
  membership_id uuid REFERENCES hon.memberships(id) ON DELETE RESTRICT,
  status hon.invoice_status NOT NULL DEFAULT 'DRAFT',
  currency char(3) NOT NULL,
  subtotal_minor integer NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor integer NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor integer NOT NULL CHECK (total_minor >= 0),
  due_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE hon.payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES hon.invoices(id) ON DELETE RESTRICT,
  provider_code text NOT NULL,
  provider_account_reference text NOT NULL,
  provider_idempotency_reference text NOT NULL,
  provider_payment_reference text,
  state hon.payment_state NOT NULL DEFAULT 'PENDING',
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  initiated_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (provider_code, provider_account_reference, provider_idempotency_reference)
);

CREATE INDEX crm_leads_scope_stage_idx ON hon.crm_leads (organization_id, school_id, pipeline_stage_id, created_at DESC);
CREATE INDEX invoice_open_scope_idx ON hon.invoices (organization_id, school_id, status, due_at) WHERE status = 'OPEN';
CREATE INDEX payment_attempt_reconcile_idx ON hon.payment_attempts (state, initiated_at) WHERE state IN ('PENDING', 'PROCESSING', 'UNKNOWN');

ALTER TABLE hon.people ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.payment_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY people_tenant_isolation ON hon.people USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY crm_pipelines_tenant_isolation ON hon.crm_pipelines USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY crm_pipeline_stages_tenant_isolation ON hon.crm_pipeline_stages USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY crm_leads_tenant_isolation ON hon.crm_leads USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY crm_activities_tenant_isolation ON hon.crm_activities USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY billing_accounts_tenant_isolation ON hon.billing_accounts USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY memberships_tenant_isolation ON hon.memberships USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY invoices_tenant_isolation ON hon.invoices USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY payment_attempts_tenant_isolation ON hon.payment_attempts USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id()) WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

COMMIT;