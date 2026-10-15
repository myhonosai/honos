BEGIN;

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES ('crm.pipeline.manage', 'Create and configure CRM pipelines and stages in an authorized school', false)
ON CONFLICT (code) DO NOTHING;

COMMIT;
