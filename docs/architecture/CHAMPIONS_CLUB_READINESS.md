# HON Champions Club — Integration Audit and Readiness (Milestone 5)

**As of:** 2026-10-18. **Evidence:** repository code, merged PRs, and disposable-database proofs. This is not a production audit.

## 1. Connected journey (verified end to end)

`test-champions-club-journey-integrity.mjs` drives every step through the real API service against a disposable database:

1. Owner publishes program terms and reward terms (financial activation stays disabled).
2. School staff issue the school's referral code.
3. A new organization is provisioned after the code exists.
4. HQ records the attribution:
   - a replay returns the original
   - a duplicate is refused (409)
   - a self-referral is refused (422)
   - school staff are refused (403)
5. A contest is created, then scheduled by the owner and activated.
6. The owner QUALIFIES the referral. The referrer credit and the welcome credit accrue **in the same transaction** (M5), and a manual reconcile finds nothing missing. A REJECT accrues nothing.
7. The permanent leaderboard, school statistics, milestone progress and school rewards all agree.
8. The contest counts the referral. Then end, propose, approve and complete. The school sees `won`.
9. The HQ overview totals match.
10. The owner REVERSES the payment:
    - both liabilities move to `REVERSAL_REVIEW` (never voided)
    - the school leaves the permanent standings
    - the completed contest's frozen result stays final
    - the overview reflects all of it
11. Every command has exactly one request receipt, audit row and inert outbox event. Each attribution decision records its reward reconciliation in its audit `next_state`.
12. No billing, entitlement, membership, invoice, payment-schedule or shared-audit row changes.

**Mutation check:** removing the M5 reconciliation hook fails the proof.

## 2. Audit of M1–M4 integration

| Area | Finding | Evidence |
| --- | --- | --- |
| Tenant isolation | 19 Champions tables, all forced RLS with no policies and no runtime or client grants; 26 runtime-callable functions (of 52; the rest are private helpers), all `SECURITY DEFINER` with a fixed `search_path`. Sessions carrying tenant, school, family, principal, delegated or Action Engine context are refused. `verify-rls` covers 204 tables | `champions-club-security.mjs`, `verify-rls.mjs` |
| HQ versus school | HQ functions accept only an HQ owner, or an operator with `hq.champions.manage`; support is refused. School functions accept only staff with `champions.participate` at that exact school, an active entitlement, and no parent, family, HQ or platform role. Owner-only: publish, qualify, refund, reverse, reward decisions, contest schedule, resume, early end, winner decisions, complete, cancel | Authority matrices in all five proofs |
| Duplicate referrals | Unique referred organization. Capture returns 409; replay returns the original | M1 and journey proofs |
| Self-referral | Same organization or a shared user identity, checked **at capture and again at qualification** (added in the M1 review) | M1 proof (late-grant case) |
| Idempotency | Actor + key + SHA-256 fingerprint on every command; a reused key with a different body returns 409; replay never re-applies effects, including reward accrual | All proofs |
| Refunds and reversals | REFUND and REVERSE immediately drop the count. M5 reconciliation moves affected liabilities to review in the same transaction; clawback stays an owner rule (`UNDECIDED` blocks it) | Rewards and journey proofs |
| Fraud and holds | Leaderboard holds remove a school from permanent and contest rankings without touching referrals or rewards. A held school sees only `NOT_RANKED` | Leaderboard and contest proofs |
| Contest winner eligibility | Winners come only from frozen eligible results; a school holds at most one live win; a boundary tie needs the owner; completion is blocked while any place is unresolved | Contest proof |
| Prize budget | Scheduling is refused when prize estimates exceed the budget; gift cards are refused unless compliance is `PERMITTED`; the contest budget is immutable after scheduling | Contest proof |
| Financial activation | Pinned false (or `DISABLED`) by `CHECK` on program policies, reward policies and contests. No `FULFILLED` or `ISSUED` state anywhere. No route to fulfill, issue, publish or enter. The outbox is inert by constraint | Constraint tests with the guard disabled; route 404 tests |
| Cross-service consistency | Standings and contest counts read live attribution state. Rewards reconcile on every decision. The overview equals the sum of the parts | Journey proof |

**Known limits, not defects:**
- Monthly standings use UTC.
- Contest transitions are manual (there is no scheduler).
- Attribution capture is an HQ action, because public signup does not exist yet.

## 3. Readiness matrix

- **Implemented** and **tested** apply to every row; tests run on disposable databases, never production.
- **Deployed** and **commercially active** are "no" for every row.

| Capability | Merged | Frontend-connected | Notes |
| --- | --- | --- | --- |
| Referral codes (school) | ✅ `75f3a81` | — | |
| Attribution, qualification, refunds and reversals (HQ) | ✅ `75f3a81` | — | |
| Program terms (versioned) | ✅ | — | Values are owner decisions |
| Reward accounting ledger and decisions | ✅ `13d98c9` | — | |
| Leaderboard, holds, school statistics and privacy | ✅ `ba1866a` | **Partial** | HQ leaderboard on Codex's unmerged `codex/hq-champions-integration` branch |
| Contest management, standings, winners and liabilities | ✅ `77fd2bd` | — | |
| Auto-reconciliation on decisions (M5) | ✅ `50d44d9` | n/a | |
| HQ overview (M5) | ✅ `50d44d9` | — | |
| End-to-end journey proof (M5) | ✅ `50d44d9` | n/a | |

## 4. Owner decisions that block real commercial activation

1. **Program term values.** Attribution window, refund window (the 30-day guarantee), minimum paid days and minimum invoices.
2. **Payment evidence.** Owner attestation is the only working source; `HON_BILLING` needs subscription billing to exist (see the billing handoff).
3. **Clawback rule** after a refund or reversal: void unfulfilled rewards, or retain earned ones.
4. **Plan rules and substitutes.** Founder, monthly and annual rules, and the paid-lifetime substitute.
5. **Rewards between milestones**, the prize budget and prize tax handling.
6. **Contests.** Gift-card legality per jurisdiction, contest legal terms, announcements, any public listing, and approval of an automatic scheduler.
7. **Fulfillment design.** How a credit or free month is applied to a HON invoice, and how lifetime is granted. This needs HON billing.
8. **Signup integration.** How a code is captured at self-serve signup once signup exists.
9. **Essential.** Whether legacy Essential schools may participate (currently allowed).

## 5. Dependencies kept out of M5 (beyond approved scope)

| Dependency | Why it is out of scope |
| --- | --- |
| Automatic contest start and end | Needs an approved scheduler (worker or `pg_cron`) and an unattended-transition policy |
| `HON_BILLING` payment source and reward fulfillment | Needs HON subscription billing and invoices |
| Code capture at signup | No public signup flow exists |
| Contest and reward notifications | Outbound messaging is not activated |
| Frontend | Codex owns the HQ screens; contracts are in [CHAMPIONS_CLUB_API_CONTRACTS.md](CHAMPIONS_CLUB_API_CONTRACTS.md) |
