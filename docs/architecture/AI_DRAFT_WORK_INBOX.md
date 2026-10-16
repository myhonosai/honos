# AI Draft Work Inbox

## Purpose

`/staff/ai-work` is a **human-only, current-requester work index** for the implemented Marcus (marketing), Claire (teaching), and Chad (CRM follow-up) drafting slices. It makes durable work visible without turning the HON UI into a provider console, chat transcript, delivery queue, or generic AI gateway.

It is a presentation of work already created through the existing bounded assistant services. It creates no work, invokes no model, sends no message, publishes no content, saves no content, charges no credits, and makes no Action Engine decision.

## Read boundary

Each assistant owns one fixed `SECURITY DEFINER` function:

| Agent | Function | Source record | Allowed output |
|---|---|---|---|
| Marcus | `hon.list_my_marketing_invocations(text)` | Campaign | Durable ID, agent key, current school, campaign reference, work-item reference, status/reason, action-request reference, update timestamp |
| Claire | `hon.list_my_teaching_invocations(text)` | Curriculum | Durable ID, agent key, current school, curriculum reference, work-item reference, status/reason, action-request reference, update timestamp |
| Chad | `hon.list_my_chad_follow_up_invocations(text)` | Lead | Durable ID, agent key, current school, lead reference, work-item reference, status/reason, action-request reference, update timestamp |

Every function reuses the slice's live direct-human, exact school, Complete-tier, entitlement and permission resolver. It accepts no tenant, agent, status, provider, model, pagination or search selector. It returns at most 20 requester-owned records in deterministic newest-first order.

The result deliberately excludes prompts/briefs, generated draft text, raw provider output, provider/model IDs, usage/tokens/costs, recipient/contact/lead fields, names, payment data, Action payloads and any raw table row.

## UI and resumption

The UI calls only fixed same-origin GET endpoints with credentials, no-store caching and a fixed command header. It treats access loss as unavailable, clears stale content, and validates the exact response envelope before display. The **Governed AI Work** workspace distinguishes unavailable, empty, error and recorded-state views; it contains fixed links to the existing bounded Marcus, Claire and Chad draft guides. A row may point to its existing agent-specific screen with an opaque invocation fragment; each original workbench still reads its own exact durable record through its existing controlled endpoint.

The Inbox says **recorded status**, never completed delivery or live agent availability. `AWAITING_APPROVAL`, `SAVED`, `REJECTED`, `UNKNOWN`, or any other state remains a statement about the existing durable assistant work only. Only an `AWAITING_APPROVAL` record with an opaque Action Engine request reference exposes a generic link to the existing qualified-human Action Center; it does not display or pass that reference as a URL selector, and the Action Center independently re-authorizes every visible approval. Terminal `APPROVED`/`REJECTED` records describe only that a historical handoff occurred and never claim review remains available. A model/provider failure never implies success, and no inbox button can retry, approve, deliver, publish or save content.

## Security invariants

- No direct select, insert, update, delete, truncate or column access is granted on private invocation/draft tables.
- The runtime role receives only the three fixed function executions; public/client roles have none and no grant option.
- No AI employee, automation, Action Engine delegation, parent, HQ operator, external browser input or arbitrary principal can use the projection.
- A requester can never view another requester's work, even if both otherwise have current assistant permissions in the same school.
- Existing assistant proposal/review/save gates remain unchanged. The Action Engine retains complete authority over consequential operations.
- The implementation has no provider SDK, key, raw HTTP/provider transport, payment, communication, voice or worker path.

## Validation

The three existing guarded disposable-local assistant fixtures now prove current-requester-only list visibility and redaction under restricted runtime roles, along with their prior Complete entitlement, tenant, role, audit/outbox, Action Engine approval and no-delivery coverage. Focused API and browser checks cover fixed endpoint/response/route behavior. `db:verify-rls` verifies the sealed function posture and client denial for standard and relevant isolated runtime aliases.

No live provider inference or outbound action is part of this feature.
