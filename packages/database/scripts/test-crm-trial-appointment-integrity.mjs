import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for CRM trial appointment integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for CRM trial appointment integrity tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { TrialAppointmentController } = await import('../../../apps/api/dist/crm/trial-appointment.controller.js');
const { TrialAppointmentService } = await import('../../../apps/api/dist/crm/trial-appointment.service.js');
const { TrialAppointmentOutcomeController } = await import('../../../apps/api/dist/crm/trial-appointment-outcome.controller.js');
const { TrialAppointmentOutcomeService } = await import('../../../apps/api/dist/crm/trial-appointment-outcome.service.js');
const { TrialAppointmentReadController } = await import('../../../apps/api/dist/crm/trial-appointment-read.controller.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries(
  [
    'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole',
    'personA', 'personB', 'pipelineA', 'pipelineB', 'stageA', 'stageB', 'leadA', 'leadB',
    'personA2', 'personA3', 'leadA2', 'leadA3',
    'foreignAppointment', 'localScheduledAppointment', 'localConsultationAppointment', 'pastScheduledAppointment',
  ].map((key) => [key, randomUUID()]),
);
const externalSubject = `crm-trial-appointment-${randomUUID()}`;
const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const runtime = new Client(connectionOptions(process.env.HON_RUNTIME_DATABASE_URL));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function responseCapture() {
  return {
    statusCode: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
  };
}

function inputFor(startsAt, endsAt, overrides = {}) {
  return {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    location: 'Studio A',
    notes: 'First visit; parent will attend.',
    ...overrides,
  };
}

function outcomeFor(status, expectedVersion, overrides = {}) {
  return {
    status,
    expectedVersion,
    ...overrides,
  };
}

async function expectStatus(expectedStatus, operation, message) {
  try {
    await operation();
    throw new Error(message);
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
    if (typeof error?.getStatus !== 'function' || error.getStatus() !== expectedStatus) throw error;
  }
}

async function expectDatabaseError(expectedCode, operation, message) {
  try {
    await operation();
    throw new Error(message);
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
    if (error?.code !== expectedCode) throw error;
  }
}

async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.outbox_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.idempotency_records WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_appointments WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.principal_role_grants WHERE principal_id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.roles WHERE id = $1', [ids.ownerRole]);
    // Campaign attribution evidence is immutable by trigger; disposable-fixture cleanup only (transactional).
    await administrator.query('ALTER TABLE hon.crm_lead_attributions DISABLE TRIGGER USER');
    await administrator.query('DELETE FROM hon.crm_lead_attributions WHERE organization_id = $1', [ids.organization]);
    await administrator.query('ALTER TABLE hon.crm_lead_attributions ENABLE TRIGGER USER');
    await administrator.query('DELETE FROM hon.crm_leads WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_pipeline_stages WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.crm_pipelines WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.users WHERE id = $1', [ids.user]);
    await administrator.query('DELETE FROM hon.people WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.schools WHERE id IN ($1, $2)', [ids.schoolA, ids.schoolB]);
    await administrator.query('DELETE FROM hon.organizations WHERE id = $1', [ids.organization]);
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }
}

await administrator.connect();
await runtime.connect();
const database = new RuntimeDatabaseService();
const service = new TrialAppointmentService(database);
const controller = new TrialAppointmentController(database, service);
const outcomeService = new TrialAppointmentOutcomeService(database);
const outcomeController = new TrialAppointmentOutcomeController(database, outcomeService);
const readController = new TrialAppointmentReadController(database, service);

async function expectConflictCode(expectedCode, operation, message) {
  try {
    await operation();
    throw new Error(message);
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
    if (typeof error?.getStatus !== 'function' || error.getStatus() !== 409) throw error;
    const body = error.getResponse();
    if (body?.code !== expectedCode) throw new Error(`${message} (code ${body?.code})`);
    return body;
  }
}

try {
  const permissions = await administrator.query(
    "SELECT code FROM hon.permissions WHERE code IN ('crm.trial.schedule', 'crm.trial.manage') ORDER BY code",
  );
  assert(permissions.rowCount === 2, 'CRM trial schedule/manage permission migrations were not applied.');

  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = 'hon.crm_appointments'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'crm_appointments must enable and force row-level security.');

  const grants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.crm_appointments', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.crm_appointments', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.crm_appointments', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.crm_appointments', 'DELETE') AS can_delete,
      has_type_privilege(current_user, 'hon.crm_appointment_type', 'USAGE') AS type_usage,
      has_type_privilege(current_user, 'hon.crm_appointment_status', 'USAGE') AS status_usage
  `)).rows[0];
  assert(grants?.can_select && grants?.can_insert && grants?.can_update && !grants?.can_delete,
    'hon_runtime CRM appointment grants are not the exact SELECT/INSERT/UPDATE and no-DELETE minimum.');
  assert(grants?.type_usage && grants?.status_usage,
    'hon_runtime lacks explicit CRM appointment enum usage grants.');

  const now = Date.now();
  const startsAt = new Date(now + 3 * 24 * 60 * 60 * 1000);
  const endsAt = new Date(now + 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'CRM Trial Appointment Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'CRM Trial School A', $3),
       ($4, $2, 'CRM Trial School B', $5)`,
      [
        ids.schoolA, ids.organization, `crm-trial-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `crm-trial-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `crm-trial-${ids.user}@example.test`, 'CRM Trial Scheduler'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'CRM Trial Scheduler')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
       VALUES
         ($1, $2, 'crm.trial.schedule'),
         ($1, $2, 'crm.trial.manage')`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.principal_role_grants (
         organization_id, school_id, principal_id, role_id, granted_by_principal_id
       ) VALUES ($1, $2, $3, $4, $3)`,
      [ids.organization, ids.schoolA, ids.principal, ids.ownerRole],
    );
    await administrator.query(
      `INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name) VALUES
       ($1, $2, $3, 'Avery', 'Local'),
       ($4, $2, $5, 'Bailey', 'Foreign'),
       ($6, $2, $3, 'Casey', 'Local'),
       ($7, $2, $3, 'Devon', 'Local')`,
      [ids.personA, ids.organization, ids.schoolA, ids.personB, ids.schoolB, ids.personA2, ids.personA3],
    );
    await administrator.query(
      `INSERT INTO hon.crm_pipelines (id, organization_id, school_id, name) VALUES
       ($1, $2, $3, 'Local Pipeline'),
       ($4, $2, $5, 'Foreign Pipeline')`,
      [ids.pipelineA, ids.organization, ids.schoolA, ids.pipelineB, ids.schoolB],
    );
    await administrator.query(
      `INSERT INTO hon.crm_pipeline_stages (
         id, organization_id, school_id, pipeline_id, name, position
       ) VALUES
       ($1, $2, $3, $4, 'New', 1),
       ($5, $2, $6, $7, 'New', 1)`,
      [ids.stageA, ids.organization, ids.schoolA, ids.pipelineA, ids.stageB, ids.schoolB, ids.pipelineB],
    );
    await administrator.query(
      `INSERT INTO hon.crm_leads (
         id, organization_id, school_id, primary_person_id, pipeline_id, pipeline_stage_id, status
       ) VALUES
       ($1, $2, $3, $4, $5, $6, 'OPEN'),
       ($7, $2, $8, $9, $10, $11, 'OPEN'),
       ($12, $2, $3, $13, $5, $6, 'OPEN'),
       ($14, $2, $3, $15, $5, $6, 'OPEN')`,
      [
        ids.leadA, ids.organization, ids.schoolA, ids.personA, ids.pipelineA, ids.stageA,
        ids.leadB, ids.schoolB, ids.personB, ids.pipelineB, ids.stageB,
        ids.leadA2, ids.personA2, ids.leadA3, ids.personA3,
      ],
    );
    await administrator.query(
      `INSERT INTO hon.crm_appointments (
         id, organization_id, school_id, crm_lead_id, appointment_type, status,
         starts_at, ends_at, created_by_principal_id
       ) VALUES (
         $1, $2, $3, $4, 'CONSULTATION', 'SCHEDULED', $5, $6, $7
       )`,
      [ids.foreignAppointment, ids.organization, ids.schoolB, ids.leadB, startsAt.toISOString(), endsAt.toISOString(), ids.principal],
    );
    await administrator.query(
      `INSERT INTO hon.crm_appointments (
         id, organization_id, school_id, crm_lead_id, appointment_type, status,
         starts_at, ends_at, location, notes, created_by_principal_id
       ) VALUES (
         $1, $2, $3, $4, 'TRIAL', 'SCHEDULED', $5, $6, 'Studio A', 'Unchanged schedule note', $7
      )`,
      [ids.localScheduledAppointment, ids.organization, ids.schoolA, ids.leadA2, startsAt.toISOString(), endsAt.toISOString(), ids.principal],
    );
    // A SCHEDULED trial whose time already passed (outcome never recorded) must not block a new trial.
    await administrator.query(
      `INSERT INTO hon.crm_appointments (
         id, organization_id, school_id, crm_lead_id, appointment_type, status,
         starts_at, ends_at, created_by_principal_id
       ) VALUES (
         $1, $2, $3, $4, 'TRIAL', 'SCHEDULED', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', $5
       )`,
      [ids.pastScheduledAppointment, ids.organization, ids.schoolA, ids.leadA3, ids.principal],
    );
    await administrator.query(
      `INSERT INTO hon.crm_appointments (
         id, organization_id, school_id, crm_lead_id, appointment_type, status,
         starts_at, ends_at, created_by_principal_id
       ) VALUES (
         $1, $2, $3, $4, 'CONSULTATION', 'SCHEDULED', $5, $6, $7
       )`,
      [ids.localConsultationAppointment, ids.organization, ids.schoolA, ids.leadA, startsAt.toISOString(), endsAt.toISOString(), ids.principal],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const firstKey = `crm-trial-${randomUUID()}`;
  const firstResponse = responseCapture();
  const first = await controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, firstKey, inputFor(startsAt, endsAt), request, firstResponse,
  );
  assert(firstResponse.statusCode === 201 && !first.meta.replayed,
    'The first CRM trial appointment was not created with HTTP 201.');
  assert(first.data.crmLeadId === ids.leadA && first.data.appointmentType === 'TRIAL'
    && first.data.status === 'SCHEDULED' && first.data.createdByPrincipalId === ids.principal,
  'The endpoint did not create only a scheduled TRIAL appointment attributed to the authenticated principal.');
  assert(first.data.location === 'Studio A' && first.data.notes === 'First visit; parent will attend.',
    'Trial appointment scheduling did not retain normalized location and notes.');

  const replayResponse = responseCapture();
  const replay = await controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, firstKey, inputFor(startsAt, endsAt), request, replayResponse,
  );
  assert(replayResponse.statusCode === 200 && replay.meta.replayed && replay.data.id === first.data.id,
    'A matching trial scheduling idempotency request did not replay its original response.');

  // P1-1: a lost tab/session retrying with a NEW key cannot create a second active trial for the same lead.
  const secondKey = `crm-trial-second-${randomUUID()}`;
  const laterStart = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);
  const laterEnd = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
  const duplicate = await expectConflictCode('TRIAL_ALREADY_SCHEDULED', () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, secondKey, inputFor(laterStart, laterEnd), request, responseCapture(),
  ), 'A new idempotency key created a second active trial for the same lead.');
  assert(duplicate.existingAppointment?.id === first.data.id && duplicate.existingAppointment?.status === 'SCHEDULED',
    'The active-trial refusal did not return the existing appointment for reconciliation.');
  const fixtureDuplicate = await expectConflictCode('TRIAL_ALREADY_SCHEDULED', () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA2, `crm-trial-a2-${randomUUID()}`, inputFor(laterStart, laterEnd), request, responseCapture(),
  ), 'A lead with an existing scheduled trial accepted another.');
  assert(fixtureDuplicate.existingAppointment?.id === ids.localScheduledAppointment, 'The refusal named the wrong existing trial.');
  // Preserved pre-upgrade history: the active trial is OLDER than the newest 50 rows (51 later-created trials that
  // were cancelled). The read must still name it, exactly as the scheduling guard does, while the history stays bounded.
  await administrator.query(
    `INSERT INTO hon.crm_appointments (id, organization_id, school_id, crm_lead_id, appointment_type, status, starts_at, ends_at,
       created_by_principal_id, created_at, updated_at)
     SELECT gen_random_uuid(), $1, $2, $3, 'TRIAL', 'CANCELLED', now() + (g || ' days')::interval, now() + (g || ' days')::interval + interval '1 hour',
       $4, clock_timestamp() + (g || ' seconds')::interval, clock_timestamp() + (g || ' seconds')::interval
     FROM generate_series(1, 51) g`,
    [ids.organization, ids.schoolA, ids.leadA2, ids.principal],
  );
  const upgraded = await controller.listForLead(ids.organization, ids.schoolA, ids.leadA2, request);
  assert(upgraded.data.activeTrial?.id === ids.localScheduledAppointment,
    'The reconciliation read lost an active trial that sits outside the newest 50 history rows.');
  assert(upgraded.data.trials.length === 50 && !upgraded.data.trials.some((t) => t.id === ids.localScheduledAppointment)
    && upgraded.data.trials.every((t) => t.status === 'CANCELLED'), 'The bounded trial history window changed.');
  const upgradedRefusal = await expectConflictCode('TRIAL_ALREADY_SCHEDULED', () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA2, `crm-trial-a2-upgrade-${randomUUID()}`, inputFor(laterStart, laterEnd), request, responseCapture(),
  ), 'An upgraded history with an older active trial accepted another.');
  assert(upgradedRefusal.existingAppointment?.id === upgraded.data.activeTrial.id, 'The read and the scheduling guard named different active trials.');

  // Unknown-result reconciliation: the exact school's direct-human read finds the committed trial.
  const reconciled = await controller.listForLead(ids.organization, ids.schoolA, ids.leadA, request);
  assert(reconciled.data.activeTrial?.id === first.data.id
    && reconciled.data.trials.length === 1 && reconciled.data.trials[0].id === first.data.id,
  'The reconciliation read did not return exactly the committed trial as active.');
  const detail = await readController.read(ids.organization, ids.schoolA, first.data.id, request);
  assert(detail.data.id === first.data.id && detail.data.version === first.data.version, 'The trial detail read did not return the committed trial.');
  await expectStatus(404, () => readController.read(ids.organization, ids.schoolA, ids.foreignAppointment, request),
    'The trial detail read exposed another school\'s appointment.');
  await expectStatus(404, () => readController.read(ids.organization, ids.schoolA, ids.localConsultationAppointment, request),
    'The trial detail read returned a non-trial appointment.');
  await expectStatus(404, () => controller.listForLead(ids.organization, ids.schoolA, ids.leadB, request),
    'The reconciliation read exposed another school\'s lead.');
  await expectStatus(403, () => controller.listForLead(randomUUID(), ids.schoolA, ids.leadA, request),
    'The reconciliation read accepted an organization route outside its resolved scope.');

  // Exact-key replay is recognised before the clock rule: after the trial's start has passed, the same key
  // still returns the original receipt, while a new key with the same input is refused as past.
  const realNow = Date.now;
  Date.now = () => realNow() + 4 * 24 * 60 * 60 * 1000;
  try {
    const lateReplayResponse = responseCapture();
    const lateReplay = await controller.schedule(
      ids.organization, ids.schoolA, ids.leadA, firstKey, inputFor(startsAt, endsAt), request, lateReplayResponse,
    );
    assert(lateReplayResponse.statusCode === 200 && lateReplay.meta.replayed && lateReplay.data.id === first.data.id,
      'A post-start exact-key replay was refused by time validation instead of returning its receipt.');
    await expectStatus(400, () => controller.schedule(
      ids.organization, ids.schoolA, ids.leadA, `crm-trial-late-${randomUUID()}`, inputFor(startsAt, endsAt), request, responseCapture(),
    ), 'A new key scheduled a trial whose start has passed.');
  } finally {
    Date.now = realNow;
  }

  // Concurrent new keys on one lead (two tabs): exactly one trial is created. A past, never-closed
  // SCHEDULED trial on that lead does not block.
  // Deterministic interleaving: a blocker holds appointment inserts so both commands are in flight together.
  // Without the per-lead serialization both would pass the active-trial check and wait at the insert.
  const blocker = new Client(connectionOptions(process.env.DATABASE_URL));
  await blocker.connect();
  let raced;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE hon.crm_appointments IN SHARE ROW EXCLUSIVE MODE');
    const racing = Promise.allSettled([0, 1].map((n) => controller.schedule(
      ids.organization, ids.schoolA, ids.leadA3, `crm-trial-race-${n}-${randomUUID()}`, inputFor(startsAt, endsAt), request, responseCapture(),
    )));
    const deadline = Date.now() + 20000;
    for (;;) {
      const waiting = await administrator.query(
        "SELECT count(DISTINCT pid)::integer AS n FROM pg_locks WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
      );
      if (waiting.rows[0].n >= 2) break;
      if (Date.now() > deadline) throw new Error('The two concurrent trial commands never reached a lock wait together.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await blocker.query('COMMIT');
    raced = await racing;
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    await blocker.end();
  }
  const racedCreated = raced.filter((r) => r.status === 'fulfilled');
  const racedRefused = raced.filter((r) => r.status === 'rejected' && r.reason?.getResponse?.()?.code === 'TRIAL_ALREADY_SCHEDULED');
  assert(racedCreated.length === 1 && racedRefused.length === 1
    && racedRefused[0].reason.getResponse().existingAppointment?.id === racedCreated[0].value.data.id,
  `Concurrent trial scheduling on one lead did not create exactly one trial: ${JSON.stringify(raced.map((r) => r.status))}`);

  const outcomeKey = `crm-trial-outcome-${randomUUID()}`;
  const outcomeInput = outcomeFor('COMPLETED', first.data.version, { outcomeNotes: '  Trial completed successfully.  ' });
  const outcomeResponse = responseCapture();
  const outcome = await outcomeController.record(
    ids.organization, ids.schoolA, first.data.id, outcomeKey, outcomeInput, request, outcomeResponse,
  );
  assert(outcomeResponse.statusCode === 200 && !outcome.meta.replayed,
    'The first CRM trial outcome was not recorded with HTTP 200.');
  assert(outcome.data.id === first.data.id && outcome.data.crmLeadId === ids.leadA
    && outcome.data.appointmentType === 'TRIAL' && outcome.data.status === 'COMPLETED'
    && outcome.data.version === first.data.version + 1
    && outcome.data.notes === 'First visit; parent will attend.'
    && outcome.data.updatedAt !== first.data.updatedAt,
  'Trial outcome recording did not atomically preserve appointment identity/type/schedule notes while advancing outcome version and timestamp.');

  const outcomeReplayResponse = responseCapture();
  const outcomeReplay = await outcomeController.record(
    ids.organization, ids.schoolA, first.data.id, outcomeKey, outcomeInput, request, outcomeReplayResponse,
  );
  assert(outcomeReplayResponse.statusCode === 200 && outcomeReplay.meta.replayed
    && outcomeReplay.data.id === outcome.data.id && outcomeReplay.data.version === outcome.data.version,
  'A matching trial outcome idempotency request did not replay its original response.');
  await expectStatus(409, () => outcomeController.record(
    ids.organization, ids.schoolA, first.data.id, outcomeKey,
    outcomeFor('COMPLETED', first.data.version, { outcomeNotes: 'Different evidence' }), request, responseCapture(),
  ), 'A reused trial outcome idempotency key accepted a different command.');
  await expectStatus(409, () => outcomeController.record(
    ids.organization, ids.schoolA, ids.localScheduledAppointment, `outcome-stale-${randomUUID()}`,
    outcomeFor('NO_SHOW', 2), request, responseCapture(),
  ), 'A stale trial outcome expectedVersion was accepted.');
  await expectStatus(409, () => outcomeController.record(
    ids.organization, ids.schoolA, first.data.id, `outcome-terminal-${randomUUID()}`,
    outcomeFor('NO_SHOW', outcome.data.version), request, responseCapture(),
  ), 'A terminal CRM appointment accepted another trial outcome.');
  // Once the trial has an outcome, a new trial may be scheduled; the key refused earlier was released by rollback.
  const afterOutcomeResponse = responseCapture();
  const afterOutcome = await controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, secondKey, inputFor(laterStart, laterEnd), request, afterOutcomeResponse,
  );
  assert(afterOutcomeResponse.statusCode === 201 && !afterOutcome.meta.replayed && afterOutcome.data.id !== first.data.id,
    'A new trial could not be scheduled after the previous trial outcome was recorded.');
  await expectStatus(409, () => outcomeController.record(
    ids.organization, ids.schoolA, ids.localConsultationAppointment, `outcome-consultation-${randomUUID()}`,
    outcomeFor('COMPLETED', 1), request, responseCapture(),
  ), 'A same-school consultation accepted a trial-only outcome command.');
  await expectStatus(404, () => outcomeController.record(
    ids.organization, ids.schoolA, ids.foreignAppointment, `outcome-foreign-${randomUUID()}`,
    outcomeFor('CANCELLED', 1), request, responseCapture(),
  ), 'RLS-scoped trial outcome lookup exposed an appointment from another school.');
  await expectStatus(400, () => outcomeService.record({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `outcome-invalid-status-${randomUUID()}`,
    source: 'HUMAN_UI',
  }, ids.localScheduledAppointment, outcomeFor('SCHEDULED', 1)), 'An invalid trial outcome status was accepted.');
  await expectStatus(400, () => outcomeService.record({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `outcome-blank-note-${randomUUID()}`,
    source: 'HUMAN_UI',
  }, ids.localScheduledAppointment, outcomeFor('CANCELLED', 1, { outcomeNotes: '   ' })), 'A blank trial outcome note was accepted.');
  await expectStatus(400, () => outcomeService.record({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `outcome-long-note-${randomUUID()}`,
    source: 'HUMAN_UI',
  }, ids.localScheduledAppointment, outcomeFor('CANCELLED', 1, { outcomeNotes: 'x'.repeat(2001) })), 'An oversized trial outcome note was accepted.');
  await expectStatus(400, () => outcomeService.record({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `outcome-version-${randomUUID()}`,
    source: 'HUMAN_UI',
  }, ids.localScheduledAppointment, outcomeFor('CANCELLED', 0)), 'A non-positive trial outcome expectedVersion was accepted.');
  await expectStatus(403, () => outcomeService.record({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'AUTOMATION',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `outcome-automation-${randomUUID()}`,
    source: 'AUTOMATION',
  }, ids.localScheduledAppointment, outcomeFor('CANCELLED', 1)), 'A non-human/non-UI context recorded a trial outcome.');

  await expectStatus(409, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, firstKey,
    inputFor(new Date(startsAt.getTime() + 60 * 60 * 1000), new Date(endsAt.getTime() + 60 * 60 * 1000)),
    request, responseCapture(),
  ), 'A reused trial idempotency key accepted a different appointment.');
  await expectStatus(403, () => controller.schedule(
    randomUUID(), ids.schoolA, ids.leadA, `wrong-org-${randomUUID()}`, inputFor(startsAt, endsAt), request, responseCapture(),
  ), 'Trial scheduling accepted an organization route outside its resolved scope.');
  await expectStatus(404, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadB, `foreign-lead-${randomUUID()}`, inputFor(startsAt, endsAt), request, responseCapture(),
  ), 'RLS-scoped lead lookup exposed a lead from another school.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `timezone-${randomUUID()}`,
    inputFor(startsAt, endsAt, { startsAt: '2030-05-01T09:00:00' }), request, responseCapture(),
  ), 'A timezone-free trial timestamp was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `calendar-${randomUUID()}`,
    inputFor(startsAt, endsAt, { startsAt: '2030-02-30T09:00:00Z' }), request, responseCapture(),
  ), 'An invalid-calendar trial timestamp was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `ordering-${randomUUID()}`,
    inputFor(endsAt, startsAt), request, responseCapture(),
  ), 'A non-increasing trial appointment range was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `past-${randomUUID()}`,
    inputFor(new Date(now - 60 * 60 * 1000), endsAt), request, responseCapture(),
  ), 'A past trial appointment was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `future-window-${randomUUID()}`,
    inputFor(new Date(now + 89 * 24 * 60 * 60 * 1000), new Date(now + 91 * 24 * 60 * 60 * 1000)), request, responseCapture(),
  ), 'A trial appointment outside the 90-day scheduling window was accepted.');
  await expectStatus(400, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, `notes-${randomUUID()}`,
    inputFor(startsAt, endsAt, { notes: 'x'.repeat(2001) }), request, responseCapture(),
  ), 'Trial appointment notes longer than 2000 characters were accepted.');
  await expectStatus(403, () => service.schedule({
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'AUTOMATION',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `automation-${randomUUID()}`,
    source: 'AUTOMATION',
  }, ids.leadA, inputFor(startsAt, endsAt)), 'A non-human/non-UI context scheduled a trial appointment.');

  await administrator.query('BEGIN');
  try {
    await administrator.query('SAVEPOINT invalid_range');
    await expectDatabaseError('23514', () => administrator.query(
      `INSERT INTO hon.crm_appointments (
         organization_id, school_id, crm_lead_id, appointment_type, status,
         starts_at, ends_at, created_by_principal_id
       ) VALUES ($1, $2, $3, 'TRIAL', 'SCHEDULED', $4, $5, $6)`,
      [ids.organization, ids.schoolA, ids.leadA, endsAt.toISOString(), startsAt.toISOString(), ids.principal],
    ), 'CRM appointment storage accepted a non-increasing time range.');
    await administrator.query('ROLLBACK TO SAVEPOINT invalid_range');
    await administrator.query('SAVEPOINT cross_tenant_lead');
    await expectDatabaseError('23503', () => administrator.query(
      `INSERT INTO hon.crm_appointments (
         organization_id, school_id, crm_lead_id, appointment_type, status,
         starts_at, ends_at, created_by_principal_id
       ) VALUES ($1, $2, $3, 'TRIAL', 'SCHEDULED', $4, $5, $6)`,
      [ids.organization, ids.schoolA, ids.leadB, startsAt.toISOString(), endsAt.toISOString(), ids.principal],
    ), 'CRM appointment storage accepted a lead from another school.');
    await administrator.query('ROLLBACK TO SAVEPOINT cross_tenant_lead');
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true),
              set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT id FROM hon.crm_appointments WHERE id = $1::uuid', [first.data.id]);
    const hidden = await runtime.query('SELECT id FROM hon.crm_appointments WHERE id = $1::uuid', [ids.foreignAppointment]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS exposed a CRM appointment from another school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  // Permission revocation: neither replay nor reconciliation survives a removed role grant.
  await administrator.query('DELETE FROM hon.principal_role_grants WHERE principal_id = $1', [ids.principal]);
  await expectStatus(403, () => controller.schedule(
    ids.organization, ids.schoolA, ids.leadA, firstKey, inputFor(startsAt, endsAt), request, responseCapture(),
  ), 'A revoked principal replayed a trial scheduling receipt.');
  await expectStatus(403, () => controller.listForLead(ids.organization, ids.schoolA, ids.leadA, request),
    'A revoked principal read trial reconciliation.');
  await expectStatus(403, () => readController.read(ids.organization, ids.schoolA, first.data.id, request),
    'A revoked principal read a trial appointment.');

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.crm_appointments WHERE organization_id = $1) AS appointments,
      (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'crm.trial.schedule') AS schedule_audits,
      (SELECT count(*)::integer FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'crm.trial.outcome.record') AS outcome_audits,
      (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'crm.trial.scheduled' AND schema_version = 1) AS schedule_outbox,
      (SELECT count(*)::integer FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'crm.trial.outcome.recorded' AND schema_version = 1) AS outcome_outbox,
      (SELECT next_state->>'outcomeNotes' FROM hon.audit_events WHERE organization_id = $1 AND action_code = 'crm.trial.outcome.record') AS audit_outcome_notes,
      (SELECT payload->>'outcomeNotes' FROM hon.outbox_events WHERE organization_id = $1 AND event_type = 'crm.trial.outcome.recorded') AS outbox_outcome_notes,
      (SELECT status::text FROM hon.crm_leads WHERE id = $2::uuid) AS lead_status,
      (SELECT pipeline_id::text FROM hon.crm_leads WHERE id = $2::uuid) AS lead_pipeline_id,
      (SELECT appointment_type::text FROM hon.crm_appointments WHERE id = $3::uuid) AS appointment_type,
      (SELECT status::text FROM hon.crm_appointments WHERE id = $3::uuid) AS appointment_status,
      (SELECT version FROM hon.crm_appointments WHERE id = $3::uuid) AS appointment_version,
      (SELECT notes FROM hon.crm_appointments WHERE id = $3::uuid) AS appointment_notes,
      (SELECT status::text FROM hon.crm_appointments WHERE id = $4::uuid) AS stale_appointment_status,
      (SELECT status::text FROM hon.crm_appointments WHERE id = $5::uuid) AS consultation_appointment_status,
      (SELECT count(*)::integer FROM hon.class_bookings WHERE organization_id = $1) AS bookings,
      (SELECT count(*)::integer FROM hon.families WHERE organization_id = $1) AS families,
      (SELECT count(*)::integer FROM hon.student_profiles WHERE organization_id = $1) AS students,
      (SELECT count(*)::integer FROM hon.student_curriculum_enrollments WHERE organization_id = $1) AS enrollments,
      (SELECT count(*)::integer FROM hon.memberships WHERE organization_id = $1) AS memberships,
      (SELECT count(*)::integer FROM hon.crm_activities WHERE organization_id = $1) AS activities,
      (SELECT count(*)::integer FROM hon.ai_usage_ledger WHERE organization_id = $1) AS ai_usage,
      (SELECT count(*)::integer FROM hon.action_requests WHERE organization_id = $1) AS action_requests
  `, [ids.organization, ids.leadA, first.data.id, ids.localScheduledAppointment, ids.localConsultationAppointment]);
  assert(evidence.rows[0]?.appointments === 7 + 51
    && evidence.rows[0]?.schedule_audits === 3 && evidence.rows[0]?.outcome_audits === 1
    && evidence.rows[0]?.schedule_outbox === 3 && evidence.rows[0]?.outcome_outbox === 1
    && evidence.rows[0]?.audit_outcome_notes === 'Trial completed successfully.'
    && evidence.rows[0]?.outbox_outcome_notes === 'Trial completed successfully.',
  'Trial scheduling/outcome did not create exactly one atomic audit and v1 outbox event under idempotent replay.');
  assert(evidence.rows[0]?.lead_status === 'OPEN' && evidence.rows[0]?.lead_pipeline_id === ids.pipelineA
    && evidence.rows[0]?.appointment_type === 'TRIAL' && evidence.rows[0]?.appointment_status === 'COMPLETED'
    && evidence.rows[0]?.appointment_version === 2 && evidence.rows[0]?.appointment_notes === 'First visit; parent will attend.'
    && evidence.rows[0]?.stale_appointment_status === 'SCHEDULED'
    && evidence.rows[0]?.consultation_appointment_status === 'SCHEDULED',
  'Trial outcome altered lead/pipeline state, appointment type/schedule notes, or a protected consultation.');
  assert(evidence.rows[0]?.bookings === 0 && evidence.rows[0]?.families === 0 && evidence.rows[0]?.students === 0
    && evidence.rows[0]?.enrollments === 0 && evidence.rows[0]?.memberships === 0 && evidence.rows[0]?.activities === 0
    && evidence.rows[0]?.ai_usage === 0 && evidence.rows[0]?.action_requests === 0,
  'Trial outcome mutated booking, student/family, enrollment, membership, CRM activity, or AI/action state.');

  console.log('Verified one active trial per lead (new-key, cross-tab and concurrent duplicates refused with the existing trial; past unclosed trials do not block), exact-key replay before the clock rule, direct-human reconciliation reads, permission revocation, CRM trial appointment scheduling/outcome permission scope, forced RLS, exact runtime grants, locked tenant isolation, strict outcome validation, human-UI boundary, stale-version and terminal-state handling, idempotent replay, atomic audit/v1 outbox evidence, and no lead/pipeline/booking/student/family/enrollment/membership/AI/action mutation.');
} finally {
  try {
    await database.onModuleDestroy();
  } finally {
    try {
      await cleanupFixtures();
    } finally {
      await Promise.all([administrator.end(), runtime.end()]);
    }
  }
}
