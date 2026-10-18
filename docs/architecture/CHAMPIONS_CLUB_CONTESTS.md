# HON Champions Club — Referral Contests (Milestone 4)

**Status:** Implemented and tested on a disposable local database. **Not merged, not deployed, not commercially activated.**

HON HQ can create, configure, schedule, run, pause, end and settle referral contests through the API, with no developer changes. Prizes are **recorded liabilities only**. Nothing in this milestone:
- buys a prize or issues a gift card
- sends a message
- lists a contest publicly
- creates an external obligation

Migration: [`0152_champions_club_contests.sql`](../../packages/database/migrations/0152_champions_club_contests.sql). Contracts: [`champions-club-contests.ts`](../../packages/contracts/src/champions-club-contests.ts).

## Separation from the permanent program

- **Windows, not referrals.** A contest is a time window over the same verified `QUALIFIED` attributions from M1. It never creates, consumes or changes a referral, a permanent reward (M2) or a leaderboard hold (M3).
- **Permanent milestones are unaffected.** M2 counts every qualified referral, so contest referrals always count toward permanent milestones; contests change nothing there.
- **Contest prizes have their own ledger.** They live in `champions_contest_winners`, separate from the permanent reward ledger (`champions_reward_entries`).

## Lifecycle

```
DRAFT ──SCHEDULE (owner)──► SCHEDULED ──ACTIVATE──► ACTIVE ◄──RESUME (owner)── PAUSED
  │                            │                     │  └──PAUSE──────────────►  │
  └──CANCEL (owner)            └──CANCEL (owner)     └──END──► ENDED ◄──END──────┘
                                                                  │ PROPOSE_WINNERS
                                                                  ▼
                                    COMPLETED ◄──COMPLETE (owner)── PENDING_WINNER_APPROVAL
```

- **No scheduler.** The repository has no safe scheduling infrastructure, so transitions are explicit HQ commands and `automaticTransitions` reads `NOT_CONFIGURED`.
- **Due flags.** Reads report `due: START_DUE` once a scheduled contest's start has passed, and `END_DUE` once an active or paused contest's end has passed. They state what HQ should do; nothing happens on its own.
- **Standings follow the configured window, not the clicks.** They count referrals qualified in `[startsAt, endsAt)` and skip the time spent paused, so a late click does not change who counts.
- **Validated configuration.** The database guard enforces the transition matrix. Configuration is editable only in `DRAFT`. After that, only lifecycle fields change; prizes and eligible schools cannot be added or removed.

## Configuration (draft)

| Field | Values |
| --- | --- |
| `name`, `description`, `termsReference` | Text. Terms are required to schedule |
| `startsAt`, `endsAt` | UTC ISO times. End after start; at most 366 days |
| `countBasis` | `CAPTURED_AND_QUALIFIED_IN_WINDOW` (default; anti-gaming: no holding back qualifications) or `QUALIFIED_IN_WINDOW` |
| `minimumQualified` | Minimum qualified referrals to place |
| `tieRule` | `OWNER_RESOLVES` (a tie that crosses a prize boundary goes to `TIE_REVIEW`) or `EARLIEST_TO_REACH` |
| `eligibility` | `ALL_ACTIVE_SCHOOLS` or `SELECTED_SCHOOLS` (with school IDs), plus eligible tiers (`ESSENTIAL`, `CORE`, `COMPLETE`) |
| `budgetMinor` | Overall budget. Required to schedule, and prize estimates must fit within it |
| `giftCardCompliance` | `UNDECIDED`, `PERMITTED` or `NOT_PERMITTED`. Any `GIFT_CARD` prize blocks scheduling unless `PERMITTED` |
| `prizes[]` | Non-overlapping place ranges; kind (`ELECTRONICS`, `AMUSEMENT_TICKETS`, `GIFT_CARD`, `EXPERIENCE`, `OTHER_APPROVED`); description; quantity per place; estimated unit cost |

`SCHEDULE` is the owner's approval of the whole configuration. It also sets `schoolVisibility`:
- `HIDDEN` (the default)
- `ELIGIBLE_SCHOOLS`: shown to eligible signed-in schools only

`publicListing` is pinned `DISABLED`, `ownerApprovalRequired` pinned true, and `financialActivation` pinned `DISABLED`, all by constraint.

`DUPLICATE` copies a contest's configuration into a new draft with a new name and dates.

## Standings, eligibility and anti-fraud

- **What counts:** only `QUALIFIED` referrals of the referrer school. A reversal removes one immediately while the contest is live.
- **What is listed but not ranked:** schools with counted referrals but one of these reasons:
  - `NOT_SELECTED`
  - `TIER_NOT_ELIGIBLE`
  - `SCHOOL_INACTIVE`
  - `LEADERBOARD_HOLD` (the M3 hold)
  - `BELOW_MINIMUM`
- **Ranking:** ties share a rank, and position breaks ties by reached-first.
- **END freezes results:** the counts, eligibility, rank and position at that moment are written to immutable rows. Later attribution changes do not move a finished contest.
  - An early END (before `endsAt`) is owner-only.

## Winners

- **Proposal.** `PROPOSE_WINNERS` assigns each prize place to the eligible frozen result at that position.
  - Under `OWNER_RESOLVES`, a place whose school is tied with a school receiving a different prize outcome is marked `TIE_REVIEW`.
  - Each winner row carries its estimated cost (quantity × unit cost) as a liability.
- **Owner decisions:**
  - `APPROVE_WINNER`.
  - `REJECT_WINNER` (`DISPUTE_UPHELD`, `FRAUD_CONFIRMED`, `INELIGIBLE`).
  - `RESOLVE_WINNER`: break a tie, dismiss a dispute, or reassign a rejected place. It only accepts an eligible frozen result that holds no other live win in the contest.
- **Disputes.** HQ operators may raise `DISPUTE_WINNER`.
- **Completion.** `COMPLETE` is refused while any place is `PROPOSED`, `TIE_REVIEW` or `DISPUTED`.
- **Liabilities.** Reported per contest: budget, estimated prize cost, pending winner cost, approved winner cost.

## Authority

All contest commands are HQ only, never school staff, families or AI.

| HQ operator (with `hq.champions.manage`) or owner | Owner only |
| --- | --- |
| CREATE, UPDATE, DUPLICATE, ACTIVATE, PAUSE, END (at or after `endsAt`), PROPOSE_WINNERS, DISPUTE_WINNER | SCHEDULE, RESUME, early END, APPROVE / REJECT / RESOLVE_WINNER, COMPLETE, CANCEL |

## API (under `/v1`)

| Method and path | Notes |
| --- | --- |
| `GET /hq/champions/contests[?status=]` | Newest 100 |
| `POST /hq/champions/contests` | `{action: CREATE, …config}`; header `champions-contest-command` |
| `GET /hq/champions/contests/:contestId` | Contest, live or frozen standings, pauses, winners, liabilities, history |
| `POST /hq/champions/contests/:contestId/commands` | Every other action; same header; `expectedVersion` on all |
| `GET /schools/:schoolId/champions/contests` | Visible contests the school is eligible for |

The school view returns:
- prizes, without costs
- the top 10, privacy-filtered with the M3 opt-in
- `you` (`NOT_RANKED` hides any hold)
- `won` (approved and completed)

New 422 codes:
- `CHAMPIONS_CONTEST_INCOMPLETE`
- `CHAMPIONS_CONTEST_OVER_BUDGET`
- `CHAMPIONS_GIFT_CARDS_NOT_PERMITTED`
- `CHAMPIONS_CONTEST_NOT_STARTED`
- `CHAMPIONS_CONTEST_WINDOW_PASSED`
- `CHAMPIONS_CONTEST_PRIZES_OVERLAP`
- `CHAMPIONS_CONTEST_WINNER_NOT_ELIGIBLE`
- `CHAMPIONS_CONTEST_WINNERS_UNRESOLVED`

## Evidence

- `apps/api/test/champions-club-contests.test.cjs`: command and response contracts, service routing, refusal codes, routes, and that no publish, fulfill or enter route exists.
- `pnpm db:test-champions-club-contests` (also in CI) covers the full lifecycle:
  - authority and closed configuration
  - completeness, budget and gift-card gates
  - duplicate
  - `START_DUE` and `END_DUE` (a real 3.5-second wait)
  - pause exclusion
  - frozen results
  - boundary-tie review, owner resolution, dispute, rejection and reassignment
  - completion block
  - liabilities
  - selected-school eligibility with `QUALIFIED_IN_WINDOW`
  - privacy-filtered school views, and hidden contests never shown
  - immutability
  - **no effect on permanent rewards, holds, entitlements, memberships or invoices**
  - the API service on real output
- Mutation-checked: removing the pause exclusion fails the proof.

## Open owner decisions

1. **Automatic start and end:** needs an approved scheduler (worker or `pg_cron`) and a policy for unattended transitions.
2. **Prize fulfillment:** purchasing, gift-card issuance and shipping workflow, plus prize tax handling. Not built.
3. **Gift-card compliance:** confirmation per jurisdiction before setting `PERMITTED`.
4. **Notifications and public listing:** contest announcements to schools and any public listing. Not built.
5. **Optional exclusion:** whether a contest's referrals should ever be excluded from permanent milestones. Currently they always count, by design.
