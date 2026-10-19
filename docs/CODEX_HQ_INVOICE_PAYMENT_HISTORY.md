# HQ invoices and payment history — implementation boundary

Owner-authorized next frontend slice after #22 merged as `890daf2a39116894d987457edc75ced0d17279ac`. Branch `codex/hq-invoice-payment-history`. Claude owns merged B1–B4 backend; Manus owns CRM/family billing. No backend, contract, migration, permission or original-art changes.

## Intended functional slice

Existing Revenue links to `/hq/revenue/invoices`, a fixed authenticated status-filtered newest-200 invoice read, with clearly bounded local organization/search filters. `/hq/revenue/invoices/[invoiceId]` is a separate invoice detail workspace. The URL is an untrusted selector: no invoice or organization read occurs until explicit human load. Canonical server authorization remains independent of every UI/URL selection.

Exact B2 detail supplies invoice identity, frozen commercial terms, service period, status/tax/line amounts including B4 `ACCOUNT_CREDIT`, settlement and payment/refund/chargeback evidence. No frontend invoice/balance/eligibility calculation. B1 organization subscription/status history and B2 standing are separately authorized and bound to the invoice's returned organization. Historical invoices need not match today's current subscription. B4 eligibility is a current first-purchase preview, not selected-invoice entitlement or refund execution; matching refund-request records come from a clearly labeled limited global window.

## Backend dependencies and limits

[Issue #24](https://github.com/myhonosai/honos/issues/24) asks Claude to define verified school→billing-organization resolution and complete paginated invoice/refund histories. The minimized school directory deliberately omits organization IDs, so this slice uses authoritative billing organization identities from invoices and never matches names or couples billing to Champions statistics/staff scope. Organizations may cover multiple schools. Global newest-200 filters do not establish complete school history, official totals or absence of older refund requests. Current subscription status history is at most 50 events, not full historical plan/offer details.

The unchanged reward-history dependency remains #21. English/Korean/Spanish is future documentation-only #17, not implemented localization. Collection, delivery, provider verification and refund execution remain unavailable; no charge/refund/reservation/subscription/reward command is present.

## Verification plan

Closed canonical validators, fixed no-store same-origin GETs, identity/evidence binding, independent denials, private-body rejection, request cancellation, stale-state clearing, exact signed USD amounts and truthful payment/refund strength. Actual production-app browser checks use signed synthetic authorized localhost fixtures and blocked external requests, never production data. Full CI includes B4's disposable PostgreSQL security proofs. Desktop/tablet/mobile/narrow overflow, keyboard, assistant/appearance regressions and axe scans; screenshots and actual results will be added after execution. No passing results are assumed.
