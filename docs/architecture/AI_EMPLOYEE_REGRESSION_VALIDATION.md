# AI Employee Regression Validation

This validation increment covers the existing **Marcus Marketing Assistant**, **Claire Teaching Assistant**, and **Chad Sales Follow-up Draft Assistant** slices. It is intentionally integration-first: each focused test exercises the existing restricted runtime role, durable work item, immutable AI invocation plan, HQ routing metadata, usage ledger, and **shared HON Action Engine**. It adds no execution framework, provider configuration, entitlement, identity, pricing, or provider-semantics change.

## Safety boundary

All focused tests use an injected fake provider and replace global `fetch` with a rejecting sentinel. Setup/test scripts refuse provider credentials, paid-call gates, and non-local targets where their fixture supports setup. **No real provider is invoked, no paid external call is made, and no test treats an accepted proposal as external delivery.**

The tests use only a fixed, marked disposable localhost database (where applicable); test fixtures are synthetic and must not be pointed at Supabase, a remote database, or any unrecognized local database.

## Shared regression matrix

| Evidence | Marcus | Claire | Chad |
|---|---|---|---|
| Permitted typed request and durable work | `AI_DRAFT_MARKETING` / campaign | `AI_DRAFT_TEACHING` / published curriculum | `AI_DRAFT_FOLLOW_UP` / current OPEN lead + observed version |
| Model routing | `DRAFT_MARKETING`, agent `marcus`, planner-selected HQ policy/catalog/provider snapshot | `DRAFT_TEACHING`, agent `claire`, planner-selected HQ policy/catalog/provider snapshot | `DRAFT_FOLLOW_UP`, agent `chad`, planner-selected HQ policy/catalog/provider snapshot; inactive HQ policy yields no route before fake generation |
| Human decision | Exact **CONFIRM** Action Engine proposal; separate qualified reviewer; save is internal campaign workspace content only | Exact **CONFIRM** proposal; separate qualified reviewer; save is a private Teaching Studio draft only | Exact **CONFIRM** proposal; separate qualified reviewer; approval/denial changes content-proposal state only |
| Failure/recovery | Configuration, failed and `UNKNOWN` paths preserve durable state; `UNKNOWN` is not resent | Configuration/quota/result-budget/`UNKNOWN` paths with retry and concurrency coverage | Configuration, failed and `UNKNOWN` paths; `UNKNOWN` retry is quarantined and no-route stops before fake generation |
| Authority | Owner / permission / Complete checks and cross-scope rejection | Direct human staff, unambiguous school, Complete/permission/revocation checks | Direct staff, parent/AI/foreign rejection, Complete and exact permission checks |
| Evidence | Redacted audit/outbox plus actual usage, credits, provider cost | Redacted audit/outbox plus actual usage, credits, provider cost | Redacted audit/outbox plus actual usage, credits, provider cost |
| No delivery/execution | Approved draft can only be internally saved; it has no publish adapter | Approved draft can only be internally saved; it has no lesson/resource/publication adapter | `ActionEngineService.beginExecution` explicitly rejects the approved proposal; no CRM follow-up, communication, queue, schedule, lead mutation, or delivery is created |

The provider runtime only receives the plan-derived `providerId`, `modelId`, request ID, and fixed typed budgets. The employee service never accepts provider/model/authority/action selectors from request input. The plan is metadata-only and is selected through HQ provider policy; it is not a provider execution authorization.

## Focused commands

Run the static shared verifier first (it has no database or network dependency):

```bash
pnpm --filter @hon/database db:test-ai-employee-slices-verifier
```

### Marcus

```bash
export HON_MARKETING_AI_VALIDATION_TARGET=postgresql://localhost:5432/hon_marketing_ai_validation
export HON_MARKETING_AI_ENV_FILE=/home/ubuntu/jobs/<job>/marketing-ai.env
pnpm --filter @hon/database db:setup-marketing-assistant
source "$HON_MARKETING_AI_ENV_FILE"
pnpm --filter @hon/database db:test-marketing-assistant
```

### Claire

Claire's existing setup deliberately **does not create roles**. It requires pre-provisioned exact local `hon_teaching_ai_owner` (BYPASSRLS migration owner) and `hon_teaching_ai_runtime` (restricted runtime) aliases, and rejects all provider-related environment variables:

```bash
export HON_TEACHING_AI_RESET=LOCAL_DISPOSABLE_ONLY
# DATABASE_URL and HON_RUNTIME_DATABASE_URL must use the exact guarded Claire aliases.
pnpm --filter @hon/database db:setup-teaching-assistant
pnpm --filter @hon/database db:test-teaching-assistant
```

### Chad

```bash
export HON_CHAD_AI_VALIDATION_TARGET=postgresql://localhost:5432/hon_chad_follow_up_validation
export HON_CHAD_AI_ENV_FILE=/home/ubuntu/jobs/<job>/chad-follow-up-ai.env
pnpm --filter @hon/database db:setup-chad-follow-up-assistant
source "$HON_CHAD_AI_ENV_FILE"
pnpm --filter @hon/database db:test-chad-follow-up-assistant
```

## Intentional validation distinctions

All three focused integration tests are **mock-only** in the current repository. The existing Marcus test creates its marked database and roles itself, injects a DI fake, and also checks its disabled production runtime against a rejecting network sentinel. Claire uses a pre-provisioned restricted-role fixture and explicitly refuses provider-related environment variables. Chad now mirrors Marcus's marked local role/database creation but also refuses provider-related variables before setup/test.

There is **no supported real-provider/live-paid test command** in this matrix, and this document does not claim that any one slice has live-provider parity with another. The only approved path exercised here is local durable-state validation with fake/rejecting transport.

## Remaining boundary

This coverage does not authorize a communication or delivery workflow. In particular, Chad approval is not recipient consent, a send, a queue insertion, a calendar action, or CRM mutation. Any future outbound workflow must be separately designed and verified for consent, recipient selection, delivery receipts, adapter authority, idempotency, reconciliation, and external side effects.
