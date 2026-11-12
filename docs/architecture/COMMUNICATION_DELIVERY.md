# Communication delivery: receipts, email, texting and lead intake

Status: spec and plan for the NEW-COMMS build (`/mnt/project-files/endzone/COMMUNICATIONS_PLAN.md` §5), 2026-11-09.
Nothing here creates a provider account, number, registration or real message. Every provider path is
INACTIVE until David approves live sending.

## 1. Goal

A human-queued message (0047) actually reaches the person through a provider, with a durable record of
what happened: accepted, delivered, bounced, failed, unknown. Opt-outs from the recipient (unsubscribe,
spam report, STOP reply) stop further messages automatically. Leads from Meta/Google arrive in the CRM
through signed webhooks. All of it is testable with deterministic fakes.

## 2. What already exists (reused, not duplicated)

| Piece | Where | Kept as is |
|---|---|---|
| Consent per person and channel | 0046, `communication-consent.service.ts`, People page (#194) | The only gate. Queue and send both require `OPTED_IN`. |
| Message drafts and human queueing | 0047, `communication-message.service.ts` | DRAFT → QUEUED stays a human command. Delivery starts only after QUEUED. |
| Outbox lease semantics | 0021/0029, `OUTBOX_DELIVERY_WORKER.md` | Copied: a lost lease or late result is UNKNOWN, never success, never retried automatically. |
| A2P 10DLC preparation | 0190, #81/#83 | Registration facts per school; the Twilio adapter needs a registered sender before SMS is READY. |
| Zernio HQ credential check | `apps/api/src/integrations/zernio-*` | Lead intake builds next to it. |
| INACTIVE switch pattern | `OPENROUTER_PAID_CALL_APPROVED` | Same shape: key present AND `*_SEND_APPROVED=true`. |

## 3. Pieces and pull requests

| PR | Piece | Migration |
|---|---|---|
| 1 | Delivery records, provider receipts, recipient opt-out, worker role, dispatcher with a deterministic fake provider, school delivery read | 0243 |
| 2 | Twilio SendGrid email adapter (sandbox mode) and signed Event Webhook | none planned |
| 3 | Twilio Messaging adapter: piece counter, MMS for long texts, status callbacks, STOP/START/HELP, school sending numbers | 0248 |
| 4 | Missed-call text-back | 0249 |
| 5 | Zernio per-school lead intake (signed webhook → CRM lead with source) | 0250 |

## 4. PR 1 design (0243)

### 4.1 Records

`hon.communication_deliveries`: one row per QUEUED message, created by the dispatcher claim.

- `status`: `PENDING` (waiting: schedule, quiet hours, inactive school, no ready provider),
  `SENDING` (leased to one worker), `ACCEPTED` (provider took it), `DELIVERED`, `BOUNCED`,
  `FAILED` (permanent or retries exhausted), `SUPPRESSED` (no consent or no address at send time),
  `UNKNOWN` (lease expired or provider answer lost; never retried automatically).
- `hold_reason` while PENDING: `SCHEDULED`, `QUIET_HOURS`, `SCHOOL_INACTIVE`, `RETRY_WAIT`.
- `provider` (`FAKE`, `SENDGRID`, `TWILIO`), `provider_message_id` (unique per provider), `sent_as`
  (`EMAIL`, `SMS`, `MMS`), `segments`, `encoding` (`GSM7`, `UCS2`), `provider_cost_microunits`
  (measured usage per school so whoever pays for texting, Decision 4, can be billed from facts).
- `failure_code` from a closed list. No raw provider error text, no address, no message body copy.

`hon.communication_delivery_events`: append-only provider receipts. `(provider, provider_event_id)` is
unique, so a redelivered webhook is a replay. Event types: `SENT`, `DELIVERED`, `DEFERRED`, `BOUNCED`,
`DROPPED`, `UNDELIVERED`, `FAILED`, `UNSUBSCRIBED`, `SPAM_REPORT`. Opens and clicks are not stored.

Both tables: forced RLS on organization + school; school staff read through `hon_runtime` SELECT only.

### 4.2 Who can write

A new login `hon_communication_worker` (infra `013_supabase_hon_communication_worker.sql`), like
`hon_outbox_worker`: no superuser, no BYPASSRLS, no inheritance, no table privileges. It may only run:

1. `hon.claim_communication_deliveries(channels, limit, lease_seconds)` — reconciles expired leases to
   UNKNOWN, creates PENDING rows for due QUEUED messages, re-checks school/organization ACTIVE, current
   consent and address, applies SMS quiet hours (21:00–08:00 school time), then leases. It returns the
   address and body only for leased rows, in memory, for the one send.
2. `hon.record_communication_send_result(delivery, lease, outcome, ...)` — `ACCEPTED`, `RETRYABLE`
   (backoff, at most 5 attempts), `FAILED`, `UNKNOWN`. A stale lease returns `accepted=false` and UNKNOWN.
3. `hon.record_communication_provider_event(provider, event_id, provider_message_id, hon_delivery_id,
   event_type, occurred_at, cost)` — idempotent; status only moves forward (a late `DELIVERED` resolves an
   UNKNOWN; a late `DEFERRED` never undoes `DELIVERED`). `UNSUBSCRIBED`/`SPAM_REPORT` record the
   person's consent for that channel as `OPTED_OUT` with source `RECIPIENT`.

`hon_runtime` gets no EXECUTE on these. Every transition writes `hon.audit_events` (actor: the fixed
INTEGRATION principal "HON communication delivery") and one outbox event.

### 4.3 Dispatcher (API)

- `CommunicationProviderAdapter`: `channel`, `provider`, `readiness()`, `send(request)`. Errors carry
  `RETRYABLE`, `FAILED` or `UNKNOWN` and a closed code. A timeout is `UNKNOWN`.
- `CommunicationDispatcher.runOnce(limit)`: claims only channels whose adapter is READY, sends outside
  any database transaction, records each result. Never claims PUSH.
- Fake provider (`FAKE`): deterministic, READY only when `HON_COMMUNICATION_FAKE_PROVIDER=1` and the
  deployment is not production. The production configuration check refuses it.
- The interval loop runs only when `HON_COMMUNICATION_WORKER_DATABASE_URL` and
  `HON_COMMUNICATION_DISPATCH_INTERVAL_SECONDS` are both set. Default: off.

### 4.4 School read

`GET /v1/organizations/:org/schools/:school/communications/messages/:id/delivery` with
`communication.message.read`: status, hold reason, sent-as, pieces, failure code, timestamps and the
receipt timeline. No address, no provider IDs, no cost.

## 5. Later pieces (summary; each gets its own section before build)

- **Email (PR 2):** SendGrid v3 mail send with `sandbox_mode` on unless `HON_EMAIL_SANDBOX_MODE=false`;
  READY only with `SENDGRID_API_KEY`, `HON_EMAIL_FROM` and `HON_EMAIL_SEND_APPROVED=true`. `custom_args`
  carry the HON delivery ID, plus `hon_purpose` (`INTERNAL` for staff notices such as the 0257 weekly
  briefing, `HQ` for HQ messages) when the mail is not a school delivery. The Event Webhook is account-wide,
  so events with any `hon_purpose` other than `SCHOOL` are acknowledged and ignored here (an HQ receipt
  handler can claim `HQ` later); otherwise they would find no delivery and make SendGrid retry. Event
  Webhook verified with ECDSA P-256 over timestamp + raw body, a 10-minute window, raw-body transport
  like Stripe's.
- **Texting (PR 3):** shared `countTextPieces(text)` in contracts (GSM-7 vs UCS-2, 160/153 and 70/67),
  used by the composer and the adapter. Three or more pieces send as one MMS (cheaper than three SMS
  pieces at list price). Twilio request signature (HMAC-SHA1) on status callbacks and inbound messages;
  STOP/UNSUBSCRIBE/CANCEL/END/QUIT → OPTED_OUT, START/UNSTOP → only re-opens a person who opted out by
  text, HELP → fixed reply. READY needs the school's registered sender (A2P) plus `HON_SMS_SEND_APPROVED`.
- **Missed-call text-back (PR 4):** a signed Twilio call-status webhook for a school number with
  `no-answer`/`busy` queues one reply per caller per day with consent wording; never to opted-out numbers.
- **Zernio leads (PR 5):** signed webhook per installation, routed only through a verified school
  connection and form mapping (Phase 2A design), creating a CRM lead with source `ZERNIO_META` or
  `ZERNIO_GOOGLE` through the existing lead-create path. Unknown or ambiguous routing is rejected.

## 5a. Texting as built (0248)

- `hon.school_text_senders`: one Twilio Messaging Service + number per school, set or disabled only by a human
  HON HQ owner (`POST /v1/hq/saas/schools/:schoolId/text-sender`, same human-command guard as other HQ
  commands). Recording a number buys nothing. A text from a school without an ACTIVE sender waits as
  `SENDER_NOT_READY`; the claim returns the sender's service SID for the send.
- v1 uses one HON Twilio account (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`); per-school subaccounts are a
  later step because callback signatures are per account. READY also needs an https `HON_PUBLIC_API_ORIGIN`
  (status callback URL) and `HON_SMS_SEND_APPROVED=true`.
- The Messaging Service must have the MMS converter and Smart Encoding on. HON never changes a Twilio service, so
  the HQ owner must send `mmsConverterConfirmed: true` to make a sender ACTIVE (API 400
  `MMS_CONVERTER_NOT_CONFIRMED`; the table also refuses ACTIVE without it). HON smart-encodes the body itself,
  records predicted sent-as (3+ pieces → MMS) and Twilio's reported piece count, and refuses over 1,600 characters.
- `POST /v1/communications/webhooks/twilio/status` and `/twilio/inbound`: form posts verified with
  X-Twilio-Signature over `HON_PUBLIC_API_ORIGIN` + fixed path + sorted parameters, and the AccountSid must match.
  Inbound is routed only by the receiving ACTIVE number to one school; only exact STOP/START/HELP words are
  stored (`hon.inbound_text_keywords`, without the sender's number). START re-opens only an opt-out the person
  made themselves (source RECIPIENT). Replies come from Twilio Advanced Opt-Out; HON answers empty TwiML.

## 5b. Missed-call text-back as built (0249)

- The HQ owner sets, per school sender, a forwarding phone (the school's own line) and a text-back switch
  (`POST /v1/hq/saas/schools/:schoolId/missed-call-settings`, human-command guard, version-checked, audited). Off by default.
- `POST /v1/communications/webhooks/twilio/voice` (signed like the other Twilio webhooks): a call to an ACTIVE school
  number rings the forwarding phone for 20 seconds with a fixed `voice-result` action URL; with no forwarding phone the
  call is recorded as missed and HON hangs up; any other number is rejected. A withheld caller ID is never texted.
- `POST /v1/communications/webhooks/twilio/voice-result`: `no-answer`, `busy`, `failed` or `canceled` records one row in
  `hon.missed_calls` (unique Twilio CallSid, so a redelivered callback is a replay).
- Text-back: at most one per caller per school per 24 hours (an UNKNOWN reply counts as sent), never to a number the
  school holds as SMS `OPTED_OUT` (checked when recorded and again before sending), only while the switch and sender are
  ACTIVE and the school and organization are ACTIVE, and only 08:00-21:00 school time. Leases, three attempts with
  backoff, and expired leases as UNKNOWN follow the 0243 rules. The reply is one fixed message in the school's default
  language (en/ko/es) naming the school and ending with STOP wording; it goes through the same Twilio adapter and
  `HON_SMS_SEND_APPROVED` switch as other texts, without a status callback.
- School staff read their recent missed calls to call back with `communication.message.read`
  (`GET /v1/organizations/:org/schools/:school/communications/missed-calls`): caller, dial outcome, text-back state, time.
  The list is a definer read (`hon.read_school_missed_calls(subject, school, limit)`) that also requires the
  organization's entitlement to be ACTIVE and in effect, so staff at a suspended, lapsed or not-yet-started school read
  nothing (403); the runtime has no direct access to `hon.missed_calls`.
- `canceled` (the caller hung up before the forwarding phone answered) counts as missed and gets a text-back, the same as
  `no-answer` and `busy`.
- A STOP texted from a number the school has no person record for is not stored in HON (0248 keywords need a school
  number match and record against the school's people). Blocking further texts to that number relies on Twilio's own
  opt-out handling on the Messaging Service (Advanced Opt-Out or the default STOP list), which must stay on; this is on
  the pre-launch review list.

## 6. Who pays for texting (open, Decision 4)

Nothing here charges anyone. Every delivery records provider, pieces, sent-as and measured provider cost
per school, so any of the options (included allowance, pass-through, credits) is a billing read over
these rows, not a change to sending.

## 7. Tests (TDD)

- DB proof `test-communication-delivery-integrity.mjs`: claim/lease/record, quiet hours, consent revoked
  after queue, missing address, inactive school, retry backoff and exhaustion, lease expiry → UNKNOWN,
  late result refused, provider event replay and forward-only status, unsubscribe → OPTED_OUT, RLS
  isolation between two schools, runtime cannot call worker functions, worker cannot read tables.
- API unit tests: dispatcher with fake adapters (READY gating, error mapping, timeout → UNKNOWN), fake
  provider production refusal, delivery read authorization.
