# Database TLS, connections and production configuration

Status: **source implemented and proven against a private TLS cluster; NOT verified against Supabase.** Nothing here has been deployed or applied to a live project.

## What changed (P0-3)

Every HON PostgreSQL client now builds its connection through `verifiedDatabaseConnection()` (`packages/database/src/database-tls.ts`):

| Client | File |
|---|---|
| API runtime pool | `apps/api/src/foundation/runtime-pool-options.ts` (used by `runtime-database.service.ts`) |
| Migrations | `packages/database/scripts/migrate.mjs` |
| RLS / least-privilege verifier | `packages/database/scripts/verify-rls.mjs` |
| HQ owner bootstrap | `packages/database/scripts/bootstrap-hq-owner.mjs` |
| Read-only migration status | `packages/database/scripts/migration-status.mjs` |

Rules:

- `localhost`, `127.0.0.1`, `[::1]`: plaintext, unchanged (disposable fixtures only).
- Any other host: TLS with `rejectUnauthorized: true` and the configured CA. Node checks the chain **and** the host name. There is no switch to turn verification off.
- No CA configured for a remote host: refused before connecting (`PERSISTENCE_NOT_CONFIGURED` at runtime).
- URL parameters that node-postgres would let override TLS or the host (`ssl`, `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `sslpassword`, `sslnegotiation`, `uselibpqcompat`, `host`, `hostaddr`, …) are refused. Remove `?sslmode=require` from copied Supabase URLs; HON configures TLS itself.
- Errors never contain the URL, host, password or certificate.

The previous `ssl: { rejectUnauthorized: false }` encrypted traffic but accepted any server certificate, so an on-path attacker could impersonate the database and capture the runtime or migration password. `test-database-tls-verification.mjs` demonstrates that the old setting connects to an unverifiable server and the new one refuses it.

## Configuration (owner action, secret manager only)

| Variable | Where | Value |
|---|---|---|
| `HON_DATABASE_CA_CERT` | API, migration job | PEM text of the Supabase project CA (Dashboard → Database → Settings → SSL Configuration, file `prod-ca-2021.crt`). Escaped `\n` single-line values are accepted. |
| `HON_DATABASE_CA_CERT_FILE` | alternative | Path to the same PEM file. Set only one of the two. |
| `HON_DEPLOYMENT_ENVIRONMENT` | API | `production`, `staging`, `preview` or `development`. **Required whenever `NODE_ENV=production`.** |
| `HON_RUNTIME_DATABASE_POOL_MAX` | API, optional | Pool size per API instance, 1–40, default 8. |

The CA certificate is public material, not a secret, but keep it in deployment configuration rather than Git unless you decide otherwise.

## API startup gate (`apps/api/src/foundation/production-config.ts`)

A production build refuses to start, logging only stable codes, when:

| Code | Meaning |
|---|---|
| `DEPLOYMENT_ENVIRONMENT_REQUIRED` / `_INVALID` | `NODE_ENV=production` without a valid `HON_DEPLOYMENT_ENVIRONMENT` |
| `DEVELOPMENT_DEPLOYMENT_IN_PRODUCTION_BUILD` | labelled development in a production build |
| `RUNTIME_DATABASE_TLS_INVALID` | remote runtime DB without a valid CA, or with URL TLS overrides (all environments) |
| `RUNTIME_DATABASE_URL_REQUIRED` | production/staging without `HON_RUNTIME_DATABASE_URL` |
| `RUNTIME_DATABASE_LOOPBACK_FORBIDDEN` | production/staging pointed at a plaintext loopback DB |
| `MIGRATION_CREDENTIAL_IN_API_PROCESS` | production/staging API process holds `DATABASE_URL` (the privileged migration credential). Run migrations as a separate job. |
| `RUNTIME_USES_MIGRATION_ROLE` | the runtime URL uses the migration role |
| `OIDC_AUTH_REQUIRED` | production/staging not in `HON_AUTH_MODE=OIDC` (the Manus development adapter is refused) |
| `SESSION_CONFIGURATION_INVALID` | HON session secret/audience invalid |
| `RUNTIME_POOL_MAX_INVALID` | pool size outside 1–40 |

`preview` keeps the development auth adapter available but still requires verified TLS for a remote database.

## Pooling, timeouts and recovery

- Runtime: Supabase **Session Pooler** (`hon_runtime.<project-ref>`), `pg.Pool` max 8 per instance, 5 s connect timeout, 30 s idle timeout, connections recycled after 30 min (`maxLifetimeSeconds`), TCP keep-alive on, `application_name=hon-api`.
- Size so that `API instances × pool max` stays well below the project's Session Pooler pool size (Dashboard → Database → Connection pooling). Example: 2 instances × 8 = 16.
- Per-transaction `statement_timeout='5s'` and `lock_timeout='3s'` are already set inside each runtime transaction (existing code, unchanged).
- Idle-client errors (database or pooler restart) are now handled: the pool discards the client and logs `database.idle_client_error` instead of crashing the process (previously an unhandled `'error'` event).
- `SIGTERM` closes the pool (Nest shutdown hooks are now enabled), so rolling deploys drain cleanly.
- Readiness: `GET /v1/health/ready` checks the runtime role posture and runs `SELECT 1`; use it as the platform health check. `GET /v1/health` is liveness only.
- The migration runner uses the **direct** connection (or Session Pooler). It takes a session advisory lock, so it must not use the transaction pooler (port 6543).

## Rollout (staged; each step needs owner authorization)

1. **Dev/staging Supabase project first.** Set `HON_DATABASE_CA_CERT` and `HON_DEPLOYMENT_ENVIRONMENT=staging`, remove any `sslmode` parameter, deploy, confirm `GET /v1/health/ready` = 200. Run `pnpm db:status` from the migration job (verifies the direct/migration host against the same CA).
2. Negative check on staging: temporarily use a different CA → readiness must fail with `PERSISTENCE_NOT_CONFIGURED` (not connect).
3. Production: same configuration, deploy, readiness 200.
4. Optional: enable **Enforce SSL** in the Supabase dashboard after confirming every client (including any Manus app sharing the project) uses TLS. Supabase documents a brief database reboot when this setting changes.
5. Revert path: redeploy the previous build (configuration-only). There is intentionally no runtime flag to disable verification.

**Open risk (NOT VERIFIED):** Supabase's documentation shows `verify-full` with the project CA against the shared pooler host, but nobody has yet confirmed the HON Session Pooler and direct hosts present certificates that validate against `prod-ca-2021.crt` with host-name checking. Step 1 is the proof; if it fails, stop and do not deploy to production.
