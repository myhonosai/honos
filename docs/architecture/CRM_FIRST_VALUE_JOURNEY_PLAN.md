# CRM First-Value Journey Plan

**Status:** delivered and validated implementation slice
**Date:** 2026-10-18
**Scope:** ordinary staff CRM workflow only

## Goal

Make the existing canonical path from a new or selected CRM lead through a trial appointment and its final outcome usable in ordinary school operations without routine internal UUID copying. This is a conventional, direct-human workflow; it is not an agent, automation, enrollment, billing, or communication flow.

## The delivered slice

1. Resolve a current reporting school only through the existing server-authoritative staff scope APIs. When exactly one ordinary staff scope is valid it may be selected; when multiple ordinary staff schools are valid, show only the existing authorized school choices; mixed, family, HQ, nonhuman, and otherwise ambiguous contexts remain unavailable.
2. Read at most the exact school's configured non-terminal CRM intake stages through a new bounded read. The stage read is available only to a current human who already has the same live `crm.lead.create` permission and CRM entitlement required by the canonical create command.
3. Let that human enter the minimal primary contact and explicitly create a canonical lead with the selected stage. The existing lead-create domain command, idempotency, audit, and outbox boundaries remain authoritative.
4. Let the human choose an already authorized lead and open the existing trial appointment workbench with only untrusted organization/school/lead selector prefill. That workbench remains idle and independently reauthorizes before a human explicitly schedules a trial.
5. Use the existing final outcome command for the immediately verified scheduled trial. `COMPLETED`, `NO_SHOW`, and `CANCELLED` remain appointment facts only.

## Explicitly excluded

This slice must not infer or create a student, family, curriculum enrollment, membership, invoice, payment, payment authorization, agreement, consent, attendance, booking, seat, ClassPass record, staff availability, communication, reminder, provider call, AI request, Action Engine request, automation run, conversion, or revenue fact.

A trial outcome is not a lead state transition. A lead `WON` state is not enrollment or payment. Membership activation remains a separate direct-human lifecycle command. The later direct-human registration foundation is documented separately in [Human CRM lead registration](HUMAN_CRM_LEAD_REGISTRATION.md): it may create only the narrowly authorized person/family/student foundation and returns `NEEDS_STAFF_REVIEW` for ambiguity. Curriculum enrollment, membership/billing, agreement/payment authorization, consent and broader conversion remain separate governed boundaries; none may be improvised in browser code.

## Security contract

- Every browser query is same-origin, no-store, no-referrer and validates a closed response shape.
- The server resolves the current principal and school scope independently for every read or command. UI selection, query prefill, or receipt content is never authority.
- Intake-stage output contains only pipeline/stage identifiers and names needed for intake. It contains no lead/contact directory, staff/family data, metrics, counts, status history, automation configuration, or command capability.
- Consequential commands keep exact idempotency, optimistic-version, audit, and outbox behavior from their canonical services. There is no automatic retry.
- Staff, HQ, parent/family, nonhuman, delegated, and Action Engine contexts remain separated according to their existing controller/service policies.

## Validation evidence

Focused API/service/transport/UI coverage passed for current-school selection, multi-school choices, mixed-context denial, browser-compatible originless same-origin intake-stage reads, response closure, lead creation, lead/trial selector handoff, inactive-page scope clearing and final trial outcomes. The intake-stage read also passed a marked disposable localhost PostgreSQL proof covering a 25-row ordered non-terminal projection, no-write behavior, direct-table/helper ACL denial, cross-school exclusion, current human/permission/entitlement and HQ/family/mixed/nonhuman/delegated/action denial, forced RLS and function/grant drift rejection. Root `pnpm test` (392 API tests), `pnpm check`, `pnpm build`, `pnpm db:check`, and `git diff --check` passed. No shared/production records were used or mutated.

## Follow-up decision boundary

A later **lead-to-enrollment continuation** slice must define durable rules for any verified existing-record linking, multi-child convenience, contact correction, curriculum program selection, enrollment term, payer/billing account, membership draft, agreement status, payment authorization, and consent. It must not be inferred from trial completion, a lead close action, a registration receipt, or browser state.
