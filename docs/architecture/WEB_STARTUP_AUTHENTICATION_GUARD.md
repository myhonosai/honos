# Web authentication startup boundary

This change guards the existing `pnpm --filter @hon/web start` / `next start`
entry point. It is separate from PR #89's API/database/telemetry hardening and
neither merges nor alters that PR. It changes no session schema, IAM, tenant
resolver, billing contract, API route, database or migration.

## Configuration contract

`next.config.ts` invokes `assertWebStartupConfiguration` before returning server
configuration. No requests, discovery, JWKS lookup or token exchanges occur.

| Execution | Required behavior |
| --- | --- |
| `next build` / export | No runtime authentication secrets or deployment settings required; the artifact is revalidated when served. |
| `next dev`, no deployment label | Existing local development remains available. Authentication routes retain their existing validators. |
| `next start` | Explicit `HON_DEPLOYMENT_ENVIRONMENT` required, independently of `NODE_ENV`. |
| `production` or `staging`, either server command | Exactly `HON_AUTH_MODE=OIDC`; the complete existing `oidcConfig` validator must pass. No Manus/development fallback. |
| `development` on `next start` or with `NODE_ENV=production` | Refused; an isolated production-build preview must identify itself as `preview`. |
| Explicit `preview` | Preserve the existing isolated-reference/synthetic-fixture and explicit development-adapter workflows. This is not authentication readiness or a private-hosting guarantee. |
| Unknown, blank or misspelled deployment identity | Refused. |

Production/staging use the existing server-only settings documented in
[Production authentication](PRODUCTION_AUTHENTICATION.md): HON signing key,
deployment-specific audience, HTTPS public origin, explicit OIDC issuer and
endpoints, client, scopes, exact callback, permitted signing algorithms and the
registered token-auth method/secret. The guard does not create new credential
storage or inspect secret files. Failure messages contain only stable, fixed
codes, without environment values, provider exceptions or nested causes.

This is **configuration validation**, not verification that a real provider,
client registration, secret, signing key or hosting environment is operational.
It grants no HQ, school or family authority. The API and live IAM/RLS checks
remain independently mandatory. Verified-email reader-first rollout from P0-1
is unchanged; the guard does not enable verified-email issuance.

## Preview and deployment policy boundaries

- Operators must never label a customer-facing production/staging service as
  `preview`. Software cannot infer hosting privacy from an environment label.
  Keep previews access-controlled, isolated from real customers, credentials and
  databases, with separate test signing keys/audiences. The existing API's
  deployment labels already distinguish these environments; this change reuses
  them without inventing a hosting allowlist or granting development identities
  access to customer data.
- A preview with no auth config can show existing public reference pages;
  `/auth/login`, identity and readiness remain unavailable/fail closed. Synthetic
  signed-session harnesses can retain their isolated session-only configuration;
  this does not configure real login. Existing fixture runners now explicitly
  declare `preview` rather than accidentally resembling production.
- An explicit `MANUS_DEVELOPMENT` preview retains the documented development
  adapter. It is refused in production/staging. A public real-identity preview
  needs a separately configured and approved OIDC client and exact callback.
- **Owner/operations question:** approve the actual preview hosting/access policy,
  allowed origins and separate deployment identities before hosting. No preview
  service is created or exposed by this PR.
- The repository currently uses Next's standard server, not standalone output.
  **Standalone/custom servers that deserialize prebuilt configuration without
  loading `next.config.ts` are not approved by this guard.** Before adopting such
  an entry point, integrate and test the same runtime guard there; do not assume
  the credential-free build validated runtime configuration. No new runtime mode
  or deployment default is silently approved here.

## Verification

- `apps/web/test/web-startup.test.ts`: positive/negative production and staging,
  missing identity, typos, missing/invalid OIDC settings, secure callback/session
  configuration, no network calls, sanitized errors, build/development/preview
  compatibility and actual Next config wiring.
- Existing `auth-routes.test.ts` continues to test real transport handlers,
  OIDC code/state/nonce/PKCE, signed sessions, expired/cross-app rejection,
  development compatibility and sanitized failures with local fake responses.
- `apps/web/scripts/web-startup-verification.mjs`: actual built `next start`
  refusal/success, production/staging readiness, redirect-only login, valid and
  expired/cross-audience signed sessions, fail-closed unconfigured previews,
  explicit development-adapter preview, desktop/mobile idle account UI, keyboard,
  overflow and axe. Its child environments contain only synthetic `.invalid`
  endpoints; requests never follow provider redirects. Browser external traffic
  is blocked. No provider credentials/calls or database are needed.
- The existing draft-safe account workflow includes these checks and the
  existing mounted invitation privacy/retry/browser and full disposable database
  regressions. Regular CI can remain draft-skipped; report that separately.

The exact head, actually executed results and artifact links belong in the PR
verification report, not an assumed passing claim in this source document.
Production deployment still requires independent review, explicit owner approval,
real isolated OIDC/TLS/environment verification, release checksum/status preflight,
backups and restricted/redacted logging. No deployment or activation is authorized.
