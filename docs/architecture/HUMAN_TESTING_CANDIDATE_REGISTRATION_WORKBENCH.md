# Human testing candidate registration workbench

## Delivered boundary

`/staff/testing/candidates/register` is a **dynamic, noindex/nofollow direct-human staff page** under the existing verified-session `/staff` layout. It starts blank and idle with exactly five already-known UUID fields: organization, school, testing event, student curriculum enrollment and target rank. Optional private instructor notes are bounded to 2000 characters. No URL/query prefill, saved values, school default, automatic I/O, directory, search, event/student/enrollment/rank list, eligibility/readiness/capacity calculation or selection logic exists.

UUID syntax validation is local only. These IDs are untrusted command selectors, not evidence of identity, permission, existence, eligibility, event placement or capacity.

The page uses **only the existing canonical command**:

```text
POST /api/v1/organizations/:organizationId/schools/:schoolId/testing/events/:testingEventId/candidates
```

The existing Next `/api/v1` rewrite still forwards to the canonical Nest API. `TestingCandidateController.register` and `TestingCandidateService.register` remain unchanged and exclusively own the mutation. No API/list/read route, canonical service, DTO, contract, migration, domain workflow, permission, grant or consumer was added or altered.

## PENDING is not another workflow's outcome

> **Registration creates a PENDING candidate, canonical audit and inert outbox evidence only. PENDING is not testing eligibility or testing completion.**

The existing command also records its idempotency reservation/receipt transactionally. This page neither tests nor creates eligibility, readiness, roster membership, place or capacity; scores, grades, pass/fail/defer; promotion, rank placement/history, belt or certificate; family/parent access; attendance, billing, payment, message/notification, provider, AI, Action Engine, automation or any external effect. It exposes no event authoring, student/enrollment/rank authoring, grading, promotion, certificate, roster or family registration command. The existing `testing.candidate.registered` outbox evidence gains no consumer or executor.

## Explicit locally valid human command

A separate confirmation is required for the exact draft. **Only the valid confirmed submit handler allocates `crypto.randomUUID()`**, once, as a v4 idempotency key. Preparation itself performs no I/O. UUIDs are canonicalized to lowercase. Notes are checked against the raw 2000-character limit and unsafe C0/DEL controls (tab/newline/carriage return remain allowed), then trimmed exactly as the existing service does; empty/whitespace-only notes are omitted.

The body is exactly `RegisterTestingCandidateInput`:

```json
{
  "studentCurriculumEnrollmentId": "<already-known enrollment UUID>",
  "targetRankId": "<already-known target-rank UUID>",
  "instructorNotes": "<optional bounded trimmed private note>"
}
```

Organization, school and testing event appear only in the exact canonical relative path. There are no body fields for result, actor, source, organization/school authority, delegation, action request, expected grade/version or eligibility. The transport independently verifies the exact closed command and canonical serialization before fetching. Prepared selectors and command are frozen; a retained retry has the identical path, serialized body and key.

POST uses `credentials: same-origin`, `mode: same-origin`, `cache: no-store`, `redirect: error`, `referrerPolicy: no-referrer`, JSON Accept/Content-Type, `Idempotency-Key` and **the existing `X-HON-Human-Command: testing` marker**. This is not the distinct family-interest/staff-review `testing-registration` marker. Existing `HON_PUBLIC_ORIGIN` must match the actual browser-facing origin; no origin/authentication exception is introduced. The unchanged controller does not set a response Cache-Control header; this workbench enforces no-store on its fetch and stores nothing in browser persistence.

## Strict receipt, closed display

Accepted responses are bounded to **20,000 response characters** and require JSON media type, no redirect, a closed `{ data, meta }` envelope and exactly `{ requestId, correlationId, replayed }` metadata. Request/correlation IDs must be valid UUIDs and equal; replayed must be boolean. HTTP **201 must mean `replayed: false`**, and HTTP **200 must mean `replayed: true`**, matching the unchanged controller.

The entire candidate must have exactly the canonical fields: candidate/event/enrollment/target-rank IDs, `result: PENDING`, `version: 1`, created timestamp and the optional note only when that exact normalized note was submitted. Event/enrollment/rank IDs must match the command. Missing or extra fields, wrong IDs/notes, non-PENDING results, other versions, malformed timestamps and unexpected authority/private/downstream projections reject the whole receipt. RFC3339 timestamps, including PostgreSQL microseconds/offsets, are validated without inventing browser times. There is no partial or optimistic success display.

The UI displays **only returned canonical candidate UUID, event UUID, enrollment UUID, target-rank UUID, PENDING/version and creation timestamp**. A verified replay is labelled as previously recorded evidence. This is a **command-response snapshot**, never a live candidate/grade, readiness, eligibility or testing-completion claim. Private notes are verified for exact receipt matching but are not rendered; actor, authority, audit/outbox payload and raw error/network details are never displayed. No input-supplied organization/school value is presented as a returned receipt fact.

## Memory-only state and uncertainty

- No request or key allocation occurs on render or in effects. The effect only manages cleanup. No storage, timers, polling, background action, recovery search or automatic retry exists.
- Every command attempt clears the visible note, confirmation and prior receipt/retry before I/O. Inputs are locked while pending; an immediate ref guard deduplicates rapid submit/retry actions.
- After success or definite rejection, no exact command/key is retained for retry. A new command requires an edit or explicit start-over and fresh local validation/confirmation.
- Every UUID/note edit resets confirmation, receipt and retry. Confirmation changes invalidate stale confirmed-submit handlers, including after revocation. Epoch and retained-command identity checks prevent stale edit/confirm/submit/retry handlers from resending obsolete intent.
- `401/403`, including on retained replay, clear all five UUIDs, note, confirmation, receipt and retry. Initial page authentication does not substitute for current server authorization.
- `400/404/405/409/413/415/422` are definite rejection/conflict and never show success or retain retry, **except the canonical closed `409 IDEMPOTENCY_IN_PROGRESS` response**, which is uncertain. An unreadable/unverifiable 409 body is also uncertain because it cannot exclude that canonical in-progress condition.
- Network/redirect failure, unexpected server/status, malformed/oversized/wrong-type success, mismatched receipt or noncanonical status/replay pairing is uncertain. Only that unchanged frozen in-memory command is retained, and only a separate **Retry exact unchanged registration** action can resend it. No new key is allocated by retry, and no automatic resend occurs.
- Cleanup drops retained-command references and rejects late in-flight completion after unmount. Initial idle React Strict Mode cleanup/setup replay remains idle and does not strand first-render handlers. A real remount/reload starts blank.

**Editing, discarding or reloading is not cancellation.** An earlier uncertain command may already have created the candidate. Once its exact in-memory retry is discarded, staff must seek a separately authorized review before a different command; this page adds no lookup/history/verification route for that purpose.

## Preserved server security and integrity

Every submit/replay still passes `HonIdentityGuard` and `TestingHumanUiGuard`, resolves the verified external subject's exact current school **`testing.manage`** scope, checks the organization/school match, and derives `HUMAN_USER` / `HUMAN_UI` actor/context on the server. The service rejects nonhuman, non-UI, action-request and delegated contexts.

Within the unchanged tenant transaction it locks and rechecks current human testing authority; binds RLS scope; reads/locks the existing event, enrollment and rank; enforces their same curriculum; and reserves the existing scoped/principal idempotency record. Even replay rechecks authority and scoped dependencies before returning stored evidence. Fresh registration uses the existing event/enrollment advisory lock, unique-candidate recheck and database uniqueness/composite tenant/curriculum integrity. It inserts only PENDING candidate/audit/inert outbox evidence and completes idempotency. No browser confirmation, key or UUID confers authority. No canonical permission, RLS policy, integrity constraint or error mapping was changed.

## Validation evidence

Working-tree implementation is based on clean `main` **1b2cb0d**, preserving the original single uncommitted candidate TODO outcome until actual validation. Focused browser HTTP/UI/route tests and canonical Nest HTTP/service edge tests use only local/in-memory doubles. They cover unchanged marker/DTO/scope/actor behavior, fresh/replayed receipts, unique duplicates/reused keys, in-progress uncertainty, current authority/dependency/curriculum rechecks, response privacy, access loss and no-effect SQL boundaries. They are **not a live PostgreSQL/RLS or remote integration proof**.

| Validation | Actual result |
| --- | --- |
| Focused new browser HTTP/UI/route tests plus existing staff route-session tests | **4 files / 24 tests passed**: 22 new tests and 2 existing authentication-boundary tests |
| New canonical candidate HTTP/service edge tests plus adjacent testing registration/scorecard/certificate tests | **14 tests passed**: 5 new candidate tests and 9 existing adjacent tests |
| API build | Passed |
| `pnpm check` | All prerequisite builds and workspace checks passed |
| Final web/API typechecks after the Strict Mode fix | Passed |
| `pnpm test` | **1,133 tests passed**: auth 91; domain 188 (22 files); web 506 (95 files); API 348; no failures/skips |
| `pnpm build` | All workspace builds passed; candidate registration page emitted as **dynamic**; existing unrelated CSS/autoprefixer and webpack warning-serialization warnings remain |
| `pnpm db:check` | **145 PostgreSQL migration files verified**, static only |
| Complete normalized source/manifest comparison | All **66 page routes** match, no duplicates; exactly one new entry |
| Tracked/new-file whitespace and canonical source diff audit | Passed; canonical API source, auth/config/contracts/domain/database remain unchanged |

Full root test/build child environments omit database URL variables. Initial background launches ignored their requested working directory and stopped before finding a package; explicit repository `cd` corrected the launcher. The initial new API double had an audit-parameter index typo, corrected before the passing rerun; no canonical source changed. Managed diagnostic discovery was unavailable, so existing TypeScript check commands and available edit diagnostics were used.

No live PostgreSQL/RLS, signed-browser mutation or remote integration proof is claimed. No remote database/provider/payment, migration application, fixture provisioning, deployment, commit or push was performed.
