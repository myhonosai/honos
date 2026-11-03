# Connected CRM membership recovery

This is the actual staff application, using the existing CRM, E1a activation and #104 date/history components. It is a frontend dependency PR, not approval or deployment of Claude's backend or S4.

## Exact dependency and current behavior

- Accepted main: `fac44beba30f5bec3d06d32022c6875ac7019f41` (merged #104).
- Dependency: [PR #122](https://github.com/myhonosai/honos/pull/122), exact head `2446820575ae13cdd65284c2168003140fc5b8da`, branch `claude/crm-lead-membership-discovery`. GitHub verified that accepted main is already its ancestor. The frontend branch starts directly on that dependency; it does not merge or modify #122 or any S4 branch. The draft PR targets the backend branch so only this frontend/test/documentation delta is reviewed. Retarget/reconcile with accepted main after independently approved backend/dependency merges; do not merge this stack prematurely.
- Reuse the dependency's exact `verifyCrmLeadMemberships` contract. GET one selected lead at one school; no query/body/key, fallback person matching, directory, new backend or migration. Direct-human `crm.lead.read` and `billing.membership.activate` authority are mandatory server-side. A browser's school, lead or membership selector never establishes access.
- CRM list and connected staff journey expose a saved-memberships link only from a usable lead view. The destination retains lead/school selectors, starts idle and explicitly verifies signed identity before and after the protected discovery read. Refresh/new session can discover durable database records without a saved membership UUID.
- Every adult/child membership remains separate. The minimal backend response intentionally has no names or terms: show its origin, student-profile reference, lifecycle/version and recorded creation time. Names, plan and dates require the existing separately authorized detail reads. No identity matching or fabricated student names.
- DRAFT opens the existing protected two-step activation component. Other lifecycle rows open the existing date/history component, which independently reads current state and limits changes to backend-authorized ACTIVE records. ACTIVE discovery is lifecycle evidence only; scheduled, ended, cancelled and expired periods are not inferred as currently in effect or paid. No automatic activation or date command.
- Back returns to the same lead's recovery context, with an explicit fresh read rather than restoring cached facts. A return link carries only lead/school selectors to the existing CRM journey, which remains idle until independently authorized. Its existing 50-lead reader bound remains; this is not a new school directory or a general CRM lead reader.

## Privacy, navigation and failure handling

Blur, hidden visibility, pagehide, confirmed session invalidation and school-context changes synchronously conceal the protected DOM, clear discovery facts, abort reads and invalidate late responses. Focus does not reveal or fetch. Explicit restoration verifies the original signed identity and exact-school lookup again. HTTP 401 reports shared invalidation; 403 is local denial. 404, 409, 503/network/unverifiable results are distinct from an authorized empty 200 list. The response envelope and shared decoder fail closed on scope, shape, ordering, duplicates and count drift.

An open activation/date detail stays mounted behind its existing shield so unsettled immutable command/key ownership survives ordinary focus loss. Discovery itself never writes or allocates a key. Return/abandon behavior uses the existing command guards; a stale detail callback cannot navigate a different membership. Full document destruction still loses in-memory consequential retries; no browser storage or URL carries a retry, student details or membership ID. The detail's existing unload warning and deliberate abandonment rules remain.

EN/KO/ES labels and errors use local catalogs and the existing formatting utilities. Modern, Classic and Big Button reuse existing activation styling. Bound detail screens inherit the selected mode and use the same existing components; no parallel date/activation implementation.

## School operations: implemented navigation and exact remaining gap

After an authorized ACTIVE history read, existing links open `/staff/schedule/bookings` and `/staff/attendance`. They perform no booking, attendance, eligibility or payment action. This feature does not add a new prefill exception:

- The current booking destination accepts only a closed organization/school/**class session** triple; it intentionally leaves student profile blank. It cannot consume a membership/student-only handoff.
- Attendance accepts organization/school selectors; program, class session and student still require explicit verified context. Discovery's student UUID alone does not prove session eligibility or attendance.
- **Next minimum integration contract to coordinate with Claude:** an independently authorized, exact-school student/membership → class-session/booking context read, including verified student display reference, current effective membership evidence where required, applicable server capabilities, bounded session/booking references and versions. Reuse existing session/booking/attendance services. Define privacy-safe selector handoffs only after this context is verified. Never claim a session, benefit, booking or attendance record from a membership UUID alone. This is the next separate school-operations slice, not implemented here.

## Verification and release gates

The dedicated workflow supports the explicit #122 stacked base and later main, checks out the exact PR head, and runs repository/typecheck/build/migrations, complete disposable database proofs, guarded commercial rehearsals and browser/API verification. No runtime secret/provider configuration or activation is added. The stacked source has 192 migration files through proposed 0200; all are inherited unchanged, including all 184 accepted-main migrations. Owner migration allocation, independent #122/S4 approval and accepted-main integration remain prerequisites.

Unit/interaction/page tests exercise the actual shared decoder, distinct HTTP refusals, closed idle selectors, identity checks, concurrent clicks, late responses, school/session changes, unmount, privacy and same-lead navigation. The actual frontend HTTP transport also runs through signed-session Nest, the real scope resolver and restricted runtime against guarded disposable PostgreSQL, with all-table snapshots and a timing-only revocation barrier. Browser tests mount production Next components with real signed synthetic sessions and deterministic localhost API fixtures; these are explicitly not database/provider proofs. Desktop/tablet/mobile screenshots and axe evidence remain private Actions artifacts.

Exact executed counts, failures and final-head CI/artifact links belong in the PR evidence. Local cached tooling can run frontend tests/typecheck/build. Local listening/PostgreSQL/Chromium are unavailable, so those executions are claimed only when the supported GitHub jobs actually pass. Issue #125's four P3 findings and #121 remain separate. No live provider, paid access, trial, policy approval, payment, AI spending, deployment or production record is activated.
