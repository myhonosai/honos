# Human Action Engine approval workbench

## Purpose and boundary

`/staff/action-center/approvals` is a **human review workbench** for existing Action Engine `CONFIRM` proposals. It lets an independently authorized human inspect the exact persisted intent and record **APPROVED** or **DENIED**. It is not an action-creation surface, payload editor, execution console, provider console, or automation queue.

> **A decision is not execution.** The workbench neither invokes an executor nor calls a provider, model, payment processor, communications service, membership service, marketing publisher, or background worker.

The browser selects an already-known school UUID only. The server derives the reviewer principal and organization from the verified session plus the live exact `action.approve` school permission. It never accepts an actor, organization, requester, reviewer permission, authority mode, provider credential, or execution instruction from the browser.

## Human review authority

The HTTP controller and the database checker require a direct, verified `HUMAN_USER` in `HUMAN_UI` context. They reject missing/ambiguous identities, inactive users/principals, HQ operators, parent roles, nonhuman principals, delegated requests, and Action Engine contexts. The direct reviewer must currently hold exact-school `action.approve`; an organization-only or wrong-management-school role cannot lend it.

A reviewer cannot decide a request they made or delegated. The requestor must still hold the request action's exact permission. Current organization/school topology, active entitlement, current policy version and `CONFIRM` authority, target validity, payload hash/safety, and approval expiry are revalidated under locks. The fixed `hon.require_human_action_review(text,uuid)` checker takes stable topology/IAM/entitlement/policy locks and rechecks current reviewer permission:

1. before inspecting or deciding;
2. **after any idempotency reservation or replay wait**; and
3. immediately before a new decision state/evidence write.

This avoids returning a replayed success or committing a decision on a permission that was valid only before the wait.

## Exact proposal binding and state

The detail projection exposes only a request's immutable, normalized payload when it is safe and its SHA-256 hash matches. Credential-like keys/content, unsafe payloads, and hash mismatch cause the entire payload to be withheld; no partial redaction can be approved. The screen shows action code, request/requester IDs, payload hash, required permission, policy version, proposed/current authority, expiry, delegation fact, current decision block, and bounded decision evidence.

The decision body must exactly repeat this displayed binding:

| Binding field | Required match |
| --- | --- |
| `actionRequestId` and `actionCode` | The scoped immutable request |
| `requestedByPrincipalId` | The original requestor |
| `payloadHash` | SHA-256 of the exact canonical normalized payload |
| `policyVersion` and `effectiveAuthorityMode` | Current valid `CONFIRM` policy and proposal binding |
| `approvalExpiresAt` | The original timed approval window |

A decision is rejected if any field is stale, unsafe, expired, self/delegator-conflicted, no longer `CONFIRM`, or invalid at its action-specific CRM lead target. `billing.invoice.issue` and other catalog actions without a reviewed revalidation adapter are intentionally blocked, not guessed or executed.

`ActionEngineService.beginExecution` retains its existing execution boundary. It now also rejects an `APPROVED` `CONFIRM` request with no timed approval binding before any state transition or adapter invocation. It deliberately does **not** read reviewer evidence from an Action Engine context, because that evidence is RLS-visible only to qualified human reviewers. A future execution adapter must retain its own domain revalidation and undergo separate review.

## API and browser transport

All responses use `Cache-Control: private, no-store`. The protected Next page uses the verified session cookie and redirects unauthenticated users to `/auth/login`; it is non-indexable. The browser calls only same-origin `/api/v1` rewrites.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/v1/staff/action-center/approvals/:schoolId?status=<status>&after=<uuid>` | 50-item scoped queue; `AWAITING_APPROVAL` by default or bounded status history |
| `GET` | `/v1/staff/action-center/approvals/:schoolId/:actionRequestId` | Exact safe/withheld detail and bounded decision evidence |
| `POST` | `/v1/staff/action-center/approvals/:schoolId/:actionRequestId/decision` | Exact human approval/refusal receipt only |
| `GET` | `/v1/organizations/:organizationId/schools/:schoolId/action-requests/:actionRequestId` | Retained scoped review detail contract |
| `POST` | `/v1/organizations/:organizationId/schools/:schoolId/action-requests/:actionRequestId/decision` | Retained scoped decision contract |

POST requests require configured `HON_PUBLIC_ORIGIN`, exact origin, JSON content type, `X-HON-Human-Command: action-approvals`, and an `Idempotency-Key`; cross-site fetches are denied. The client validates closed response shapes, UUIDs, timestamps, pagination, statuses, and the canonical browser SHA-256 before displaying a payload. It starts empty, retains only an uncertain exact input/key in page memory, never auto-retries, clears sensitive state on access loss, and does not report a decision as an execution result.

The route manifest and both staff navigation shells link to `/staff/action-center/approvals` as **Action Center**.

## Persistence, RLS, and audit

Migration `0082_human_action_approval_workbench.sql` adds no new executor, handler, consumer, external integration, or general database capability. It adds only:

- `hon.require_human_action_review(text,uuid)`, a locked live human-review authority check;
- `hon.human_action_reviewer()`, a restricted qualified evidence-read predicate;
- immutable proposal/evidence triggers and a review-queue index; and
- a restrictive RLS `SELECT` policy on `action_approvals` for qualified human reviewers.

Existing request, approval, policy, audit, outbox, and idempotency tables remain tenant-scoped and FORCE-RLS. Runtime permissions are the reviewed minimum: request `SELECT/INSERT/UPDATE`, policy `SELECT`, and qualified approval evidence `SELECT/INSERT`; no delete, truncate, directory, broad function, provider, or tool grants are added. The immutable triggers prohibit request identity/payload/policy binding edits and any approval evidence update/delete/truncate.

Successful decisions atomically write the terminal request status, immutable approval evidence, a redacted `action.request.decide` audit event, an inert `action.request.decided` outbox event, and an idempotency receipt. Audit/outbox fields include IDs, action, decision, hash/policy and `executionTriggered:false`; they exclude payload/contact/reason/credential values. Existing `recordExecutionOutcome` remains separate and is not called by this workbench.

Canonical runtime provisioning/verifier scripts (`infra/postgres/010_supabase_hon_runtime.sql`, `011_verify_supabase_hon_runtime.sql`) and `action-approval-security.mjs` assert exact role posture, function owner/definer/path/ACLs, RLS policies, table privileges, triggers, and scoped foreign keys.

## Local-only verification and rollout

Run only from an existing private job directory and a scrubbed shell with no provider, payment, messaging, action, worker or execution configuration: set `HON_ACTION_APPROVAL_VALIDATION_TARGET=postgresql://localhost:5432/hon_approval_validation` and a fresh normalized `HON_ACTION_APPROVAL_ENV_FILE=/home/ubuntu/jobs/<job>/action-approval.env`, then run `pnpm db:setup-action-approvals`, source that private env file, and run `pnpm db:test-action-approvals`. Setup refuses every non-local target, unmarked existing database/role aliases, external-provider/payment/messaging namespaces, paid/live/execution gates and action/provider/worker namespaces. It resolves the parent directory under the canonical job root, rejects an existing or symlinked output, creates and verifies a regular owner-owned mode-0600 file, and supplies migrations only a minimal allowlisted environment plus generated local URLs. It creates the exact `hon_approval_owner` and `hon_approval_runtime` aliases, applies the full ordinary migration sequence, and reconciles the canonical runtime grant SQL twice.

Coverage includes scope/HQ/parent/nonhuman/delegation/self denial, requestor/reviewer revocation, wrong-role-school denial, expiry (including post-lock expiry), policy/entitlement/target changes, payload safety/hash withholding, exact binding, replay/concurrent idempotency, post-idempotency reviewer rechecks, atomic audit/outbox rollback, no forbidden domain effects, canonical and JavaScript ACL/RLS drift attempts, and actual-row non-bypass-owner FORCE-RLS probes. API tests cover direct HUMAN_UI route derivation/closed input and the execution validity rejection without executing an adapter; web tests cover closed browser transport, payload/receipt verification, protected navigation, and no fabricated success.

This change performs **no remote migration or deployment**. It does not authorize a provider call, external action, future executor/worker/consumer, or a broader action-specific revalidation adapter.
