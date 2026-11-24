# Class sessions function-only reads (#177, 0632)

Source: the launch-readiness review pinned to main `0d476427` lists issue **#177** under "canonical privilege and migration integrity". Owner decision (David, 2026-11-22, decision card): **lock it down**.

## Problem (verified on main `094b18dd`)

- 0147 revoked runtime SELECT on `hon.class_sessions`. It made the named projection `hon.read_current_school_class_sessions` the only session read.
- The canonical grants in `infra/postgres/010_supabase_hon_runtime.sql` still granted `hon_runtime` SELECT on the table. That script runs after migrations in production and in most fixtures. Only the class-sessions-read fixture narrowed the grant again.
- Forced RLS kept every read inside the tenant, so this was a mismatch between the stated posture and the proofs, not a leak.
- Three runtime paths depended on the grant:
  - the operations report's session and attendance counts;
  - the parent family schedule;
  - class creation, through `INSERT ... RETURNING`, which needs SELECT.

## Contract

- **CS1** `hon.read_operations_report_session_counts(subject, from, to)` returns only the eight counts: scheduled, completed and cancelled sessions, and attendance by status, for the current school. It works only when `hon.resolve_authorized_scope(subject, school, 'reporting.view')` returns this transaction's own principal, in the current organization and school. That is the same check the report controller makes. The other report counts are unchanged and still come from tables the runtime can read.
- **CS2** `hon.read_parent_family_schedule(subject, family, from, to)` returns the same fields, through the same relation path, as the SQL the service used before. It works only when `hon.resolve_parent_family_scope(subject, school)` returns that family for this transaction's own principal. A forged scope, or another person's subject, gets 403.
- **CS3** Both reads, and their private guard `hon.require_class_sessions_human_read()`, refuse with 42501 `CLASS_SESSIONS_READ_FORBIDDEN` before reading anything when:
  - there is no tenant context or principal;
  - the principal type is not `HUMAN_USER`;
  - the command is an action request or a delegated command.

  The services map only that refusal to 403. Any other 42501, such as a missing grant, stays a server error.
- **CS4** The runtime has INSERT but no table or column SELECT on `hon.class_sessions`, and both 0632 and 010 say so. Class creation now chooses the id itself and inserts without RETURNING. It confirms the stored instants and the creation time with `$1::timestamptz, $2::timestamptz, now()` in the same transaction, and uses the column defaults SCHEDULED and version 1. The response shape is unchanged.
- **CS5** The runtime gains EXECUTE on the two reads only. The `011` section pins:
  - the body md5, volatility, definer posture, search path and ACL of all three functions;
  - INSERT-only runtime access to the table.

## Proofs

- `test-operations-report-security.mjs` runs on the crm-lead-close fixture and is now in CI. Exact counts are unchanged through the definer read.
  - A direct runtime SELECT is refused with 42501, and the runtime has no table or column SELECT.
  - The session read refuses a transaction that has no human principal.
  - The `011` section passes, and fails when the old SELECT grant is restored.
  - The old fixture was also repaired: it now has an entitlement row, sets the attendance progression flag, and cleans up lead attributions.
- `test-parent-family-schedule-security.mjs` is now in CI. The projection is unchanged, cross-family access is denied, and the definer read refuses a forged family scope and another person's subject with 403.
- `test-owner-launch-integrity.mjs` creates classes through `ClassSessionService` with table snapshots.
- `test-class-session-pages-integrity.mjs` and the class-sessions-read fixture proofs are unchanged.

## Not changed

These paths already read through definer functions and are unchanged: the 0147 projection, forward paging, rosters, booking locks, the kiosk and parent booking. RLS and forced RLS on `hon.class_sessions` are unchanged. No data, sends, charges or providers are touched.
