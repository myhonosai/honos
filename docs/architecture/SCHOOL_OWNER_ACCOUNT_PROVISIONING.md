# Launch P0-1 — school-owner account provisioning

Status: implementation for independent review, not deployment approval. Integrated baseline `8c1c0af12a5d9f6030b4c53d81741d6bd511204c` (merged A2P #82); prior invitation review baseline `2877a2711c8831be8bff3fa4c37ad81905255c2f`. HON OS targets a complete functional SaaS launch; this is the first account slice, not a concierge-beta definition of done.

## Reuse and authority

Reuse deployment-owned OIDC authorization-code/PKCE/nonce/JWKS verification, HON's signed HttpOnly session, canonical `hon.users`, `hon.principals`, school OWNER roles and role grants, the HQ resolver and D9 provisioning. No password database, alternate auth issuer, public tenant selector or artificial subscription. OIDC issuer-scoped `sub` is identity; email alone never links existing accounts. Only strict boolean `email_verified=true` from the verified ID token supplies the invitation proof. Old sessions must sign in again. Manus development identity cannot accept an invitation.

The additional email proof lives only in the signed session. Existing public identity DTOs and human guards retain their closed shape; it is neither a role nor an authorization claim. The API rechecks the signed proof and derives the accepting subject/email. Neither comes from an acceptance body. Proof issuance is default-off until the reader-first rollout below is complete; ordinary legacy sessions stay valid but cannot accept invitations without fresh verified proof.

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

Before that envelope, HQ invite/revoke/list perform live HQ-owner authorization. Acceptance first verifies the intended email/token, current invitation and school, issuer authority, identity compatibility and (for replay) the original request/live bound grant in a private, read-only preflight. Invalid callers never reach the onboarding advisory or broad table locks. The acceptance check runs again after the invitation row lock has settled. Snapshot isolation is refused: READ COMMITTED is required so reauthorization cannot reuse an earlier authority snapshot. Existing final authority/expiry checks and full rollback remain in place.

The authenticated API also bounds command attempts before SQL: 10 acceptance attempts per signed subject per minute; 30 combined HQ invite/revoke/list attempts per signed subject per minute; 300 total per service process per minute; a bounded 512-key map with no eviction of live counters. Keys are keyed hashes, not raw subjects/tokens/IPs. Saturation returns 429, bounded `Retry-After` and `outcome: NOT_SUBMITTED`. No attempt is automatically repeated. A throttled exact retry retains its original in-memory request/key because an earlier attempt may still have committed. These process-local quotas are defense in depth, not distributed limits or authority; production scale-out requires separately reviewed edge/cluster abuse controls. SQL preauthorization applies even when the HTTP limiter is bypassed by a trusted runtime caller. No rate-limit business table, audit event or idempotency claim is created.

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

This PR does not author or alter migration 0190: merged A2P #82's `0190_a2p_registration_preparation.sql` is preserved. Migration 0191 is additive. 0179/0180 stay reserved; all 182 historical migrations on the integrated main remain byte-identical. The combined tree contains 183 migrations and pins 11 targets from 0181 through 0191. Before combined release, recheck competing migrations and persistent deployment posture; do not run these fixtures/migrations against a shared database.

## Verified-email session rollout and rollback

The existing main verifier rejects all unknown session keys, including `emailVerified`. This is a coordinated schema expansion, not a universally backward-compatible new token. No real OIDC configuration or deployment was performed here.

1. **Readers first:** deploy the compatible `@hon/auth` verifier to every API, web server, route handler, worker and other session reader. Leave `HON_SESSION_VERIFIED_EMAIL_ENABLED` absent or `false` on all issuers. Issuance remains exactly the legacy closed claim shape, even when verified OIDC internally supplies `email_verified: true`. Old and new readers continue to authenticate those sessions. Invocation of the new invitation acceptance endpoint remains unavailable without verified proof; ordinary login continues.
2. **Verify the fleet:** drain old reader instances and verify mixed-version/ordinary-login behavior. Do not infer readiness from upgrading only the web frontend. The flag is server-only, not `NEXT_PUBLIC_`, and neither a client toggle nor an authorization grant.
3. **Issuer enablement, separately approved:** only after all readers are compatible, explicitly set `HON_SESSION_VERIFIED_EMAIL_ENABLED=true` on OIDC issuers. Only a verified signed OIDC boolean `email_verified: true` with an email can then be emitted as HON `emailVerified: true`. Existing legacy sessions remain valid for ordinary login; invitation recipients must deliberately sign in again to obtain proof. A new API reader accepts old/new shapes irrespective of its local issuance flag. Invalid values, development-mode proof, forged signatures and other unknown claims remain refused.
4. **Safe rollback:** first disable issuance on every issuer and record the last possible new-token issue time. Keep compatible readers for at least the full 43,200-second session lifetime after that time (plus the deployment clock/drain margin). Disabling the flag does not remove claims from existing cookies. Do not roll a reader back while any new-shape token can remain valid. An earlier forced sign-out requires its own approved recovery/security procedure; this PR does not invalidate all users or rotate secrets.

Synthetic tests explicitly opt in on their isolated issuers; they are not deployment settings. The compatibility tests exercise the original closed claim allowlist, old/new token combinations, default-off issuance, strict malformed/forged proof rejection and the full rollback lifetime. No new cookie or browser storage is introduced.

## HQ administration versus school ownership — proposed policy only

Platform HON HQ administration is a separate authority plane from permanent school-level OWNER authority. Proposed direction: HQ provisioning/support should not automatically imply indefinite school ownership; genuine school owners should have independently governed school-scoped grants, with any HQ support access explicit and auditable. Owner decisions are still required for bootstrap-grant retirement/retention, handover, support access and ownership transfer.

Current D9 migration 0185 creates a school OWNER grant for the HQ provisioner. This PR does not change that behavior, remove such grants, add a retention policy, transfer ownership, or reinterpret existing grants. Invitation revocation continues to end only the specific grant that invitation created. Pending acceptance continues to require a live authorized issuer; already accepted exact replay continues to require the original live bound grant. These existing behaviors are not approval of a permanent-ownership policy. Disposable proofs explicitly preserve the original D9 grants through invitation acceptance/revocation.

## Independent review request

Claude: independently review exact final PR head, verified-email trust and identity recovery boundary, broad NOWAIT authority serialization, token handling, private evidence/ACLs, replay/revocation and two-organization real signed-session proofs. Approval requested for source merge only; deployment, real account creation, providers, billing and activation remain separately gated. No changes to Claude's conversation, A2P or other PRs are requested.

## P1 directory/invitation correction

The prior browser fixture incorrectly added organization/invitation IDs to the minimized school directory. The fixture now matches the unchanged seven-field production row, the UI reuses the existing strict directory validator, and the invitation command submits only the selected school ID plus closed invitation fields. The live HQ-owner check and canonical organization lookup happen together inside the existing protected database command and authority locks. No new lookup API, direct runtime table access or broader directory projection is added.

The real signed-session/PostgreSQL proof now calls the actual HQ directory controller/service first and uses its organization-ID-free row to issue an invitation. It verifies the resulting canonical school/organization and rejection of organization overrides in both HTTP and direct protected-function input, expired HQ grants/sessions, unauthorized actors, cross-school identities and revoked invitations. Migration 0191 remains an unmerged draft under the same proposed number; only its draft command body/checksum changes. Historical main migrations and number reservations remain untouched.

## Final A2P/main integration checkpoint

Normal two-parent integration of main `8c1c0af12a5d9f6030b4c53d81741d6bd511204c` into invitation head `0afde4b1ac9807da0781f8d7208cf01740595dde` retains both closed runtime API paths, both RLS/security registries, both contracts and both disposable proofs. Runtime reconciliation also explicitly revokes access to the private acceptance-preflight helper, matching migration 0191. Migration evidence is regenerated from the final sorted file bytes, not copied from either parent. Fresh combined-head results belong in the PR evidence record, not in older historical test counts.

The owner has allocated later PR #90 to 0192. At inspection, PR #90 head `f36e7492a0268274d3e0af7174526991c365bbf6` still contains `0191_commercial_b2_schedule_billing.sql`; its owner must perform the separately authorized renumbering before combined integration. This PR neither imports that file nor changes #90. The current ceiling deliberately remains 0191; a later 0192 integration must regenerate the chain and update its ceiling/target count with fresh proofs. No HQ ownership-handoff behavior or policy changes are included.
