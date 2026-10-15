# Conventional human work-item workbench

## Purpose and non-goals

The [human work-item workbench](/staff/work) is a bounded **human recordkeeping** slice over the existing `hon.work_items` relation. It records a school staff member's practical next step and its lifecycle; it is not an AI queue, action proposal, scheduler, reminder system, communication feature, or execution service.

> A due date is optional UTC planning metadata. A completion records a human state change; it does not establish that an AI employee, provider, Action Engine, payment, message, campaign, or any external operation performed work.

Only work rows marked `work_origin = 'HUMAN_UI'` enter this slice. Existing durable work rows remain legacy data, are never enumerated by this workbench, and are not rewritten. The workbench has no comments, attachment, recipient/contact, directory-search, raw prompt/result, tool payload, or execution endpoint.

## Closed model, lifecycle, and visibility

A human work item has a bounded 1–120-character title, a 0–2,000-character description, `LOW`/`NORMAL`/`HIGH` priority, an optional canonical millisecond UTC due date from 2000–2099, and an optional already-known staff UUID. It is created `READY` at version 1. Full assignment/state metadata is append-only in `human_work_history`; private old title/description content never appears in queue/history projections.

| From | Permitted targets |
|---|---|
| `READY` | `WORKING`, `WAITING`, `NEEDS_ATTENTION`, `FAILED` |
| `WORKING` | `WAITING`, `COMPLETED`, `NEEDS_ATTENTION`, `FAILED` |
| `WAITING` | `READY`, `WORKING`, `NEEDS_ATTENTION`, `FAILED` |
| `NEEDS_ATTENTION` | `READY`, `FAILED` |
| `COMPLETED`, `FAILED` | none |

There is no invented cancelled/reopen/thinking/approval state. Create, update, and transition commands are optimistic-versioned and actor-scoped idempotent. The same key and fingerprint can replay only after the caller's current authority is checked again; a changed fingerprint conflicts.

| Live exact-school authority | Read and command scope |
|---|---|
| `work_item.create` | Create a self-assigned or unassigned item; see own created records. Assigning another person requires manager authority. |
| `work_item.self_manage` | Read and transition only a record currently assigned to that actor. |
| `work_item.manage` | Read the bounded `team` queue/detail, revise/reassign, and transition any human work item. |

All actors and assignable staff must be active, eligible `HUMAN_USER` staff with live effective exact-school grants. Parent/family/student/HQ/HON/platform/system categories, organization-wide or wrong-management-school authority, delegation, Action Engine context, and non-human sources are rejected. Active Essential, Core, and Complete organizations receive the same basic human work capability.

## Fail-closed SQL authorization

`0084_human_work_item_workbench.sql` uses only fixed-search-path `SECURITY DEFINER` boundaries. It locks organization, school, actor/current/target-assignee identities, grants, roles, role permissions, HQ grants, and entitlement before live rechecks. The private `work_items`, `human_work_history`, and `human_work_requests` tables use enabled and forced RLS with no policy and no direct runtime or client table/column grant.

Nullable authorization conditions are normalized to **false**. In particular, an unassigned record can never satisfy self-transition authority: the assignee must be non-null, match the current actor with `IS NOT DISTINCT FROM`, and have current `work_item.self_manage`. The initial command authorization, idempotent replay authorization, and final post-write authorization each use `COALESCE(..., false) IS DISTINCT FROM true`; an SQL NULL therefore denies rather than bypasses a check. The reusable permission and visibility predicates, queue manager flag, assignment eligibility, snapshot capability flags, and detail visibility checks also fail closed if a nullable relation/predicate does not prove authorization.

Successful commands atomically append a redacted audit event and inert `work_item.human_recorded` outbox event (`humanOnly`, `internalOnly`, `executionAllowed: false`) plus immutable receipt/history. Evidence omits title, description, due date, assignee, contact, prompt/output, and provider data. Any evidence failure rolls back the work row and receipt.

## HTTP/UI and legacy planning compatibility

The only API paths are:

| Route | Purpose |
|---|---|
| `GET /v1/staff/work?queue=mine|team&status=...&after=<uuid>` | At most 50 title-only human queue records. `team` is manager-only. |
| `GET /v1/staff/work/:id?beforeVersion=<n>` | Current authorized human detail and bounded metadata history. |
| `POST /v1/staff/work` | Create. |
| `POST /v1/staff/work/:id/revisions` | Manager-only revision/reassignment. |
| `POST /v1/staff/work/:id/transition` | Authorized lifecycle transition. |

The `/staff/work` page is a verified-session, no-index dynamic staff route. Its client starts empty, uses same-origin no-store requests, validates every response against exact closed shapes, clears private detail on access failure, and retains an uncertain mutation key only in page memory for a **manual exact retry**. It does not auto-retry, persist drafts/keys, show fake activity, or offer staff directory, recipient, timer, AI, send, or execute controls.

The existing decision-only `AiInvocationPlanService` remains compatible after `work_items` became private: it first requires its existing planning authority and calls the new fixed `hon.lock_ai_planning_work_reference(uuid)` boundary. That function only locks and confirms a current-scope reference; the planner still selects its minimal work ID/type/version/status internally under its own reviewed definer boundary. The workbench exposes at most existing scoped plan UUIDs; it never reads plan prompts, outputs, provider metadata, or causes planning/execution. No provider, AI, Action Engine, or execution behavior was changed.

## Validation, rollout, and deferred work

Focused validation is restricted to the exact guarded disposable local pair `hon_work_owner` / `hon_work_runtime` on `localhost:5432/hon_work_validation`. The reset aliases canonical runtime provisioning to the restricted work runtime role and refuse other hosts, roles, or database names. The fresh test builds required local artifacts, applies all migrations, runs integration behavior plus the JavaScript and canonical SQL ACL/RLS drift verifier, and proves actual-row forced-RLS owner non-bypass. It covers unassigned/self/manager/creator scopes, parent/HQ/nonhuman/cross-school denial, nullable unassigned transition denial, transitions/version races/replays/revocation, history redaction, immutable receipts, atomic rollback, and zero CRM/payment/communication/provider/AI/Action Engine/automation effects.

Root `pnpm check`, `pnpm test`, `pnpm db:check`, and `pnpm build` run with `DATABASE_URL` and `HON_RUNTIME_DATABASE_URL` unset. These are source/local proofs only: no remote migration, deployment, credential, provider call, worker, outbox consumer, timer, notification, payment, marketing action, or AI execution is activated.

> **Deferred:** comments, attachments, staff discovery, reminders/scheduling, external delivery, autonomous assignment, AI work orchestration, plan execution, and any Action Engine or provider consumer each require a separately reviewed authority, policy, execution, idempotency/reconciliation, and failure boundary.
