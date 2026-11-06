# HON OS private owner test environment — real application

This runs the actual repository Next frontend, Nest API, canonical PostgreSQL migrations, restricted `hon_runtime` and real HON OIDC login. The small isolated test identity issuer is not the production IdP. All identities/records are synthetic; no production/customer account, provider, payment or communication is connected.

## Authorization and version boundary

The owner approved a temporary passcode-protected sandbox site on 2026-11-06, separate from HON login. This is not merge, production deployment, billing/provider activation or school operating-access approval. The initial candidate is reviewed #143 `5be577cd24ed7b672922854d5f08aa643c634e0e` against accepted main `a84064f3b3d25a11f49e3183effbfc252660d72e`, with reviewed #102/#133 launcher safety and environment-only ingress. Preserve those application/domain/infra/migration bytes.

The initial database contains 200 checksum-locked migrations through0208. Allocated0209/#147 and Account & Usage #146 remain separately reviewable integration dependencies. Never fabricate subscriptions or apply an unapproved migration to retained state. Refresh the candidate once after owner-approved source integration, preserving the actual ledger and focused equivalence/CI evidence.

## Private lab startup

Requirements: pinned Node22.23.4+, pnpm10.18.0, PostgreSQL16+, OpenSSL. Use a normal unprivileged user and frozen dependencies. Child applications receive explicit minimal environments, no migration/provider credentials; `.env` files and inherited database/provider keys are refused.

```bash
pnpm install --frozen-lockfile
HON_TESTENV_HOME=/absolute/new-approved-private-state node scripts/testenv/testenv.mjs up --fresh --build
```

`--fresh` requires an explicit absolute external unused directory with a real existing parent. Private ownership,0700directory,0600non-linked marker/secrets, ancestor symlinks/hardlinks and private cluster paths are validated. Existing retained state is never silently adopted/reset. Startup failures await reverse-order cleanup. An explicit confirmed reset is destructive and is not authorized simply by running QA.

Lab listeners bind loopback. Defaults: gateway3443/web3100/API3001/PostgreSQL55440. A second instance can select distinct validated `HON_TESTENV_GATEWAY_PORT`, `HON_TESTENV_WEB_PORT`, `HON_TESTENV_API_PORT`, `HON_TESTENV_POSTGRES_PORT`; production API default remains unchanged, with only reviewed opt-in `HON_API_LISTEN_HOST=127.0.0.1`.

## Protected temporary remote access

Only after explicit owner approval, configure an exact HTTPS `HON_TESTENV_PUBLIC_ORIGIN` and `HON_TESTENV_PUBLIC_ACCESS_APPROVAL=temporary-passcode-site-v1` consistently for lab, edge and verifier. The browser issuer/authorization/callback use this public origin; token exchange/JWKS use verified private localhost TLS backchannels. Only the separate `private-edge.mjs` binds the approved external forwarding port. Raw web/API/PostgreSQL/IdP-backchannel listeners remain private.

Generate a cryptographically random site passcode of at least32characters and store only as `gatePasscode` in the already private external `secrets.json`; never commit, print, include in a URL, log or post it to GitHub. The operator starts the edge with the same configuration and approved port. The middleware gates **all** app/login/IdP/static/API paths, including token/JWKS, with no bypass header/route. It issues only a separate Secure/HttpOnly/`__Host-` gate cookie, absolute2hour server expiry, hash-only bounded token state, closed4KiBform, exact Origin/FetchMetadata validation and bounded one-minute failure throttle. It does not issue HON sessions or authority.

The whole temporary site has an absolute7day expiry from private-state creation; restarts do not extend it. `SIGUSR2` to the exact edge process revokes all gate cookies; authenticated testers can re-unlock with the unchanged passcode. To revoke knowledge of a compromised passcode, rotate the private stored code and `SIGHUP` the edge: old sessions are revoked and reload failure closes access. Stopping the edge closes remote access without deleting the private database. No permanent uptime is promised; sandbox hibernation may interrupt access.

The explicit environment ingress fixes upstream Host to the configured origin and removes untrusted forwarded/hop metadata. It never invents Origin, Sec-Fetch, human-command, expected-principal or idempotency. HON guards/domain authorization remain unchanged. Preserve IdP same-origin form-referrer policy; do not manufacture `Origin` to repair a failed command. Use a standalone HTTPS tab, not an iframe.

## Legitimate test people and provisioning

| Identity | Canonical path / limit |
|---|---|
| HQ Owner(test) | Real HQ owner bootstrap only; protected HQ directory/provisioning/invitations. |
| School A Owner(test) | Accept the real manually delivered invitation for school-a-owner@hon-testenv.invalid; no operating access implied. |
| School B Owner(test) | Independent owner binding for school-b-owner@hon-testenv.invalid; no HQ/foreign-school authority. |
| Unprovisioned visitor(test) | Real signed identity but no grants; HQ/school operations must refuse. |

The old scripted `create-school`/unbound POST is **retired**, with no fallback. Sign in normally as HQ owner, open `/hq/schools`, explicitly verify the current HQ principal, complete/confirm the actual form and receive a real actor-bound201 **SUSPENDED** receipt. Normal form transport and database rechecks enforce identity. Use the real owner-invitation and acceptance screens; tokens are manual synthetic delivery only and must not enter screenshots or storage. Role-based post-login routing is implemented in the reviewed application; do not assume all people land in HQ.

**Owner binding is not operating access.** School operations remain blocked unless the owner separately approves exact named-school INTERNAL_TESTING payloads and the existing exception-only policy. Existing signed-HQ policy/grant APIs enforce current policy/terms/entitlement versions, expiry, one open exception, immutable audit/idempotency and zero AI credits. An operator may submit separately approved canonical payloads; no direct SQL entitlement grant, fake subscription, hidden fixture repair or full paid-access policy activation is allowed. The HQ exception screen is still absent.

## Validation and acceptance

```bash
node --test scripts/testenv/testenv.test.mjs scripts/testenv/state-safety.test.mjs scripts/testenv/runtime-config.test.mjs scripts/testenv/private-site-gate.test.mjs
# Supply the same lab config, installed playwright-core and Chromium:
HON_TESTENV_PLAYWRIGHT=/installed/playwright-core HON_TESTENV_CHROME=/installed/chromium node scripts/testenv/verify-testenv-browser.mjs /private/results
HON_TESTENV_VERIFY_PERSISTENCE=1 HON_TESTENV_PLAYWRIGHT=/installed/playwright-core HON_TESTENV_CHROME=/installed/chromium node scripts/testenv/verify-testenv-browser.mjs /private/results
```

The native verifier first uses the actual passcode form, then OIDC, protected HQ form/directory, two owner binding attempts and explicit fresh accepted-invitation reads. It fabricates no gate/HON cookie, mock API success or transport header. Public HTTPS certificates must validate; ignore-TLS is limited to the explicit private localhost lab. Every durable school is retained/discovered authoritatively before any later diagnostic failure can authorize a replacement mutation. Read-only governance preflight never grants access. Persistence mode never recreates schools/invitations.

Playwright interception may omit browser-generated FetchMetadata in its client header view. Observed values must match; the real unchanged Nest guard independently requires exact metadata before its actor-bound201. Record that instrumentation limit, preserve failed reports and successful durable records, and never inject missing headers.

A bounded startup/binding/reload pass is **not** seven-journey owner acceptance or full staff-plane isolation. Real provider egress is not measured; `realProviderCalls:null` is not zero. After separately approved school access, perform A–G (login/school,CRM,membership,booking,attendance,available account/usage,AI interface safety) with actual persisted IDs/versions and reload recovery. Preserve localization/presentation/privacy work and #145's four native journey evidence; do not merge#145 or substitute it for this private owner environment.
