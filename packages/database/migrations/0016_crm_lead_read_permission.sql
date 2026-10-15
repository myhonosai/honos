BEGIN;

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES ('crm.lead.read', 'Read CRM leads and their primary contact in an authorized school', false)
ON CONFLICT (code) DO NOTHING;

COMMIT;
