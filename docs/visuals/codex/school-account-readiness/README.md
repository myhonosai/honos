# School account readiness — actual application review

Capture source: `2c557fd1e4a3c205139e12d0bf7ebdafee8b960c`, based on main `c08091a4c3c7b824bb165d13fa74bc44f3d027a1`, including approved #31 and Claude #30. Actual production Next UI with signed synthetic school-owner B5/B3 fixtures. **No real customer data or actual Stripe sandbox verification.** The visible fixture banner is injected only by the browser harness.

| State | Desktop | Mobile |
| --- | --- | --- |
| Verified test payment, pending activation (initial viewport) | [Desktop](desktop-paid-viewport.jpg) | [Mobile](mobile-paid-viewport.jpg) |
| Verified test payment, recorded subscription suspension | [Desktop](desktop-suspended.jpg) | [Mobile](mobile-suspended.jpg) |
| Full payment, reported tier, service and credit records | [Desktop](desktop-paid.jpg) | [Mobile](mobile-paid.jpg) |

[Browser run 39208364925](https://github.com/myhonosai/honos/actions/runs/39208364925): **66 checks, 14 captures, 22 axe scans**, zero failures/reported violations/JavaScript errors/unexpected API paths. This durable gallery contains six selected exact JPEG captures; [the full runner artifact](https://github.com/myhonosai/honos/actions/runs/39208364925/artifacts/12165928937) contains all PNG/JPEG captures and the sanitized report (expires October 22). [Report](report.json).

[Full CI 39208364938](https://github.com/myhonosai/honos/actions/runs/39208364938) passed 649 web (24 focused subscription), 419 API, 188 domain and 91 auth tests; typecheck/build, 157 migration checks and all 15 database security proofs / 238 forced-RLS tables.

The existing checks cover desktop/tablet/mobile/narrow widths (1440/834/390/320), all three view modes, keyboard/HON, confirmation/idempotency, current-school/purchaser denial, session gates, forged returns and stale responses. Added cases cover paid-but-suspended records, refreshed service without claiming account reactivation, inactive/missing/expired/zero allowance, top-level credit-plan drift and tier/subscription mismatch.

Screenshots were visually inspected: pending activation and suspension headings remain visible in the initial desktop/mobile return viewport; no tested horizontal overflow. One axe rule per scan is incomplete, so physical devices, screen readers, zoom and contrast still need manual review. The floating HON guide retains its approved behavior.

Payment is not an entitlement grant. B5 reports a provisioned tier, not the effective feature-access decision. B5.1 invoice history/detail, dedicated purchaser/multi-school context and B6 activation/reactivation remain unavailable pending approved merged contracts. The actual Stripe provider/account/credentials/webhook setup and real-sandbox transaction are not verified.

No deployment, live payment, refund, provider activation, entitlement change or merge of follow-up #32. Evidence-only commit after this capture does not change application, test, harness or workflow blobs. Full handoff: [school account readiness](../../../CODEX_SCHOOL_ACCOUNT_READINESS.md).
