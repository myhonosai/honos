import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const migrationsDirectory = new URL('../migrations/', import.meta.url);
const files = (await readdir(migrationsDirectory))
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();

if (files.length === 0) {
  throw new Error('At least one numbered PostgreSQL migration is required.');
}

for (const file of files) {
  const source = await readFile(join(migrationsDirectory.pathname, file), 'utf8');
  if (!source.trimStart().startsWith('BEGIN;') || !source.trimEnd().endsWith('COMMIT;')) {
    throw new Error(`${file} must use an explicit BEGIN/COMMIT transaction.`);
  }
}

const firstMigration = await readFile(join(migrationsDirectory.pathname, files[0]), 'utf8');
for (const requiredFragment of [
  'ENABLE ROW LEVEL SECURITY',
  'FUNCTION hon.require_tenant_context',
  'app.hon_organization_id',
  'app.hon_school_id',
]) {
  if (!firstMigration.includes(requiredFragment)) {
    throw new Error(`Foundation migration is missing required RLS contract: ${requiredFragment}`);
  }
}

console.log(`Verified ${files.length} PostgreSQL migration files.`);
