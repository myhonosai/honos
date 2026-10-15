# Parent / Eian Billing Read Foundation

## Scope

This is a **conventional, read-only, current-family billing observation** at `GET /v1/parent/billing` and the guarded, no-index `/parent/billing` UI. It is not a billing portal, payment flow, membership self-service flow, or Eian action.

The browser supplies no organization, school, family, child, account, payer, membership, invoice, payment, provider, or pagination selector. The API receives only a verified session subject. `hon.read_parent_billing_view(text)` resolves exactly one live scope using `hon.resolve_parent_journey_scopes`, then requires `PRIMARY_GUARDIAN` or `SECONDARY_GUARDIAN`. A `VIEWER`, staff member, HQ operator, unknown user, revoked principal/grant, inactive family/school/organization, or multiple current-family scope fails closed.

> A current-family ambiguity never chooses a school or family automatically.

## What is shown

The strict `ParentBillingView` contract permits only:

| Record | Allowed facts |
|---|---|
| Membership | Current-family student display linkage, verified designated-family-billing-contact linkage (without payer identity), state, term start/end facts |
| Invoice | Current-family student display linkage, invoice state, currency, total minor units, due timestamp |
| Payment attempt | State, amount/currency, initiated and reconciled timestamps |

The projection follows a fixed relationship path:

`guardian current family → STUDENT participant → membership → billing account → current-family GUARDIAN + is_billing_contact → linked invoice → linked payment attempt`

If **any** current-family child membership has no explicit designated current-family guardian payer link, both membership and invoice sections return `UNAVAILABLE / PAYER_LINK_UNVERIFIED`. The UI explains that facts were withheld rather than inferred. Empty `AVAILABLE` lists mean no verified record was returned; they do not imply payment, membership, collection, or renewal outcomes.

## Deliberate exclusions

No response field or endpoint exposes IDs, payer identity, billing-account identity, plan code, payment schedule, payment method, card/bank data, provider code/account/reference/token, invoice line items, discounts, credits, refunds, notices, staff data, or another family’s data.

There are no mutation routes for invoices/payments/memberships and no refund, discount, credit, cancel, renewal, collection, charge, payment-method, or member-change control. This slice calls no provider and has no credential, webhook, payment collection, automatic retry/outcome, Action Engine, AI, voice, communications, automation, audit, or outbox behavior.

## Database and runtime boundary

Migration `0102_parent_billing_read_foundation.sql` reasserts forced RLS on the four source relations and adds only relationship indexes. Its single fixed `SECURITY DEFINER`, `pg_catalog,hon` function owns family authorization and emits a redacted JSON projection; it has EXECUTE only for `hon_runtime`. `PUBLIC`, `anon`, `authenticated`, and `service_role` are revoked.

The application makes the projection call in `REPEATABLE READ READ ONLY` with short transaction timeouts. It verifies scope twice before the query and twice after it, validates the closed response allowlist, and clears the client’s prior view before/refocus/refresh access checks. Canonical Supabase provisioning and verification scripts explicitly reconcile and inspect this function without widening billing table grants or default privileges.

## Validation

`pnpm db:test-parent-billing` is intended only after the existing explicit `pnpm db:setup-parent-journey` disposable-local reset. It asserts current guardian-only access, cross-family/school suppression, insufficient payer-link withholding, ambiguous/revoked scope denial, forced RLS/function ACL posture, response redaction, and unchanged table/audit/outbox counts. It must never target a remote or Supabase database.

## Known limits / follow-up

This foundation does not make a payer legally authorized to pay, determine whether an amount is collectible, show payment-method availability, establish a receipt, or say an invoice is settled. Any future method update, payment collection, receipt/download, member change, refund/credit/discount, renewal/cancellation, provider integration, notification, or Eian action requires an independently reviewed contract, authority model, mutation service, audit/outbox semantics, provider boundary, reconciliation and failure handling.
