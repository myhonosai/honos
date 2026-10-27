# Pitbull Payments Adapter Requirements (PPA-v1)

**Status:** Future planning requirement only. `Pitbull Payments` is a name under consideration, not an approved vendor, provider API, account, credential, payment method, webhook contract, sandbox, live environment, merchant model, or implementation authorization.

## Separation is mandatory

PPA-v1 is server-only, provider-flexible, `UNCONFIGURED`, and execution-disabled. It contains three non-interoperable profiles:

| Profile | Permitted scope | Never coupled to |
| --- | --- | --- |
| `HON_SAAS_SUBSCRIPTION` | HON charging an organization for HON service; immutable accepted commercial terms and HON commercial evidence | School memberships, tuition accounts, school invoices, student/family/payer records, school payment methods |
| `SCHOOL_MERCHANT_TUITION` | Exactly one school’s own merchant/tuition relationship after explicit merchant-of-record/account-binding decision | HON SaaS account, checkout, invoice/evidence, entitlement, offer, or founder logic |
| `CUSTOMER_STUDENT_PAYMENT_DATA` | A separately approved protected custody plane for payer/student/guardian/payment-method/mandate information | CRM, family/student records, SaaS records, ordinary audit/outbox, URLs, browser state, telemetry, logs, support dashboards |

A record, credential binding, provider account, webhook stream, idempotency namespace, reconciliation ledger, audit projection, and retention policy belongs to exactly one profile. A provider reference string never bridges profiles.

A tuition event cannot create, renew, suspend, cancel, credit, or qualify a HON SaaS subscription. A SaaS payment cannot select a school merchant relationship. A school provider account cannot be used as the HON SaaS account, even if a future owner chooses the same processor for both domains.

## Authority and custody contract

PPA accepts only server-derived, closed, immutable commercial or tuition instructions. Browser input, URL, provider metadata/default account, account label, external ID, webhook body, invoice reference, or status cannot choose profile, school, merchant account, provider account, amount, currency, payer, authorization, or lifecycle transition.

A `CredentialBindingReference` is opaque and purpose-bound. It may identify a policy, steward, lifecycle, purpose, and key version. It never exposes raw secret material, vault location, OAuth code, refresh token, signing key, account inventory, or provider error content. Webhook-signing verification credentials and post-routing provider API/data-operation credentials are separate, non-substitutable bindings. A named server resolver returns material only in process memory after current scoped authorization and lifecycle checks.

Missing, stale, revoked, cross-domain, or purpose-mismatched bindings return a bounded `UNCONFIGURED` or `REVIEW_REQUIRED` result **before I/O**. Existing Stripe test-mode evidence does not approve Pitbull, school merchant processing, customer-data custody, sandbox, live mode, or any reusable secret.

HON never collects, receives, transmits, stores, logs, or replays raw card data, PAN, CVV/CVC, magnetic-stripe data, bank-login credentials, provider secret material, or a payment-method credential. Any later approved card-entry/tokenization path must use an approved provider-hosted surface and may return only narrowly normalized profile-allowed evidence.

## Evidence ingress, idempotency, and unknown outcomes

A payment webhook is evidence ingress, never direct business authority. A future approved fixed endpoint/installation may select eligible historical signing-key generations, verify bounded raw bytes before parse, normalize only closed profile-allowed evidence, reserve stable event identity, compare canonical digest, resolve historical profile binding, validate exact account/amount/currency/period, and commit one bounded outcome before acknowledgement.

A `2xx` may prove only that a bounded outcome committed. It never proves payment success, tuition enrollment, subscription activation, payout, receipt delivery, or payer authorization.

Idempotency is profile-local:

- a human command uses original key plus immutable request fingerprint and frozen scope;
- a provider event uses stable installation/profile/account/event identity plus canonical digest;
- a financial effect uses a distinct evidence/covered-period identity.

Same identity and same digest returns the original scoped result. Same identity and different digest is immutable `CONFLICT`. After possible outbound I/O, local state is `UNKNOWN`, never success or a safe retry. Only current-scope original-identity reconciliation against approved evidence may proceed. Unknown, pending, failed, reversed, disputed, malformed, unsigned, ambiguous, stale, mismatched, and cross-profile states remain `REVIEW_REQUIRED` or bounded recovery with no automated business effect.

## Required owner decisions before any PPA implementation

1. Whether Pitbull is a real provider, internal adapter name, or both—and whether any vendor is in scope.
2. Merchant of record, contracting party, payee, settlement recipient, tax/receipt issuer, dispute owner, and refund authority for each profile.
3. Whether HON SaaS and a school may ever share a processor, and if so the exact non-sharing model for accounts, credentials, customers, webhooks, idempotency, evidence, retention, and incident blast radius.
4. Whether school merchant/tuition processing is in scope; permitted instruments, collection/retry/refund/dispute/payout rules, and human approval thresholds.
5. Secret facility, key issuance/scope, rotation/revocation/cutover, sandbox/live separation, resolver authorization, and break-glass policy.
6. Customer/student payment-data legal basis, guardian/consent policy, processors/regions, encryption/KMS, retention/hold/backup/deletion/erasure, and support disclosure.
7. Webhook/recovery policy, acknowledgement semantics, permitted metadata, raw-byte retention default, reconciliation cadence, provider outages, and manual-repair limits.
8. Sandbox/pilot/live go/no-go: specific provider/profile/account, cost/liability model, monitoring, reconciliation staffing, thresholds, runbook, kill switch, success/abort criteria, and per-mode owner approval.

## Future proof gate

Before a credential or external I/O, run provider-free deterministic simulations covering all profile isolations; no cross-profile reference reuse; signing-before-parse; bounded input; secret redaction; rotation/revocation/cutover refusal; no raw-card/payer/student leakage; concurrent duplicate/conflicting/out-of-order events; response-loss `UNKNOWN` recovery with original identity; historical remap denial; wrong account/school/organization/amount/currency/period; and rollback.

Denied and unknown paths must leave payment, invoice, membership, entitlement, CRM, and protected-data tables unchanged. A hosted redirect, generic provider status, simulation, or existing Stripe test-mode result is not Pitbull readiness.
