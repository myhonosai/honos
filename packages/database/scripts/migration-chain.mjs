import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const migrationsDirectory = new URL('../migrations/', import.meta.url);
export const checksumManifest = new URL('../migration-checksums.json', import.meta.url);

// Filenames recorded by earlier drafts of Manus PR #27 before renumbering (see migrate.mjs and
// docs/architecture/CRM_ADULT_DRAFT_MAIN_INTEGRATION.md). Their presence needs a reviewed baseline.
export const SUPERSEDED_CRM_FILENAMES = ['0152_flexible_billing_accounts.sql', '0153_crm_lead_registration.sql', '0154_staff_curriculum_enrollment_preparation.sql',
  '0155_crm_adult_membership_draft.sql', '0158_flexible_billing_accounts.sql', '0159_crm_lead_registration.sql', '0160_staff_curriculum_enrollment_preparation.sql',
  '0161_crm_adult_membership_draft.sql', '0162_crm_adult_membership_draft_confirmation.sql'];

export async function repositoryMigrations() {
  return (await readdir(migrationsDirectory)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
}

export async function migrationChecksum(file) {
  return createHash('sha256').update(await readFile(join(migrationsDirectory.pathname, file))).digest('hex');
}

export function duplicateNumbers(files) {
  const seen = new Map();
  for (const file of files) seen.set(file.slice(0, 4), [...(seen.get(file.slice(0, 4)) ?? []), file]);
  return [...seen.values()].filter((group) => group.length > 1);
}

// Pure comparison of the repository chain with a database's hon.schema_migrations ledger.
export function compareChain(repositoryFiles, appliedFiles) {
  const repository = new Set(repositoryFiles);
  const applied = new Set(appliedFiles);
  const latestApplied = [...applied].filter((file) => repository.has(file)).sort().at(-1) ?? null;
  const pending = repositoryFiles.filter((file) => !applied.has(file));
  return {
    appliedCount: applied.size,
    repositoryCount: repositoryFiles.length,
    latestApplied,
    pending,
    // Pending files numbered below the newest applied file run out of order (for example a reserved
    // gap such as 0179/0180 landing later). Each needs a reviewed statement that it is order-independent.
    outOfOrderPending: latestApplied ? pending.filter((file) => file < latestApplied) : [],
    // Applied in the database but absent from this checkout: a newer or divergent build migrated it.
    unknownApplied: [...applied].filter((file) => !repository.has(file) && !SUPERSEDED_CRM_FILENAMES.includes(file)).sort(),
    supersededApplied: SUPERSEDED_CRM_FILENAMES.filter((file) => applied.has(file)),
  };
}

/**
 * Applies one migration and records it in hon.schema_migrations in the SAME transaction.
 *
 * Every accepted migration file is exactly `BEGIN; ... COMMIT;` (verify-migrations.mjs enforces this and the bytes are
 * checksum-locked). Sending the file as-is commits the migration before the ledger INSERT, so a crash or lost connection
 * between the two leaves the change applied but unrecorded, and the next run replays non-idempotent SQL. Instead the
 * in-memory text loses only its final `COMMIT;` (the file is untouched), the ledger row is written inside the migration's
 * own transaction, and one COMMIT publishes both. Any failure rolls both back.
 */
const TRANSACTION_CONTROL = new RegExp(String.raw`^\s*(?:(?:COMMIT|ABORT|ROLLBACK)(?:\s+(?:WORK|TRANSACTION))?(?:\s+AND\s+(?:NO\s+)?CHAIN)?`
  + String.raw`|(?:COMMIT|ROLLBACK)\s+PREPARED\s+'[^']*'|PREPARE\s+TRANSACTION\s+'[^']*'`
  + String.raw`|START\s+TRANSACTION\b[^;]*|BEGIN(?:\s+(?:WORK|TRANSACTION|ISOLATION|READ|NOT|DEFERRABLE)\b[^;]*)?)\s*;`, 'im');

export function withoutFinalCommit(file, sql) {
  const trimmed = sql.trimEnd();
  if (!sql.trimStart().startsWith('BEGIN;') || !trimmed.endsWith('COMMIT;')) {
    throw new Error(`${file} must use an explicit BEGIN/COMMIT transaction.`);
  }
  const body = trimmed.slice(0, -'COMMIT;'.length);
  // A second transaction-control statement would commit part of the file early and defeat the atomic ledger row.
  // Every PostgreSQL spelling that ends or starts a top-level transaction at the start of a line is refused: COMMIT,
  // END-free ABORT/ROLLBACK (with WORK/TRANSACTION and AND [NO] CHAIN), two-phase PREPARE/COMMIT/ROLLBACK PREPARED,
  // START TRANSACTION and BEGIN with any options. ROLLBACK TO [SAVEPOINT] stays allowed. A bare `END;` cannot be told
  // apart from the end of a PL/pgSQL block, so it is left to review (inside a DO body it is the block's END).
  if (TRANSACTION_CONTROL.test(body.slice(body.indexOf('BEGIN;') + 'BEGIN;'.length))) {
    throw new Error(`${file} contains more than one transaction boundary.`);
  }
  return body;
}

export async function applyMigrationAtomically(client, file, sql) {
  if (!/^\d{4}_[A-Za-z0-9_]+\.sql$/.test(file)) throw new Error(`Unexpected migration filename: ${file}`);
  const body = withoutFinalCommit(file, sql);
  try {
    await client.query(body);
    await client.query('INSERT INTO hon.schema_migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
