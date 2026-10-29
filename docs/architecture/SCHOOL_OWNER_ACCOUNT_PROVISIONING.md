# Launch P0-1 — school-owner account provisioning

Status: implementation for independent review, not deployment approval. Baseline `2877a2711c8831be8bff3fa4c37ad81905255c2f`. HON OS targets a complete functional SaaS launch; this is the first account slice, not a concierge-beta definition of done.

## Reuse and authority

Reuse deployment-owned OIDC authorization-code/PKCE/nonce/JWKS verification, HON's signed HttpOnly session, canonical `hon.users`, `hon.principals`, school OWNER roles and role grants, the HQ resolver and D9 provisioning. No password database, alternate auth issuer, public tenant selector or artificial subscription. OIDC issuer-scoped `sub` is identity; email alone never links existing accounts. Only strict boolean `email_verified=true` from the verified ID token supplies the invitation proof. Old sessions must sign in again. Manus development identity cannot accept an invitation.

The additional email proof lives only in the signed session. Existing public identity DTOs and human guards retain their closed shape; it is neither a role nor an authorization claim. The API rechecks the signed proof and derives the accepting subject/email. Neither comes from an acceptance body.

An existing current HON HQ OWNER approves an exact active organization/school from the existing directory and records an invitation. HQ operators, support, staff, parents, integrations and AI cannot issue/revoke invitations. New school creation continues through existing authorized D9 provisioning; it remains SUSPENDED and creates no operating access. P0-1 does not change D9 or SaaS policy.

## Operational path (after review and separately approved deployment)

1. Configure the existing deployment-owned OIDC provider (account registration, verified email, MFA and provider recovery). No credentials were configured or providers contacted by this PR.
2. HQ provisions/approves the organization and school using the existing HQ onboarding API. No database console is needed. If the organization is not yet approved, do not issue an invitation.
3. Signed-in HQ owner opens `/hq/school-owner-invitations`, verifies access and explicitly loads the approved directory. Select school, enter owner email, generate a private 256-bit token and record the invitation. Default expiry 24 hours; API permits 1–168 hours. The minimized production directory contains no organization ID; its exact closed response is validated unchanged. The database resolves the selected school’s organization and chooses the invitation ID and canonical OWNER role.
4. Share `/account/owner-invitation`, the invitation ID and token through an independently approved secure channel. The token is NOT a query/fragment/path value. No email/SMS is sent. The existing login callback still lands at `/hq`; the school owner opens the fixed invitation page again after login. An automatic account-type landing router is a follow-up.
5. Owner signs in with the invited verified email and explicitly accepts. One transaction creates/reuses the exact subject's human identity and creates one school-scoped OWNER grant. Existing active grants in another organization, mixed HQ/family identity, duplicate email under another subject and ambiguous/inactive principals require review. Same-organization additional schools are supported only via independent approved invitations, not an organization-wide grant.
6. Owner can sign in normally and resolve ONLY the bound school. Operating APIs retain their existing entitlement checks. `OWNER_BOUND` means identity binding; it never means paid access or commercially activated software.
7. HQ can review the most recent 50 invitations for a selected school and revoke pending or accepted invitations. Revoking an accepted invitation ends ONLY the exact role grant created by that invitation; it never changes another owner or another school's authority. Revoked/expired invites cannot be accepted; expiry needs no cleanup. Accepted receipts remain historical facts, not current authority.

## API contracts

All routes use the verified HON session and private/no-store responses. Commands require POST JSON, exact configured Origin, same-origin fetch metadata, `X-HON-Human-Command: school-owner-account`, UUID `Idempotency-Key`, and no contextual headers/query/delegation.

- POST `/v1/hq/school-owner-invitations`: closed `{schoolId, email, ttlHours, token}`. The school ID is an untrusted target; current HQ-owner authority is independently checked. PostgreSQL derives the organization from that school while holding the existing authority locks, never from browser fields. Supplied organization/role fields are rejected.
- GET `/v1/hq/schools/:schoolId/owner-invitations`: HQ OWNER only, bounded latest 50, explicit read. No token/hash, creator, accepting subject, grant identity or private evidence returned.
- POST `/v1/hq/school-owner-invitations/revoke`: closed `{invitationId}`.
- POST `/v1/account/school-owner-invitations/accept`: closed `{invitationId, token, confirmation: "ACCEPT_SCHOOL_OWNER_INVITATION"}`. No role, organization, email, entitlement, person or subject input.

Invalid/expired/revoked invitation, wrong token/email and wrong target all fail confidentially. 401 invalidates the existing shared browser session signal; 403 remains local. 409 means conflict/review, not success. 503/transport timeout may be uncertain: retain exact body/key and retry only after explicit identity revalidation. No automatic retry or success inference.

## Transaction and lock safety

Migration 0191 adds private invitation, immutable request receipt and immutable account-event tables with FORCE RLS, no policies and no runtime direct/column grants. Events carry audit and structurally inert outbox evidence (`execution_allowed=false`), completely separate from the ordinary claimable `crm.lead.created`/delivery outbox. There is no account dispatcher, delivery worker or provider adapter.

A low-volume global onboarding try-advisory lock plus a NOWAIT SHARE ROW EXCLUSIVE envelope over organizations, schools, users, principals, role grants, HQ grants, family grants, roles and permissions prevents inserts/deletes/revocations/permission changes from racing the mutation. It either obtains authority without waiting or aborts the whole command with recoverable 503. No inverted IAM lock wait or timeout-based unlock. Revocation that wins first refuses the command; a later writer waits until this transaction commits. Live actor/issuer and invitation expiry are checked after locks and again before return. This deliberately favors safety over onboarding throughput; revisit scoped lock granularity with executable interleaving proofs before higher-scale onboarding.

The locked request fingerprint binds operation and closed normalized input, including the token hash. Same-key exact replay returns the original result without writing. Changed input is rejected. Single-use state and a unique invitation-bound grant prevent parallel creation. A committed acceptance replay requires the same subject, token, email and still-live exact grant; it cannot resurrect revoked access. All transaction failures roll back identities, grants, receipts and events.

Tokens are generated with browser CSPRNG, never logged or stored client-side, hashed SHA-256 before SQL, and never returned by list/receipt APIs. The authenticated HQ request necessarily transports the raw token over protected same-origin HTTP. Deployment ingress/APM must not log request bodies/cookies; the runtime SQL parameter-error logging remains disabled. Manual delivery custody and rotation use revoke/reinvite, never token recovery from a hash.

## Privacy and approved design

Use current main's HON HQ shell and established navy/cyan/glass styling. No PR #27 prototype, unmerged conversation/portrait experiment or alternate Manus design is promoted. All shared assets, navigation, View/AI Style controls and existing presentation preferences remain unchanged. These isolated account forms do not change operational school UI. Existing layouts remain responsible for density; no mode change reads records or conveys authority.

Blur, hidden visibility, pagehide, session invalidation and school-context events immediately remove fields, configuration, errors and receipts from the rendered/accessibility tree. Read epochs abort/ignore late reads. Consequential request lifetime is independent: it settles behind the shield; immutable request/key remains only in mounted memory. Restoration requires explicit fresh signed identity (and fresh HQ-owner scope for HQ); a different subject cannot recover the original capsule. No auto-reveal or resend. In-flight abandonment is disabled; settled unknown abandonment warns that it cannot reverse a server action. Full document destruction loses the capsule. A concealed successful invitation may require revocation/reinvite if its manual delivery token was lost.

## Recovery and full launch dependencies

Working P0-1: HQ-approved invitation, verified OIDC owner binding, single-use/expiry, exact replay, scoped revocation and existing-owner login. No real account was created by development/testing.

Launch-critical sequenced PRs, not optional beta tasks:

1. Self-service school registration: verified-email admission, duplicate school/organization review, anti-abuse/rate limits, consent, approval and canonical D9 provisioning. Public input never selects OWNER/organization authority. Owner-policy and independently reviewed activation gates precede live enrollment.
2. Staff invitations: current exact-school owner/inviter permission, approved non-escalating role allowlist, role-version binding, staff scope, expiry/revocation/replay and two-organization proofs. Do not reuse OWNER invitation semantics for staff.
3. Parent invitations: explicit existing guardian/family relationship and family-safe grant; never staff roles or email-only family association. Minors/consent/privacy policies must be approved.
4. Account recovery: same issuer/sub uses the configured identity provider's password/MFA recovery today. Lost/replaced identity, changed subject/email and ownership transfer require a reviewed HQ rebind/revoke ceremony, independently verified identity, immutable history and session revocation; email matching alone is insufficient.
5. Session lifecycle: deployment-owned OIDC provider/MFA/recovery validation, appropriate reauthentication/session rotation, account routing, independently approved invitation delivery, verified notification status and incident/rate-limit controls.
6. Localize the new account strings into shared English/Korean/Spanish catalogs and complete the account UX/navigation/browser acceptance before launch. Current new strings are English; no complete localization claim.
7. Commercial/trial/AI activation remains governed by its own milestones/policy. This account foundation never bypasses entitlement gates to make login appear operational.

No migration 0190 is authored: pending A2P #82 already uses it. Migration 0191 is additive. 0179/0180 stay reserved, all 181 historical main migrations stay byte-identical. Before combined release, recheck competing migrations and persistent deployment posture; do not run these fixtures/migrations against a shared database.

## Independent review request

Claude: independently review exact final PR head, verified-email trust and identity recovery boundary, broad NOWAIT authority serialization, token handling, private evidence/ACLs, replay/revocation and two-organization real signed-session proofs. Approval requested for source merge only; deployment, real account creation, providers, billing and activation remain separately gated. No changes to Claude's conversation, A2P or other PRs are requested.

## P1 directory/invitation correction

The prior browser fixture incorrectly added organization/invitation IDs to the minimized school directory. The fixture now matches the unchanged seven-field production row, the UI reuses the existing strict directory validator, and the invitation command submits only the selected school ID plus closed invitation fields. The live HQ-owner check and canonical organization lookup happen together inside the existing protected database command and authority locks. No new lookup API, direct runtime table access or broader directory projection is added.

The real signed-session/PostgreSQL proof now calls the actual HQ directory controller/service first and uses its organization-ID-free row to issue an invitation. It verifies the resulting canonical school/organization and rejection of organization overrides in both HTTP and direct protected-function input, expired HQ grants/sessions, unauthorized actors, cross-school identities and revoked invitations. Migration 0191 remains an unmerged draft under the same proposed number; only its draft command body/checksum changes. Historical main migrations and number reservations remain untouched.
