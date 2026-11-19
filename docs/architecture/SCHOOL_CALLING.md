# Calling on the school texting number (spec, CL series)

Status: spec 2026-11-19. Owner ask (David, 2026-11-19 05:15Z): "I want HON OS and HQ able to call and receive calls,
same number as the text number." Clarification 05:16Z: understand GoHighLevel's phone features, but do not copy it;
make HON's version easier to use and focused on martial arts schools.

Migrations (coordinator): **CL1 = 0556** (call log, voicemail, calling settings), **CL2 = 0561** (per-school voice
credentials), **CL5 = 0562** (HQ calling). Nothing here buys anything, places a real call or turns on a provider:
every real Twilio voice action is behind `HON_VOICE_CALLS_APPROVED=true` (unset everywhere) and David's OK. All
tests run against a fake Twilio voice client and a fake browser phone.

## 1. What GoHighLevel offers (understood, not copied)

| GHL feature | What it does | HON v1 |
| --- | --- | --- |
| LC Phone numbers, one per sub-account | Number for calls and texts | Already: school's own number on its own Twilio subaccount (0351/0352); the **same** number now also calls |
| Web dialer in the top bar | Keypad, contact search, call from browser | **Yes**: Call button in the top bar opens a dialer panel |
| Click-to-call from contact / conversation | Call a contact in one click | **Yes**: Call button on the contact card and Texts thread header |
| Inbound routing (ring users, round robin, forward) | Decide who rings | **Simplified**: "Ring everyone who is set to take calls" in the browser, plus the school's own phone if a forwarding phone is set (0249). No round robin, no IVR in v1 |
| Voicemail with custom greeting | Caller leaves a message | **Yes**: one greeting per school (typed text read in the school language, or default), voicemail inbox |
| Voicemail drop, power dialer, number pools, IVR, call tracking per source | Sales-floor features | **Not in v1**: too complex for a school front desk; listed as later |
| Call recording toggle | Record calls | **Yes, off by default**, school owner turns on, every recorded call announces itself (§6) |
| Call transcription / AI summary | Text of the call | Later (needs paid AI + provider OK); voicemail transcription later |
| Missed call text back | Auto text after a missed call | Already (0249); now also fires when nobody answers in the browser |
| Call disposition / notes | Outcome of the call | **Yes**, martial-arts outcomes: Trial booked, Call back, Interested, Not interested, Left voicemail, Wrong number |
| Call reporting | Counts and durations | Simple counts on the Calls page (answered, missed, voicemails this week); no fake metrics |

What makes HON easier: one number for texts and calls with nothing extra to set up (the number a school already has
starts taking calls once calling is on); one "Calls" page with plain words; every call shows the contact and family
("Jamie's mom") when the number is known; Call back / Text / Open contact on every row; a single switch per staff
member: "Ring me for incoming calls".

## 2. Goal and non-goals

Goal: staff with permission make and receive calls in the browser (Modern, Classic, Big Button, phone width) on the
school's ACTIVE texting number; every call is logged and tied to a contact; missed calls go to voicemail; HQ does the
same on the HQ number.

Non-goals v1: IVR menus, call queues, round robin, transfers and conference/hold, power dialer, voicemail drop,
transcription, mobile app push calls, international calling (US/Canada +1 only), calling from a number that is not the
school's ACTIVE sender.

## 3. Where it lives

- **Top bar Call button** (all three looks, school app and HQ): opens the **dialer panel** (slide-over on desktop,
  full screen on phone): search contacts by name or number, keypad, recent calls, Call. In a call: name/family line,
  timer, Mute, Keypad (touch tones), Hang up, then a short **after-call card** (outcome chips + note, Save / Skip).
- **Incoming call banner** on any page while signed in and "Ring me" is on: caller name or number, family line,
  Answer / Decline, ringtone. Answered by one person, it stops ringing for everyone else.
- **Calls page** `/staff/calls` under Communication (Texts, Email, **Calls**, Social), tabs:
  1. **Call log** (default): chips All / Missed / Voicemail / Outgoing; rows: direction icon, name or number, family
     line, when, length, outcome, who took it; actions Call back, Text (opens Texts Send prefilled), Open contact.
  2. **Voicemail**: play, mark heard, Call back, Text; unheard count.
  3. **Settings** (school owner): Calling on/off, Ring who (list of staff with their "Ring me" state), forwarding
     phone (0249, still HQ-set today; shown read-only), voicemail greeting, recording (§6), missed-call text back state.
- **Contact card**: Call button and the person's calls in their history.
- **HQ**: same dialer and banner in the HQ shell; HQ Calls page under HQ Communications (CL3).

## 4. How a call works (Twilio Voice, browser)

- **Credentials (CL2, 0561)**: per school subaccount, HON creates an API key (`SK…`, secret sealed with the 0351 vault,
  own label) and a TwiML App (`AP…`) whose Voice URL is HON's fixed `/v1/communications/webhooks/twilio/client-voice`.
  Created by a worker only with `HON_VOICE_CALLS_APPROVED=true` and an ACTIVE subaccount. HQ uses the parent account's
  key and app from environment settings.
- **Browser phone token**: `POST /v1/schools/:schoolId/calls/phone-token` (staff with `communication.call.use`, ACTIVE
  school, in-window entitlement, ACTIVE sender, calling on). Returns a 1-hour Twilio access token (JWT HS256 signed with
  the sealed key secret) with identity `u<principal id without dashes>` and a Voice grant (outgoing app = the school's
  TwiML App, incoming allowed only when "Ring me" is on). Never returns the secret or the subaccount SID.
- **Outgoing**: the browser first asks HON to start a call: `POST /v1/schools/:schoolId/calls` `{toE164, personId?,
  idempotencyKey}` → HON records an `INITIATED` outgoing call (checks below) and returns `callId`. The browser then
  connects with only `{ HonCallId }`. The signed client-voice webhook re-reads the call row: same school subaccount,
  caller identity = the staff member who started it, `INITIATED`, under 2 minutes old, used once; it returns
  `<Dial callerId="school number" answerOnBridge="true" action=dial-result>` to the number **stored on the row** (the
  browser can never choose the number at the provider). Checks at start: +1 US states and Canada only (the NANP
  Caribbean and territory codes such as 876, 809/829/849, 268, 473, 787/939 are refused as international or high-cost),
  not 900/976/premium, personal (5XX), carrier, government or reserved (N9X) codes, not the school's own number, a
  linked contact's phone must be the number dialled, not a number marked "Do not call" for that school, at most 60 outgoing calls per staff per hour.
  Deploy: Twilio Voice geographic permissions on each school subaccount set to United States and Canada only, as a
  second layer behind this check.
- **Incoming**: the existing 0249 voice webhook, when calling is on: records a `RINGING` incoming call, then
  `<Dial timeout=20 answerOnBridge=true action=voice-result>` with one `<Client>` per staff member who has "Ring me" on
  (max 10), plus the forwarding phone when set. First to answer wins (Twilio cancels the other legs). No answer,
  busy or nobody set to ring → **voicemail**: greeting, `<Record maxLength=120>`; recording status callback stores the
  voicemail. Calling off → today's 0249 behaviour unchanged.
- **Status**: signed status callbacks (`call-status`, `dial-result`, `recording-status`) move the call through
  `INITIATED/RINGING → IN_PROGRESS → COMPLETED | NO_ANSWER | BUSY | FAILED | CANCELED | VOICEMAIL | MISSED`. Each
  callback is idempotent per call SID + status; an older status never overwrites a newer one.
- **Missed-call text back** (0249) still fires for an unanswered incoming call (also when it reached voicemail).
- **Playback**: voicemails and recordings are played through HON (`GET .../calls/:id/recording`), which fetches the
  media from Twilio with the parent credentials and streams it; Twilio URLs are never sent to the browser.

## 5. Records (CL1, 0556)

- `hon.school_calling_settings` (one per school): calling_on, voicemail_greeting (<= 300 chars, plain text),
  recording_on, recording_ack_by/at (who accepted the consent statement), version.
- `hon.school_call_staff` (per school + staff principal): ring_me boolean, version.
- `hon.school_calls`: school, direction IN/OUT, status, school_number, remote_e164, person_id (matched by the
  school's people phone, or chosen at start), staff_principal_id (who started / answered), provider_call_sid
  (unique), idempotency key (unique per school + staff), started/answered/ended, duration_seconds, voicemail (bool),
  recording_sid, recording_seconds, recording_status, heard_at, outcome (closed list), note (<= 1000), version.
- `hon.school_call_events`: append-only status history (provider event id unique).
- `hon.school_do_not_call` (school + E.164): set from the call log or contact; checked on every outgoing start.
- FORCE RLS on all; runtime has no table grants; staff reads/commands via definer functions with permission checks
  (`communication.call.use` for calling, log, voicemail, outcome; `communication.call.manage` for settings, granted to
  system OWNER roles); webhook writes via worker-only definer functions. Audit + outbox
  `communication.call.completed` / `communication.call.missed` / `communication.voicemail.received` (Automation can
  use later).

## 6. Recording and consent

US law: federal and most states need one party's consent, but California, Florida, Illinois, Maryland, Massachusetts,
Montana, New Hampshire, Pennsylvania, Washington and others require **everyone** on the call to consent; Canada needs
notice. A school cannot know where each caller is. So:

- Recording is **off by default**. Only a school owner can turn it on, after accepting a plain statement ("Every
  recorded call will start with a short notice. You are responsible for following recording laws where you and your
  callers are."), recorded with who and when.
- When on, **every** recorded call plays a notice to the other person before connecting ("This call may be recorded."
  in the school language): incoming before the Dial, outgoing to the called person when they pick up (`<Number url>`).
  Staff see a red "Recording" badge. No notice → no recording.
- Voicemails are recorded because the caller chooses to leave one (the greeting says so).
- Recordings and voicemails are kept 90 days, then deleted at Twilio and marked deleted in HON (owner default; can be
  changed later). Only staff with `communication.call.use` at that school can play them; every play is audited.

## 7. Cost and switches

Twilio charges per minute (browser leg, phone leg, recording, storage) in the school's subaccount, so cost is already
split per school. Cost lines per call are recorded for HQ visibility like texting (0243 / T4). **Owner decision (David, 2026-11-19 05:19Z card): call minutes are
included like texting; HON pays Twilio, the cost is recorded per school for HQ, never capped.**

Switches: `HON_VOICE_CALLS_APPROVED` gates key/app creation, real tokens and real TwiML for client calls. Without it the
token endpoint answers `CALLING_NOT_AVAILABLE`, the Calls page shows "Calling isn't switched on yet" (never a fake
working screen), incoming calls keep 0249 behaviour. The fake Twilio voice client and fake browser phone work only in
test/local environments (same production refusal as the 0243 fake provider).

## 8. Pieces (small PRs, tests first)

| PR | Contents | Migration |
| --- | --- | --- |
| CL1 | Records + definer functions (§5): settings, ring-me, start outgoing, record incoming/status/voicemail, call log + voicemail reads, outcome/note, do-not-call, heard; permissions; DB proof | 0556 |
| CL2 | Voice credentials: sealed API key + TwiML App per subaccount, worker (switch-gated), token minting; fake Twilio voice client | 0561 |
| CL3a | API: phone token, start call, log/voicemail/settings endpoints, webhooks (client-voice, call-status, dial-result, recording-status), 0249 voice webhook routing to browsers + voicemail, recording playback proxy | none |
| CL4 | Web: top-bar Call button + dialer panel, incoming banner, after-call card, Calls page (log / voicemail / settings), contact Call button, `CallButton` for Texts; fake phone for tests and screenshots | none |
| CL5 | HQ calling on the HQ number (parent account), HQ Calls page | 0562 |
| Later | Transcription, voicemail drop, IVR, round robin, transfers, cost lines (with T4) | — |

Each PR: unit tests + DB proof (tenant isolation, permission, idempotency, status ordering, toll-fraud checks), web
component tests with the fake phone, screenshots (Modern 1440, phone 390, Big Button) in `/mnt/project-files/calling/`,
independent review, squash on GO + green CI (standing approval). No deploy.

## 9. Security rules

- Never trust the browser for the number dialed at the provider: only the stored call row.
- Webhooks verified per subaccount token (0351), `To`/`From` must be that school's ACTIVE sender number.
- Token identity is bound to one staff member and one school; a token from school A can't start or answer school B's calls.
- No secrets, numbers or names in logs; call SIDs only.
- Calling stops (new calls refused, tokens not issued) when the school is suspended, the entitlement lapses, the sender
  is disabled or calling is off; calls in progress end naturally.
