# HON Champions Club — Referral Leaderboards (Milestone 3)

**Status:** Implemented and tested on a disposable local database. **Not merged, not deployed.** It is read-mostly and changes no attribution, reward or billing record.

Builds on [Milestone 1](CHAMPIONS_CLUB_BACKEND.md) (attribution) and [Milestone 2](CHAMPIONS_CLUB_REWARD_ACCOUNTING.md) (reward ladder). Migration: [`0150_champions_club_leaderboard.sql`](../../packages/database/migrations/0150_champions_club_leaderboard.sql). Contracts: [`champions-club-leaderboard.ts`](../../packages/contracts/src/champions-club-leaderboard.ts).

## What counts (accuracy and anti-fraud)

The official standings are computed live from database records. Nothing is stored or typed in.

| Rule | Effect |
| --- | --- |
| Only `QUALIFIED` attributions count | Pending, rejected, refunded and reversed referrals never count. A reversal drops the count immediately |
| Qualification itself is gated | Through M1's owner-attested payment evidence, refund window, minimum paid period and self-referral checks at capture **and** at qualification |
| Only `ACTIVE` schools of `ACTIVE` organizations | A suspended referrer is not ranked |
| HQ leaderboard hold | A school under fraud, duplicate, dispute or owner review is left out of the standings. Placing a hold is HQ owner or operator; releasing it is owner only. A hold never changes attributions or rewards |
| Ties share a rank | Standard competition ranking (1, 1, 3). Within a tie, the school that reached its count first is listed first, then school ID, so the order is stable |
| Monthly standings | By the UTC calendar month in which the referral **qualified**. From 2026-01 to the current month; other months are refused, not shown as empty |
| No minimum padding | Schools with zero qualified referrals are not listed |

## Privacy

- **Anonymous by default.** A school opts in to show its name (`SCHOOL_NAME`) and can opt out at any time. This is a school-staff command, audited.
- **School view of the standings:**
  - Shows rank, qualified count, and a name only for schools that opted in.
  - Shows its own row with its own name.
  - Never shows another school's ID, organization, pending count or hold.
- **A held school** sees only `NOT_RANKED`, never the hold or its reason.
- **School statistics history** lists dates, states and reasons for its own referrals, with no referred-school identity.
- **HQ** sees school and organization names and IDs, pending counts, display preference and holds. It never sees personal data.

## API (under `/v1`)

| Method and path | Authority | Notes |
| --- | --- | --- |
| `GET /hq/champions/leaderboard[?period=ALL_TIME\|MONTH&month=YYYY-MM]` | HQ owner or operator | Top 100 plus `held`, `totalRanked`, `countsOnly: QUALIFIED`, `timeZone: UTC` |
| `GET /hq/champions/schools/:schoolId/statistics` | HQ owner or operator | State counts, 12-month series, milestone progress, all-time rank, 50 newest history events with referred organization, hold |
| `POST /hq/champions/leaderboard/holds` `{action: PLACE, schoolId, reasonCode}` or `{action: RELEASE, schoolId}` | PLACE: owner or operator. RELEASE: owner | Header `champions-leaderboard-hold` |
| `GET /schools/:schoolId/champions/leaderboard[?period&month]` | School staff | Top 25, privacy-filtered, plus `you` |
| `GET /schools/:schoolId/champions/statistics` | School staff | Own statistics, identity-free history |
| `POST /schools/:schoolId/champions/leaderboard-preference` `{displayMode}` | School staff | Header `champions-leaderboard-preference` |

The same request posture as M1 and M2 applies: idempotency key, exact command header, same-origin human JSON, closed validators.

**Selectors:** `period` and `month` are the only selectors, and only on the two leaderboard reads.

**Response checks:** validators reject any standings that are not consecutive by position, are not non-increasing by count, or where a tie does not share a rank.

**Milestone progress:** read against the published M2 reward ladder (reached milestones, next milestone, remaining). When no reward policy is published it reads `POLICY_UNDECIDED`.

## For Codex (HQ Growth & Referrals)

Codex's `/hq/growth/leaderboard` page lists three areas: all-time standings, monthly standings and contest standings.

- **All-time and monthly:** use `GET /v1/hq/champions/leaderboard`.
- **Contest standings:** arrive with Milestone 4.
- **Per-school drill-down:** use `/hq/champions/schools/:id/statistics`.

Please render `held` separately and never as ranked.

## Evidence

- `apps/api/test/champions-club-leaderboard.test.cjs`: contracts, including ordering and privacy validators, plus routes, selectors and headers.
- `pnpm db:test-champions-club-leaderboard` (also in CI) covers:
  - tie ranks and reached-first order
  - all-time and monthly standings
  - exclusion of pending, rejected, refunded, reversed, suspended and held schools
  - opt-in and opt-out privacy
  - no cross-school identity
  - a confidential hold
  - statistics and milestone progress
  - owner-only release
  - immutability
  - no reward, entitlement, membership or invoice effect
  - the API service on real output
- Mutation-checked: removing the hold exclusion fails the proof.

## Open owner decisions

1. **Time zone:** monthly standings use UTC months. Should they use another time zone, for example HON's operating time zone?
2. **Public visibility:** should standings ever be shown publicly, outside signed-in HON? Not built.
3. **Display options:** is a custom display name or logo wanted beyond school name or anonymous? Not built; it would need moderation.
