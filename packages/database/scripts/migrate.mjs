import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be configured before HON migrations can run.');
}

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const files = (await readdir(migrationsDirectory))
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();

const client = new Client({ connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query('CREATE SCHEMA IF NOT EXISTS hon');
  await client.query(`
    CREATE TABLE IF NOT EXISTS hon.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set((await client.query('SELECT filename FROM hon.schema_migrations')).rows.map((row) => row.filename));
  for (const file of files) {
    if (applied.has(file)) continue;
    let sql = await readFile(join(migrationsDirectory.pathname, file), 'utf8');
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
    await client.query(sql);
    await client.query('INSERT INTO hon.schema_migrations (filename) VALUES ($1)', [file]);
    console.log(`Applied ${file}`);
  }
  console.log('HON PostgreSQL migrations are current.');
} finally {
  await client.end();
}
