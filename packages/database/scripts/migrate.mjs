import { requireCurriculumLibraryLocalUrls } from './curriculum-library-local-guard.mjs';
import { requireClassPassLocalUrls } from './classpass-local-guard.mjs';
import { requirePromotionReadinessLocalUrls } from './promotion-readiness-local-guard.mjs';
import { requireOwnerLaunchLocalUrls } from './owner-launch-local-guard.mjs';
import { requireRetentionAcknowledgementLocalUrls } from './retention-review-acknowledgement-local-guard.mjs';
import { requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be configured before HON migrations can run.');
}
const parsedDatabaseUrl = new URL(databaseUrl);
const isLoopbackDatabase = ['localhost', '127.0.0.1', '[::1]'].includes(parsedDatabaseUrl.hostname);

if (new URL(databaseUrl).username === 'hon_classpass_owner') requireClassPassLocalUrls();
if (new URL(databaseUrl).username === 'hon_curriculum_library_owner') requireCurriculumLibraryLocalUrls();
const migrationsDirectory = new URL('../migrations/', import.meta.url);
const stopAfter = process.env.HON_MIGRATION_STOP_AFTER;
const localFixtureRuntimeAlias = (() => {
  if (!process.env.HON_RUNTIME_DATABASE_URL) return false;
  const owner = new URL(databaseUrl);
  const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL);
  const prefix = owner.username.endsWith('_owner') ? owner.username.slice(0, -'_owner'.length) : '';
  return owner.hostname === 'localhost' && owner.port === '5432'
    && /^hon_[a-z0-9_]+$/.test(prefix)
    && owner.pathname.startsWith(`/${prefix}_validation`)
    && runtime.hostname === owner.hostname && runtime.port === owner.port && runtime.pathname === owner.pathname
    && runtime.username === `${prefix}_runtime`;
})();
if (stopAfter && stopAfter !== '0113_hq_ai_task_profiles.sql' && stopAfter !== '0158_hon_payment_provider_test_mode.sql') {
  throw new Error('Only the guarded attendance-backfill or flexible-billing proof may stop migrations.');
}
if (stopAfter) {
  const owner = new URL(databaseUrl), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
  const attendanceBackfill = stopAfter === '0113_hq_ai_task_profiles.sql'
    && owner.hostname === 'localhost' && owner.port === '5432' && owner.pathname === '/hon_attendance_backfill_validation' && owner.username === 'hon_attendance_backfill_owner'
    && runtime.hostname === owner.hostname && runtime.port === owner.port && runtime.pathname === owner.pathname && runtime.username === 'hon_attendance_backfill_runtime';
  const flexibleBilling = stopAfter === '0158_hon_payment_provider_test_mode.sql'
    && owner.hostname === 'localhost' && owner.port === '5432' && owner.pathname === '/hon_flexible_billing_accounts_validation' && owner.username === 'hon_flexible_billing_accounts_owner'
    && runtime.hostname === owner.hostname && runtime.port === owner.port && runtime.pathname === owner.pathname && runtime.username === 'hon_flexible_billing_accounts_runtime';
  if (!attendanceBackfill && !flexibleBilling) {
    throw new Error('Stopping migrations requires the exact marked disposable localhost aliases.');
  }
}
const files = (await readdir(migrationsDirectory))
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .filter((file) => !stopAfter || file <= stopAfter)
  .sort();

const client = new Client({ connectionString: databaseUrl, ssl: isLoopbackDatabase ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  if (new URL(databaseUrl).username === 'hon_owner_launch_owner') {
    requireOwnerLaunchLocalUrls();
    const marker=(await client.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
    if(marker?.owner!=='hon_owner_launch_owner'||marker.marker!=='HON disposable owner_launch validation') throw new Error('Owner launch migrations refuse an unmarked local fixture.');
  }
  if (new URL(databaseUrl).username === 'hon_retention_acknowledgement_owner') {
    requireRetentionAcknowledgementLocalUrls();
    const marker = (await client.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
    if (marker?.owner !== 'hon_retention_acknowledgement_owner' || marker.marker !== 'HON disposable retention_acknowledgement validation') throw new Error('Retention migrations refuse an unmarked local fixture.');
  }
  if (new URL(databaseUrl).username === 'hon_curriculum_library_owner') {
    const marker=(await client.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
    if(marker?.owner!=='hon_curriculum_library_owner'||marker.marker!=='HON disposable curriculum_library validation') throw new Error('Library migrations refuse an unmarked local fixture.');
  }
  await client.query('CREATE SCHEMA IF NOT EXISTS hon');
  await client.query(`
    CREATE TABLE IF NOT EXISTS hon.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set((await client.query('SELECT filename FROM hon.schema_migrations')).rows.map((row) => row.filename));
  // Deployment gate: earlier drafts of Manus PR #27 used these CRM filenames before they were renumbered to
  // 0159-0163. A database that recorded any of them has CRM objects under another ledger identity and needs a
  // reviewed, environment-specific baseline; the ordinary runner must not replay or reinterpret that history.
  const supersededCrmFilenames = ['0152_flexible_billing_accounts.sql', '0153_crm_lead_registration.sql', '0154_staff_curriculum_enrollment_preparation.sql',
    '0155_crm_adult_membership_draft.sql', '0158_flexible_billing_accounts.sql', '0159_crm_lead_registration.sql', '0160_staff_curriculum_enrollment_preparation.sql',
    '0161_crm_adult_membership_draft.sql', '0162_crm_adult_membership_draft_confirmation.sql'].filter((file) => applied.has(file));
  if (supersededCrmFilenames.length) {
    throw new Error(`Refusing to migrate: superseded CRM migration history recorded (${supersededCrmFilenames.join(', ')}). See docs/architecture/CRM_ADULT_DRAFT_MAIN_INTEGRATION.md.`);
  }
  for (const file of files) {
    if (applied.has(file)) continue;
    let sql = await readFile(join(migrationsDirectory.pathname, file), 'utf8');
    if (new URL(databaseUrl).username === 'hon_curriculum_library_owner') { requireCurriculumLibraryLocalUrls(); sql=sql.replaceAll('hon_runtime','hon_curriculum_library_runtime'); }
    if (new URL(databaseUrl).username === 'hon_promotion_readiness_owner') {
      requirePromotionReadinessLocalUrls();
      sql = sql.replaceAll('hon_runtime', 'hon_promotion_readiness_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_classpass_owner') {
      const owner = new URL(databaseUrl), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_classpass_validation' || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_classpass_runtime') throw new Error('ClassPass aliases require exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_classpass_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_class_sessions_read_owner') {
      const owner = new URL(databaseUrl), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_class_sessions_read_validation' || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_class_sessions_read_runtime') throw new Error('Class Sessions aliases require exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_class_sessions_read_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_flexible_billing_accounts_owner') {
      await requireFlexibleBillingAccountsLocalUrls();
      sql = sql.replaceAll('hon_runtime', 'hon_flexible_billing_accounts_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_attendance_owner') {
      const owner = new URL(databaseUrl), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_attendance_validation' || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_attendance_runtime') throw new Error('Attendance aliases require exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_attendance_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_attendance_backfill_owner') {
      const owner = new URL(databaseUrl), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_attendance_backfill_validation' || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_attendance_backfill_runtime') throw new Error('Attendance backfill aliases require exact marked disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_attendance_backfill_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_achievement_owner') {
      const owner=new URL(databaseUrl), runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if(owner.hostname!=='localhost' || owner.port!=='5432' || owner.pathname!=='/hon_achievement_validation' || runtime.hostname!=='localhost' || runtime.port!=='5432' || runtime.pathname!==owner.pathname || runtime.username!=='hon_achievement_runtime') throw new Error('Achievement aliases require exact disposable localhost database.');
      sql=sql.replaceAll('hon_runtime','hon_achievement_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_marketplace_owner') {
      const owner=new URL(databaseUrl), runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if(owner.hostname!=='localhost' || owner.port!=='5432' || owner.pathname!=='/hon_marketplace_validation' || runtime.hostname!=='localhost' || runtime.port!=='5432' || runtime.pathname!==owner.pathname || runtime.username!=='hon_marketplace_runtime') throw new Error('Marketplace aliases require exact disposable localhost database.');
      sql=sql.replaceAll('hon_runtime','hon_marketplace_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_work_owner') {
      const owner=new URL(databaseUrl), runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if(owner.hostname!=='localhost' || owner.port!=='5432' || owner.pathname!=='/hon_work_validation' || runtime.hostname!=='localhost' || runtime.port!=='5432' || runtime.pathname!==owner.pathname || runtime.username!=='hon_work_runtime') throw new Error('Work aliases require exact disposable localhost database.');
      sql=sql.replaceAll('hon_runtime','hon_work_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_voice_owner') {
      const owner=new URL(databaseUrl), runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if(owner.hostname!=='localhost' || owner.port!=='5432' || owner.pathname!=='/hon_voice_validation' || runtime.hostname!=='localhost' || runtime.port!=='5432' || runtime.pathname!==owner.pathname || runtime.username!=='hon_voice_runtime') throw new Error('Voice aliases require exact disposable localhost database.');
      sql=sql.replaceAll('hon_runtime','hon_voice_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_approval_owner') {
      const owner=new URL(databaseUrl), runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if(owner.hostname!=='localhost' || owner.port!=='5432' || owner.pathname!=='/hon_approval_validation' || runtime.hostname!=='localhost' || runtime.port!=='5432' || runtime.pathname!==owner.pathname || runtime.username!=='hon_approval_runtime') throw new Error('Approval aliases require exact disposable localhost database.');
      sql=sql.replaceAll('hon_runtime','hon_approval_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_absence_review_owner') {
      const owner = new URL(databaseUrl), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_absence_review_validation' || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_absence_review_runtime') throw new Error('Review aliases require exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_absence_review_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_parent_journey_sandbox_owner') {
      const owner=new URL(databaseUrl), runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if(owner.hostname!=='localhost' || owner.port!=='5432' || owner.pathname!=='/hon_parent_journey_validation_sandbox' || runtime.hostname!=='localhost' || runtime.port!=='5432' || runtime.pathname!==owner.pathname || runtime.username!=='hon_parent_journey_sandbox_runtime') throw new Error('Parent Journey aliases require exact disposable localhost database.');
      sql=sql.replaceAll('hon_runtime','hon_parent_journey_sandbox_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_parent_billing_owner') {
      const owner=new URL(databaseUrl), runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if(owner.hostname!=='localhost' || owner.port!=='5432' || owner.pathname!=='/hon_parent_billing_validation' || runtime.hostname!=='localhost' || runtime.port!=='5432' || runtime.pathname!==owner.pathname || runtime.username!=='hon_parent_billing_runtime') throw new Error('Parent billing aliases require exact disposable localhost database.');
      sql=sql.replaceAll('hon_runtime','hon_parent_billing_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_automation_owner') {
      const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? ''); const owner = new URL(databaseUrl);
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_automation_validation' || runtime.hostname !== 'localhost' || runtime.port !== '5432' || runtime.pathname !== owner.pathname || runtime.username !== 'hon_automation_runtime') throw new Error('Automation aliases require exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_automation_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_staff_owner') {
      const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? ''); const owner = new URL(databaseUrl);
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_staff_validation' || runtime.hostname !== 'localhost' || runtime.port !== '5432' || runtime.pathname !== owner.pathname || runtime.username !== 'hon_staff_runtime') throw new Error('Staff aliases require exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_staff_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_marketing_ai_owner') {
      const owner=new URL(databaseUrl), runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if(owner.hostname!=='localhost' || owner.port!=='5432' || owner.pathname!=='/hon_marketing_ai_validation' || runtime.hostname!==owner.hostname || runtime.port!==owner.port || runtime.pathname!==owner.pathname || runtime.username!=='hon_marketing_ai_runtime') throw new Error('Marketing AI aliases require exact disposable localhost database.');
      sql=sql.replaceAll('hon_runtime','hon_marketing_ai_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_teaching_ai_owner') {
      const owner=new URL(databaseUrl), runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      if(owner.hostname!=='localhost' || owner.port!=='5432' || owner.pathname!=='/hon_teaching_ai_validation' || runtime.hostname!==owner.hostname || runtime.port!==owner.port || runtime.pathname!==owner.pathname || runtime.username!=='hon_teaching_ai_runtime') throw new Error('Claire Teaching Assistant aliases require exact disposable localhost database.');
      sql=sql.replaceAll('hon_runtime','hon_teaching_ai_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_campaign_owner') {
      const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      const owner = new URL(databaseUrl);
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_campaign_validation'
        || runtime.hostname !== 'localhost' || runtime.port !== '5432' || runtime.pathname !== owner.pathname || runtime.username !== 'hon_campaign_runtime') throw new Error('Campaign aliases require the exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_campaign_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_community_owner') {
      const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? ''); const owner = new URL(databaseUrl);
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_community_validation' || runtime.hostname !== 'localhost' || runtime.port !== '5432' || runtime.pathname !== owner.pathname || runtime.username !== 'hon_community_runtime') throw new Error('Community aliases require exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_community_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_renewal_owner') {
      const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? ''); const owner = new URL(databaseUrl);
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_renewal_validation' || runtime.hostname !== 'localhost' || runtime.port !== '5432' || runtime.pathname !== owner.pathname || runtime.username !== 'hon_renewal_runtime') throw new Error('Renewal aliases require exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_renewal_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_followup_owner') {
      const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
      const owner = new URL(databaseUrl);
      if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_followup_validation'
        || runtime.hostname !== 'localhost' || runtime.port !== '5432' || runtime.pathname !== owner.pathname || runtime.username !== 'hon_followup_runtime') throw new Error('Follow-up aliases require the exact disposable localhost database.');
      sql = sql.replaceAll('hon_runtime', 'hon_followup_runtime');
    }
    // Exact descriptor-bound disposable retention alias only. This also makes
    // the existing 0126 local-only logging deferral match; no shared hon_runtime
    // role is altered, elevated or granted to this fixture migration owner.
    if (new URL(databaseUrl).username === 'hon_retention_acknowledgement_owner') {
      sql = sql.replaceAll('hon_runtime', 'hon_retention_acknowledgement_runtime');
    }
    if (new URL(databaseUrl).username === 'hon_owner_launch_owner') {
      sql = sql.replaceAll('hon_runtime', 'hon_owner_launch_runtime');
    }
    // PostgreSQL allows a role-global setting only to a superuser or an
    // ADMIN member of that exact runtime role. Guarded fixture owners create
    // a non-privileged runtime login deliberately, so preserve 0126's
    // trusted-owner guard while deferring only its role-global logging SET
    // statements when this migration owner lacks that exact authority.
    // Development/production migration owners still execute 0126 unchanged.
    if (file === '0126_kiosk_runtime_logging_reconciliation.sql') {
      const runtimeRole = sql.match(/ALTER ROLE ([a-z0-9_]+) SET log_parameter_max_length = 0;/)?.[1];
      if (runtimeRole) {
        const capability = await client.query(
          `SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
                    OR EXISTS (
                      SELECT 1
                      FROM pg_auth_members membership
                      JOIN pg_roles member_role ON member_role.oid = membership.member
                      JOIN pg_roles target_role ON target_role.oid = membership.roleid
                      WHERE member_role.rolname = current_user
                        AND target_role.rolname = $1
                        AND membership.admin_option
                    ) AS allowed`,
          [runtimeRole],
        );
        if (!capability.rows[0]?.allowed) {
          sql = sql
            .replace(/^\s*ALTER ROLE hon_[a-z0-9_]+_runtime SET log_parameter_max_length = 0;\n/gm, '')
            .replace(/^\s*ALTER ROLE hon_[a-z0-9_]+_runtime SET log_parameter_max_length_on_error = 0;\n/gm, '');
        }
      }
    }
    await client.query(sql);
    await client.query('INSERT INTO hon.schema_migrations (filename) VALUES ($1)', [file]);
    console.log(`Applied ${file}`);
  }
  console.log('HON PostgreSQL migrations are current.');
} finally {
  await client.end();
}
