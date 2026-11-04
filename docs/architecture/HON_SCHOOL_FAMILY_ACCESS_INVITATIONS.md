# Parent and guardian account linking (Sprint 2, migration 0205 provisional)

## Why

Parents need to sign in to see their own family. Before this change:

- Families, guardians and children could be created by staff (0134, 0160, 0176), but those records are CRM people, not sign-in identities.
- Every parent read (`resolve_parent_family_scope`, 0025) needs a row in `hon.family_access_grants`, and no runtime path created one.

So no parent could use the parent screens without a database fixture.

## What it does

1. **Invite.** A family manager at one school invites one email to one existing, active family at that same school, with one access level (`PRIMARY_GUARDIAN`, `SECONDARY_GUARDIAN` or `VIEWER`).
   - A family manager holds both `family.member.manage` and `family.read` at the school. That includes the school OWNER.
   - The browser generates a 256-bit token and sends it once. The database stores only its SHA-256.
   - The link expires within 1–168 hours.
2. **Deliver.** The manager passes the link to the parent outside HON. HON sends no email or text.
3. **Accept.** The parent signs in with OIDC, with an email the identity provider has verified, and accepts. The database then:
   - re-checks, under the IAM authority locks, that the issuer is still a family manager at that school and the family is still active there;
   - creates a new identity, or reuses a clean existing one;
   - inserts exactly one `family_access_grants` row for exactly that family and access level.
4. **End.** The manager can later end the access an invitation created. The grant gets `effective_until = now`; the parent loses the family from their scope immediately.

## Security rules

- **Exact school and family.** The family must belong to the manager's exact school and be `ACTIVE`. A family from another school, a missing one and an archived one all return the same not-found.
- **Issuer authority is re-proven at acceptance.** If the issuer's grant ends, the organization's paid access lapses, or the family is archived, an outstanding invitation stops working. It works again if that is restored.
- **Identity handling**
  - Accounts are never linked by email alone. A new subject whose email already belongs to another user needs review (409).
  - An existing identity can accept only if: it has exactly one active human principal, its stored email matches, it is not the issuer, and it has no HQ grant, **no live staff role grant anywhere**, no live family grant in another organization and no live grant to this same family.
  - A parent can be linked to a second family in the same organization (for example a blended family) through a second invitation.
  - The staff invitation flow (0204) refuses identities that hold any family grant, and this flow refuses identities that hold any staff role. Mixed staff/parent identities are an owner decision (below).
- **Inputs from the session only.** The subject and verified email come only from the signed HON session. The request body can't name an organization, principal, student, role or activation; the closed validators reject those fields.
- **No staff permission.** A linked parent gets only parent scope for that family. `resolve_authorized_scope` returns nothing for them.
- **Ending access** affects only the grant that invitation created, needs the explicit confirmation `END_FAMILY_ACCESS`, and is idempotent. A replayed acceptance never revives ended access. A fresh invitation can relink the same person.
- **Concurrency.** It uses the 0191 authority envelope: one advisory lock plus NOWAIT `SHARE ROW EXCLUSIVE` on the IAM tables, including `family_access_grants`. The family row is held `FOR SHARE`. Unauthorized callers are refused before they touch those locks. Authorized callers that hit contention get `503 ACCOUNT_BUSY`, which is safe to retry.
- **Storage and evidence**
  - The custody tables use forced RLS with no policies, and the runtime role can't read them.
  - Runtime executes only `manage_school_family_access_invitation`, `accept_school_family_access_invitation` and `read_school_family_access_invitations`.
  - Each (subject, idempotency key) pair is single-use across every account flow, because requests share `hon.school_account_requests`.
  - Audit events are immutable, and `execution_allowed` is always false. Invitations allow only PENDING→ACCEPTED, PENDING→REVOKED and ACCEPTED→ENDED.
- **Paid access fails closed.** The family-manager check uses the B6A (0172) live-entitlement predicate. A suspended or lapsed organization cannot invite, revoke, end, list, or have an outstanding invitation accepted. Already-linked parents keep their existing scope; what they can read during a suspension is decided by each parent read, not by this slice.
- **No commercial effect.** No entitlement, billing, credit, AI, CRM, student or outbox table changes. The receipt says so: `accessGranted`, `billingActivated` and `aiCreditsGranted` are all false (they refer to paid access, not to the family link).

## API (same-origin human browser only, header `x-hon-human-command: school-family-account`)

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/v1/school/family-access-invitations` | `{schoolId, familyId, accessLevel, email, ttlHours, token}` | `FamilyAccessInvitation` |
| POST | `/v1/school/family-access-invitations/revoke` | `{schoolId, invitationId}` | `FamilyAccessInvitation` (REVOKED) |
| POST | `/v1/school/family-access-invitations/end` | `{schoolId, invitationId, confirmation: 'END_FAMILY_ACCESS'}` | `FamilyAccessInvitation` (ENDED) |
| POST | `/v1/account/family-access-invitations/accept` | `{invitationId, token, confirmation: 'ACCEPT_FAMILY_ACCESS_INVITATION'}` | `FamilyAccountReceipt` |
| GET | `/v1/school/schools/:schoolId/family-access-invitations` | — | `FamilyAccessInvitation[]` (≤ 50, newest first; `EXPIRED` derived) |

`FamilyAccessInvitation` is `{invitationId, schoolId, familyId, familyName, accessLevel, email, expiresAt, status}` with status `PENDING | ACCEPTED | EXPIRED | REVOKED | ENDED`.

POST commands need an `Idempotency-Key` UUID. The contracts and validators are in `packages/contracts/src/school-family-access-invitations.ts`.

**Error codes:**

| Status | Code | When |
|---|---|---|
| 400 | `ACCOUNT_INPUT_INVALID` | Request fails validation, or a missing end confirmation |
| 403 | `ACCOUNT_FORBIDDEN` | Caller lacks authority, or the invitation is unavailable |
| 403 | `VERIFIED_EMAIL_REQUIRED` | Session has no verified email |
| 404 | `ACCOUNT_UNAVAILABLE` | Family or invitation not found at this school |
| 409 | `ACCOUNT_REVIEW_REQUIRED` | Identity conflict, revoking an accepted invitation, or ending one that was never accepted |
| 409 | `ACCOUNT_CONFLICT` | Key reused with a different body, or a duplicate pending invitation |
| 429 | `ACCOUNT_RATE_LIMITED` | Too many requests |
| 503 | `ACCOUNT_BUSY` | IAM authority locks are contended; safe to retry |

## Evidence

`packages/database/scripts/test-school-family-access-invitations-integrity.mjs` runs as part of `run-db-proofs.sh`, on the disposable Champions fixture: 13 groups through real signed sessions, Nest, the restricted runtime role and PostgreSQL, with no provider. It checks the parent scope through the real `resolve_parent_family_scope` resolver.

`apps/api/test/school-family-access-invitations.test.cjs` covers the contracts, the guard, the session-only email and the error mapping.

## Owner decisions

1. **Who can link parents.** Proposed: `family.member.manage` plus `family.read` (OWNER by default; custom staff roles can be given it). Alternative: OWNER only.
2. **Mixed staff/parent identities.** An instructor who is also a parent at the school is refused today (fail closed). Allowing it needs a deliberate rule for how one identity sees both scopes.
3. **Suspension.** Linking, ending and listing are blocked while paid access is suspended or lapsed, same as staff invitations. Ending a parent's access during a suspension (for example a custody issue) may need to stay available.
4. **Delivery.** Sending the link by email or SMS needs owner approval of a provider.

## Not included / follow-ups

- Ending a family grant that was not created by an invitation (fixture or legacy grants).
- Parent self-service (a parent inviting a second guardian).
- Codex owns the family-access screen: an "Invite parent" action on the family record, the invitations list, and the accept page.
