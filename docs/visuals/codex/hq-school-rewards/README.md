# HQ school referrals and reward management — actual application review

These are real production-build application screenshots with visibly labeled **synthetic authorized localhost fixtures**, not concepts or customer data. No production deployment, provider call, payment, reward fulfillment or contest activation.

Capture source: `2067347b2f9ba29a916076c11a125895f00d494f` on `codex/hq-school-reward-management`, [PR #20](https://github.com/myhonosai/honos/pull/20).

| Screen | Desktop | Mobile |
| --- | --- | --- |
| School selection, verified referrals/rank/history and official milestone progress | [Full desktop](school-desktop.jpg) | [Full mobile](school-mobile.jpg), [initial viewport](school-mobile-viewport.jpg) |
| Global liability groups, published reward terms and all record states | [Full desktop](rewards-desktop.jpg) | [Full mobile](rewards-mobile.jpg) |

Open/download the originals for full resolution. The full mobile reward image includes all five synthetic records and is long; viewport captures retain the actual fixed bottom navigation. No application UI was hidden or reconstructed for these captures. Separate View / AI Style boundaries remain visible, and school selection is verified above the fixed navigation at both mobile widths.

[Browser run 39163831003](https://github.com/myhonosai/honos/actions/runs/39163831003): **68 checks passed**, zero failures/JavaScript errors, **42 PNG captures** at 1440×1000, 834×1112, 390×844 and 320×800; **24 axe scans**, zero reported violations. [Sanitized actual report](browser-report.json). The [complete PNG artifact](https://github.com/myhonosai/honos/actions/runs/39163831003/artifacts/12150430001) expires October 21, 2026; this JPEG gallery remains in Git.

Browser checks include explicit versus inert URL school selection, search/refresh/keyboard access, server ranks and reached/next milestones, global liability scope across status filters, denied/empty/malformed/stale/wrong-school/policy-race states, separate HQ versus staff/family/support/unsigned access and existing dashboard/leaderboard/assistant/appearance regressions. All browser network activity is allowlisted local GET traffic; ephemeral sessions are actually signed and verified. Canonical backend authorization/calculations are separately tested through existing disposable-database proofs.

The first corrected [full CI 39163004850](https://github.com/myhonosai/honos/actions/runs/39163004850) passed: 602 web (12 new), 408 API, 188 domain and 91 auth tests, typecheck, application build, 155 migration-file checks and all 13 disposable-database proofs (227 forced-RLS tables). Screenshot review then moved secondary controls below school selection and added complete reward captures; the browser run above verifies that final source. Final evidence-commit CI results are recorded in PR #20 and tracking issue #4; application/test/harness/fixture blobs remain identical to the capture source.

Manual QA still needed: physical iOS/Android software keyboards and rotation, VoiceOver/NVDA focus/live announcements, zoom and image-backed contrast. Axe retains 1–2 incomplete rules per scan; automated checks do not establish full WCAG conformance. External font hosts were blocked; captures use fallback fonts.

**Backend gap:** complete per-school reward history remains unavailable pending Claude's authorized paginated contract, tracked in [#21](https://github.com/myhonosai/honos/issues/21). Global newest-200 records are not complete school history. Backend-calculated milestone progress does not establish reward fulfillment. Contest controls, financial activation and payments remain disabled. Localization in PR #17 remains future documentation only.

Implementation/security handoff: [CODEX_HQ_SCHOOL_REWARDS.md](../../../CODEX_HQ_SCHOOL_REWARDS.md). No original assets replaced. Separate owner approval is required before merging #20; no deployment authorization.
