# Maya: students at risk (M1, migration 0259)

Maya is the retention specialist of the school AI team. Part 1 is a read-only list of the current school's students at
risk of quitting, each with the record-derived reasons, a 0-100 ranking score, a level and one suggested next step.
No AI is called, nothing is sent and no record changes. Part 2 (0262, separate PR) adds Maya's explanation and an
outreach draft that staff approve.

## Route

`GET /v1/organizations/:organizationId/schools/:schoolId/retention/at-risk[?after=<score>:<membershipId>]`

- Browser only (`MayaAtRiskReadHumanUiGuard`): no `X-Hon-Source`, Action Engine or delegation headers, no cross-site
  fetch, no Idempotency-Key. The scope comes from the verified session for `retention.review.read` at the route school.
- `hon.read_maya_at_risk_students(subject, {after?})` re-proves the direct human, the live permission at the exact
  school, active organization/school and an active COMPLETE entitlement (HON OS, which includes the AI team; the same
  gate as Claire 0229 and the 0210-0212 agents; a legacy Essential/Core-only school is refused) before and after the read.

## Rules

| Factor | Rule | Points | Suggested next step |
|---|---|---|---|
| LONG_ABSENCE | not paused; last attended 14+ days ago (45 at 30+), or never attended 14+ days after joining | 30/45 | Call to check in |
| ATTENDANCE_DROP | not paused; 4+ classes 28-56 days ago and the last 28 days under half of that | 25 | Invite back to class |
| TUITION_OVERDUE | ISSUED invoice of the membership, or of its billing account with no membership, past due with a balance after 0240 payment records | 20 | Review tuition balance |
| TERM_ENDING | cancellation pending, or the term ends within 30 days | 20 | Discuss renewal |
| NO_RANK_PROGRESS | active curriculum enrollment 180+ days old and no PROMOTED decision in 180 days | 15 | Plan a progress talk |

Attendance counts PRESENT, LATE and MAKEUP at sessions that have started. Score = sum (max 100); HIGH >= 50,
MEDIUM 30-49, WATCH 15-29. The first factor (most points, then the order in the table) gives the suggested step.
Day windows are fixed 24-hour multiples, so daylight-saving changes do not move them. One row per student: when a student
holds more than one checked membership, the highest-scoring membership is shown.

Tuition is billing data: it is evaluated only when the reader also passes the 0240 tuition reader rule
(`hon.require_tuition_reader`: `billing.invoice.payment.record`, `billing.invoice.issue` or `billing.invoice.create`) (`tuitionChecked`).
A school with an invalid timezone gets 409 `SCHOOL_TIMEZONE_INVALID`.

The list is recomputed on every page, so a student whose score rises while staff page through may appear only after Refresh.

## Output and privacy

Given and family name, membership state, score, level, factors with their numbers and the suggested step. No email,
phone, family, notes or amounts. 50 rows per page, highest score first; counts per level cover the whole school.

## Security boundary

Runtime gets EXECUTE on the one read; `require_maya_actor` and `maya_reader_sees_tuition` are private. The read has
no DML. 010 grants and an 011 exact-verification section pin the three function bodies.

## Evidence

`packages/database/scripts/test-maya-at-risk-integrity.mjs` (signed HTTP on the disposable CRM-close fixture), API test
`apps/api/test/maya-at-risk.test.cjs`, web test `apps/web/test/maya-at-risk-ui.test.tsx`.

Screen: `/staff/retention/at-risk`, in the AI team menu as "Maya: students at risk".

## Part 2 (0284): Maya explains a risk and suggests a check-in message

Each at-risk row has an "Ask Maya" button. It opens one Ask HON conversation ("Maya: student check-in") and sends one
turn with delegation `{ agentKey: 'maya', membershipId }`. Maya is the fifth 0260 analysis specialist (Complete only,
`retention.review.read`, task class ANALYZE, DETAILED single step, HQ pause, budget lock and UNKNOWN handling unchanged).

- `begin_hon_turn` refuses a membership that is not in the signed-in school (`INVALID_HON_TURN`).
- `read_specialist_school_facts` (new 5-argument form; the 4-argument form is a wrapper) gives Maya only that
  membership's row from `read_maya_at_risk_students`: state, score, level, factors and the suggested step, or
  `onAtRiskList: false`. **No name, contact detail, family, note or amount reaches the provider.** Tuition factors are
  included only when the asker is a tuition reader, and the reply is concealed from a reader who lost either permission
  (`source_permissions`).
- The prompt asks for why the student is flagged, what to do, and a short message that starts "Hi [First name],".
  The browser fills the placeholder for the staff member who already sees the name. The reply never states the score,
  level or flag.
- Maya never sends anything. Staff copy the message and send it themselves; no message, record or campaign is created.
- Provider: the same HON reply runtime as the other analysts. On main it is not configured, so Maya shows as not
  available; tests use the fake provider only.

Evidence: AI-0 invariant INV-37 in `test-ai-spend-authority-baseline.mjs` (facts, no-name check, foreign membership
refusal, concealment, lapse BLOCKED, readiness), API test `hon-conversation.test.cjs` (0284 Maya), web test
`apps/web/test/maya-ask-ui.test.tsx`.
