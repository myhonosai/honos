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
