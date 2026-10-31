# Connected staff CRM operating journey

Source baseline: `b234be7f14c49d07349219dfb4ae3b9c2a05d3f9`. PRs #90 and #94 and their branches are excluded.

`docs/hon/START_HERE.md` is absent at this baseline. The existing `docs/hon/README.md`, external handoff, Master Directive, TODO and domain contracts were reviewed instead. Historical tier/pricing prose is not new commercial authority.

## Verified contract inventory (before implementation)

| Step | Implemented API / source | Permission and actual effect | Gap / classification |
| --- | --- | --- | --- |
| Lead lookup | GET `/organizations/:org/schools/:school/crm/leads?limit=50`, LeadController/LeadService, `crm-leads-http.ts` | Live `crm.lead.read`, exact school/organization, RLS; bounded contact summary | Usable read-only. No arbitrary search, single-lead detail or complete history. The 50-row result is not the whole school. |
| Context | GET `/staff/current-reporting-school`, existing dashboard context reader | Independently authorized reporting scope; returns RESOLVED or MANUAL_ENTRY_REQUIRED | Optional convenience only; it cannot grant CRM permission. Ordinary links from the existing authorized lead list prefill selectors; every read authorizes independently. |
| Internal follow-up | GET/POST `/staff/crm/follow-ups`, FollowUpController/Service, migration0079, shared `crm-follow-ups` | `crm.lead.read` plus self_manage/manage; exact unambiguous school, known current principal assignment; append-only versioned record, audit/inert outbox/idempotency | Usable. No outbound contact, reminder, staff directory or inferred lead-stage change. Queue is bounded; not all school history. |
| Trial appointment | POST `/organizations/:org/schools/:school/crm/leads/:lead/trials`, TrialAppointmentController/Service | `crm.trial.schedule`, HUMAN_UI, tenant transaction, idempotency/audit/outbox | Usable create. Future timezone-qualified instants within90days. No appointment list/detail reader or durable UI recovery; no booking/calendar invite. |
| Trial outcome | POST `/organizations/:org/schools/:school/crm/appointments/:id/outcome`, TrialAppointmentOutcomeController/Service | `crm.trial.manage`, expected version, SCHEDULED TRIAL only; COMPLETED/NO_SHOW/CANCELLED | Usable only for this tab's exact verified scheduling receipt. No imported/manual appointment ID or inferred outcome. No automatic follow-up or lead close. |
| WON/LOST | POST `/organizations/:org/schools/:school/crm/leads/:lead/close`, shared `crm-lead-close`,0145 | `crm.lead.close`, current OPEN/version, direct human, protected canonical SQL; exact replay | Usable CRM-only close. Does not prove enrollment, revenue, payment or trial completion. A fresh list is required for current lead state. |
| Optional registration | POST `/organizations/:org/schools/:school/crm/leads/:lead/register`, LeadRegistrationController/Service,0159/0176 | `crm.lead.register`, explicit ADULT or GUARDIAN_CHILD confirmation, exact contact linkage, needs-review ambiguity | Usable person/student/family registration record only. No billing account, payer designation, agreement, membership or paid enrollment in this journey. |
| Recovery | POST `.../registration-recovery` and `.../guardian-child-enrollment`,0174/0176 | Existing protected explicit read, registration receipt versus verified current-DRAFT states; other creator privacy | Existing Resume Setup remains separate and unchanged. Historical registration does not prove current membership. |
| History | Current lead list; follow-up queue/detail; validated command receipts | Response-backed bounded evidence | No unified activity timeline or trial history API. This tab's receipts are explicitly historical, not an authoritative full history. |

## Planned frontend boundary

One protected `/staff/crm/journey` route will carry a selected, freshly authorized lead through explicit human actions. No action is mandatory solely because a previous step was shown. Follow-up scope must match the selected school's verified list. Buttons are presentation, not capability grants; every backend command independently reauthorizes. New requests use fresh keys; unknown results retain exact serialized payload/key in private mounted memory. No automatic consequential retry or browser storage.

Privacy conceals the complete mounted workspace on blur/hidden/pagehide. Read epochs and command-instance lifetimes are separate so a concealed command can settle without locking restoration. Session invalidation, school change and unmount invalidate late results. Explicit restoration rechecks signed identity and exact-school lead access; follow-up facts require a fresh independently authorized queue. Historical trial/registration/close receipts never become refreshed current-state facts. No UI-derived role/entitlement/selected-school authority.

## Remaining backend dependencies

- Exact-school trial appointment detail/history and safe receipt recovery before a durable multi-day trial workflow can be complete.
- Search/pagination beyond50lead summaries, school names/context resolution without unrelated reporting permission, and a minimized authorized activity timeline.
- Complete lifecycle messaging/consent, enrollment agreements, billing and parent provisioning remain separate, deliberately unavailable operations.
- Multi-school ambiguity in follow-up resolver fails closed; do not simulate a school switch or use the queue from another school.
- Existing trial scheduling validates future dates before idempotency replay: an uncertain request retried after its start may be refused. No new-key retry or duplicate appointment is offered; durable reconciliation needs a backend read.

No backend, migration, authority, outbox-consumer, external-provider or activation change is authorized by this frontend.

## Implemented privacy and recovery limits

The new view reuses shared closed validators, canonical paths and command headers. It adds no API. Individual steps are navigation, not a required backend state machine or automatic completion score. A lead can have independent follow-ups, appointments and CRM state.

A normal explicit lead refresh preserves this tab's clearly historical response receipts. After focus-loss restoration, old form values and detailed receipts are **not** revealed by lead-read permission alone. They are cleared, while a consequential unknown request remains frozen in a separate private ref and can only be retried explicitly. The fresh lead read is bracketed by signed identity checks. Follow-up and registration preflight facts require their own separate explicit authorized reads again.

A successful scheduled appointment concealed by focus loss cannot be recovered as current appointment state: trial controls show the missing-reader limitation and block replacement scheduling in this tab. This conservative boundary needs a minimized exact-school trial detail/recovery API before staff can operate a durable multi-day trial queue. A full document destruction/navigation loses private retry memory; it cannot cancel a server action. New commands never reuse abandoned keys automatically.

The existing follow-up SQL explicitly locks/rechecks live authority. The new disposable proof verifies a real HTTP request waiting on a permission lock and being refused after revocation commits. Existing lead/trial generic resolvers and tenant services remain unchanged; broader post-resolution authorization/entitlement race guarantees must not be inferred from this single follow-up proof. These older boundaries need their own backend review before claiming every legacy CRM read/command is serialized against all IAM changes.

The new journey is localized in EN/KR/ES. Ordinary links preserve the existing adult/family Resume Setup interfaces, whose untranslated text and broader lifecycle gaps are not claimed fixed here. No new support, AI, messaging, billing, parent or enrollment authority is added.

## First hosted verification findings

The full canonical proof suite was actually attempted. On October31 the unchanged `test-saas-subscription-integrity.mjs:193` fails because its JavaScript `setUTCMonth` expectation overflows October31+1month to December1, while PostgreSQL clamps to November30. This PR changes no billing implementation or historical proof. The suite stops at this failure; later proofs are not claimed passed. The separate connected-journey API/database step still executes to collect independent CRM evidence, while the job retains its canonical-suite failure.

Mounted browser testing exposed a genuine new-form defect: updating dirty state during input capture could restore the first controlled field before React's onChange read its value. Edits now read and store the value in the normal handler before updating dirty/confirmation state. The synthetic provider-free browser test remains strict about receiving a new validated receipt for each command.

A403during replay is not evidence that the original unknown operation failed. The request remains immutable and concealed, detailed forms/receipts are cleared, and explicit signed-session/school restoration is required before another human retry. Confirmed session replacement/invalidation permanently clears private memory to prevent cross-identity sharing; safe server-side reconciliation is then a backend dependency, not browser persistence.
