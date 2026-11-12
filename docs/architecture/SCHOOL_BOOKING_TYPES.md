# School booking types (migration 0286)

Status: spec and plan, 2026-11-12. The owner asked that Settings let a school make its own kinds of booking, for example
"reservation for a test, 2nd trial, just a parent meeting", with pages it can customize. Owner decisions on 2026-11-12:

- **"Branded pages"**: the school's logo, color, cover photo and contact line come from 0285 and are set once. Each booking type
  has its own text, questions, waiver, thank-you message and link/QR/embed. This is not a layout or page builder.
- **"Owner picks per type"**: each booking type is either an **open link** (anyone with the link) or **current families only**.

The coordinator assigned number 0286. It sits next to 0261 (one-off event days). A booking type is the repeating kind: it has
weekly hours and stays open until the school pauses it.

## Rules (v1, free bookings only)

- **T1 Type.** Staff with `schedule.session.manage` create a type as a DRAFT. A type has:
  - name (1-80) and an optional description (up to 500);
  - a template label: `TEST_RESERVATION`, `SECOND_TRIAL`, `PARENT_MEETING` or `OTHER` (it sets defaults and a label only, never behavior in v1);
  - length (10-240 minutes) and spots per time (1-50);
  - weekly hours: 1 to 14 windows of weekday plus local start and end, in school time, with no overlaps;
  - how far ahead families can book (1-90 days) and minimum notice (0-168 hours);
  - audience `OPEN` or `FAMILIES_ONLY`;
  - up to 5 questions (label 1-120, `TEXT` up to 300 characters or `YES_NO`, required or not);
  - an optional waiver (up to 4,000 characters) that the family must tick;
  - a thank-you message (up to 500).
  At most 20 types per school that are not archived.
- **T2 Status.** DRAFT → ACTIVE (bookable, link on) ↔ PAUSED (link shows "not taking bookings") → ARCHIVED (final). Edits keep
  the version moving by exactly 1. Changing the hours, length or spots never cancels a booking that already exists. Lowering the
  spots is refused if any future time already holds more bookings than the new number.
- **T3 Times.** Times are worked out when asked, not stored. They start at each window's start and step by the length,
  and each one must end by the window's end. They run from now plus the notice to the end of the horizon. A local time
  that does not exist on a daylight-saving day is skipped. One read returns at most 400 times.
- **T4 Open booking.** On an `OPEN` type, with no account, the family gives a name, an email or a mobile number (E.164),
  answers the required questions, ticks the waiver if there is one, and picks a time that still has a spot. **One live
  booking per contact per type**: the same email or mobile number cannot hold two future bookings of the same type. The family
  gets a booking code (`XXXX-XXXX-XXXX`, shown once) and the thank-you message. A retry with the same request key returns the
  same code.
- **T5 Families only.** A `FAMILIES_ONLY` link shows the type and "for current families: sign in to book" and refuses public
  booking. Booking from a family sign-in comes in PR 3 (below).
- **T6 Cancel.** The code cancels the family's own booking and frees the spot. To change the time, the family cancels and books
  again.
- **T7 Staff view.** Staff see the upcoming bookings per type with each family's name, contact, answers and waiver time. Staff
  can cancel a booking or mark the family as arrived.
- **T8 Limits.** Public reads show only open spots, never names. Per type, at most 600 booking attempts and 300 cancel
  attempts an hour. Per contact, at most 5 booking attempts an hour. No message, no charge, no AI. In v1 a booking also
  creates no CRM lead, appointment or student record.

## Security boundary

- Staff writes are direct human commands only, through `hon.require_class_series_actor`. That means live
  `schedule.session.manage` at the exact school, paid access, and no family or HQ roles. The authority check runs again after
  the locks. Each write has exact-request idempotency, audit and an inert outbox event (ids and version only).
- Public writes run as a code-owned SYSTEM_SERVICE principal (`...0286`) with no roles, like 0261. The type must be ACTIVE and
  `OPEN`, its school and organization ACTIVE, and the organization's entitlement live. Rate limits live in the database.
  Capacity is checked under an advisory lock per (type, time), so two families cannot take the last spot.
- The waiver is stored as the exact text hash plus the accepted time on the booking. A later waiver edit never changes
  what an earlier family accepted.
- Contact details and answers are stored only on the booking row. Audit and outbox carry ids only. All tables use forced RLS,
  and the runtime gets EXECUTE on the entry points only.

## Plan

1. **PR 1: database, contracts, API.** Migration `0286_school_booking_types.sql` adds three tables:
   `school_booking_types` (+ `_versions`), `school_booking_type_bookings` and `school_booking_type_rates`.
   - Staff functions: `read_school_booking_types`, `save_school_booking_type`, `set_school_booking_type_status`,
     `read_school_booking_type_bookings` and `set_school_booking_type_booking_status`.
   - Public functions: `read_public_school_booking_type` (returns the times and the 0285 branding), `book_public_school_booking_type`
     and `cancel_public_school_booking_type_booking`.
   - Contracts go in `school-booking-types.ts`.
   - Routes: `…/settings/booking-types` (staff) and `public/booking-types/:publicId` (public).
   - Proof: `test-school-booking-types-integrity.mjs`, plus the 010/011 and staging pins.
2. **PR 2: web.** Settings › Booking types lets staff create, edit, activate, pause, archive and see bookings, copy the link,
   get a QR code and copy an embed snippet. The public `/book/t/<id>` page shows the school branding, lets the family pick a day
   and time, answer the questions and accept the waiver, then shows the thank-you message and the code. Families can also cancel
   with the code. Text is in en/ko/es.
3. **PR 3: families only, staff booking and 2nd trial.** This covers family-session booking for `FAMILIES_ONLY` types and
   staff booking on behalf of a family. A `SECOND_TRIAL` booking made for a known CRM lead also creates the trial
   appointment through the existing `crm.trial.schedule` path, with its per-lead lock order unchanged.
4. **Later (owner call):** paid bookings through tuition payments, reminders once messaging is live, and a booking calendar
   feed.
