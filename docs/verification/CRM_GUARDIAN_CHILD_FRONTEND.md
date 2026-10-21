# Guardian/child CRM frontend verification

Baseline: main `9667b4005d5d637f878d6c91addc680ab5160324` (merged PR #47, migration 0176). Frontend only; existing APIs/contracts/migrations are unchanged.

## Connected workflow

From a freshly authorized CRM lead list, **Set up / resume family** explicitly reads the merged family recovery endpoint. No recovery runs on page load or from a URL selector. NOT_REGISTERED offers the existing GUARDIAN_CHILD registration command; ADULT_REGISTRATION links back to the existing adult recovery. The other four family states drive canonical-account create/reuse, separate guardian payer confirmation, child selection or terminal staff review.

Each child retains its independent student profile and plan selection. The existing published-plan picker uses the child-only command/confirmation when a child is selected, and the unchanged adult command otherwise. Official plan version, availability, program, currency and terms remain server-validated. Original terms in a current child DRAFT come from the historical bound version returned by recovery, never the current catalog. The legacy adult free-text route remains available; no child equivalent is invented.

Command receipts are historical evidence. Account/payer/child commands refresh the authorized family read; child DRAFT creation shows a historical receipt and requires an explicit refresh before showing current progress. Other staff see only that a current DRAFT exists, without receipt/creator/confirmation/edit/transfer/activation controls.

Unknown command outcomes retain immutable input/key in memory for an exact explicit retry. New commands use fresh UUID keys. A brief window blur preserves family work/retries; navigation/pagehide, school changes and access loss discard the scoped view. Recovery after a new session requires a new explicit read. No family/child/receipt/key information is stored in browser storage, URL handoffs or telemetry.

## Verification layers

- `apps/web/test/crm-family-http.test.ts`: exact merged routes/markers/validators; six family and five child states; malformed/cross-contact responses, privacy, keys, unknown/rejected/access results.
- `apps/web/test/crm-family-flow.test.tsx`: staff interactions, explicit confirmations, duplicate prevention, exact retry, 10 children total, child-specific picker, stale versions, scope/lifecycle clearing and historical/current distinction.
- `apps/web/scripts/crm-family-browser.mjs`, invoked by the existing actual-application browser suite: production Next application with signed synthetic sessions and deterministic localhost API fixtures, desktop/mobile screenshots, keyboard and axe checks. **Synthetic browser verification, not real database evidence.**
- `apps/web/scripts/crm-family-api-verification.mjs`: actual frontend transport, real signed sessions, Nest controllers/guards/services and restricted-runtime disposable PostgreSQL. Covers guardian registration/account/designation, multiple children/families, canonical payer binding, plan DRAFTs, exact concurrent retries, historical terms, stale versions, review and authorization denials. **No mocked API or identity guard.**
- Existing full CI includes unit tests, typecheck, build, migration verification and all disposable PostgreSQL proofs, including 266 guardian/child assertions and the 1,332-interleaving lock-order regression.

The browser workflow is limited to relevant paths and same-repository PRs targeting main, with read-only repository permission, pinned actions, no repository/provider secrets, exact-head checkout and three-day artifact retention. It no longer silently skips relevant future branches due to the old hard-coded branch name. No screenshot blobs are uploaded individually.

Local environment: shell proxy connection failed before reaching GitHub; one offline install failed with `ERR_PNPM_NO_OFFLINE_META`. No repeated downloads, proxy bypass, dependency/lockfile change or security-policy workaround. Exact main was retrieved through the GitHub connector and the complete source tree verified before editing. CI is the execution environment for the required checks; final PR status records actual results.

## Remaining dependencies and boundaries

- Staff review is terminal for ambiguous identities/twins, co-guardians, relationship drift and pre-0176 registrations without snapshots. No merge/link/backfill tool exists in this milestone.
- Alternate payers, guardian consent, agreements, discounts, fees, schedules, collection and activation need separate owner policy/backend work. No financial action is added here.
- The server cap is ten children **total**, including the initially registered child.
- New family copy is English. Existing language/appearance preferences are preserved; broader catalog/family Korean/Spanish translation remains a follow-up, not claimed complete.
- Existing adult historical-plan recovery and legacy free-text policy follow-ups remain separate. No original asset, HON SaaS subscription, HQ interface or protected backend source is changed.

Review recommendation: pending exact-head CI, browser/API evidence and independent review. No merge/deployment authorization is implied.
