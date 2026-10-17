# Human Class Sessions Read

## Purpose

`GET /api/v1/organizations/:organizationId/schools/:schoolId/schedule/sessions` is a **bounded, read-only operational selection aid** over the existing `hon.class_sessions` table. It lets authorized direct staff select a real session without using a session UUID as the list input.

The protected UI is `/staff/schedule/sessions`. It begins with no data and performs no I/O until a human enters an exact organization and current-school UUID and explicitly chooses **Load bounded Class Sessions**. These UUIDs are untrusted selectors only.

## Exact bounded window and result

The PostgreSQL projection `hon.read_current_school_class_sessions(text)` has no caller range, cursor, search, filter, sort, or list selector. At the database statement's UTC date it returns, in deterministic `starts_at ASC, id ASC` order, **at most 50** sessions where:

- `starts_at` is **at or after 00:00 UTC 30 calendar days before today**; and
- `starts_at` is **before 00:00 UTC 91 calendar days after today**.

This includes today through 90 calendar days forward. The end is exclusive.

Each returned item contains exactly:

| Field | Meaning |
|---|---|
| `sessionId` | Existing persisted class-session ID |
| `name` | Persisted session name |
| `startsAt`, `endsAt` | Persisted UTC session boundaries |
| `roomName` | Persisted room name or `null` |
| `capacity` | Persisted capacity fact |
| `bookingPolicy` | Persisted booking policy fact |
| `status` | Persisted `schedule_item_status` value only |
| `createdAt` | Persisted creation timestamp |

No returned field represents availability, seats, a roster, or an outcome.

## Security boundary

The request needs a signed identity and a strict same-origin browser GET (`Origin`, Fetch Metadata, `X-HON-Human-Read: class-sessions`, `credentials: same-origin`, `mode: same-origin`, `cache: no-store`, `redirect: error`, and `Referrer-Policy: no-referrer`). Query/body/command/delegation/authority headers are rejected; responses use private no-store and `noindex, nofollow` headers.

The API independently resolves the exact selected school with the new narrow `schedule.session.read` permission. The fixed SECURITY DEFINER projection independently repeats all authority checks from tenant GUC context before and after building the result:

- exactly one active `HUMAN_USER` principal for the signed external subject;
- direct `HUMAN_UI` only, with no action request or delegated principal;
- active exact organization and school;
- no HQ grant, active family grant, or parent/guardian/student/family/HQ/platform/system mixed role;
- an active exact school role grant with `schedule.session.read`; and
- an active `ESSENTIAL`, `CORE`, or `COMPLETE` organization entitlement.

Migration `0147_current_school_class_sessions_read.sql` grants the permission only to existing system `OWNER` roles. Future system OWNER provisioning already copies the complete current permission catalog. It revokes direct `SELECT` on `hon.class_sessions` from runtime/public clients, preserves `ENABLE/FORCE ROW LEVEL SECURITY`, revokes helper execution, and grants `hon_runtime` only the named projection function. The existing direct class-session creation insert is unchanged.

## Deliberate exclusions and effects

The projection does **not** expose or query instructors, students/roster, families, enrollment, eligibility, attendance, bookings/waitlist, ClassPass, membership/payment, providers, AI, Action Engine, aggregates, generic search/directory data, or any mutation/effect. It creates no audit, outbox, idempotency, booking, notification, calendar, provider, or payment record.

The page's **Select session** control is memory-only. It cannot book, reserve, waitlist, check in, modify, or guarantee a seat. The link to the existing manual booking workflow transfers no scope or authority; that workflow independently authorizes its own exact inputs.

The existing class-session creation receipt has one clean destination link to the bounded read. It carries no UUID prefill, session ID, scope, authority, or capability.

## Verification

`pnpm db:setup-class-sessions-read` creates only the marked disposable localhost database and private job-directory credentials. `pnpm db:test-class-sessions-read` proves the 50-row bound/window/order/minimum shape, denied direct table reads and helper execution, forced RLS/function ACLs, no-write behavior, cross-school suppression, and direct-human/current-school/permission/entitlement/HQ/family/mixed-role/nonhuman/delegated/action denials.

Focused API and browser contracts, the disposable 0147 integrity proof, root `pnpm test`, root `pnpm check`, root `pnpm build`, and `git diff --check` passed locally. The fixture is localhost-only and does not exercise any remote/shared database, provider, payment, or deployment.
