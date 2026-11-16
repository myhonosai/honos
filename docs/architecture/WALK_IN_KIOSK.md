# Walk-in kiosk: quick intake, waiver, day pass or trial (WK)

Status: spec and plan (2026-11-16). Nothing built yet. Test/sandbox payments only.

Owner request (David, 2026-11-16, screenshot of Classes > "ClassPass & walk-in"): "This meant to be kiosk style quick
intake form and waiver and day pass or trial purchase." Today the Classes area has two technical staff screens:

- `/staff/classpass` (0117-0121): manual, nonfinancial passes typed in by exact UUID.
- `/staff/kiosk` + `/kiosk` (0122/0125/0126): a staff-assistance handoff where staff paste 43-character bearer values.

Neither is what a school needs at the front desk. This spec replaces both screens in the Classes tabs with one
**Walk-in kiosk**: a school tablet that a visitor uses on their own to fill a short form, sign the school's waiver and
pick a day pass or a trial class, then pays (or is told to pay at the desk). The old tables and functions stay (no
destructive change); their screens move out of the tabs.

## 1. What the visitor sees (tablet, Modern / Classic / Big Button, EN / KO / ES)

1. **Welcome.** School logo and name (0285 branding), "Welcome! New here? Tap to start", language buttons.
2. **Who is training?** "Me" / "My child" / "Me and my child(ren)". Up to 4 people.
3. **Quick details.** For each participant: first and last name, date of birth. Contact adult: first and last name,
   mobile, email (one of the two required), relationship for children. Emergency contact name and phone (optional,
   school can make it required). "How did you hear about us?" (optional, fixed list). An **unticked** box "Text and email
   me school news" (marketing consent is never pre-ticked or bundled with the waiver).
4. **Waiver.** The school's waiver text in the chosen language (falls back to English with a line saying so). The
   visitor scrolls, types their full name, signs with a finger, and ticks "I have read and agree". For anyone under 18
   the signer must be the adult contact acting as parent or legal guardian.
5. **Choose.** The school's kiosk offers (for example "Day pass $25", "Free trial class", "2-week trial $49"). A trial
   may let the visitor pick one of the next classes that accept trials; a day pass is for today.
6. **Pay.** Free offers skip this. Paid offers: pay on the tablet (see 3.3) or "Pay at the front desk".
7. **Done.** "Thanks, Alex! Please see the front desk." The screen clears itself after 20 seconds or on "Finish", and
   returns to Welcome. Nothing the visitor typed stays on the device.

No search, roster, names of other people, schedule attendee counts or "welcome back" lookup is ever shown on the tablet.
A returning visitor fills the form again; staff merge duplicates with the existing Merge tool.

## 2. What staff see (`/staff/kiosk`, tab "Walk-in kiosk")

- **Start kiosk on this tablet.** A signed-in owner/admin taps "Start kiosk", chooses until when (end of today, or 4 / 8
  / 12 hours) and the page switches to the visitor screen. Leaving kiosk mode needs a staff sign-in again (the visitor
  screen has no menu, no back to staff pages).
- **Today's walk-ins.** Name(s), offer, waiver signed time, payment status (Free, Paid on tablet, Pay at desk, Paid at
  desk), link to the new lead. Staff can mark "Paid at desk" (cash/card outside HON) and open the signed waiver to
  view or print.
- **Kiosk settings** (owner): turn the kiosk on, waiver text (EN required, KO/ES optional), emergency contact required
  or not, where new leads go (pipeline and stage), the offers (name, Day pass or Trial, price, short description, EN/KO/ES,
  up to 6), and which tablets are running (end any of them).
- The old technical ClassPass and handoff screens leave the Classes tabs. Their routes stay reachable for existing
  links, under Settings > Advanced; nothing is deleted.

## 3. Design

### 3.1 Tablet sessions (replaces the bearer paste)

- `hon.walkin_kiosk_devices`: one row per started tablet: school, started by (human principal), started/ends at (max
  12 hours), ended at/by, label. The device token is 32 CSPRNG bytes generated **server-side** and returned once to the
  staff browser that started it; only its SHA-256 digest is stored.
- The staff page that started kiosk mode keeps the token in memory only and swaps to the visitor screen in the same
  page. A reload, tab close or the end time ends the tablet's use; staff start again. No token in URL, cookie or
  storage (the 0122 posture).
- Start and end are direct-human commands (`walkin_kiosk.run`, OWNER and ADMIN system roles) with the usual live
  re-checks, idempotency, audit and outbox. Owner settings use `walkin_kiosk.manage` (OWNER).

### 3.2 Intake, waiver and visit (one public call)

`POST /api/v1/walk-in-kiosk/visits` with body `{device: <token>, visit: {...}}` and an `Idempotency-Key` (the token travels in the body, never a header, URL or cookie; `POST /api/v1/walk-in-kiosk/terminal` with `{device}` reads the tablet's settings). Same public
endpoint posture as 0122 (no cookies/Authorization, JSON only, same-origin, fixed errors). The database function runs as a
code-owned SYSTEM_SERVICE principal (the 0075/0286 shape) and, in one transaction:

1. Checks the device digest is live for an active, entitled school whose kiosk is on; rate-limits per device.
2. Validates the form against the school's current kiosk settings version, waiver version and offer version.
3. Creates `hon.people` rows (contact adult + participants), one `hon.crm_leads` row (source `WALK_IN_KIOSK`, the
   school's chosen pipeline/stage), and records the optional marketing opt-in through the existing consent records.
4. Writes one append-only `hon.walkin_waiver_signatures` row: waiver version, language, SHA-256 of the exact text shown,
   signer name as typed, relationship, participants covered, drawn signature as bounded vector strokes (max 16 KB), time,
   device id. Signatures are never edited or deleted.
5. Writes one `hon.walkin_visits` row: lead, offer (frozen name/kind/price/currency), optional trial session, payment
   state `FREE`, `PAY_AT_DESK` or `AWAITING_PAYMENT`.
6. Writes audit (ids only) and an inert outbox event.

The response holds only the visit id, the first participant's first name for the thank-you line, the payment state, and
(for tablet payment) the data the card form needs. A retry with the same key and body returns the same answer.

### 3.3 Paying on the tablet (sandbox only)

Uses the school's default processor connection from tuition collection (0258/0320), TEST mode only (the database
already refuses LIVE). No platform fee. HON never sees card numbers.

- **Stripe Connect:** a Checkout Session `mode=payment`, `ui_mode=embedded`, on the school's connected account, one line
  item with the frozen offer price, idempotency key from the visit. The tablet shows Stripe's embedded form in the page,
  so kiosk mode is never left.
- **Square:** the Web Payments SDK card form (sandbox) tokenizes the card; the API calls `POST /v2/payments` on the
  school's seller account with the visit's idempotency key. Uses only the scopes already granted (`PAYMENTS_WRITE`).
- **Result:** the API confirms with the provider (Stripe session retrieve / Square payment response) before the visit
  becomes `PAID_ON_TABLET`; a lost answer becomes `PAYMENT_UNKNOWN` and is reconciled, never assumed. A refused card
  lets the visitor try again or choose "Pay at the front desk".
- No school processor connected, or the provider not configured: only "Pay at the front desk" is offered.
- New environment names (owner sets them; never in chat): `HON_TUITION_STRIPE_TEST_PUBLISHABLE_KEY` (`pk_test_` only).
  Square uses the existing sandbox app id plus the school's location from the connection status.

### 3.4 Trial class pick

A trial offer can list the school's next scheduled class sessions (up to 14 days) whose program the owner ticked for
trials, showing only class name, day and time and "spots open" (yes/no). Picking one schedules the trial through the
existing CRM trial command path (`crm.trial.schedule`, 0107 shape) as the kiosk service principal, inside the visit
transaction; a full class shows as unavailable.

## 4. Safety rules

- The tablet can only **create** a new walk-in. It can never read people, leads, students, bookings or payments.
- Every public input is bounded and validated in the database; text rules match 0261/0286 (no angle brackets or
  control characters).
- Signatures, visits and people rows are school-scoped, forced-RLS, no runtime table privilege; definer functions only.
- Children's data: date of birth is collected only to apply the under-18 waiver rule and is stored on the person row
  the way staff-entered students are.
- No AI, message, automation, live payment, refund or provider call outside 3.3. Payment code refuses non-test keys.

## 5. Pieces (small PRs, each with tests)

| # | Piece | Migration | Contents |
| --- | --- | --- | --- |
| WK1 | Kiosk settings, tablet sessions, intake + waiver + visit | 0414 | Tables, permissions, settings/offer/waiver versions, start/end tablet, public visit submit (FREE / PAY_AT_DESK), today's walk-ins, mark paid at desk, signed waiver read, DB proof, API, contracts. |
| WK2 | Kiosk screens | — | Visitor flow (3 themes, EN/KO/ES, signature pad), staff kiosk page + settings, Classes tab change (old screens to Settings > Advanced). Browser screenshots at phone/tablet/desktop. |
| WK3 | Pay on the tablet (sandbox) | 0397 | Stripe embedded Checkout + Square card form, confirm/reconcile, PAID_ON_TABLET / PAYMENT_UNKNOWN, simulators for tests. |
| WK4 | Trial class pick | maybe | Trial-eligible sessions read + CRM trial scheduling inside the visit. |

## 6. Open owner items

1. How walk-ins pay: **decided (David, 2026-11-16, "Can you do both of these")**: pay on the tablet with the front desk
   as backup, **and** a QR code so the visitor can pay on their own phone. Both test mode only. The QR opens a
   provider-hosted checkout page (Stripe Checkout `ui_mode=hosted`; Square through the same card-form page hosted by HON
   at a one-time, short-lived link) and the kiosk waits for the confirmed result. Built in WK3.
2. Real Stripe publishable test key for WK3 (owner sets in Project settings).
3. The waiver wording is the school's own text; HON ships a plain sample marked "have your lawyer review".
