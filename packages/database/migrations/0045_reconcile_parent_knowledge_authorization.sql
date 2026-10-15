BEGIN;

-- Parent-safe school knowledge is intentionally authorized by the existing
-- family-access resolver, not by a staff ROLE permission. The earlier
-- knowledge.parent.read seed was never enforced by the parent projection and
-- was granted only to OWNER roles, so retaining it would falsely imply a
-- separate parent capability. Remove that unused metadata rather than leaving
-- a dead authorization control in the catalog.
DELETE FROM hon.role_permissions
WHERE permission_code = 'knowledge.parent.read';

DELETE FROM hon.permissions
WHERE code = 'knowledge.parent.read';

COMMIT;
