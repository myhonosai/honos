# Membership date revisions (E1b-1, migration 0178)

E1b-1 lets authorized school staff change the school-local dates of a confirmed (ACTIVE) membership through a two-step, direct-human command, and adds a membership status summary that never hides an ACTIVE membership whose dates were never confirmed. It builds on the E1a activation gate ([MEMBERSHIP_ACTIVATION_GATE.md](MEMBERSHIP_ACTIVATION_GATE.md)) and does not change any 0177 evidence or contract.

**Not deployed. Not activated.** This document describes code and disposable-database proofs only. The frontend is Codex-owned; see [MEMBERSHIP_DATE_REVISIONS_CODEX_HANDOFF.md](MEMBERSHIP_DATE_REVISIONS_CODEX_HANDOFF.md).

## Owner decisions implemented (E1b-D1..D10)

| Decision | Implementation |
| --- | --- |
| D1 permissions | `billing.membership.dates.revise` and `billing.membership.dates.retroactive`, both sensitive and staff-assignable. 0178 grants them to system `OWNER` roles only. Owners delegate them per school through the existing role/grant model; every call re-checks them live at the route school. |
| D2 retroactive changes | Any revision that changes whether a past school-local day (before today) was in effect counts those days (`retroactiveDays.added/removed`), adds the `RETROACTIVE_CHANGE` warning, and needs both permissions plus a reason, two-step confirmation and the immutable revision row. |
| D3 shortening with money | A PAID invoice is disclosed (`PAID_INVOICE_NOT_REFUNDED_OR_CREDITED`), must be acknowledged, and creates one `BILLING_REVIEW` work item. A payment schedule or open invoice that would fall outside the new dates refuses the revision. Nothing refunds, credits or changes money. |
| D4 extension suggestions | A fixed-term EXTENSION suggests the next end anchored to the confirmed original start (`start + k*N months - 1 day`, the same month-end arithmetic as E1a). It is never applied automatically; different dates need `dateAdjustmentReason`. |
| D5 cancelled | Only ACTIVE memberships can be revised; CANCELLED (and every other state) returns the `MEMBERSHIP_NOT_ACTIVE` block. |
| D6 ended memberships | Extending an ENDED membership is allowed. It adds past days, so it needs the retroactive permission, and it warns `EXTENDS_ENDED_MEMBERSHIP`. It is not a paid renewal. |
| D7 legacy queue | ACTIVE memberships with no confirmed period are listed one at a time in the date-confirmation queue and confirmed individually with `INITIAL_CONFIRMATION`. Stored pre-0177 instants are shown as unconfirmed hints only. No bulk action, no fabricated dates. |
| D8 numbering | E1b-1 = 0178 (this). E1b-2 = 0179, E1c = 0180 are not started. |
| D9 health score | Unchanged in E1b-1. V2 (excluding DRAFT) belongs to E1b-2. |
| D10 parent visibility | **Unchanged in E1b-1.** Internal membership DRAFTs must be hidden from parents until a future explicit, authorized, school-scoped publication action. Publication must never be inferred from the existence of a DRAFT, billing account or registration. The parent billing view is not modified here; this is recorded for E1b-2 and as a deployment prerequisite below. |

## Database objects

- `hon.membership_date_revisions`: one immutable row per revision. It holds the decision (actor, kind, reason, acknowledged warnings, retroactive days, financial facts seen, digest, idempotency key and fingerprint, receipt) and the resulting effective period (`period_version`, school-local `start_date`/`end_date` inclusive, school timezone, projected instants). `prior_membership_version`/`next_membership_version` bind it to exactly one membership row version. Private, forced RLS, no runtime privilege; UPDATE/DELETE/TRUNCATE raise `IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE` via the 0177 evidence guard.
- `hon.membership_date_revision_follow_ups`: the `BILLING_REVIEW` work-item link, equally immutable.
- `hon.guard_membership_date_revision_insert()`: a settings-free insert guard. A row is accepted only when it is exactly the next period version of an ACTIVE membership whose current row version equals `prior_membership_version`, and its prior dates equal the current confirmed period. Forged or replayed rows raise `MEMBERSHIP_DATE_REVISION_DENIED`.
- `hon.guard_membership_state_transition()` (0177 body replaced): exactly one new branch. An ACTIVE→ACTIVE update may change only `term_started_at`, `term_ends_at` and `version` (by +1), and only when the latest revision row matches the old and new values exactly. Every other 0177 rule is byte-for-byte unchanged (the proof compares the body against the 0177 body plus this branch). No caller-controlled setting is consulted.
- `hon.membership_lifecycle_permission` / `hon.require_membership_lifecycle_actor` (0177 bodies replaced): identity rules unchanged; the allow-list gains the two date permissions, `billing.membership.read` (history) and `reporting.view` (status summary).
- Private helpers: `membership_instant_text`, `membership_next_anchored_term_end`, `membership_date_revision_retroactive_days`, `membership_current_period`, `membership_reporting_status`, `evaluate_membership_date_revision`.
- Runtime entry points (SECURITY DEFINER, EXECUTE only to `hon_runtime`):
  - `preview_membership_date_revision(subject, membership, input)`: read-only, lock-free, no DML.
  - `revise_membership_dates(subject, membership, input, key, request, correlation)`: the only writer.
  - `read_membership_date_history(subject, membership)`, `read_membership_date_confirmation_queue(subject, input)`, `read_school_membership_status_summary(subject)`: read-only, no DML.

The runtime role still has only SELECT and the 7-column DRAFT INSERT on `hon.memberships` (D41 option C). 0178 grants no table privilege to anyone. `010` revokes everything on the new tables and helpers and grants EXECUTE on the five entry points; `011` verifies tables, 12 functions (signature, definer, config, body hash), 5 triggers and both permission definitions.

## Revision flow

1. **Preview** with `{changeKind}` (suggested dates, when HON has a suggestion) or `{changeKind, startDate, endDate}`. The database resolves the actor from the verified subject, checks `dates.revise` live at the school, and returns facts: current period or legacy stored term, suggestion and its basis, proposed dates and `dateSource` (`SUGGESTED`, `STAFF_ADJUSTED`, `STAFF_ENTERED`), projected instants, effective status now and if confirmed now, retroactive days, financial facts (up to 20 schedules and invoices), sorted warnings and blocks, required permissions, the not-evaluated list, `canConfirm` and `previewDigest` (SHA-256 of the facts).
2. **Confirm** with `Idempotency-Key`, `expectedVersion`, `expectedPeriodVersion` (null exactly for INITIAL_CONFIRMATION), `previewDigest`, the same kind and dates, the server-derived `dateSource`, `dateAdjustmentReason` when STAFF_ADJUSTED, exactly the warning codes listed, `reasonCode` from the kind's list, `reasonText` (10–500 characters, always required) and the confirmation constant. The function re-derives the facts under locks; any difference is `DATE_REVISION_PREVIEW_STALE`.

Kinds: `INITIAL_CONFIRMATION` (no confirmed period yet), `CORRECTION`, `EXTENSION` (same start, later or open end), `EARLY_END` (same start, earlier end). Shape violations block with `CHANGE_KIND_SHAPE_MISMATCH` / `CHANGE_KIND_NOT_APPLICABLE`.

### Lock order (`revise_membership_dates`)

Key reservation → IAM tables SHARE → `billing_accounts` SHARE → `memberships` ROW EXCLUSIVE, then the row `FOR NO KEY UPDATE` (so an invoice insert's foreign-key KEY SHARE is not blocked) → plan tables SHARE → `membership_payment_schedules`, `invoices` SHARE → renewal tables SHARE → evidence, work item, projection, follow-up, audit, inert outbox, idempotency completion → a final live re-check of both permissions after every write. See [CRM_OWNER_LAUNCH_LOCK_ORDER.md](CRM_OWNER_LAUNCH_LOCK_ORDER.md).

### Idempotency

An exact retry with the same key and the same request fingerprint returns the stored receipt with `replayed: true` and writes nothing; a different request with the same key is `IDEMPOTENCY_KEY_REUSED`; a concurrent identical request waits and replays. Two staff confirming the same preview with different keys produce exactly one revision; the other gets `VERSION_CONFLICT`, `PERIOD_VERSION_CONFLICT` or `DATE_REVISION_PREVIEW_STALE`.

## Dates

All dates are school-local calendar dates with an **inclusive** end. The projection stores `term_started_at` = local midnight of the start date and `term_ends_at` = local midnight of the day after the end date, using the E1a helpers (`membership_local_day_start`), so DST transitions and zones that skip midnight are handled (proofs: Los Angeles spring-forward and fall-back, Santiago's skipped midnight, 29 February starts, month-end anchoring: a 1-month plan started 31 January with a confirmed end of 27 February suggests 30 March as the next anchored end).

Reporting statuses: an ACTIVE membership with a confirmed period is `SCHEDULED`, `IN_EFFECT` or `ENDED`; an ACTIVE membership without one is `UNDATED` even if legacy instants are stored; other lifecycle states are returned as stored (`DRAFT`, `FROZEN`, `CANCELLATION_PENDING`, `CANCELLED`, `EXPIRED`).

## Status summary

`GET …/reports/membership-status` (`reporting.view`) returns lifecycle totals exactly as stored, the ACTIVE split (`SCHEDULED + IN_EFFECT + ENDED + UNDATED = ACTIVE`), unconfirmed hints for UNDATED rows (`storedTermInEffect + storedTermEnded + storedTermFuture + noStoredStart = UNDATED`) and confirmed starts/ends in the next 30 school-local days. No names, money or reasons. It is a new route; the operations report and every other V1 response are unchanged.

## Financial boundary

A revision never collects money, creates or changes an invoice, changes a schedule, refunds, credits, changes a payment method, price, agreement, consent or payer, calls a provider, sends a communication, or touches HON SaaS billing or entitlements. The receipt's `financialEffects` is always `[]`. The outbox event `billing.membership.dates_revised` carries `executionAllowed: false`, `humanOnly: true`. The proof snapshots 62 money, entitlement and agreement tables before and after every path and asserts they are unchanged except for the documented work item.

## Proofs

- `packages/database/scripts/test-membership-date-revision-integrity.mjs` (CI, 329 assertions): posture and exact bodies; forged settings, forged and replayed history rows, history immutability; 0177 protections; permission matrix including revocation before confirmation, during the IAM wait and before replay; retroactive permission; digest, acknowledgement, date-source, version and period-version refusals; exact retry, concurrent replay, key reuse, parallel staff; dates, DST, leap years and month ends; kinds and ended/cancelled memberships; schedule and invoice conflicts and disclosures; legacy queue, summary totals and INITIAL_CONFIRMATION; races with invoice creation, cancellation, renewal and retention acknowledgement in both orders without new deadlocks; the 16 V1 reader bodies equal their pre-0178 definitions.
- `test-membership-activation-gate-integrity.mjs` (CI): still passes against the replaced bodies.
- `test-crm-owner-launch-lock-order-integrity.mjs` (CI): the revision joins the matrix as a 19th workflow.
- `apps/api/test/membership-date-revision.test.cjs`: guards, headers, DTO whitelist, error mapping, no DML in the service.
- `verify-rls.mjs` tracks both new tables.

## Deployment prerequisites and risks

Do not deploy E1b-1 on its own. All E1a blockers still apply:

1. The known-minor adult registration recovery issue must be resolved first.
2. Persistent migration history must be verified (0159–0177 applied exactly, the PR #27 filename gate) before 0178.
3. Release must be coordinated with the Codex frontend (E1a two-step activation and the E1b date UI). Without the UI, the routes exist but are unused.

E1b-1 specific:

- **D10 (owner decision):** before any parent-facing release that could show memberships, implement the explicit, authorized, school-scoped publication action and hide internal DRAFTs from parents (E1b-2). E1b-1 leaves the parent billing view unchanged.
- 0178 refuses to apply unless the 0177 trigger and the three replaced 0177 bodies are exactly the reviewed ones (hash-checked). Apply `010` then `011` immediately after.
- Applying 0178 takes a brief catalog lock on the replaced functions and the memberships trigger function; in-flight activations finish on the old body. Apply in a quiet window.
- Only system OWNER roles receive the new permissions. Owners must delegate them deliberately; nothing is auto-granted to managers.
- Existing ACTIVE memberships without a confirmed period appear as UNDATED and in the queue. That is intended (D7); expect a one-time confirmation workload per school.
- Manual fixtures that write non-DRAFT memberships now go through `membershipFixtureQuery` / `membershipFixtureStatement`, which only run as the owner of a marked disposable database.
