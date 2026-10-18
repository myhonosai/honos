# HON Champions Club — Stable API Contracts (for Codex's HQ frontend)

**Status:** stable as of Milestone 5. Types live in `packages/contracts/src/champions-club*.ts` and are exported from `@hon/contracts`. Every response is `{ data }` and is checked by a closed validator; any extra or missing field fails closed (503).

**Rules for every call**
- **Reads** (`GET`): session identity only, `Cache-Control: no-store`, no body. Selectors only where listed.
- **Commands** (`POST`): `Content-Type: application/json`, `Origin` equal to the HON public origin, `Sec-Fetch-Site/Mode: same-origin`, `Sec-Fetch-Dest: empty`, an `Idempotency-Key` UUID, and the exact `x-hon-human-command` value listed (exported as `CHAMPIONS_COMMANDS`). No query string, and no other `x-hon-*` header. Replaying the same key and body returns the original receipt with `replayed: true`.
- **Never shown as done:** `financialActivation` / `financialRewards` are always `DISABLED`; `automaticTransitions` is `NOT_CONFIGURED`; `publicListing` is `DISABLED`. The UI must never present a reward, credit, prize or contest as issued, applied, purchased or public.

## Errors (all endpoints)

| HTTP | `code` | UI meaning |
| --- | --- | --- |
| 400 | `INVALID_CHAMPIONS_INPUT` | Shape, range or selector invalid |
| 403 | `CHAMPIONS_FORBIDDEN`, `HUMAN_UI_REQUIRED` | No authority, or not a same-origin human command |
| 404 | `CHAMPIONS_UNAVAILABLE` | Unknown record |
| 409 | `CHAMPIONS_VERSION_CONFLICT`, `CHAMPIONS_TRANSITION_NOT_ALLOWED`, `CHAMPIONS_POLICY_NOT_DRAFT`, `CHAMPIONS_DUPLICATE_ATTRIBUTION`, `IDEMPOTENCY_KEY_REUSED`, `CHAMPIONS_OUTCOME_UNKNOWN` (retry the same request and key) | Refresh, or retry as named |
| 422 | Business rule refused: `CHAMPIONS_SELF_REFERRAL`, `CHAMPIONS_ATTRIBUTION_NOT_ELIGIBLE`, `CHAMPIONS_POLICY_UNDECIDED`, `CHAMPIONS_PAYMENT_SOURCE_UNAVAILABLE`, `CHAMPIONS_QUALIFICATION_NOT_MET`, `CHAMPIONS_ATTRIBUTION_EXPIRED`, `CHAMPIONS_REWARD_RULE_UNDECIDED`, `CHAMPIONS_REWARD_SUBSTITUTE_MISMATCH`, `CHAMPIONS_PRIZE_OVER_BUDGET`, `CHAMPIONS_CLAWBACK_NOT_PERMITTED`, `CHAMPIONS_CONTEST_INCOMPLETE`, `CHAMPIONS_CONTEST_OVER_BUDGET`, `CHAMPIONS_GIFT_CARDS_NOT_PERMITTED`, `CHAMPIONS_CONTEST_NOT_STARTED`, `CHAMPIONS_CONTEST_WINDOW_PASSED`, `CHAMPIONS_CONTEST_PRIZES_OVERLAP`, `CHAMPIONS_CONTEST_WINNER_NOT_ELIGIBLE`, `CHAMPIONS_CONTEST_WINNERS_UNRESOLVED` | Show the specific reason |
| 503 | `CHAMPIONS_UNAVAILABLE`, `HUMAN_UI_ORIGIN_NOT_CONFIGURED` | Show unavailable |

## 1. HQ overview — `/hq/growth`, `/hq/growth/champions-club`

| Method and path | Authority | Response type |
| --- | --- | --- |
| `GET /v1/hq/champions/overview` | HQ owner or operator | `ChampionsOverview` |

`ChampionsOverview` contains, all as counts or sums:
- program and reward-program status
- active referral codes
- attributions by state
- ranked schools and active holds
- reward liabilities (entries, credits, free months, prizes, lifetime, in review, approved)
- contests by status, plus `startDue` and `endDue`
- contest winner liabilities

## 2. Program terms and attribution — `/hq/growth/champions-club`

| Method and path | Authority | Header | Types |
| --- | --- | --- | --- |
| `GET /v1/hq/champions/program` | Owner or operator | — | `ChampionsProgram` |
| `POST /v1/hq/champions/policy-drafts` | Owner or operator | `champions-policy-draft` | `ChampionsPolicyDraftInput` → `ChampionsPolicyDraftReceipt` |
| `POST /v1/hq/champions/policy-drafts/:policyId/publish` | Owner | `champions-policy-publish` | `{}` → `ChampionsPolicyPublishReceipt` |
| `GET /v1/hq/champions/attributions[?state=]` | Owner or operator | — | `ChampionsAttributionList` (newest 100) |
| `POST /v1/hq/champions/attributions` | Owner or operator | `champions-attribution-capture` | `ChampionsAttributionCaptureInput` → `ChampionsAttributionReceipt` |
| `POST /v1/hq/champions/attributions/:id/decisions` | REJECT: owner or operator. QUALIFY, REFUND, REVERSE: owner | `champions-attribution-decide` | `ChampionsDecisionInput` → `ChampionsAttributionReceipt` |

Since M5, every decision also reconciles the referrer school's reward liabilities in the same transaction. No separate call is needed; refresh the ledger afterwards.

## 3. School referral details and statistics

| Method and path | Authority | Types |
| --- | --- | --- |
| `GET /v1/hq/champions/schools/:schoolId/statistics` | HQ owner or operator | `ChampionsHqSchoolStatistics`: state counts, 12-month series, milestone progress, rank, 50 newest events with referred organization, hold |
| `GET /v1/schools/:schoolId/champions/summary` | School staff | `ChampionsSchoolView` |
| `GET /v1/schools/:schoolId/champions/statistics` | School staff | `ChampionsSchoolStatistics` (no referred identity) |
| `GET` / `POST /v1/schools/:schoolId/champions/referral-code` | School staff | `ChampionsReferralCodeReceipt`. Header `champions-referral-code-issue` |
| `GET /v1/schools/:schoolId/champions/rewards` | School staff | `ChampionsSchoolRewards` |
| `POST /v1/schools/:schoolId/champions/leaderboard-preference` | School staff | `{displayMode}` → `ChampionsPreferenceReceipt`. Header `champions-leaderboard-preference` |

## 4. Leaderboard — `/hq/growth/leaderboard`

| Method and path | Authority | Types |
| --- | --- | --- |
| `GET /v1/hq/champions/leaderboard[?period=ALL_TIME\|MONTH&month=YYYY-MM]` | HQ owner or operator | `ChampionsHqLeaderboard`: top 100, `held` list, `countsOnly: QUALIFIED`, `timeZone: UTC` |
| `POST /v1/hq/champions/leaderboard/holds` | PLACE: owner or operator. RELEASE: owner | `ChampionsHoldInput` → `ChampionsHoldReceipt`. Header `champions-leaderboard-hold` |
| `GET /v1/schools/:schoolId/champions/leaderboard[?period&month]` | School staff | `ChampionsSchoolLeaderboard` (privacy-filtered top 25 plus `you`) |

Render `held` separately, never as ranked. Ties share a rank.

## 5. Reward liabilities — `/hq/growth/rewards`

| Method and path | Authority | Header | Types |
| --- | --- | --- | --- |
| `GET /v1/hq/champions/rewards/program` | Owner or operator | — | `ChampionsRewardProgram` |
| `POST /v1/hq/champions/rewards/policy-drafts` | Owner or operator | `champions-reward-policy-draft` | `ChampionsRewardPolicyDraftInput` → `ChampionsRewardPolicyDraftReceipt` |
| `POST /v1/hq/champions/rewards/policy-drafts/:id/publish` | Owner | `champions-reward-policy-publish` | `{}` → `ChampionsRewardPolicyPublishReceipt` |
| `GET /v1/hq/champions/rewards/ledger[?status=]` | Owner or operator | — | `ChampionsRewardLedger`: newest 200 plus `liabilities` grouped by status and kind |
| `POST /v1/hq/champions/rewards/schools/:schoolId/reconcile` | Owner or operator | `champions-rewards-reconcile` | `{}` → `ChampionsRewardReconcileReceipt` (manual re-check; decisions already reconcile) |
| `POST /v1/hq/champions/rewards/entries/:entryId/decisions` | Owner | `champions-reward-decide` | `ChampionsRewardDecisionInput` (APPROVE, VOID, RETAIN) → `ChampionsRewardDecisionReceipt` |

There is no fulfill or issue action. "Approved" means approved for future fulfillment only.

## 6. Contest management, standings and winner review — `/hq/growth/contests`

| Method and path | Authority | Types |
| --- | --- | --- |
| `GET /v1/hq/champions/contests[?status=]` | Owner or operator | `ChampionsContestList` |
| `POST /v1/hq/champions/contests` | Owner or operator | `{action: 'CREATE', …ChampionsContestConfig}` → `ChampionsContestReceipt` |
| `GET /v1/hq/champions/contests/:contestId` | Owner or operator | `ChampionsContestDetail`: contest, live or frozen `standings`, `pauses`, `winners`, `liabilities`, `history` |
| `POST /v1/hq/champions/contests/:contestId/commands` | See below | `ChampionsContestCommand` → `ChampionsContestReceipt` |
| `GET /v1/schools/:schoolId/champions/contests` | School staff | `ChampionsSchoolContests` (visible contests only; no costs) |

- **Header:** `champions-contest-command` for both POSTs.
- **`expectedVersion`:** use `contest.version` from the latest read on every command except CREATE and DUPLICATE.
- **Owner-only actions:** SCHEDULE, RESUME, early END, APPROVE_WINNER, REJECT_WINNER, RESOLVE_WINNER, COMPLETE, CANCEL.
- **Owner or operator:** UPDATE, DUPLICATE, ACTIVATE, PAUSE, END (after `endsAt`), PROPOSE_WINNERS, DISPUTE_WINNER.
- **Due prompts:** show `contest.due` (`START_DUE` / `END_DUE`) as a prompt for HQ to act. Contests never start or end on their own.
