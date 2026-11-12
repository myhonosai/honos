# HQ texting and email (HQ-COMM)

Status: spec, 2026-11-11. Owner ask (David, 2026-11-11): "i need text and email systems on hq as well", plus long texts
working the way Twilio's Messaging Service "MMS Converter" fixes them. Nothing here creates a provider account, number,
registration or real message. Every provider path stays INACTIVE until David approves live sending.

## 1. Where long texts stand

- School texting is built by the "Connect email, texting and Zernio leads" thread (spec
  `docs/architecture/COMMUNICATION_DELIVERY.md`, PR #223 then SendGrid, 0248, 0249, 0250). Its Twilio adapter posts
  `To` + `MessagingServiceSid` + `Body` (never `From`), so Twilio's MMS Converter applies. A shared
  `countTextPieces(text)` (GSM-7 160/153, UCS-2 70/67) drives the composer warning and records `sent_as` `MMS` at 3+
  pieces. Nothing in HON truncates a message: the queue allows 1 to 4,000 characters (0047). Twilio's MMS limit is
  1,600 characters, so a text over 1,600 is refused before queueing (§4.4).
- What "the CRM has to allow it" means for HON: send through a Messaging Service, not a bare number, and have MMS
  Converter switched on for that service. The Messaging Services API exposes `MmsConverter`, so when live provisioning
  is approved, HON sets it on every service it creates (school and HQ) and the HQ sender record (§3) will not become
  READY until an HQ owner confirms it is on.
- HQ texting must use the same rule. That is what this spec adds.

## 2. Goal and scope

HQ (HON the company) can email and text the people who run a school: its owners and, later, staff, about support,
billing, onboarding and account matters. A human HQ person writes and sends each message. The same lease, receipt,
opt-out and quiet-hours rules as school messaging apply. HQ never sees the recipient's address: it picks "this school's
owners", and only the delivery worker reads the address, in memory, for one send.

In v1:

- Recipients: the live owners of one school (non-HQ owner grants, as counted by 0225), and HON prospects (§4.8,
  owner decision 2026-11-11 22:14Z). School staff come later.
- Channels: EMAIL to the owner's account email; SMS to a phone the owner added and confirmed themselves (§4.3).
- Purposes: `SUPPORT`, `BILLING`, `ONBOARDING`, `ACCOUNT`. Each needs the matching HQ permission (§4.2).
- Owner messages: one school per message. Prospect messages: one prospect, or one HQ marketing campaign audience with
  an HQ owner's approval of that send (§4.8).

Not in v1: messages to families, leads or students (those are the school's own messages),
inbound replies routed to HQ support (STOP/START/HELP are handled), attachments or pictures.

## 3. HQ sender

`hon.hq_communication_senders`: at most one ACTIVE row per channel.

- EMAIL: from address and display name ("HON OS"), the SendGrid domain-authentication state as HQ recorded it.
- SMS: the HQ Twilio Messaging Service SID (`^MG[0-9a-f]{32}$`), the A2P campaign state as HQ recorded it, and
  `mms_converter_confirmed` (true required for READY).
- Only the HQ owner (`HON_HQ_OWNER`) sets or retires a sender, by human command, with audit and outbox rows.
- A channel is READY only when its sender is ACTIVE and the provider switch is on (`HON_EMAIL_SEND_APPROVED`,
  `HON_SMS_SEND_APPROVED`, same as schools). Otherwise HQ can draft and queue, and the delivery waits with
  `NO_PROVIDER`.

## 4. Design

### 4.1 Records (migration 0281)

- `hon.hq_messages`: organization, school, purpose, channel, content (1 to 4,000; SMS 1 to 1,600), optional support
  case link (0232, must be the same organization/school), status `DRAFT` / `QUEUED` / `CANCELLED`, created by,
  version.
- `hon.hq_message_deliveries`: one row per (message, recipient principal), created at queue time from the school's live
  owners. Same states as 0243 (`PENDING`, `SENDING`, `ACCEPTED`, `DELIVERED`, `BOUNCED`, `FAILED`, `SUPPRESSED`,
  `UNKNOWN`), hold reasons, lease columns, provider ids, `sent_as`, `segments`, `encoding`, measured cost. No address
  or body copy.
- `hon.hq_message_delivery_events`: append-only receipts, unique on (provider, provider_event_id).
- `hon.hq_contact_channels`: per user, the SMS phone (E.164) they added, when it was confirmed, and their HQ texting
  opt-in. Email is the account email (`hon.users.email`), not copied.
- Forced RLS on all tables; runtime has no table privileges; everything goes through SECURITY DEFINER functions.
  History rows cannot be changed or deleted. Grants are mirrored in `infra/postgres/010_supabase_hon_runtime.sql`.

### 4.2 Who can do what

| Action | Who |
| --- | --- |
| Draft, queue, cancel, read | HQ owner, or HQ operator/support with the purpose permission: `SUPPORT` → `hq.support.manage`, `BILLING` → `hq.billing.manage`, `ONBOARDING` → `hq.onboarding.manage`, `ACCOUNT` → `hq.support.manage` |
| Set or retire the HQ sender | HQ owner only |
| Claim, record send result, record receipt | `hon_communication_worker` only (EXECUTE on fixed functions, no table access) |
| Add/confirm own phone, opt in/out of HQ texts | the user themselves |

Authority is checked before and after every read and command (0206 rule). Commands use the SaaS command guard (same
origin, `X-HON-Human-Command`, JSON, `Idempotency-Key`). An AI agent can draft text for a human but never queues.

### 4.3 Consent

- EMAIL: account and service email to a school owner's account address is allowed. Each email carries a one-click
  "stop HQ emails" link that records a per-user email opt-out; `BILLING` and `ACCOUNT` notices that the owner must
  receive are marked as such and still go (owner decision, §7).
- SMS: only to a phone the user added and confirmed with a code, with HQ texting switched on by them. STOP from that
  phone to the HQ number turns it off (source `RECIPIENT`); START turns it back on; HELP gets a fixed reply. Quiet hours
  are 21:00 to 08:00 in the school's time zone, as for schools.
- Checked again at claim time, so a change after queueing still stops the send (`SUPPRESSED`).

### 4.4 Text length

- The composer shows the live piece count from `countTextPieces` and "will send as one picture message (MMS)" at 3+
  pieces. Korean, emoji and accented Spanish switch to UCS-2 (70 per piece).
- Over 1,600 characters, SMS is refused with `TEXT_TOO_LONG` and the composer suggests email.
- Nothing is cut short anywhere. The adapter sends the whole body; Twilio converts.

### 4.5 Delivery

The comms thread's provider adapters (`CommunicationProviderAdapter.send`) are reused; a small HQ dispatcher
(`apps/api/src/hq-communications/hq-message-dispatcher.ts`, same lease, timeout and UNKNOWN rules as the school one)
claims HQ deliveries through separate HQ claim/record functions and hands the adapter `origin: 'HQ'` plus the HQ
sender's `senderServiceId` (texts) or `senderEmail` (email). A real adapter is used for HQ only once it declares
`hqSender: true`, meaning it honors those fields; until then HQ deliveries on that channel are never claimed, so an HQ
message can never go out from a school's sender. Texts also need the person's own HQ texting opt-in (recorded by 0282
after they confirm their phone); in 0281 alone every HQ text is held back as CONSENT_MISSING. Receipts: SendGrid HQ emails
carry the internal-purpose `custom_arg` marking them HQ, and the Twilio status callback for HQ sends uses its own path,
so the webhook handlers look up `hq_message_deliveries` instead of school deliveries. The comms thread fits the
webhook side.

### 4.6 API

- `GET /v1/hq/communications/senders`, `POST /v1/hq/communications/senders` (HQ owner).
- `GET /v1/hq/communications/messages?schoolId&cursor&limit`, `GET …/messages/:id` (status, pieces, sent-as,
  per-recipient delivery state; never the address).
- `POST /v1/hq/communications/messages` (draft), `…/:id/queue`, `…/:id/cancel`.
- School app: `GET/POST /v1/me/hq-contact` (own phone, confirm code, HQ texting on/off).

### 4.7 Screens

- HQ school detail and HQ support case: "Message the owners" with channel, purpose, the piece counter and the delivery
  timeline. No address is shown.
- `/hq/communications`: sender status per channel (Not set up / Waiting for approval / Ready) and recent HQ messages.
- School app account page: "Texts from HON" phone, code and switch.
- English, Korean and Spanish.

### 4.8 HON prospects (owner decision: in v1)

HON's own prospects: people who signed up, started a trial or asked about HON OS, not schools' leads.

- `hon.hq_prospects`: name, school name, email, phone (E.164), source (`PUBLIC_SIGN_UP`, `TRIAL`, `HQ_ENTERED`,
  `IMPORT`, `INBOUND_TEXT`), optional HQ marketing campaign (0252), status, created by/at, version. HQ marketing
  people (`hq.marketing.manage`) can add and read prospects; their address is shown to them, unlike owners'.
- `hon.hq_prospect_consents`: per prospect and channel, append-only: `OPTED_IN` / `OPTED_OUT`, purpose
  (`SERVICE`, `MARKETING`), source (`SIGN_UP_FORM`, `HQ_RECORDED`, `RECIPIENT`), the exact disclosure text version
  shown, and when. Current state is the latest row.
- Marketing texts need `MARKETING` `OPTED_IN` from the prospect themselves (sign-up checkbox with the disclosure, or
  texting in). HQ cannot record SMS marketing consent on someone's behalf. Marketing emails need an opt-in or an
  existing inquiry, and always carry an unsubscribe link and HON's postal address (CAN-SPAM).
- Campaign sends: an HQ marketing person drafts a message for a 0252 campaign audience; the HQ owner approves that
  exact message and audience count before anything is queued. The audience is re-checked against consent at claim
  time. At most one approved bulk send per campaign per day.
- Marketing SMS needs the HQ sender's A2P campaign registered for marketing use; until HQ records that, marketing
  texts wait with `NO_PROVIDER` and only service texts can go.
- Public sign-up (0241, 0247) feeds prospects when it lands; until then prospects are HQ-entered or imported.

## 5. Pieces and pull requests

| PR | Piece | Migration |
| --- | --- | --- |
| A | HQ sender, messages, deliveries, receipts, owner recipients, email consent, worker functions, API, fake provider proof | 0281 |
| B | HQ screens: Message the owners (school detail + support case), `/hq/communications` | none |
| C | Own phone + code confirmation + HQ texting switch (school app), STOP/START/HELP on the HQ number | 0282 |
| D | Webhook routing for HQ receipts (comms thread) | none planned |
| E | HON prospects, prospect consent, campaign sends with HQ owner approval, prospect screens | 0283 |

A waits for #223 (0243) and SendGrid to be on main, because it reuses the worker role, dispatcher and adapter.

## 6. Proof

- DB proof `test-hq-communications.mjs`: role boundaries, permission per purpose, HQ never reads addresses, only live
  owners become recipients, consent and quiet hours re-checked at claim, lease expiry → UNKNOWN, receipt replay,
  forward-only status, SMS over 1,600 refused, cross-school isolation, worker cannot touch school deliveries and back.
- API tests for guards and response shape; web tests for the composer piece counter in three languages.
- Fake provider only. No real Twilio or SendGrid credentials, no real sends.

## 7. Owner decisions

1. v1 recipients: DECIDED 2026-11-11 22:14Z, owners plus HON prospects (§4.8).
2. Must-receive notices: may `BILLING` and `ACCOUNT` emails go to an owner who opted out of HQ emails? (Recommended
   yes, as service messages; texts never ignore opt-out.)
3. Who pays for HQ texting: HON (recommended; it is HON's own messaging, never billed to the school).

## 8. Plan for PR A (0281)

Starts from main once #223 (0243) and the SendGrid PR are merged. Tests first for each step.

1. Contracts: HQ message purpose, status, delivery and sender enums; reuse `countTextPieces`; `TEXT_TOO_LONG` above
   1,600 for SMS. Unit tests in contracts.
2. Migration 0281: the tables in §4.1 (without `hq_contact_channels` SMS confirmation, which is 0282), forced RLS,
   append-only triggers, definer functions `hq_communication_sender_set/retire`, `hq_message_draft/queue/cancel`,
   reads, and worker functions `claim_hq_message_deliveries` / `record_hq_message_send_result` /
   `record_hq_message_provider_event`. Mirror grants in infra 010 and 013. Write the DB proof
   `test-hq-communications.mjs` first (§6), watch it fail, then make it pass. Pin the AI-0 and staging inventories.
3. API: `/v1/hq/communications/*` controller and service with the SaaS read and command guards; the dispatcher gets an
   HQ claim pass that sends with the HQ sender's service id through the existing adapter. API tests for guards,
   permission per purpose, response shape and the fake-provider end-to-end run.
4. Verify: `pnpm test`, `pnpm check`, `pnpm build`, `git diff --check`, the new proof and the existing communication
   proofs. Then `/agent-skills:review`, open the PR, ask the "Review PRs independently" thread.
