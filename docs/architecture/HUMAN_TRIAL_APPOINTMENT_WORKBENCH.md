# Human Trial Appointment Workbench

## Purpose

`/staff/crm/trials` is a **direct-human CRM appointment workspace** over the existing canonical trial-appointment and trial-outcome domain services. It closes a practical conventional CRM step between an already-known lead and a recorded trial appointment without creating a second CRM, scheduling, booking, enrollment, or communication model.

It is intentionally narrow: the page can create one future `TRIAL` appointment for one already-known lead and can record one final human outcome only for the immediately verified in-memory `SCHEDULED` receipt. It does not list leads or appointments, replace Staff Search, or create a calendar integration.

## Existing command boundaries

| Route | Existing service boundary | UI posture |
| --- | --- | --- |
| `POST /organizations/:organizationId/schools/:schoolId/crm/leads/:leadId/trials` | Canonical `crm.trial.schedule` appointment creation | Fixed same-origin direct-human command with generated idempotency key |
| `POST /organizations/:organizationId/schools/:schoolId/crm/appointments/:appointmentId/outcome` | Canonical `crm.trial.manage` terminal outcome record | Available only for the page's exact verified `SCHEDULED` receipt and its current version |

The browser accepts entered organization, school, lead and appointment identifiers only as route selectors. The API independently resolves the authenticated human, current authorization, organization/school scope, and direct `HUMAN_UI` source. A known identifier never grants access.

## Truthful lifecycle

1. A human supplies an already-known organization, school, lead, future UTC start/end, and optional internal location/note.
2. The existing service validates time window and live `crm.trial.schedule` authority, creates only `crm_appointments` `TRIAL/SCHEDULED`, plus its normal audit/outbox/idempotency facts.
3. The browser displays a receipt only after strict response validation binds the returned lead, `TRIAL` type, `SCHEDULED` state, canonical start/end instants and initial version `1` to the exact scheduling command. A differently timed or non-initial same-lead response is rejected and cannot expose an outcome control.
4. Only that in-memory receipt exposes the final-outcome form. The existing outcome service rechecks direct-human context, current `crm.trial.manage`, school/RLS scope, appointment type, `SCHEDULED` state and expected version before writing `COMPLETED`, `NO_SHOW`, or `CANCELLED`.
5. An error never becomes success. The exact request body/key remains in memory only for an explicit retry; changing scheduling inputs clears the receipt/retry, while changing outcome inputs clears its retry.

The workbench does not retain appointment state across reload. It purposely does not offer a generic appointment selector, history reader, lead directory, or browser persistence. Staff must use an established authorized CRM workflow to find another record.

## Explicit non-effects

A scheduled appointment or recorded outcome does **not**:

- send an email, SMS, reminder, notification, calendar invite, or any other external delivery;
- reserve a class seat, create a class booking, admit/check in an attendee, or record attendance;
- change lead status/pipeline stage or prove a trial-to-enrollment conversion;
- create/update a person, student, family, enrollment, membership, payment method, invoice, payment, consent, or agreement;
- invoke AI, a provider, the Action Engine, automation, a worker, or an external integration.

No `BOOKED`, `WAITLISTED`, attendance, enrollment, membership, payment, consent, delivery, conversion, or revenue claim is displayed by this surface.

## Validation evidence

The focused web coverage proves the page starts without fetching or a fabricated receipt, validates strict same-origin scheduling/outcome response linkage, rejects foreign/consultation/non-scheduled/private/extra response data, uses generated idempotency keys, constrains outcomes to an exact scheduled receipt/version, registers only `/staff/crm/trials`, and has no browser persistence/AI/message/execution capability. Workspace `pnpm test`, `pnpm check`, `pnpm build`, and `git diff --check` remain checkpoint requirements.
