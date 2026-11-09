# HQ school detail (C-HQ-3, migration 0225 proposed)

Status: built as a PR. Not deployed. Migration number 0225 was approved by the owner on 2026-11-09.

## What it is

One read-only HQ page per school, at `/hq/schools/[schoolId]`, linked from the School Directory. It brings together
what HQ needs to fix or change a school: its access standing, owners, invitations and how many people use it. It names
no person: no names, emails, birth dates, subjects or tokens. It writes nothing and changes no command.

## API

`GET /v1/hq/saas/schools/:schoolId` (SaaS read guard: GET, no query string, `private, no-store`).

Readers: an HQ owner, or an HQ operator with `hq.billing.manage` (the reader rule of every SaaS HQ read). Authority is
checked before the read and again after it (0206 rule). Errors: 403 `SAAS_FORBIDDEN`, 404 `SAAS_UNAVAILABLE` (no such
school; only after authority passed), 400 `INVALID_SAAS_INPUT`, 503 on response drift.

| Field | Meaning |
| --- | --- |
| `school` | id, display name (300 chars max), slug, time zone, status, created |
| `organization` | exactly the B-HQ-1 access overview row (0219) for the school's organization |
| `exceptionPolicyReady` | whether an approved access exception policy is in effect |
| `ownership` | `ownerCount` (live non-HQ owner grants), `primaryOwnerGrantId`, `primaryNeeded`, `hqSeatCount` (0223) |
| `invitations.owner/staff/family` | `pending` (unexpired), `expired` (pending past expiry), `accepted`, `revoked`, `ended` (family only) |
| `people` | `staffWithAccess` (distinct non-HQ principals with a live role grant, owners included), `familyMembersWithAccess`, `activeStudents` |
| `viewer` | `canGrantAndRevokeExceptions` and `canManageOwnership`: true for the HQ owner only |

## Page

Read only. Links onward to School access (`/hq/schools/access`), School owners (`/hq/schools/owners`) and Owner
invitations (`/hq/school-owner-invitations`), where the existing commands live. Leaving the tab or a session end hides
everything; "Show again" reads fresh. English, Korean and Spanish.

## Proof

`packages/database/scripts/test-hq-school-detail.mjs` (champions-club), `apps/api/test/hq-school-detail.test.cjs`,
`apps/web/test/hq-school-detail-ui.test.tsx`.
