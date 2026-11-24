# AI website edits on creative credits (0670)

Owner decisions:
- 2026-11-24 04:23Z, card "Charge AI website building to the school's creative credits?" was answered **Yes**. This applies the 2026-11-12 rule in `docs/hon/INCLUDED_AI_AND_FAIR_USE.md`.
- 2026-11-24 04:51Z: **5 creative credits per edit**.
- 2026-11-24 04:52Z: trial schools spend their own, smaller trial creative allowance. This is the 1,500-credit `TRIAL` lot from 0663.

Nothing here is deployed. The creative program stays INACTIVE and no rate is published until the HQ owner does both.

## Which credits pay

Prepare decides this for each request (`hon.ai_text_creative_applies`). A request pays with **creative credits** when all of these hold:

1. The kind is creative-billed (`hon.ai_text_creative_billing`; today only `WEBSITE_EDIT → website.edit`).
2. A `website.edit` rate (`media_kind WEBSITE`) is published.
3. The creative program is ACTIVE.
4. The school is eligible for creative credits (`saas_creative_eligibility`). That means a verified paid HON OS subscription, or, after 0663, a funded free trial.

If any of these fails, the request is an ordinary included-AI request, byte-for-byte the 0550 path. This covers a school with neither a subscription nor a trial, and every school while HQ has not switched creative credits on. An eligible school that is **out of** creative credits never falls back. Its request is blocked `CREATIVE_CREDITS_EXHAUSTED` with nothing sent.

The school's price read, `GET …/website/ai-edits/price` (`hon.read_school_website_ai_price`), returns one of two answers:
- `CREATIVE_CREDITS` with the per-edit rate and the available credits. This month's included credits count even before their lot is granted.
- `INCLUDED_AI`.

The read needs the same access as asking Marcus. The panel shows "Each message uses N creative credits (M left)" or "Messages use your included AI".

## Lifecycle (creative-paid)

| 0550 status | Creative reservation (CW1) | Included AI credits |
| --- | --- | --- |
| prepare → SENDING | 1 unit RESERVED at the rate, in the same transaction, before any provider call | none reserved, org ceiling not checked |
| prepare refused | none (BLOCKED `CREATIVE_CREDITS_EXHAUSTED` / `AI_SPEND_STOPPED`; `CREATIVE_NOT_ELIGIBLE` / `CREATIVE_NOT_PRICED` only if the facts changed under the lock) | none |
| RESULT_RECORDED | FINALIZED, 1 unit, cost = the 0550 usage row (`usage_id` linked, `cost_reference AI_TEXT_PROPOSAL_USAGE`) | usage row with 0 customer credits |
| RESULT_REJECTED / over-budget FAILED | RELEASED (credits back), cost RECORDED from the usage row | usage row with 0 customer credits |
| FAILED without usage | RELEASED, cost UNKNOWN (HQ may record it later) | none |
| PRE_SEND (back to CONFIGURATION_REQUIRED) | RELEASED at a known zero cost (`NOT_SENT`) | none |
| UNKNOWN (incl. the 90-second SENDING timeout) | OUTCOME_UNKNOWN, credits held | none |

**One creative-paid edit in flight per school.** A creative-paid proposal holds no included credits, so the school AI cost limit, which counts only `reserved_credits > 0` holds, cannot see it while it runs. The reserve therefore refuses a second one while the school already has a RESERVED website reservation (`CREATIVE_EDIT_IN_PROGRESS`, nothing sent). The cost the limit cannot see is at most one request, $0.15 under the kind's cap. An OUTCOME_UNKNOWN reservation does not block. If the API dies after prepare, the edit stays SENDING. The next creative-paid prepare at that school, before it takes the wallet lock, moves any such edit older than 90 seconds to UNKNOWN (`FOR UPDATE SKIP LOCKED`). The settle trigger then moves its reservation to OUTCOME_UNKNOWN for the HQ CW1 queue, so it stops blocking. Proof W15 covers this.

The dollar cost is recorded once, in the 0550 `AGENT_INFERENCE` usage row. The school AI cost limit and HQ usage still see it, and CW1 settlement writes no second usage row.

**UNKNOWN goes to one queue: CW1.** The HQ owner resolves it with the existing creative reservation resolution (`resolve_saas_creative_reservation_from_hq`). The S4 unknown queue lists only included-credit holds (`reserved_credits > 0`), and a creative-paid proposal holds none, so the same decision never appears in two queues. HQ Creative Credits labels the reservation "Website AI edit". A "charged" CW1 resolution records its cost as CREATIVE_MEDIA usage, as CW1 does for every creative reservation. That cost counts against HON's creative spend, not the school's AI-team cost limit, which is accepted because it only follows an UNKNOWN outcome that the HQ owner decides by hand.

## Custody

- `hon.ai_text_creative_billing` and `hon.ai_text_creative_reservations` are immutable, deny-all, with forced RLS, and the runtime has no privilege on them.
- The reserve, settle and applies helpers are private. The runtime gains exactly one function: the price read.
- A trigger (`website_creative_reservation_guard`) refuses any `WEBSITE` reservation insert, and any provider settle of one, unless it comes from this path, marked by a transaction-local setting. The public CW1 reserve and settle therefore refuse `website.edit`. HQ resolution and late-cost recording keep working, recorded as TEXT modality with spend class CREATIVE_MEDIA.
- Rate rule: `WEBSITE` is billed per `REQUEST`, `max_units_per_request = 1`, PROVISIONAL only. It is enforced by a table CHECK, by `publish_saas_creative_rates`, and by the contracts.
- Both Creative Studio screens (school and HQ) filter out the website rate, so it is never offered as an image or video generation.

## Lock order

The order is `ai.budget` (0194) → the proposal row → the creative pause gate → the school wallet. No path that holds a wallet lock takes `ai.budget`: CW1 reserve, settle, resolve and Creative Studio never call it. Proof W12 races website edits against image reservations on one wallet and checks for no deadlock and no overspend.

## Evidence

- `packages/database/scripts/test-website-ai-creative-credits.mjs`: 15 checks on the Champions fixture with simulated payments and a counted fake provider.
- `test-website-ai-edits.mjs` (WB5): unchanged behavior on included AI.
- AI-0 inventory: adds the reserve and settle helpers and two triggers.
- 011: an exact verification block.

## After deploy (owner)

- The HQ owner publishes the `website.edit` rate at 5 credits (Creative Credits → rates) and activates the creative program when ready.
- Until both happen, website edits keep using included AI.
