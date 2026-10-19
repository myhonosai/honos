import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const crmGuardianChildMembershipDraftFunctions = [
  [
    "hon.guard_crm_guardian_child_registration_source_facts()",
    false,
    false,
    "0167_crm_guardian_child_registration_source_facts.sql"
  ],
  [
    "hon.capture_crm_guardian_child_registration_source_facts()",
    true,
    false,
    "0167_crm_guardian_child_registration_source_facts.sql"
  ],
  [
    "hon.guard_crm_guardian_child_payer_designation()",
    false,
    false,
    "0164_crm_guardian_child_payer_designation.sql"
  ],
  [
    "hon.require_crm_guardian_child_membership_actor(text)",
    true,
    false,
    "0164_crm_guardian_child_payer_designation.sql"
  ],
  [
    "hon.crm_guardian_child_membership_relation(uuid)",
    true,
    false,
    "0167_crm_guardian_child_registration_source_facts.sql"
  ],
  [
    "hon.crm_guardian_child_designated_relation(uuid)",
    true,
    false,
    "0164_crm_guardian_child_payer_designation.sql"
  ],
  [
    "hon.read_crm_guardian_child_payer_designation_preparation(text,uuid)",
    true,
    true,
    "0164_crm_guardian_child_payer_designation.sql"
  ],
  [
    "hon.designate_crm_guardian_child_payer(text,jsonb,uuid,uuid,uuid)",
    true,
    true,
    "0164_crm_guardian_child_payer_designation.sql"
  ],
  [
    "hon.guard_crm_guardian_child_membership_draft_source()",
    false,
    false,
    "0165_crm_guardian_child_membership_draft.sql"
  ],
  [
    "hon.guard_crm_guardian_child_membership_insert()",
    true,
    false,
    "0165_crm_guardian_child_membership_draft.sql"
  ],
  [
    "hon.read_crm_guardian_child_membership_preparation(text,uuid)",
    true,
    true,
    "0165_crm_guardian_child_membership_draft.sql"
  ],
  [
    "hon.draft_crm_guardian_child_membership(text,jsonb,uuid,uuid,uuid)",
    true,
    true,
    "0165_crm_guardian_child_membership_draft.sql"
  ],
  [
    "hon.read_crm_guardian_child_membership_draft_confirmation(text,uuid)",
    true,
    true,
    "0166_crm_guardian_child_membership_draft_confirmation.sql"
  ]
];
export async function verifyCrmGuardianChildMembershipDraftSecurity(admin, runtimeRole) {
  const role = (await admin.query(`SELECT rolcanlogin AND NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication)
    AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AS safe FROM pg_roles WHERE rolname=$1`, [runtimeRole])).rows[0];
  assert.equal(role?.safe, true, 'restricted runtime');
  const migrations = Object.fromEntries(await Promise.all([...new Set(crmGuardianChildMembershipDraftFunctions.map(([, , , file]) => file))].map(async file => [file, await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')])));
  for (const [signature, , , file] of crmGuardianChildMembershipDraftFunctions) {
    const name = signature.split('(')[0].slice(4);
    const expected = migrations[file].match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION hon\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
    assert(expected, `source found for ${signature}`);
    assert.equal((await admin.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0]?.prosrc, expected, `exact source ${signature}`);
  }
  const canonical = await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
  const block = canonical.split('-- Guardian-child CRM exact verification:')[1]?.split('-- End guardian-child CRM exact verification.')[0];
  assert(block, 'canonical verifier block');
  await admin.query(block.slice(block.indexOf('DO $$')).replaceAll('hon_runtime', runtimeRole));
}
