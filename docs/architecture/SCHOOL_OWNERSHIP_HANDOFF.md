# School ownership handoff (B-ID-4, migration 0223 proposed)

Status: built as a draft PR. Not deployed. Migration number 0223 is proposed; the owner confirms it before merge.

Owner decisions H-1 to H-5 were approved as recommended on 2026-11-08. H-6 (break-glass support access), H-7 (owner
recovery procedure) and H-8 are still open and out of scope.

## Problem

`provision_school_from_hq` (0185, 0208) granted the school `OWNER` role to whoever at HQ provisioned the school. The
grant had no end date and nothing ever ended it. The 2026-10-29 audit called it dormant, because `staff_member_eligible`
excludes any principal with an HQ grant row. It is not fully dormant: `resolve_authorized_scope` (0059) does not exclude
HQ principals, so paths built on it, for example the staff-invitation manager (0204), accept the provisioner as a school
manager once the school's entitlement is `ACTIVE`. The proof shows this on a pre-0223 grant and shows it closed after
the handoff.

## Behavior

| Decision | What happens |
| --- | --- |
| H-1 | Provisioning still creates the system `OWNER` role with every permission, but grants it to nobody. The first school owner is bound by an HQ-owner invitation (0191). |
| H-2 | When a school owner accepts an invitation, every `OWNER` grant at that school held by an HQ principal ends in the same statement. An HQ principal is one with any `hq_operator_grants` row, timed or not, the same rule as `staff_member_eligible`. Each ended grant is revoked the way 0059 revokes a staff grant (`effective_until`, `revoked_at`, `revoked_by`) and gets an audit row. Existing owners get a `HQ_OWNER_ACCESS_ENDED` notice. A person with any HQ row (current, expired or future) cannot accept an owner invitation at all (`ACCOUNT_REVIEW_REQUIRED`), so an accepted owner is never ended by the same statement. |
| H-3 | For schools provisioned earlier, an HQ owner reads the list of schools with HQ-held `OWNER` grants (the dry run), then ends them one school at a time. The command refuses a school without a live non-HQ owner (`OWNERSHIP_SCHOOL_OWNER_REQUIRED`) and any plan that differs from the current set (`OWNERSHIP_PLAN_CHANGED`). Nothing ends automatically. |
| H-4 | A school can have several owners and one primary owner (billing contact and recovery). The first owner to accept becomes primary when there is no live primary. An HQ owner can make another live owner primary. If the primary owner's grant ends, the school shows `primaryNeeded`. |
| H-5 | HQ can invite or add an owner where one exists. Existing owners get an `OWNER_INVITED` notice when the invitation is created and an `OWNER_ADDED` notice when it is accepted. There is no consent step and nothing is emailed or sent. |

A "live non-HQ owner" is a started, unended, unrevoked system `OWNER` grant at the school, held by an active human
principal (the only active principal of its user) with no HQ grant row, at an `ACTIVE` school and organization.

## Endpoints

All use the owner-invitation guard (`SchoolAccountHumanGuard`): direct human request, same origin, `no-store`, no
query string; commands also need `x-hon-human-command: school-owner-account`, JSON and an `idempotency-key`.

| Route | Who | Returns |
| --- | --- | --- |
| `GET /v1/hq/schools/:schoolId/ownership` | HQ owner | `owners[]` (`ownerGrantId`, `displayName`, `email`, `since`, `primary`, `viaInvitation`), `primaryOwnerGrantId`, `primaryNeeded`, `hqOwnerGrantIds`, `hqOwnerCleanup {eligible, blocker, expectedGrantIds}`, `notices[]` (50 newest), `asOf` |
| `GET /v1/hq/school-ownership/hq-owner-grants` | HQ owner | the H-3 dry run: `schools[]` (up to 200, oldest school first) with `hqOwnerGrantIds`, `schoolOwnerCount`, `eligible`, `blocker`; `total`, `truncated`, `summary {eligible, needsOwner}`, `asOf` |
| `POST /v1/hq/school-ownership/primary-owner` | HQ owner | body `{schoolId, ownerGrantId}`; receipt `{operation, schoolId, organizationId, primaryOwnerGrantId, changed, endedGrantIds: []}` |
| `POST /v1/hq/school-ownership/end-hq-owner-grants` | HQ owner | body `{schoolId, expectedGrantIds}` (the `hqOwnerCleanup.expectedGrantIds` just read); receipt with `endedGrantIds` |
| `GET /v1/account/schools/:schoolId/ownership` | a live non-HQ owner of that school | `owners[]`, `yourOwnerGrantId`, `primaryOwnerGrantId`, `notices[]`, `asOf` |

Errors: 403 `ACCOUNT_FORBIDDEN`, 404 `ACCOUNT_UNAVAILABLE` or `OWNERSHIP_OWNER_NOT_LIVE`, 409
`OWNERSHIP_SCHOOL_OWNER_REQUIRED`, `OWNERSHIP_PLAN_CHANGED` or `ACCOUNT_CONFLICT` (key reuse, busy), 400
`ACCOUNT_INPUT_INVALID`, 429 rate limited, 503 on response drift. Exact replays of a command return the first receipt.

## Data

- `school_primary_owners`: one row per school; only the designation moves, with a version bump. Never deleted.
- `school_ownership_notices`: immutable; one shape per kind.
- `school_ownership_requests`: immutable idempotency claim and receipt for the two HQ commands.

All three are forced deny-all RLS with no runtime privileges. Only the four entry points are granted to `hon_runtime`.
Every write happens under the existing school-account authority lock (0191), and the HQ-owner authority is checked
again after the last write (0206 rule).

## Also fixed

The lock-free acceptance preflight (`check_school_owner_acceptance`, 0191) runs several READ COMMITTED statements. A
second, concurrent acceptance of the same invitation could read it as `PENDING` and then see the user row the first one
had just committed, and answer `ACCOUNT_REVIEW_REQUIRED` (409) instead of the recoverable busy (503) the contract
promises. The existing 0191 proof caught this once acceptance did more work. The preflight now re-reads the invitation
before that answer and returns `ACCOUNT_BUSY` when it has moved. The preflight and the acceptance also refuse any HQ row, timed or not (review finding P2-184-1).

## For the UI

- HQ school detail: show owners, the primary badge, `primaryNeeded`, and a "Make primary" action per owner.
- HQ cleanup screen: list from `hq-owner-grants`; for eligible rows, call `end-hq-owner-grants` with that row's
  `hqOwnerGrantIds`; for `SCHOOL_OWNER_REQUIRED` rows, link to the owner invitation flow. Re-read after each command.
- School owner settings: show co-owners, the primary owner and the notices.

## Out of scope

H-6 break-glass HQ support access, H-7 owner recovery procedure, staff-role ownership transfer, any email delivery,
and any entitlement, billing, payment or AI-credit change.

## Proof

`packages/database/scripts/test-school-ownership-handoff.mjs` (champions-club, guarded target) and
`apps/api/test/school-ownership.test.cjs`.
