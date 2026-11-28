# HQ email and text blasts (HB, migration 0712)

Owner request (David, 2026-11-28): "I don't see anything regarding text and email blast. Remember I want this set like
school OS with filter and everything." HQ (`/hq/communications`) gets a Blasts tab that works like the school blast composer
(`docs/architecture/SCHOOL_BLASTS.md`, BL1-BL4), but the audience is **schools**, chosen with HQ filters, and the people reached
are each school's owners. It is built on the HQ messaging records (`docs/architecture/HQ_COMMUNICATIONS.md`, 0281/0282/0698), so
the same consent, opt-out, quiet-hours, sender and receipt rules apply. Nothing here turns on sending: deliveries wait with
`NO_SENDER` until an HQ sender is set and the deployment switches (`HON_EMAIL_SEND_APPROVED`, `HON_SMS_SEND_APPROVED`) are on,
which is David's call at deploy time.

## 1. What HQ can do

`/hq/communications`, new tab **Blasts** (next to the inbox and settings):

1. **Write.** Name, channel (Email or Text), purpose, email subject (email only, 1 line, up to 150 characters), body. Email body
   up to 4,000 characters, text up to 1,600 (the HQ limits; texts over 3 pieces send as one MMS through the Messaging Service, as
   today). The live piece counter from `countTextPieces` is shown for texts. Merge tags (closed list): `{{first_name}}` (the
   owner's first name, "there" when empty), `{{school_name}}`, `{{hq_name}}` (the display name of the HQ person who sends it).
   Any other `{{...}}` is refused at save.
2. **Choose the schools.** Filters, all ANDed, each optional:
   - **Status:** Active, Paused (any mix). Archived schools are never included.
   - **Plan:** one or more current HQ plan names, or "No plan"; founder only / not founder; billing interval (monthly, annual,
     one-time); free plan.
   - **Trial:** On trial now, Trial ended, Never had a trial; or trial ends within 7, 14 or 30 days.
   - **Sign-up date:** joined within the last 7/30/90 days, or a from/to date range (the school's created date, UTC).
   - **Location:** country, state/region (up to 20), city (up to 20, exact, case-insensitive), from the school's saved location.
     A school with no saved location matches no location filter.
   - **Features:** the school's plan includes all of the picked features, or is missing any of them (from the same feature list
     as the HQ plan builder, `hon.school_plan_features`).
   - **Can get texts:** only schools where at least one owner turned on texts from HON.
   - **Picked schools:** 1 to 200 hand-picked schools (search by name), reached in addition to the filter matches (a union, like
     BL4 picked people). **Leave out** 1 to 200 schools: removed from the result last.
   With no filter and no pick, the audience is "all active and paused schools" and the composer says so in words.
3. **See the count before sending.** The database resolves the audience exactly as it will send: matching schools, their current
   owners (non-HQ owner grants), then per channel the owners who can be reached (email: account email and not opted out of HQ
   email; text: confirmed phone, HQ texting on). Counts shown: schools matched, owners reached, skipped (opted out, no texting
   opt-in, no owners). A preview shows the first school's rendered message. HQ never sees any address.
4. **Send now or schedule** up to 60 days ahead. Sending writes one QUEUED `hq_messages` row per matching school (purpose,
   channel, subject, content with `{{school_name}}` and `{{hq_name}}` filled, `blast_id`), and its deliveries (one per current
   owner) with `next_attempt_at = sendAt`. `{{first_name}}` is filled per owner by the claim, in memory. The existing HQ
   dispatcher delivers them.
5. **Cancel a scheduled blast** before its time: its messages become CANCELLED, so the claim suppresses their deliveries.
6. **Results** per blast: schools, owners, and deliveries by status (waiting, pending, sending, accepted, delivered, bounced,
   failed, suppressed, unknown). "Read" is never shown.
7. Each blast message also appears in that school's inbox thread (labelled "Blast"), so an owner's text reply lands in the right
   conversation (0698).

## 2. Rules

- **Purpose.** A blast uses `ANNOUNCEMENT` (new in 0712: product news, events, offers to customer schools), `SUPPORT` or
  `ONBOARDING`. Blasts never use `BILLING` or `ACCOUNT`, because those bypass an email opt-out and a bulk send must never do
  that. `ANNOUNCEMENT` is the HQ owner's only and always honors every opt-out.
- **Who.** **The HQ owner only, for everything** (draft, edit, read, send, schedule, cancel): a bulk message to every customer is
  an owner-level act. HQ operators keep their one-off messages exactly as before; blasts and ANNOUNCEMENT are not offered to them.
  Direct human only (HUMAN_UI, no AI action, no delegation). Authority is proved again after the locks.
- **Email footer.** Every blast email ends with a fixed footer: why they got it ("You get this because you run a school on HON
  OS"), HON's mailing address (`HON_MAILING_ADDRESS`, set at deploy; until it is set, blast emails wait and retry, never go out
  without it), and the existing SendGrid unsubscribe link (subscription tracking stays on; `bypass_unsubscribe_management` is
  never set for blasts). Owner-supplied address (2026-11-28): `HON_MAILING_ADDRESS="546 W. Las Tunas Dr. San Gabriel CA 91776"`,
  set on hon-api at the combined deploy.
- **Text footer.** Every blast text ends with "Reply STOP to stop texts from HON OS." (added by the HQ dispatcher; the 1,400
  character body limit leaves room inside one 1,600 character message). STOP is already handled by the 0282 HQ inbound path.
- **Refusals.** `HQ_BLAST_NOT_DRAFT`, `HQ_BLAST_NO_RECIPIENTS`, `HQ_BLAST_DAILY_LIMIT`, `HQ_BLAST_AUDIENCE_TOO_LARGE`,
  `HQ_BLAST_NOT_CANCELLABLE`, `HQ_BLAST_SEND_TIME` and `HQ_BLAST_TEXT_TOO_LONG` are SQLSTATE 23514 and reach the page as 422 with
  that code, like the 0281 HQ message refusals.
- **Caps.** At most 2,000 schools per blast (`HQ_BLAST_AUDIENCE_TOO_LARGE`), at most 10 blasts handed over in any 24 hours across
  HQ (`HQ_BLAST_DAILY_LIMIT`, counted under one HQ lock), a school gets at most one blast message per 24 hours per channel (later
  ones skip it as `RECENTLY_SENT` in the count).
- **Versioned drafts.** A DRAFT is edited by exact version; QUEUED and CANCELLED are final.
- **Evidence.** Exact-request idempotency, audit row and inert outbox event with ids only, append-only messages. Forced RLS, the
  runtime gets EXECUTE on fixed entry points only. Grants mirrored in `infra/postgres/010_supabase_hon_runtime.sql`.
- **Not in piece 1:** pictures and video (HQ Creative media), HON sign-up/offer links picker, HON prospects and school staff as
  audiences, AI-written blasts (need a second person's approval, David 2026-11-15).

## 3. Records (0712)

- `hon.hq_blasts`: id, name, channel, purpose, subject (email), body, audience (jsonb, closed shape checked by
  `hon.hq_blast_audience_ok`), status DRAFT / QUEUED / CANCELLED, send_at, created/queued/cancelled by and at, school and owner
  counts at send, version.
- `hon.hq_blast_requests`, `hon.hq_blast_audit`, `hon.hq_blast_outbox`: idempotency and evidence, append-only.
- `hon.hq_messages`: new nullable `subject` (email only, 1-150, one line) and `blast_id` (FK); purpose CHECK widened to add
  `ANNOUNCEMENT`; recipient_count unchanged.
- `hon.hq_communication_purposes` returns `ANNOUNCEMENT` for the HQ owner only;
  `hon.hq_communication_is_owner` checks the owner's full list instead of the count 4.
- `hon.claim_hq_message_deliveries` (replaces 0282's): also returns `subject` and `blast_id`, and fills `{{first_name}}` from the
  owner's display name. Every other check is unchanged.
- Functions: `hon.hq_blast_resolve(audience, channel)` (the one resolver for count and send), `read_hq_blasts`, `read_hq_blast`,
  `read_hq_blast_audience`, `read_hq_blast_audience_options` (plan names, features, countries/regions in use, and a school
  name search for the picker), `save_hq_blast`, `send_hq_blast`, `cancel_hq_blast`.

## 4. API

`/v1/hq/communications/blasts`: `GET` list, `GET /:id`, `GET /:id/audience`, `GET /options?search=`, `POST` save (create or
edit by version), `POST /:id/send` {expectedVersion, sendAt|null}, `POST /:id/cancel` {expectedVersion}. SaaS read and command
guards (same origin, `X-HON-Human-Command: hq-blast-save|hq-blast-send|hq-blast-cancel`, JSON, Idempotency-Key). The dispatcher
passes `subject` and `blastId`; SendGrid uses the HQ subject when present and adds the footer for blast mail.

## 5. Screens (piece 2, frontend only)

The Blasts tab: a list (name, channel, status, when, schools, delivered), New blast, and the composer in three steps on one page:
Write (channel, purpose, subject, body, merge tag buttons, piece counter), Schools (the filters always visible as chips and
selects, school search with picked and left-out chips, live count), Send (preview, Send now or Schedule, confirm with the exact
school and owner counts). A sent blast shows its results. English, Korean and Spanish. Like every HQ page, nothing hides when
the tab loses focus; a session end hides everything.

## 6. Pieces

| PR | Piece | Migration |
| --- | --- | --- |
| HB1 | Records, resolver with all filters, save/send/cancel/results, ANNOUNCEMENT purpose, subject + first name in the claim, API, SendGrid subject and footer | 0712 |
| HB2 | Blasts tab and composer on `/hq/communications` | none |
| HB3 (later) | Pictures/video from HQ Creative, HON offer links, prospects and staff audiences | owner allocates |

## 7. Proof

- DB proof `test-hq-blasts.mjs`: each filter alone and combined, picks and leave-outs, archived never, only current owners, consent
  and opt-out in the count and again at claim, BILLING/ACCOUNT refused, owner-only send, operators refused, caps, schedule
  and cancel, first-name fill at claim, cross-org isolation, runtime has no table access, append-only evidence.
- API tests for guards and response shapes; dispatcher/SendGrid tests for subject and footer, footer missing = retry.
- Web tests for the composer (filters, counter, three languages). Fake provider only; no real sends.
