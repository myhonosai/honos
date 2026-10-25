# Zernio: secure configuration and credential verification

Baseline: `5e110057612b4846a73e4be7a45ead5212c1ffc2`. This is a separate
integration slice; draft Meta PR #79 and Claude's conversation PR #78 are unchanged.

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
Verification receipts remain in page memory and are concealed on focus loss;
restoration rereads the owner-authorized API. No key or retry is stored in browser
storage. No last-check state is presented as durable authorization.

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

## Verification scope

Run the credential-file tests, adapter/service/guard/API tests, translated view
and transport tests, full repository CI, typecheck, build and migration-file
validation. No migration or database mutation is introduced. API tests use
synthetic signed sessions and a mocked existing HQ resolver; they do not claim
new live-database authorization proofs. No actual Zernio key, live account or
external call is used. Document local HTTP listener restrictions separately from
supported GitHub CI results. No deployment or automatic merge.
