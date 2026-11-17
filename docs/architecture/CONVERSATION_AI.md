# Conversation AI: one school inbox, every channel, an AI receptionist the owner trains

Status: gap audit, spec and plan, 2026-11-15. Asked for by David in the "Complete AI platform handoff" (section 1, plus
the Conversation AI parts of sections 5 to 8). Migration numbers from the coordinator (register, 2026-11-16): CA1 **0364**, CA2a **0420**,
CA2b **0421**, CA3 **0422**, CA1b **0424** (after Automation's AU-2 **0423**); later pieces ask for theirs. Sibling threads own the Website Builder, the AI Customizer and Automation.

## 1. Gap audit (main fbc9102, 2026-11-15)

Legend: **working** = merged, tested end to end in the database proofs; **partial** = merged but only part of the
requirement; **open PR** = not on main; **absent** = nothing in the repository.

| Requirement | State | Where | Notes |
|---|---|---|---|
| Outbound SMS and email with consent, quiet hours, retries, receipts, cost | working | 0047, 0243, 0248, `communication/delivery/*` | Consent-gated queue + worker + Twilio/SendGrid adapters (fake by default). Reuse as the only send path. |
| School's own texting number | partial / open PR | 0248, 0351, 0352, 0358, PR #372 | HQ records or buys the number; screens in #372. |
| Inbound SMS | partial | `communication-webhook.controller.ts` `twilio/inbound` | Only STOP/START/HELP are recorded. Every other school text is dropped (not stored). |
| Missed-call text-back | partial | 0249 | Fixed template, one per caller per day. Not part of any conversation. |
| Inbound email | absent | — | SendGrid events only (delivered/bounced), no Inbound Parse. |
| Messenger / Instagram DMs and comments | open PR | 0435 (PR #349, first allocated 0349) | Separate social inbox; replies are human only and still switched off. |
| Website live chat | absent | — | Public lead forms (0075) and booking links (0261/0286) exist; no chat. |
| Family (parent app) messages | working | 0330 | Separate parent-to-school threads, staff reply inside HON, nothing texted. |
| Unified inbox across channels | absent | — | Three separate stores (SMS keywords, social, family), no shared list. |
| Assignment, tags, status, human takeover | partial | 0435 has assignment and unread for social only | Nothing for SMS/email/chat; no takeover or AI state anywhere. |
| CRM contact match and lead dedup | absent | 0075/0250 always insert a new person | Nothing matches an incoming phone or email to an existing person or lead. |
| School knowledge for AI | partial | 0036 knowledge articles (approved, two-person rule), 0255 school notes, 0256 tone | Only HON's staff answers read notes and tone. No owner instructions, no customer-facing knowledge pack. |
| Real text AI | working | `ai/*-provider-runtime.ts`, 0242/0287 routing, 0244/0288 per-school ceilings | OpenRouter behind `OPENROUTER_PAID_CALL_APPROVED`; every agent so far answers staff, never a customer. |
| AI reply drafts for a contact | partial | Chad 0107 (lead follow-up drafts, approval does not send), 0128 draft inbox | Not tied to a conversation, never delivered. |
| Automatic replies and actions | absent | — | No AI sends anything to a customer today. |
| Trial / evaluation availability | working | 0043 trial appointments, 0286 booking types (weekly hours, open link) | AI can offer and book real slots of an owner-chosen booking type. |
| Appointment reminders | absent | — | Belongs with Automation; Conversation AI sends through the same queue. |
| Staff notifications | partial | outbox events, work items | No conversation notifications. |
| English, Korean, Spanish | working (UI) | `apps/web` copy files | The AI must answer in the contact's language. |
| Audit and AI cost accounting | working | audit_events, outbox, 0193-0199 AI spend evidence | Reuse for every AI turn. |

Nothing from this list is deployed. Reusable without change: the send queue and worker, number routing, consent and
STOP handling, booking types, trial appointments, knowledge articles, notes, tone, the AI invocation planner, provider
runtimes, per-school AI ceilings, the Action Engine, audit and outbox.

## 2. What we build

One **Conversations** section in the school app. Every message a contact sends the school, on any channel, lands in
one list, matched to the CRM person or lead. Staff read and answer there. The school's AI receptionist (**Chad**, the
sales and front-desk member of the AI team; owner may rename later) reads the school's approved knowledge, answers in
the contact's language, asks qualifying questions, offers real evaluation slots and, when the owner allows it, books
them and creates the lead. **Chad answers live texts and chats automatically** (David, 2026-11-15 08:04Z: "conversation AI and automation
workflow are meant to be done automatically; only AI-helped SMS or email blasts need approval"). The owner can still set
a channel to **Assist** (drafts for staff approval) or **Off**, and staff can take any conversation over by hand.
Guardrails decide when Chad hands a conversation to a person instead of answering.

### 2.1 Architecture

```
 Twilio SMS ─┐   SendGrid inbound ─┐   web chat widget ─┐   Zernio (0349) ─┐   parent app (0330) ─┐
             ▼                     ▼                    ▼                  ▼                      ▼
     school_conversations + school_conversation_messages (SMS, EMAIL, WEB_CHAT)   social + family stores
             └──────────────── unified inbox read (one list, one contact panel) ───────────────────┘
                                         │ conversation.message.received (outbox)
                                         ▼
                    conversation AI worker: prepare (facts + plan + budget) → provider → record
                                         │
                 Assist: draft waits for staff   │   Automatic: guardrails → send via 0047 queue
                                         ▼
                0047 queue → 0243 worker → Twilio / SendGrid (consent, quiet hours, receipts, cost)
```

- **One store for the new channels, links for the old ones.** SMS, email and web chat use the new conversation tables.
  Social (0435) and family (0330) keep their stores; a small overlay table gives them the same AI mode, takeover and
  tags, and the inbox read merges all of them. Nothing is copied twice.
- **One send path.** A reply (staff or AI) is a QUEUED 0047 message delivered by the 0243 worker. Consent, quiet hours,
  retries, receipts and cost stay where they are. Automation uses the same path.
- **One knowledge pack.** `hon.school_ai_knowledge(school, audience)` returns the approved, customer-safe facts: public
  knowledge articles (0036), programs and membership plans with prices as recorded, the evaluation booking type and its
  next open times, active promotions with their dates, school tone (0256) and the owner's instructions (CA2). Any agent
  or channel can use it; nothing outside it reaches a customer-facing answer.
- **The model never acts.** It returns a structured answer (`reply`, `language`, `intent`, `needsHuman`, `reason`,
  `proposedAction`). The database decides what happens: draft, send, book, escalate. Proposed actions come from a closed
  list and run through existing domain functions under a fixed system principal with no human authority.

### 2.2 Rules for every piece

- School-scoped, forced RLS, SECURITY DEFINER entry points, the runtime gains no table privilege. Every staff command is
  `HUMAN_UI`, same-origin, idempotent by key, version-checked, audited, with ids-only outbox events.
- New permissions: `conversation.read` (see the inbox) and `conversation.manage` (reply, assign, tag, close, link,
  take over). System OWNER roles get both; both are staff-assignable. `conversation.ai.configure` (modes, Train AI,
  automatic rules) is OWNER only by default.
- An incoming message is never an instruction. The model gets it as untrusted data; nothing in it can change modes,
  rules, recipients or prices.
- Automatic mode can never change money (no discounts, refunds, charges, plan changes), promise anything not in the
  knowledge pack, read another school, or override a policy. Anything sensitive or uncertain goes to a person.
- Real provider calls (OpenRouter, Twilio, SendGrid sends) stay behind their existing switches and David's approval.
  Tests use the fake providers.

## 3. Pieces and pull requests

| Piece | What | Migration |
|---|---|---|
| **CA1** | Conversation store; every non-keyword text to an ACTIVE school number becomes a conversation message; contact match by phone to the school's people and their open lead; staff inbox read (list with filters/search, thread, contact panel); staff reply through the 0047 queue; assign, tag, open/close, mark read, link person/lead, create lead from a conversation. Backend PR, then the **Conversations** screen (en/ko/es) as its own PR. | 0364 |
| **CA2** | **Train AI section** (David 2026-11-15 08:06Z: "needs a section for uploading schedule or scripts and more"): per-school settings (mode per channel, languages, evaluation booking type, escalation topics, staff to notify); **uploaded training material** (class schedules, sales and phone scripts, price sheets, policies, FAQs: PDF, Word, text, CSV; the text is extracted on the server, shown to the owner to check, and only owner-approved text is used; the original file is not kept); owner instructions (plain sentences, versioned, owner-approved; HON can turn "make it friendlier with parents" into a proposed instruction); the knowledge pack function over all of it; the AI turn engine: each inbound message starts a turn (plan, budget, fake/real provider, usage evidence); Automatic sends, Assist leaves a draft staff send as is, edit or discard; human takeover pauses Chad for that conversation.| 0420 |
| **CA3** | Actions and guardrails: guardrails (prices and dates must match the pack, money and promise words, low confidence, opt-out, quiet hours) decide send vs. hand to a person; **Chad books appointments on the scheduler by itself** (David 2026-11-15 08:06Z): offers real open times of the owner-chosen booking type (0286) or trial slots and books them directly, creating or matching the lead first (asks for a name); confirmation text; escalation creates a staff notification and a work item; per-conversation and per-school auto-reply limits; outbox `conversation.reply.sent` / `conversation.escalated` / `conversation.appointment.booked` for Automation.| 0422 |
| CA4 | Website live chat: public chat id per school (like 0075 public forms), signed visitor session, rate limits, embeddable script for the Website Builder, same AI and inbox. | ask |
| CA5 | Email: SendGrid Inbound Parse on a HON reply domain per school, threading by reply-to token, same inbox and AI. | ask |
| CA6 | Social and family in the unified inbox: overlay for AI mode/takeover/tags on 0435 and 0330 threads; Chad drafts and (when David switches it on) automatic replies within Messenger's 24-hour window. Waits for #349. | ask |
| CA7 | Missed call into the conversation (Chad writes the text-back instead of the fixed template, when on), appointment reminders through Automation, conversation reporting (response time, AI share, booked evaluations, escalations), HON assistant access ("show me unanswered texts"). | ask |
| Voice | Separate later piece; the voice handoff ledger stays as it is. | — |

Each piece: spec section here, plan, tests first, review by the independent review thread, squash on GO and green CI.

### 3.1 Additions approved by David on 2026-11-15 08:23Z (ideas from his Manus CRM, "Apply all")

| Idea | Lands in | What it adds |
|---|---|---|
| #2 Message history per contact | **CA1b** (new, migration to ask) | One read per person: conversation texts, family messages, campaign and automation texts and emails from the 0047 queue, each row with channel, Sent or Received, where it came from (Conversation, Campaign, Automation, Family) and the delivery result from 0243 receipts; search and All / Today / 7 days / 30 days ranges; count. The Clean up screens thread calls it from the new contact card's Comms tab. |
| #3 View the exact email sent | **CA1b** | Shows the stored subject and plain-text body of that message (never raw HTML or CSS; the preview is the plain-text start). "Resend to saved address" queues a new message to the person's current address after a fresh unsubscribe and consent check, as a staff command with an idempotency key. |
| #4 Test bench and coaching | **CA2** | "Test a question" runs the same AI turn with the fake or approved provider and returns a reply that is never sent and never touches a conversation (still metered when a real provider is on). "Improve this reply" saves a coaching card (test question, preferred answer, optional staff note), versioned, with pause and delete; active cards go into the knowledge pack. |
| #5 Training library | **CA2** | Each item has a type chip (FAQ, Document, Image), an on/off switch that pauses it without deleting, the owner-checked summary, "Review training summary", last updated date. A photo of the class schedule is accepted as input (text read on the server, owner checks it). Change from §3 CA2: the original file is kept in private school storage so "Open original file" works; only owner-approved text is ever used. |
| #8 Inbox quick actions | **CA1 screen** (link, mark read, consent badge), **CA2** (AI or Staff state per thread, "Needs staff" chip, "need attention" counter, take over), **CA3** ("Send verified times" offers real open slots of the booking type; "Send calendar link" sends the school's booking page) | |
| #9 Plain settings | **CA2** (mode per channel: Off / Assist / Automatic), **CA3** (comma list of hand-off words such as human, manager, cancel, refund, billing that move the conversation to staff at once; an after-hours text; a length cap per channel, for example SMS 500 and chat 900, enforced by the guardrail before sending) | |

## 4. CA1 design (0364): conversations and two-way texting

### 4.1 Records

- `hon.school_conversations`: school, channel (`SMS`; `EMAIL` and `WEB_CHAT` reserved for CA4/CA5), contact address
  (E.164 for SMS), linked person and lead (nullable), status (`OPEN`, `CLOSED`), assigned staff principal (nullable),
  tags (0 to 10, each 1 to 32 letters, digits, spaces or dashes), unread count, last inbound and last message times,
  version. One conversation per school, channel and address.
- `hon.school_conversation_messages`: conversation, direction (`INBOUND`, `OUTBOUND`), author kind (`CONTACT`, `STAFF`;
  `AI` arrives in CA2), body (1 to 1,600 characters, no control characters except line breaks and tabs), provider message
  id (inbound, unique), the 0047 message id (outbound), staff principal (outbound), time. Append-only, never deleted.
- Commands reuse the shared `hon.idempotency_records` (key plus a fingerprint of operation and input; the receipt is
  recorded once and replayed exactly). No conversation-specific command table.

### 4.2 Inbound text

`hon.record_inbound_conversation_text(to, from, body, media_count, provider_message_id, received_at)`, called by the webhook's
communication store after the signature and number checks it already makes. STOP/START/HELP keep their 0248 path and
are not added to a conversation (a STOP already silences replies through consent).

1. The number must be an ACTIVE school sender (0248); otherwise `UNROUTED` and nothing is stored.
2. The school and organization must be live; otherwise `UNROUTED`.
3. Replay of the same provider message id returns `REPLAYED`.
4. The conversation for (school, SMS, from) is found or created. A new conversation is matched: when exactly one person
   of this school has that mobile number, it links that person and that person's newest OPEN lead. Two or more people
   with the number link nobody (staff choose). No person is ever created from a bare phone number.
5. The message is stored, unread +1, the conversation re-opens if closed, audit plus outbox
   `conversation.message.received` (ids only). At most 300 inbound texts per school per hour and 30 per conversation per
   hour are stored; above that the text is counted as `RATE_LIMITED` and dropped (Twilio keeps the log).

### 4.3 Staff

Reads need `conversation.read` at the session school; commands need `conversation.manage`, both re-checked after locks.

- **List** newest first, 50 per page (keyset), filters: status, channel, assigned to me / unassigned, unread, tag;
  search by person name, phone digits or tag. Each row: contact name (person name or masked number), channel, last
  message preview (first 120 characters), unread, assigned staff name, lead stage, tags, status.
- **Thread**: messages oldest to newest (last 100, then older pages), each outbound message with its delivery status from
  0243 (`QUEUED`, `SENT`, `DELIVERED`, `FAILED`...). **Contact panel**: person name, lead status and stage, next trial
  appointment, SMS consent state.
- **Reply** `{body, expectedVersion}`: the conversation must be linked to a person whose mobile is the conversation's
  number and whose SMS consent is OPTED_IN; creates a QUEUED 0047 SMS message to that person (`queued_by` = staff), and
  the message row. Without consent the reply is refused with `COMMUNICATION_CONSENT_REQUIRED` and the screen offers the
  existing consent recording. Reply marks the conversation read.
- **Assign** (a direct staff member of this school with `conversation.read`, or nobody), **tags**, **open/close**,
  **mark read**, **link** (a person of this school whose mobile equals the number, and optionally one of that person's
  leads), **create lead** `{givenName, familyName?, pipelineId, stageId}`: creates the person with the conversation's
  number and an OPEN lead with source `CONVERSATION_SMS` through the same insert path as public forms, then links both.

### 4.4 Not in CA1

No AI, no automatic sending, no email/web chat intake, no social or family merge, no consent change from an inbound
text (see decision D1), no notifications beyond the outbox event.

## 5. Owner decisions

- **D1 (open, asked 2026-11-15):** does a contact texting the school first allow the school (and Chad) to text back in
  that conversation? Recommended: yes, for replies in that conversation for 30 days after their last text, never after a
  STOP, without turning on marketing texts. Until decided, replies need recorded SMS consent (today's rule).
- D4 (decided by David 2026-11-15 08:04Z): Conversation AI replies to live SMS and chat automatically; approval is
  only for AI-helped blasts. Automatic is the default mode once a school turns Conversation AI on.
- D2 (assumed, reversible): Chad is the AI receptionist persona.
- D3 (assumed): the newest owner instruction (automatic mode allowed under owner rules) supersedes the social spec's
  "people decide, AI drafts" for Messenger/Instagram once CA6 lands; replying there still needs David's switch.

## 6. Tests (TDD)

CA1 database proof `test-school-conversations.mjs` (communication-delivery fixture): routing (active, disabled, unknown
number, inactive school), replay, keyword texts not stored, match rules (one person, two people, none, newest open
lead), rate limits, reopen on inbound, every command's permission and cross-school refusal, idempotency replay and
conflicting reuse, version conflicts, reply without consent refused, reply queues exactly one 0047 message to the right
person, delivery status shown, append-only and no-truncate guards, runtime has no table privilege. API unit tests for
the webhook branch (keyword vs conversation text, Twilio not retried twice), controllers' closed input, and the
contract validators.

## 7. CA2 design (0420): Train AI and Chad's replies

### 7.1 Safety switches (three, all off by default)
1. **HQ program switch** `conversation_ai_program` (HQ owner only, audited): OFF, TEST_MODE (fake provider only), LIVE.
   The OpenRouter switch is already on for the text agents, so this switch is what keeps automatic replies from making
   real calls or sending texts until David turns it on.
2. **School switch** in `school_conversation_ai_settings`: enabled plus a mode per channel (OFF, ASSIST, AUTOMATIC),
   set by staff with `conversation.ai.configure` (OWNER only by default). The setting row records who turned it on and
   when. That record is the standing authority for automatic turns. Turning it off stops new turns at once.
3. **Per-conversation takeover**: `ai_state` AI or STAFF. A staff reply or "Take over" sets STAFF, and only "Hand back
   to Chad" returns it to AI. A conversation with `needs_staff` is never answered automatically.

### 7.2 Training library (David 08:06Z "a section for uploading schedule or scripts and more"; Manus ideas #4 and #5)
`school_ai_training_items`:
- **Fields:** type (FAQ, DOCUMENT, IMAGE, INSTRUCTION, COACHING), title, owner-checked text (at most 8,000 characters),
  short summary, ACTIVE or PAUSED (on/off switch), soft delete, version, updated by and at.
- **Files:** the original file sits in private school storage under a content hash, so "Open original file" works.
- **Extraction:** text, CSV, PDF and Word text is extracted on the server. For a photo of the schedule, the owner types
  or corrects the text. A later step may read the image with AI, behind its own switch.
- **What Chad may use:** only ACTIVE, owner-approved text reaches the knowledge pack.
- **Coaching cards (#4):** a test question, the preferred answer and an optional staff note, saved from "Improve this
  reply". They are versioned and can be paused or deleted.
- **Instructions:** plain sentences from the owner, versioned. HON may propose wording, and the owner approves it.

### 7.3 Knowledge pack
`hon.school_ai_knowledge(school)` returns customer-safe facts:
- the school name, tone (0256) and languages;
- programs and membership plans at the prices recorded;
- the evaluation booking type and its next open times (CA3 uses these to book);
- active promotions with their dates;
- public knowledge articles;
- ACTIVE training items and coaching cards.

Each fact carries its source id, so a reply can show what it used. Nothing outside the pack reaches an answer.

### 7.4 Turn engine
- **Turn record:** `school_conversation_ai_turns` holds one turn per inbound message: conversation, message, status,
  plan and usage evidence ids, structured result, outbound message id and reviewer.
- **Three steps:** `conversation.message.received` → worker `prepare_conversation_ai_turn` (all switches, the
  takeover and needs-staff flags, school access and the AI ceiling, then a plan through the 0287 router as agent `chad`
  with the new task class CONVERSATION_REPLY) → provider (fake unless LIVE) → `record_conversation_ai_turn_result`.
- **S4 evidence:** usage evidence is recorded in its own transaction, the same way as the other agents. A lost answer
  is UNKNOWN and is never resent.
- **Model output** is data only: `{reply, language, intent, needsStaff, reason, usedFacts[]}`. The database decides
  what happens next:
  - **ASSIST:** the reply becomes a draft on the thread. Staff can send it as is, edit it or discard it, and sending is
    an ordinary CA1 reply.
  - **AUTOMATIC:** CA2 checks the basic rules: length cap per channel (#9), reply consent (D1), quiet hours and the
    after-hours text. If they pass, it queues the reply through 0047 as the system principal "HON conversation AI".
    Anything else is a draft marked `needs_staff`.
  - The full guardrails and booking come in CA3.
- **Test bench (#4):** a staff command (`conversation.ai.configure`) runs a turn on a test question with no
  conversation and no send. It uses the same metering and is labeled TEST.
- **Inbox state (#8):** AI or Staff on each thread, a "Needs staff" filter, and a needs-attention count in the list read.

### 7.5 Spend
- **Trial school:** turns count toward the existing $15 ceiling.
- **Paying school:** no conversation cap, as David decided on 2026-11-13.
- **Every school:** a per-conversation limit of 10 automatic replies per hour and a per-school limit of 300 per day.
  When a limit is hit, Chad hands the conversation to staff.

### 7.6 Owner decisions this needs
- **D5:** when should David turn the HQ program switch to LIVE, and for which schools first? The recommendation is
  his own test school only, after a fake-provider week.
- **D1** (still open) decides whether Chad may answer a first-time texter who has no recorded consent.

### 7.7 Design read (review thread, 2026-11-15; full notes in /mnt/project-files/conversation-ai/CA2_S4_DESIGN_READ.md), accepted
- System turns get their own planner, `plan_conversation_ai_turn`. It is worker-only and its only input is the inbound
  message id, with one turn per message (UNIQUE). Both it and `plan_ai_invocation` call one shared, non-granted S4
  core: route, unavailable model, org ceiling, budget lock first, access and pause, UNKNOWN window. Both paths are in
  the AI-0 inventory.
- Standing authority is proved again on every turn, both when it is planned and when its result is recorded. That
  covers the HQ switch, the school mode, takeover and needs-staff, entitlement, and the enabling owner still holding
  `conversation.ai.configure`. A switch or takeover that happens during the provider call wins.
- `CONVERSATION_REPLY` is HIGH risk and has its own HQ task profile. Without that profile the turn fails closed.
- Audit source is SYSTEM, under a fixed system principal. When the reply is queued, consent, address and quiet hours
  are checked again.
- AUTOMATIC is allowed only while the HQ program is in TEST_MODE until CA3's guardrails land. Otherwise turns produce
  ASSIST drafts only.
- Chad hands off to staff after 5 AI replies in a row with no staff message in between.
- The S4 org ceiling applies to every turn. "No cap for paying schools" means no extra cap from conversations only.

### 7.8 Split
- **CA2a (0420)** covers:
  - the HQ program switch and school settings;
  - the training library with coaching cards and the on/off switch;
  - the knowledge pack read;
  - inbox AI state: takeover and hand-back, needs staff, the needs-attention count.

  No AI is called.
- **CA2b** (0421) adds the CONVERSATION_REPLY kind to the shared AI text caller (0380 `hon.ai_text_proposals`, Website Builder;
  docs/architecture/AI_TEXT_PROPOSALS.md), which owns the one S4 wiring. CA2b adds its own worker-only planning path, the HIGH
  CONVERSATION_REPLY task profile, its gate (the 0420 program switch and school settings, run before core prepare), the system turn planner and recorder, the worker,
  ASSIST drafts, TEST_MODE automatic replies, and the test bench.

## 8. CA1b design (0424): one person's message history and the exact email

- **History** (`GET /v1/organizations/:org/schools/:school/people/:person/messages`, conversation.read): every non-draft 0047
  message to the person (texts and emails from staff, conversations, campaigns and automations, with the 0243 delivery
  state), the texts the person sent the school number (0364) and, only for staff who also hold `family_messages.manage`,
  the family app messages of the person's families (0330). Each row: channel, Sent or Received, origin (Staff, Conversation,
  Campaign, Automation, Family), subject for emails, a 160-character plain preview, who sent it and "resent copy". Plain-text
  search over body and subject, All / Today (school time zone) / 7 days / 30 days, total count, 50-row keyset pages ordered by
  millisecond time then id. Drafts never appear; another school's person is not found.
- **Email view** (`GET …/messages/:message/email`): the subject that is sent (the author's 0423 subject, or the adapter's
  standard subject "A message from <school>") and the plain-text body exactly as stored, rendered as text, never HTML; the
  delivery status, attempts and provider events; the person's saved address now; resends. From 0424 the delivery worker
  reads the author's subject for the email it holds the lease for (`hon.communication_email_subject`, worker only), so the
  subject shown is the subject sent.
- **Resend to saved address** (`POST …/messages/:message/resend`, conversation.manage and communication.message.queue,
  Idempotency-Key): a new QUEUED 0047 email with the same subject and body to the same person; the 0243 worker sends it to
  the address saved now. Refused unless the original was queued (never draft or cancelled), the person has an email address
  and EMAIL consent is OPTED_IN (an unsubscribe or spam report records OPTED_OUT). At most 3 resends of one email and 10
  email resends to one person in 24 hours, counted under a lock on the person. Recorded in the append-only
  `hon.communication_message_resends`; audited, outbox `communication.message.resent` with ids only; authority re-proved
  after the writes.
- **Screens**: the "Message history" section on People (the contact card) and in the Conversations contact panel, opened on
  request, in en/ko/es.
- Proof: `test-contact-message-history.mjs` (7 groups). Not deployed; nothing is sent by this piece.
