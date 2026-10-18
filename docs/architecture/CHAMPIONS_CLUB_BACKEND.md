# HON Champions Club — Backend (Milestone 1)

**Status:** Implemented and tested on a disposable local database. **Not merged, not deployed, not commercially activated.** No reward of any kind is issued: financial rewards are pinned `DISABLED` by a database constraint.

Business intent: [`docs/hon/CHAMPIONS_CLUB_AND_GROWTH.md`](../hon/CHAMPIONS_CLUB_AND_GROWTH.md). Tracking: issue #6.

## What Milestone 1 provides

| Capability | Where |
| --- | --- |
| School-owned referral code (one ACTIVE per school, server-generated, 10 characters from a 32-letter alphabet without `I`, `O`, `0`, `1`) | `hon.champions_referral_codes`, `issue_champions_referral_code` |
| Referral attribution recorded by an HQ human against an existing organization | `hon.champions_attributions`, `capture_champions_attribution` |
| States `PENDING → QUALIFIED / REJECTED / REFUNDED`, `QUALIFIED → REFUNDED / REVERSED`, each versioned, with closed reason codes | `decide_champions_attribution`, `guard_champions_records` trigger |
| Versioned program policy (attribution window, refund window, minimum paid days and invoices, payment-verification source, welcome-credit amount, terms reference) | `hon.champions_policies`, draft / publish functions |
| Immutable history, idempotency receipts, audit and inert outbox | `champions_attribution_history`, `champions_requests`, `champions_audit`, `champions_outbox` |
| Typed contracts | [`packages/contracts/src/champions-club.ts`](../../packages/contracts/src/champions-club.ts) |
| API | [`apps/api/src/champions/`](../../apps/api/src/champions/) |

Migration: [`0148_champions_club_foundation.sql`](../../packages/database/migrations/0148_champions_club_foundation.sql).

## Security boundary

- All seven tables have **forced RLS with no policies** and no grants to `hon_runtime`, `anon`, `authenticated`, `service_role` or `PUBLIC`. The runtime role may execute only the eight public functions listed below.
- Every function resolves its actor from the verified external subject. A session carrying any tenant, school, family, principal, delegated or Action Engine context (`app.hon_*`) is refused, so AI employees and delegated calls cannot reach these commands.
- **HQ authority:** `HON_HQ_OWNER`, or `HON_HQ_OPERATOR` holding `hq.champions.manage`. `HON_HQ_SUPPORT` is refused. Financially consequential actions are owner-only: publishing terms, QUALIFY, REFUND, REVERSE. Operators may draft terms, capture attributions and REJECT.
- **School authority:** staff with the new `champions.participate` permission at the exact school (existing system OWNER roles receive it), an active organization entitlement, and no parent, guardian, student, family, HQ or platform role. HQ-granted principals are excluded by `staff_member_eligible`. The path school ID is only a selector; the database decides.
- Commands require the `Idempotency-Key` UUID header, the route's exact `x-hon-human-command` value, same-origin `sec-fetch-*` headers, JSON content type and no query string. Reads are `no-store`, have no body, and take no selectors except `state` on the HQ attribution list.
- Database errors are mapped to fixed codes. Only the business-rule refusal codes listed below are shown; no SQL text, constraint name or private value reaches the client. Responses pass closed validators, and any extra field fails the request (503).

## Fraud and eligibility rules enforced now

| Rule | Behavior |
| --- | --- |
| Self-referral | Refused if the referred organization is the referrer, or any user holds a role in both organizations (`CHAMPIONS_SELF_REFERRAL`) |
| Duplicate | One attribution per referred organization, ever (`CHAMPIONS_DUPLICATE_ATTRIBUTION`) |
| Retroactive | An organization created before the code was issued cannot be attributed |
| Inactive | Revoked codes and non-ACTIVE organizations cannot be attributed |
| Attribution expiry | QUALIFY is refused after `attributionWindowDays` from capture (`CHAMPIONS_ATTRIBUTION_EXPIRED`) |
| 30-day guarantee and minimum paid period | QUALIFY is refused until `max(refundWindowDays, minimumPaidDays)` days after the first payment, with at least `minimumPaidInvoices` payments (`CHAMPIONS_QUALIFICATION_NOT_MET`) |
| Referred account in good standing | QUALIFY requires an ACTIVE organization and entitlement |
| Undecided terms | A draft with any undecided term cannot be published, and nothing can qualify without a published policy (`CHAMPIONS_POLICY_UNDECIDED`) |
| Payment source | `HON_BILLING` has no authoritative data yet, so it fails closed (`CHAMPIONS_PAYMENT_SOURCE_UNAVAILABLE`). `HQ_OWNER_ATTESTATION` records the owner's evidence reference, payment count and first-payment time |

A visit or click on a referral code records nothing. Attribution is an explicit HQ act against a provisioned organization, so there is no cookie, URL or form path that can create or qualify a referral.

## API (all under `/v1`)

| Method and path | Authority | Command header |
| --- | --- | --- |
| `GET /schools/:schoolId/champions/summary` | School staff | — |
| `GET /schools/:schoolId/champions/referral-code` | School staff | — |
| `POST /schools/:schoolId/champions/referral-code` (ensures one ACTIVE code) | School staff | `champions-referral-code-issue` |
| `GET /hq/champions/program` | HQ owner or operator | — |
| `POST /hq/champions/policy-drafts` | HQ owner or operator | `champions-policy-draft` |
| `POST /hq/champions/policy-drafts/:policyId/publish` | HQ owner | `champions-policy-publish` |
| `GET /hq/champions/attributions[?state=]` (newest 100) | HQ owner or operator | — |
| `POST /hq/champions/attributions` | HQ owner or operator | `champions-attribution-capture` |
| `POST /hq/champions/attributions/:attributionId/decisions` | REJECT: owner or operator. QUALIFY, REFUND, REVERSE: owner | `champions-attribution-decide` |

Responses are `{ data }`, using the types in `champions-club.ts`. Every command receipt carries `replayed`; repeating a request with the same key and body returns the original result.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_CHAMPIONS_INPUT` | Shape, range or selector invalid |
| 403 | `CHAMPIONS_FORBIDDEN`, `HUMAN_UI_REQUIRED` | No authority, or not a same-origin human command |
| 404 | `CHAMPIONS_UNAVAILABLE` | Unknown code, organization, policy or attribution |
| 409 | `CHAMPIONS_VERSION_CONFLICT`, `CHAMPIONS_TRANSITION_NOT_ALLOWED`, `CHAMPIONS_POLICY_NOT_DRAFT`, `CHAMPIONS_DUPLICATE_ATTRIBUTION`, `IDEMPOTENCY_KEY_REUSED`, `CHAMPIONS_OUTCOME_UNKNOWN` | Retry rules as named |
| 422 | `CHAMPIONS_SELF_REFERRAL`, `CHAMPIONS_ATTRIBUTION_NOT_ELIGIBLE`, `CHAMPIONS_POLICY_UNDECIDED`, `CHAMPIONS_PAYMENT_SOURCE_UNAVAILABLE`, `CHAMPIONS_QUALIFICATION_NOT_MET`, `CHAMPIONS_ATTRIBUTION_EXPIRED` | Business rule refused |
| 503 | `CHAMPIONS_UNAVAILABLE`, `HUMAN_UI_ORIGIN_NOT_CONFIGURED` | Fails closed |

**Privacy:** the school summary returns only counts by state. It never names or identifies referred schools. The leaderboard (Milestone 3) will add opt-in display.

## Evidence

- `pnpm --filter @hon/api test`: `apps/api/test/champions-club.test.cjs`, 7 tests covering contracts, service mapping and redaction, request posture, HTTP routes and headers, and the fixed database path.
- Disposable PostgreSQL: `pnpm db:setup-champions-club` then `pnpm db:test-champions-club` runs the full SQL authority and denial matrix, every transition, replay and key reuse, immutability, no unrelated table effects, and the API service against real database output. This also runs in CI (`.github/scripts/run-db-proofs.sh`).
- `verify-rls.mjs` now tracks 192 tables, including the seven Champions tables, through `champions-club-security.mjs`.

## Not in Milestone 1 (planned)

- **M2:** welcome-credit and milestone entitlement accounting (1–4: $100 each; 5: 6 months total; 10: 12 months total, inclusive of the 6; 20: owner-configured prize; 30: lifetime preserving the plan's AI allowance), substitute rewards for paid-lifetime members, reversal and clawback ledger, liabilities. Recorded as liabilities only; **no credit is applied** until billing integration and owner approval.
- **M3:** leaderboard (all-time, monthly, personal, privacy opt-in, qualified only) and HQ admin reads.
- **M4:** contest engine, kept separate from the permanent program.
- Self-serve signup capture of a code (there is no public signup yet), and the `HON_BILLING` payment source (no HON subscription billing exists yet).

## Owner decisions still open

These block financial activation, not development:

1. Attribution window, refund window, minimum paid days and invoices: the actual values to publish.
2. Payment-verification source until HON billing exists: is HQ owner attestation acceptable?
3. Clawback rules after a reward is issued (refund, chargeback, cancellation inside N days) and reward caps.
4. Founder, annual and paid-lifetime substitute rewards, and rewards between milestones.
5. Prize tax handling, contest legal terms.
6. Whether legacy Essential schools may refer. M1 allows any school with an active entitlement.
