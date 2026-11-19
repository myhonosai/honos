# Texts and Email pages (spec, TE series)

Owner request (David, 2026-11-19 04:59Z): "Text and email set up is terrible. Even though my current CRM is not the best, it
has a better layout design than this. Text and email should be separate pages with different tabs for history and
template. Look at my current CRM and follow, but better code and better design." Also: "there is a lot that is mismatched
in aesthetics" (dark shell with light cards).

Status: SPEC. Reference: David's current CRM (Manus, Operations > Communications), studied 2026-11-19 in his browser
plus his 7 screenshots. That CRM puts everything on one page with 11 tabs (SMS / Quick Send, SMS Conversations, FB/IG
Messenger, Email Campaign with Compose / Templates / Campaign History, Call Log, Templates, Message History, Student
Messages, Scheduled, Unsubscribes). David wants texts and email split into two pages, each with its own tabs.

What we keep from it: dark page with one accent colour and pill tabs; audience chips with live counts (All active
students, All contacts, Prospects, Trial, Former, Individual contact) and tag chips; a "Recent campaigns" column beside the
composer; Insert (merge tag) / Template / Emoji row above the message box with a character counter; a big primary
"Send to N" button with Schedule beside it; the two-pane conversations inbox with chat bubbles (staff and AI replies on
the right) and "Open contact"; template cards with "Use in composer", edit and delete; history cards with outcome counts
(accepted, delivered, skipped, failed, not delivered, read shown as unavailable) and a Campaign / Individual switch; an
Unsubscribes list with "Record email unsubscribe". What we improve: no 11-tab row, no wall of fine print, raw HTML never
shown in template previews, one consistent component kit, phone layout, and every send through HON's governed queue.

## 1. Audit of main (1bbd6c8, 2026-11-19)

| Area | Today | Problem |
| --- | --- | --- |
| Communication > Texts & email (`/staff/family-messages`, `staff-family-inbox.tsx`) | One long light page: "New text or email" (search box, Find button, radio Text/Email, textarea, confirm checkbox, Send), then "Family messages" (parent app chat). | Texts and email mixed; no history; no templates; no email subject; parent-app chat is a different thing on the same page; search-then-click-Find flow; light card inside dark shell. |
| AI > Conversation AI > Conversations (`/staff/conversations`, 0364) | Two-way texts with the school number. Filters row (Status select, Unread checkbox, Search, Apply, Refresh), then a list, then the open conversation below it. | Single column: list and thread stacked, so a reply means scrolling; no contact panel; lives under AI, not under Communication. |
| Sent messages | `GET .../communications/messages` (0047) lists the school's messages: ids only, no names, no delivery status, no search, max 100, no paging. Per-person history exists only on the contact card (0424). | No school-wide "what did we send and did it arrive" page. |
| Templates | None for staff messages. Automations (0423) and blasts (#489, 0536) keep their own text. | Staff retype the same text every time. |
| Email subject | Column `communication_messages.email_subject` exists (0423); the one-to-one staff command does not accept it, so staff emails go out with the standard subject. | Staff cannot write a subject. |
| Group sending | Blasts BL1 (#489, 0536, Marketing > Blasts, not merged yet): audience by group/tag, merge tags, schedule, results. | Reuse, do not duplicate. |
| Inbound email | Not wired (0364 accepts an EMAIL channel, nothing writes it). | Email page has no inbox in this series; replies go to the school's reply-to address. |
| Look | Most workbench pages use `testing-registration.module.css` on the light `:root` tokens (`--surface:#f5f7fb`), inside the dark school shell. Newer pages (Lead pipeline, Commerce) are dark. | Two looks in one app. |

## 2. Target

### Menu (Communication heading)

`Texts` · `Email` · `Social` (unchanged). Conversation AI under the AI heading keeps **Train AI** and its settings; its
inbox moves to Texts > Conversations. Old routes redirect: `/staff/conversations` -> `/staff/texts`,
`/staff/family-messages` -> `/staff/texts/app`. Call log and FB/IG Messenger are not part of this series (Social keeps
FB/IG; a call log page can follow once calls are recorded).

### Texts page (`/staff/texts`), tabs

1. **Conversations** (default). Two panes on desktop (list | thread), a slide-in contact panel, one pane at a time on
   phone. List: live search (name, number, message), chips All / Unread / Not linked / Closed, rows with name, number,
   preview, time, unread dot, "Not linked" badge. Thread: header with name, number, Mark read, Close, Open contact;
   "Linked to: name" bar with Change / Unlink (0364 link command); bubbles (contact left, staff and AI right, AI marked);
   composer pinned at the bottom with Template, Merge tag, character and segment counter, Send.
2. **Send.** Left: composer. Audience chips with counts (One person, Active students, All contacts, Prospects, Trial,
   Former) and tag chips; One person shows a type-ahead (no Find button) with the number and texting consent inline;
   message box with Insert merge tag, Template, Emoji, counter; live preview bubble filled from the first recipient;
   "Send to N" and Schedule. Right: Recent sends (last 10, status chip). One person uses the 0047 create + queue; a group
   is the BL1 blast (#489) mounted with channel SMS, not a second implementation.
3. **History.** Switch Group sends / One-to-one. Group sends: one card per blast with its text, audience, date, sender
   and outcome tiles (accepted, delivered, skipped, failed, not delivered; read "not available"). One-to-one: table of
   every other text (staff, automation, Conversation AI) with search, status and source filters, date range, Load more;
   a row opens a drawer with the full text and the 0243 receipt timeline.
4. **Templates.** Card grid of text templates: name, preview, "Use in Send", edit, archive. Editor in a side drawer with
   merge tag picker and a live preview.
5. **Scheduled.** Group sends waiting for their time, with Cancel (BL1 cancel).
6. **Opted out.** Contacts who replied STOP or whose texting consent is OPTED_OUT, with date, source and Open contact.
7. **Parent app.** The family-messages chat (0330) in the same two-pane layout; replies stay inside HON.

### Email page (`/staff/email`), tabs

1. **Send.** Left: From (school sender, read-only), Subject (with merge tag insert), body, Template, Merge tag,
   "Send to N", Send test to me, Save as template, Schedule. Right: Recipients list with counts (as Texts) and Recent sends.
   Body is plain text in this series; formatted email (bold, links, pictures, logo and social footer) is a later piece
   that waits for BL3 media and safe HTML email.
2. **History.** As Texts, with Subject; the drawer shows the email as sent and **Resend** (0424).
3. **Templates.** As Texts, plus Subject. Previews show plain text, never raw HTML.
4. **Scheduled.** As Texts.
5. **Opted out.** Email opt-outs, plus "Record an email unsubscribe" (find contact, records OPTED_OUT email consent with
   the existing consent command).

### Look

- New pages are built on the shell's `--hon-*` tokens (the "Make the app look consistent" thread owns the app-wide token
  adapter, spec SCHOOL_APP_CONSISTENT_LOOK_SPEC.md; this series does not touch shell CSS).
- A small shared kit for these pages (`comms-kit`: PillTabs, SplitPane, ListRow, Bubble, Drawer, Chip, StatTile,
  TemplateCard, Composer, EmptyState) so Texts and Email look the same and later pages can reuse it.
- Modern / Classic / Big Button kept (owner, 2026-11-16): Big Button gets one pane at a time with large controls.

## 3. Backend changes

| Piece | Change | Migration |
| --- | --- | --- |
| TE1 history read | `hon.read_school_message_history(subject, p jsonb)`: school-wide, SECURITY DEFINER read under `communication.message.read`; filters channel, status, source (STAFF / AUTOMATION / CAMPAIGN / CONVERSATION_AI), search (name, phone, email, escaped ILIKE), date range; keyset paging 50; returns recipient name, the recipient address, subject, preview (first 160 chars), delivery state (0424 `contact_message_delivery_state`), source, sender display name. Excludes DRAFT and demo people. One message detail read reuses 0424 for the drawer. | yes (number from coordinator) |
| TE1 opted out | `hon.read_school_opted_out_contacts(subject, p jsonb)`: contacts whose latest consent for a channel is OPTED_OUT (0046, STOP 0248), with date and source, under `communication.message.read`; keyset paging. Recording an email unsubscribe uses the existing consent command. | same migration |
| TE1 email subject | Staff one-to-one create accepts optional `emailSubject` (EMAIL only, 1-150, no control chars), stored in the existing column; the worker already sends it (0424). | same migration if the create path is SQL, else API only |
| TE2 templates | `hon.school_message_templates` (school, channel SMS/EMAIL, name unique per school+channel among active, subject for EMAIL, body: SMS 1,000 / EMAIL 3,500, merge tags = BL1 closed list, version, archived_at). Commands create / update by exact version / archive / restore; read list. Permissions `communication.template.read` and `communication.template.manage` (staff-assignable, OWNER default). Exact-request idempotency, audit, inert outbox with ids only, forced RLS, EXECUTE-only runtime grants. | yes (number from coordinator) |

Merge tags in one-to-one messages are filled in the browser from the chosen contact before the draft is created, so the
preview is exactly what is stored and sent; the server stores plain text as today. Group sends render on the server (BL1).

## 4. Pieces and order

1. **TE1** backend: history read + staff email subject (migration A).
2. **TE2** backend: templates (migration B).
3. **TE3** frontend: comms kit + Texts page (Conversations over 0364, Send one person, History, Templates, Opted out,
   Parent app), menu change and redirects.
4. **TE4** frontend: Email page.
5. **TE5** group sends: mount the BL1 composer, group history cards and Scheduled tab after #489 merges (coordinate
   with the blasts thread; Marketing > Blasts then links here).
6. Later: formatted email (after BL3), call log page.

Each piece: tests first (unit + DB proof for TE1/TE2, component + browser check for TE3/TE4), screenshots in
`/mnt/project-files/texts-email/`, independent review, squash on GO + green CI (standing approval). Nothing here sends
anything new: sending still goes through the 0047 queue and the 0243 worker with its consent, STOP, quiet-hours and
sender checks. No deploy.

## 5. Open questions for David

- Parent-app chat as a tab on Texts (proposed) or its own page.
