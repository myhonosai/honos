# Human Class Booking Workbench

## Delivered scope

`/staff/schedule/bookings` is a **conventional, direct-human staff booking workbench**. The existing dynamic `/staff` layout verifies the signed application session before rendering. The page is dynamic and no-index, accepts only the exact closed `organizationId`/`schoolId`/`sessionId` UUID query shape from a selected bounded Class Sessions result, and remains otherwise blank/idle with an unselected kind and no receipt. The handoff leaves the student UUID blank and cannot issue a request, allocate a key or establish scope authority. It is included once in `apps/web/public/manus-routes.json`; all other manifest entries are unchanged.

Only these already-known identifiers are accepted: organization UUID, school UUID, class session UUID and student profile UUID. Browser ID validation accepts complete UUIDs (versions 1–5), with no names, URLs, whitespace or inferred relationships. The closed three-selector handoff may prefill only organization/school/session; any missing, duplicate, extra or non-UUID query value clears the whole prefill. IDs are **untrusted selectors**, never proof of current school authority, identity, eligibility, enrollment or availability.

The immutable selectable kinds come from the existing `CLASS_BOOKING_KINDS`:

- `REGULAR`
- `TRIAL`
- `MAKEUP`
- `PRIVATE_LESSON`
- `EVENT`

`CLASS_PASS` is neither selectable nor accepted by the browser command or receipt validator. The broader `ClassBookingKind` and `CLASS_BOOKING_STATUSES` are not used as browser option catalogs. Kind selection does not approve a makeup or establish eligibility.

## One canonical command

The sole browser transport is:

```text
POST /api/v1/organizations/:organizationId/schools/:schoolId/schedule/sessions/:sessionId/bookings
```

```json
{"studentProfileId":"<exact UUID>","bookingKind":"<permitted kind>"}
```

The existing Next same-origin rewrite reaches the existing `ClassBookingController.create` and **`ClassBookingService.create`**. No new domain endpoint, service, booking model, permission, migration, policy mechanism or proxy is introduced.

The prepared command is immutable and closed to exactly its generated path, organization/school/session IDs, UUID key and canonical JSON body. Immediately before transport, the browser revalidates the exact relative path against those IDs and validates the body has only `studentProfileId` and `bookingKind`. Absolute URLs, protocol-relative URLs, alternate endpoints, extra path/query/fragment segments, method properties, extra authority/capacity fields and `CLASS_PASS` fail before fetch.

The request always uses:

- `method: 'POST'`
- `credentials: 'same-origin'` and `mode: 'same-origin'`
- `cache: 'no-store'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'`
- JSON Accept/Content-Type headers
- `X-HON-Human-Command: class-booking`
- one generated UUID-v4 `Idempotency-Key`

There is no GET, discovery/load path, arbitrary URL transport, caller-selected method or automatic I/O. Key allocation occurs only in the explicit confirmed submit handler, **after local ID and kind validation**. Merely mounting, receiving a selector prefill, typing, selecting or confirming performs no request and allocates no key. Rapid duplicate submits/retries are blocked synchronously. Inputs are disabled during the outstanding command.

## Narrow HTTP guard: why it was necessary

The existing canonical HTTP controller used `HonIdentityGuard`, resolved `schedule.booking.manage` for the exact school/organization pair and server-derived `HUMAN_USER`/`HUMAN_UI`. It did **not** have the current trusted-origin/direct-human JSON transport guard used by adjacent staff command controllers.

Only `ClassBookingHumanUiGuard` was added, as a narrow specialization of the existing `CurriculumHumanUiGuard`, and registered on the existing controller **after `HonIdentityGuard`**. It requires the configured `HON_PUBLIC_ORIGIN`, matching request Origin, JSON content type and the exact `class-booking` marker, and denies cross-site Fetch Metadata. Unconfigured/invalid public origin fails closed with 503. This is the existing application transport/CSRF convention, not independent proof of a person's physical intent and not a replacement for verified identity or domain authorization. The inherited guard's GET handling creates no GET endpoint; the booking controller remains POST-only.

The existing controller and service still own the verified subject, principal, source, exact school permission, tier/scope resolution, RLS, in-transaction session locking and live replay authorization. Existing server idempotency keys of up to 200 characters remain valid; only this browser generates a UUID. Create/replay HTTP 201/200 semantics and the canonical capacity/waitlist behavior are unchanged.

No change was made to the canonical service, DTO, contracts, migrations, database privileges, permission catalog or domain model. Canonical booking audit and inert outbox facts remain unchanged; no downstream executor or worker was added.

## Receipt contract and honest wording

Only a JSON success response with status 201 (recorded) or 200 (replayed/previously recorded), no redirect and the exact `{data, meta}` envelope can produce a receipt. Bodies above 4,000 characters and malformed content are not accepted. Meta is closed to UUID `requestId`, matching UUID `correlationId` and Boolean `replayed`, consistent with the HTTP status.

The data object must contain **only the canonical summary fields**:

```text
id, classSessionId, studentProfileId, bookingKind, status, source,
bookedAt, version, createdAt, updatedAt,
sessionCapacity, bookingPolicy, activeSeatCount
```

The verifier checks returned UUIDs, exact requested session/student/kind, source `STAFF`, status **only `BOOKED` or `WAITLISTED`**, canonical ISO timestamps, positive integer version, nonnegative integer capacity/count and the closed existing `WALK_IN`/`OPTIONAL_BOOKING`/`REQUIRED_BOOKING` policies. Counts/version are bounded to PostgreSQL integer range. Extra raw capacity-policy objects, identity/contact/financial fields, missing fields and broader statuses are rejected rather than displayed.

The UI renders only returned summary facts. There is no capacity/policy input or raw policy viewer and no browser availability or status calculation. In particular, `WALK_IN` may legitimately return an active seat count above capacity. The canonical server can waitlist bookings under required/optional policies; `WAITLISTED` is rendered as such, never relabeled as `BOOKED`.

> `BOOKED` is a returned record status, not a seat guarantee. `WAITLISTED` is not a confirmed seat or a promise of future promotion. The receipt is a command-response snapshot, not live status.

Neither status establishes attendance, eligibility, availability, enrollment, identity, makeup approval, ClassPass allowance, membership, payment, parent access or communication. A replay may contain historical capacity/count facts. Existing canonical bookings with `CHECKED_IN`, `CANCELLED`, `NO_SHOW` or a non-`STAFF` source do not produce this workbench's bounded receipt; the browser shows an unverified/uncertain result and requires staff review without mutating those records.

## Retry and local state

A successful receipt or definite rejection blocks fresh resubmission of the same draft until a human edits or discards it. Only a network/redirect failure, server/unrecognized status, malformed/unverified success receipt or canonical `409 IDEMPOTENCY_IN_PROGRESS` retains the exact immutable path/body/key in memory. Retry is a separate explicit human button; there is no timer, background retry, polling or alternative command. Stale retry handlers cannot send after state has changed.

Ordinary 400/404/409/413/415/422 rejections do not retain retry. Error responses are never echoed as raw details, policy, capacity or SQL text. 401/403 clear all entered IDs, kind, confirmation, receipt and retry. Editing any ID or kind—including reverting to the same visible value—clears receipt, retry and confirmation. Discard starts blank. Unmount discards the retained key and ignores a delayed response; remount/reload starts idle. Nothing is persisted to browser storage.

**Discard/edit is not cancellation.** An earlier uncertain request may still have recorded a booking. The UI explicitly warns staff to seek review before starting a different command; it cannot discover or confirm the earlier outcome after the in-memory retry has been discarded.

## Explicit non-goals

No directory, list, roster, people/family/program search, calendar or current-status lookup; no session create/edit/cancel or booking edit/cancel; no eligibility/identity/enrollment/availability inference; no ClassPass grant/redemption; no attendance, progression, testing, membership, payment, message, provider, AI, Action Engine, automation or external-delivery changes.

The page is a direct route/manifest entry, not a new dashboard handoff or school-selector trust mechanism. Its only session handoff is a closed, untrusted three-UUID prefill from an already selected bounded Class Sessions row; the session list remains unable to provide a student, booking kind, confirmation, authority, seat/waitlist outcome or command.

## Validation evidence

Validated in the assigned sandbox against `main` at `62dc957`, preserving the pre-existing booking TODO outcome until validation completed:

| Command / audit | Result |
| --- | --- |
| `pnpm --filter @hon/web exec vitest run test/class-booking-workbench-http.test.ts test/class-booking-workbench-ui.test.tsx test/class-booking-workbench-route.test.tsx test/staff-route-auth-layout.test.ts` | 4 files, 18 tests passed |
| `pnpm --filter @hon/api build` | Passed |
| `node --test apps/api/test/class-booking.test.cjs apps/api/test/class-booking-workbench-edge.test.cjs` | 10 tests passed |
| Adjacent API regression: those two suites plus `classpass`, `parent-classpass`, `attendance`, `owner-launch`, `owner-launch-guardian-child`, `owner-launch-first-class-booking-context` | 8 files, 51 tests passed |
| `pnpm --filter @hon/web test` | 86 files, 441 tests passed |
| `pnpm check` | All workspace checks and prerequisite package builds passed |
| Final `pnpm --filter @hon/web check` after selectable-kind freeze and wording refinement | Passed |
| Source/manifest audit | All 63 normalized page routes match; exactly one manifest entry added |
| `git diff --check` and no-index whitespace checks of new files | Passed |
| Canonical service/DTO/contracts/database/domain diff audit | Unchanged |

The local HTTP integration uses a **fixture identity guard and mocked database/service**, but runs the actual narrow human guard, controller, DTO pipeline, exact scope checks and POST routing. Existing canonical service tests separately cover live scope/replay authorization, cancelled sessions, WALK_IN overcapacity and required/optional waitlisting. This is not a remote-database/RLS concurrency proof or a live authenticated browser smoke test.

No migration, remote database, commit, push, deployment or external effect was performed. The implementation reuses the existing staff CSS and adds no assets, packages or configuration changes.

## Review points

- Ensure existing `HON_PUBLIC_ORIGIN` matches the browser-facing HTTPS origin in the intended environment. The new guard intentionally rejects old clients that omit the trusted origin or direct-human marker, while preserving canonical body/idempotency/result semantics.
- Receipts are deliberately not live operational status, and exact retry is available only while the unchanged uncertain command remains in this component's memory.
- Closed receipt validation deliberately declines broader legacy statuses/sources rather than making attendance or seat claims. Such outcomes need an existing staff review process outside this workbench.
- Browser local validation never confers school authority. Every submit and retained replay must pass the unchanged canonical server boundary.
