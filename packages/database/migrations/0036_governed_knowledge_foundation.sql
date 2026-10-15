BEGIN;

CREATE TYPE hon.knowledge_article_audience AS ENUM ('STAFF', 'PARENT_SAFE');
CREATE TYPE hon.knowledge_article_lifecycle AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- Types are not public API. Every runtime cast is explicitly granted below.
REVOKE USAGE ON TYPE hon.knowledge_article_audience, hon.knowledge_article_lifecycle FROM PUBLIC;

CREATE TABLE hon.knowledge_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES hon.organizations(id) ON DELETE RESTRICT,
  school_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  audience hon.knowledge_article_audience NOT NULL,
  lifecycle hon.knowledge_article_lifecycle NOT NULL DEFAULT 'DRAFT',
  effective_from timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_by_principal_id uuid NOT NULL REFERENCES hon.principals(id) ON DELETE RESTRICT,
  approved_by_principal_id uuid REFERENCES hon.principals(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, organization_id) REFERENCES hon.schools(id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id, school_id),
  CHECK (btrim(title) <> ''),
  CHECK (btrim(body) <> ''),
  CHECK (version >= 1),
  -- A draft has no publication facts. An approved or archived article retains
  -- an attributable human approval and an explicit effective timestamp.
  CHECK (
    (lifecycle = 'DRAFT' AND effective_from IS NULL AND approved_by_principal_id IS NULL AND approved_at IS NULL)
    OR
    (lifecycle IN ('APPROVED', 'ARCHIVED') AND effective_from IS NOT NULL AND approved_by_principal_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  -- Segregation of duties is database-enforced, not merely a controller rule.
  CHECK (approved_by_principal_id IS NULL OR approved_by_principal_id <> created_by_principal_id)
);

CREATE INDEX knowledge_articles_scope_lifecycle_effective_idx
  ON hon.knowledge_articles (organization_id, school_id, lifecycle, effective_from DESC);
CREATE INDEX knowledge_articles_parent_safe_effective_idx
  ON hon.knowledge_articles (organization_id, school_id, effective_from DESC)
  WHERE audience = 'PARENT_SAFE' AND lifecycle = 'APPROVED';
CREATE INDEX knowledge_articles_creator_scope_idx
  ON hon.knowledge_articles (created_by_principal_id, organization_id, school_id, created_at DESC);

ALTER TABLE hon.knowledge_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hon.knowledge_articles FORCE ROW LEVEL SECURITY;

CREATE POLICY knowledge_articles_tenant_isolation ON hon.knowledge_articles
  USING (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id())
  WITH CHECK (organization_id = hon.current_organization_id() AND school_id = hon.current_school_id());

-- There is no parent endpoint in this foundation. Define only the permissions
-- exercised by the staff command paths; a future parent projection must add its
-- own reviewed knowledge.parent.read authority instead of pre-granting it.
INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES
  ('knowledge.manage', 'Create governed school knowledge article drafts', false),
  ('knowledge.approve', 'Approve a different principal’s school knowledge article draft', true)
ON CONFLICT (code) DO NOTHING;

-- Bring existing system owners forward. Newly provisioned OWNER roles inherit
-- every then-current permission in hon.provision_school_from_hq.
INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
SELECT role.id, role.organization_id, permission.code
FROM hon.roles AS role
JOIN hon.permissions AS permission ON permission.code IN ('knowledge.manage', 'knowledge.approve')
WHERE role.code = 'OWNER' AND role.is_system_role = true
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Exact application data-plane requirements: scope-bound read/create/approval
-- only. Delete, DDL, identity/IAM, and type access beyond these casts remain denied.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hon_runtime') THEN
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE hon.knowledge_articles FROM hon_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE hon.knowledge_articles TO hon_runtime;
    GRANT USAGE ON TYPE hon.knowledge_article_audience, hon.knowledge_article_lifecycle TO hon_runtime;
  END IF;
END;
$$;

COMMIT;
