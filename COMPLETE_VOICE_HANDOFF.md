# Complete Voice/Text Handoff Foundation

## Purpose and boundary

This foundation makes a **human-owned, Complete-tier voice-to-text handoff ledger** available at `/staff/voice`. It is deliberately **not** a voice provider, microphone integration, transcription system, AI conversation runtime, or Action Engine entrypoint.

The stored session preserves enough bounded context for a human to retain their place when voice is unavailable:

- one approved catalog ID (`alex`, `chad`, `maya`, `marcus`, `jordan`, `claire`, or `lena`), which is presentation metadata and **not** an invocation or principal;
- optional scoped work-item, action-request, and approval UUIDs, subject to live read/approval authority;
- an actor-owned prior session UUID for a new handoff session; and
- a conservative, private plain-text fallback draft.

> Saving a draft records no command. It does not send a message, invoke an employee, connect a provider, or change any authority.

**No microphone access, recording, audio retention, transcript, provider configuration, health probe, LLM request, invocation, tool call, action/work execution, usage charge, billing change, communication delivery, or external network call is introduced.** Eian/family voice and HQ use are not part of this slice.

## Authority and API boundary

Every endpoint is guarded by verified identity plus the same-origin human-command guard (`Sec-Fetch-Site: same-origin`, trusted origin, JSON and `X-HON-Human-Command: voice-session`). The server derives the actor and scope; callers cannot provide organization, principal, entitlement, authority, provider, model, or raw payload fields.

The SQL boundary requires an active, unambiguous `HUMAN_USER` actor with `HUMAN_UI` source, active organization/school, exact effective `ai.voice.interact`, and active **Complete** organization entitlement. It locks and rechecks the relevant live IAM/topology/entitlement facts after waits. It rejects public, parent, HQ, AI employee, automation, integration, delegated, Action Engine, inactive, future, expired, cross-school, and cross-organization access.

| Endpoint | Purpose | Closed input |
|---|---|---|
| `POST /v1/staff/voice/:schoolId` | Create an actor-owned handoff session | Approved catalog ID; optional stable scoped IDs, or only `resumeSessionId` |
| `GET /v1/staff/voice/:schoolId/:sessionId` | Read exact actor-owned evidence | No query parameters |
| `POST /v1/staff/voice/:schoolId/:sessionId/status` | Record a non-success voice observation | Expected version, `VOICE_CONNECTING` or `VOICE_UNAVAILABLE`, redacted reason code |
| `POST /v1/staff/voice/:schoolId/:sessionId/mark-fallback` | Record fallback and optional private safe draft | Expected version, redacted reason code, optional bounded draft |
| `POST /v1/staff/voice/:schoolId/:sessionId/end` | Explicitly end the historical session | Expected version |

Request bodies must be ordinary objects. `null`, primitive, and array JSON bodies are rejected with `VALIDATION_FAILED` in `VoiceController` before the service is called; `undefined` fields are removed only from valid object shapes. Input and result contracts reject expanded/poisoned shapes.

## State, retries, and privacy

Sessions use only the following forward-only states:

```text
REQUESTED → VOICE_CONNECTING → VOICE_UNAVAILABLE → TEXT_FALLBACK → ENDED
```

Forward skips are allowed. There is intentionally no connected, listening, speaking, provider-success, or execution-success state. A session expires after 30 minutes; an expired session is readable historical evidence but permits only explicit end. An ended session never reconnects. Version checks, UUID idempotency receipts, actor/session locks, and post-lock revocation/expiry checks make uncertain retries and concurrent writes deterministic.

`NOT_CONFIGURED`, `CLIENT_OFFLINE`, `CLIENT_ERROR`, `PERMISSION_UNAVAILABLE`, and `PROVIDER_UNAVAILABLE` are **redacted observations**, never proof of provider health or success. Draft text is accepted only when it is 1–500 trimmed ASCII plain-text characters without numbers, contact data, URLs, markup, credential syntax, audio/transcript terms, or other prohibited sensitive terms. It is visible only through the exact actor-owned session projection and is absent from audit and outbox evidence.

## Database and runtime posture

Migration `0083_complete_voice_handoff_foundation.sql` adds:

- `hon.voice_sessions` and idempotent `hon.voice_session_requests`, each forced-RLS with a single deny-all policy;
- scoped composite foreign keys to school/work/action/approval/actor-owned resume context;
- immutable receipt evidence and a monotonic transition trigger;
- fixed-search-path `SECURITY DEFINER` helpers, with only `hon.read_voice_session(text, uuid)` and `hon.mutate_voice_session(...)` executable by `hon_runtime`; and
- atomic, redacted audit plus inert `ai.voice.session.recorded` outbox evidence with `executionTriggered: false`.

There are no direct runtime table or column privileges. Private helpers are not executable by runtime, Supabase client roles, or `PUBLIC`. Canonical runtime provisioning (`infra/postgres/010_supabase_hon_runtime.sql`), SQL verification (`infra/postgres/011_verify_supabase_hon_runtime.sql`), and the JavaScript voice verifier enforce these ACL, RLS, function, trigger, scoped-FK, and fixed-column boundaries.

The same-origin `/staff/voice` workspace presents unavailable/offline/uncertain outcomes honestly, supports exact resume and private text fallback, and says explicitly that no connection or command execution is assumed. Conventional school navigation remains independent of voice.

## Validation record

The final implementation was validated only against a **fresh disposable local PostgreSQL database** named `hon_voice_validation`, recreated from all 83 migrations with a local `hon_voice_owner` migration role and non-superuser/non-`BYPASSRLS` `hon_voice_runtime` role. No remote database, provider, microphone, LLM, or action executor was used.

| Validation | Result |
|---|---|
| Fresh migration recreation and canonical runtime reconciliation | Passed; `0083_complete_voice_handoff_foundation.sql` applied as migration 83 |
| `pnpm db:test-voice` with sourced local-only environment | Passed: Complete/human/school/actor scope, HQ/parent denial, references, forward states, expiry, revocation, replay, concurrency, private draft/evidence redaction, direct ACL/FORCE-RLS, audit/outbox rollback, 20 JS+SQL drift denials, and zero provider/invocation/action/work/usage/billing/communication effects |
| `pnpm db:verify-rls` with sourced local-only environment | Passed: forced RLS on all 106 tracked operational tables and canonical runtime ACL checks |
| Clean root `pnpm check` with `DATABASE_URL` and `HON_RUNTIME_DATABASE_URL` unset | Passed |
| Clean root `pnpm test` with database variables unset | Passed (including the malformed-body controller regression) |
| Clean root `pnpm db:check` with database variables unset | Passed: 83 migration files |
| Clean root `pnpm build` with database variables unset | Passed |

## Explicitly deferred activation

A separate review is required before any live voice capability or downstream action is enabled. That work includes microphone/device permissions and recording, media custody/retention/deletion, speech-to-text/text-to-speech providers, provider credential custody/rotation and observed health, real-time connection/reconnection semantics, LLM prompting/output handling, conversation retention, usage/credit reservation and metering, provider retry/circuit/UNKNOWN reconciliation, durable work orchestration, and independently authorized Action Engine/tool execution with fresh approval/policy checks.

This ledger neither authorizes nor implies any of those capabilities.
