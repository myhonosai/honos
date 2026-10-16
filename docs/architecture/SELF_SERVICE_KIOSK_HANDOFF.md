# HON Self-Service Kiosk — bounded handoff foundation

## Status

Migration `0122`, reconciled forward-only by `0125` and `0126`, delivers an intentionally limited **staff-assistance handoff**, not autonomous self-service admission. It follows the ClassPass and function-only attendance boundaries without calling either command.

> A kiosk result of `NEEDS_STAFF_ASSISTANCE` means only that the public terminal has submitted a valid opaque handoff claim for a human staff member to review. It is **not** a booking, admission, ClassPass redemption, check-in, attendance, payment, notification, or identity-verification result.

No kiosk operation changes ClassPass, canonical bookings, attendance, family, membership, invoice, payment, messaging, AI, Action Engine, provider, worker, audit, or outbox data.

## Three-party scope

1. **Direct human staff** activates or retires a school-owned terminal and provisions a claim only for exact, already-known student/session UUIDs.
2. The **public terminal** holds a short-lived opaque terminal bearer only in browser memory.
3. The **guest** submits an opaque, single-use claim. The terminal receives the same generic result for every semantic condition.

The staff member then uses the existing human workflows to decide any actual ClassPass admission, booking or attendance action. This foundation deliberately has no resolution/complete action for a pending handoff, no queue or listing, and no notification.

## Authority and data boundaries

| Surface | Permission / authority | Result |
|---|---|---|
| Terminal activation / retirement | `kiosk.terminal.manage`; direct HUMAN_USER + HUMAN_UI; **OWNER only** | Active/retired terminal and a 15-minute terminal session bearer |
| Claim provision | `kiosk.handoff.provision`; direct HUMAN_USER + HUMAN_UI; OWNER/ADMIN | 10-minute, exact student/session claim bearer |
| Exact recovery | `kiosk.handoff.read`; direct HUMAN_USER + HUMAN_UI; OWNER/ADMIN | UUIDs, timestamps and `ISSUED` / `CONSUMED` / `EXPIRED` + `PENDING_STAFF_REVIEW` only |
| Public submission | Two opaque bearer values, no authenticated HON principal | Fixed `NEEDS_STAFF_ASSISTANCE` response only |

The direct-human commands require one active human principal, matching external subject, active organization/school and Essential/Core/Complete entitlement, exact current school role permission, no active guardian or HQ grant, and no delegation or Action Request context. Those facts are checked before and after locks.

The public function accepts no organization, school, student, family, class, pass, permission, provider or result selector. It matches only SHA-256 digests, locks terminal session then claim, confirms exact same-school active/scheduled student/session facts, atomically marks the claim consumed and writes one private `PENDING_STAFF_REVIEW` handoff + receipt. A replay, invalid, expired, retired, cross-school, unavailable or already-consumed request returns the same fixed response without an ID or state oracle.

## Opaque secrets and terminal posture

- Terminal-session and claim values are canonical 32-byte CSPRNG base64url bearers; only their SHA-256 digests are stored.
- Terminal sessions expire within 15 minutes; claims expire within 10 minutes and are single-use.
- Bearers never appear in database rows, receipts, audit/outbox events, URLs, referrers, storage, recovery output or public errors.
- The public terminal has no cookie, Authorization header, staff session, parent session, directory, roster, search, free-text identity fallback, PIN, camera/clipboard persistence, or offline-success path.
- Kiosk UI uses same-origin relative fetch with `credentials: 'omit'`, `no-store`, no index/referrer headers, browser-memory-only values, and automatic lock/clear on visibility loss, page hide, reset or terminal expiry.
- Production operation also requires HTTPS and reverse-proxy/APM request-body/redaction policy. The app reduces PostgreSQL bind-value logging but does not make an unsafe deployment configuration safe.

## Private records and safeguards

`kiosk_terminals`, `kiosk_terminal_sessions`, `kiosk_claims`, `kiosk_handoffs` and `kiosk_receipts` are forced-RLS, no-policy private tables. The restricted runtime has no table or column privilege and executes only fixed functions. State transitions are append-only or narrowly immutable; the receipt is IDs/timestamp/fixed outcome only.

`0125` reconciles an ordinary PostgreSQL migration replay with the pre-existing canonical `hon_runtime` grant posture: exactly four public-facing kiosk function signatures are executable, while all kiosk tables and helpers remain denied. `0126` applies the matching runtime-role parameter logging controls (`log_parameter_max_length=0` and `log_parameter_max_length_on_error=0`) so opaque bearer parameters are not captured in PostgreSQL error/parameter logs. These migrations add no kiosk feature or authority.

The public submission intentionally creates **no** audit event: HON audit requires a non-null, correctly attributable actor principal, and a public bearer submission must not be falsely credited to a staff member. Its private receipt preserves the limited internal provenance needed for exact staff recovery.

## Interfaces

- `/staff/kiosk`: authenticated direct-human exact-ID workbench. It has no listing/search/queue and explains the absence of admission, redemption, check-in, attendance, payment or notification outcome.
- `/kiosk`: public resettable terminal screen. A staff member configures it with an in-memory terminal bearer; the guest enters only a claim bearer.
- `POST /api/v1/kiosk/handoffs`: public fixed endpoint. It rejects cookies, Authorization, `X-HON-*`, query inputs, cross-site requests and non-JSON bodies. Semantic cases always return the same result.

## Guarded local validation

```bash
# Supply a new private job file; never reuse or commit it.
env -i PATH="$PATH" HOME=/home/ubuntu LANG=C.UTF-8 \
  HON_KIOSK_HANDOFF_VALIDATION_TARGET=postgresql://localhost:5432/hon_kiosk_handoff_validation \
  HON_KIOSK_HANDOFF_ENV_FILE=/home/ubuntu/jobs/<job-id>/kiosk-handoff.env \
  pnpm db:setup-kiosk-handoff

env -i PATH="$PATH" HOME=/home/ubuntu LANG=C.UTF-8 \
  HON_KIOSK_HANDOFF_ENV_FILE=/home/ubuntu/jobs/<job-id>/kiosk-handoff.env \
  pnpm db:test-kiosk-handoff
```

The guarded fixture rejects remote/unmarked aliases, inherited database URLs, external-provider/payment/messaging/execution environments, existing/symlinked credential files and unsafe local targets. Its generated credentials are descriptor-bound in a fresh private mode-0600 job file. The test rebuilds all migrations, isolates legacy runtime ACLs only inside its disposable database, reapplies canonical grants and removes the marked database/roles/descriptor on success.

It proves two-school terminal/claim isolation, expiry/retirement/single-use/replay/concurrency, same generic public semantic output, direct-human role/tier/principal/family/HQ/nonhuman/delegated/Action denial, private recovery, RLS/ACL/grant-option drift, secret/PII redaction, append-only receipts, whole-table no-effect snapshots and zero external calls.

## Deferred work

- Kiosk self-service admission, ClassPass redemption, booking, check-in or attendance.
- Handoff resolution, queues, staff notifications, QR links containing bearer values, public status lookup or any identity fallback.
- Payments, memberships, pricing, refunds, credits, family/parent capability, messaging, provider adapters, AI, Action Engine and automation.

Those changes require separately reviewed authority, identity, reconciliation and delivery boundaries.
