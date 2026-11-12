# HON OS public sign-up (B-ID-5, migration 0241)

**Status:** source only. Not deployed, not applied to any persistent database. Sign-up is **CLOSED** by default and can
only be opened in **TEST_MODE** by the migration owner of a disposable or private test database. There is no LIVE value.

## Spec

### Goal

A martial arts school owner can go from the website to their own school workspace without HQ:
website → **sign up** (verified email) → owner account → organization + school + OWNER role → `REGISTERED`.
The 14-day free trial (next slice, D11-B) moves a `REGISTERED` school to `TRIAL_ACTIVE`; Founder Setup then works.

### Decided inputs (owner)

- One HON OS product; 14-day trial, no automatic charge (OWNER_DECISIONS 2026-11-09).
- OD-2 (onboarding audit): registration is decoupled from the paid-access program. Registration creates identity and
  organization with **no access**; payment activation stays gated.
- Sign-in uses the existing verified OIDC session (Auth0 recommended). The email must be verified by the identity
  provider (`emailVerified` in the HON-signed session); a body never supplies subject or email.

### Behaviour

`POST /v1/account/sign-up` (same-origin human command `hon-os-sign-up`, `Idempotency-Key`), body exactly:

| Field | Rule |
|---|---|
| `ownerName` | 1–120 chars, trimmed, no control characters |
| `schoolName` | same |
| `legalName` | business legal name, same |
| `timezone` | real IANA zone |
| `termsVersionId` | the current sign-up terms version the page displayed |
| `confirmation` | `CREATE_HON_OS_SCHOOL_ACCOUNT` |

In one transaction, under the 0191 school-account authority envelope (NOWAIT, so a busy system answers
`SIGNUP_BUSY`, safe to retry with the same key):

1. Sign-up program must be `TEST_MODE` (else `SIGNUP_CLOSED`), checked before and after every write.
2. Terms version must be the latest (else `SIGNUP_TERMS_CHANGED`).
3. Identity: a new OIDC subject gets a user + one human principal, **unless another user already has that email**
   (`SIGNUP_REVIEW_REQUIRED`; HON never merges identities by email). An existing subject must be one clean active
   human principal with the same email, holding no school, HQ or family access (`SIGNUP_OWNER_NOT_ELIGIBLE`;
   multi-school owners are OD-12, still open, so one school per identity).
4. One registration per identity ever (`SIGNUP_ALREADY_REGISTERED`), even across different keys or concurrent tabs.
5. Creates: organization; entitlement `COMPLETE` **SUSPENDED** (every gated function refuses it); school (slug
   derived from the name); system `OWNER` role with every permission (same as 0019/0022/0183); the owner grant;
   an immutable `hon_os_school_registrations` row recording the verified email, terms version and acceptance time.
6. Receipt: `lifecycle = REGISTERED`, `accessGranted:false`, `billingActivated:false`, `aiCreditsGranted:false`.

No access-state row is written: `saas_access_states` is being rebuilt by the billing pieces (#205 0235), so the
`REGISTERED` lifecycle lives in the registration record and is reported by the read. The conversion slice maps it to
the access-state v2 `REGISTERED` value once billing lands. Paid access, checkout, credits and AI are unchanged.

`GET /v1/account/sign-up` returns the sign-up program status, the current terms version and the caller's
registration (or `null`) with an eligibility hint (`ELIGIBLE`, `ALREADY_REGISTERED`, `HAS_OTHER_ACCESS`).

### Boundaries

- Never authority: body subject/email/organization/school/role, a URL, the selected school, a UI label.
- Runtime role executes exactly two entry points; new tables are forced deny-all RLS with no runtime privileges.
- The 0183 initializer stays private and unused; HQ provisioning (0185/0208) and invitations are untouched.
- API rate limit per subject; database uniqueness per identity, subject and organization.

### Acceptance tests (proof `test-hon-os-public-signup-integrity.mjs`, real signed sessions → Nest → runtime SQL)

1. Custody: forced RLS, no runtime table privileges, exactly two executable entry points.
2. Closed program refuses with zero effects; TEST_MODE allows.
3. Unverified email, non-OIDC, forged body fields, wrong confirmation, bad timezone refused with zero effects.
4. Happy path creates exactly one org, school, OWNER role, grant, SUSPENDED entitlement and registration; the owner
   holds no capability (scope resolver refuses), no access state, subscription, checkout, allowance or AI row.
5. Same key replay returns the same receipt; changed body under the key is refused; a new key is `ALREADY_REGISTERED`.
6. Five concurrent sign-ups by one identity with different keys create exactly one school.
7. Email already used by another identity → review required; existing staff/HQ/family identity → not eligible.
8. Stale terms version refused; read reports program, terms and registration; cross-identity read shows nothing.
9. Program closed between steps refuses; entitlement-coverage proof lists the read as OPEN_BY_DESIGN.

## Plan

1. Migration 0241 (tables, program, terms seed, two functions, grants) + `infra/postgres/010` mirror.
2. Contracts `packages/contracts/src/hon-os-signup.ts` with closed validators + unit tests.
3. API `apps/api/src/accounts/hon-os-signup.{service,controller}.ts`, runtime-database fixed calls, module wiring,
   unit tests (`apps/api/test/hon-os-signup.test.cjs`).
4. DB proof + run-db-proofs registration; security registries (`school-account-security.mjs`, coverage allowlist).
5. Next PRs: trial runtime (D11-B), then the web sign-up and trial screens leading into Founder Setup.
