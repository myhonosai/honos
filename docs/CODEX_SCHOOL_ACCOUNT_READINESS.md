# School account readiness — merged-contract follow-up

Baseline: owner-approved #31 merged as `ceee55b76f6b37c63d5481e9a78a8db041cc65e8`, exact tree `bb8dba521635e240a06339f6ecaf0fe6366fabff`. Branch `codex/school-account-readiness`. No deployment, provider activation, entitlement change or merge of this follow-up is authorized.

## Supported functional slice

The existing school subscription and authenticated checkout-return screens now distinguish independent B5 payment, reported provisioned tier, recorded subscription service and B3 allowance facts. A verified payment does not override a recorded suspension. A later refreshed `IN_SERVICE` record still does not prove payment-to-entitlement activation: the UI continues to show Pending Account Activation. Existing Core/Complete comparison, owner-confirmed checkout, HON guidance and all three presentation modes are preserved.

B5 `entitlementTier` is only a reported tier. Its merged SQL reads the organization entitlement row without returning its effective dates/status or feature decision. Therefore the previous phrase “Currently authorized tier” is removed. Effective feature access stays explicitly unconfirmed; backend permission checks are unaffected. A mismatch between the reported provisioned tier and recorded subscription plan is shown without choosing, rewriting or granting either plan.

B3 independently authorizes credit reads. Subscription suspension, inactive premium program, missing allowance, expired allowance and zero available credits remain distinct. A positive ledger balance is not provider access or permission to spend. Top-level credit plan/status must match B5 even when there is no allowance; scope/contract failures leave those records unavailable. No balance or official financial total is calculated in the browser. Denied credits do not imply suspension. Refresh clears prior facts, using the existing abort/generation protections.

## Backend coordination and next integration plan

Claude owns B5.1 invoices, B6 paid access and payment/credit services. Coordination is on #29 and #30. The following are semantic requirements for the backend owner, not invented API names or executable contracts:

| Need | Merged support | Frontend behavior / integration gate |
| --- | --- | --- |
| School plan, checkout, payment status | B5 school `hon-plan` and existing checkout command | Integrated; URLs never establish payment or authority |
| Current allowance and subscription suspension | B3 school `ai-credits` | Independently read/bound; suspension never becomes a browser reactivation |
| Effective Core/Complete access, activation/grace/suspension/reactivation | B5 returns only a tier and billing status; B6 unmerged/unimplemented | Effective access unconfirmed. Await approved school-authorized closed outcome, policy/version/scope and coverage tests; do not infer grants from payment or balances |
| Invoice history/detail and evidence | B5 invoice UUID only; B2 detail is HQ-only | Unavailable. After B5.1 merges, inspect actual typed pagination/filters/line items/adjustments/refunds/verification. Bind exact school/org/subscription and validate full pagination; no HQ/family fallback |
| Multi-school purchaser context | Reporting resolver yields only a candidate, not purchaser authority | Fail closed when ambiguous. Await dedicated school-authorized purchaser choices/resolver; no URL/local-storage authority or permission inference from reporting selection |
| Reactivation or new-plan access | No approved merged school command | Unavailable. Read refreshed authoritative status only; never directly mutate entitlements |

The UI exposes read-only next steps and the unavailable pieces instead of speculative links/buttons. Real Stripe sandbox setup/verification, paid-access owner policy and B6 remain launch dependencies. PR #30 is now merged as `c08091a4c3c7b824bb165d13fa74bc44f3d027a1`: its provider safety changes and B6 proposal are preserved byte-for-byte. The proposal is not an implemented B6 contract and no speculative API is consumed. No Manus CRM, migrations, backend, shared contracts/security, HQ, portraits, original assets or lockfile changes. Language & Region remains a future shared English/Korean/Spanish requirement, not implemented here.

## Verification

Capture source `2c557fd1e4a3c205139e12d0bf7ebdafee8b960c`: [CI 39208364938](https://github.com/myhonosai/honos/actions/runs/39208364938) passed both jobs: 649 web tests (24 focused subscription tests), 419 API, 188 domain, 91 auth, typecheck/build, 157 migration checks and all 15 disposable database security proofs / 238 forced-RLS tables. [Browser 39208364925](https://github.com/myhonosai/honos/actions/runs/39208364925) passed **66 checks / 14 captures / 22 axe scans**, with zero failures/reported violations/JavaScript errors/unexpected API paths. [Inspected actual desktop/mobile gallery](visuals/codex/school-account-readiness/README.md) and sanitized report are durable; evidence-only final head adds documentation/images, without application/harness/workflow changes. Final exact-head status will be recorded in #32/#4.

Tests extend the existing privacy/authorization/idempotency suite with independent payment/service/credit cases, tier mismatch and top-level credit plan drift. Browser uses the actual production Next application with signed synthetic localhost fixtures and intercepted hosted stand-in, no real Stripe sandbox/provider/customer data. New desktop/mobile suspension captures and existing all-mode/keyboard/session/denial/stale checks are attached. Full CI and disposable database security proofs passed. Physical-device/screen-reader/zoom/contrast QA remains manual; automated axe scans do not establish full WCAG compliance.
