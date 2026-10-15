BEGIN;

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES ('billing.account.create', 'Create a billing account for an in-scope responsible person', false)
ON CONFLICT (code) DO NOTHING;

COMMIT;
