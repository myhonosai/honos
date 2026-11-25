# Maya check-in drafts that send once approved (P8, migration 0649)

Owner decision 2026-11-22: "Send automatically once approved", with approval by button or by voice. Staff approve a draft and it
queues and sends at its scheduled time through the school's usual consent, STOP and quiet-hour checks. HON records who approved,
when and how.

## Flow

1. **Ask.** On the at-risk list (`/staff/retention/at-risk`), a staff member presses *Draft a check-in with Maya* for one student and
   picks text or email, with an optional note. `POST /api/v1/organizations/:org/schools/:school/maya/check-ins` (human command
   `maya.check_in.request`, Idempotency-Key required).
   - `hon.begin_maya_check_in_draft` refuses unless the student is on the 0259 at-risk list **now**, read as the asking person
     (`MAYA_CHECK_IN_NOT_AT_RISK`).
   - Maya receives only: channel, note, school name, school-local date and the verified at-risk numbers (level, score, membership
     state, suggested next step, factors). Tuition factors are removed. No name, email, phone, plan code or amount.
   - One paid text call on the shared AI text proposal table (0550), with S4 spend controls and the per-school ceiling. Usage is
     attributed to `RETENTION`. The kind's task class is `ANALYZE`, because 0284 keeps every Maya plan to `ANALYZE`.
2. **Review.** The requester sees the summary, the editable message (and subject for email), who can receive it (the student, and the
   billing contact when that is a different person) with reachability (consent plus address), and *now* or *at a set time*.
   `[First name]` in the draft becomes the recipient's first name when queued.
3. **Approve** (`POST …/:id/approve`, `maya.check_in.approve`): by the button (`BUTTON`) or by saying "approve" / "send it" while the
   draft is on screen (`VOICE`, with a fresh voice turn id). `hon.approve_maya_check_in_draft`:
   - requester only, draft must be `RESULT_RECORDED`; closed body; message re-checked (length, no links); send time at most 30 days out;
   - re-checks consent and address for the chosen person (`MAYA_CHECK_IN_NO_CONSENT` / `MAYA_CHECK_IN_NO_ADDRESS`);
   - the shared cap: at most 3 `AI_APPROVED_DRAFT` messages per person in 24 hours, across Chad and Maya, under the same advisory
     lock as 0647 (`MAYA_CHECK_IN_DAILY_CAP`);
   - inserts one `QUEUED` `communication_messages` row (origin `AI_APPROVED_DRAFT`), one `maya_check_in_sends` row (approver,
     time, method, voice turn, whether staff edited the text, idempotency key and request hash), and an audit event with no text;
     then closes the draft `APPLIED`. An exact retry replays.
4. **Send.** The ordinary delivery worker sends it. It still checks consent, STOP and quiet hours at send time, so a STOP after approval
   stops the message (`SUPPRESSED`).
5. **Cancel** (`POST …/:id/cancel`, `maya.check_in.cancel`): the requester can cancel until the worker claims it. A send row changes
   only by that one cancel.

Dismiss: `POST …/:id/close` with `{ "status": "DISMISSED" }`.

## Permissions

Maya (0259 direct-human rules and Complete) plus `communication.message.queue` at the session school to read or approve; plus
`ai.invocation.plan` to ask. Drafts are the requester's own. Nothing is reachable from another school. Non-human sources are refused.

## Evidence

`packages/database/scripts/test-maya-check-in-draft-send.mjs` (MCI1, 12 groups) on the disposable AI-0 fixture with a counted fake
provider; `apps/api/test/maya-check-in.test.cjs`; `apps/web/test/maya-check-in-ui.test.tsx`; the 0649 section of
`infra/postgres/011_verify_supabase_hon_runtime.sql`.

## Not changed

No live AI is switched on by this change: the paid route still needs `OPENROUTER_PAID_CALL_APPROVED` on the server and a
deploy. No message provider, sender or consent rule changed.
