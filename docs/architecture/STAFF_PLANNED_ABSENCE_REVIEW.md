# Direct-human planned absence review

## Delivered boundary

`/staff/attendance/planned-absences` is an authenticated, dynamic, no-index workbench linked from the existing attendance workbench. Authentication alone is not authority: the selector-free queue API resolves the verified subject to **exactly one current human staff/school scope**, requires `schedule.planned_absence.review` on a permitted school role and an active effective Essential/Core/Complete entitlement. A second live school (even without review permission), additional active identity, any HQ grant, current family access or mixed parent/guardian/student/family/HQ/system/platform role is disqualifying. There is no directory, school picker, arbitrary request lookup, history, count, cursor or export.

Additive migration `0144_staff_planned_absence_review_queue.sql` creates four fixed functions only. It does not change tables, policies, indexes, permissions, grants on source tables or lifecycle enums from 0038/0039. The bounded function reads at most **50 currently SUBMITTED records**, oldest submission first with request ID tie-break. Items contain only request ID, student profile ID, start/end timestamps, nullable original submitted reason, current version (used as expected version) and submitted timestamp. Organization/school IDs in the envelope bind the returned snapshot to the independently resolved current scope; no principal/reviewer/family/name/contact facts are returned. A full 50-item snapshot is not a total, and the UI never infers that all pending work is shown.

The private actor helper requires matching transaction-local `HUMAN_USER` / `HUMAN_UI` context and denies delegated/action context. It re-resolves exact subject/principal/school/permission/entitlement before and after queue projection. Runtime reads begin **READ ONLY before tenant GUC establishment**, use bounded statement/lock timeouts, and invoke only the fixed queue function. FORCE RLS remains on source tables. Only the scope/queue/command-lock functions are executable by runtime; the actor helper remains private. Canonical bootstrap 010 reconciles these function-only ACLs, and the dedicated local integrity proof plus canonical verifier 011 check exact function bodies, fixed search paths, trusted owner, runtime posture, closed ACLs and unchanged planned-absence FORCE-RLS policy/grants.

## Decision and privacy

The workbench invokes the existing `POST /organizations/:organizationId/schools/:schoolId/planned-absence-requests/:requestId/decision` service: one APPROVED/DECLINED transition, nonblank review note at most 1000 characters, expected integer version and Idempotency-Key. The controller now inherits the **same trusted-public-origin JSON guard pattern used by Attendance**, with a separate `planned-absence-review` marker. Neither Origin nor actor/school/source is derived from client authority fields. Queries and extra `x-hon-*` context headers are rejected. DTO/contracts are closed; expectedVersion is bounded to permit the PostgreSQL integer increment.

The existing decision service's row lock, submitted-state/version conditions, normalized fingerprint, durable idempotency response, audit and inert outbox evidence are preserved. Before **lookup or replay**, it rechecks/locks live identity, IAM, topology and entitlement dependencies. Authority-table SHARE locks prevent identity/mixed-grant phantoms and revocation through command commit; these conservative short-lived locks can contend with IAM/topology administration. They make no data writes. Different keys against one version produce one decision and a conflict. Evidence failure rolls back the whole command.

The HTTP decision receipt is newly narrowed to request ID, final status, version and review timestamp. Reviewer attribution and private note remain internal in the existing record/service/audit/outbox, never the browser receipt. **Parent request and history APIs/contracts/UI are unchanged**: parent history exposes only its existing bounded child display/time/status/timestamp projection, not reviewer or submitted/private note. No new consumer or delivery path is introduced.

## Manual browser workflow

1. Prepare a private note/decision, explicitly load the current queue, then inspect and select one returned request.
2. Explicitly record that decision using the selected version. Loading or selecting never posts.
3. If a network/nonterminal/unverifiable receipt leaves uncertainty, only **Retry exact retained decision** resends the same snapshot, note, version, decision and key. There is no polling, automatic retry, persistence, cross-origin transport or automatic queue refresh.

Changing either note or decision clears queue/detail/retry; explicitly reload and inspect again. Selecting another request clears prior detail/retry. Refresh, explicit clear, authorization/conflict/invalid-state response, blur/pagehide/hidden visibility or session-change event clears loaded private state and aborts requests. Generation guards discard late responses after any clearing boundary. Hiding/leaving also clears the note. Returning never auto-loads. All fetches are fixed relative, same-origin, no-store, redirect-error, no-referrer JSON with strict closed envelopes and returned ID/decision/version verification. The route's server session check and every API/function reauthorization are independent.

## Evidence and local commands

Focused tests cover strict contracts, the HTTP guard/closed DTO, module registration, canonical decision ordering/replay/conflicts, transport/receipt redaction, route/manifest/link, explicit loads/decisions, exact retry, input/auth/conflict clearing and stale responses. The dedicated localhost integrity proof applies all canonical migrations and runtime reconciliation twice, tests cap/isolation/denials/revocation/replay/concurrency/rollback/parent redaction, compares all downstream table counts and rejects ACL/body/FORCE-RLS tampering.

Use a **clean environment**, a fresh mode-0600 credential file under a private job directory, and only the exact marked local target:

```sh
env -i PATH="$PATH" HOME=/home/ubuntu \
  HON_PLANNED_ABSENCE_REVIEW_VALIDATION_TARGET=postgresql://localhost:5432/hon_absence_review_validation \
  HON_PLANNED_ABSENCE_REVIEW_ENV_FILE=/home/ubuntu/jobs/YOUR_JOB/review-db.env \
  node packages/database/scripts/setup-planned-absence-review-validation.mjs

env -i PATH="$PATH" HOME=/home/ubuntu /bin/bash -c '
  source /home/ubuntu/jobs/YOUR_JOB/review-db.env
  cd /home/ubuntu/honplatform
  node packages/database/scripts/test-planned-absence-review-integrity.mjs
'
```

Setup refuses unrelated/remote targets, unmarked databases/roles, existing credential outputs and recognized live credentials/execution switches. It resets only its specifically marked disposable local database; never point another script at a production/remote database. Compile contracts/API before the proof. No commit/push/deployment, remote database, provider/payment or external service call is part of this evidence.

## Deliberately absent

No attendance, booking, schedule, makeup, enrollment, parent reply, message, provider, payment, AI, Action Engine, automation, notification, worker or external effect. Existing audit/outbox entries are transactional evidence only, not a delivery claim. No new lifecycle or staff/parent history view. Multi-school review and pagination are intentionally unavailable, and a snapshot can become stale; decisions/retries always reauthorize and check version/state.
