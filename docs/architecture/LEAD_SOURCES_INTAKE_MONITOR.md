# Lead Sources & Intake Monitor

## Status

**Corrected implementation boundary for review.** This document defines the first, provider-free staff monitor. It does not activate Zernio, Meta, Google Ads, webhooks, advertising, messaging, AI automation, or customer communication.

## Purpose

The monitor gives a school operator one bounded place to understand the status of existing website-form intake and navigate to the governed workbenches that already own CRM leads, human duplicate review, trial appointments, campaign attribution, and Chad follow-up drafting.

It is deliberately not a second CRM directory, a provider dashboard, a conversion dashboard, or an automation console.

## Authoritative data and availability

| Surface | Source | What the monitor may state | What it must not state |
| --- | --- | --- | --- |
| Website forms | Dedicated same-origin `GET /api/v1/marketing/forms/intake-monitor` projection under the existing `marketing.form.read` guard | Current form title, lifecycle, accepted-new-lead count, and whether a campaign association is recorded | Form/public/pipeline/campaign IDs, descriptions, optional fields, versions, timestamps, raw submission, consent, message state, lead state, provider delivery, payment, enrollment, or revenue |
| Facebook / Instagram | None in this slice | `NOT_CONNECTED`: a future Zernio adapter has not been configured or activated | Account connection, ad spend, live lead sync, delivery, attribution, or a provider health claim |
| Google Ads | None in this slice | `UNAVAILABLE`: this page makes no Google call; existing public forms can be configured with an existing campaign association | Clicks, spend, live conversions, provider attribution, or ROI |
| Campaign cohort | Existing Campaign Planning workbench | The existing separate workbench is the authorized location for redacted campaign cohort aggregates | A cross-domain campaign list or a browser-inferred funnel |
| Lead, trial and enrollment flow | Existing CRM Lead and Trial workbenches | Navigation to the separately authorized human workflows | A lead-to-trial conversion, enrollment, membership, payment, or revenue outcome |
| Duplicate review | Existing Lead Migration Center | Navigation to its human, versioned import/skip review | A match, merge, deduplication outcome, or imported count |
| Chad | Existing Chad follow-up draft guide | Navigation to a manual, governed draft workflow | An automated follow-up, sent message, task execution, or provider call |

`WON` remains a CRM terminal state, not proof of enrollment, payment, or revenue. Full campaign-to-enrollment/revenue linkage remains a separately governed delivery item.

## Scope, privacy, and lifecycle

- The monitor begins idle and does not fetch on route load or query parameters.
- Its sole read is a dedicated bounded same-origin monitor projection. The server derives the current human/school context, enforces `marketing.form.read`, validates the internal form response, and drops all identifiers and private configuration before the browser response is created.
- It displays and receives no form/public/pipeline/campaign ID, description, optional field, version, timestamp, source PII, raw receipt, contact data, import evidence, or private campaign metadata.
- It has no mutation control, idempotency key, command header, raw SQL, provider credential, provider request, polling, browser storage, background retry, or AI invocation.
- A denied, invalid, uncertain, blur, page-hide, hidden-document, unmount, same-user school-context transition, or confirmed authenticated-session invalidation clears returned monitor facts from memory, cancels an in-flight request, and rejects a late response by generation. Reload is an explicit human action.
- A confirmed same-origin `401` from either the monitor transport or the authenticated language-preference transport dispatches the narrow client session-invalidation event; `403` remains a local authorization denial and never asserts that the whole session ended. Anonymous/public form transport does not dispatch this event. The protected route also derives an opaque hash from the verified session server-side and keys the monitor to it; the cookie itself is never serialized.
- All navigation is ordinary same-origin navigation. Links carry no record, authority, campaign, provider, contact, family, billing, or execution selector.

## Presentation and language

The workbench is an isolated route/component and does not modify shared visual components, HON marks, portraits, or Claude/Codex experimental assets. Modern HON, Classic CRM, and Big-Button / Phone are local presentation modes only: they are available before an intake read and vary density/touch target sizing without changing requests, scope, data, authority, or links. The visible monitor copy resolves from the active English, Korean, or Spanish interface language; organization-specific data remains server-returned and is not translated or altered. One persistent, atomic live region reports idle/loading/verified states politely and denied/unavailable/session-invalid states as alerts; it never programmatically moves focus.

## Follow-on dependencies

1. A separately approved Zernio provider adapter needs school-scoped credentials, webhook verification, mapping/version policy, idempotency, deduplication review, consent boundaries, delivery/reconciliation evidence, rate limits, and audit/outbox coverage before any Facebook or Instagram lane can report more than `NOT_CONNECTED`.
2. Google Ads attribution requires an approved consent/privacy model, credential and account isolation, source/event-time linkage, reconciliation, cost/spend evidence, and distinct aggregate/reporting contracts before any provider conversion or ROI claim.
3. Campaign-to-enrollment, membership, payment, revenue, retention, and ROI reporting needs an authoritative event-time linkage policy. It is not inferred from a CRM `WON` state.
4. Chad may prepare governed human-reviewed drafts through its existing boundary. Automated sequencing, delivery, or financial/customer-impacting action remains outside this monitor.

## Acceptance boundary

The first slice is complete only when the isolated route returns no facts before an explicit authorized form read; rejects/scrubs stale data safely; supports English, Korean, and Spanish copy; keeps all three presentation modes semantically identical; includes focused tests for transport closure, unavailable provider truthfulness, no automatic read/effect, route manifest registration, and no browser persistence/provider/AI use; and passes web checks/build plus broader regression before review.

## Validation evidence

The F1/F2 corrective run passed the dedicated API form suite (10 tests, including a real Nest loopback of the monitor endpoint) and focused monitor/public-form UI suites (18 tests). The F1 language-transport follow-up then passed 34 focused monitor, language-transport, and localization tests covering authenticated GET/save `401` propagation into a co-mounted READY/LOADING monitor, late-response rejection, `403` locality, anonymous/public isolation, normal language save, and fresh-read-only recovery. Provider-free root workspace validation passed: `pnpm test` (509 passing), `pnpm check`, `pnpm build`, and `git diff --check`. The route manifest was parsed and contains exactly one `/staff/marketing/intake` declaration.

The guarded local PostgreSQL dispatcher passed all **41** disposable proofs over all 189 migrations. The public-form fixture now proves the real signed-session Nest endpoint against a restricted runtime database; one school then another for the same subject, two-scope ambiguity refusal, parent/HQ/limited/nonhuman refusal, absent/malformed/expired session refusal before scope/data access, suspended/expired entitlement refusal, current read-permission revocation, exact minimal response closure, no-effect snapshots, and both valid PostgreSQL lock serializations for a live permission revocation. It uses only a marked localhost fixture and deletes generated credentials on exit.

[The review-capture record](../review/LEAD_INTAKE_MONITOR_SCREENSHOTS.md) contains genuine idle and explicitly labeled synthetic loaded-state layout captures. The latter use only a temporary local minimal projection and are not customer/school records or provider evidence. Browser inspection confirmed named landmarks and controls, keyboard presentation selection, a single status/alert region, no horizontal overflow, and no new monitor request from a presentation switch. A temporary local F1 fixture additionally confirmed that a genuine browser language `401` dispatched the named invalidation event, cleared a previously loaded monitor, showed its existing session-invalid alert, and preserved focus; that fixture, its server, and its synthetic endpoints were removed before checkpointing. The protected staff route remains behind the verified web-session gate. No database migration, provider credential/call, advertising action, customer communication, AI execution, payment, deployment, or merge was performed. GitHub Actions manual-dispatch evidence remains a required PR approval gate.
