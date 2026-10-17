# Human CRM Lead List

## Purpose

The list inside `/staff/crm/leads` is a conventional, **read-only projection** over the existing `GET /organizations/:organizationId/schools/:schoolId/crm/leads` boundary. The same page now hosts separate explicit [canonical intake](HUMAN_CRM_LEAD_CREATE.md) and [CRM-only close](HUMAN_CRM_LEAD_CLOSE.md) panels, not a second CRM or a generic mutation directory. List authorization and handoffs remain independent of creation receipts.

The page starts empty. A human must enter one organization UUID, one school UUID, and an optional existing status filter. These values are route selectors only; the API independently resolves the authenticated human and exact current `crm.lead.read` school permission before returning any data.

After a Staff Dashboard or School Command Center has itself returned a verified current-school snapshot, its CRM links may append only that snapshot's organization/school UUID pair as a convenience prefill. Those query values remain untrusted: the leads page stays empty and makes no automatic list request, while the trial page makes no automatic read or command. Both destination APIs independently resolve the signed-in human and exact school authority; no report, metric, preference, entitlement, role, action, approval, receipt, student/family fact, or provider state crosses the handoff.

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

## Follow-up handoff

Each rendered, already-authorized row also has an ordinary **Create human follow-up** anchor. Its URL is exactly `/staff/crm/follow-ups?leadId=<uuid>`: it carries only the existing lead UUID, never organization/school, contact, status, version, appointment, or trial facts.

The Follow-ups route treats that value as a bounded, untrusted, one-time local draft prefill. It makes no request on mount, performs no lead lookup, and cannot expose the create form until the human explicitly loads the existing authorized queue. Only that server-derived queue may supply the current own-assignee default; access failure, refresh/pagination, queue/status changes, and form reset discard or clear the prefill. Nothing is persisted in browser storage, and the established server lead/scope/permission/version/idempotency checks remain final.

## Explicit non-effects

The list read itself does not create/edit/archive a lead, change a status/pipeline, save notes or execute a command. Only a separate confirmed canonical intake can create a lead/contact; only a freshly loaded OPEN row/version can prepare the separate explicit CRM-only close. Any create/close attempt leaves the list unchanged and requires an explicit reload before another close. Creation receipts never supply close rows or inferred list counts/status/filter membership.

Neither the list nor those two bounded panels sends messages, schedules/records a trial, reserves/checks in a class, creates a student/family/enrollment/membership/payment/agreement/consent/communication, calls a provider or model, invokes the Action Engine, or executes automation, work or external delivery. Trial/follow-up navigation remains only untrusted selector prefill.

It is not a family/parent/HQ/global directory and does not relax RLS, tenant scope, or least-privilege access.

## Validation evidence

Focused web coverage proves the empty/no-request posture, fixed same-origin no-store request, 50-row/redaction/shape/duplicate rejection, UUID-only lead handoff, no direct mutation/provider/AI/persistence capability, route registration, and untrusted no-command trial/follow-up selector handoffs. Workspace `pnpm test`, `pnpm check`, `pnpm build`, and `git diff --check` remain checkpoint requirements.
