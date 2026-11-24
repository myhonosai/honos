/**
 * Automatic contact consent at lead intake (IC1, 0634) on the guarded disposable CRM-close fixture only.
 * Owner decision 2026-11-19 "Email automatic, texts one tick":
 *   - a website form records email consent; text consent only with the lead's own textOptIn tick and a mobile;
 *   - a Zernio (Facebook/Instagram) lead records email consent only;
 *   - a lead with an intake source code but no intake evidence (no receipt) records nothing; demo-like inserts record nothing;
 *   - staff adds and imports record what staff left ticked, only for people created in the same transaction;
 *   - an existing row is never overwritten; an opt-out on another record with the same address wins (PRIOR_OPT_OUT);
 *   - STOP still flips an automatic agreement; evidence is append-only, identifier-only, tenant-scoped; private helpers.
 * Synthetic names and example.test contacts only; nothing is sent.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';

await import('./test-crm-close-proof-target.mjs');
const targets = crmCloseProofTargets(process.env);
const admin = new pg.Client(targets.owner); await admin.connect(); await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime); await runtime.connect(); await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);
const sql = (text, values = []) => admin.query(text, values).catch((e) => { if (process.env.IC1_DEBUG) console.error("SQL", text.slice(0, 120), e.message); throw e; });
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const ids = Object.fromEntries(['org', 'otherOrg', 'schoolA', 'schoolB', 'otherSchool', 'pipeA', 'stageA', 'pipeB', 'stageB', 'form', 'zForm'].map((k) => [k, randomUUID()]));
const orgs = [ids.org, ids.otherOrg];
const FORM_SVC = '00000000-0000-4000-8000-000000000075';
const ZERNIO_SVC = '00000000-0000-4000-8000-00000000c050';
const tag = `ic1-${ids.org}`;

async function cleanup() {
  await sql('BEGIN'); await sql('SET CONSTRAINTS ALL IMMEDIATE');
  try {
    for (let pass = 0; pass < 10; pass += 1) {
      let failed = 0;
      for (const table of ['public_lead_form_versions', 'communication_consent_captures', 'communication_consents', 'outbox_events', 'audit_events', 'zernio_lead_receipts', 'zernio_lead_forms',
        'public_lead_form_receipts', 'public_lead_forms', 'crm_lead_attributions', 'crm_leads', 'people', 'crm_pipeline_stages', 'crm_pipelines',
        'idempotency_records', 'principal_role_grants', 'role_permissions', 'roles', 'organization_entitlements', 'schools']) {
        await sql('SAVEPOINT t');
        try {
          if (table === 'public_lead_forms') await sql('DELETE FROM hon.public_lead_form_rates WHERE form_id IN (SELECT id FROM hon.public_lead_forms WHERE organization_id = ANY($1::uuid[]))', [orgs]);
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [orgs]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT t');
        } catch (error) { failed += 1; if (pass === 9) console.error('cleanup', table, error.message); await sql('ROLLBACK TO SAVEPOINT t'); }
      }
      if (!failed) break;
    }
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${tag}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${tag}-%`]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function staff(label, permissions, { org = ids.org, school = ids.schoolA, roleCode } = {}) {
  const user = randomUUID(), principal = randomUUID(), role = randomUUID(), subject = `${tag}-${label}`;
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [role, org, roleCode ?? `STAFF_${role.slice(0, 8)}`]);
  for (const p of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, p]);
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Desk Staff')", [user, subject, `${user}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Desk Staff')", [principal, user]);
  await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [org, school, principal, role]);
  return { subject, principal, org, school };
}

// The runtime transaction shape of RuntimeDatabaseService.withTenantTransaction for a signed-in staff member.
async function asStaff(who, work, { commit = true } = {}) {
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
      set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_request_id',$4,true),set_config('app.hon_source','HUMAN_UI',true),
      set_config('app.hon_external_subject',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`,
    [who.org, who.school, who.principal, randomUUID(), who.subject]);
    const result = await work(runtime);
    await runtime.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) { await runtime.query('ROLLBACK'); throw error; }
}
const refusedCode = async (promise, code, message) => {
  try { await promise; } catch (error) { ok(error.code === code, `${message} (got ${error.code} ${error.message})`); return; }
  assert.fail(`${message}: expected ${code}`);
};
const consents = async (person) => (await sql(`SELECT c.channel::text channel, c.status::text status, c.source::text source, c.version,
    (SELECT jsonb_agg(jsonb_build_object('method',k.method,'evidence',k.evidence,'status',k.status::text,'version',k.consent_version,'actor',k.actor_principal_id) ORDER BY k.captured_at) FROM hon.communication_consent_captures k WHERE k.consent_id=c.id) captures
  FROM hon.communication_consents c WHERE c.person_id=$1 ORDER BY c.channel::text`, [person])).rows;
const leadPerson = async (lead) => (await sql('SELECT primary_person_id FROM hon.crm_leads WHERE id=$1', [lead])).rows[0].primary_person_id;
const formLead = async (email) => (await sql("SELECT l.id, l.primary_person_id FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id WHERE l.organization_id=$1 AND l.source_code='PUBLIC_API' AND p.email=$2", [ids.org, email])).rows[0];
let formPublicId;
const submit = async (input, key = `key-${randomUUID()}`) =>
  (await runtime.query('SELECT hon.submit_public_form($1,$2::jsonb,$3) r', [formPublicId, JSON.stringify({ website: '', acknowledged: true, ...input }), key])).rows[0].r;

try {
  await cleanup();
  // Seed: one organization with two schools, another organization, pipelines, a published form and a Zernio mapping.
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'IC1 Org','IC1 Org'),($2,'IC1 Other','IC1 Other')", orgs);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", orgs);
  for (const [school, org, slug] of [[ids.schoolA, ids.org, 'a'], [ids.schoolB, ids.org, 'b'], [ids.otherSchool, ids.otherOrg, 'o']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, `IC1 Dojo ${slug}`, `ic1-${slug}-${school.slice(0, 8)}`]);
  }
  for (const [pipe, stage, school] of [[ids.pipeA, ids.stageA, ids.schoolA], [ids.pipeB, ids.stageB, ids.schoolB]]) {
    await sql("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'New leads')", [pipe, ids.org, school]);
    await sql("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, ids.org, school, pipe]);
  }
  // Seeded published directly by the fixture owner (the staff publish flow has its own proof).
  await sql('BEGIN'); await sql('ALTER TABLE hon.public_lead_forms DISABLE TRIGGER USER');
  await sql("INSERT INTO hon.public_lead_forms(id,organization_id,school_id,status,title,description,optional_fields,pipeline_id,pipeline_stage_id) VALUES($1,$2,$3,'PUBLISHED','Free class','Ask us','[]'::jsonb,$4,$5)",
    [ids.form, ids.org, ids.schoolA, ids.pipeA, ids.stageA]);
  const formRequest = randomUUID();
  await sql("SELECT set_config('app.hon_principal_id',$1,true),set_config('app.hon_request_id',$2,true),set_config('app.hon_organization_id',$3,true),set_config('app.hon_school_id',$4,true)", [FORM_SVC, formRequest, ids.org, ids.schoolA]);
  await sql("INSERT INTO hon.public_lead_form_versions(form_id,organization_id,school_id,version,actor_principal_id,request_id,snapshot) SELECT $1,$2,$3,1,$4,$5,hon.public_form_staff_summary($1)-'acceptedCount'",
    [ids.form, ids.org, ids.schoolA, FORM_SVC, formRequest]);
  await sql('ALTER TABLE hon.public_lead_forms ENABLE TRIGGER USER'); await sql('COMMIT');
  formPublicId = (await sql('SELECT public_id FROM hon.public_lead_forms WHERE id=$1', [ids.form])).rows[0].public_id;
  await sql(`INSERT INTO hon.zernio_lead_forms(id,organization_id,school_id,account_id,form_id,pipeline_id,pipeline_stage_id,field_map,status,set_by_principal_id)
    VALUES($1,$2,$3,'ic1acct',$4,$5,$6,'{"fullName":"full_name","email":"email","phone":"phone_number"}'::jsonb,'ACTIVE',$7)`,
  [ids.zForm, ids.org, ids.schoolA, `f${ids.zForm.slice(0, 8)}`, ids.pipeA, ids.stageA, ZERNIO_SVC]);
  const MANAGER = await staff('manager', ['crm.lead.create', 'people.create', 'migration.lead_import.review', 'students.import']);
  const PEOPLE_ONLY = await staff('people', ['people.create']);
  const READER = await staff('reader', ['people.read', 'crm.lead.read']);
  const PARENTISH = await staff('parentish', ['crm.lead.create', 'people.create'], { roleCode: 'PARENT_PORTAL' });
  const B_STAFF = await staff('b-manager', ['crm.lead.create', 'people.create'], { school: ids.schoolB });

  // 1. Website form: email automatic, text only with the lead's own tick.
  ok(await submit({ name: 'Ada', email: 'ada@example.test', mobile: '+15555550101' }) === 'ACCEPTED', 'form without the text tick accepted');
  const ada = await formLead('ada@example.test');
  let rows = await consents(ada.primary_person_id);
  ok(rows.length === 1 && rows[0].channel === 'EMAIL' && rows[0].status === 'OPTED_IN' && rows[0].source === 'RECIPIENT' && rows[0].version === 1, 'form: email agreed, no text without the tick');
  const cap = rows[0].captures;
  ok(cap.length === 1 && cap[0].method === 'LEAD_FORM' && cap[0].actor === FORM_SVC && cap[0].evidence.formId === ids.form && cap[0].evidence.formVersion === 1
    && cap[0].evidence.leadId === ada.id && cap[0].evidence.wording === 'IC1-2026-11-19', 'form evidence: method, form id and version, lead, wording version, intake principal');
  ok(!JSON.stringify(cap).includes('example.test') && !JSON.stringify(cap).includes('5555'), 'evidence holds no contact value');
  ok(await submit({ name: 'Bea', email: 'bea@example.test', mobile: '+15555550102', textOptIn: true }) === 'ACCEPTED', 'form with the text tick accepted');
  const bea = await formLead('bea@example.test');
  rows = await consents(bea.primary_person_id);
  ok(rows.map((r) => `${r.channel}:${r.status}`).join() === 'EMAIL:OPTED_IN,SMS:OPTED_IN' && rows[1].captures[0].evidence.textOptIn === true && rows[1].captures[0].method === 'LEAD_FORM', 'form tick: text agreed with the tick as evidence');
  ok((await sql("SELECT attribution->'optionalAnswers'->'textOptIn' t FROM hon.crm_leads WHERE id=$1", [bea.id])).rows[0].t === true, 'the tick is kept on the lead answers');
  ok(await submit({ name: 'Cy', email: 'cy@example.test', textOptIn: true }) === 'ACCEPTED', 'tick without a mobile accepted');
  const cy = await formLead('cy@example.test');
  ok((await consents(cy.primary_person_id)).map((r) => r.channel).join() === 'EMAIL'
    && (await sql("SELECT attribution->'optionalAnswers' ? 'textOptIn' t FROM hon.crm_leads WHERE id=$1", [cy.id])).rows[0].t === false, 'a tick without a mobile is dropped and records no text');
  ok(await submit({ name: 'Dee', mobile: '+15555550103' }) === 'ACCEPTED', 'mobile-only form accepted');
  const dee = (await sql("SELECT l.primary_person_id FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id WHERE l.organization_id=$1 AND p.phone_e164='+15555550103'", [ids.org])).rows[0];
  ok((await consents(dee.primary_person_id)).length === 0, 'no email address, no email consent; no tick, no text');
  for (const bad of [{ textOptIn: 'yes' }, { textOptIn: 1 }, { textOptIn: null }]) {
    ok(await submit({ name: 'Bad', email: 'bad@example.test', ...bad }) === 'INVALID', `textOptIn must be a boolean (${JSON.stringify(bad.textOptIn)})`);
  }
  const replayKey = `key-${randomUUID()}`;
  ok(await submit({ name: 'Eve', email: 'eve@example.test', mobile: '+15555550104', textOptIn: true }, replayKey) === 'ACCEPTED', 'Eve accepted');
  ok(await submit({ name: 'Eve', email: 'eve@example.test', mobile: '+15555550104', textOptIn: true }, replayKey) === 'ACCEPTED', 'Eve exact retry accepted');
  const eve = await formLead('eve@example.test');
  ok((await sql('SELECT count(*)::int n FROM hon.communication_consent_captures k JOIN hon.communication_consents c ON c.id=k.consent_id WHERE c.person_id=$1', [eve.primary_person_id])).rows[0].n === 2, 'a retry records nothing twice');
  ok((await runtime.query('SELECT hon.read_published_form($1) f', [formPublicId])).rows[0].f.schoolName === 'IC1 Dojo a', 'the published form names its school for the wording');

  // 2. An opt-out on another record with the same address wins over automatic capture.
  await sql("SELECT hon.communication_record_recipient_opt_out($1,$2,$3,'SMS',clock_timestamp())", [ids.org, ids.schoolA, bea.primary_person_id]);
  await sql("SELECT hon.communication_record_recipient_opt_out($1,$2,$3,'EMAIL',clock_timestamp())", [ids.org, ids.schoolA, bea.primary_person_id]);
  rows = await consents(bea.primary_person_id);
  ok(rows.every((r) => r.status === 'OPTED_OUT' && r.source === 'RECIPIENT' && r.version === 2) && rows.every((r) => r.captures.length === 1 && r.captures[0].status === 'OPTED_IN'), 'STOP and unsubscribe still flip an automatic agreement; the capture stays as history');
  ok(await submit({ name: 'Bea Again', email: 'BEA@example.test', mobile: '+15555550102', textOptIn: true }) === 'ACCEPTED', 'Bea submits again');
  const bea2 = (await sql("SELECT l.id, l.primary_person_id FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id WHERE l.organization_id=$1 AND p.given_name='Bea Again'", [ids.org])).rows[0];
  rows = await consents(bea2.primary_person_id);
  const beaRows = Object.fromEntries((await sql('SELECT channel::text, id FROM hon.communication_consents WHERE person_id=$1', [bea.primary_person_id])).rows.map((r) => [r.channel, r.id]));
  ok(rows.length === 2 && rows.every((r) => r.status === 'OPTED_OUT' && r.source === 'RECIPIENT' && r.captures[0].method === 'PRIOR_OPT_OUT' && r.captures[0].evidence.intakeMethod === 'LEAD_FORM')
    && rows[0].captures[0].evidence.priorConsentId === beaRows.EMAIL && rows[1].captures[0].evidence.priorConsentId === beaRows.SMS, 'a new record for an opted-out email and phone starts opted out (prior opt-out wins, case-insensitive email)');
  ok((await sql("SELECT count(*)::int n FROM hon.communication_consents c JOIN hon.people p ON p.id=c.person_id WHERE c.organization_id=$1 AND p.phone_e164='+15555550102' AND c.status='OPTED_IN'", [ids.org])).rows[0].n === 0, 'nobody with that phone is opted in');
  // The same phone at another school is a different relationship: it is not suppressed there.
  const crossSchool = await asStaff(B_STAFF, async (c) => {
    const p = (await c.query("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,phone_e164) VALUES($1,$2,'Bea','B','+15555550102') RETURNING id", [ids.org, ids.schoolB])).rows[0].id;
    return { p, r: (await c.query('SELECT hon.record_staff_intake_consent($1,$2::jsonb) r', [B_STAFF.subject, JSON.stringify({ method: 'STAFF_ADD', channels: ['SMS'], personId: p })])).rows[0].r };
  });
  ok(crossSchool.r.recorded === 1 && (await consents(crossSchool.p))[0].status === 'OPTED_IN', 'an opt-out at school A does not suppress school B');

  // 3. Zernio (Facebook/Instagram): email automatic, never text.
  const z = (await sql("SELECT * FROM hon.record_zernio_lead($1,$2,'ic1acct',$3,$4::jsonb,'{}'::jsonb)", [`evt_${randomUUID().replace(/-/g, '')}`, '777001', `f${ids.zForm.slice(0, 8)}`,
    JSON.stringify({ full_name: 'Fay Facebook', email: 'fay@example.test', phone_number: '+15555550105' })])).rows[0];
  ok(z.outcome === 'CREATED', 'Zernio lead created');
  rows = await consents(await leadPerson(z.lead_id));
  ok(rows.length === 1 && rows[0].channel === 'EMAIL' && rows[0].status === 'OPTED_IN' && rows[0].captures[0].method === 'FACEBOOK_LEAD_FORM' && rows[0].captures[0].actor === ZERNIO_SVC
    && rows[0].captures[0].evidence.formMappingId === ids.zForm, 'Zernio lead: email agreed with the mapping as evidence, no text');

  // 4. An intake source code without that path's evidence records nothing; plain inserts record nothing.
  for (const source of ['PUBLIC_API', 'ZERNIO_META', 'WALK_IN_KIOSK', 'CONVERSATION_SMS', 'WEBSITE']) {
    let person = null, refusal = null;
    try {
      person = await asStaff(MANAGER, async (c) => {
        const p = (await c.query("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,'Forged','Source',$3,'+15555550199') RETURNING id", [ids.org, ids.schoolA, `forged-${source.toLowerCase()}@example.test`])).rows[0].id;
        await c.query('INSERT INTO hon.crm_leads(organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,source_code,attribution) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
          [ids.org, ids.schoolA, p, ids.pipeA, ids.stageA, source, JSON.stringify({ optionalAnswers: { textOptIn: true }, publicForm: { id: ids.form, version: 1 } })]);
        return p;
      });
    } catch (error) { refusal = error.message; }
    if (person) ok((await consents(person)).length === 0, `a staff lead naming source ${source} without intake evidence records nothing`);
    else ok((await sql("SELECT count(*)::int n FROM hon.people WHERE organization_id=$1 AND email=$2", [ids.org, `forged-${source.toLowerCase()}@example.test`])).rows[0].n === 0, `a staff lead naming source ${source} is refused by its provenance guard (${refusal}), nothing kept`);
  }
  const plain = (await sql("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email) VALUES($1,$2,'Plain','Insert','plain@example.test') RETURNING id", [ids.org, ids.schoolA])).rows[0].id;
  ok((await consents(plain)).length === 0, 'a person created outside intake (registration, demo data) records nothing');

  // 5. Staff add: what staff left ticked, only for a person created in this transaction of this school.
  const staffAdd = async (who, channels, { email = `${randomUUID().slice(0, 8)}@example.test`, phone = null, personId, subject } = {}) => asStaff(who, async (c) => {
    const p = personId ?? (await c.query("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,'Added','Person',$3,$4) RETURNING id", [who.org, who.school, email, phone])).rows[0].id;
    const r = (await c.query('SELECT hon.record_staff_intake_consent($1,$2::jsonb) r', [subject ?? who.subject, JSON.stringify({ method: 'STAFF_ADD', channels, personId: p })])).rows[0].r;
    return { p, r };
  });
  let added = await staffAdd(MANAGER, ['EMAIL', 'SMS'], { phone: '+15555550110' });
  rows = await consents(added.p);
  ok(added.r.people === 1 && added.r.recorded === 2 && rows.every((r) => r.status === 'OPTED_IN' && r.source === 'STAFF' && r.captures[0].method === 'STAFF_ADD' && r.captures[0].actor === MANAGER.principal && !('wording' in (r.captures[0].evidence ?? {}))), 'staff add: both agreed by default, source STAFF, the staff member as actor');
  added = await staffAdd(PEOPLE_ONLY, ['EMAIL'], { phone: '+15555550111' });
  ok((await consents(added.p)).map((r) => r.channel).join() === 'EMAIL', 'staff unticked text: only email recorded (people.create is enough)');
  added = await staffAdd(MANAGER, [], { phone: '+15555550112' });
  ok(added.r.recorded === 0 && (await consents(added.p)).length === 0, 'both unticked: nothing recorded');
  const existingPerson = plain;
  added = await staffAdd(MANAGER, ['EMAIL'], { personId: existingPerson });
  ok(added.r.people === 0 && (await consents(existingPerson)).length === 0, 'an existing person (not created in this transaction) is never touched');
  const otherSchoolPerson = (await sql("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email) VALUES($1,$2,'Other','School','os@example.test') RETURNING id", [ids.org, ids.schoolB])).rows[0].id;
  added = await staffAdd(MANAGER, ['EMAIL'], { personId: otherSchoolPerson });
  ok(added.r.people === 0 && (await consents(otherSchoolPerson)).length === 0, 'another school\'s person is never touched');
  // Never overwrite: an opt-out written earlier in the same transaction stays.
  const kept = await asStaff(MANAGER, async (c) => {
    const p = (await c.query("INSERT INTO hon.people(organization_id,school_id,given_name,family_name,email) VALUES($1,$2,'Said','No','no@example.test') RETURNING id", [ids.org, ids.schoolA])).rows[0].id;
    await c.query("INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,'EMAIL','OPTED_OUT','STAFF',now(),$4)", [ids.org, ids.schoolA, p, MANAGER.principal]);
    await c.query('SELECT hon.record_staff_intake_consent($1,$2::jsonb)', [MANAGER.subject, JSON.stringify({ method: 'STAFF_ADD', channels: ['EMAIL'], personId: p })]);
    return p;
  });
  rows = await consents(kept);
  ok(rows.length === 1 && rows[0].status === 'OPTED_OUT' && rows[0].version === 1 && rows[0].captures === null, 'an existing opt-out is never overwritten');
  // Authority and input.
  await refusedCode(staffAdd(READER, ['EMAIL']), '42501', 'a reader cannot record intake consent');
  await refusedCode(staffAdd(PARENTISH, ['EMAIL']), '42501', 'a family-type role cannot record intake consent');
  await refusedCode(staffAdd(MANAGER, ['EMAIL'], { subject: READER.subject }), '42501', 'another subject than the session is refused');
  for (const bad of [{ method: 'STAFF_ADD', channels: ['EMAIL', 'EMAIL'] }, { method: 'STAFF_ADD', channels: ['PUSH'] }, { method: 'LEAD_FORM', channels: ['EMAIL'] },
    { method: 'STAFF_ADD', channels: ['EMAIL'], batchId: randomUUID() }, { method: 'STAFF_ADD', channels: 'EMAIL' }]) {
    await refusedCode(asStaff(MANAGER, async (c) => c.query('SELECT hon.record_staff_intake_consent($1,$2::jsonb)', [MANAGER.subject, JSON.stringify({ personId: randomUUID(), ...bad })])), '22023', `bad input refused: ${JSON.stringify(bad)}`);
  }
  await refusedCode(runtime.query('SELECT hon.record_staff_intake_consent($1,$2::jsonb)', [MANAGER.subject, JSON.stringify({ method: 'STAFF_ADD', channels: ['EMAIL'], personId: randomUUID() })]), '42501', 'no tenant session, refused');

  // 6. Import paths take a batch: only that batch's people created in this transaction.
  added = await asStaff(MANAGER, async (c) => c.query('SELECT hon.record_staff_intake_consent($1,$2::jsonb) r', [MANAGER.subject, JSON.stringify({ method: 'LEAD_IMPORT', channels: ['EMAIL'], batchId: randomUUID() })]).then((r) => r.rows[0].r));
  ok(added.people === 0 && added.recorded === 0, 'an unknown batch records nothing');
  await refusedCode(asStaff(PEOPLE_ONLY, async (c) => c.query('SELECT hon.record_staff_intake_consent($1,$2::jsonb)', [PEOPLE_ONLY.subject, JSON.stringify({ method: 'STUDENT_IMPORT', channels: ['EMAIL'], batchId: randomUUID() })])), '42501', 'student import needs students.import');

  // 7. Audit and outbox: one each per recorded channel, identifiers only.
  const audit = (await sql("SELECT next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code='communication.consent.intake_recorded'", [ids.org])).rows;
  const outbox = (await sql(`SELECT o.payload FROM hon.outbox_events o JOIN hon.communication_consent_captures k ON k.consent_id=o.aggregate_id AND k.consent_version=o.aggregate_version
    WHERE o.organization_id=$1 AND o.event_type='communication.consent.recorded'`, [ids.org])).rows;
  const captures = (await sql('SELECT count(*)::int n FROM hon.communication_consent_captures WHERE organization_id=$1', [ids.org])).rows[0].n;
  ok(audit.length === captures && outbox.length === captures, `one audit row per automatic record (${audit.length}/${captures})`);
  ok(!JSON.stringify(audit).includes('@') && !JSON.stringify(outbox).includes('@') && !JSON.stringify(audit).includes('+1555'), 'audit and outbox hold no contact value');
  ok((await sql("SELECT count(*)::int n FROM hon.communication_messages WHERE organization_id=$1", [ids.org])).rows[0].n === 0, 'recording consent sends nothing');

  // 8. ACL and isolation.
  for (const f of ['hon.record_intake_consent(uuid,text,text,jsonb,uuid,boolean)', 'hon.intake_consent_after_lead()']) {
    ok((await sql(`SELECT has_function_privilege($1,$2::regprocedure,'EXECUTE') x`, [CRM_CLOSE_RUNTIME_ROLE, f])).rows[0].x === false, `runtime cannot execute ${f}`);
  }
  ok((await sql("SELECT has_function_privilege($1,'hon.record_staff_intake_consent(text,jsonb)'::regprocedure,'EXECUTE') x", [CRM_CLOSE_RUNTIME_ROLE])).rows[0].x === true, 'runtime executes the staff entry point');
  ok((await sql("SELECT has_table_privilege($1,'hon.communication_consent_captures','SELECT') s, has_table_privilege($1,'hon.communication_consent_captures','INSERT,UPDATE,DELETE') w", [CRM_CLOSE_RUNTIME_ROLE])).rows
    .every((r) => r.s === true && r.w === false), 'runtime reads evidence and cannot write it');
  ok((await sql("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid='hon.communication_consent_captures'::regclass")).rows.every((r) => r.r && r.f), 'forced RLS on the evidence');
  ok((await runtime.query('SELECT count(*)::int n FROM hon.communication_consent_captures')).rows[0].n === 0, 'no tenant context: no evidence visible');
  const visible = await asStaff(B_STAFF, async (c) => (await c.query('SELECT count(*)::int n FROM hon.communication_consent_captures')).rows[0].n, { commit: false });
  ok(visible === 1, 'school B staff see only school B evidence');
  ok((await sql("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='hon.crm_leads'::regclass AND tgname='crm_leads_intake_consent' AND tgdeferrable AND tginitdeferred")).rows[0].n === 1, 'the lead trigger is deferred to commit');

  console.log(`PASS: intake contact consent (0634): ${checks} checks.`);
} finally {
  try { await cleanup(); } finally { await admin.end(); await runtime.end(); }
}
