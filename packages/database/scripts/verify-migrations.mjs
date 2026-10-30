import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checksumManifest, duplicateNumbers, migrationChecksum } from './migration-chain.mjs';

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

const duplicates = duplicateNumbers(files);
if (duplicates.length) throw new Error(`Duplicate migration numbers: ${duplicates.map((group) => group.join(' + ')).join('; ')}.`);

// History is append-only: a migration recorded in migration-checksums.json must never change or
// disappear, because databases that already applied it would silently diverge from the repository.
// New files are allowed and reported; `--record-new` appends them (it never rewrites an entry).
const manifest = JSON.parse(await readFile(checksumManifest, 'utf8'));
const changed = [], missing = [], unrecorded = [];
for (const [file, checksum] of Object.entries(manifest.migrations)) {
  if (!files.includes(file)) missing.push(file);
  else if (await migrationChecksum(file) !== checksum) changed.push(file);
}
for (const file of files) if (!(file in manifest.migrations)) unrecorded.push(file);
if (changed.length || missing.length) {
  throw new Error(`Applied migration history must not change. Modified: ${changed.join(', ') || 'none'}; removed: ${missing.join(', ') || 'none'}. Add a new migration instead.`);
}
if (unrecorded.length && process.argv.includes('--record-new')) {
  for (const file of unrecorded) manifest.migrations[file] = await migrationChecksum(file);
  await writeFile(checksumManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Recorded checksums for ${unrecorded.length} new migration(s): ${unrecorded.join(', ')}.`);
} else if (unrecorded.length) {
  console.log(`New migrations without a recorded checksum (record after merge with --record-new): ${unrecorded.join(', ')}.`);
}

console.log(`Verified ${files.length} PostgreSQL migration files (${files.length - unrecorded.length} checksum-locked).`);
