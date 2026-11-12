# Sale-day and event slot booking (B-SCH-3, migration 0261)

Status: spec and plan, 2026-11-11. Asked for by the owner after a competitor's "RSVP your rush" post: a school runs a
one-off day (Black Friday sale, open house, belt test, picture day) and families book a time slot so the day is not a
stampede. Number 0261 was assigned by the coordinator.

## What the scheduler could not do before

- Class sessions need a program, and only staff can book an enrolled student (`hon.class_bookings`).
- The only unauthenticated write is the public lead form (0075). Nothing lets a family pick a time.

## Rules (v1, free bookings only)

- **E1 Event.** A one-day event in school time: title (1-120), optional description (up to 500) and place (up to 120),
  a local date from today to 365 days ahead, an opening and a closing time, a slot length (10-240 minutes) and the
  spots per slot (1-500). Staff with the existing `schedule.session.manage` permission create and edit it as a DRAFT.
  A multi-day sale is one event per day.
- **E2 Publish.** Publishing makes the time slots (each slot fits inside opening to closing, at most 96; a time that
  does not exist on a daylight-saving day is skipped and reported) and turns on the public link
  (`/book/<48 hex>`). After publishing, the date and times are fixed; text and spots per slot can still change, but spots
  never go below the most-booked slot.
- **E3 Close or cancel.** Closing stops new bookings and keeps the list (families can still cancel). Cancelling the event
  shows families "this event was cancelled" on the link. HON sends no messages: staff contact families themselves.
- **E4 Family booking.** No account. The family gives a name and an email or a mobile number (E.164), and picks a slot that
  has a spot and has not started. **One booking per family per event**: the same email or the same mobile number cannot
  hold two live bookings. The family gets a booking code (shown once, `XXXX-XXXX-XXXX`). A retry with the same request key
  returns the same code; nothing is booked twice.
- **E5 Family cancel.** The booking code cancels the booking and frees the spot. To change the time, cancel and book again.
- **E6 Staff view.** Staff see each event with booked and open spots per slot and, per slot, who is coming (name and
  contact). Staff can cancel a booking or mark a family as arrived.
- **E7 Limits.** Public reads show only open spots, never names. Per event at most 1,000 booking attempts and 300 cancel
  attempts an hour; per email or mobile at most 5 booking attempts an hour. No message, no charge, no CRM lead, no AI, no
  student record. Paid bookings come later through the tuition payments work.

## Security boundary

- Staff writes: direct human commands only, through `hon.require_class_series_actor` (live `schedule.session.manage` at
  the exact school, paid access, no family/HQ roles), with exact-request idempotency, audit and an inert outbox event.
- Public writes: a code-owned SYSTEM_SERVICE principal (`...0261`) with no roles, like the 0075 lead form. The event must be
  PUBLISHED, its school and organization ACTIVE, and the organization's entitlement live. Rate limits live in the database.
- The runtime gets EXECUTE on the entry points only, never a table privilege. All four tables use forced RLS.
- Contact details are stored only on the booking row; audit and outbox carry ids only.

## Plan

1. **PR 1 (this branch): database, contracts, API.**
   - `0261_school_event_booking.sql`: tables `school_events`, `school_event_slots`, `school_event_bookings`,
     `school_event_rates`; guard triggers; staff functions `read_school_events`, `read_school_event`,
     `save_school_event`, `set_school_event_status`, `set_school_event_booking_status`; public functions
     `read_public_school_event`, `book_public_school_event`, `cancel_public_school_event_booking`.
   - Contracts in `packages/contracts/src/school-events.ts` with validators shared by the API and web.
   - API: `organizations/:org/schools/:school/schedule/events...` (staff) and `public/events/:publicId` (+ `/bookings`,
     `/cancellations`) behind a strict transport like the lead form.
   - Proof `test-school-event-booking-integrity.mjs` over signed HTTP; 010/011 pins; staging pins.
2. **PR 2: web.** Staff "Events" page (create, publish, see who is coming, cancel/arrived, copy link, print poster) and the
   public `/book/<id>` page (pick a time, book, see the code, cancel with the code). en/ko/es.
3. **Later (owner call):** QR code on the poster, staff booking on behalf of a family, booking creates a CRM lead for open
   houses, paid slots, reminder messages once messaging is live.
