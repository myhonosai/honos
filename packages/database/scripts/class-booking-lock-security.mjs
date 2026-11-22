import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function verifyClassBookingLockSecurity(client, runtime = 'hon_runtime') {
  if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Invalid booking-lock runtime alias.');
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- Class booking lock exact verification:')[1]?.split('-- End class booking lock exact verification.')[0];
  if (!block) throw new Error('Missing canonical booking-lock verification.');
  await client.query(block.replaceAll('hon_runtime', runtime));
  const source = (await client.query("SELECT prosrc FROM pg_proc WHERE oid='hon.lock_class_booking_session(text,uuid)'::regprocedure")).rows[0].prosrc.replace(/--[^\n]*/g, '');
  if (!/FOR UPDATE OF s/i.test(source) || !/FOR phase IN 1\.\.2 LOOP/.test(source)) throw new Error('Session locking and post-wait authority checks required.');
  if (/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b/i.test(source.replace(/FOR UPDATE OF s/gi, ''))) throw new Error('Booking lock may not mutate or use dynamic SQL.');
  // 0631 (launch-readiness P2): the lock refuses the same identity planes as 0147 discovery.
  if (!/NOT EXISTS\(SELECT 1 FROM hon\.hq_operator_grants/.test(source) || !/NOT EXISTS\(SELECT 1 FROM hon\.family_access_grants/.test(source)
    || (source.match(/\^\(PARENT\|GUARDIAN\|STUDENT\|FAMILY\|HQ\|HON_\|PLATFORM\|SYSTEM\)/g) ?? []).length !== 2
    || !/x\.user_id=u\.id AND x\.is_active\)=1/.test(source)) throw new Error('Booking lock must refuse HQ, family, mixed-role and multi-principal identities.');
  // 0644 H2: booking authority comes only from a staff-assignable permission row (the 0147 discovery rule).
  if (!/JOIN hon\.permissions pm ON pm\.code=rp\.permission_code AND pm\.is_staff_assignable\n/.test(source)) throw new Error('Booking lock must require a staff-assignable schedule.booking.manage permission.');
  for (const relation of source.matchAll(/hon\.([a-z_]+)/g)) {
    if (!['current_organization_id', 'current_school_id', 'principals', 'users', 'organizations', 'schools', 'principal_role_grants', 'roles', 'role_permissions', 'organization_entitlements', 'class_sessions', 'hq_operator_grants', 'family_access_grants', 'permissions'].includes(relation[1])) throw new Error('Unexpected booking lock dependency: ' + relation[1]);
  }
  const helper = (await client.query("SELECT prosrc FROM pg_proc WHERE oid='hon.require_classpass_read_actor(text)'::regprocedure")).rows[0].prosrc.replace(/--[^\n]*/g, '');
  if (/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b|FOR SHARE|FOR KEY SHARE/i.test(helper)) throw new Error('ClassPass read authorization must be read-only and lock-free.');
}

export async function testClassBookingLockVerifier(client, runtime = 'hon_runtime') {
  await verifyClassBookingLockSecurity(client, runtime);
  for (const sql of [
    `GRANT UPDATE ON hon.class_sessions TO ${runtime}`,
    `GRANT UPDATE(capacity) ON hon.class_sessions TO ${runtime}`,
    'GRANT UPDATE(capacity) ON hon.class_sessions TO PUBLIC',
    'GRANT EXECUTE ON FUNCTION hon.lock_class_booking_session(text,uuid) TO PUBLIC',
    `GRANT EXECUTE ON FUNCTION hon.require_classpass_read_actor(text) TO ${runtime}`,
    `GRANT EXECUTE ON FUNCTION hon.lock_class_booking_session(text,uuid) TO ${runtime} WITH GRANT OPTION`,
    'ALTER FUNCTION hon.lock_class_booking_session(text,uuid) SECURITY INVOKER',
    'ALTER FUNCTION hon.lock_class_booking_session(text,uuid) SET search_path=hon,pg_catalog',
    `REVOKE EXECUTE ON FUNCTION hon.lock_class_booking_session(text,uuid) FROM ${runtime}`,
  ]) {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await assert.rejects(() => verifyClassBookingLockSecurity(client, runtime));
    } finally { await client.query('ROLLBACK'); }
  }
  await verifyClassBookingLockSecurity(client, runtime);
}
