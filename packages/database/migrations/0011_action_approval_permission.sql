BEGIN;

INSERT INTO hon.permissions (code, description, is_sensitive)
VALUES ('action.approve', 'Review and decide a tenant-scoped HON Action Engine confirmation proposal', true)
ON CONFLICT (code) DO NOTHING;

COMMIT;
