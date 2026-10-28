// Read-only migration status for any HON database (including production, with owner approval).
// It never writes: the session is READ ONLY and the only statement reads hon.schema_migrations.
// Prefer a read-only role: HON_MIGRATION_STATUS_DATABASE_URL, falling back to DATABASE_URL.
// Output contains file names and counts only, never connection details.
//   pnpm db:status                 report; exit 1 on unknown/superseded history
//   pnpm db:status --require-current  also exit 1 when anything is pending
import pg from 'pg';
import { verifiedDatabaseConnection } from '../dist/index.js';
import { compareChain, repositoryMigrations } from './migration-chain.mjs';

const url = process.env.HON_MIGRATION_STATUS_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set HON_MIGRATION_STATUS_DATABASE_URL (preferred, read-only role) or DATABASE_URL.');
const requireCurrent = process.argv.includes('--require-current');

const client = new pg.Client({ ...verifiedDatabaseConnection(url), application_name: 'hon-migration-status' });
await client.connect();
let applied;
try {
  await client.query("BEGIN READ ONLY; SET LOCAL statement_timeout = '10s'");
  const exists = (await client.query("SELECT to_regclass('hon.schema_migrations') IS NOT NULL AS present")).rows[0].present;
  applied = exists ? (await client.query('SELECT filename FROM hon.schema_migrations ORDER BY filename')).rows.map((row) => row.filename) : [];
  await client.query('ROLLBACK');
} finally {
  await client.end();
}

const status = compareChain(await repositoryMigrations(), applied);
const lines = [
  `Repository migrations: ${status.repositoryCount}`,
  `Applied in database:   ${status.appliedCount}`,
  `Latest applied:        ${status.latestApplied ?? 'none'}`,
  `Pending:               ${status.pending.length}${status.pending.length ? ` (${status.pending.join(', ')})` : ''}`,
  `Out-of-order pending:  ${status.outOfOrderPending.length}${status.outOfOrderPending.length ? ` (${status.outOfOrderPending.join(', ')})` : ''}`,
  `Unknown applied:       ${status.unknownApplied.length}${status.unknownApplied.length ? ` (${status.unknownApplied.join(', ')})` : ''}`,
  `Superseded CRM ledger: ${status.supersededApplied.length}${status.supersededApplied.length ? ` (${status.supersededApplied.join(', ')})` : ''}`,
];
const conflict = status.unknownApplied.length > 0 || status.supersededApplied.length > 0;
const verdict = conflict ? 'FAIL: database history diverges from this build; do not migrate or deploy.'
  : status.pending.length ? (requireCurrent ? 'FAIL: migrations pending.' : 'PENDING: run reviewed migrations before deploying this build.')
    : 'PASS: database is at this build\'s migration level.';
console.log([...lines, verdict].join('\n'));
if (conflict || (requireCurrent && status.pending.length)) process.exitCode = 1;
