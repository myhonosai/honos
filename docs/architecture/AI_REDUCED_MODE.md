# Reduced-AI mode, part 1: automatic fallback when a model is down (migration 0336, RA-1)

Plan step 5 (B-AI-4, "graceful when provider down"). This covers HON and the analysis specialists that answer through
HON's reply table: Claire, Alex, Jordan, Lena and Maya. Marcus, Chad and Kai keep their current behaviour and follow in a
later slice. Only stand-in providers are used; nothing here activates a real provider.

## Before

- HQ could already reroute by hand. The planner uses only `HEALTHY` providers and active catalog models, so HQ could mark a
  model inactive and the next plan would take the task profile's fallback.
- A call to a model that was down failed the turn. The runtime gave `PROVIDER_REJECTED` for 404 and 429, and `UNKNOWN` for
  every 5xx. Staff saw "the AI provider declined to answer, try rephrasing". When no route was left, they saw a generic
  "could not answer (no eligible route)".

## After

1. **Definite unavailability.** The runtime gives `FAILED` / `PROVIDER_UNAVAILABLE` for three cases:
   - HTTP 404 (model not available)
   - HTTP 429 (rate limited)
   - HTTP 503, but only when it carries OpenRouter's own JSON error body with code 503 ("no available model provider")

   Each is a refusal before any generation: the hold is released and nothing is recorded as spent. 502, 504, any other
   503, timeouts and network errors stay `UNKNOWN` and are never resent. 401, 402 and 403 are account problems, so a
   different model on the same key would not help; with 400 and 422 they stay `PROVIDER_REJECTED`.
2. **One automatic fallback.** After a `PROVIDER_UNAVAILABLE` failure, the service calls
   `hon.reopen_hon_reply_for_fallback(subject, turn)`. That reopens the reply only when all of these hold:
   - the reply is this human's own
   - it is `FAILED` as `PROVIDER_UNAVAILABLE`
   - nothing is held or recorded for it
   - it has not fallen back before
   - its plan was the task profile's `DEFAULT`
   - that profile, at the planned version, has `retryCategory = TRANSIENT_ONCE` (an existing HQ setting, 0113)

   When it reopens:
   - It records the failed attempt in `hon.ai_route_unavailable_attempts`: the plan, the catalog model and the failed
     provider request id. The table is immutable, holds at most one row per reply, has forced RLS and is not reachable by
     the runtime.
   - The reply goes back to `PENDING` with a new provider request id. The work item goes back to `READY` with a new
     version.
   - The next plan uses the attempt id as its idempotency key (`planKey` from `hon_reply_planning_reference`), so it never
     replays the failed plan.
   - The planner never picks that catalog model again for that work item, so it takes the profile's first eligible
     `FALLBACK`. If no fallback is eligible, the result is no route.
   - The second attempt is planned and prepared live, like the first: access decision, budget lock, HQ pauses, school
     ceilings and source permissions all apply again.
   - A turn makes at most two provider calls. A second failure is final.
   - 0342: if HQ deactivates the task profile between the attempts, the second plan uses the legacy policy order, and
     that order also skips the model that just failed. The failed model is never called twice for one turn.
3. **Honest message.** `PROVIDER_UNAVAILABLE` and `NO_ELIGIBLE_ROUTE` show: "HON's AI is temporarily unavailable.
   Everything else in HON OS keeps working. Nothing is charged. Try again in a few minutes."

## Unchanged

- `UNKNOWN` handling and HQ resolution.
- Per-call ceilings and reply budgets, the budget lock, access decisions, pauses, R2 ceilings, the creative wallet.
- HQ HON keeps mapping a `FAILED` call to `PROVIDER_REJECTED`.

## Risk

The 503 rule trusts OpenRouter's documented error body. Its 503 means no provider was available to run the request. A
503 without that exact body stays `UNKNOWN`.

## Tests

- **AI-0 INV-41:**
  - default unavailable → one fallback call on the backup model, the turn completes, one ledger row, the attempt recorded
    once, a new provider request id, and a resend never calls again
  - both models unavailable → exactly two calls, then `FAILED` / `PROVIDER_UNAVAILABLE` with nothing held, and no second
    reopen
  - a backup made inactive between the attempts → no route and no second call
  - an HQ pause between the attempts → blocked, with no reservation and no call
  - no fallback for retry `NONE`, for `UNKNOWN`, for `PROVIDER_REJECTED` or on the legacy policy order
  - the evidence table is immutable, has forced RLS and is not reachable by the runtime, and the runtime can execute only
    the reopen function
- **API runtime test:** the 404, 429 and OpenRouter-503 mapping, and every other 503, 502 and 504 staying `UNKNOWN`.
