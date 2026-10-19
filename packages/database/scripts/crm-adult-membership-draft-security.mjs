import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const crmAdultMembershipDraftFunctions = [
  ['hon.guard_crm_adult_membership_draft_source()', false, false, '0161_crm_adult_membership_draft.sql'],
  ['hon.require_crm_adult_membership_actor(text)', true, false, '0161_crm_adult_membership_draft.sql'],
  ['hon.crm_adult_membership_relation(uuid)', true, false, '0161_crm_adult_membership_draft.sql'],
  ['hon.read_crm_adult_membership_preparation(text,uuid)', true, true, '0161_crm_adult_membership_draft.sql'],
  ['hon.read_crm_adult_membership_draft_confirmation(text,uuid)', true, true, '0162_crm_adult_membership_draft_confirmation.sql'],
  ['hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid)', true, true, '0161_crm_adult_membership_draft.sql'],
];
export async function verifyCrmAdultMembershipDraftSecurity(admin, runtimeRole) {
  const migrations = Object.fromEntries(await Promise.all([...new Set(crmAdultMembershipDraftFunctions.map(([, , , migration]) => migration))].map(async migration => [migration, await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8')])));
  const role = (await admin.query(`SELECT rolcanlogin AND NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS safe FROM pg_roles WHERE rolname=$1`, [runtimeRole])).rows[0];
  assert.equal(role?.safe, true, 'restricted runtime');
  for (const table of ['people','student_profiles','crm_leads','crm_lead_registration_conversions','family_members','billing_accounts','memberships','crm_adult_membership_draft_sources']) {
    const row = (await admin.query('SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid=$1::regclass', [`hon.${table}`])).rows[0];
    assert.deepEqual(row, { enabled: true, forced: true }, `FORCE RLS ${table}`);
  }
  for (const table of ['crm_adult_membership_draft_sources','crm_lead_registration_conversions']) {
    assert.equal((await admin.query(`SELECT NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl) a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner) AS safe
      FROM pg_class c WHERE c.oid=$1::regclass`, [`hon.${table}`])).rows[0].safe, true, `private source table ${table}`);
    for (const grantee of ['public', runtimeRole]) {
      assert.equal((await admin.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') AS allowed`, [grantee,`hon.${table}`])).rows[0].allowed, false);
    }
  }
  for (const [signature, definer, execute, migrationFile] of crmAdultMembershipDraftFunctions) {
    const name = signature.split('(')[0].slice(4);
    const expected = migrations[migrationFile].match(new RegExp(`CREATE FUNCTION hon\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
    assert(expected, `source found for ${signature}`);
    const row = (await admin.query(`SELECT p.prosrc,p.prosecdef AS definer,p.provolatile AS volatility,p.proconfig AS config,
      (o.rolsuper OR o.rolbypassrls) AS trusted,has_function_privilege($2,p.oid,'EXECUTE') AS execute,
      (SELECT count(*) FROM pg_proc x WHERE x.pronamespace=p.pronamespace AND x.proname=p.proname)=1 AS sole,
      NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=$2) OR NOT $3 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS private
      FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=$1::regprocedure`, [signature,runtimeRole,execute])).rows[0];
    assert.equal(row.prosrc, expected, `exact function source ${signature}`);
    assert.equal(row.definer, definer); assert.equal(row.volatility, 'v'); assert.equal(row.trusted, true);
    assert.deepEqual(row.config, ['search_path=pg_catalog, hon']); assert.equal(row.execute, execute); assert.equal(row.private, true); assert.equal(row.sole, true, `no overload ${signature}`);
  }
  for (const [name, type] of [['crm_adult_membership_source_immutable',27],['crm_adult_membership_source_no_truncate',34]]) {
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='hon.crm_adult_membership_draft_sources'::regclass
      AND tgname=$1 AND tgtype=$2 AND tgfoid='hon.guard_crm_adult_membership_draft_source()'::regprocedure
      AND tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred`, [name,type])).rows[0].count, 1);
  }
  for (const definition of ['PRIMARY KEY (conversion_id)','UNIQUE (membership_id)','UNIQUE (organization_id, school_id, actor_principal_id, idempotency_key)']) {
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid='hon.crm_adult_membership_draft_sources'::regclass
      AND convalidated AND NOT condeferrable AND pg_get_constraintdef(oid)=$1`, [definition])).rows[0].count, 1, definition);
  }
  for (const table of ['schools','crm_lead_registration_conversions','memberships']) {
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid='hon.crm_adult_membership_draft_sources'::regclass
      AND confrelid=$1::regclass AND contype='f' AND convalidated AND NOT condeferrable AND array_length(conkey,1)>=2 AND confdeltype='r'`, [`hon.${table}`])).rows[0].count, 1, `scoped restrictive FK ${table}`);
  }
}
