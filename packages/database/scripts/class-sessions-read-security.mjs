export async function verifyClassSessionsReadSecurity(client, runtime = 'hon_runtime') {
  if (!/^hon_[a-z_]+$/.test(runtime)) throw new Error('Unsafe Class Sessions runtime alias.');
  const required = ['hon.require_current_school_class_sessions_read_actor(text)', 'hon.read_current_school_class_sessions(text)'];
  const functions = await client.query(`SELECT p.oid::regprocedure::text signature, p.prosecdef, p.provolatile, p.prosrc
    FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[])`, [required]);
  if (functions.rows.length !== 2) throw new Error('Missing Class Sessions read functions.');
  for (const row of functions.rows) if (!row.prosecdef || row.provolatile !== 'v') throw new Error(`Class Sessions function posture weakened: ${row.signature}`);
  const helper = functions.rows.find((row) => row.signature.startsWith('hon.require_current_school_class_sessions_read_actor'))?.prosrc ?? '';
  const read = functions.rows.find((row) => row.signature.startsWith('hon.read_current_school_class_sessions'))?.prosrc ?? '';
  if (!helper.includes("'schedule.session.read'") || !helper.includes("'HUMAN_USER'") || !helper.includes("'HUMAN_UI'") || !helper.includes('hq_operator_grants') || !helper.includes('family_access_grants') || !helper.includes('organization_entitlements')) throw new Error('Class Sessions helper lacks exact direct-human authority checks.');
  const body = read.replace(/--[^\n]*/g, '');
  if ((body.match(/require_current_school_class_sessions_read_actor/g) ?? []).length !== 2 || !body.includes('LIMIT 50') || !body.includes("interval '30 days'") || !body.includes("interval '91 days'")) throw new Error('Class Sessions fixed read window/reauthorization weakened.');
  if (/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b/i.test(body) || /\bFOR\s+(?:UPDATE|SHARE|KEY\s+SHARE)\b/i.test(body)) throw new Error('Class Sessions read must not mutate or lock.');
  for (const forbidden of ['class_session_instructors', 'class_bookings', 'attendance_records', 'families', 'student_profiles', 'memberships', 'invoices', 'payment_attempts', 'action_requests', 'ai_usage_ledger', 'outbox_events', 'audit_events']) if (body.includes(`hon.${forbidden}`)) throw new Error(`Class Sessions projection depends on forbidden table: ${forbidden}`);
  for (const field of ['sessionId', 'name', 'startsAt', 'endsAt', 'roomName', 'capacity', 'bookingPolicy', 'status', 'createdAt']) if (!body.includes(`'${field}'`)) throw new Error(`Class Sessions projection lacks ${field}.`);
  const rls = (await client.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='hon.class_sessions'::regclass")).rows[0];
  if (!rls?.relrowsecurity || !rls?.relforcerowsecurity) throw new Error('class_sessions must retain forced RLS.');
  const acl = await client.query(`SELECT has_table_privilege($1, 'hon.class_sessions', 'SELECT') AS table_select,
    has_function_privilege($1, 'hon.read_current_school_class_sessions(text)', 'EXECUTE') AS read_execute,
    has_function_privilege($1, 'hon.require_current_school_class_sessions_read_actor(text)', 'EXECUTE') AS helper_execute,
    EXISTS (SELECT 1 FROM pg_proc AS proc CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
      WHERE proc.oid = 'hon.read_current_school_class_sessions(text)'::regprocedure
        AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE') AS public_execute`, [runtime]);
  const privileges = acl.rows[0];
  if (privileges?.table_select || !privileges?.read_execute || privileges?.helper_execute || privileges?.public_execute) throw new Error('Class Sessions function-only ACL weakened.');
  // 0221 forward pages: the same private helper before and after the read, read-only, no other table, runtime EXECUTE only.
  const pages = (await client.query(`SELECT p.prosecdef, p.provolatile, p.prosrc, has_function_privilege($1, p.oid, 'EXECUTE') AS runtime_execute,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS privilege WHERE privilege.grantee = 0) AS public_any
    FROM pg_proc p WHERE p.oid = to_regprocedure('hon.read_school_class_session_page(text,jsonb)')`, [runtime])).rows[0];
  if (!pages || !pages.prosecdef || pages.provolatile !== 'v' || !pages.runtime_execute || pages.public_any) throw new Error('Class-session page function posture weakened.');
  const pageBody = pages.prosrc.replace(/--[^\n]*/g, '');
  if ((pageBody.match(/require_current_school_class_sessions_read_actor/g) ?? []).length !== 2
    || /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b/i.test(pageBody) || /\bFOR\s+(?:UPDATE|SHARE|KEY\s+SHARE|NO\s+KEY)\b/i.test(pageBody)
    || [...pageBody.matchAll(/\bhon\.([a-z_]+)/g)].some(([, name]) => !['require_current_school_class_sessions_read_actor', 'current_organization_id', 'current_school_id', 'schools', 'class_sessions'].includes(name))) {
    throw new Error('Class-session page read must re-authorize twice, never mutate or lock, and read only schools and class_sessions.');
  }
  const permission = (await client.query("SELECT is_sensitive, is_staff_assignable FROM hon.permissions WHERE code='schedule.session.read'" )).rows[0];
  if (!permission || permission.is_sensitive || !permission.is_staff_assignable) throw new Error('Class Sessions exact permission is invalid.');
}
