# Parent account: booking and messages

Status: spec and plan, 2026-11-13. The owner asked for no idle time on finishing the product. The coordinator assigned
"parent account bookings and messages": parents book class or event slots and message the school from their account.
Small PRs, independent review, migration numbers from the coordinator, no deployment.

## Who may act

A parent acts through the existing parent sign-in: `resolve_parent_journey_scopes` must return exactly one live family
grant, and it is re-checked after the locks. Only `PRIMARY_GUARDIAN` and `SECONDARY_GUARDIAN` may book, cancel or write;
`VIEWER` may read. The school and organization must be ACTIVE and the entitlement live. A family role never gains staff
power and a staff role never acts as a parent. Every write has exact-request idempotency, audit and an inert outbox event
(ids and version only).

## PR A: book classes from the parent account (0329)

- **A1 Choices.** A guardian sees, for each child of the family, upcoming class sessions in the next 14 days that:
  are SCHEDULED, have a booking policy of `OPTIONAL_BOOKING` or `REQUIRED_BOOKING` (never `WALK_IN`), belong to a program
  the child has an active enrollment in, and start after now. Each shows the open spots, never other students.
- **A2 Book.** The guardian books one child into one session. It uses the existing session lock (0118), so capacity is
  never exceeded and the same child is never booked twice. The booking is `REGULAR`, `source = PARENT_APP`.
- **A3 Cancel.** The guardian may cancel a `PARENT_APP` booking of their own child until the session starts. A staff-made
  booking is cancelled only by staff.
- **A4 Event slots and families-only booking types (later PR, needs its own number).** The guardian can book a 0261 event slot or a 0286
  `FAMILIES_ONLY` booking type with the family's details filled in from the account, with the same capacity and
  one-booking rules as the public path. (This is booking types part 3's family path.)

## PR B: messages between a family and the school, inside HON (0330)

- **B1 Threads.** One conversation per family and school. A guardian writes a message (1-2,000 characters, plain text).
  Staff with the new staff-assignable permission `family_messages.manage` read every family thread of their school and
  reply to it. It is granted to the system OWNER role (the only system role), and the owner can add it to any staff role.
  Staff reply to existing threads; starting a thread from the school side is a later PR. VIEWER parents read only.
- **B2 Inbox.** Staff see threads newest first with an unread count. Opening a thread does not mark it read; "Mark read"
  and a reply move the staff read mark up to the newest message the staff member loaded, never past it, so a family
  message that arrives after the load stays unread. The parent
  sees the school's replies in the Messages page, as "the school", never with a staff name.
- **B3 No outside delivery.** Nothing is texted or emailed. A later PR may send a "you have a new message" notice through
  the existing 0243 worker once messaging providers are approved and live.
- **B4 Limits.** Per family at most 30 messages an hour; per school at most 600. Message text is stored only on the
  message row; audit and outbox carry ids only.

## Not in scope

Payments, reminders, SMS or email, AI drafting, and any change to staff booking or attendance.
