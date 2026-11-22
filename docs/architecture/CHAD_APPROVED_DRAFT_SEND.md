# Chad approved-draft send (P7, migration 0647)

Status: spec + build, 2026-11-22. Owner decision (David, 2026-11-22 07:13Z): **"Send automatically once approved"**, with verbal
approval allowed. It replaces Chad's "Send or schedule a follow-up message: Backend required" line in the Ask HON roster.
Design notes: `/mnt/project-files/ai-agents-switch-on/P7_P8_SEND_APPROVED_DRAFTS.md`.

## What it does

1. Chad writes a follow-up draft for a lead (0107/0108, unchanged). It waits for a second staff member's approval.
2. **Before review**, the person who asked for the draft may set a **send plan**: text or email (or "don't send"), and now or a time
   up to 30 days ahead. The lead's contact must have OPTED_IN consent on that channel at this school and an address for it.
   Plans are append-only and versioned; the newest counts; "don't send" is a plan with channel NONE.
3. A reviewer with `action.approve` (never the requester) approves by button, or by voice. In the **same transaction** as the
   approval, `hon.transition_chad_follow_up_draft` (0108 body unchanged, then the new step) checks consent and address again and the
   cap (at most 3 approved-draft messages per contact per 24 hours), then queues **one** `communication_messages` row:
   `lifecycle QUEUED`, `scheduled_at = max(plan time, now)`, `origin_kind AI_APPROVED_DRAFT`, `origin_id` the draft, created and
   queued by the reviewer, the draft's text (and subject for email).
4. The existing delivery worker (0243/0248) sends it at its time with its own checks: consent and address again at send time
   (a contact who replied STOP after approval is suppressed), school status, quiet hours, sender readiness, retries.
5. Before the worker claims it, the requester or the approver may **cancel** it (message → CANCELLED).

Nothing is sent without a plan and an approval. A draft with no plan behaves exactly as before 0647. A denial queues nothing.

## Evidence: who approved, when, how

`hon.ai_draft_sends` (one row per draft at most, PK source+source_id): `outcome` QUEUED | NO_CONSENT | NO_ADDRESS | DAILY_CAP,
`message_id`, `channel`, `scheduled_at`, `approved_by`, `approved_at`, `approval_method` BUTTON | VOICE, `voice_turn_id`
(required for VOICE), `plan_version`, and `cancelled_by/at` (set once). Audit events `chad.follow_up_draft.send_plan_set`,
`.send_queued` (actor = reviewer, with method) and `.send_cancelled`; none holds the message text.

`approvalMethod` and `voiceTurnId` are optional fields on the ordinary decide body (`HumanActionDecision`). The action engine
puts them in transaction-local settings (`app.hon_approval_method`, `app.hon_voice_turn_id`) just before the Chad transition.
VOICE needs a uuid `voiceTurnId` and decision APPROVED. **The voice turn id is evidence, not authority**: the decision is still
the authenticated reviewer's own decide call with the exact review binding; the id records which voice exchange the reviewer's
own client reports. Linking it to a stored transcript is follow-up work for the voice approval UI.

## API

All under `staff/leads/assistant` (same guard and scope as Chad drafts):

| Route | Who | Body |
| --- | --- | --- |
| `POST :id/send-plan` (Idempotency-Key) | requester, while AWAITING_APPROVAL | `{channel: 'SMS'\|'EMAIL'\|'NONE', sendAt: ISO-ms-UTC \| null}` |
| `GET :id/send` | requester, the approver, or (while awaiting approval) anyone with `action.approve` | |
| `POST :id/send/cancel` | requester or approver, before the worker claims it | `{}` |

Errors: `CHAD_SEND_PLAN_INVALID` (400), `CHAD_SEND_PLAN_NO_CONSENT`, `CHAD_SEND_PLAN_NO_ADDRESS`, `CHAD_SEND_PLAN_CLOSED`,
`CHAD_SEND_NOT_CANCELLABLE`, `IDEMPOTENCY_KEY_REUSED` (409), `FOLLOW_UP_DRAFT_UNAVAILABLE` (404).

## Security boundary

- Both new tables: forced RLS, no policies, no runtime access; guard trigger makes plans immutable and send rows change only by
  one cancel. Runtime executes only the three entry points and the (already runtime) transition.
- The approval boundary changes on purpose: an approval of a Chad draft with a plan now creates a communication. That is the
  owner's decision. The self-review ban, exact payload binding and expiry checks of the action engine are unchanged.
- The proposal payload still says `delivery: NOT_CREATED_OR_SENT` (it is the immutable reviewed content). The send plan is shown
  beside it on the review screen.
- Delivery stays with the worker; this code never calls a provider.

## Web

- Chad workbench: "Send once approved" (how / when / save; after approval: what happened, cancel).
- Approvals: for a Chad draft the plan is shown with the draft. A reviewer needs Chad access to read it.
- Voice approval UI (saying "approve" / "send it") is not in this PR; the API accepts it. The HON Staff app thread owns staff-app voice.

## Proof

`packages/database/scripts/test-chad-approved-draft-send.mjs` (CAS1, 11 groups) on a fresh AI-0 fixture with the real API
services and the runtime role. It also calls the worker claim function directly to show STOP after approval is suppressed.
