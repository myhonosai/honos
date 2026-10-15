BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE SCHEMA IF NOT EXISTS hon;

CREATE TYPE hon.principal_type AS ENUM ('HUMAN_USER', 'AI_EMPLOYEE', 'AUTOMATION', 'INTEGRATION', 'SYSTEM_SERVICE');
CREATE TYPE hon.membership_status AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE hon.audit_result AS ENUM ('SUCCEEDED', 'DENIED', 'FAILED', 'UNKNOWN');
CREATE TYPE hon.outbox_status AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER');

CREATE TABLE hon.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  status hon.membership_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hon.schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  slug text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  status hon.membership_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, slug)
);

CREATE TABLE hon.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text UNIQUE NOT NULL,
  email citext NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hon.principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type hon.principal_type NOT NULL,
  user_id uuid REFERENCES hon.users(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((principal_type = 'HUMAN_USER') = (user_id IS NOT NULL))
);

CREATE TABLE hon.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  is_system_role boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);

CREATE TABLE hon.permissions (
  code text PRIMARY KEY,
  description text NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT false
);

CREATE TABLE hon.role_permissions (
  role_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  permission_code text NOT NULL REFERENCES hon.permissions(code) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_code),
  FOREIGN KEY (role_id, organization_id) REFERENCES hon.roles(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE hon.principal_role_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL,
  granted_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (role_id, organization_id) REFERENCES hon.roles(id, organization_id) ON DELETE RESTRICT,
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE OR REPLACE FUNCTION hon.current_organization_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.hon_organization_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION hon.current_school_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.hon_school_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION hon.require_tenant_context() RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF hon.current_organization_id() IS NULL OR hon.current_school_id() IS NULL THEN
    RAISE EXCEPTION 'HON tenant context is required' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE TABLE hon.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  actor_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  delegated_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  source text NOT NULL,
  action_code text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  prior_state jsonb,
  next_state jsonb,
  result hon.audit_result NOT NULL,
  request_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  action_request_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE hon.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, school_id, principal_id, idempotency_key)
);

CREATE TABLE hon.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  status hon.outbox_status NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error jsonb,
  published_at timestamptz,
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX outbox_events_dispatch_idx ON hon.outbox_events (status, next_attempt_at, occurred_at)
  WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX audit_events_scope_idx ON hon.audit_events (organization_id, school_id, occurred_at DESC);

ALTER TABLE hon.schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.principal_role_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.outbox_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY schools_tenant_isolation ON hon.schools
  USING (organization_id = hon.current_organization_id() AND id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND id = hon.current_school_id());
CREATE POLICY roles_tenant_isolation ON hon.roles
  USING (organization_id = hon.current_organization_id())
  WITH CHECK (organization_id = hon.current_organization_id());
CREATE POLICY principal_role_grants_tenant_isolation ON hon.principal_role_grants
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY audit_events_tenant_isolation ON hon.audit_events
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY idempotency_records_tenant_isolation ON hon.idempotency_records
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());
CREATE POLICY outbox_events_tenant_isolation ON hon.outbox_events
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

COMMIT;
