# School email and text blasts (BL1, migration 0621)

Owner request (David, 2026-11-18): staff send an email or text blast with a checkout page link, merge tags and pictures or
video. Audit and the full three-piece plan: `/mnt/project-files/blasts/BLAST_COMPOSER_AUDIT_AND_SPEC.md` (project files).
This document is the spec for piece 1. Piece 2 (checkout link) waits for the public checkout page, and piece 3 (media library,
email pictures, video page) waits for media storage.

Owner decisions: 2026-11-15 (automation design 5.7) blasts are the campaign path. Audiences are chosen by group and tag and
deduplicated per household, and a results card reads the 0243 receipts. 2026-11-18: pictures go in email only, video is sent as a link,
texts stay plain SMS (no MMS).

## What piece 1 does

Marketing > Blasts (`/staff/marketing/blasts`):

1. **Write.** A name, the channel (email or text), an email subject, and the body. Body limits: email up to 3,500 characters and text up to 1,000 characters.
   Merge tags (closed list): `{{first_name}}`, `{{last_name}}`, `{{school_name}}`, `{{staff_name}}`. Anything else in
   `{{ }}` is refused when saving. An empty first name renders as "there" and an empty last name as nothing. `staff_name` is the display name of
   the person who sends the blast.
2. **Choose who gets it.** One to five groups, `ACTIVE_STUDENTS`, `PROSPECTS` (open leads), `TRIAL` (open leads with a
   scheduled or completed trial), `FORMER_STUDENTS` (a past membership, none active) and `ALL_CONTACTS`, optionally narrowed
   to people carrying any of up to 10 contact tags.
3. **See the count before sending.** The database resolves the audience the way it will send:
   - A child (a STUDENT or DEPENDENT family member with a guardian, unless a student birth date shows 18 or over) is always
     reached through the guardians in their families who have an address, and also at their own address when they have one
     and are opted in (David's decision, 2026-11-18). Anyone else without an address is replaced by their guardians if they have any.
   - Archived or merged contacts (an open `school_contact_archives` row, 0523) never get a blast, as recipient or guardian.
   - The list is deduplicated by address (one message per phone number or email, so one per household).
   - People without OPTED_IN consent for the channel are skipped (NO_CONSENT). People with no address and no guardian address are skipped (NO_ADDRESS).
     Duplicates are skipped (DUPLICATE_ADDRESS). Demo-data people are never included.
   - The answer gives the counts and a preview of the first recipient's rendered message.
4. **Send now or schedule.** Up to 60 days ahead. Sending writes one QUEUED `communication_messages` row per reachable
   recipient with `origin_kind = 'CAMPAIGN'`, `origin_id = blast id`, the rendered subject and body, and `scheduled_at`. The
   existing 0243 worker delivers them with its own consent, STOP, quiet-hours and sender checks. Nothing in this piece talks
   to a provider, and the deployment send switches stay off.
5. **Cancel a scheduled blast** before its time. Its messages without a delivery become CANCELLED.
6. **Results.** Per blast: recipients by outcome, and queued messages by delivery status (waiting, pending, sending,
   accepted, delivered, bounced, failed, suppressed, unknown). "Read" is never shown.

## Rules

- Permissions (staff-assignable, OWNER by default): `marketing.blast.read` (list, detail, audience count) and
  `marketing.blast.send` (sensitive: save, send, cancel). Direct human only (HUMAN_USER, HUMAN_UI, no action request or
  delegation). Active school and organization, live ESSENTIAL/CORE/COMPLETE access. The actor is proved again after the locks.
- Blasts are versioned. A DRAFT is edited by exact version. QUEUED and CANCELLED blasts are final (no edits).
- Caps: at most 2,000 reachable recipients per blast (more is refused with BLAST_AUDIENCE_TOO_LARGE, so narrow the audience),
  and at most 10 blasts handed over per school in any 24 hours (BLAST_DAILY_LIMIT), counted under a per-school lock.
- Every command has exact-request idempotency, an audit row and an inert outbox event with ids only (no addresses or
  text). Recipient rows are append-only. The runtime gets no table privilege, only EXECUTE on the entry points.
- AI help writing a blast is not part of this piece. When it is added, an AI-written blast needs a second person's approval
  (David 2026-11-15).

## Pictures in email blasts (BL3b, migration 0653)

Owner decisions (David): 2026-11-18 "Email pictures, video as a link"; 2026-11-22 "Allow media storage". Pictures come from
the school's media library (BL3a, `docs/architecture/SCHOOL_MEDIA_LIBRARY.md`).

- **In the composer.** An email has a Pictures row: Insert picture opens the school's READY pictures (read with
  `marketing.media.read`) and puts the chosen one on its own line where the cursor is. The pictures already in the email are
  listed with Remove. The audience sample and a sent blast show each picture in place. Texts have no pictures.
- **In the body.** A picture is a whole line `{{picture:<assetId>}}` (lower-case id), at most 10 per email. For the 0621
  plain-text rules each picture line counts as one character, and the body is still at most 3,500 characters. The table
  check `school_blasts_body_ok` (`hon.school_blast_body_ok`) replaces the 0621 body check; `@hon/contracts`
  `schoolBlastBodyOk` mirrors it.
- **Save and send** both check that every picture is a READY picture of the same school, else `409
  BLAST_PICTURE_NOT_READY` and nothing changes. Each queued message keeps the picture lines; merge tags are filled as before.
- **The worker.** The claim also reads `hon.communication_email_pictures(delivery, lease)`, runnable only by
  `hon_communication_worker`. It answers only for the lease holder of a SENDING email delivery of a CAMPAIGN message of an
  EMAIL blast, and only READY pictures of that school whose id is in the blast body: id, link token, title and size, never a
  storage key. It answers nothing (text only) for a blast without pictures and for any other email.
- **The email.** With pictures, SendGrid gets a text part, where each picture line becomes `<HON_PUBLIC_ORIGIN>/m/<token>`,
  and an HTML part from a fixed template: escaped paragraphs, and each picture as an image of that link, at most 600 pixels
  wide, with its title as alt text. A picture line that matches no listed picture (deleted since sending, or produced by a
  merge tag) is dropped. Open and click tracking stay off. If `HON_PUBLIC_ORIGIN` is not set, the email is retried later and
  never sent half-built. HQ mail never gets pictures.
- **Staff history** shows a sent blast message with its picture lines as text.

Evidence: `packages/database/scripts/test-school-blast-pictures-integrity.mjs` (`db:test-school-blast-pictures`),
`apps/api/test/school-blast-pictures.test.cjs`, `apps/web/test/school-blast-pictures-ui.test.tsx`.

## Later pieces

- **BL2:** `{{checkout:<slug>}}` for a LIVE checkout page of the school, checked at save and at send, plus per-recipient
  attribution tokens.
- **BL3c (0654):** video: resumable uploads up to 5 GB, a thumbnail, a hosted video page with the approved 720p playback copy,
  shown in email as a thumbnail that opens the page and sent in a text as a link.
- Belt-rank audience filter, contact-list segments (with the contacts list work), and AI-written blasts with approval.
