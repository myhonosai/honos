# HQ "Buy a number" (HQ-NUM) — spec

Owner ask (David, 2026-11-28): HQ needs its own texting number and a button in HQ that buys it, instead of setting it
up by hand in the Twilio console. Extends [HQ_COMMUNICATIONS.md](HQ_COMMUNICATIONS.md) §3 (HQ sender) and reuses the
school number pieces in [SCHOOL_OWN_SENDERS.md](SCHOOL_OWN_SENDERS.md) §4 (T2).

## 1. What the HQ owner sees

HQ > Communications > Settings > Texting sender gets a **Buy a number** panel next to the existing "paste a Messaging
Service ID" form:

1. Search by area code, or city + state. Up to 20 US local numbers that can text, picture-text (MMS) and take calls,
   each with Twilio's **current monthly price** read live from Twilio's pricing API (never a hard-coded figure).
2. Pick one. A confirm step repeats the number and the monthly price and says "This is billed to HON's Twilio account
   every month until the number is released." Only then does **Buy this number** submit.
3. Status line: Buying… / Bought, setting up texting service… / Ready — waiting for A2P registration / Failed (reason,
   with "Try again" or "Check with Twilio" for an unknown outcome).
4. When done, the HQ SMS sender is filled in automatically: Messaging Service ID, reply number, MMS Converter on,
   A2P state `NOT_REGISTERED`. Live texting still needs `HON_SMS_SEND_APPROVED` (unchanged) and A2P approval.

When the provisioning switch is off the panel says "Buying numbers from HQ is switched off" and offers only the
existing paste form. Nothing is searched or bought.

## 2. Rules

- **Who:** only the HQ owner (`HON_HQ_OWNER`), by human command (same guard as setting the HQ sender). Never an AI
  action, never a school role, never from URL/query values.
- **Off switch:** reuses `HON_TWILIO_PROVISIONING_APPROVED=true` plus parent `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`.
  Default off. Turning it on in production is an owner decision (paid).
- **Account:** HQ's number lives on **HON's parent Twilio account** (not a school subaccount). HQ is HON itself.
- **One at a time:** at most one open HQ number order. A second Buy while one is open is refused.
- **Idempotent, no second buy:** the buy request carries an idempotency key; a replay returns the same order. The API
  does the Twilio steps in the request, reading before every create (number by phone on HON's account, service by
  friendly name `hon-hq`, number-in-service). If an answer is lost, the order stays `BUYING` and the owner presses
  **Finish setup**, which re-runs the same read-before-create steps. No worker, no lease.
- **When an order fails:** `FAILED` is recorded only when Twilio definitely refused before HON holds the number (e.g.
  number gone). Anything after the number is held keeps the order `BUYING` for Finish setup, so a bought number is never
  forgotten.
- **Price shown = price recorded:** the browser sends the monthly price it showed; the API re-quotes the number from
  Twilio and refuses with `PRICE_CHANGED` (nothing ordered) if the price rose; the order keeps the API's quote.
- **Messaging Service settings:** `MmsConverter=true`, `SmartEncoding=true`, `StickySender=true`,
  `UseInboundWebhookOnNumber=false`, inbound + status webhooks = HON's existing `/v1/twilio/...` paths (inbound is
  matched by the service SID, which is already how HQ inbound works).
- **Sender auto-set:** `READY` makes the HQ SMS sender in the same transaction. No order starts while an ACTIVE SMS
  sender exists (retire it first), and `READY` is refused if one was set by hand meanwhile (order stays `BUYING`).
- **Audit:** orders are the record: who asked, which number, the price, SIDs and times; never deleted, and only
  `BUYING` changes, once, to `READY` or `FAILED`.
- **Not in scope:** A2P brand/campaign submission from HQ (owner does it in Twilio console or a later piece reusing
  T3), releasing numbers, more than one HQ number, non-US numbers.

## 3. Data (migration 0704, coordinator-allocated)

`hon.hq_number_orders`: id, phone_e164 (NANP), locality, region, monthly_price_microunits, status (`BUYING`, `READY`,
`FAILED`), number_sid (`PN…`), service_sid (`MG…`), failure_code, sender_id, idempotency_key (unique) + fingerprint,
requested_by/at, finished_by/at, version. Partial unique index: one `BUYING` row. Guard trigger: no delete/truncate,
only `BUYING` → `READY|FAILED` keeping the request fields. Forced RLS, no policies, no table grants. SECURITY DEFINER
functions (HQ owner, proved again before returning): `start_hq_number_order`, `finish_hq_number_order`,
`read_hq_number_orders`. 010 grant block, 011 exact verification, `verify-rls.mjs` entry.

## 4. API

- `GET  /v1/hq/communications/number-orders` → orders + `hasActiveSmsSender` + `provisioning: READY|SWITCHED_OFF`
- `GET  /v1/hq/communications/number-search?areaCode=…` or `?city=…&region=…` → up to 20 numbers with price
- `POST /v1/hq/communications/number-orders` `{ phoneE164, monthlyPriceMicrounits }` + `Idempotency-Key` (marker `hq-number-order-buy`)
- `POST /v1/hq/communications/number-orders/:id/finish` `{}` (marker `hq-number-order-finish`)
All HQ owner only (database), SaaS read/command guards. `HqNumberService` reuses `TwilioRestNumberClient` with the
parent credential; voice URL = HQ calling voice webhook; service inbound = the Twilio inbound webhook, status = HQ status.

## 5. Tests

Contracts (validators), API unit (guard, switch-off makes zero Twilio calls, lost-response paths with
`FakeTwilioNumberClient`, price-changed, existing-sender path), DB proof (RLS, one-open-order, idempotency, lease,
settle), web (panel states incl. switched-off, confirm shows price). No real Twilio calls in CI.

## 6. Owner decisions

- Turning on `HON_TWILIO_PROVISIONING_APPROVED` in production (paid: ~$1.15/mo per number at Twilio's current price).
- A2P 10DLC fees for HON's own brand/campaign (one-time brand + vetting, monthly campaign) — paid in Twilio.
- Live HQ texting (`HON_SMS_SEND_APPROVED`) — unchanged, separate OK.
