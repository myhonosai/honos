# Human Class-Session Workbench

**Status:** delivered conventional staff slice
**Route:** `/staff/schedule/sessions/create`
**Canonical command:** `POST /api/v1/organizations/:organizationId/schools/:schoolId/schedule/sessions`
**Required permission:** `schedule.session.manage`
**Available entitlement:** existing active scheduling entitlement (Essential, Core, or Complete)

## Purpose

This screen makes one existing canonical **current-school class-session creation** command usable by a verified human staff member. It creates a single returned operational session record; it is not a calendar, roster, recurring scheduler, booking or attendance surface.

The screen begins blank and idle. It accepts only already-known exact organization, school and program UUIDs plus bounded session fields:

- nonblank session name;
- optional room name;
- canonical UTC start and end timestamps;
- positive capacity; and
- one existing closed booking-policy value.

Entered values are local syntax only. They are not authority, proof that the program exists, proof that a room is available, or proof that any student can attend.

## Direct-human transport boundary

The canonical mutation now has `ClassSessionHumanUiGuard` in addition to `HonIdentityGuard`. The guard is a **browser transport boundary**, not a replacement for API authorization:

| Required transport fact | Rule |
| --- | --- |
| Method | `POST` only |
| Origin | exact configured HON public origin |
| Body | JSON only |
| Marker | `X-HON-Human-Command: class-session` |
| Idempotency | one UUID v4 `Idempotency-Key` |
| Fetch Metadata | same-origin, same-origin mode, empty destination, no user-navigation marker |
| Authority headers | rejects supplied identity/scope/role/tier/source/delegation/action-request and forwarding headers |
| Query selectors | rejected |

The controller still independently resolves the current signed-in human against the exact school and `schedule.session.manage`. The existing service/RLS transaction independently validates the active scheduling entitlement, exact program, timestamps, scope, idempotency and evidence writes.

## Command and retry semantics

An explicit local confirmation allocates one fresh v4 idempotency key. The browser sends only the closed canonical DTO body. It stores neither inputs nor receipt. If network delivery is uncertain, only the exact frozen path/body/key remains in memory for a separate human retry. Any edit, discard, reload, unmount or access denial clears the retry. There is no polling, automatic retry, optimistic success, browser persistence or alternate mutation path.

The response parser accepts only the expected canonical `SCHEDULED` snapshot and strips all metadata except replay posture. A returned session is a command-response fact, not a live schedule, capacity, calendar or roster assertion.

## Explicit non-effects

This workbench does **not**:

- create recurring calendar events, calendar integration, instructor assignment, room availability or a schedule guarantee;
- list or search programs, sessions, staff, rooms, students, families or rosters;
- create a booking, attendance observation, ClassPass use, membership, invoice, payment, refund, discount or revenue outcome;
- determine eligibility, enrollment, capacity availability, waitlist position, identity, progression, testing, promotion or parent access;
- send a message or notification, call a provider, make an AI/Action Engine request, schedule automation or activate an outbox consumer.

## Validation evidence

Focused API coverage verifies the strict mutation guard and closed server DTO boundary. Focused browser coverage verifies blank/idle mount, no automatic I/O, exact body/path/key preparation, explicit confirmation, uncertainty-only retry, access clearing, route behavior and manifest registration. The full workspace regression (`pnpm test`, `pnpm check`, `pnpm build`) and `git diff --check` were run before checkpoint. No remote database, provider, payment, deployment or customer action occurs in this slice.
