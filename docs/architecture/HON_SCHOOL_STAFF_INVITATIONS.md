# School staff invitations (Sprint 2, migration 0204 provisional)

## Why

Owner-pilot journeys need real staff identities. Before this change:

- The only runtime path that created a school identity was the HQ owner invitation (0191).
- The staff role commands (0059) can only grant a role to a principal that already exists.

So nobody could add a front-desk person or an instructor without a database fixture.

## What it does

1. **Invite.** A staff manager at one school invites one email to one existing custom role at that same school.
   - A staff manager is anyone who holds both `iam.staff_role.manage` and `iam.staff_role.grant` at the school. That includes the school OWNER.
   - The browser generates a 256-bit token and sends it once. The database stores only its SHA-256.
   - The link expires within 1–168 hours (7 days at most).
2. **Deliver.** The manager passes the link to the person outside HON. HON sends no email or text.
3. **Accept.** The invitee signs in with OIDC, with an email the identity provider has verified, and accepts. The database then:
   - re-checks, under the IAM authority locks, that the issuer is still a staff manager at that school and could still grant the role;
   - creates a new identity, or reuses a clean existing one;
   - grants exactly that role at exactly that school.

## Security rules

- **Role eligibility** is the same rule that `iam.staff_role.grant` (0059) applies.
  - The role must belong to the school's organization and be usable at this school.
  - It cannot be a system role, and its code cannot start with OWNER, HON_, HQ, PLATFORM or SYSTEM.
  - It needs at least one permission. Every permission must be staff-assignable and currently held by the issuer at this school.
  - So an invitation can never escalate privilege.
- **Issuer authority is re-proven at acceptance.** If the issuer's grant ends, or the role gains a permission the issuer lacks, an outstanding invitation stops working. It works again if that authority is restored.
- **Identity handling**
  - Accounts are never linked by email alone. A new subject whose email already belongs to another user needs review (409).
  - An existing identity can accept only if all of these hold: it has exactly one active human principal, its stored email matches, and it has no HQ grant, no family grant, no grant in another organization, no current grant at this school, and is not the issuer.
- **Inputs from the session only.** The subject and verified email come only from the signed HON session. The request body can't name an organization, principal, permission list or activation, and the closed validators reject those fields.
- **Exact school.** Revoke and list work only at the manager's exact school. An invitation id from another school returns not-found.
- **Final once accepted.** An accepted invitation can't be revoked. Ending the access goes through the existing `iam.staff_role.revoke` command, which keeps its final-owner-coverage and self-mutation protections.
- **Authority is decided after the last write.** Every time window (grants, paid access, invitation expiry) is judged on `clock_timestamp()`. The final authority check runs after the invitation, role grant and evidence writes, so authority that ends at any instant up to the evidence row aborts the whole statement and nothing durable survives. This holds for invite, revoke, accept and replay. Proof group 11 pins the expiry exactly at that boundary.
- **Concurrency.** It uses the 0191 authority envelope: one advisory lock plus NOWAIT `SHARE ROW EXCLUSIVE` on the IAM tables. Unauthorized callers are refused before they touch those locks. Authorized callers that hit contention get `503 ACCOUNT_BUSY`, which is safe to retry.
- **Storage and evidence**
  - The custody tables use forced RLS with no policies, and the runtime role can't read them.
  - Runtime executes only `manage_school_staff_invitation`, `accept_school_staff_invitation` and `read_school_staff_invitations`.
  - Each (subject, idempotency key) pair is single-use across every account flow, because requests share `hon.school_account_requests`.
  - Audit events are immutable, and `execution_allowed` is always false.
- **Paid access fails closed.** The staff-manager check uses the B6A (0172) live-entitlement predicate. A suspended or lapsed organization, or one whose access hasn't started, cannot invite, revoke or list, and cannot have an outstanding invitation accepted. The entitlement-coverage proof classifies all three entry points as ENFORCED. Owner decision: should this be relaxed, for example to allow read-only listing during the owner CRM read-only window?
- **No commercial effect.** No entitlement, billing, credit or AI table changes. The receipt says so explicitly: `accessGranted`, `billingActivated` and `aiCreditsGranted` are all false.

## API (same-origin human browser only, header `x-hon-human-command: school-staff-account`)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/v1/school/staff-invitations` | `{schoolId, roleId, email, ttlHours, token}` | `StaffInvitation` |
| POST | `/v1/school/staff-invitations/revoke` | `{schoolId, invitationId}` | `StaffInvitation` (REVOKED) |
| POST | `/v1/account/staff-invitations/accept` | `{invitationId, token, confirmation: 'ACCEPT_SCHOOL_STAFF_INVITATION'}` | `StaffAccountReceipt` |
| GET | `/v1/school/schools/:schoolId/staff-invitations` | — | `StaffInvitation[]` (≤ 50, newest first; `EXPIRED` derived) |

POST commands need an `Idempotency-Key` UUID. The contracts and validators are in `packages/contracts/src/school-staff-invitations.ts`.

**Error codes:**

| Status | Code | When |
|---|---|---|
| 400 | `ACCOUNT_INPUT_INVALID` | Request fails validation |
| 403 | `ACCOUNT_FORBIDDEN` | Caller lacks authority, the role isn't grantable, or the invitation is unavailable |
| 403 | `VERIFIED_EMAIL_REQUIRED` | Session has no verified email |
| 404 | `ACCOUNT_UNAVAILABLE` | Invitation not found at this school |
| 409 | `ACCOUNT_REVIEW_REQUIRED` | Identity conflict, or revoking an already accepted invitation |
| 409 | `ACCOUNT_CONFLICT` | Key reused with a different body, or a duplicate pending invitation |
| 429 | `ACCOUNT_RATE_LIMITED` | Too many requests |
| 503 | `ACCOUNT_BUSY` | IAM authority locks are contended; safe to retry |

## Evidence

`packages/database/scripts/test-school-staff-invitations-integrity.mjs` runs as part of `run-db-proofs.sh`, on the disposable Champions fixture. It runs 12 groups through real signed sessions, Nest, the restricted runtime role and PostgreSQL, with no provider.

`apps/api/test/school-staff-invitations.test.cjs` covers the contracts, the guard, the session-only email and the error mapping.

## Not included / follow-ups

- Parent and guardian account linking to an existing family: a separate slice.
- Delivering the invitation link by email or SMS. That needs owner approval of a provider.
- Codex owns the staff screen. It uses the existing custom-role list, and this API.
