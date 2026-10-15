# OpenRouter Marketing Assistant — bounded live validation

**Date:** 2026-10-15
**Status:** Completed once under explicit owner authorization; not a production activation

## Scope

This record covers the first deliberately bounded, paid, tenant-scoped HON Marketing Assistant inference after the approved provider-control, invocation-planning, Action Engine, approval, audit, and usage-accounting foundations were in place.

It was a controlled development validation only. It did **not** enable a recurring worker, automated marketing, public publishing, external communication, campaign-content persistence, provider health polling, or broad model access.

## Executed route

| Control | Verified result |
|---|---|
| Provider | `OPENROUTER` server-side adapter |
| Approved model | `google/gemini-2.5-flash-lite` |
| Tenant selection | Isolated development organization and school under a verified direct human owner scope |
| Tier | `COMPLETE` |
| Request type | `MARKETING_COPY_DRAFT` |
| Action authority | `CONFIRM` |
| Action state after generation | `AWAITING_APPROVAL` |
| Invocation state after generation | `AWAITING_APPROVAL` |
| Usage ledger | Persisted atomically with provider/model, input/output units, cost and customer-credit evidence |
| Input/output units | 126 / 526 |
| Provider-cost evidence | 223 USD micro-units |
| Customer-credit evidence | 1 credit |

## Governance outcomes

- The generated text was retained only as an immutable private draft associated with the governed invocation.
- The resulting Action Engine proposal is **not executable** until a qualified human reviews the exact persisted payload under the normal approval path.
- No marketing content was saved to campaign content.
- No communication, publishing, payment, membership, CRM mutation, Action Engine execution, or external delivery occurred.
- Three internal-only outbox evidence events were recorded; no consumer or provider delivery was activated.
- The restricted `hon_runtime` role had no direct `SELECT` privilege on invocation, draft, or saved-content tables. Runtime access remains through the reviewed fixed-function/service boundary.

## Deliberately not activated

1. A recurrent AI worker or automatic draft generation.
2. OpenRouter fallback or multi-provider execution.
3. Provider health checks, retries, circuit handling, or UNKNOWN-outcome reconciliation beyond the bounded adapter behavior.
4. Human approval execution that would save content or publish externally.
5. HeyGen, Higgsfield, direct LLM, voice, or media provider adapters.
6. Production tenant use, provider budget changes, or subscription entitlement changes.

## Operational conclusion

The first real provider call confirms that the implemented Marketing Assistant path operates through **HON-owned tenant scope, provider routing, Action Engine confirmation, approval state, audit/outbox evidence, and usage/cost accounting**, rather than Manus runtime AI. It remains intentionally gated and narrowly scoped pending separate approval for any further paid/provider behavior or external effect.
