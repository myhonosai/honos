# CRM enrollment privacy and usability follow-up

Baseline: main `43c41e0d4a26ff32b0cc6f3e75f8489adbf03537` (PR #48). Frontend only.

## Privacy boundary

Window blur or hidden-tab visibility synchronously conceals the entire sensitive CRM region with `hidden`, `inert`, accessibility exclusion and a `display: none !important` rule. It remains mounted to preserve immutable uncertain enrollment requests and their original idempotency keys only in memory. Focus restoration alone performs no read or command and cannot reveal the region.

The explicit **Verify access and resume** action checks the existing signed-session identity read, reloads the selected school's authorized lead list, matches the original lead/contact, and calls the exact existing adult or guardian/child recovery read. It checks signed identity continuity again before revealing fresh facts. Reads do not carry idempotency keys. Every domain API still independently verifies current permissions and entitlement; the client cannot grant authority. An absent, changed, expired or denied identity discards the scoped view. Unavailable/missing/conflicting recovery keeps it concealed. Repeated blur, scope changes and navigation invalidate late verification responses.

An in-flight command is allowed to settle while concealed; verification waits for it. No consequential command is automatically resent. Unknown plan-DRAFT requests move from the plan picker into the enrollment panel so revalidating current records cannot discard the exact retry. Only an explicit retry submits the same immutable input/key. Discarding the local view, navigating away, changing schools or losing access drops that memory; this never undoes a recorded operation. No recovery facts or retry information enter storage, URLs or telemetry.

The shield protects screen and accessibility visibility, not against scripts already running in the same trusted origin or inspection of browser memory/hidden DOM. It adds no replacement for server authorization or an operating-system lock screen. Bounded lead-list verification can fail to find a previously selected lead; staff must discard/reload rather than reveal an unverified record.

## Usability

- Family account rejection uses guardian/family-specific guidance, without changing adult transport or billing authority.
- A current-status button sits beside the child's historical DRAFT receipt and returns to that child's verified state. Historical receipts remain distinct from current state.
- CRM timestamps, adult/family receipt times and plan-term previews use the existing Language & Region date formatter. UTC date inputs remain explicitly labeled UTC; formatting never changes their values or business terms.
- Existing technical safeguards are retained in a collapsed disclosure; focus moves to enrollment/restoration headings for keyboard access without excessive mobile scrolling. The existing HON components and appearance preferences remain intact.

## Verification

Focused unit/interaction tests cover identity continuity, screen concealment, explicit restoration, all failure statuses, duplicate verification, stale responses, exact child DRAFT retries and family-specific errors. Existing adult/family tests and real transport-to-disposable-PostgreSQL integration remain in the browser workflow. Actual production-built Next browser checks use authorized synthetic sessions/local fixtures, with desktop/mobile screenshots, keyboard, visibility, overflow and axe checks. These browser fixtures are distinct from the real API/disposable-database proof. Full CI and the existing PostgreSQL security proofs must pass on the final head before independent review readiness is claimed.

No backend, migration, contract, financial permission, payment/activation, original asset or unrelated PR change. Remaining staff-review, consent, agreements, alternate-payer, discount, payment and Korean/Spanish copy dependencies are unchanged. Execution results belong in the PR; no production readiness is implied.


## Final safety follow-up after merged PR #49

Baseline: `9db881458ccb4a21ec83505f4482116700513b77`. The page now catches invalid/expired session verification and redirects to the existing sign-in flow before rendering CRM props. Domain APIs remain independently authorized.

Discard is disabled while a request is unsettled; live activity guards also reject stale Discard handlers. Once an outcome is unknown, staff can retry the immutable exact request or acknowledge an accurate warning and deliberately abandon only local recovery. Adult plan-bound and legacy DRAFT retries have dedicated Discard controls. Abandoning an adult/family retry requires a fresh saved-setup read before new commands; it never implies server cancellation or reversal. Unexpected retry types are retained, visibly fail closed, and cannot be executed through the wrong workflow.

An empty idle view is not concealed. Loaded lead/enrollment facts, typed sensitive input, active requests and already-concealed views retain focus-loss protection. Late reads are invalidated when focus leaves an empty view. There is no automatic focus restoration or grace period: concealed information still requires the existing signed-session/exact-school/recovery verification.

The bounded recovery limitation is unchanged: the selected lead must still appear in the freshly authorized, filtered list of at most 50 records. A status change or absence keeps the view hidden; deliberately discard and reload the appropriate filter. No unbounded or speculative backend endpoint is introduced. Browser refresh/navigation/session loss still cannot preserve ephemeral retries across document destruction; no storage or persistence contract is added. Korean/Spanish copy coverage remains separate work.


## PR #50 close-command lifecycle correction

Independent review found that blur incremented `readEpoch` while the WON/LOST close panel used a captured read epoch to report command settlement. The old callback was consequently ignored, leaving both close activity and the shield controls locked. Merely changing that comparison was insufficient: restoration cleared `selected`, and another blur after settlement could also unmount the panel and destroy its exact uncertain retry.

Close ownership now has its own instance epoch, independent of read/verification invalidation. Selection, cancellation/discard, scope clearing and workbench unmount invalidate that ownership. Only the currently mounted close instance can report busy/start/cancel, including after a blur. Its frozen request and key remain in the same mounted panel through settlement, repeated focus loss and explicit access restoration. Live activity guards prevent concurrent reload/other setup and stale Discard handlers from dropping an unsettled request. An unknown retry can be deliberately discarded through the shared warning/acknowledgement control after settlement; neither Discard nor a page reload reverses a server action.

Explicit restoration checks signed identity before and after the existing independently authorized exact-school CRM list read. For a selected close it requests all statuses (still bounded to 50), matches the original lead/contact, and shows the all-status filter with fresh status/version facts. A WON/LOST lead disappearing from the earlier OPEN filter therefore does not destroy recovery. Original request terms and historical close receipts remain separate from the latest list read. New close creation is blocked if the original OPEN version changed; only a retained exact retry can replay an uncertain command. There is no new permission-probe API: restoration rechecks CRM read authority; every explicit close/replay independently rechecks both `crm.lead.read` and `crm.lead.close`, direct-human scope and entitlements at the existing server boundary. A grant to read never becomes a grant to close.

Targeted parent/child lifecycle tests and built-app desktop/mobile checks cover WON/LOST pending focus loss, successful/rejected/network/timeout/503 settlement, exact-key explicit replay after restoration, duplicate and concurrent command protection, stale callbacks across instances/scopes/sessions, repeated blur during restoration, denied/missing recovery, and deliberate abandonment. Browser fixtures are synthetic. Separately the actual signed-session API/disposable-PostgreSQL transport proof injects response loss only after the real close transaction commits, then checks current all-status reads, concurrent exact replay without new rows, cross-school/session/permission denial and no financial effects. Full CI/security results and final-head screenshots are recorded in PR #50 after execution.

The 50-record list limit, document-destruction loss of ephemeral retries and untranslated CRM copy remain unchanged. No backend, contract, migration, financial, permission, provider or production change is part of this correction.
