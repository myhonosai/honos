BEGIN;

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES ('crm.lead.create', 'Create a lead and primary contact within an authorized school', false)
ON CONFLICT (code) DO NOTHING;

COMMIT;
