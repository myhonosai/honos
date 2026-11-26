# Staff choose phone alerts per send (0658)

Owner request (David, 2026-11-23): "I want all push notifications be optional. Like announcement, text." Clarified:
**staff** decide, not parents. This builds on parent announcement push (0601, `PARENT_ANNOUNCEMENT_PUSH.md`).

## Spec

- **S1 Announcements.** The staff Announcements composer has an "Also send as a phone alert" tick box, **unticked by
  default**. Only an announcement posted with the box ticked is pushed (0601 used to push every announcement). An
  announcement posted without it shows in the HON Family app as before and never pushes, even later.
- **S2 Parent app messages.** The staff reply box in Parent app messages (0330) gets the same tick box, unticked by
  default. A ticked reply pushes to the live phones of that family's members only: title = school name, body = "You have
  a new message from the school." The message text never goes in the notification (it can be private and lock screens
  show it). Tapping opens the app's Messages tab.
- **S3 Server is the authority.** The choice travels in the command body as `phoneAlert: true|false` (absent = false, so
  older browsers keep working and never push). The database records a private push request row only when it is true; the
  worker fans out only requested items. Same-key replay with a different choice is `IDEMPOTENCY_KEY_REUSED`.
- **S4 Unchanged safety.** Sending still needs the owner switch `HON_PARENT_PUSH_APPROVED=true` (off; turn-on is part
  of the combined deploy David holds). Requests older than 24 hours are never sent. Same leases, retries, receipts,
  UNKNOWN-never-resent, let-go phones and not-live people as 0601. A family member who lost their grant to the family is
  SKIPPED (NOT_LIVE). Nothing is texted or emailed.
- **S5 Wording.** The Announcements page no longer says "not sent as a phone alert"; it says alerts go only when the box
  is ticked, to families who use the app and allowed notifications. Texts and email are unchanged (they already reach the
  phone; no push needed).

Out of scope: bookings and reminders (no push source yet), a school-wide default setting, iPhone delivery (APNs not set
up), showing per-item "alert sent" on the staff list.

## Plan

1. `0658_parent_push_staff_choice.sql`: `hon.parent_push_requests` (private, forced RLS, immutable except
   `fanned_out_at` once); deliveries gain `message_id` (exactly one of announcement/message); guard and claim function
   generalized (claim returns `push_kind`, `announcement_id`, `thread_id`); `publish_school_announcement` and
   `reply_family_message` accept `phoneAlert` and write the request + an audit row. 010/011/013 updated.
2. Contracts: `phoneAlert` optional on the two inputs; `ParentPushData` gains `school_message`.
3. API: services pass `phoneAlert`; worker sends `school_message` data.
4. Web: tick boxes + wording. Parent app: a message tap opens Messages.
5. Tests: contract unit tests, worker unit test, DB proof extended (`test-parent-announcement-push.mjs`).
