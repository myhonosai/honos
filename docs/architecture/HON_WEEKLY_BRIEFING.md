# HON weekly briefing (migration 0257 settings, 0258 dispatcher)

Status: spec + plan, 2026-11-11. Owner: "Instead of call let's do sms and email and its optional."
Comms-stream guidance (2026-11-11 09:48Z) is folded in.

## Goal

Each Monday morning, school time, a short summary of the school's numbers is sent to staff who opted in, by email and/or
text. It is built from the Command Center facts with **no AI call**, it is off by default, and every recipient can turn
it off. Nothing sends until the email/SMS providers are connected and `HON_EMAIL_SEND_APPROVED` /
`HON_SMS_SEND_APPROVED` are on.

## Slice A: 0257, buildable now (email settings and preview; nothing is sent)

- **Settings, per school:** `enabled` (default false) and the send hour (default 8, allowed 6-11, school time, Mondays).
  Changed only by the OWNER (`ai.school_briefing.manage`, owner only). Idempotent by key, audited with values only.
- **My briefing, per staff member:** an email switch for themselves only, sent to their own account email. Turning it on
  needs `reporting.view` at the school (the Command Center permission), because the briefing shows those numbers. No
  lead, family or student is ever a recipient. SMS is reserved: it comes in 0258 with phone verification by code, which
  needs texting to work first.
- **Builder:** `hon.school_briefing_email(metrics, school name)` is a pure fixed template over the Command Center facts.
  Counts only, never names; a metric that is not available reads "not available yet". The closing line explains how to
  stop.
- **Preview:** `read_school_briefing_preview` shows the reader's own email exactly as it would look today, built from
  `read_school_command_center` with the reader's own authority. It sends nothing.
- **Web:** a "Weekly briefing" card on the full HON workspace: the owner's on/off switch and hour, "Email me", and the
  preview.

## Slice B (0258): the dispatcher, after the comms PRs merge (#223 0243, SendGrid, 0248, 0249)

- Weekly issue rows (PENDING/SENDING/ACCEPTED/FAILED/UNKNOWN, lease columns, unique per school, week, recipient and
  channel), the scheduler, and SMS subscriptions with a verified phone (code sent by text).

- Own definer `claim_school_briefing_issues` / `record_school_briefing_result` (lease, quiet hours 21:00–08:00 school
  time for SMS, at most 3 attempts, expired lease → UNKNOWN, never retried). Granted only to `hon_communication_worker`
  in infra 013. Own system principal.
- Rechecks at claim time: school and organization ACTIVE, setting enabled, subscription still on, recipient still staff
  with the permission, address still verified.
- The send goes through `CommunicationProviderAdapter.send` with `statusCallback: false`, in lease-sized batches like
  `MissedCallTextBackDispatcher`. SMS comes from the school's ACTIVE `school_text_senders` row. Email carries the
  internal-purpose custom_arg that the SendGrid verifier acknowledges and ignores.
- Does not touch `communication_consents`, the 0243 delivery and receipt tables, or the existing worker function
  signatures.

## Owner decisions (defaults used)

- Day and time: Monday 08:00 school time, editable hour.
- Content: new leads, trials, testing events, renewals due, unanswered inquiries, attendance trend, revenue (counts
  only).
- Who may subscribe: any staff member with the Command Center permission (reporting.view), for themselves only; anyone can always turn their own email off.
- Texting cost: follows the open comms Decision 4 (who pays for texting).
