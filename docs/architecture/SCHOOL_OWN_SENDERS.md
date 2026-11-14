# School-owned texting numbers and email senders (spec)

Status: SPEC, 2026-11-14. Extends [COMMUNICATION_DELIVERY.md](COMMUNICATION_DELIVERY.md) §5a (texting, 0248) and §5
(email). Nothing here buys a number, registers a brand, sends a message or charges anyone in tests or by default.

## 1. Owner decisions this builds on

- 2026-11-14 05:03Z (David): "for twilio i want each school to buy their own phone number".
- 2026-11-14 05:04Z (David, decision card): **Buy in HON, billed to school.** The school picks a local number inside
  HON; HON buys it on the school's own Twilio **subaccount** and passes the number and texting cost to the school.
- 2026-11-14 05:17Z (David): "Remember text is free. They just have to buy their number." Texting usage is included
  (HON pays Twilio for messages); only the number itself is billed to the school. This narrows the 05:04Z card.
- 2026-11-14 05:05Z (David): "same for emails": each school gets its own email sending identity set up inside HON,
  with its cost billed to the school.
- Standing safety rule: no real purchase, registration, send or charge without David's explicit OK. Every real number
  purchase and every real A2P submission needs a human HON HQ owner approval in HON (§4.3) **and** an off-by-default
  process switch.

## 2. Goal and non-goals

Goal: a school owner, inside HON, (1) gets a Twilio subaccount of its own, (2) searches and requests a local number,
(3) completes A2P 10DLC brand and campaign registration from the A2P assistant's facts, (4) has the number go ACTIVE
as the school's sender once the campaign is approved, and (5) sends email from its own authenticated domain or a HON
fallback, with (6) every provider cost for that school recorded per school for pass-through billing.

Non-goals for this spec: actually charging the school (§7, waits on a David decision and is a B-series billing piece
that merges only with his approval); toll-free numbers; non-US numbers; porting an existing number into HON (later);
SendGrid subusers (§6.4); HQ's own sender (already built, 0281/0282, stays on HON's master Twilio account).

## 3. What exists and is reused

- `hon.school_text_senders` (0248): one Messaging Service + number per school, ACTIVE/DISABLED, set today by an HQ owner
  typing a hand-bought number. Claim v2 returns the sender's service SID. Kept; provisioning becomes a second writer.
- `TwilioTextProvider` / `TwilioWebhookVerifier`: one account (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`); signature check
  rejects any other `AccountSid`. This is the piece T1 changes.
- A2P preparation engine (0190, `apps/api/src/a2p/`): stateless facts, findings and draft copy, owner confirmation.
  T3 persists one owner-confirmed draft per school and maps it to Twilio's brand and campaign fields.
- `SchoolPaymentVault` (AES-256-GCM, `HON_SCHOOL_PAY_VAULT_KEY`): sealed per-school provider secrets bound to
  connection/provider/account. Reused (with its own AAD label) for subaccount auth tokens.
- `hon.communication_deliveries.provider_cost_microunits` (0243): measured provider cost per delivery per school.
- SendGrid adapter (0243 PR 2): one HON account, `HON_EMAIL_FROM`, sandbox mode unless switched off.
- `hon.require_saas_hq_actor`, human-command guard, audit events, versioned writes, entitlement-gated definer reads.

## 4. Texting

### 4.1 Twilio model

HON's Twilio account is the **parent**. Each school gets one **subaccount** (`AC…`), created by HON with the parent
credentials. The school's numbers, Messaging Service, Trust Hub secondary customer profile, A2P brand and campaign all
live in the subaccount, so Twilio's usage records and invoice supplement split cost per school. The parent pays Twilio;
HON recovers it from the school (§7). HQ's own number stays on the parent account (primary profile).

Twilio signs webhooks for a subaccount resource with **that subaccount's auth token**. HON therefore stores each
subaccount's auth token sealed in the vault (never in logs, never returned by any API), and verifies a webhook by:
read `AccountSid` from the form body (untrusted) → look up an ACTIVE school subaccount with that SID (or the parent SID
for HQ) → open its token → HMAC-SHA1 over the fixed URL + sorted params → constant-time compare. Unknown SID, closed
subaccount, vault failure or mismatch → `SIGNATURE_INVALID` (403), same as today. The school that a verified school
webhook belongs to is the subaccount's school; inbound routing additionally requires the `To` number to be that same
school's ACTIVE sender, so a valid signature from school A can never touch school B.

### 4.2 Records (new)

- `hon.school_twilio_accounts`: school (unique), subaccount SID (unique), status `PENDING | ACTIVE | SUSPENDED | CLOSED`,
  sealed auth token + vault key id, created_by, version, timestamps. FORCE RLS; runtime has no table access; worker
  reads via definer functions only.
- `hon.school_number_orders`: one row per requested number: school, requested E.164 (from a search result), locality,
  status `REQUESTED → APPROVED → PURCHASING → PURCHASED | FAILED | REJECTED | CANCELLED`, requester (school owner),
  approver (HQ owner), provider number SID (`PN…`), monthly price quoted, idempotency key, timestamps. One open order per
  school; one purchased number per school in v1.
- `hon.school_a2p_registrations`: school, frozen owner-confirmed A2P draft (facts + digest from the 0190 engine),
  secondary customer profile SID, brand SID, campaign SID, status
  `DRAFT → SUBMIT_APPROVED → SUBMITTING → BRAND_PENDING → CAMPAIGN_PENDING → APPROVED | FAILED | REJECTED`, provider
  failure reason codes, fees quoted.
- `hon.school_communication_costs`: append-only cost lines per school: kind
  `NUMBER_MONTHLY | NUMBER_SETUP | A2P_BRAND | A2P_VETTING | A2P_CAMPAIGN_MONTHLY | SMS | MMS | CARRIER_FEE | EMAIL`,
  amount in microunits, currency USD, source (`MEASURED` from provider, `QUOTED` before the provider confirms),
  provider reference, billing month (school timezone). Delivery costs are copied in when the 0243 receipt records them.

### 4.3 Flow and who can do what

1. **Subaccount**: created automatically on the school's first number search, by the worker, idempotent per school
   (friendly name = HON school id, never the school's name or owner). Only for an ACTIVE school with an ACTIVE, in-window
   entitlement.
2. **Search**: school OWNER (new permission `communication.sender.manage`, granted to system OWNER roles like 0190)
   searches local US numbers by area code or city. Search is read-only at Twilio and returns at most 20 numbers.
3. **Request**: the owner picks one; HON records an order `REQUESTED` with the quoted monthly price and the plain
   statement that the number's monthly cost is billed to the school (texting itself is included). Staff without the permission, HQ, family, AI
   and delegated contexts are refused.
4. **Approve**: a human HON HQ owner approves or rejects each order (`POST /v1/hq/saas/school-number-orders/:id/decision`,
   versioned, audited, authority re-checked after the write). This is David's per-purchase OK inside HON.
5. **Purchase** (worker): only `APPROVED` orders, only when `HON_TWILIO_PROVISIONING_APPROVED=true`; otherwise the order
   waits as `APPROVED` with hold `PROVISIONING_OFF`. The worker buys the number in the subaccount with Twilio's
   idempotency, creates the school's Messaging Service (MMS converter on, smart encoding on, inbound + status webhooks to
   HON's fixed paths), adds the number to it, records `PURCHASED` and a `NUMBER_MONTHLY` cost line. Because HON
   configured the service itself, it records `mms_converter_confirmed = true`. A timeout is `UNKNOWN` and is resolved by
   reading the subaccount's numbers, never by buying again.
6. **A2P**: the owner confirms the A2P draft (0190 engine; only a current OWNER can confirm). HQ owner approves the
   submission (same decision pattern). Worker, only with `HON_TWILIO_A2P_SUBMIT_APPROVED=true`, creates the secondary
   customer profile, brand and campaign in the subaccount and attaches the Messaging Service. Status comes from
   Twilio's A2P status callbacks (signed per subaccount) and a daily read; fee lines are recorded `QUOTED` then
   `MEASURED`.
7. **Activate**: only when the campaign is `APPROVED` does provisioning write the 0248 sender row ACTIVE (number +
   service SID). Until then school texts wait as `SENDER_NOT_READY`, exactly as today. The HQ manual path in 0248 stays
   for exceptional cases but refuses a number that belongs to another school's subaccount.
8. **Release**: owner or HQ can request release; HQ approves; worker releases the number and disables the sender. Closing
   the school's subaccount happens only on HQ command after all numbers are released.

### 4.4 Sending

`TwilioTextProvider.send` picks credentials per delivery: the claim returns the school's subaccount SID; the adapter
posts to `/2010-04-01/Accounts/{subaccount}/Messages.json` authenticated with the **parent** SID and token (Twilio allows
the parent to act on subaccounts), so subaccount tokens are only needed for webhook verification. HQ sends keep using
the parent account. `HON_SMS_SEND_APPROVED` still gates every real send.

### 4.5 Adapters and switches

One `TwilioProvisioningClient` interface (create subaccount, search numbers, buy number, create/configure Messaging
Service, Trust Hub + brand + campaign, release, read). `FakeTwilioProvisioningClient` is used by every test and by
local/test environments; it returns deterministic SIDs and simulates timeouts, failures and A2P rejections. The real
client is READY only with parent credentials, an https `HON_PUBLIC_API_ORIGIN` and its own switch:
`HON_TWILIO_PROVISIONING_APPROVED` (subaccounts, numbers, services) and `HON_TWILIO_A2P_SUBMIT_APPROVED` (Trust Hub,
brand, campaign). Both unset in every environment until David says otherwise. The fake refuses to run when
`NODE_ENV=production` unless explicitly a test environment (same rule as the 0243 fake provider).

## 5. A2P details

- Brand type: Standard (or Low-Volume Standard for small schools) using the owner-confirmed legal name, EIN, address,
  website and contact from the A2P facts. Sole-proprietor brands are not offered in v1 (they cap at one number and need
  OTP to the owner's personal phone).
- Campaign use case from the confirmed draft (transactional `ACCOUNT_NOTIFICATION`/`CUSTOMER_CARE`, or `MIXED` only when
  marketing consent was confirmed separately), with the draft's sample messages, opt-in description, HELP/STOP replies.
- Twilio fees noted 2026-11 (recheck before enabling): Standard brand about $46 one-time incl. secondary vetting,
  Low-Volume Standard about $4.50, campaign vetting $15, campaign $2-$10/month, plus carrier fees per message. These are
  recorded per school as cost lines, never hard-coded as prices to the school.

## 6. Email

### 6.1 Model

v1 keeps **one HON SendGrid account** and gives each school its own **authenticated sending domain** on it, plus a HON
fallback. Every school email carries `custom_args.hon_school_id` so events and costs attribute per school.

### 6.2 Records

- `hon.school_email_senders`: school (unique), mode `HON_FALLBACK | OWN_DOMAIN`, domain, SendGrid domain-auth id, DNS
  records to show (CNAMEs, never secrets), status `PENDING_DNS | VERIFIED | FAILED | DISABLED`, from local part (default
  `notices`), from name (school name), reply-to (school's verified contact email), version.

### 6.3 Flow

1. Default (no setup): mail goes from `HON_EMAIL_FROM` with from name "<School name>" and Reply-To the school's contact
   email. This is today's behaviour plus the school name and reply-to.
2. Own domain: the school OWNER enters a domain they own (e.g. `mail.myschool.com`); with
   `HON_SENDGRID_DOMAIN_SETUP_APPROVED=true` HON creates a SendGrid domain authentication (automatic security, custom
   return path) and shows the DNS records; "Check" calls SendGrid's validate. Once VERIFIED the school's mail goes from
   `notices@<domain>`. If verification later fails, sending falls back to the HON default, never to an unverified from.
3. Free domains (gmail.com, yahoo.com, etc.) and domains already used by another school are refused.

### 6.4 Why not subusers in v1

SendGrid subusers (separate reputation and stats per school) need the Pro plan or higher, and the account is capped at
15 subusers there; HON's account is on a trial plan. Moving to Pro is a paid service change for David. The model above
works on the current plan; subusers can be added later behind the same `school_email_senders` row.

### 6.5 Cost

Email is included (David 2026-11-14: "same for emails" as texting). SendGrid bills per plan, not per message, so HON
records a per-school count of accepted emails for HQ visibility only; a school's own domain costs the school nothing in HON.

## 7. Billing (pass-through)

- What the school pays: **only its number** (Twilio's monthly number price, at cost unless David decides otherwise).
  Texting and email usage are included in the HON plan; HON pays the provider.
- A2P fees, decided by David 2026-11-14 05:35Z ("Split: school pays one-time only"): the school pays the one-time
  brand and campaign-vetting fees with its number; HON covers the monthly campaign fee. Nothing is charged until piece B.
- Every cost line is still recorded per school and per month, so HQ sees what each school costs HON. School OWNER sees
  its number charge; HQ sees all lines (entitlement-gated reads).
- Safety cap on included texting: none is chosen yet; asked David 2026-11-14 (options: no cap, HQ alert only, or a
  per-school monthly ceiling that pauses non-required texts). Until he answers, T4 records costs and enforces nothing.
- Charging the school for the number becomes its own billing piece (B) that merges only with David's explicit approval.
  Nothing in T1-T4 or E1-E2 charges anyone.

## 8. Pieces (each a small PR, separate migration from the coordinator)

| Piece | What | Depends on |
|---|---|---|
| T1 | `school_twilio_accounts`, sealed tokens, per-account webhook signature verification, per-subaccount send URL, fake provisioning client, subaccount creation worker step | - |
| T2 | number search, order, HQ approval, purchase + Messaging Service (fake), release; school + HQ screens | T1 |
| T3 | A2P draft persistence, HQ submit approval, Trust Hub/brand/campaign (fake), status callbacks, activation into 0248 | T2, 0190 |
| T4 | cost lines (number charge to school; usage for HQ visibility), cost reads and screens; no texting limit (David 2026-11-14 05:34Z) | T2 |
| E1 | school email sender: fallback from-name/reply-to, own-domain setup + DNS screen (fake SendGrid client) | - |
| E2 | email cost lines + `hon_school_id` attribution | E1, T4 |
| B | charging the school, after David's decision | T4, E2, David |

## 8a. T1 as built (0351)

- `hon.school_twilio_accounts` (FORCE RLS, no runtime access) and `hon.school_text_senders.twilio_account_sid` with a
  composite FK, so a sender can only name its own school's subaccount. Five worker-only definer functions:
  `begin_school_twilio_account` (CLAIMED / BUSY / ACTIVE, lease 30-900 s, take-over after expiry),
  `complete_school_twilio_account` (live claim only, SID unique across schools, audited without the token),
  `read_twilio_webhook_account` (ACTIVE only), `read_twilio_send_account`, `twilio_number_in_account`.
- Webhooks: `AccountSid` other than the parent selects the subaccount's sealed token (opened with the
  `HON_SCHOOL_PAY_VAULT_KEY` vault under its own label); unknown, not ACTIVE or unopenable → 400 like a bad signature;
  then the event's school number (status `From`; inbound, voice, voice-result `To`) must be a sender of that subaccount.
  Subaccount texts are never offered to the HQ inbound check; `hq-status` stays parent-only.
- Sends: a school Messaging Service on an ACTIVE subaccount posts to `/Accounts/{sub}/Messages.json` with the parent
  credentials; SUSPENDED/CLOSED or a lookup failure is RETRYABLE and never falls back to the parent; HQ uses the parent.
- `SchoolTwilioAccounts.ensure(school)`, `TwilioRestProvisioningClient` (READY only with parent credentials and
  `HON_TWILIO_PROVISIONING_APPROVED=true`) and `FakeTwilioProvisioningClient` exist but no route calls `ensure` yet (T2).
- Open for T2: the 0248 HQ manual setter must refuse to change the phone or service of a sender that has a subaccount.

## 8b. T2 as built (0352)
- Orders: REQUESTED (school owner, price = the API's own Twilio quote) -> APPROVED or REJECTED (human HQ owner) ->
  PURCHASING (worker lease) -> PURCHASED, FAILED or back to APPROVED on RETRY. The owner may cancel before buying starts.
- Every purchase step reads Twilio before it creates: subaccount, number, Messaging Service, number-in-service.
- `outcomeUnknown`: set when a step may have acted without a recorded result (lost response, lost lease) or once the
  number is bought and a later step fails. It is never cleared by RETRY; only PURCHASED, or Twilio refusing the buy right
  after this attempt found no such number on the subaccount, clears it. Five attempts end FAILED: `RECONCILE_REQUIRED`
  when `outcomeUnknown`, else `ATTEMPTS_EXHAUSTED`.
- A FAILED order with `outcomeUnknown` is **unsettled**: it keeps the number reserved and blocks a new order for the
  school (`NUMBER_ORDER_UNSETTLED`) until HQ reconciles it with Twilio. The HQ reconcile action is a later piece; until
  then an operator checks the subaccount in Twilio.
- A bought number becomes the school's 0248 sender as DISABLED. The HQ setter refuses a phone or service change on it
  (`PROVISIONED_SENDER_LOCKED`) but can still switch it ACTIVE. HQ must not do that before the school's A2P campaign is
  approved; T3 adds the A2P check to that switch.

## 9. Security and failure rules

- No permission is inferred from the selected school, URL, form value or AI persona. Owner actions re-resolve the live
  OWNER role and entitlement after locks; HQ approvals use the human HQ owner guard and re-check after the write.
- Subaccount tokens: sealed with AAD `hon-twilio-subaccount:v1:<keyId>:<school>:<accountSid>`; a token copied to another
  school or SID never opens. No API returns a token, SID-less error or provider body.
- Webhooks: the `AccountSid` in the body only selects which token to try; the signature decides. Signature failure is
  403 with no detail. Replays stay idempotent per provider id as today.
- Money and spend: purchases and A2P submissions each need an HQ approval row and a process switch; timeouts are
  UNKNOWN and resolved by reading, never by retrying the purchase.
- Tenant isolation: all new tables FORCE RLS; the runtime gets definer reads only; DB proofs cover two schools.

## 10. Tests (TDD, per piece)

- API unit: verifier with parent + two subaccount tokens (right token passes, other school's token fails, unknown SID
  fails, closed subaccount fails, HQ parent still passes); send URL per subaccount; fake client determinism; switches off
  ⇒ no provider call; production refuses the fake.
- DB proofs: RLS between two schools; runtime cannot read the tables; only worker can create subaccount rows; one
  account per school; order state machine; HQ approval required; authority re-check after write.
- Browser proof (T2/E1 screens) in modern, classic and big-button modes at 390 and 1440 widths.

## 11. Open questions (defaults used until David says otherwise)

1. ~~A2P fees.~~ Decided 2026-11-14 05:35Z: school pays the one-time brand and vetting fees; HON pays the monthly campaign fee.
2. ~~Safety limit on included texting.~~ Decided 2026-11-14 05:34Z: **no limit**. Costs are recorded per school for HQ to see; nothing is capped or paused.
3. SendGrid plan: stay on current plan, no subusers.
4. Existing hand-entered 0248 senders: kept; HQ may migrate them into a subaccount later.
