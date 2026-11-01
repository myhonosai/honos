# C-HQ-2 — HQ school creation integration

Source baseline: `6ab871cd781935fc633dfec7685075b3d95432be`.

`/hq/schools` now mounts the existing `HqOnboardingPanel` beside the minimized directory. The creation form starts hidden and makes no mount-time access read or command. An operator explicitly verifies HQ-owner access, enters the organization and first-school details, reviews the no-access policy, and confirms creation. Changes clear confirmation. Shared HQ presentation modes affect density only; original artwork, shell and minimized directory fields are unchanged. The directory privacy lifecycle is hardened for this shared page, as described below.

HON OS is one product. The existing backend requires `initialTier`; this integration sends the allowed `COMPLETE` value as an internal suspended placeholder. It exposes no public tier selection, prices or AI-credit allowances, and does not modify legacy tier contracts or existing entitlements.

## Existing route and receipt

The path remains:

`/hq/schools` → `hq-onboarding-http.ts` → `POST /api/v1/hq/organizations` → existing Next rewrite → `HqOnboardingController` / `HonIdentityGuard` → live `hq.onboarding.manage` resolver → `HqOnboardingService.provisionInitialSchool` → `RuntimeDatabaseService.provisionSchoolFromHq` → `hon.provision_school_from_hq` in migration `0185`.

The request has exactly the merged DTO fields: `legalName`, `displayName`, `schoolName`, `schoolSlug`, `timezone`, `initialTier`. Identity and authority are never added to the body. The existing server retains its normalization, fingerprint, actor-scoped idempotency, audit and transactional outbox.

The closed HTTP receipt is `{ data: { organizationId, schoolId, ownerRoleId, replayed }, meta: { replayed } }`. A new receipt is HTTP 201 with `replayed: false`; a replay is HTTP 200 with `replayed: true`. The browser verifies the exact envelope, UUIDs, distinct IDs, boolean consistency and status. It rejects augmented/malformed success data. It verifies the same current HQ-owner principal both immediately before dispatch and after the response, before displaying IDs.

The D9 function inserts `SUSPENDED`. Its `entitlementStatus: SUSPENDED` and `access: NONE` appear in private audit/idempotency evidence, **not** in the HTTP receipt. The interface labels suspension as provisioning policy and labels the receipt as creation IDs/replay only. It claims no current access, payment, school-owner login, onboarding completion or active subscription.

Exception policy terms v1 remain `PROPOSED` in the merged D9 contract. Creation does not establish an approved exception policy or a school's eligibility. Product copy requires separate policy approval and verified eligibility before any HQ-owner exception; this screen supplies no exception command. A persistent polite live region announces loading, authorization denial and verified receipt outcomes.

## Request lifetime and privacy

- A synchronous lease prevents duplicate commands, including during authorization and post-response reads.
- Before dispatch, the normalized serialized body, generated key and originating principal are frozen as one request.
- An unknown, malformed, denied or unverified dispatched outcome retains that request. The form stays locked and retry requires fresh human confirmation, current authorization and the same principal. It never generates a replacement key or silently repeats a command.
- Session/school signals, window blur/pagehide and hidden visibility clear visible inputs, confirmation, receipt and authority. Read epochs discard late responses. Privacy cannot release the physical command lease; late settlement stays hidden and requires explicit restoration.
- A retained request exists only in component memory. The interface tells the operator to keep the page open until a receipt is verified. No local/session storage, persistent private draft or invented receipt-lookup API is added.
- While that request remains unverified, there is no discard or start-replacement action. The original owner must keep the exact request and resolve it by explicit retry. Leaving the page loses that recovery state and must not be treated as evidence that creation failed.

The existing directory previously retained loaded customer names after a sibling creation-transport 401. The directory now subscribes independently to the same session/school/blur/pagehide/hidden-visibility signals. It sets the facts wrapper's DOM `hidden` and `inert` properties synchronously, then clears the React snapshot, aborts the read and advances its epoch. Late authorization, directory or final-principal responses cannot repopulate it. Unmount performs the same clearing and removes listeners.

Directory reads preserve the existing minimized fixed `/hq/schools` projection and OWNER/OPERATOR capability. Each read verifies the strictly parsed current principal through fixed `/hq/session` GETs before and after the projection; support remains denied. After concealment, only the explicit **Verify and read school directory** action restores facts. Focus, visibility restoration and presentation changes do not read. The creation panel stays mounted as an independent sibling, so directory concealment/restoration cannot reset its unknown request or idempotency key. Authenticated 401 is broadcast before response-body use; 403 remains local to the denied operation.

## Actual merged-contract limitations

1. `GET /v1/hq/session` resolves dashboard access and returns only `principalId` and `hqRole`, with no onboarding permission list. The UI conservatively allows `HON_HQ_OWNER` only. It cannot prove delegated operators' `hq.onboarding.manage` capability using this contract. The POST independently checks that permission.
2. The existing provisioning controller uses `HonIdentityGuard` and the HQ resolver, but **has no server human-command/origin guard**. The browser sends `X-HON-Human-Command: hq-school-provisioning` to mark intent; this is advisory and does not create server enforcement. Pre/post principal checks also do not add atomic expected-actor binding to the legacy command. Review these existing backend gaps separately before treating this integration as a complete direct-human transport boundary.
3. The HTTP response returns no entitlement/access state, actor echo, submitted-name echo or idempotency-key echo. The UI does not invent or infer those receipt fields.

No API, shared contract, database migration/function, RLS, permission, financial authority, invitation or entitlement activation is changed.

## Verification

Local results after the directory-coupling correction: all 1,078 web tests passed across 140 files. All 39 focused checks passed (18 creation, 9 directory lifecycle/coupling, 5 minimized directory, 7 catalog). The final reviewed source passed the production web build, then a sequential web `tsc --noEmit`, browser-script syntax checking and `git diff --check`. Existing dependency/package-build caches were reused; no install was attempted. Exact-head CI remains for the draft PR.

Focused coverage lives in `apps/web/test/hq-onboarding.test.tsx` and `apps/web/test/hq-school-directory-lifecycle.test.ts`, with the existing directory and public-catalog regression tests. It exercises inert creation mount, confirmation reset, duplicate locking, unknown immutable replay, ownership changes before/after dispatch/read, privacy during reads/commands, stale responses, access refusal, exact envelope parsing, minimized transport, 401-only shared invalidation and creation-401 concealment of loaded directory facts while retaining the original creation request.

`apps/web/scripts/hq-school-create-browser.mjs` follows the existing signed-session Next/Chromium harness pattern, with synthetic contract fixtures and no database/provider credentials. It covers desktop/mobile form layout, independent initial directory reads without automatic creation authorization, populated-directory concealment, explicit fresh directory restoration while retaining exact creation retry, receipt privacy, in-flight concealment, late directory reads and 401/403/operator behavior. It does not prove the existing backend's missing human-origin guard.

`apps/web/scripts/hq-school-create-api-verification.mjs` separately bridges the actual frontend transport/controller to real signed-session Nest controllers and a descriptor-guarded disposable PostgreSQL fixture. It prepares seven groups: five concurrent exact-key requests create one suspended school with one claim/audit/inert outbox; a committed-but-lost response is explicitly replayed; owner/operator directory reads; unauthorized and expired identities/unknown inputs/key reuse without effects; injected outbox rollback and safe same-key retry; preserved unrelated records and inactive commercial/credit programs; and live HQ grant expiry including replay denial. These tests have not run locally; exact-head hosted execution is required. Their signed sessions are synthetic, but API, IAM and database authorization are real.

The browser workflow also verifies all three existing HQ presentation modes at 390/834/1440 widths, keyboard submission, no reads on view changes, accessibility scans, and shared-page directory concealment. Screenshots and reports remain private CI artifacts; none are uploaded individually. The browser's API fixtures are explicitly separate from the real API/database proof above.

Local mounted-browser execution was attempted and blocked before page startup: the sandbox refuses loopback listening with `EPERM`; Chromium startup is also refused. The final coupled script passes syntax checking; its mounted checks remain unexecuted locally. No mounted-browser, screenshot, axe or manual-device result is claimed.

Run in an environment that permits local sockets, using a built web app and the existing browser dependencies:

```bash
HON_HQ_BROWSER_LOCAL=1 \
HON_HQ_BROWSER_TOOLS=/path/to/browser-tools/node_modules \
HON_HQ_CHROME_BIN=/path/to/chromium \
HON_HQ_BROWSER_RESULTS=/tmp/hq-school-create-browser \
node apps/web/scripts/hq-school-create-browser.mjs
```

This fixture binds API port 3001, matching the default existing build rewrite. It uses signed synthetic sessions and blocks browser requests to external hosts. No installation, provider/network request, database action, publication, deployment or merge is part of this change.
