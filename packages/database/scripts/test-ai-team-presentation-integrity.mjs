import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for AI Team presentation integrity tests.');
if (!process.env.HON_RUNTIME_DATABASE_URL) throw new Error('HON_RUNTIME_DATABASE_URL is required for AI Team presentation integrity tests.');

const connectionOptions = (connectionString) => ({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

const { AiTeamController } = await import('../../../apps/api/dist/ai-team/ai-team.controller.js');
const { AiTeamService } = await import('../../../apps/api/dist/ai-team/ai-team.service.js');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');

const ids = Object.fromEntries([
  'organization', 'schoolA', 'schoolB', 'user', 'principal', 'ownerRole',
].map((key) => [key, randomUUID()]));
const externalSubject = `ai-team-${randomUUID()}`;
const administrator = new Client(connectionOptions(process.env.DATABASE_URL));
const runtime = new Client(connectionOptions(process.env.HON_RUNTIME_DATABASE_URL));

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
    await administrator.query('DELETE FROM hon.outbox_delivery_attempts WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.outbox_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.idempotency_records WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.ai_team_presentation_preferences WHERE organization_id = $1', [ids.organization]);
    await administrator.query('DELETE FROM hon.principal_role_grants WHERE principal_id = $1', [ids.principal]);
    await administrator.query('DELETE FROM hon.role_permissions WHERE role_id = $1', [ids.ownerRole]);
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
const service = new AiTeamService(database);
const controller = new AiTeamController(database, service);

try {
  const permission = await administrator.query(
    "SELECT is_sensitive FROM hon.permissions WHERE code = 'ai.team.configure'",
  );
  assert(permission.rowCount === 1 && permission.rows[0]?.is_sensitive,
    'ai.team.configure must be seeded as a sensitive permission.');

  const posture = await administrator.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = 'hon.ai_team_presentation_preferences'::regclass
  `);
  assert(posture.rows[0]?.relrowsecurity && posture.rows[0]?.relforcerowsecurity,
    'ai_team_presentation_preferences must enable and force row-level security.');

  const grants = (await runtime.query(`
    SELECT
      has_table_privilege(current_user, 'hon.ai_team_presentation_preferences', 'SELECT') AS can_select,
      has_table_privilege(current_user, 'hon.ai_team_presentation_preferences', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'hon.ai_team_presentation_preferences', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'hon.ai_team_presentation_preferences', 'DELETE') AS can_delete
  `)).rows[0];
  assert(grants?.can_select && grants?.can_insert && grants?.can_update && !grants?.can_delete,
    'hon_runtime AI Team preference grants must be exactly SELECT/INSERT/UPDATE with no DELETE.');

  const columns = (await administrator.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'hon' AND table_name = 'ai_team_presentation_preferences'
    ORDER BY ordinal_position
  `)).rows.map((row) => row.column_name);
  assert(JSON.stringify(columns) === JSON.stringify([
    'id', 'organization_id', 'school_id', 'agent_key', 'display_name', 'avatar_key', 'voice_profile',
    'version', 'created_at', 'updated_at',
  ]), 'AI Team preference storage must contain only scoped safe-presentation and version/timestamp fields.');

  await administrator.query('BEGIN');
  try {
    await administrator.query(
      'INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, $2, $2)',
      [ids.organization, 'AI Team Presentation Integrity Test'],
    );
    await administrator.query(
      `INSERT INTO hon.organization_entitlements (organization_id, tier, status, effective_from)
       VALUES ($1, 'ESSENTIAL', 'ACTIVE', now() - interval '1 day')`,
      [ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.schools (id, organization_id, name, slug) VALUES
       ($1, $2, 'AI Team School A', $3),
       ($4, $2, 'AI Team School B', $5)`,
      [
        ids.schoolA, ids.organization, `ai-team-a-${ids.schoolA.slice(0, 8)}`,
        ids.schoolB, `ai-team-b-${ids.schoolB.slice(0, 8)}`,
      ],
    );
    await administrator.query(
      'INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, $3, $4)',
      [ids.user, externalSubject, `ai-team-${ids.user}@example.test`, 'AI Team Owner'],
    );
    await administrator.query(
      `INSERT INTO hon.principals (id, principal_type, user_id, display_name)
       VALUES ($1, 'HUMAN_USER', $2, 'AI Team Owner')`,
      [ids.principal, ids.user],
    );
    await administrator.query(
      `INSERT INTO hon.roles (id, organization_id, code, name, is_system_role)
       VALUES ($1, $2, 'OWNER', 'School Owner', true)`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.role_permissions (role_id, organization_id, permission_code)
       VALUES ($1, $2, 'ai.team.configure')`,
      [ids.ownerRole, ids.organization],
    );
    await administrator.query(
      `INSERT INTO hon.principal_role_grants (
         organization_id, school_id, principal_id, role_id, granted_by_principal_id
       ) VALUES ($1, $2, $3, $4, $3)`,
      [ids.organization, ids.schoolA, ids.principal, ids.ownerRole],
    );
    await administrator.query('COMMIT');
  } catch (error) {
    await administrator.query('ROLLBACK');
    throw error;
  }

  const request = { honIdentity: { externalSubject } };
  await expectStatus(403, () => controller.list(ids.organization, ids.schoolA, request),
    'Essential tier was allowed to read the Complete AI Team directory.');
  await expectStatus(403, () => controller.updatePresentation(
    ids.organization, ids.schoolA, 'alex', `essential-${randomUUID()}`,
    { expectedVersion: 0, displayName: 'Essential Attempt' }, request,
  ), 'Essential tier was allowed to customize the AI Team directory.');

  await administrator.query("UPDATE hon.organization_entitlements SET tier = 'CORE' WHERE organization_id = $1", [ids.organization]);
  await expectStatus(403, () => controller.list(ids.organization, ids.schoolA, request),
    'Core tier was allowed to read the Complete AI Team directory.');
  await expectStatus(403, () => controller.updatePresentation(
    ids.organization, ids.schoolA, 'alex', `core-${randomUUID()}`,
    { expectedVersion: 0, displayName: 'Core Attempt' }, request,
  ), 'Core tier was allowed to customize the AI Team directory.');

  await administrator.query("UPDATE hon.organization_entitlements SET tier = 'COMPLETE' WHERE organization_id = $1", [ids.organization]);
  const initialDirectory = await controller.list(ids.organization, ids.schoolA, request);
  const initialNames = initialDirectory.data.agents.map((agent) => agent.defaultDisplayName);
  assert(initialDirectory.data.agents.length === 8
    && JSON.stringify(initialNames) === JSON.stringify(['Alex', 'Chad', 'Maya', 'Marcus', 'Jordan', 'Claire', 'Lena', 'Eian'])
    && initialDirectory.data.agents.every((agent) => agent.presentation.version === 0),
  'Complete tier did not receive exactly the eight static approved HON AI Team entries with default presentation.');

  const firstKey = `ai-team-create-${randomUUID()}`;
  const updated = await controller.updatePresentation(
    ids.organization, ids.schoolA, 'alex', firstKey,
    { expectedVersion: 0, displayName: 'Alex School Guide' }, request,
  );
  assert(!updated.meta.replayed && updated.data.agentKey === 'alex'
    && updated.data.presentation.displayName === 'Alex School Guide'
    && updated.data.presentation.avatarKey === 'hon-agent-alex'
    && updated.data.presentation.voiceProfile === 'CLEAR'
    && updated.data.presentation.version === 1,
  'Complete tier did not atomically create a safe Alex presentation override at version 1.');

  const replay = await controller.updatePresentation(
    ids.organization, ids.schoolA, 'alex', firstKey,
    { expectedVersion: 0, displayName: 'Alex School Guide' }, request,
  );
  assert(replay.meta.replayed && replay.data.presentation.version === 1,
    'A matching AI Team presentation request did not replay its completed response.');

  const revised = await controller.updatePresentation(
    ids.organization, ids.schoolA, 'alex', `ai-team-revise-${randomUUID()}`,
    { expectedVersion: 1, avatarKey: 'hon-agent-default', voiceProfile: 'WARM' }, request,
  );
  assert(!revised.meta.replayed && revised.data.presentation.displayName === 'Alex School Guide'
    && revised.data.presentation.avatarKey === 'hon-agent-default'
    && revised.data.presentation.voiceProfile === 'WARM'
    && revised.data.presentation.version === 2,
  'A version-matched safe avatar/voice-preset update did not preserve the display override and increment version.');

  await expectStatus(409, () => controller.updatePresentation(
    ids.organization, ids.schoolA, 'alex', `ai-team-stale-${randomUUID()}`,
    { expectedVersion: 1, displayName: 'Stale Change' }, request,
  ), 'AI Team presentation update accepted a stale expectedVersion.');
  await expectStatus(409, () => controller.updatePresentation(
    ids.organization, ids.schoolA, 'alex', firstKey,
    { expectedVersion: 2, displayName: 'Different Request' }, request,
  ), 'AI Team presentation idempotency key was reused for a different command.');

  const directContext = {
    organizationId: ids.organization,
    schoolId: ids.schoolA,
    principalId: ids.principal,
    principalType: 'HUMAN_USER',
    requestId: randomUUID(),
    correlationId: randomUUID(),
    idempotencyKey: `injected-${randomUUID()}`,
    source: 'HUMAN_UI',
  };
  for (const injectedField of ['tools', 'authority', 'model', 'fallback', 'provider', 'payment', 'roleGrant']) {
    await expectStatus(400, () => service.update(
      { ...directContext, idempotencyKey: `${injectedField}-${randomUUID()}` },
      'alex',
      { expectedVersion: 2, displayName: 'Rejected Injection', [injectedField]: 'unsafe' },
    ), `AI Team presentation accepted injected ${injectedField} control data.`);
  }
  await expectStatus(400, () => service.update(
    { ...directContext, idempotencyKey: `bad-agent-${randomUUID()}` },
    'unapproved-agent', { expectedVersion: 0, displayName: 'Not Allowed' },
  ), 'AI Team presentation accepted arbitrary agent creation via agentKey.');
  await expectStatus(400, () => service.update(
    { ...directContext, idempotencyKey: `unsafe-name-${randomUUID()}` },
    'alex', { expectedVersion: 2, displayName: '<script>alert(1)</script>' },
  ), 'AI Team presentation accepted an unsafe displayName.');
  await expectStatus(400, () => service.update(
    { ...directContext, idempotencyKey: `bad-avatar-${randomUUID()}` },
    'alex', { expectedVersion: 2, avatarKey: 'https://untrusted.example/avatar.png' },
  ), 'AI Team presentation accepted an arbitrary avatar URL.');
  await expectStatus(400, () => service.update(
    { ...directContext, idempotencyKey: `bad-voice-${randomUUID()}` },
    'alex', { expectedVersion: 2, voiceProfile: 'provider-model-voice' },
  ), 'AI Team presentation accepted a provider-specific voice configuration.');
  await expectStatus(403, () => service.update(
    { ...directContext, source: 'AI', idempotencyKey: `ai-source-${randomUUID()}` },
    'alex', { expectedVersion: 2, displayName: 'AI Attempt' },
  ), 'AI Team presentation accepted a non-HUMAN_UI command source.');

  await administrator.query(
    `INSERT INTO hon.ai_team_presentation_preferences (
       organization_id, school_id, agent_key, display_name
     ) VALUES ($1, $2, 'chad', 'School B Chad')`,
    [ids.organization, ids.schoolB],
  );
  await expectStatus(403, () => controller.updatePresentation(
    ids.organization, ids.schoolB, 'chad', `cross-school-${randomUUID()}`,
    { expectedVersion: 1, displayName: 'Foreign School Attempt' }, request,
  ), 'AI Team presentation accepted a school outside the resolved permission scope.');
  await expectStatus(403, () => controller.list(randomUUID(), ids.schoolA, request),
    'AI Team directory accepted a path organization outside the resolved school scope.');

  const visibleDirectory = await controller.list(ids.organization, ids.schoolA, request);
  assert(visibleDirectory.data.agents.find((agent) => agent.agentKey === 'chad')?.presentation.displayName === 'Chad',
    'AI Team directory joined a presentation override from another school.');

  await runtime.query('BEGIN');
  try {
    await runtime.query(
      `SELECT set_config('app.hon_organization_id', $1, true),
              set_config('app.hon_school_id', $2, true)`,
      [ids.organization, ids.schoolA],
    );
    await runtime.query('SELECT hon.require_tenant_context()');
    const local = await runtime.query(
      "SELECT agent_key FROM hon.ai_team_presentation_preferences WHERE agent_key = 'alex'",
    );
    const foreign = await runtime.query(
      "SELECT agent_key FROM hon.ai_team_presentation_preferences WHERE agent_key = 'chad'",
    );
    assert(local.rowCount === 1 && foreign.rowCount === 0,
      'RLS exposed AI Team presentation preferences from another school.');
    await runtime.query('ROLLBACK');
  } catch (error) {
    await runtime.query('ROLLBACK');
    throw error;
  }

  const evidence = await administrator.query(`
    SELECT
      (SELECT count(*)::integer FROM hon.ai_team_presentation_preferences
       WHERE organization_id = $1 AND school_id = $2) AS local_preferences,
      (SELECT count(*)::integer FROM hon.audit_events
       WHERE organization_id = $1 AND school_id = $2 AND action_code = 'ai.team.presentation.update') AS audits,
      (SELECT count(*)::integer FROM hon.outbox_events
       WHERE organization_id = $1 AND school_id = $2 AND event_type = 'ai.team.presentation.updated' AND schema_version = 1) AS outbox,
      (SELECT count(*)::integer FROM hon.work_items WHERE organization_id = $1) AS work_items,
      (SELECT count(*)::integer FROM hon.action_requests WHERE organization_id = $1) AS action_requests,
      (SELECT count(*)::integer FROM hon.ai_usage_ledger WHERE organization_id = $1) AS ai_usage,
      (SELECT count(*)::integer FROM hon.payment_attempts WHERE organization_id = $1) AS payment_attempts,
      (SELECT next_state->'presentation'->>'voiceProfile' FROM hon.audit_events
       WHERE organization_id = $1 AND school_id = $2 AND action_code = 'ai.team.presentation.update'
       ORDER BY occurred_at DESC LIMIT 1) AS audited_voice_profile,
      (SELECT aggregate_version FROM hon.outbox_events
       WHERE organization_id = $1 AND school_id = $2 AND event_type = 'ai.team.presentation.updated'
       ORDER BY occurred_at DESC LIMIT 1) AS outbox_version
  `, [ids.organization, ids.schoolA]);
  const row = evidence.rows[0];
  assert(row?.local_preferences === 1 && row?.audits === 2 && row?.outbox === 2
    && row?.work_items === 0 && row?.action_requests === 0 && row?.ai_usage === 0 && row?.payment_attempts === 0
    && row?.audited_voice_profile === 'WARM' && row?.outbox_version === 2,
  'AI Team customizer did not retain atomic versioned audit/outbox evidence or crossed a prohibited AI/Action/usage/payment boundary.');

  console.log('Verified Complete-only fixed HON AI Team directory, Essential/Core denial, sensitive permission, forced RLS, exact runtime grants, school isolation, strict safe-presentation field allowlist, human UI and idempotency/version guards, and atomic audit/outbox without AI, Action Engine, work-item, usage, or payment behavior.');
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
