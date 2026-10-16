# Human CRM Lead List

## Purpose

`/staff/crm/leads` is a conventional, **read-only** staff surface over the existing `GET /organizations/:organizationId/schools/:schoolId/crm/leads` boundary. It provides a practical entry point to the already-built CRM lead and trial workflow without creating a new directory, CRM model, customer-access model, or cross-school search.

The page starts empty. A human must enter one organization UUID, one school UUID, and an optional existing status filter. These values are route selectors only; the API independently resolves the authenticated human and exact current `crm.lead.read` school permission before returning any data.

## Returned projection

The browser accepts at most 50 current-school rows and only the existing `LeadListItem` projection:

- lead ID, current CRM lead status, pipeline-stage ID, person ID, version, and creation time;
- existing primary contact given/family name and recorded email/phone, if present;
- existing `nextFollowUpAt`, if present.

A malformed, extra, duplicated, foreign-shaped, or unauthorized response is rejected. The request is same-origin, `no-store`, and has no browser persistence, polling, background refresh, or client authority.

## Trial handoff

Each returned lead has one ordinary **Prepare trial appointment** link. It carries only the already-displayed organization, school, and lead UUIDs to `/staff/crm/trials` as untrusted query selectors. The destination pre-fills text inputs only:

- it does **not** load a lead, appointment, or any other record automatically;
- it does **not** schedule, send, retry, reserve, or execute anything;
- the trial command's server boundary still resolves human identity, exact scope, permission, type, state, and concurrency before any mutation.

## Explicit non-effects

This view does not create/edit/archive a lead; change a status or pipeline; save notes; send a message; schedule/record a trial; reserve/check in a class; create a student, family, enrollment, membership, payment, agreement, consent, or communication; call a provider or model; invoke the Action Engine; or create automation, work, or external delivery.

It is not a family/parent/HQ/global directory and does not relax RLS, tenant scope, or least-privilege access.

## Validation evidence

Focused web coverage proves the empty/no-request posture, fixed same-origin no-store request, 50-row/redaction/shape/duplicate rejection, no direct mutation/provider/AI/persistence capability, route registration, and untrusted no-command trial selector handoff. Workspace `pnpm test`, `pnpm check`, `pnpm build`, and `git diff --check` remain checkpoint requirements.
