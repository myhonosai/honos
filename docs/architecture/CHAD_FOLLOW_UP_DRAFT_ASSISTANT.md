# Chad Follow-up Draft Assistant

## Scope

Chad is a **Complete-tier, direct-human staff** assistant that may prepare one structured `FOLLOW_UP_DRAFT` content proposal for an already-known, permitted, current-school `OPEN` CRM lead. The caller supplies only:

- `leadId`;
- the observed `expectedLeadVersion`; and
- a closed purpose: `INTRODUCTION`, `CHECK_IN`, `TRIAL_REMINDER`, or `REENGAGEMENT`.

There is intentionally no lead directory, contact lookup, actor/school/provider/model/tier selector, free-form prompt, arbitrary HTTP/SQL/tool surface, or credential input. The prepared provider request contains only server-derived non-identifying current lead metadata and a purpose code; it never passes contact addresses or names.

## Authority and lifecycle

Migration `0107_chad_follow_up_draft_assistant.sql` adds private forced-RLS invocation/draft evidence and a fixed `DRAFT_FOLLOW_UP` text-planning route. Every request rechecks a direct active human, an unambiguous current school, current active Complete entitlement, exact `crm.lead.read`, `crm.assistant.follow_up_draft`, and `ai.invocation.plan` permissions. It locks and checks the known lead is still `OPEN` at the caller's expected version before planning and again immediately before review.

A healthy HQ-selected TEXT plan is metadata only. The OpenRouter-compatible adapter sits behind `ChadProviderRuntime`; it requires both `OPENROUTER_API_KEY` and the explicit `OPENROUTER_PAID_CALL_APPROVED=true` gate before it can attempt transport. The default absent gate reports `CONFIGURATION_REQUIRED`; no test uses a provider request. A confirmed model result is bounded to `subject`/`content`, writes durable usage and immutable draft evidence, then creates the exact `crm.follow_up_draft.propose` Action Engine `CONFIRM` proposal. The normalized payload includes the immutable invocation/lead/version/purpose/content plus `delivery: NOT_CREATED_OR_SENT`.

A separate current qualified human must approve or deny the exact payload hash, policy version, and expiry; the requester cannot self-review. Approval is **not execution**: `ActionEngineService.beginExecution` explicitly rejects Chad's action. Chad approval only records the immutable content proposal's `APPROVED` state; denial records `REJECTED`.

## Explicit non-effects

Neither request, planning, result recording, review, approval, nor denial can send, queue, deliver, schedule, create a calendar appointment, mutate a CRM lead or human follow-up record, change a membership, create a discount/refund/payment, invoke a normal Action Engine executor, or call arbitrary tools/HTTP/SQL. A later outbound message needs its own reviewed communications workflow with current consent and receipt/delivery evidence. Approval here is never permission to deliver the draft.

## Validation

Focused API coverage injects a rejecting transport and proves the absent paid-call gate makes **zero external calls**, while rejecting provider/tool/recipient/consent/schedule selectors and unsafe content. The no-index `/staff/leads/assistant` UI uses fixed same-origin requests, displays configuration/blocked/unknown/review/no-delivery states, and does not enumerate leads.

**Limits:** the local fixture suite has not been executed in this change; no remote/Supabase migration, provider call, paid-call approval, or external delivery was performed. Semantic PII classification is not provided—staff are instructed not to enter personal/private data—and an actual outbound communications/consent/receipt workflow remains separate future work.
