# Calendar cards: click to create, drag to move, resize (0567)

Owner ask (David, 2026-11-19): "i need this calendar to be clickable and let me make schedule or class cards that can be drag and dropped", plus "also need filters". The reference is the ease of a modern scheduling calendar (GoHighLevel, Google Calendar), adapted rather than copied. The coordinator allocated migration **0567**.

## Spec

**Objective.** On Classes > Calendar (`/staff/schedule`), a manager clicks an empty time in Week or Day view and creates a card: a class, a private lesson, a trial class or an event, with a title, program, instructor, time, length and whether it repeats weekly. Cards can be dragged to another time or day, and dragging the bottom edge changes the length. The calendar can be filtered by program and instructor as well as by class.

**Who.** Creating, moving and resizing need the existing `schedule.session.manage` permission at the current school (the same as the Roster page). Everyone with `schedule.session.read` sees the card details (kind, program, instructor, booked count). No new permission.

**Card kinds.** `CLASS` (default for every existing class), `PRIVATE_LESSON`, `TRIAL`, `EVENT`. The kind is a label and colour on the card; booking, attendance and capacity rules are unchanged. Sale days and events from the Sale days & events page stay as they are (the Events row).

**Create (one command, all or nothing).** Fields: kind, title (1-120), program (required, an active program of this school), instructor (optional; an active, eligible staff member of this school), school-local date and start time, length 5-600 minutes, room (optional), capacity 1-1000, booking (walk-in, optional, required), and repeat.
- *Does not repeat:* one class at that time. It must start in the future.
- *Repeats weekly:* a Roster (the 0239 class series) on the chosen weekdays from that date, until an optional last date, with the kind and instructor. Its classes are created at once from that date through 12 weeks ahead (the 0239/0251 fill limit) in the same transaction. The date's own weekday is always included.
- Every class the roster creates later (fill, ongoing top-up) gets the roster's kind and instructor.

**Move and resize (one command).** New start and end instants, with the version the page last read.
- Only a SCHEDULED class that has not started, whose new start is in the future, is 5 to 600 minutes long, and has no attendance recorded.
- A class with booked students can be moved; the page asks first ("N students are booked. They are not notified."). Nothing contacts families.
- Moving one class of a Roster moves only that class and detaches it from the Roster's pattern: a later change to the Roster never moves it back.
- A stale version is refused (someone else changed it); the page reads again.

**Calendar interactions.**
- Week and Day: click an empty hour to open the create form at the clicked quarter hour, 60 minutes long (Enter or Space on an empty hour opens it at the start of that hour). The "Add a class" button opens it at the next whole hour today.
- Drag a card by its body to another time or day (15-minute steps); drag its bottom edge to resize. While dragging, a ghost shows the new time. On drop the change is sent; the card shows the new time when the server confirms, and goes back with a short message if it is refused. Escape cancels a drag. A click without movement opens the side panel as before.
- Keyboard: a focused card moves with Alt+Arrow Up/Down (15 minutes) and Alt+Arrow Left/Right (a day), and resizes with Alt+Shift+Arrow Up/Down.
- Cancelled, completed, started, attended or unmanageable cards cannot be dragged.

**Filters.** The Filter menu gains Program and Instructor groups (from the card details read) next to Classes. Choices in different groups combine with AND; several choices in one group with OR. "No instructor" is a choice.

**Reads.** One new read, `hon.read_school_calendar_cards(subject, {from, to})`, for school-local dates at most 42 days apart: for each class starting in the range (at most 1000) its version, kind, program id and name, roster id, lead instructor (id and display name only) and booked count; plus `canManage`, and when the caller can manage, the school's programs and the staff who can be picked as instructor (id and display name only, the 0404/0467 name rule). No email, contact or role is returned.

**Out of scope.** Editing a card's title/program/instructor after creation (use the Roster page for repeating classes), copy/paste, multi-select drag, month-view drag, notifying families, calendar settings, block-out dates and shareable calendars (0552).

**Security.** Direct human commands only (HUMAN_UI, no delegation or action request), exact current school and organization from the tenant transaction, live entitlement, forced RLS, definer functions with an EXECUTE-only runtime ACL, idempotency key with exact replay and key-reuse refusal, row lock and version check, audit and outbox with identifiers only, authority checked again after the last write. The runtime keeps no UPDATE on class sessions.

**Success.** A DB proof over signed HTTP covers create one-off and weekly (with fill and inherited kind/instructor), move, resize, every refusal, replay, detachment from a later Roster revise, the read's permission split and cross-school isolation. Web unit tests cover snapping and drag maths, the form, the filters and the view. Browser proof with screenshots. `pnpm test`, `check`, `build` pass.

## Plan

1. Migration 0567: columns (`class_sessions.session_kind`, `class_series.session_kind`, `class_series.lead_instructor_principal_id`), private `class_session_roster_detachments`, the occurrence trigger that copies kind and instructor, `class_series_apply_future` skipping detached classes, `create_calendar_card`, `move_calendar_card`, `read_school_calendar_cards`; 010/011 sections; checksums and staging pins.
2. Contracts: input validators and receipt/read verifiers.
3. API: controller routes under `schedule/calendar`, human UI guards, service with exact error mapping.
4. DB proof script and run-db-proofs entry.
5. Web: `calendar-cards` http client, drag/resize/snap maths (pure, tested first), create form, view wiring, filters, en/ko/es copy.
6. Browser proof and screenshots; full web test, check, build; review.
