# HON OS private owner test environment (real backend)

This runs the **actual HON OS application from this repository** on one computer, with real sign-in,
the real API and its authorization checks, and a private PostgreSQL database that keeps your test
data between sessions. It is the real-backend counterpart to the database-free fixture preview in
PR #101; it does not replace or duplicate that preview.

Nothing here is reachable from another computer, nothing is deployed, and no production database,
payment, messaging or AI provider is contacted.

## What is real and what is not

| Part | Status |
| --- | --- |
| Web app, API, database schema | **Real.** Built from the checked-out commit; all repository migrations; the API connects as the restricted `hon_runtime` role with forced RLS, exactly like production. |
| Sign-in | **Real HON login code path** (OIDC authorization code + PKCE + nonce, ID token verified against JWKS, HON session cookie). The identity provider is a small **local test provider** with four fixed test people and a private access code, so no external account is needed. |
| HQ authority | **Real IAM.** Only the test HQ owner gets the `HON_HQ_OWNER` grant, through the repository's existing bootstrap script. |
| School-owner authority | **Real IAM.** A school owner gets access only by accepting an HQ invitation through the real invitation screens. |
| Data | **Real records in a private, non-production database** that you create while testing. Nothing is pre-filled except the HQ owner grant. |
| AI agents, payments, messaging, provider costs | **Not connected.** No provider keys are passed to the app, so those features show as unavailable. Paid tests need a separate owner-approved budget. |

## Start it

Requirements: Node 22.23.4+, pnpm 10, PostgreSQL 16 or 17 binaries (`brew install postgresql@16` on a Mac), `openssl`.
Run as your normal user (not root).

```bash
pnpm install --frozen-lockfile
pnpm testenv:up            # first run builds the app, creates the database, prints the access code
```

Open the printed address (`https://localhost:3443/auth/login`). The browser warns about the local
certificate once; either accept it for `localhost` or trust the printed `ca.pem` file. Press
**Ctrl+C** to stop. Your data stays in `~/.hon-testenv` and is there next time.

To test a different branch, check it out and run `pnpm testenv:up --build`. New migrations are
applied on start. If you switch to a branch that does **not** have migrations your database already
applied, use a new explicitly approved state path; do not reset retained data to bypass migration-ledger safety.

For fresh-only isolated QA, use an approved absolute `HON_TESTENV_HOME` with an existing real parent
and `pnpm testenv:up --fresh`. This refuses existing directories, symlink aliases and in-repository
state. Existing environments require the exact private marker, owner and private permissions.
Startup failures await reverse-order resource cleanup, including PostgreSQL launch/readiness,
migration/ACL/bootstrap and gateway failures; shutdown failures are reported, not claimed successful.
Startup still applies migrations/ACLs and bootstraps HQ. This safety correction does not authorize
retained-state writes, new test-access exceptions, exposing localhost or deployment.

## Test people

| Test person | What they should be able to do |
| --- | --- |
| HQ Owner (test) | Open HQ, see the school directory, create school-owner invitations. |
| School A Owner (test) | Accept an invitation for `school-a-owner@hon-testenv.invalid`, then open the staff workspace for that school only. |
| School B Owner (test) | Same for `school-b-owner@hon-testenv.invalid`; used to check schools cannot see each other. |
| Unprovisioned visitor (test) | Signs in, but every HQ and school page should refuse access. |

## First test run

1. `pnpm testenv:create-school --name "Test Dojo A"` (and again for "Test Dojo B"). This calls the real
   HQ provisioning API signed in as the test HQ owner. The HQ provisioning form exists in the code
   but is not yet placed on an HQ page, so this command is the way to reach that API for now.
2. Sign in as **HQ Owner (test)** and open **HQ > School owner invitations**
   (`/hq/school-owner-invitations`). Select the school, enter the school owner's test email,
   generate a token, copy the token, then record the invitation. Note the invitation ID.
3. Sign in as **School A Owner (test)**, open `/account/owner-invitation`, enter the invitation ID and
   token, and accept.
4. Open `/staff/dashboard` as that owner.

After sign-in HON always lands on `/hq`; school owners and the visitor are correctly refused there
and should go to `/staff/...` instead.

## Known gaps (as of this commit)

- **New schools are created with access suspended**, because paid access is deliberately pinned
  inactive. The school owner is bound correctly but school modules stay unavailable ("Automatic
  current-school selection is unavailable"). HQ access exceptions exist in the API but have no HQ
  screen yet. Turning on test access for a test school needs an owner decision (see the PR).
- HQ school provisioning, HQ entitlement changes and HQ access exceptions have API contracts but no
  HQ page on `main`.
- No runtime path yet for staff or parent accounts, so there are no staff or parent test people.
- AI conversation and agents are not connected to a provider in this environment.

## Checks

```bash
pnpm testenv:test                                   # test identity provider and launcher guards
pnpm testenv:test-safety                            # dependency-free filesystem/injected-cleanup tests; no app/DB
HON_TESTENV_PLAYWRIGHT=<path to playwright> pnpm testenv:verify-browser   # login/provisioning/invitation smoke only
HON_TESTENV_VERIFY_PERSISTENCE=1 HON_TESTENV_PLAYWRIGHT=<...> pnpm testenv:verify-browser   # after a restart
```

The browser verifier is not seven-journey acceptance: a staff dashboard screenshot may still show
suspended access, its cross-school probe is HQ-plane denial, and server provider egress is not
measured. `realProviderCalls: null` means unknown, not zero. Actual mounted operational journeys
require separately verified staff/parent provisioning, operating entitlement and persistence evidence.

## Safety design

- Every listener binds to `127.0.0.1` (the API via the opt-in `HON_API_LISTEN_HOST=127.0.0.1`).
- Child processes receive a minimal explicit environment. The launcher refuses to start if
  `DATABASE_URL` or provider keys are set in your shell, or if `.env` files sit in the app folders.
- The web and API run with `HON_DEPLOYMENT_ENVIRONMENT=preview`, which production/staging startup
  guards treat as non-production. Session keys, audience, database passwords and the identity
  provider key are generated per environment and stored in a private 0700 directory outside the repo.
- The test identity provider accepts only its own client and exact callback, issues single-use
  60-second PKCE-bound codes, throttles wrong access codes, and never redirects an invalid request.
- `reset` deletes only a directory carrying this tool's marker file, after explicit confirmation.

Hosting this somewhere reachable from a phone or another computer is **not** part of this change and
needs a separate owner decision (provider, cost, access control, real OIDC client).
