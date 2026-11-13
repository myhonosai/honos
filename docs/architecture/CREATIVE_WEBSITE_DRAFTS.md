# AI website drafts paid from creative credits (WB1, migration 0344)

Status: built (0344), not deployed. Test providers only. No provider is connected in production (`UnconfiguredWebsiteDraftRuntime`), nothing is
published as a site, no card is charged and no program is activated.

## Why

Owner decision 2026-11-12 ([INCLUDED_AI_AND_FAIR_USE.md](../hon/INCLUDED_AI_AND_FAIR_USE.md)): a paid school's AI money is its 12,000 monthly
creative credits. Creative and heavier work (images, video and heavy jobs such as website building) spends them; conversations with the
included AI team never do. Any new heavy generator must reserve through the same CW1 wallet path (0202), which carries the S4 organization
pause and the R2 school pause, at HQ-configurable rates. WB1 is the first heavy job on that path.

## Behaviour

1. **Rates.** The CW1 rate catalog gains a third kind, `WEBSITE`, billed per `PAGE`. The HQ owner publishes it with the existing versioned
   rate command (`POST /v1/hq/saas/creative-credits/rates`), at most 8 pages per request, always `PROVISIONAL` (there is no PAGE cost-evidence
   unit). IMAGE and VIDEO rules are unchanged. The image/video Creative Studio and HQ Creative never offer a website rate.
2. **Request.** Staff of one school (the CW1 school actor) ask for 1..8 pages from a fixed list, in this order: HOME, PROGRAMS, SCHEDULE,
   FREE_TRIAL, INSTRUCTORS, ABOUT, FAQ, CONTACT, plus a brief (1..1000 characters). `POST /v1/schools/:schoolId/creative-studio/website-drafts`
   with `X-HON-Human-Command: saas-creative-website-draft-create` and an Idempotency-Key. The client never names a provider, model, price or
   units: units = pages.
3. **Reserve, call once, record once.** The unchanged CW1 reserve (pause gate, S4 and R2 decisions, eligibility, published rate, balance,
   wallet lock, audit, outbox) reserves pages x rate. Only a WEBSITE rate can fund a draft (`CREATIVE_WEBSITE_RATE_INVALID`). The API makes
   one provider call and records the outcome exactly once, as the requester:
   - SUCCEEDED: only the pages returned are charged (never above the reservation). A result with an unrequested, repeated or out-of-order
     page, or malformed text, is not trusted and is held as UNKNOWN (`UNVERIFIED_RESULT`).
   - FAILED: credits returned; a reported provider cost is recorded, an unreported one stays UNKNOWN (never a guessed zero).
   - NOT_SENT: credits returned with a known zero cost.
   - UNKNOWN: credits held for the HQ owner's existing CW1 resolve.
   A replay with the same key returns the same draft and never calls the provider again; after 120 seconds an unanswered request is held
   for HQ (`INTERRUPTED`).
4. **Accounting.** Provider usage goes to `ai_usage_ledger` as `spend_class = CREATIVE_MEDIA`, modality `TEXT`, customer credits 0. It never
   touches the included AI-team accounting.
5. **Fair use.** One draft in progress per school.
6. **Reads.** `GET .../website-drafts` (newest 50, no page text) and `GET .../website-drafts/:draftId` (with page text for a succeeded draft).
   Exact school only. No provider, model, cost or actor is shown to the school.
7. **Storage.** `creative_website_drafts` and `creative_website_draft_pages` are private (forced RLS, no runtime table access), immutable
   except the single SUBMITTING -> terminal move. Page text is `origin = SYNTHETIC` only in WB1.

## Evidence

- `packages/database/scripts/test-creative-website-drafts.mjs` (WB1..WB11) on a disposable database with the real API services and a synthetic
  runtime. The existing CS1, A1, A2, CW1 and HQ Creative proofs still pass with the widened rate catalog.
- `apps/api/test/creative-website.test.cjs`.

## Not in this change

- The school screen (follow-up, frontend only).
- An HQ rate editor screen (rates are published through the existing API).
- A real website provider, real-text origin, publishing a draft as a live site, or images inside pages. Each needs its own approval.
