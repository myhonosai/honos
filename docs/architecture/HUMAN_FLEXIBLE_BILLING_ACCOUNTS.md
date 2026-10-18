# Human flexible billing accounts

**Status:** First production-code slice implementing the owner-approved [Flexible CRM enrollment and family billing policy](FLEXIBLE_CRM_ENROLLMENT_FAMILY_BILLING_POLICY.md). This is a direct-human staff record boundary, not payment or enrollment activation.

## Scope and routes

| Layer | Closed surface |
| --- | --- |
| Staff page | `GET /staff/billing/accounts` — dynamic and `noindex`, behind the shared staff signed-session layout |
| Explicit payer lookup | `POST /api/v1/organizations/:organizationId/schools/:schoolId/billing/accounts/payer-lookup` |
| Account command | `POST /api/v1/organizations/:organizationId/schools/:schoolId/billing/accounts` |
| Browser marker | `X-HON-Human-Command: billing.account.create` |

The page uses the existing server-authoritative current reporting-school resolver and, only when necessary, its bounded authorized school choices. These are UI aids, not scope authority. Every lookup and create route independently resolves the current human against the exact route school and `billing.account.create` permission.

## Policy implemented

1. `billing_accounts.account_classification` is additive: `CANONICAL` or `ADDITIONAL`.
2. Migration `0152_flexible_billing_accounts.sql` deterministically classifies existing rows by `(created_at, id)` within `(organization, school, responsible_person)`: earliest is canonical, all later rows are additional. It never deletes, merges, reassigns, or changes currency.
3. A partial unique index allows **at most one** `CANONICAL` account per organization, school, and responsible person. Existing forced RLS is reasserted; no payment schema, grant, or policy widening is added.
4. A normal command (`createAdditional` omitted/false) reuses the canonical account only if currency matches. The response is persisted with `reused: true`, classification, and the account summary; the initial reuse returns HTTP 200. A normal command with a canonical currency mismatch returns `CANONICAL_ACCOUNT_CURRENCY_CONFLICT`; it never mutates currency.
5. With no canonical account, a normal command creates the canonical account. An explicit additional command requires a current canonical account and `additionalReason` of 1–500 non-control, untrimmed characters; it creates a distinct `ADDITIONAL` account. It cannot implicitly create a canonical account first.
6. Each initial create/reuse command reserves the existing idempotency record. Same key plus different normalized payload is rejected. Completed replay returns the stored full response with HTTP 200 and `meta.replayed: true`; replay produces no duplicate audit/outbox evidence.

## Authority, audit, and side effects

`BillingAccountHumanUiGuard` rejects selectors/query strings, non-JSON/non-POST/non-same-origin browser requests, all unexpected `X-HON-*` authority headers, navigation fetch metadata, delegation/action context, and non-direct identity shape. It requires the exact marker and trusted configured origin. The controller then resolves current scope; the service performs in-transaction direct-human/active-principal/permission rechecks, entitlement check, person current-school check, and a relation lock before account selection/creation.

- **Creation:** immutable `billing.account.create` audit evidence plus the existing inert `billing.account.created` v1 outbox event. An additional-account reason is stored in audit evidence only, not the outbox payload.
- **Reuse:** immutable `billing.account.reuse` audit evidence and no outbox event; it is a no-op against the account record.
- **Payer lookup:** an explicit 2–20 character POST returns at most 10 current-school people with only ID and display name, after `billing.account.create` authorization. It returns no account history and does not select a payer automatically.

The browser retains query choices, payer selection, idempotency key, confirmation, receipt, and uncertainty retry **only in memory**. It allocates an idempotency UUID only at explicit confirmation, permits retry only after an uncertain result, and clears relevant state on edits, access loss, or page inactivity. It displays account ID, currency, classification, and reuse only when returned by a verified response.

## Explicit exclusions

This slice does **not** create or change memberships, invoices, payment methods, schedules, charges, provider state, communications, AI/Action Engine work, automation, collection, financial credentials, payer transfer, account merge, account lifecycle, or deployment behavior. A billing account response is not a payment, enrollment, agreement, membership, provider, or collection fact.

## Verification path

- API/guard/service: `apps/api/test/billing-account-policy.test.cjs`
- Browser transport/UI/route: `apps/web/test/billing-account-workbench-http.test.ts`, `apps/web/test/billing-account-workbench-ui.test.tsx`, `apps/web/test/billing-account-workbench-route.test.tsx`
- Disposable local database/RLS/integrity: `packages/database/scripts/test-flexible-billing-account-integrity.mjs` via `pnpm db:test-flexible-billing-accounts`. The script refuses non-localhost database URLs.

`TODO.md` records this delivered policy slice only after the focused browser/API checks, the guarded disposable-local database proof, `pnpm db:check`, and root workspace regression/build evidence are complete.
