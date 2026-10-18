# HQ school referrals and reward accounting

Owner-authorized frontend continuation after overview PR #19 merged as `ececf75d8e300f957fb99416babb95c1064688fb`. Branch `codex/hq-school-reward-management`; no deployment, financial activation or new-PR merge authorization.

## Implemented reads

| Screen | Sources and scope |
| --- | --- |
| `/hq/growth/champions-club/schools` | Existing selector-free minimized HQ school directory, followed only after human selection by `/v1/hq/champions/schools/:schoolId/statistics` and `/rewards/program` |
| `/hq/growth/rewards` | `/v1/hq/champions/rewards/ledger[?status=...]` and `/rewards/program` |
| Existing overview / leaderboard | Preserved real reads, approved shell/assistant/executives, separate View and AI Style groups |

All browser API paths have the existing `/api` same-origin prefix. No new API, contract, database, permission, preference or original-asset change. Directory identity is an untrusted human-selected UUID, never a scope token or authority; canonical Champions services independently authorize the current HQ owner/operator with `hq.champions.manage`. Directory itself separately requires its existing HQ authority. School/family/support/AI/delegated contexts cannot bridge into either boundary. URL/query values remain inert; selection is not persisted or guessed, even for one school. The existing directory helper/validator is reused unchanged; its non-abortable read is ignored after cleanup. Detail reads forward abort signals and discard obsolete results.

## Accuracy and completeness

- School counts and official all-time rank come from the canonical statistics projection, never history lengths or browser sorting. The statistics contract does not include exact tie-order position; the UI says so. Null rank means not ranked, not rank zero.
- Referral history is **newest 50 state-transition events at most**, not 50 distinct referrals or complete history. Twelve monthly qualified values are backend aggregates, not a browser leaderboard.
- Reached milestones and next-milestone remaining values are backend-reported. The 5/10/20/30 cards distinguish reached, backend next, later configured thresholds with unavailable remaining counts and unconfigured roadmap targets. No browser subtraction establishes official progress or awards. The published reward policy/version must match the school projection; a publication race fails closed and requires refresh. Qualification progress is not an accrued, approved or fulfilled award.
- Global ledger is **newest 200 matching entries at most**, ordered by the backend. Status filter affects only entries. Its liability groups always aggregate **all non-voided records** regardless of that filter (verified in migration 0149's `read_champions_reward_ledger_from_hq`). No client total or per-school history is calculated from the limited list. Historical entries retain their own policy versions, independent of current published terms.
- `ACCRUED` = recorded liability/pending approval; `APPROVED` = approved for future fulfillment; `REVERSAL_REVIEW` = requires review; `VOIDED` = voided accounting record. None means paid, applied, delivered or fulfilled. Account credits differ from AI credits. Free months, prizes/substitutes and lifetime entries remain distinct benefits/liabilities. Exact USD minor-unit formatting preserves safe integer precision.
- Configuration amounts (including any $100 account credit) come from published terms or entries, not hardcoded award assumptions. Null/undecided/zero remain distinct.

## Backend dependency and coordination

Complete HQ per-school reward history is **unavailable**. The global newest-200 list cannot support it, and the staff-only school reward endpoint is not an HQ fallback. A concrete coordination request on [Claude's PR #13](https://github.com/myhonosai/honos/pull/13) asks for a separately reviewed canonical HQ-authorized, school-bound, paginated read with stable cursor/order/snapshot semantics, closed typed validators, exact status/filter/aggregate scope and disabled financial activation. Codex has not implemented or assumed that API. The school UI displays this limitation explicitly.

## Next contest milestone — reviewed, not implemented

Merged M4 has HQ contest list/detail GETs with closed validators (`validateChampionsContestList`, `validateChampionsContestDetail`), frozen standings, winner/liability/history records and manual due-state metadata. A future read-only integration can consume those exact contracts after current owner review. Contest commands, public listing, publication, scheduling/transitions, winner decisions and fulfillment are excluded here; no duplicate backend. Financial/public activation remains disabled and automatic transitions are not configured.

## Verification and handoff

Focused unit/transport/render tests cover fixed GETs, UUID/status validation, independent failures, private body suppression, response/school/policy/filter binding, exact server aggregates, empty/unpublished and truthful reward states. Actual production-app browser verification uses signed synthetic localhost sessions, closed GET fixtures, blocked external hosts, no inherited credentials and read-only pinned CI. It extends the existing narrowly restricted temporary workflow to this exact same-repository branch targeting main. Canonical backend authorization/calculation/security remains separately exercised by existing full CI disposable-database proofs; browser doubles are not a substitute.

Actual CI results, browser counts and permanent screenshots will be recorded after execution. Local dependency cache is absent; no repeated broken-proxy installation attempts. Physical device software keyboard/rotation and VoiceOver/NVDA/contrast/zoom review remain manual, and axe incomplete results require assessment. Do not claim complete WCAG certification.

English/Korean/Spanish remains future documentation-only PR #17 scope; no translations or persistent preference database are implemented. No school CRM/enrollment, backend, contracts, RLS, production databases, rewards, providers or deployment changed. Remove temporary verification workflow only through a separately reviewed cleanup after evidence/sign-off.
