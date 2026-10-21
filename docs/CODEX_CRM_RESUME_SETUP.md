# CRM Resume Setup frontend

Based on canonical main `9682f87d931b728207af8eb0deabd2ca57f0da5b` (PRs #41/#42/#43 merged). Codex branch `codex/crm-resume-setup`; frontend and verification only. PRs #27/#17/#3, backend, contracts, migrations, grants/RLS, payments and entitlements are unchanged.

## Connected behavior

`/staff/crm/leads` stays idle until an explicit authorized list load. A returned non-archived row offers **Resume setup**. Its click handler calls the exact 0174 POST with `{}`, the recovery human-command marker and no idempotency key. No effect, mount, URL, navigation, focus, polling or timer triggers recovery. The shared verifier binds the lead; the frontend additionally binds the historical receipt's contact to the selected row.

- `NOT_REGISTERED`: the existing explicit adult registration form.
- `NEEDS_STAFF_REVIEW`: stop with no later step, record details or reason disclosure.
- `BILLING_ACCOUNT_REQUIRED`: seed only the historical registration receipt; require explicit account confirmation and the existing create/reuse command.
- `READY_FOR_DRAFT`: seed the receipt and verified canonical-account currency, without inventing an account ID. Require the existing explicit preparation read before a new DRAFT command.
- `CURRENT_DRAFT`: display the backend's live creator-owned confirmation separately from historical creation evidence. No create command.
- `CURRENT_DRAFT_BY_OTHER_STAFF`: display only the current-DRAFT existence message; no membership details, creator identity, confirmation, creation, editing, ownership-transfer or activation controls. Refresh performs another recovery read only.

New commands still receive distinct UUID keys; uncertain commands retain their immutable original input/key and block other steps until explicitly retried or discarded. Recovery never silently replaces an uncertain command. No recovery receipt, workflow identifiers or retry state enters storage, URLs or telemetry. Appearance/localization infrastructure is untouched; this CRM slice retains English fallback.

401/403 clears scope/list/panel; 404 closes setup and requires a fresh list load. 409/503 and malformed responses show no assumed state and permit only an explicit read retry. Synchronous guards suppress duplicate reads. Abort signals and generation checks discard responses after scope/filter changes, close, inactivity, access loss or unmount. Refresh first discards the old recovery result. Loading/error and recovered headings receive keyboard focus; controls reuse the existing mobile layout.

## Verification boundaries

- Frontend transport, component interaction and parent lifecycle tests cover all six states, scope/contact mismatches, denied/unknown/404/conflict states, stale responses and exact command retries.
- Browser harness runs the real built Next application with signed synthetic sessions and deterministic localhost API fixtures. Desktop/mobile captures and axe scans cover each recovery state plus the original connected workflow, refresh/navigation/session loss, failures and stale reads. These screenshots do not claim a real database journey.
- A separate frontend verification script runs the actual transport against the real Nest controller, human-UI guard, signed-session identity guard, normal services and a marked disposable PostgreSQL fixture. It uses all merged migrations unchanged, all six states, same-school creator/noncreator and cross-school/revoked/session denials, and before/after snapshots of 18 tables. No identity or API mock. This transport/API/database proof is separate from browser verification.
- Full repository CI retains migration checks and all disposable PostgreSQL security proofs, including 0174 recovery and the 540-interleaving lock-order proof.

Final CI results and private artifact links belong in the PR after completion. Local checks are limited to syntax/source boundaries: proxy port 8080 refuses connections, and frozen offline installation lacks registry metadata (`ERR_PNPM_NO_OFFLINE_META`). No lockfile, security policy or network bypass is used.

## Remaining dependencies and risks

School membership plan catalog/pricing remains unavailable: staff use the existing opaque plan code. Account ambiguity, guardian/child conversions, activated/drifted memberships and unsupported records require staff review. Persistent-database migration baselines and production deployment require separate approval; none are executed here. Backend helper/0163 invariant synchronization, bounded SHARE-lock contention and complete loser-side concurrency assertions remain the existing backend follow-ups. Native-device/assistive-technology QA remains separate from automated browser/axe results.
