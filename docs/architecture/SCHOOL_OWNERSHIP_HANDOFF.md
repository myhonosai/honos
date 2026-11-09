# School ownership: co-owners, primary owner and HQ seats (B-ID-4, migration 0223 proposed)

Status: built as a PR. Not deployed. Migration number 0223 is proposed; the owner confirms it before merge.

## Owner decisions

- 2026-11-08 21:39Z: H-1 to H-5 approved as recommended.
- 2026-11-08 22:59Z: the owner chose **"Keep HQ owner seats"** because HQ needs access to every school and
  organization to fix or change things. This replaces H-1, H-2 and H-3. H-4 and H-5 stand.
- H-6 (a separate, audited, time-limited HQ support access) was offered as the alternative and not chosen.
- H-7 (owner recovery procedure) and H-8 are still open and out of scope.

## Behavior

| Decision | What happens |
| --- | --- |
| HQ seats kept | `provision_school_from_hq` (0185, 0208) is unchanged. It still grants the school `OWNER` role, with no end date, to the HQ person who provisions the school (the "HQ seat"). Accepting an owner invitation leaves every HQ seat alone. Nothing in 0223 ends an HQ seat, and there is no cleanup command. |
| H-4 | A school can have several owners and one primary owner (billing contact and recovery). The first non-HQ owner to accept becomes primary when there is no live primary. An HQ owner can make another live non-HQ owner primary. An HQ seat is never primary. If the primary owner's grant ends, the school shows `primaryNeeded`. |
| H-5 | HQ can invite or add an owner where one exists. Existing owners get an `OWNER_INVITED` notice when the invitation is created and an `OWNER_ADDED` notice when it is accepted. There is no consent step and nothing is emailed or sent. |

A "live non-HQ owner" is a started, unended, unrevoked system `OWNER` grant at the school, held by an active human
principal (the only active principal of its user) with no `hq_operator_grants` row, at an `ACTIVE` school and organization.
HQ seats are shown to HQ as `hqOwnerGrantIds` and are never listed as school owners.

A person with any HQ row (current, expired or future) cannot accept an owner invitation (`ACCOUNT_REVIEW_REQUIRED`).
That is the `staff_member_eligible` rule: HQ people reach a school through their HQ seat, not as invited school owners.

What an HQ seat can do: `resolve_authorized_scope` (0059) does not exclude HQ principals, so paths built on it, for
example the staff-invitation manager (0204), accept the HQ seat holder as a school manager once the school's
entitlement is `ACTIVE`. Paths that use `staff_member_eligible` still refuse HQ principals. The seat belongs to the
person who provisioned the school, not to every HQ owner. The proof records this as current behavior.

## Endpoints

All use the owner-invitation guard (`SchoolAccountHumanGuard`): direct human request, same origin, `no-store`, no
query string. The command also needs `x-hon-human-command: school-owner-account`, JSON and an `idempotency-key`.

| Route | Who | Returns |
| --- | --- | --- |
| `GET /v1/hq/schools/:schoolId/ownership` | HQ owner | `owners[]` (`ownerGrantId`, `displayName`, `email`, `since`, `primary`, `viaInvitation`), `primaryOwnerGrantId`, `primaryNeeded`, `hqOwnerGrantIds` (HQ seats), `notices[]` (50 newest), `asOf` |
| `POST /v1/hq/school-ownership/primary-owner` | HQ owner | body `{schoolId, ownerGrantId}`; receipt `{operation: 'SET_PRIMARY', schoolId, organizationId, primaryOwnerGrantId, changed}` |
| `GET /v1/account/schools/:schoolId/ownership` | a live non-HQ owner of that school | `owners[]`, `yourOwnerGrantId`, `primaryOwnerGrantId`, `notices[]`, `asOf` |

Notice kinds: `OWNER_INVITED`, `OWNER_ADDED` (both with `invitedEmail`), `PRIMARY_OWNER_CHANGED` (`invitedEmail: null`).

Errors: 403 `ACCOUNT_FORBIDDEN`, 404 `ACCOUNT_UNAVAILABLE` or `OWNERSHIP_OWNER_NOT_LIVE`, 409 `ACCOUNT_CONFLICT` (key
reuse, busy), 400 `ACCOUNT_INPUT_INVALID`, 429 rate limited, 503 on response drift. An exact replay of the command
returns the first receipt.

## Data

- `school_primary_owners`: one row per school; only the designation moves, with a version bump. Never deleted.
- `school_ownership_notices`: immutable; one shape per kind.
- `school_ownership_requests`: immutable idempotency claim and receipt for the HQ command.

All three are forced deny-all RLS with no runtime privileges. Only the three entry points are granted to `hon_runtime`.
Every write happens under the existing school-account authority lock (0191), and the HQ-owner authority is checked
again after the last write (0206 rule).

## Also fixed

The lock-free acceptance preflight (`check_school_owner_acceptance`, 0191) runs several READ COMMITTED statements. A
second, concurrent acceptance of the same invitation could read it as `PENDING` and then see the user row the first one
had just committed, and answer `ACCOUNT_REVIEW_REQUIRED` (409) instead of the recoverable busy (503) the contract
promises. The existing 0191 proof caught this once acceptance did more work. The preflight now re-reads the invitation
before that answer and returns `ACCOUNT_BUSY` when it has moved.

## For the UI

- HQ school detail: show owners, the primary badge, `primaryNeeded`, a "Make primary" action per owner, and the HQ
  seats as a separate "HQ access" line (not as owners).
- School owner settings: show co-owners, the primary owner and the notices.

## Out of scope

H-6 audited HQ support access, H-7 owner recovery procedure, giving HQ seats to HQ owners other than the provisioner,
staff-role ownership transfer, any email delivery, and any entitlement, billing, payment or AI-credit change.

## Proof

`packages/database/scripts/test-school-ownership-handoff.mjs` (champions-club, guarded target) and
`apps/api/test/school-ownership.test.cjs`.
