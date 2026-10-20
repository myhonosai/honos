# Connected adult CRM staff frontend

Codex frontend slice based on main `95b78f0dc158c7b2f9c19ee477c93031bb04f3ff` after PR #41. PR #27 was read as a frontend reference only. No backend, contracts, database migrations, shared visual assets or PR #27 branch are changed.

## Working path

`/staff/crm/leads` remains protected by the existing signed-session layout. Scope URL fields remain inert until an explicit authorized lead-list load. A staff member selects a returned lead using **Set up adult membership**. A new inline panel carries verified response identifiers only in memory:

1. Explicit ADULT registration: date of birth and human confirmation; the returned lead/contact/path must match the selected row before continuing.
2. Explicit self-payer confirmation and account currency: use the returned registration contact with the existing normal billing-account command. Show creation/reuse only from the response. No additional-account or payer-transfer command is exposed.
3. Explicit DRAFT readiness read: the backend derives the ADULT conversion and sole canonical account. Staff enters the opaque school membership plan code and confirms a DRAFT. No account ID, payer ID or price is sent to the DRAFT endpoint.
4. Separate current-DRAFT confirmation: a historical creation receipt is never represented as current state. A failed fresh check clears the current-confirmation indicator. No activation or payment entry point is added.

All five calls reuse merged controllers/services and typed validators. API permission, current principal, exact school, entitlement and database boundaries remain final. The frontend never reads private tables or confers permission from a receipt. Unknown command outcomes retain an immutable exact request/key for manual retry only; commands each receive their own UUID. A synchronous in-flight guard blocks duplicate submissions. Scope/filter/list changes, access loss, inactivity and unmount discard the panel; late responses cannot restore it. No workflow/PII/retry state is placed in browser storage, URLs or telemetry.

## Backend gaps, deliberately unavailable

- No authorized read endpoint recovers a lead's private registration conversion/receipt after navigation, inactivity or a lost session. This slice connects a newly returned registration receipt; `NEEDS_STAFF_REVIEW` cannot be converted into an invented receipt or student selection. Durable resume needs a backend-owner contract.
- No school membership plan catalog/price endpoint exists for this DRAFT input. The UI accepts the backend's bounded opaque plan code and does not calculate prices, choose schedules or imply agreement/eligibility.
- The account command requires the intended currency. A currency mismatch or multiple accounts requires staff review; no currency overwrite or additional-account workaround is offered.
- A Won lead or completed trial is only a backend registration gate. The frontend makes no adulthood, consent, enrollment, payment, membership activation or successful commercial-conversion claim from that state.
- Guardian/child registration and DRAFT UI, membership activation, payments, public signup and production migration/deployment are excluded. Existing language infrastructure is preserved; this screen uses English fallback and does not claim complete localization.

## PR #41 follow-ups

- Error-status documentation accuracy: CRM maps `40P01`/`55P03` to 409; Owner Launch maps an unhandled `40P01` to recoverable 503 with exact-request/key retry guidance. Both roll back and neither reports success. The existing lock-order note is corrected; no backend behavior changed.
- Backend-owned test follow-up (still open): strengthen the same-key Owner Launch/CRM residual proof to assert the actual loser error status and every loser-side membership, account, source, audit and outbox effect. The current residual test checks exactly one fulfilled command, one idempotency row and no unfinished reservation; transaction rollback is separately verified. This frontend PR does not modify that proof or refactor backend locking.

## Verification and limits

Frontend tests cover the real transport and component handlers, closed responses, tenant/payer mismatches, denied access, uncertainty/replay, stale responses and duplicate submission. The dedicated GitHub Actions browser job runs the actual built Next application with signed synthetic sessions and a localhost deterministic API fixture, desktop/mobile screenshots, keyboard checks and axe accessibility checks. No production database, real customer, payment provider or external AI service is used. Browser fixtures validate frontend behavior; they are not evidence of a deployed end-to-end database journey. Existing main CI retains backend security proofs.

Local environment: canonical main and imported files were SHA-verified. Proxy connection refused and offline package metadata was unavailable (`ERR_PNPM_NO_OFFLINE_META`); local runtime tests/build were not claimed. Final GitHub results and private artifact links are reported in the PR.
