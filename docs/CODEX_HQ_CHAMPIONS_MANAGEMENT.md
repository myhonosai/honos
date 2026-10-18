# Codex HQ Phase 3 — Champions Club overview slice

**Branch:** `codex/hq-champions-management`. **Tracking:** #4. Owner-authorized implementation, no merge or deployment authorization for this change.

## Connected screens

`/hq/growth` and `/hq/growth/champions-club` now share a real read-only overview using the existing rewrite, authenticated HQ shell and two independently authorized GETs:

| Read | Canonical response |
| --- | --- |
| `/api/v1/hq/champions/overview` | `ChampionsOverview` / `validateChampionsOverview` (M5) |
| `/api/v1/hq/champions/program` | `ChampionsProgram` / `validateChampionsProgram` (M1) |

Both traverse `ChampionsHqController` → `ChampionsReadGuard` → `ChampionsClubService` → registered `RuntimeDatabaseService` operations → canonical forced-RLS/function boundaries. Those backend files and contracts are reused unchanged. The existing leaderboard remains untouched.

The overview displays program status/version, published qualification windows/minimums/evidence source, draft count explicitly limited to the returned drafts, the five referral-state aggregates, official ranked-school count, codes/schools, non-voided reward liabilities, approval/reversal-review counts, reward policy status/clawback rule and collapsed HQ review/contest liabilities. Total referrals is an exact integer sum of the five exhaustive backend aggregate states, never a count of a limited list or a browser qualification/ranking calculation. All USD minor units are formatted without floating-point rounding.

## Financial and privacy meaning

Subscription account credits are monetary liabilities, not AI credits or applied balances. Free months, prize entries and lifetime milestones are recorded benefits, not activated services. Approved means approved for future fulfillment; reversal review is not a payment or a finding of fraud. Permanent and contest liabilities stay separate. Voided entries are excluded by the aggregate backend projection. No inferred accrued/paid counts, currency conversion, reward buttons or financial activation.

Only the existing signed-in HQ shell can mount content. Each API resolves its own HQ owner/operator authority; a school/family/support session or overview permission cannot substitute for Champions authority. Fixed same-origin no-store GETs have no scope/actor selectors or command headers. Closed response validation rejects extra/private fields, drift and activation states. Denial bodies are never parsed or echoed. Either failed read clears the entire overview. Separate policy reads must agree on publication/version/evidence source; a concurrent change requires refresh instead of presenting inconsistent configuration.

Refresh and route changes hide previous facts during render. AbortController plus effect cleanup rejects obsolete responses. No URL/query-driven fetch selector, local-storage cache, production credentials, direct table access or command transport is introduced. Retrieved UTC time is browser retrieval time, not a backend as-of receipt or an atomic multi-endpoint snapshot.

## Scope still awaiting frontend integration

School search/selection, individual referral history and state filters, per-school 5/10/20/30 milestone details, and individual reward records/status filters are not implemented by this first slice. Their merged M1–M5 services exist; these are frontend follow-ups, not missing backend claims. No awards are inferred from the business roadmap. `/hq/growth/rewards` and contest/founder pages retain their explicit planned state. The next slice should use authorized HQ school directory selection and the canonical statistics/ledger contracts, without deriving totals from truncated history/entries.

Financial fulfillment, public contest publication, provider spending, operational HON conversation/voice and deployment remain disabled/unavailable. Claude owns backend, billing and credit work; Manus owns school CRM/enrollment. No changes to their files, original portraits, approved background, six executives, HON assistant or View/AI Style controls. Language & Region remains the future all-tier English/Korean/Spanish requirement documented in PR #17; no translations, preference store, schema or permissions are added here.

## Verification

Focused tests cover fixed transport, denied/invalid/private responses, separate-policy drift, cancellation, initial data-free render, unfulfilled financial distinctions, aggregate totals larger than record-list limits, safe terms text and exact integer/currency formatting. The actual-app browser harness adds overview checks across desktop/tablet/mobile/320px, all views, assistant access, refresh/empty/loading/errors, out-of-order navigation, owner/operator and forbidden principals. Existing leaderboard and HQ appearance/navigation/assistant regression checks remain.

The terminal has no workspace dependency cache; one bounded registry check failed because the configured proxy could not be reached. No dependency-download loop, lockfile change or network bypass. A new temporary Phase-3-only browser workflow is limited to this exact same-repository branch targeting main, uses read-only permissions, pinned actions/tools and real production-build localhost verification with ephemeral signed sessions and visibly synthetic fixtures. It is distinct from the completed PR #8/#11 workflow removed in PR #16. No production database or external API is contacted. Existing CI continues canonical API/integration and disposable-local database security proofs unchanged.

Actual CI/browser results and screenshots will be linked after the run completes. Pending checks are not described as passing. Physical-device software keyboard, VoiceOver/NVDA, contrast/zoom and axe incomplete rules remain manual review; automated scans do not establish full WCAG conformance.
