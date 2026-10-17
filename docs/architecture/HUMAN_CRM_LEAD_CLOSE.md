# Direct-human CRM lead close

## Delivered boundary

`/staff/crm/leads` remains the existing bounded, authorized CRM lead list. A close panel can appear **only** for a returned current `OPEN` list row. It accepts one explicit human choice—`WON` or `LOST`—an optional private internal close note, and a second confirmation. The browser never creates a panel from a query parameter, knows no lead directory beyond the pre-existing list projection, and does not rewrite its loaded list after a close. A human must explicitly reload the list to see a later authorized state.

The fixed command is:

```text
POST /organizations/:organizationId/schools/:schoolId/crm/leads/:leadId/close
```

The server derives the signed-in subject and resolves a live exact organization/school/principal scope. It requires active Essential/Core/Complete entitlement plus both `crm.lead.read` and the new sensitive `crm.lead.close` permission. Only direct `HUMAN_USER` / `HUMAN_UI` requests pass; parent/family, HQ, system, AI, automation, integration, Action Engine and delegated contexts fail closed. The trusted public origin, JSON request format and exact `X-HON-Human-Command: crm-lead-close` marker are required. Body, query and contextual-header fields cannot nominate authority.

## CRM-only transition

Migration `0145_human_crm_lead_close.sql` adds a fixed SECURITY DEFINER transaction. It rechecks identity, mixed-role/topology, organization/school, permissions and entitlement before and after short authority-table locks. It permits only:

```text
OPEN + expected version → WON | LOST
```

The transaction atomically updates only CRM lead status, the corresponding terminal timestamp, version and updated time. It creates immutable close-receipt evidence plus existing audit and inert outbox facts under one idempotency fingerprint. A replay requires the exact same retained key and normalized command; stale/terminal/competing close requests conflict. The private close note is not included in audit/outbox evidence and receives no reader/list endpoint.

> `WON` and `LOST` are internal CRM terminal states only. They are **not** enrollment, attendance, trial conclusion, conversion, membership, invoice, payment, revenue, consent, message, provider, AI, Action Engine or automation facts.

The new immutable close-receipt table is forced-RLS, has no raw runtime table grant or list API, and protects against raw terminal status updates—including caller-forged transaction settings. Canonical runtime reconciliation grants only fixed resolver/command functions; no lead directory or generic update access is added.

## Browser behavior

The same-origin, no-store transport accepts only closed receipt envelopes. An uncertain response retains the exact in-memory body/key for one manual retry; no polling, browser persistence, automatic retry or background refresh exists. Changing the close draft clears confirmation/error state. After either a receipt or a definitive rejection, the panel requires an explicit authorized lead-list reload before another close action.

## Evidence

Focused contracts/API/UI/transport suites prove the closed input/receipt, origin and marker guard, current-scope permission/tier requirements, OPEN-only version transition, exact retry, terminal/stale/concurrent conflict, list non-inference, and no executable automation/Action Engine registration. A marked disposable localhost integrity proof covers forced RLS, raw runtime/GUC forgery denial, all tiers, role/identity revocation, audit/outbox/receipt rollback, immutable evidence and no other-domain writes. The coupled marketing fixture uses the same authorized command instead of a raw `WON` update.

No external provider, message, payment, deployment, remote database or AI call is part of this slice.
