# C-AUTH-1 — verified post-login navigation

Baseline: canonical `main` `6ab871cd781935fc633dfec7685075b3d95432be`. This is a narrow web integration of existing verified APIs. It adds no backend endpoint, role claim, permission, database migration, provisioning, provider execution or deployment. Destination APIs retain independent current authorization.

## Implemented flow

The normal OIDC/development callback keeps its existing state, PKCE, nonce, issuer, token validation, verified-email handling, session issuance and transaction-cookie cleanup. Its sole identity-flow change is a fixed redirect from `/hq` to `/auth/continue` after successful session issuance.

`GET /auth/continue` verifies the HON session cookie with the shared reader. Missing, duplicate, malformed, expired or invalid cookies return a fixed relative sign-in redirect. The route accepts no query parameters, return URL, school, family or role selector. It rechecks session expiry after the protected reads settle. Its responses contain no account, principal, school, family or profile facts; they are no-store/no-referrer/noindex redirects to fixed local paths.

The server-only helper uses the deployment-owned `HON_API_BASE_URL` (the existing localhost default when absent), never browser origin, Host/forwarding headers, query data or a caller-supplied endpoint. Only the verified HON session cookie and an Accept header reach the API. Both reads share an eight-second deadline, refuse redirects, bound the response stream to 16 KB before JSON parsing, cancel stalled body reads on abort, validate UTF-8/JSON and exact closed DTO shapes, and perform no automatic retries or persistent caching. Upstream bodies and exceptions are never rendered or logged.

| Existing API result | Destination |
| --- | --- |
| `GET /v1/hq/session`: 200, exact `{data:{principalId,hqRole}}`, UUID principal and one of the three registered HQ roles | `/hq` |
| HQ 403, then `GET /v1/staff/current-reporting-school`: 200, exact `RESOLVED` organization/school UUID response | `/staff/dashboard`, with no identifiers in its URL |
| Either API 401, or locally invalid session | `/auth/login` |
| `MANUAL_ENTRY_REQUIRED`, staff 403, unsupported/malformed response, redirect, timeout, configuration or transport failure | `/auth/access` |

An HQ error other than 403 does not fall through to a different plane. An unknown staff response does not imply parent access. `/auth/access` is session-gated, renders **Access not verified**, and explicitly avoids asserting that the account has no roles. Ordinary manual HQ/staff/Parent Home links remain available; those destinations independently authorize their own APIs. An explicit verification link starts a new read only when clicked.

## Existing authority and limits

- [HQ session controller](../../apps/api/src/hq/hq.controller.ts) resolves the verified subject through `resolveHqOperatorScope(subject, 'hq.dashboard.view')`; a signed-in identity alone is insufficient.
- [Current reporting-school controller](../../apps/api/src/reports/current-staff-reporting-school.controller.ts) is a fixed selector-free read. The [current SQL definition](../../packages/database/migrations/0172_hon_paid_access_b6a.sql) requires exactly one ordinary active staff school, `reporting.view`, active entitlement and eligible current grants. It excludes family/HQ mixed identities and multi-school ambiguity. `MANUAL_ENTRY_REQUIRED` therefore does **not** prove absent staff roles. General instructor/owner landing classification needs a separately reviewed backend capability contract if broader behavior is required.
- [Web session gate](../../apps/web/src/server/require-web-session.ts) and [session format](../../packages/auth/src/session.ts) establish identity only. Roles, presentation settings and request hints are not routing authority.

## Precise Claude/backend dependency — not implemented

Add a minimal selector-free, signed-session `GET /v1/parent/current-access` only after independent contract/security review. Proposed closed response: `{data:{state:'RESOLVED'|'NO_ACCESS'|'SELECTION_REQUIRED'}}`, with **no** principal, organization, school, family, child, contact, schedule, billing or document fields. Return private/no-store before authentication errors; reject query/body/authority/delegation/command inputs. Invalid identity is 401; infrastructure/unverifiable state is unavailable, never a successful negative classification.

Reuse [guardian discovery](../../packages/database/migrations/0087_parent_journey_read_scope.sql), the [live exact-family resolver](../../packages/database/migrations/0071_curriculum_progress_read_and_integrity.sql) and current restricted runtime posture. Verify a unique active human and current active school/organization/family topology, non-expired explicit grant, exact-scope revalidation and `PRIMARY_GUARDIAN` or `SECONDARY_GUARDIAN` access. Preserve multiple-family ambiguity; do not select the first family. `VIEWER` access must not be relabelled guardian. The new read must have no writes, audit/outbox effect, impersonation, school entitlement shortcut or broader family-content access.

The existing [Parent Journey API](../../apps/api/src/families/parent-journey-view.service.ts) already discovers family scope, but also retrieves children, curriculum, schedules, awards and documents and permits viewer access. It is deliberately **not** probed for login routing. No guardian endpoint is invented or called by this frontend. Once the minimal reader is independently delivered, connect its verified `RESOLVED` result to `/parent` in a separate integration, with denied/viewer/ambiguous/revoked/expired/cross-family and no-content/no-write proofs.

## Verification and release

Focused tests exercise real signed HON sessions, both destinations, invalid sessions, strict DTO/error/redirect handling, shared timeout, late results, concurrent identities, selector and forwarding-header tampering, no extra cookie/profile disclosure, no parent probes, and no automatic retries. Existing callback tests continue to exercise PKCE/nonce/issuer/state and development compatibility, now expecting the fixed continuation URL. Page tests verify session gating and ordinary manual navigation. These web tests mock API responses; they do not establish a fresh API/database/IAM or deployment proof.

The dedicated workflow runs focused tests and a production web build, then `apps/web/scripts/post-login-routing-http.mjs`: actual Next HTTP routing with signed synthetic sessions and a localhost API fixture, plus neutral-page browser checks at 390/834/1440 pixels, keyboard focus/touch targets, overflow and axe. Browser presentation-language responses are synthetic too. Private screenshots/report are retained as Actions artifacts. This is mounted web evidence, not real IAM/RLS/provider evidence. The existing school-owner-account workflow receives scoped auth paths so its full repository and canonical disposable PostgreSQL jobs run without a second duplicate full-suite job here.

Exact executed local results and any hosted CI evidence belong in the handoff/PR. Source merge, real OIDC rollout, guardian classification, providers, account provisioning and deployment retain their separate review/owner gates. PRs #94/#95/#104, preview #101/#102, S4, financial work and Codespaces are unchanged.
