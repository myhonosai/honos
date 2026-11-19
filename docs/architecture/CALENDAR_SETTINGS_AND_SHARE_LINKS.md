# Calendar settings: block-out dates, share links and QR codes (0583)

Owner request (David, 2026-11-19): Classes > Calendar gets a Settings tab like his Manus CRM, with Programs, Block-out Dates,
Share Links and QR Codes. Share Links are public calendars a school can link to or embed: one per program, or a group of
several programs under one link. Each has an on/off switch, a copyable link, copyable iframe embed code, edit and delete. The
public page shows the school's name, address and phone, then "Choose a calendar" cards (age range, number of upcoming class
times), then that calendar's class times. Migration number 0583 was allocated by the coordinator.

Online booking from a shared calendar is a separate owner decision (asked 2026-11-19) and a separate PR. Until it lands, a
public calendar shows the times and the school's phone number to call; it never writes anything.

## Rules

- **S1 Calendar settings.** One row per school: the public address (up to 200 characters) and phone (up to 40), both optional,
  with a version raised by one on every save. Shown on every shared calendar of the school, with the 0285 branding
  (logo, accent, contact line) when it is set.
- **S2 Block-out dates.** A block-out is a label (1-80) and a first and last school date (last >= first, span at most 62 days,
  last not before today). At most 100 future or current block-outs per school. Removing one is final (REMOVED). A block-out
  never cancels, moves or refuses a class: it marks the days closed on the staff calendar, asks before a new class is added or
  a class is moved onto such a day, and hides that day's classes from every shared calendar.
- **S3 Share calendars.** A share calendar is PROGRAM (one program of the school, an optional age range 0-99) or GROUP
  (2-20 PROGRAM calendars of the same school). Name 1-80, description up to 300, enabled on/off. A public id of 48 hex
  characters is made once and never changes. Delete is final (DELETED): the link stops working and a group drops it.
  At most 40 calendars that are not deleted per school. Every change raises the version by one.
- **S4 Staff authority.** Every read and write re-proves the direct human subject and live schedule.session.manage at the
  school (hon.require_class_series_actor) and checks it again after the last write. Writes are idempotent per actor and key
  (hon.class_series_command_begin), audited and put on the outbox. The block-out read for the calendar uses the class-session
  read actor, so instructors who can see the calendar can see closed days.
- **S5 Public read.** `GET /v1/public/calendars/:publicId` answers only for an enabled, not deleted calendar of an active
  school and organization with a live entitlement (the 0286 rule). It returns a whitelisted projection: school name, address,
  phone, branding, the calendar's name and description, and either
  - for a GROUP: its enabled, not deleted PROGRAM members as cards (public id, name, description, age range, number of
    upcoming class times), or
  - for a PROGRAM: up to 200 class times in the next 28 days that are SCHEDULED, not started, not on a block-out day, of a
    non-demo program, each with name, start, end, room and open spots (capacity minus seats taken, the 0538 count).
  No student, family, instructor, booking or staff data is returned. Unknown, disabled and deleted ids all answer 404 the same way.
- **S6 Transport.** The public path accepts GET only, no query string, no body, the per-client limiter shared with booking
  types, and `Cache-Control: no-store`. The page may be embedded in an iframe on any site (it holds no session and no
  writes), and the web app sets no frame restriction on it.
- **S7 QR codes.** The settings page draws a QR code for each share link in the browser (the same encoder as the walk-in
  kiosk), with a download as SVG. Nothing is sent anywhere.

No message, charge, CRM lead, student record, booking or AI. Nothing here deploys or turns anything on.

## Plan

1. Migration 0583: tables `calendar_share_settings`, `calendar_block_outs`, `share_calendars` (forced RLS, no runtime
   table privilege, guard triggers for immutable identity and final states), commands `save_calendar_share_settings`,
   `save_calendar_block_out`, `remove_calendar_block_out`, `save_share_calendar`, `set_share_calendar_status`, reads
   `read_calendar_settings`, `read_school_calendar_block_outs`, `read_public_share_calendar`. 010 grants, 011 hashes,
   verify-rls entries, DB proof `test-calendar-settings-integrity.mjs`.
2. Contracts and API: staff controller under `.../schedule/calendar/settings`, public controller `public/calendars`,
   strict transport.
3. Web: a Settings tab on Classes > Calendar (Programs link, Block-out Dates, Share Links with link, embed code, QR,
   edit, delete, on/off), closed days on the calendar, and the public page `/calendars/[publicId]`.
4. Unit tests, browser proof with screenshots, full test/check/build.

## Closed days for families (0584)

Owner decision (David, 2026-11-19, decision card "Hide from families only"): a class whose school-local start date is inside
an ACTIVE block-out of its own school is not offered to families, while staff keep the 0583 warn-and-continue behaviour.

- Parent app (0329 `hon.parent_class_booking_session_ok`): the choices read leaves the class out and booking it is refused with
  `PARENT_CLASS_BOOKING_NOT_OFFERED`, writing nothing. Existing bookings stay, and families can still cancel them.
- Kiosk trial (0538 `hon.walkin_trial_session_open`, `hon.walkin_trial_classes`): the tablet does not list the class and a submit
  naming it is refused like any unavailable class (`CLASS_FULL`, nothing written).
- Public shared calendar: already hides block-out days (0583).
- Unchanged: staff booking, the staff calendar, ClassPass, owner-launch first class, school events and booking types.
- Private helper `hon.class_session_on_closed_day(hon.class_sessions)` uses the session's own school and time zone. Signatures
  are unchanged, so ACLs stay; 011 pins the new bodies (0329 section hash and a 0584 section).
- Proof: closed-day checks added to `test-parent-class-booking-integrity.mjs` (section 4b) and
  `test-walk-in-kiosk-trial-seats-integrity.mjs` (section 2b, plus the 0584 011 section).
