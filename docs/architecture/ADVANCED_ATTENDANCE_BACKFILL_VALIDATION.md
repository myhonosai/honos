# Advanced Attendance 0114 Backfill / 0115 Command Validation

Unchanged `0114_advanced_attendance_management.sql` has a **separate disposable localhost proof** for its legacy attendance backfill. The same proof then validates additive `0115_attendance_command_boundary.sql`. It never reuses `hon_attendance_validation`.

## Guarded execution

Run from the repository root. Choose a private job directory and replace `<private-job-dir>` below.

```bash
JOB_DIR=/home/ubuntu/jobs/<private-job-dir>
mkdir -p "$JOB_DIR"
umask 077
env -u DATABASE_URL -u HON_RUNTIME_DATABASE_URL \
  -u OPENAI_API_KEY -u OPENAI_BASE_URL -u OPENAI_API_BASE -u OPENROUTER_API_KEY \
  HON_ATTENDANCE_BACKFILL_VALIDATION_TARGET=postgresql://localhost:5432/hon_attendance_backfill_validation \
  HON_ATTENDANCE_BACKFILL_ENV_FILE="$JOB_DIR/attendance-backfill.env" \
  pnpm db:setup-attendance-backfill
. "$JOB_DIR/attendance-backfill.env"
env -u OPENAI_API_KEY -u OPENAI_BASE_URL -u OPENAI_API_BASE -u OPENROUTER_API_KEY \
  pnpm db:test-attendance-backfill
rm -f "$JOB_DIR/attendance-backfill.env"
```

The setup command refuses inherited database URLs, anything other than the exact marked `localhost:5432/hon_attendance_backfill_validation` target, non-job-directory credential files, and provider/payment/execution environment switches. It creates only these marked roles:

- migration owner: `hon_attendance_backfill_owner` (local migration-only `BYPASSRLS` owner)
- runtime: `hon_attendance_backfill_runtime` (restricted `NOBYPASSRLS` login)

Generated passwords are written mode `0600` only to the requested job env file and are never printed. Clear any other inherited provider/payment/execution variable in the same way; the guard intentionally fails closed rather than silently ignoring one. The proof explicitly exercises rejection of remote and unmarked aliases, then rejects unmarked databases/roles and provider/external/execution environment variables.

## What the proof executes

`db:test-attendance-backfill` uses the regular ordered migration runner, not a hand-made schema:

1. applies migrations `0001` through `0113` under the local migration owner;
2. applies the pre-0114-compatible canonical runtime grants twice;
3. proves the pre-0114 attendance enum/table shape, then seeds five legacy rows over two schools using the actual legacy statuses plus a genuine historical fingerprint/receipt;
4. runs the normal migration runner once more so it applies unchanged `0114` and additive `0115` once each, then reapplies the full canonical least-privilege grants twice and runs `verify-rls` with the exact localhost URLs;
5. verifies actual backfill values, immutable original record fields, forced RLS and the unchanged snapshot trigger; denies raw runtime INSERT and UPDATE even with complete valid human/tenant GUCs; denies raw command mismatched request/correlation, AI, action and delegation contexts; proves genuine `AttendanceService` create/correction each produce one matching completed receipt, safe audit and schema-v2 inert outbox; and verifies the pre-0114 receipt replays its historical state after correction (but cannot replay a different category); and
6. proves no unrelated domain rows or external/network effects, then drops the marked database and both marked roles in `finally` (including when an assertion fails).

The final `rm` removes the now-stale private credential file after teardown. Do not substitute a remote URL, existing attendance validation aliases, a shared env file, or production credentials.

The guarded backfill/boundary proof passed locally after this repair. The final workspace regression also passed: root `pnpm test` (199 tests), `pnpm check`, `pnpm build` and `git diff --check`. No protected project database, provider credential, remote migration, deployment or external execution was used.
