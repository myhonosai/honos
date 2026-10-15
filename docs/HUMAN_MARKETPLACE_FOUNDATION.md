# Human marketplace asset foundation

**Browse and save for review only. No purchase, installation, import, automation or execution.** `/community/marketplace` requires the existing signed human session and uses same-origin `/api/v1/staff/marketplace` rewrites. Private responses are `private, no-store`; the page is non-indexable. Nothing is publicly distributed.

## Exact authority

| Operation | Exact permission | Verified capacity | Additional live requirements |
| --- | --- | --- | --- |
| Browse curated current published releases | `marketplace.asset.read` | OWNER | `community.participate`, active eligible human exact-school IAM, active Essential/Core/Complete entitlement, organization and profile opt-in |
| Manage own descriptive drafts/releases/history | `marketplace.asset.manage` | OWNER or OPERATOR | Same community and human requirements; immutable exact-school membership author binding |
| Save own school planned selection | `marketplace.selection.save` and `marketplace.asset.read` | OWNER | Same requirements, current visible exact curated asset version |
| Curate/revoke a published release | No application permission or endpoint | Trusted migration/database owner, manual review only | Owner-only SECURITY INVOKER `hon.review_marketplace_asset(uuid,integer,text)` |

All three new permissions are sensitive and **not staff assignable**. Existing system OWNER roles receive them in migration 0085; creator operators need an explicitly reviewed exact-school role grant. OWNER role alone is not verification or opt-in. Parents, families, students, generic staff, HQ by role, AI/automation/integration/delegation and Action Engine contexts are denied. School/asset UUIDs are selectors, not authorization. Community profiles supply private membership/consent only: no discussion, directory, alias or profile content is projected.

## Descriptive contract

Closed keys: expected version, title, category (OPERATIONS/STAFFING/CURRICULUM), asset kind (TEMPLATE/BLUEPRINT), target module (WORK_ITEMS/STAFF_PLANNING/CURRICULUM), sorted unique required-permission allowlist, release notes, preview text and DRAFT/PUBLISHED/ARCHIVED status. Version is HON release revision, not arbitrary semantic code. Required permissions are descriptions only, **never granted, applied or checked as authorization to operate the target module**. There is no payload, attachment, URL, price, credential, code, external identifier or arbitrary JSON field. Bounds: title 100, notes 400, preview 1600 characters. Conservative shared JS/SQL checks reject contact/URL/markup/control/credential/code patterns. These are deterministic syntax restrictions, **not semantic PII detection**. Creators must never enter school-private data or customer PII; manual platform curation must confirm general, nonidentifying descriptive content before visibility. No automated/AI moderation claims.

Creators start private DRAFT; revise/publish or archive; PUBLISHED cannot return to DRAFT; ARCHIVED is terminal and archive metadata must be unchanged. Own history is only version/status, never others' draft/history. Shared projection contains only id/version/title/category/kind/module/required-permissions/notes/preview/PUBLISHED. No actor, principal, tenant, school, creator alias, profile, internal event/receipt or discussion fields.

## Manual platform curation

After a trusted human reviews the exact current published release for confidentiality and descriptive-only content, manually call `hon.review_marketplace_asset(asset_uuid, release_version, 'APPROVED')` using the trusted database-owner connection in an explicit transaction. To withdraw that approval call it with `REVOKED`. Do not grant this function, table, helper or owner connection to runtime/HQ/browser/service clients. The function takes the same transaction advisory lock as community consent/marketplace lifecycle and records immutable review versions. Publishing alone is never curation; each updated release requires fresh approval. Old approved versions are not browseable after a new release, archive, withdrawal, opt-out or creator IAM/verification revocation. No public catalog/curation service exists.

## Disabled selections and revocation

An owner can pin a visible exact release in **their exact school and own principal**. Version 1, `REQUIRES_REVIEW`, `enabled=false` are permanent database constraints. No apply/install/export/configuration/worker/Action Engine API exists. Duplicate exact selection has one row; requests retain fingerprints and original entity/version receipts. Live authority is checked before replay. Saved selection projections preserve IDs/version/status only when the release becomes unavailable and set `asset=null`; no copied preview/history survives revocation. Separate school/owner cannot read the row. Required permissions do not become school role/configuration changes.

## Persistence and hard boundary

Migration `0085_human_marketplace_assets.sql` adds seven FORCE-RLS deny-all private tables. Runtime has exactly three entrypoints: resolve, read, mutate. Helpers and curator are owner-only; direct table/column CRUD and browser/Supabase execute are denied. Immutable UPDATE/DELETE/TRUNCATE guards, composite school keys, optimistic versions and fingerprinted scoped receipts are checked by JS and canonical SQL verifiers. The community advisory lock serializes opt-in/release/curation; shared live actor/creator IAM/topology/entitlement/verification locks recheck after waits. Audit and the private `marketplace_outbox` insert atomically with mutations/receipts. Outbox is permanently `INERT`, `execution_allowed=false`, not global `outbox_events`; no worker can consume it.

## Validation and deferred scope

`pnpm db:test-marketplace` requires only the exact disposable `localhost:5432/hon_marketplace_validation` owner/runtime aliases; guard rejects other URLs. Run migration, canonical grants and global `db:verify-rls` locally; no configured remote credential is needed. API/web tests cover closed input/output, same-origin identity guards, disabled selections, retained-key manual retries and no-effect source boundaries. Integrity tests exercise real data/RLS, curation, revocation before replay and after live lock waits, cross-tenant/creator/owner constraints, atomic rollback, concurrency and verifier ACL/RLS/trigger drift.

Deferred: installations/executable templates, purchasing/payments/Shopify, public distribution, URLs/files/attachments, external adapters, AI/providers, Action Engine execution, automated review, automatic configuration changes and any consumer. This task applies **no remote migration, configuration change, deployment/publication or external integration**.

## Delivery validation evidence

- `pnpm check`: all workspace type checks passed.
- `pnpm test`: **397 tests passed** (91 auth, 96 web, 98 domain, 112 API). New tests include 4 API/contract/guard checks and 5 web SSR/HTTP/source-boundary checks. No external testing dependency was installed.
- `pnpm build`: complete workspace production build passed; `/community/marketplace` is dynamic/authenticated, not a static public asset catalog. Changed UI controls additionally received web tests/typecheck/build revalidation.
- Fresh disposable localhost database: all **85 migrations** applied, canonical runtime grants passed, `pnpm db:test-marketplace` passed and `pnpm db:verify-rls` verified **115 FORCE-RLS tables**. Integrity checks exercised 15 independent drift cases against both canonical SQL and JS verifiers, actual-row runtime/owner FORCE RLS, exact school isolation, opt-in and IAM withdrawal, creator lock-wait revocation, optimistic/concurrent/replayed writes and atomic rollback.
- Operational/configuration/provider/purchase/public/action tables stayed byte-for-byte unchanged during marketplace mutations. Every private marketplace event had an inert outbox record; no delivery consumer or external provider request exists.
- Remote migrations, environment/configuration changes, publication and external installation were **not performed**. Database activation and every platform curation remain manual trusted operations.
