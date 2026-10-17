# Human testing candidate outcome workbench

## Delivered boundary

`/staff/testing/candidates/grade` is a **dynamic, noindex/nofollow conventional direct-human staff page** under the existing verified-session `/staff` layout. It starts **blank and idle**: three already-known organization/school/candidate UUIDs, a positive expected candidate version, one explicitly chosen `PASSED` / `DEFERRED` / `NOT_PASSED` / `WITHDRAWN` result, and an optional private instructor note of at most 2000 characters. There is no default result, query/prefill, school default, saved state, autoload, list/search, event/candidate read or scorecard action.

Local UUID/version/result/note validation proves syntax only. IDs and expected versions are untrusted selectors, not authority or verified current candidate facts. Staff must already possess separately authorized current candidate/version information. This workbench introduces no discovery/recovery endpoint.

It uses **only the existing canonical grade command**:

```text
POST /api/v1/organizations/:organizationId/schools/:schoolId/testing/candidates/:candidateId/grade
```

The existing Next `/api/v1` rewrite forwards to `TestingCandidateGradeController.grade` and `TestingCandidateService.grade`. Their existing human HTTP guard is already present, so **no canonical API source, DTO, contract, service, permission, RLS policy, migration, domain workflow, grant, consumer or executor is changed**. No promotion-decision endpoint or downstream operation is exposed.

## Outcome evidence is not a downstream authorization

> **PASSED is neither promotion nor certificate issuance.** The command records candidate outcome evidence, canonical audit and inert outbox only.

Existing scoped idempotency reservation/receipt bookkeeping remains transactional. The workbench does not grade scorecards or score observations, calculate readiness/eligibility, create roster/place/capacity, decide promotion, change rank/belt or issue certificates. It grants no parent/family access, records no attendance, changes no billing/payment, sends/queues no communication, and invokes no provider, AI, Action Engine or automation. Existing `testing.candidate.graded` outbox evidence gains no consumer or external effect.

## Exact human confirmation and transport

The form requires a separate confirmation of the **exact candidate, expected version, selected outcome and note replacement**. Every ID, version, result or note edit resets confirmation, receipt and retry. Confirmation changes invalidate older confirmed-submit handlers, including after revocation. Only the locally valid confirmed submit handler allocates **one `crypto.randomUUID()` v4 idempotency key**; neither render/effects, preparation nor retry allocate keys.

UUID selectors are normalized to lowercase. Expected version must be a safe positive whole number with a safely representable `expectedVersion + 1`. The blank UI version is not coerced to zero; leading zero, decimal, exponent, signed and whitespace forms are rejected. The raw note limit is 2000 characters; unsafe C0/DEL controls are rejected while tab/newline/carriage return remain allowed. Notes are trimmed exactly like the existing service; whitespace-only/empty notes are omitted.

**Grading replaces the candidate note. An omitted/blank note clears its previous note**, rather than preserving or appending it. The UI explains this before confirmation.

The body contains exactly these existing canonical fields:

```json
{
  "result": "PASSED",
  "instructorNotes": "<optional bounded trimmed private note>",
  "expectedVersion": 3
}
```

Organization/school/candidate appear only in the exact relative path. There are no event, scorecard, enrollment/rank selection, actor/source, scope/authority, delegation, action request, promotion or certificate fields. The adapter independently validates the closed prepared command and canonical serialization before any I/O. Prepared command and selectors are frozen; exact retries retain identical path, serialized body and key.

POST uses `credentials: same-origin`, `mode: same-origin`, `cache: no-store`, `redirect: error`, `referrerPolicy: no-referrer`, JSON Accept/Content-Type, `Idempotency-Key` and **`X-HON-Human-Command: testing`**. The existing `HON_PUBLIC_ORIGIN` must match the browser-facing origin; no origin/session exception is added. The existing controller does not set a new response Cache-Control header; this page enforces fetch no-store and no browser persistence.

## Strict closed receipt and replay semantics

The adapter accepts only **HTTP 200** for both fresh and replayed grading, matching the unchanged controller. Responses require JSON media type, no redirect, at most **20,000 response characters**, exactly `{ data, meta }`, and exactly `{ requestId, correlationId, replayed }` metadata. Request/correlation IDs must be valid equal UUIDs; `replayed` must be boolean.

The candidate must have exactly the canonical candidate/event/enrollment/target-rank UUIDs, result, version and creation timestamp, plus `instructorNotes` **only when the exact normalized note was submitted**. The returned candidate UUID and closed result must match the command, the note must match exactly, and **version must equal `expectedVersion + 1`**, on both fresh execution and replay. Missing/extra fields, wrong IDs/results/notes/version, malformed RFC3339 dates (including PostgreSQL microseconds/offsets), private authority/audit/outbox or downstream facts reject the entire receipt; no partial/optimistic success is rendered.

**Replay is the original command-response snapshot, not live candidate status.** The service replays a completed matching key before testing a fresh command's expected version. A replay can legitimately return version 4 for an expected-version-3 command after a separate authorized command has advanced the candidate to version 5. The adapter requires the original progression, never adds another version, and the UI labels previously recorded evidence explicitly.

Only verified returned candidate/event/enrollment/target-rank UUIDs, result/version and creation timestamp are displayed. Those returned event/enrollment/rank UUIDs are canonical response facts, not additional input selectors or a downstream handoff. Private notes are verified but never displayed; actor, authority, audit/outbox payload and raw server/network details are never rendered. Input-supplied organization/school values are not labelled as returned scope facts. No scorecard or downstream action/link is shown.

## Memory-only state, access loss and uncertainty

- Render/effects do not send, allocate keys, poll, schedule or automatically recover. The effect manages cleanup only; idle React Strict Mode cleanup/setup remains usable without I/O.
- An immediate ref guard deduplicates rapid submit/retry actions. All inputs are locked during pending I/O. Each attempt clears visible note, confirmation and prior receipt/retry before sending.
- Success or definite rejection retains no exact retry/key. A new command requires an edit or explicit start-over, fresh local validation and confirmation.
- Every ID/version/result/note edit and discard clears receipt/retry; epoch and retained-command identity guards prevent stale edit/confirmation/submit/retry handlers from resending obsolete intent.
- `401/403`, including on exact replay, clear **all three IDs, version, result, note, confirmation, receipt and retry**. A protected page is not a substitute for current server permission.
- `400/404/405/409/413/415/422` are definite rejection/conflict with no success/retry, except the existing closed `409 IDEMPOTENCY_IN_PROGRESS` response, which is uncertain. An unreadable/unverifiable 409 body is uncertain because that in-progress condition cannot be excluded.
- Network/redirect failure, unexpected status, malformed/oversized/wrong-type success or mismatched receipt is uncertain. Only the exact frozen in-memory command survives, and only a separate **Retry exact unchanged outcome** human action resends it with no fresh key or automatic retry.
- Unmount drops retained references and ignores late completion. A real remount/reload starts blank and idle.

**Editing, discarding or reloading is not cancellation.** An uncertain command may already have changed the candidate. Once its exact memory retry is discarded, obtain separately authorized current candidate/version information before a different command; no candidate/history/verification read is added here.

## Preserved server integrity

Every submit/replay continues through `HonIdentityGuard` and existing `TestingHumanUiGuard`, verifies the current external subject's exact school **`testing.manage`** scope and organization/school match, and derives `HUMAN_USER` / `HUMAN_UI` context server-side. The service rejects nonhuman, non-UI, action-request and delegated contexts before tenant work.

The unchanged tenant transaction binds RLS scope and human source/delegation settings, locks/rechecks human testing authority and the candidate record, and reads the candidate inside that scope before idempotency. Missing/out-of-scope candidates are not read outside tenant scope. Replay rechecks current authority and scoped candidate presence before returning stored evidence. Fresh mutation compares the expected current candidate version and uses conditional `WHERE id = … AND version = …`, updates only candidate result/note/version, appends audit/inert outbox, and completes the scoped principal idempotency record with HTTP 200. Database RLS, composite integrity and existing error mapping remain untouched.

## Validation evidence

The implementation starts from clean `main` **10698f4** plus the original single uncommitted outcome TODO. New adapter/UI/route tests and canonical Nest HTTP/service edge tests use **local/in-memory doubles only**. They exercise exact headers/body, closed results, note replacement, positive/safe versions, fresh/replay progression, current identity/scope/authority/candidate rechecks, idempotency reuse/in-progress/stale/race handling, privacy, access clearing, stale handlers, Strict Mode cleanup and no-effect SQL boundaries.

| Validation | Actual result |
| --- | --- |
| Focused new and adjacent web HTTP/UI/route/staff-session tests | **7 files / 48 tests passed**; 23 new outcome tests |
| New grade HTTP/service edge tests plus adjacent registration/scorecard/certificate tests | **19 tests passed**; 5 new outcome tests |
| Initial web typecheck and API build | Passed |
| `pnpm check` | All prerequisite builds and workspace checks passed |
| Final post-build web TypeScript check | Passed |
| Final `pnpm test` after exact UUID/version/timestamp terminal-boundary hardening | **1,165 passed**: auth 91; domain 188 (22 files); web 533 (99 files); API 353; no failures/skips |
| `pnpm build` | All workspace builds passed; `/staff/testing/candidates/grade` emitted as **dynamic**; existing unrelated CSS/autoprefixer and webpack cache warning-serialization warnings remain |
| `pnpm db:check` | **145 PostgreSQL migration files verified**, static only |
| Exact normalized source/manifest comparison | All **67 page routes** match without duplicates; one outcome route entry |
| Anonymous local Preview route request | **307 `/auth/login`**, `Cache-Control: no-store, must-revalidate`; no signed browser or mutation used |
| Tracked/new-file whitespace and canonical source diff audit | Passed; canonical API source and auth/config/contracts/database/domain trees remain unchanged |

The first focused pass exposed only two presentation/test assertion issues: split React heading text in the test harness and a test assertion using `FORBIDDEN` rather than the unchanged canonical `TESTING_FORBIDDEN` code. Both were corrected and the focused suite rerun successfully; no canonical backend change was needed. Managed diagnostic discovery was unavailable, so the existing TypeScript checks are used.

Self-audit additionally tightened this new adapter's exact 36-character UUID and whole-string timestamp boundary, and rejected trailing whitespace/newline version spellings; adversarial tests pass. A concurrent web typecheck initially raced the root production build's regeneration of `.next/types` and reported missing generated files. The check was rerun after the build finished and passed; no configuration/source workaround was introduced. The final complete root regression suite was rerun after that hardening. An independent one-off manifest audit initially omitted normalization of existing dynamic route segments; the corrected normalized audit and the committed route test both pass.

Root validation child environments remove database URL/Supabase variables. Local logs are in `/home/ubuntu/jobs/job_QuIe2NWY/` (`root-check.log`, `root-test-final.log`, `root-build.log`, `db-check.log`, `validation-status.txt`). **No live PostgreSQL/RLS, signed-browser mutation or remote integration proof is claimed.** No remote DB/provider/payment, migration application, fixture provisioning, deployment, commit or push was performed. This is a validated working-tree outcome, not a production checkpoint.
