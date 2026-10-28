# Zernio: secure configuration and credential verification

Original audit baseline: `5e110057612b4846a73e4be7a45ead5212c1ffc2`.
PR #80 was reconciled against `780424c72f226123ad078b74b432d8dc9d8dbd5f` and is now
merged into canonical `main` at `2877a2711c8831be8bff3fa4c37ad81905255c2f`,
including accepted Meta #79 and merged #84–#86. The original platform-only scope
is unchanged. The Phase 2A documents below govern future integration development;
their historical PR-status wording is not current implementation evidence.

## Implemented boundary

The initial integration provides protected API-server credential configuration,
an HQ-owner-only status page at `/hq/integrations/zernio`, and explicit credential
verification through Zernio's documented `GET https://zernio.com/api/v1/auth/verify`.
Verification requires `HON_ZERNIO_VERIFICATION_APPROVED=true`; it is disabled by
default. Reading configuration never contacts Zernio. No provider calls are made
during development or tests; injected deterministic transports supply fixtures.

The API key never enters the HON browser, URL, response, telemetry or database.
There is deliberately no web credential-save endpoint: the existing HQ AI registry
stores secret references, not raw secrets, and has no Zernio credential-vault
implementation. Adding a browser key editor without a reviewed encrypted secret
store would create a misleading security promise.

Both APIs resolve a live human HQ owner with the existing database authority
resolver. A selected school, school owner, HQ operator, tier or AI role is not HQ
owner authority. Verification requires a same-origin, explicit human POST with
a closed confirmation body and rechecks authority after the provider returns.
Provider PII, account lists, scope strings and raw errors are never returned.
Concurrent verification is bounded; there are no automatic requests or retries.
The concurrency guard is per API process, not a distributed provider rate-limit
service. There is no scheduled verification or persisted global health receipt.

## Where to enter the key

Recommended for hosted environments: enter `ZERNIO_API_KEY` in the **API server's
secret manager/runtime secret settings**, not in web/public/build variables. Use
a dedicated expiring, read-only, profile-scoped key with unnecessary resource
groups disabled. Never paste it into chat, GitHub, a screenshot or a shell command.
Do not use `NEXT_PUBLIC_ZERNIO_API_KEY`.

For local development, from the repository root run:

```sh
node scripts/configure-zernio.mjs
```

The interactive hidden prompt creates `.secrets/zernio.env` in a private `0700`
directory with file permissions `0600`. It refuses symlinks, insecure existing
directories and existing files rather than silently overwriting a key. The file
is ignored by Git and outside the web/public directory. This is a local plaintext
secret file protected by OS permissions, **not an encrypted vault**. File-system
or machine administrators can read it. Use managed secrets for hosted/multi-user
environments. Revoke/rotate keys in Zernio; deliberately replace the local file
when rotating, with the API stopped.

After building the workspace and configuring the existing HON authentication and
runtime database environment, start the API with the protected file:

```sh
node --env-file=.secrets/zernio.env apps/api/dist/main.js
```

Start the web application normally and open `/hq/integrations/zernio` as an
authorized HQ owner. It shows only whether server configuration is present.
Configure `HON_ZERNIO_VERIFICATION_APPROVED=true` **only after separately approving
the read-only external check**. Use the explicit Verify button; a valid key is not
proof of connected school assets, App Review, publication rights or delivery.
Configuring/validating a key does not enable any other Zernio API operation.

## Provider sources and limitations (2026-10-25)

The requested `https://zernio.com/agent-quickstart.md` could not be read by the web
reader (unsupported `text/markdown`), and the execution proxy was unreachable on
one bounded direct fetch. No repeat installation/network loop was used. The
official HTML sources below were read instead:

- [Quickstart](https://docs.zernio.com/quickstart): server-side bearer API key;
  documented API root. The sample's first-account selection and posting are not
  appropriate for HON's exact-school authorization and are not executed.
- [Verify credential](https://docs.zernio.com/api-keys/verify-credential): validates
  a bearer credential; only the documented `valid` result is projected.
- [Scoped API keys](https://docs.zernio.com/api-keys/create-api-key): read-only,
  profile scope and resource restrictions. Current docs show `sk_` keys and
  restricted `zrk_` keys; secret validation accepts the documented formats.
- [Multi-tenant guide](https://docs.zernio.com/multi-tenant): profile/account
  separation. Provider profiles do not replace HON authorization.
- [Account list](https://docs.zernio.com/accounts/list-accounts) and
  [error handling](https://docs.zernio.com/guides/error-handling): future adapters
  must pin exact profile and reconcile unknown outcomes, never blindly resend.

The read-only adapter fixes its origin/path/method, rejects redirects, bounds
response bytes/time, drops raw provider errors and never lists customer records.
Verification receipts remain in page memory. Blur, hidden-document, pagehide,
confirmed HON session invalidation and school-context signals immediately clear
configuration, receipts and errors, abort pending reads and invalidate their read
epochs. Request-instance settlement is independent of the read epoch, so a settled
request does not strand the shield or let an old instance clear another request's
busy state. Unmount destroys the local view and cancels reads. Restoration requires
an explicit fresh owner-authorized configuration read; focus regain, language
changes and successful reauthentication do not reveal cached facts or retry the
provider check. Authenticated HON 401s broadcast the existing shared session signal;
403s are local denials. A provider REJECTED/DENIED receipt within HON 200 is not a
staff-session failure. No key or retry is stored in browser storage. No last-check
state is presented as durable authorization.

## Phase 2A precedence and joint checkpoint

Read the approved [ingress architecture](PHASE_2A_INTEGRATION_INGRESS_DESIGN.md),
[state vocabulary](PHASE_2A_INTEGRATION_STATE_VOCABULARY.md),
[review/privacy contract](INTEGRATION_REVIEW_UI_SPEC.md),
[verification gates](PHASE_2A_INTEGRATION_VERIFICATION_AND_ROLLOUT.md), and
[Meta capability foundation](META_INTEGRATION_ARCHITECTURE.md) together. This PR
does not implement those future contracts.

- Platform installation, private credential custody, pre-tenant signing-key
  verification, post-routing provider/data credentials, school connection, exact
  asset/capability grants and HQ administration are separate authority planes.
  This server environment key is not a webhook signing key or a school grant.
  Future ordinary records may contain only opaque credential-binding IDs/versions,
  never secret-manager/vault locators, credential contents or arbitrary resolvers.
- Historical ownership evidence must route each signed source occurrence; unknown,
  ambiguous or A-to-B delayed/remapped events fail closed. A valid signature,
  provider profile, current mapping or browser-selected school is not tenant
  authority. Event/source-occurrence identity remains stable across reconnects.
- Ingress recording and authorized human CRM disposition are separate transaction
  boundaries. Retry-ambiguous outcomes reconcile original durable evidence before
  any acknowledgement claim and cannot create a new receipt, case or CRM effect.
  Integration-only evidence is structurally non-dispatchable; it cannot enable a
  background consumer, Action Engine, CRM mutation or automated communication.
- Before persistence or API development, Manus/Codex must agree one versioned
  installation/binding/connection/grant/mapping/receipt/candidate/review/disposition/
  effect contract, authority and lock order, privacy/retry proof gates and a single
  migration reservation. Custody, retention, remapping, review and provider-use
  policies require separate owner decisions. No Phase 2B work is authorized here.

## Full Meta scope and future integration

Zernio is a potential provider adapter for the five-phase Meta roadmap, not an
independent authority or a shortcut around Meta policy. Preserve publishing,
scheduling, Facebook/Instagram inbox and comments, ads/leads/analytics and governed
HON/Marcus/Chad/Lena assistance. Separate reporting, lead retrieval, publishing,
comments, messaging and spend capabilities; no grant inheritance across assets.
Google Ads remains separate even when Zernio exposes it.

Before school-facing use, add independently reviewed durable exact-school ↔
Zernio profile/account bindings, conflict/revocation handling, least-privilege
permissions, RLS, audit/idempotency, OAuth return validation and webhook
authenticity/deduplication. A provider `externalId` or account/profile selector is
untrusted until it matches the verified HON binding. Never choose the first
account or treat organization access as permission for every school.

Publishing, scheduling, DMs, comments, ads, media, OAuth account connection and
webhooks are **not enabled** here. Those need per-account capability checks,
provider/Meta eligibility, explicit human approval, receipt reconciliation and
separate owner authorization. AI receives no raw key, provider tool access or
automatic sending authority. Unknown writes must be reconciled, not replayed
without an endpoint-specific idempotency guarantee.

## Exact-head evidence and verification scope

Draft-safe integration run `40442381437` completed on PR #80 head
`2877a2711c8831be8bff3fa4c37ad81905255c2f`: 1,957 workspace tests, full typecheck,
production build, 181-migration validation, 41 guarded disposable PostgreSQL proofs,
nine signed-session API/actual-HQ-resolver groups with only a deterministic injected
provider, and 16 mounted browser scenarios with 12 scoped axe scans. Its companion
regular draft CI run `40442381433` was skipped with zero steps and is not passing
evidence. This source-only evidence does not authorize configuring a real key,
setting `HON_ZERNIO_VERIFICATION_APPROVED=true`, performing a provider request, or
starting any connection, school grant, ingress, CRM, AI, payment, or external effect.

## Verification scope

The existing API unit/HTTP tests use synthetic signed sessions and a mocked HQ
resolver. They remain useful unit tests and are not database-authorization proof.
PR #80 adds separate executable verification:

- `apps/api/scripts/zernio-api-verification.cjs`: guarded, marked disposable
  PostgreSQL only; actual least-privilege RuntimeDatabaseService and HQ resolver,
  actual signed-session Nest guards/routes, minimized reads, denied actors,
  post-wait revocation, concurrency and before/after business-table hashes. Only
  the provider adapter/configuration is a deterministic injected fixture. No
  external request, real key, schema change or persistent database is used.
- `apps/web/scripts/zernio-browser.mjs`: production Next and mounted React with
  signed synthetic API fixtures, real language transport/shared 401 signal,
  READY/LOADING/late-response/privacy/unmount/explicit-restoration scenarios,
  desktop/mobile English/Korean/Spanish screenshots and keyboard/axe checks.
  This is browser-fixture evidence, distinct from the database-backed API proof.
- `.github/workflows/integration-foundation-validation.yml`: same-repository,
  exact-head, read-only draft-safe checks, complete unchanged canonical PostgreSQL
  proof commands, the new API proof and browser proof. Regular draft-skipped jobs
  must be reported as skipped. The complete existing regression suite is not
  evidence of a future Zernio connection/ingress implementation.

Run all workspace tests, runtime/setup guards, typecheck, production build and
181-file migration validation. All historical migrations stay byte-for-byte
unchanged; 0179/0180 remain reserved. Report exact executed counts, SHA, workflow
and artifact links in the PR after checks finish, separating local limitations
and historical results. No operational provider, school authorization, encrypted
tenant vault, webhook, CRM mutation, deployment or activation is validated here.
Keep `HON_ZERNIO_VERIFICATION_APPROVED` disabled outside synthetic injected tests.
