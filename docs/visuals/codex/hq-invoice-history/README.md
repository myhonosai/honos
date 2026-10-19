# HQ invoices and payment history — actual application review

Actual production-build application screenshots with visibly labeled **synthetic authorized localhost fixtures**. No concepts, customer data, production deployment, payment, refund execution, financial activation or provider calls.

Capture source: `8018997b42d7107fdf83e9eb1dfdbae60f4bf3f0`, branch `codex/hq-invoice-payment-history`, [PR #25](https://github.com/myhonosai/honos/pull/25), based on main's owner-approved #22 merge `890daf2a39116894d987457edc75ced0d17279ac` including B4 unchanged.

| Screen | Desktop | Mobile |
| --- | --- | --- |
| Invoice list: authorized status filter, bounded organization/search and all record states | [Full desktop](invoices-desktop.jpg) | [Full mobile](invoices-mobile.jpg) |
| Detail: amounts/adjustments, payment/refund/chargeback evidence, subscription status history and B4 refund review | [Full desktop](detail-desktop.jpg) | [Full mobile](detail-mobile.jpg), [loaded-detail viewport](detail-mobile-viewport.jpg) |

Download originals for full resolution. Full mobile images retain every synthetic evidence/line-item explanation and are long; the viewport image shows actual keyboard entry with the amount/terms visible above fixed navigation. Full-page captures retain the real fixed-navigation position at capture time. No UI was hidden or reconstructed. Separate View and AI Style groups remain visible in the list captures. Record identifiers are keyboard-expandable; HON remains accessible with fixed invoice page context and no financial authority.

[Browser 39185861384](https://github.com/myhonosai/honos/actions/runs/39185861384): **95 checks passed**, zero failures or JavaScript errors, **60 PNG captures**, **40 axe scans with zero reported violations**, across 1440×1000, 834×1112, 390×844 and 320×800. [Actual sanitized report](browser-report.json). [Complete PNG artifact](https://github.com/myhonosai/honos/actions/runs/39185861384/artifacts/12158326509) expires October 22, 2026; these byte-preserved JPEGs remain in Git.

Checks cover Revenue→invoice navigation, server status and bounded local organization/text filters, inert URL/query values, explicit keyboard detail load, amount/evidence/refund distinctions, identity expansion, visible mobile focus, refreshed authoritative evidence/balance, historical subscriptions, draft/unresolved tax, lifetime reversals, empty/denied/malformed/scope-race/stale responses, independent B4 failures and all six billing read permissions. Staff/family/support/non-billing HQ/unsigned sessions are denied by the signed-session localhost double; owner/operator reads remain allowed. Only fixed local GET traffic is allowed, external requests are blocked. Existing HQ/Champions/subscription/assistant/appearance regressions are retained. Canonical API/calculations/authorization are separately exercised through full CI's disposable PostgreSQL proofs.

[Full CI 39185861362](https://github.com/myhonosai/honos/actions/runs/39185861362) passed both jobs: **625 web tests (12 new), 412 API, 188 domain and 91 auth**, typecheck, application build, **156 migration-file checks**, **all 14 disposable-database security proofs / 234 forced-RLS tables**, including unchanged B1–B4. Final evidence-head CI results are recorded in #25 / #4; application/test/harness/fixture blobs remain identical to this capture source.

Manual QA remains: physical iOS/Android keyboards and rotation, VoiceOver/NVDA focus/live announcements, zoom and image-backed contrast. Axe retained 1–2 incomplete rules per scan; this is not full WCAG certification. External Google fonts were blocked; captures use fallback fonts.

**Backend limit:** [#24](https://github.com/myhonosai/honos/issues/24) tracks verified school→billing-organization identity and complete paginated invoice/refund history. This slice reviews authoritative organization invoices and per-invoice evidence; newest-200 global list/refund windows are not complete school history. Current subscription status history is at most 50 events. No absence of older refund records or invoice-exclusive first-purchase guarantee is inferred. Refund approval/evidence is never execution or provider confirmation. Reward-history #21 remains open and unchanged; #17 remains future localization documentation only.

[Implementation/security handoff](../../../CODEX_HQ_INVOICE_PAYMENT_HISTORY.md). Claude backend/contracts/safeguards and Manus CRM/family billing are unchanged. #25 requires separate owner merge approval. No deployment; temporary verification cleanup must be separately reviewed after sign-off.
