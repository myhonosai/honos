# HON HQ Access Provisioning

HON HQ is a **separate privileged control plane**. A school owner, administrator, or any school role does not receive HON HQ access automatically.

## Current owner test path

1. Configure the non-privileged `HON_RUNTIME_DATABASE_URL` and start the application with verified session identity. The `/auth/login` and `/auth/callback` routes implement the Manus OAuth exchange and issue a validated, `SameSite=None; Secure` `webdev_app_session` cookie.
2. Sign in once through HON so the account has a `hon.users` and linked human `hon.principals` record.
3. Sign in through `/auth/login`. Retrieve the verified `external_subject`, name, and email from authenticated `GET /api/identity/me` (or the equivalent server endpoint); do not guess an identity from an email address.
4. Execute [020_bootstrap_hq_owner.sql](../../infra/postgres/020_bootstrap_hq_owner.sql) through the **privileged migration/admin connection**, replacing its placeholder with that exact subject, or run the parameterized `bootstrap:hq-owner` administrator utility with `HON_HQ_OWNER_EXTERNAL_SUBJECT` set only from the verified endpoint.
5. Sign in again and call `GET /v1/hq/session`. It will return the resolved `HON_HQ_OWNER` scope only for the bound account.
6. Visit `/hq` to test the control-plane surface.

## School tenant onboarding

The governed `POST /v1/hq/organizations` boundary is available only after the separate HQ gate resolves `hq.onboarding.manage`. It creates an organization, selects an explicit **Essential**, **Core**, or **Complete** entitlement, creates the first school, creates a scoped system `OWNER` role, grants the current HQ operator that school role, and atomically records audit and `organization.provisioned` outbox evidence. The form intentionally requires the owner to choose the legal name, school-facing name, first location, slug, timezone, and commercial tier; HON does not infer a tenant or entitlement from a test account.

## Security invariants

- `hon.hq_operator_grants` is RLS-enabled and force-RLS; normal runtime data access has no direct table grant.
- `hon.resolve_hq_operator_scope` is the identity-to-HQ grant resolver and is `SECURITY DEFINER` with a fixed `pg_catalog, hon` search path. Reviewed fixed provisioning/configuration functions repeat this live HQ gate; they do not grant runtime direct HQ table access.
- The initial bootstrap is intentionally **not** a public route. Binding an account to HON HQ owner authority is a privileged ownership action. The parameterized administrator utility provisions/updates only the verified user/principal profile and its isolated HQ owner grant; it creates no school role and no tenant-data access.
- Future HQ roles may receive explicit permission codes, while `HON_HQ_OWNER` retains full `hq.*` access through the resolver.
- Future support impersonation must be separately implemented with an explicit reason, narrow tenant/time scope, audit evidence, and visible operator status.

## AI provider configuration

The [HQ AI Provider Control Plane](HQ_AI_PROVIDER_CONTROL_PLANE.md) adds separate `hq.ai.providers.read` and `hq.ai.providers.manage` gates, redacted catalog/provider/policy configuration, and selection-only routing preview. It adds no tenant settings/config access, provider invocation, secret dereferencing, or Action Engine authority.
