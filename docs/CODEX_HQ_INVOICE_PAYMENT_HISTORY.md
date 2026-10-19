# HQ invoices and payment history — implementation boundary

Owner-authorized next frontend slice after #22 merged as `890daf2a39116894d987457edc75ced0d17279ac`. Branch `codex/hq-invoice-payment-history`. Claude owns merged B1–B4 backend; Manus owns CRM/family billing. No backend, contract, migration, permission or original-art changes.

## Intended functional slice

Existing Revenue links to `/hq/revenue/invoices`, a fixed authenticated status-filtered newest-200 invoice read, with clearly bounded local organization/search filters. `/hq/revenue/invoices/[invoiceId]` is a separate invoice detail workspace. The URL is an untrusted selector: no invoice or organization read occurs until explicit human load. Canonical server authorization remains independent of every UI/URL selection.

Exact B2 detail supplies invoice identity, frozen commercial terms, service period, status/tax/line amounts including B4 `ACCOUNT_CREDIT`, settlement and payment/refund/chargeback evidence. No frontend invoice/balance/eligibility calculation. B1 organization subscription/status history and B2 standing are separately authorized and bound to the invoice's returned organization. Historical invoices need not match today's current subscription. B4 eligibility is a current first-purchase preview, not selected-invoice entitlement or refund execution; matching refund-request records come from a clearly labeled limited global window.

## Backend dependencies and limits

[Issue #24](https://github.com/myhonosai/honos/issues/24) asks Claude to define verified school→billing-organization resolution and complete paginated invoice/refund histories. The minimized school directory deliberately omits organization IDs, so this slice uses authoritative billing organization identities from invoices and never matches names or couples billing to Champions statistics/staff scope. Organizations may cover multiple schools. Global newest-200 filters do not establish complete school history, official totals or absence of older refund requests. Current subscription status history is at most 50 events, not full historical plan/offer details.

The unchanged reward-history dependency remains #21. English/Korean/Spanish is future documentation-only #17, not implemented localization. Collection, delivery, provider verification and refund execution remain unavailable; no charge/refund/reservation/subscription/reward command is present.

## Exact reads and authority

| Existing canonical GET | Contract | Use |
| --- | --- | --- |
| `/v1/hq/saas/invoices[?status=]` | `validateSaasInvoiceList`, `validateSaasInvoiceStatusFilter` | Newest 200 global matching records in server order; local filters never claim complete organization/school history |
| `/v1/hq/saas/invoices/:invoiceId` | `validateSaasInvoiceDetail` | Explicitly requested invoice; lines, complete returned per-invoice evidence and authoritative settlement |
| `/v1/hq/saas/organizations/:id/subscription` | `validateSaasOrganizationSubscription` | Current entitlement/subscription and newest 50 status events, distinct from the selected historical invoice's frozen terms |
| `/v1/hq/saas/organizations/:id/payment-standing` | `validateSaasPaymentStanding` | Recorded versus provider-verified organization standing, never inferred from the invoice list |
| `/v1/hq/saas/organizations/:id/refund-eligibility` | `validateSaasRefundEligibility` | Server-current first-purchase preview; no browser-selected receipt instant or independent eligibility calculation |
| `/v1/hq/saas/refunds` | `validateSaasRefundRequestList` | Newest 200 global requests; return only matching invoice entries to the renderer, explicitly incomplete history |

Web reads use the existing same-origin `/api` rewrite, credentials and no-store behavior. Actual authority remains `SaasReadGuard` → canonical `SaasBillingService` → registered database operations → forced-RLS HQ functions. Each requires the independent live direct-human HQ owner/operator billing boundary (`hq.billing.manage` for operator); browser appearance, URL, organization choice and HQ layout are not authority. No role/tenant headers, generic resource executor, direct tables or new API routes.

After explicit load, detail is bound to the requested invoice ID before any organization read. Every evidence entry must match that invoice, IDs must be unique, and reversals must refer to an included payment entry. Organization/current-subscription responses are cross-bound; the historical invoice need not equal today's current subscription. B4 preview organization and matching requests' invoice/organization/subscription/offer must agree. Provider-verification and financial-execution drift fail closed. Unrelated global refund records are never rendered.

Core detail/account/standing fails as one group. B4 reads fail independently with their own cleared unavailable/denied state, preserving already verified core facts. Render-time keys clear obsolete facts before effects; AbortController and cleanup guards discard late results on refresh, target change or navigation. No cached fallback or selector persistence. The client retrieval time is labeled separately; these reads are not an atomic server snapshot.

Financial numbers are direct record fields. Only exact signed USD display formatting is added; canonical validators retain financial consistency checks. No local line-item sum, net/balance/eligibility calculation or official count from limited lists. Unknown tax stays unresolved; unissued/void balances are not applicable, not zero. Unnumbered voided drafts stay void records. B4 `REFUND_EVIDENCED` is recorded evidence, while execution remains `NOT_EXECUTED`; no processor confirmation is inferred.

## Frontend ownership and interactions

Approved shell, HON assistant, six executives, shared styles, original artwork and three-mode/portrait controls are reused unchanged. Additive label cases in the Codex HQ catalog provide fixed invoice page context without sending record IDs or query values to HON. Revenue gains a visible invoice entry link. New inputs, links, native expandable record IDs and explicit load/refresh controls are keyboard accessible; loading detail receives focus and scrolls into view. Identity details stay secondary to the invoice amount and terms on mobile.

Only two new route-manifest entries are appended (dynamic manifest convention `:invoiceId`), coordinated on Classic #3. No Claude Classic path or Manus staff/CRM/family-billing file is changed. Owner authorization for #22 does not authorize merging this follow-up PR. No deployment or activation. Temporary browser verification stays pinned/read-only/no-secrets and exact same-repository branch/base restricted; remove through a separately reviewed cleanup after sign-off.

## Verification plan

Closed canonical validators, fixed no-store same-origin GETs, identity/evidence binding, independent denials, private-body rejection, request cancellation, stale-state clearing, exact signed USD amounts and truthful payment/refund strength. Actual production-app browser checks use signed synthetic authorized localhost fixtures and blocked external requests, never production data. Full CI includes B4's disposable PostgreSQL security proofs.

[PR #25](https://github.com/myhonosai/honos/pull/25), capture source `8018997b42d7107fdf83e9eb1dfdbae60f4bf3f0`: [CI 39185861362](https://github.com/myhonosai/honos/actions/runs/39185861362) passed both jobs: 625 web (12 new), 412 API, 188 domain, 91 auth tests; typecheck/build; 156 migration checks; all 14 disposable database proofs / 234 forced-RLS tables. [Browser 39185861384](https://github.com/myhonosai/honos/actions/runs/39185861384) passed 95 checks / 60 PNG captures / 40 axe scans with zero failures, JavaScript errors or reported violations. Actual [desktop/mobile gallery and report](visuals/codex/hq-invoice-history/README.md) inspected. Initial full CI exposed a new manifest entry using Next bracket notation instead of the repository's colon notation; the entry was corrected, with no changes to existing school tests. Unnumbered void states and mobile amount/identifier hierarchy were refined and reverified.

The evidence commit changes only documentation/images; application/test/fixture/harness blobs match the capture source. Final-head checks are tracked in #25 / #4. Manual physical-device keyboard/rotation, VoiceOver/NVDA focus/live announcements, zoom and image-backed contrast remain; axe has 1–2 incomplete rules per scan and external fonts were blocked. No full WCAG claim, #25 merge authorization or deployment. Complete school history remains blocked by backend #24, not claimed implemented by this tested organization invoice workflow.
