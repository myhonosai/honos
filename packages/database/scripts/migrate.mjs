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
    const sql = await readFile(join(migrationsDirectory.pathname, file), 'utf8');
    await client.query(sql);
    await client.query('INSERT INTO hon.schema_migrations (filename) VALUES ($1)', [file]);
    console.log(`Applied ${file}`);
  }
  console.log('HON PostgreSQL migrations are current.');
} finally {
  await client.end();
}
