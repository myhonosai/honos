# HQ access overview (B-HQ-1, migration 0219 proposed)

Status: built as a draft PR. Not deployed. Read only. Migration number 0219 is proposed and subject to owner allocation.

## Problem

HQ can read and change one organization's access at a time (`GET /v1/hq/saas/organizations/:id/access`,
`GET|POST /v1/hq/saas/organizations/:id/access-exceptions`), but nothing lists every customer with its access
standing. HQ therefore cannot see which schools have no access (every newly provisioned school starts `SUSPENDED`),
which run on a D9 exception and when it ends, which await a first payment, which are paid, and which can receive an
exception right now. The HQ audit (2026-10-24) and backlog item B-HQ-1 record this gap; C-HQ-1 (the HQ
access-exception screen) and C-HQ-3 (HQ customer management) depend on it.

## Endpoint

`GET /v1/hq/saas/access-overview?status=&cursor=&limit=`

- Authority: the existing SaaS HQ reader rule (`hon.require_saas_hq_actor(subject, false)`): a current HQ owner, or a
  current HQ operator holding `hq.billing.manage`; one active human principal; no live family grant. Everyone else
  gets 403 `SAAS_FORBIDDEN`. Same `SaasReadGuard` as every other SaaS read: direct human request, `GET`, no body,
  `Cache-Control: private, no-store`, and only the three declared query keys.
- `status` (optional): one access status below. `limit`: 1-100, default 50. `cursor`: the previous page's
  `nextCursor`, written `<createdAt>~<organizationId>`. Order: organization `createdAt`, then id.
- Never a write: no audit, outbox, request claim, lock or entitlement change. It reads the same facts the commands
  re-check; it is advisory only, and every command still decides again in the database.

## Response (`data`)

| Field | Meaning |
| --- | --- |
| `viewer.canGrantAndRevokeExceptions` | true only for a current HQ owner (D9: only a human HQ owner grants or revokes) |
| `paidAccessProgram` | `INACTIVE` or `ACTIVE` |
| `exceptionPolicy` | `{ ready, maxDays, validUntil, maxScheduleAheadDays: 30 }`; `ready` false means grants fail with `SAAS_EXCEPTION_POLICY_REQUIRED` until the HQ owner approves the policy (D10) |
| `summary` | count of every organization by access status (not just this page) and `total` |
| `organizations[]` | one row per organization (below) |
| `limit`, `nextCursor`, `asOf` | paging and read time |

Each organization row: `organizationId`, `organizationDisplayName`, `organizationStatus`, `createdAt`,
`schools` (up to 10, `{schoolId, schoolDisplayName, schoolStatus}`), `schoolCount`, `entitlement` (the canonical
entitlement view, with `version` for `expectedEntitlementVersion`), `accessState` (B6A state or `NONE`/`PROVISIONED`),
`accessStatus`, `currentException` (the open exception summary or null), `subscription` (the non-voided
subscription summary or null), `openCheckout`, `ownerOnboarding`, `exceptionGrant`.

`accessStatus` (one value, first match wins):

1. `AWAITING_FIRST_PAYMENT`: B6A awaiting state.
2. `EXCEPTION_IN_EFFECT`: an open exception is in effect.
3. `EXCEPTION_SCHEDULED`: an open exception starts later.
4. `PAID_ACCESS`: payment-activated and in effect.
5. `PROVISIONED_ACCESS`: an entitlement in effect from provisioning (legacy and pre-D9 customers).
6. `NO_ACCESS`: nothing in effect (for example a new school, a lapsed exception, a suspension).

`exceptionGrant`: `{ eligible, blockers[], expectedEntitlementVersion }`. Blockers mirror, in order, the refusals of
`hon.grant_saas_access_exception`: `ORGANIZATION_NOT_ACTIVE`, `NO_ACTIVE_SCHOOL`, `NO_ENTITLEMENT`,
`EXCEPTION_POLICY_REQUIRED`, `ACCESS_EXCEPTION_ACTIVE`, `ENTITLEMENT_IN_EFFECT`, `ACCESS_STATE_EXISTS`,
`SUBSCRIPTION_EXISTS`, `CHECKOUT_OPEN`. It never considers the viewer: an operator sees the same eligibility but
`viewer.canGrantAndRevokeExceptions` is false.

`currentException`: `{ exceptionId, schoolId, purpose, scopeTier, startsAt, expiresAt, lifecycle, revocable }` for the
organization's one `GRANTED` exception (lifecycle `IN_EFFECT`, `SCHEDULED`, `EXPIRED` or `SUPERSEDED`); `revocable`
is true for `IN_EFFECT` and `SCHEDULED`. Full history stays on the per-organization exceptions read.

`ownerOnboarding`: `{ status, invitedAt, expiresAt, acceptedAt }` from the latest HQ school-owner invitation (0191):
`NOT_INVITED`, `PENDING`, `EXPIRED`, `ACCEPTED` or `REVOKED`. No email address or token is returned.

## Out of scope

No grant, revoke or close change (those routes exist). No AI credits, payments, prices or provider data. No school
staff exposure. The HQ ownership handoff (B-ID-4) is a separate slice that needs owner decisions H-1 to H-5.

## Proof

`packages/database/scripts/test-hq-access-overview.mjs` (champions-club fixture, restricted runtime role) and
`apps/api/test/hq-access-overview.test.cjs` (contract and route guard).
