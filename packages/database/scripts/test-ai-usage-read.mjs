import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for AI usage read tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for AI usage read tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { AiUsageController } = await import('../../../apps/api/dist/ai/ai-usage.controller.js');
const { AiUsageService, determineAiUsageWarningLevel } = await import('../../../apps/api/dist/ai/ai-usage.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const runtime = new Client(connectionOptions(process.env.HON_RUNTIME_DATABASE_URL));
const ids = Object.fromEntries(
  [
    'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole',
    'usageA1', 'usageA2', 'usageB',
  ].map((key) => [key, randomUUID()]),
);
const externalSubject = `ai-usage-${randomUUID()}`;
const now = Date.now();
const from = new Date(now - (2 * 24 * 60 * 60 * 1000));
const to = new Date(now + (2 * 24 * 60 * 60 * 1000));
const occurredA1 = new Date(now - (18 * 60 * 60 * 1000));
const occurredA2 = new Date(now - (12 * 60 * 60 * 1000));
const occurredB = new Date(now - (6 * 60 * 60 * 1000));

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function cleanupFixtures() {
  await administrator.query('BEGIN');
  try {
    await administrator.query('DELETE FROM hon.ai_usage_ledger WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.principal_role_grants WHERE principal_id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.roles WHERE id = $1', [ids.ownerRole]);
    await administrator.query('DELETE FROM hon.principals WHERE id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.users WHERE id = $1', [ids.user]);
    await administrator.query('DELETE FROM hon.organization_entitlements WHERE organization_id = $1', [ids.organization]);
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
const service = new AiUsageService(database);
const controller = new AiUsageController(database, service);

try {
  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = 'hon.ai_usage_ledger'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'ai_usage_ledger must enable and force row-level security.');

  const grants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.ai_usage_ledger', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.ai_usage_ledger', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.ai_usage_ledger', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.ai_usage_ledger', 'DELETE') AS can_delete
  `)).rows[0];
  assert(grants?.can_select && !grants?.can_insert && !grants?.can_update && !grants?.can_delete,
    'hon_runtime ai_usage_ledger privileges are not the reviewed SELECT-only minimum.');

  assert(determineAiUsageWarningLevel(0, 5_000) === 'NONE', 'Zero usage must not warn.');
  assert(determineAiUsageWarningLevel(3_749, 5_000) === 'NONE', 'Usage below 75% must not warn.');
  assert(determineAiUsageWarningLevel(3_750, 5_000) === '75', 'Usage at 75% must return the 75 warning.');
  assert(determineAiUsageWarningLevel(4_500, 5_000) === '90', 'Usage at 90% must return the 90 warning.');
  assert(determineAiUsageWarningLevel(5_000, 5_000) === '100', 'Usage at 100% must return the 100 warning.');
  assert(determineAiUsageWarningLevel(1, 0) === '100', 'Positive usage without an active included-credit tier must return 100.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'AI Usage Read Test'],
    );
    await administrator.query(
      `INSERT INTO hon.organization_entitlements (
         organization_id, tier, status, effective_from
       ) VALUES ($1, 'CORE', 'ACTIVE', now() - interval '1 day')`,
      [ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'AI Usage School A', $3),
       ($4, $2, 'AI Usage School B', $5)`,
      [
        ids.schoolA, ids.organization, `ai-usage-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `ai-usage-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `ai-usage-${ids.user}@example.test`, 'AI Usage Owner'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'AI Usage Owner')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
       VALUES ($1, $2, 'ai.usage.read')`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.principal_role_grants (
         organization_id, school_id, principal_id, role_id, granted_by_principal_id
       ) VALUES ($1, $2, $3, $4, $3)`,
      [ids.organization, ids.schoolA, ids.principal, ids.ownerRole],
    );
    await administrator.query(
      `INSERT INTO hon.ai_usage_ledger (
         id, organization_id, school_id, provider_code, model_code, modality,
         input_units, output_units, provider_cost_microunits, customer_credits,
         correlation_id, occurred_at
       ) VALUES
       ($1, $2, $3, 'openai', 'gpt-4.1-mini', 'TEXT', 100, 20, 120, 1500, $4, $5),
       ($6, $2, $3, 'vertex', 'imagen-3', 'IMAGE', 0, 2, 150, 2250, $7, $8),
       ($9, $2, $10, 'foreign-provider', 'foreign-model', 'VOICE_OUTPUT', 400, 100, 999, 400000, $11, $12)`,
      [
        ids.usageA1, ids.organization, ids.schoolA, randomUUID(), occurredA1.toISOString(),
        ids.usageA2, randomUUID(), occurredA2.toISOString(),
        ids.usageB, ids.schoolB, randomUUID(), occurredB.toISOString(),
      ],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  const report = await controller.read(
    ids.organization,
    ids.schoolA,
    { from: from.toISOString(), to: to.toISOString() },
    request,
  );
  assert(report.data.organizationId === ids.organization && report.data.schoolId === ids.schoolA,
    'AI usage response did not retain the resolved organization/school scope.');
  assert(report.data.entitlementTier === 'CORE' && report.data.includedCredits === 5_000,
    'AI usage response did not derive included credits from the active organization entitlement.');
  assert(report.data.customerCredits === 3_750 && report.data.remainingCredits === 1_250
    && report.data.providerCostMicrounits === 270 && report.data.inputUnits === 100
    && report.data.outputUnits === 22 && report.data.entries === 2 && report.data.warningLevel === '75',
  'AI usage totals or deterministic warning level were not scoped and aggregated correctly.');
  assert(report.data.breakdown.length === 2
    && report.data.breakdown[0]?.modality === 'IMAGE'
    && report.data.breakdown[1]?.modality === 'TEXT',
  'AI usage provider/model/modality breakdown was not deterministic.');
  assert(!('id' in report.data) && !('correlationId' in report.data)
    && report.data.breakdown.every((row) => !('request' in row) && !('payload' in row)),
  'AI usage response exposed raw ledger identity, request, or payload data.');

  await expectStatus(403, () => controller.read(
    randomUUID(), ids.schoolA, { from: from.toISOString(), to: to.toISOString() }, request,
  ), 'AI usage endpoint accepted a path organization outside the resolved scope.');
  await expectStatus(400, () => controller.read(
    ids.organization,
    ids.schoolA,
    { from: from.toISOString(), to: new Date(from.getTime() + (93 * 24 * 60 * 60 * 1000)).toISOString() },
    request,
  ), 'AI usage endpoint accepted a range longer than 92 days.');
  await expectStatus(400, () => controller.read(
    ids.organization, ids.schoolA, { from: from.toISOString() }, request,
  ), 'AI usage endpoint accepted an unbounded one-sided date range.');

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true),
              set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const visible = await runtime.query('SELECT id FROM hon.ai_usage_ledger WHERE id = $1::uuid', [ids.usageA1]);
    const hidden = await runtime.query('SELECT id FROM hon.ai_usage_ledger WHERE id = $1::uuid', [ids.usageB]);
    assert(visible.rowCount === 1 && hidden.rowCount === 0,
      'RLS exposed AI usage ledger data from another school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  console.log('Verified AI usage permission scope, forced RLS, SELECT-only runtime grant, active-entitlement included credits, bounded aggregation, deterministic thresholds, and no raw ledger/request exposure.');
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
