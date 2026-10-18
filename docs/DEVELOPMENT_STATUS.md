# HON OS — Development Status Report

| | |
| --- | --- |
| **As of** | 2026-10-18 |
| **Baseline** | `main` @ `ca464ea` |
| **Prepared by** | Claude Code, from repository code, tests and `TODO.md` evidence. Not a production or runtime audit |
| **Maintenance** | Update at each meaningful milestone (merged feature, owner decision, CI change). Edit the date, baseline SHA and affected rows only; do not mark anything complete without evidence |

> **Read this first.** A checked TODO item, a passing test, or a polished screen is **not** product completion. HON is a strong, well-tested **foundation of bounded human workflows**. It is **not** yet a commercially launchable product: there is no live signup, no payment processing, no outbound messaging, no ad-platform connection, no deployed production environment, and the AI employees are limited to approval-gated drafts.

## Status legend

| Label | Meaning |
| --- | --- |
| **Verified** | Implemented end-to-end for a bounded workflow (UI → API guard → service → database) **and** covered by passing automated tests on `main` |
| **Partial** | Some real, tested slices exist, but the user-facing capability is incomplete or not connected into the full lifecycle |
| **Visual only** | Reference or concept screens with labeled sample data; no live data or behavior |
| **Blocked** | Waiting on an external provider, owner decision, or approval; deliberately not activated |
| **Missing** | No implementation in the repository |

## 1. Test evidence (actual results)

| Check | Result | Where it runs |
| --- | --- | --- |
| `pnpm test` | **1,220 passed, 0 failed** (web 565, API 376, domain 188, auth 91) | Locally, and on GitHub Actions ([run #1](https://github.com/myhonosai/honos/actions/runs/39090185996), green) via [`ci.yml`](../.github/workflows/ci.yml) |
| `pnpm check` (TypeScript) | Pass | Locally; CI |
| `pnpm build` | Pass | Locally; CI |
| `pnpm db:check` | Pass: 147 migration files | Locally; CI |
| Disposable PostgreSQL 16 proofs | **5 of 70** proof scripts pass, all migrations applied: tenant security boundaries, outbox leases, Class Sessions read, **forced RLS on all 185 tracked tables**, CRM lead close | Locally on a throwaway database, and on GitHub Actions ([run #1](https://github.com/myhonosai/honos/actions/runs/39090185996), green) |
| Remaining 65 database proofs | Recorded as passing in `TODO.md` by Manus; **not independently re-run** by this report | Manus's sandbox |
| Browser end-to-end tests | None in CI | — |

## 2. Implementation progress by area

| Area | Status | Evidence | Main gaps |
| --- | --- | --- | --- |
| Multi-tenant security (org → school isolation, forced RLS, least-privilege runtime role, audit/outbox/idempotency) | **Verified** | 147 migrations; `verify-rls` (185 tables) and `test-security-boundaries` pass on a disposable DB | Production runtime-role setup on the hosted database not verified here |
| Authentication | **Partial** | Signed sessions; generic OIDC plus a Manus development login (`packages/auth`); `/staff/*` and `/hq/*` fail closed | No public signup or self-serve account creation; production identity provider not configured in repo |
| Owner onboarding (school, program, class, first student, first booking, membership draft) | **Verified** (bounded) | `/staff/launch`; `OWNER_LAUNCH_LIFECYCLE.md` | Activation policy (agreement, payment start) needs owner decisions |
| CRM: leads, trials, follow-ups, close, lead import | **Partial** | Lead create/list/close, trial scheduling/outcome, follow-up queue, CSV lead import; DB proofs | Pipelines are separate workbenches rather than one connected lifecycle; frequent manual ID entry; attribution to enrollment/revenue unavailable |
| Scheduling, booking, attendance, planned absence, ClassPass, kiosk | **Partial** | Session creation, bounded read, manual booking, attendance, planned absence request/review, walk-in passes, kiosk handoff | Recurring schedules, waitlists, capacity tracking from bookings, makeups |
| Memberships and invoices | **Partial** | Membership draft/activation/cancellation, invoice draft/issue, renewal review | Payment schedules in use, signed agreements, collection, proration and discounts policy |
| Curriculum, testing, promotion, certificates | **Partial** | Curriculum library, progress observations, testing candidates, scorecards, promotion decisions, certificates, readiness | Full testing event lifecycle, registration payment, rank history |
| Parent / family (web) | **Partial** | 11 family pages: journey, billing observations, planned absences, testing status, messages, documents, achievements | No native Parent App; no account activation flow; message delivery evidence model pending |
| Reporting: operations report, Command Center, health score, revenue planning | **Partial** | Deterministic aggregate reads with explicit UNAVAILABLE states | Revenue, conversion and trends are deliberately unavailable (no authoritative source) |
| Marketing: campaign planning, public lead forms | **Partial** | Human campaign planning and attribution foundation, published lead-form intake | No ad publishing, audiences or spend; ROI unavailable |
| AI Action Engine and approvals | **Partial** | Approval queue, policies, CONFIRM review; AI draft inbox | General tool gateway, AUTO/RESTRICTED coverage across domains |
| School AI employees (Alex, Chad, Maya, Marcus, Jordan, Claire, Lena) | **Partial** | Approval-gated **draft-only** work for Chad (follow-up drafts), Marcus (marketing drafts) and a curriculum/teaching assistant | No employee executes actions; no provider calls in tests; Alex, Maya, Jordan and Lena have no dedicated workflows. Claire's owner-approved role is Business Performance Manager; no workspace for that role yet |
| HON assistant / voice | **Partial** | `/staff/voice` text/voice **handoff record** foundation (no microphone, no AI responses) | Conversational assistant not connected |
| HQ control plane | **Partial** | Overview, school directory, AI provider catalog/routing policy, non-commercial Core↔Complete transition | Subscriptions, credits ledger, support access, contests; **HQ visual implementation is assigned to Codex** |
| Staff roles, availability, qualifications, documents, work items, automation rules, community, marketplace | **Partial** | Human-governed foundations with tests | Broader workflows and execution engines |
| Presentation modes (Big-Button, Modern, Classic) | **Partial** | Persisted per user/school on selected staff screens; reference screens | Not applied platform-wide; HQ and family preferences deferred |
| HON Champions Club | **Partial** (M1–M5 merged; [readiness](architecture/CHAMPIONS_CLUB_READINESS.md)) | Referral codes, attribution, qualification gates ([M1](architecture/CHAMPIONS_CLUB_BACKEND.md)); reward liabilities ledger ([M2](architecture/CHAMPIONS_CLUB_REWARD_ACCOUNTING.md)); leaderboards and statistics ([M3](architecture/CHAMPIONS_CLUB_LEADERBOARD.md)); HQ contest management ([M4](architecture/CHAMPIONS_CLUB_CONTESTS.md)) | Scheduler, fulfillment, notifications; financial activation disabled pending owner terms and billing |
| HON subscription catalog (HON billing schools) | **Partial** (B1 PR pending; [design](architecture/HON_SUBSCRIPTION_CATALOG_B1.md)) | Versioned Core/Complete catalog with regular, founder and lifetime offers; Essential legacy only; atomic founder inventory; per-organization subscription records linked to entitlements; undecided policies refused | Invoices and payment evidence (B2), credit allowances (B3), refunds (B4), provider (B5); charges and credit grants pinned off |
| CI / engineering operations | **Partial** (this PR) | CI for test/check/build/migrations + 5 database proofs on PRs | No push-to-main CI yet (cost decision), no deployment pipeline, monitoring, backups or runbooks in the repo |

## 3. Visual-only prototypes

| Screen | Location | Notes |
| --- | --- | --- |
| HON Complete / Core / Mobile references | `/`, `/core`, `/complete-mobile` | Sample data; portraits and logo load only inside the Manus preview |
| Public pricing reference | `/pricing` | Core $149 / Complete $249 shown as non-binding display metadata; nothing purchasable |
| Classic school dashboard proof | PR #3 (not merged) | Labeled sample data typed to real contracts; awaiting owner final approval |
| HQ concept frames | `docs/visuals/hq-concepts/` | Concept only; Codex is implementing HQ visuals |

## 4. Missing features (no implementation found)

- HON's own subscription billing: checkout, invoices, payment evidence, the 30-day refund guarantee, $100 welcome credit (plan catalog, founder inventory and subscription records: see section 2, B1 PR pending).
- **HON Champions Club** rewards ledger, verified leaderboard and HQ contest builder (referral codes and attribution: see section 2, Partial, PR pending).
- Premium AI credit allowance, balance, reservation and 75/90/100% warnings (usage ledger table exists; no allowance or balance).
- Payment processor integration (Stripe Connect / Square), payouts, reconciliation.
- Outbound SMS / email / push delivery and receipts.
- Meta and Google Ads connection, lead sync, publishing and spend.
- Native Parent App (React Native/Expo) and student mobile experience.
- Commerce / POS / inventory.
- Production deployment, hosting, monitoring, backups and restore runbooks in the repository.

## 5. Commercial launch readiness (separate from implementation progress)

| Launch requirement (owner policy) | Status |
| --- | --- |
| Self-serve signup and school provisioning | Missing (HQ-assisted onboarding exists) |
| HON subscription checkout (Core / Complete, founder, lifetime) | Missing |
| 30-day money-back refund workflow | Missing |
| Champions Club referrals, leaderboard, contests | Partial: attribution foundation only, rewards disabled |
| School payment processing (optional HON Payments) | Missing / Blocked (provider and owner approval) |
| Messaging to families and leads | Blocked (consent/queue foundations exist; no delivery) |
| Meta / Google marketing connectors | Missing / Blocked |
| Complete-tier AI employees doing real delegated work | Partial: drafts only |
| AI credit allowance and cost controls | Missing |
| Production environment, monitoring, backups, incident runbooks | Missing from repository |
| Legal terms, privacy, refund and contest rules | Owner / legal decisions pending |

**Assessment:** 0 of 11 launch requirements are complete. The engineering foundation (tenant security, data model, bounded workflows, tests) is substantially ahead of commercial readiness. Do not infer a launch date from TODO completion counts (272 checked / 78 open).

## 6. Current blockers and owner decisions

1. **PR #3** (Classic dashboard proof) is waiting on owner final approval.
2. **CI triggers:** whether to run on every push to `main`, after the GitHub plan's Actions minutes are confirmed (see [`docs/CI.md`](CI.md)).
3. **Original visual assets** live only in Manus-hosted storage; Manus has been asked to export them to the repository.
4. **Champions Club terms:** referral qualification timing, attribution window, clawbacks and reward caps.
5. **Membership activation policy:** agreement, consent and payment-start rules.
6. **Documentation conflict:** `docs/HON_MASTER_DIRECTIVE.md` §3 still lists Essential as a public tier; the owner has retired it from new sales (legacy records preserved).
7. **Teaching assistant ownership:** Claire is the Business Performance Manager; reassigning the existing curriculum assistant is a separate owner decision.

## 7. Recommended next priorities

1. **Approve and merge CI**, then decide the push-to-main trigger, so every agent's change is verified automatically.
2. **Champions Club backend foundation** (launch-critical, missing, no overlap with Codex HQ UI or current Manus work), after the owner sets qualification rules.
3. **HON subscription and credits foundation** (HQ-only ledger and policy), coordinated with Codex for any HQ screens.
4. **Connect the lifecycle**: lead → trial → enrollment → membership without manual UUID entry, then live-data wiring of the Classic dashboard (coordinate with Manus).
5. **Expand CI database coverage** fixture by fixture, and add production deployment, monitoring and backup runbooks when hosting is chosen.

## 8. How to keep this report honest

- Update rows only with evidence: a merged PR, a passing CI run link, or a named test.
- Keep implementation status (section 2) and launch readiness (section 5) separate.
- Record owner decisions in section 6 with the date.
- When a CI run is the evidence, link the run instead of copying numbers.
