# HON production authentication

## Trust boundary

Production uses **generic OIDC**, not a Manus runtime identity dependency. Set `HON_AUTH_MODE=OIDC` explicitly on the web and API services. The authorization endpoint, token endpoint, JWKS URI, issuer, client, scopes, and exact callback URI are supplied through **protected server runtime environment variables**. There is no provider hardcoding or automatic discovery. No identity-provider secret, access token, refresh token, or ID token is returned to the browser, saved in the HON session, or included in errors/logs by this implementation.

The web server completes authorization-code exchange and verifies the ID token with `jose` and the configured JWKS: permitted asymmetric algorithm, signature, exact issuer, client audience, authorized party where required, subject, issued-at, expiration, and the browser transaction's nonce. PKCE uses `S256`; state and nonce are cryptographically random. The verifier, challenge, state, nonce, and exact callback are bound inside a signed, HttpOnly, ten-minute `hon_auth_transaction` cookie. Callbacks reject missing, mismatched, expired, malformed, cross-app, or forged bindings **before** exchanging a code. Transactions are cleared on success and failure; the provider must enforce one-use authorization codes. A new login supersedes an older in-flight login in the same browser.

The API verifies only **HON-owned `hon_session` cookies**, never provider bearer tokens or `webdev_app_session`. Web and API share `@hon/auth`'s strict session validation; the historical `ManusIdentityService` export is only an alias to the provider-neutral `HonIdentityService`.

## Web startup enforcement

The standard web server now requires an explicit deployment identity at startup.
Production/staging require the complete OIDC configuration below; development
sign-in is refused there. Builds remain secret-free and explicitly isolated
previews retain existing fail-closed routes. See the
[web startup guard contract](WEB_STARTUP_AUTHENTICATION_GUARD.md), including the
preview hosting decision and unsupported standalone/custom-server release gate.

## Required protected runtime configuration

Do not use `NEXT_PUBLIC_` names, browser-delivered config, client components, or database/UI settings for these values. `.env.example` contains placeholders, not deployable secrets. Provision actual values through the deployment environment's secret manager; do not paste secrets into chats, commits, logs, or test output.

### Both web and API

| Variable | Meaning |
| --- | --- |
| `HON_AUTH_MODE` | Exactly `OIDC` or `MANUS_DEVELOPMENT`; any other value, including an empty string, fails closed. |
| `HON_SESSION_JWT_SECRET` | A separate HON-owned cryptographically random signing key, at least 32 bytes. Never reuse `MANUS_JWT_SECRET`. Share only between trusted web/API services for this application. |
| `HON_SESSION_AUDIENCE` | Unique, stable application/deployment identifier. Explicitly required in OIDC; prevents cross-app reuse even if signing keys are accidentally shared. Use distinct keys and audiences between production and previews. |

The API needs only these settings to validate an already-issued HON session. It does **not** need Manus credentials, OIDC client secrets, or provider connectivity. The web requires the complete OIDC configuration below to initiate/complete login.

### OIDC web server

| Variable | Meaning |
| --- | --- |
| `HON_PUBLIC_ORIGIN` | Canonical public HTTPS origin, with no path/query/fragment or credentials; e.g. `https://hon.example.invalid`. |
| `HON_OIDC_ISSUER` | Exact HTTPS issuer from provider metadata, including any tenant path or trailing slash; no query/fragment/credentials. |
| `HON_OIDC_AUTHORIZATION_ENDPOINT` | Explicit HTTPS authorization endpoint. |
| `HON_OIDC_TOKEN_ENDPOINT` | Explicit HTTPS server-side token endpoint. |
| `HON_OIDC_JWKS_URI` | Explicit HTTPS public signing-key endpoint. Keys are cached; rollover uses `jose`'s remote JWKS refresh/cooldown. |
| `HON_OIDC_CLIENT_ID` | OIDC client identifier; ID-token `aud`/`azp` must identify this client. |
| `HON_OIDC_SCOPES` | Space-separated scopes including `openid`; commonly `openid profile email`. |
| `HON_OIDC_REDIRECT_URI` | Must equal `HON_PUBLIC_ORIGIN` + `/auth/callback` exactly. No query/fragment or request-controlled redirects. |
| `HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD` | Exactly `none`, `client_secret_basic`, or `client_secret_post`, matching the client registration. Confidential clients should generally use `client_secret_basic`. |
| `HON_OIDC_CLIENT_SECRET` | Required only for the two confidential-client methods. Must be absent/empty for `none`. Sent only in server-to-server token exchange. |
| `HON_OIDC_ID_TOKEN_ALGORITHMS` | Optional comma-separated strict asymmetric allowlist; defaults to `RS256`. Supported: `RS256/384/512`, `PS256/384/512`, `ES256/384/512`, `EdDSA`. Set only algorithms advertised by the configured provider; symmetric/unsigned algorithms are forbidden. |
| `HON_OIDC_END_SESSION_ENDPOINT` | Optional explicit HTTPS provider logout endpoint (OIDC `end_session_endpoint`, or Auth0 `https://<tenant>/v2/logout`). When set, `POST /auth/logout` clears HON cookies and then redirects there with `client_id`, `post_logout_redirect_uri` and `returnTo` all from protected config, returning to `<HON_PUBLIC_ORIGIN>/`. Register that exact URL (trailing slash included) as an allowed logout URL. When absent, only the HON session ends and the next sign-in can silently reuse the provider session. |

A public HTTPS preview should use its public origin and exact `/auth/callback` URI. OIDC redirects are constructed from protected environment configuration, **not** forwarded headers, query parameters, request host, or user input. Cookies on public HTTPS origins are host-only, `HttpOnly; Secure; SameSite=None`, with no `Domain`. The transaction has `Path=/auth`; the session has `Path=/`. OAuth responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer` to avoid leaking codes through redirect referrers.

No provider account/client settings are changed by this implementation or its validation. An operator must separately ensure that their provider supports authorization code + PKCE S256, the selected token-auth method and algorithms, and the configured exact HTTPS callback. This document is configuration guidance, not authorization to modify external accounts.

## One HON session schema

`hon_session` is an HS256 JWT with a strict `typ=JWT` header and only these payload fields:

```json
{
  "externalSubject": "normalized external identity key",
  "displayName": "optional normalized display name",
  "email": "optional normalized email",
  "iss": "OIDC or MANUS_DEVELOPMENT",
  "aud": "HON_SESSION_AUDIENCE",
  "iat": 1700000000,
  "exp": 1700043200
}
```

`iat` and `exp` are mandatory integer seconds; maximum lifetime is **12 hours**, with no expiration grace period. Extra payload/header claims, array audiences, another issuer mode, future issuance, excessive lifetime, invalid profiles, malformed/ambiguous cookies, or invalid signatures are rejected. There are no roles, organization/school IDs, principal IDs, raw tokens, or authority claims. Sessions are signed JWTs, **not encrypted**; profile fields are readable to the cookie owner and should contain no confidential data. There is no refresh-token storage or automatic session renewal in OIDC mode; after expiry, reauthenticate. Rotate the signing key consistently across web/API to invalidate all current sessions.

OIDC identity keys are deterministic and issuer-namespaced:

```text
externalSubject = "oidc:" + encodeURIComponent(exactIssuer) + ":" + encodeURIComponent(exactSub)
```

The opaque provider subject is never silently trimmed/reassigned. Display names and emails are trimmed and bounded; they are optional and are **not** authorization/account-linking signals. Treat email as provider-asserted profile data, not proof of mailbox verification. HON IAM must explicitly associate the exact namespaced subject with an existing principal or a separately governed provisioning workflow. Never automatically grant HQ/tenant authority or link accounts by email. Changing issuer/client/subject behavior requires a deliberate IAM migration, not an authentication fallback.

`HonIdentityGuard` attaches only the verified normalized identity. Existing scope resolution (`hon.resolve_authorized_scope` and other IAM resolvers), organization matching, permissions, `hon_runtime` posture checks, tenant transaction context, and PostgreSQL RLS remain mandatory and unchanged. A valid login is **not** a tenant/HQ authorization grant.

## Explicit Manus development adapter

`HON_AUTH_MODE=MANUS_DEVELOPMENT` deliberately retains the development portal `/app-auth` and `ExchangeToken`/`GetUserInfo` RPC flow. Its required web settings are `MANUS_PROJECT_ID`, `MANUS_OAUTH_PORTAL_URL`, `MANUS_OAUTH_API_URL`, `MANUS_JWT_SECRET`, and the separate `HON_SESSION_JWT_SECRET`. `HON_SESSION_AUDIENCE` may default to `MANUS_PROJECT_ID` in this mode, although an explicit audience is recommended.

For backward compatibility, **only when `HON_AUTH_MODE` is absent, `NODE_ENV` is not `production`, and all four Manus variables exist**, the development adapter is selected implicitly. Partial Manus config, an explicit invalid mode, or absent mode in production never falls back. Isolated previews using Next production servers must explicitly declare `HON_DEPLOYMENT_ENVIRONMENT=preview` and select the development mode if that adapter is desired. This is not permission to use the development adapter in customer-facing production or staging. A HON-owned key is required even for development; there is intentionally no implicit key reuse or insecure hardcoded key.

The development callback issues the same normalized `hon_session` and also retains `webdev_app_session` for the development adapter only. A still-valid legacy development cookie can be migrated to `hon_session` by visiting `/api/identity/me` in development mode. An invalid HON cookie never falls back to the legacy cookie. The API accepts no legacy cookie in either mode. Existing in-flight pre-upgrade OAuth attempts must restart `/auth/login` to obtain the signed transaction. Development subjects retain the existing Manus `openId` identity key.

`HON_PUBLIC_ORIGIN` is recommended in this mode too. If absent, the development adapter preserves public preview forwarded-host handling with strict single-host/protocol validation. HTTP is permitted only for local `localhost`/`127.0.0.1` development, using `SameSite=Lax`; external public origins require HTTPS and use `SameSite=None; Secure`. Trust forwarded headers only behind a proxy that overwrites them.

## Offline readiness and verification

`GET /api/identity/readiness` runs a **pure configuration validator** and returns only:

```json
{ "data": { "mode": "OIDC", "ready": true, "code": "AUTH_READY" } }
```

Invalid/incomplete configuration yields HTTP 503, `ready=false`, and `AUTH_NOT_CONFIGURED` (mode may be null). This endpoint never returns environment values or validation exceptions and never performs discovery, JWKS lookup, token exchange, user-info lookup, or other external auth requests, in **either mode**. Readiness certifies local configuration syntax, not provider reachability, correct credentials, registration, or key availability. Provider requests happen only in a bound login callback. Failures are sanitized; this code does not log authentication inputs or upstream errors. Configure proxy/APM/access logs to redact callback query strings, cookies and authorization headers as well.

Run `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm db:check`. Authentication tests use generated **test-only** keys and local mocked HTTP responses; no live provider or production secrets are needed. They cover signature/claim/audience/issuer/expiry rejection, forged/cross-app cookies, fail-closed config, state/nonce/PKCE/redirect binding, no Manus dependency in OIDC, development compatibility, tenant-scope guard behavior, secure preview cookies, and error redaction. Existing database security suites remain applicable; no RLS or runtime-role guard is disabled by this change.
