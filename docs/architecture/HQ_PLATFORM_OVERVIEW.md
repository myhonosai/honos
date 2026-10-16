# HQ Platform Overview (HQ-1)

**Status:** implemented and locally validated bounded platform-operator read surface. It is not a claim that financial, usage, executive-work, voice, provider execution, or production SaaS metrics are active.

## Purpose

`HQ-1` provides the first governed HON HQ overview route for a platform owner or HQ operator. It replaces the former reference-only `/hq` experience with a conventional, read-only screen that is truthful when authoritative data is unavailable.

The route is deliberately a **platform control-plane projection**, not a school-admin screen and not a support-access mechanism.

## Fixed public contract

`GET /api/v1/hq/overview` has no selector, role, tenant, date, tier, authority, execution, or mutation parameter. It returns only a closed `HqPlatformOverview` object:

| Field | Meaning |
| --- | --- |
| `asOf` | UTC projection timestamp |
| `callerHqRole` | `OWNER` or `OPERATOR`, derived server-side |
| `organizationCount`, `schoolCount` | Aggregate platform counts only |
| `onboarding` | Aggregate request-state counts only |
| `configuredProviderStates` | Aggregate configured provider connection states only |
| `taskProfileCount` | Aggregate number of configured HQ task profiles |
| `financialMetrics` | Explicit `UNAVAILABLE` fact until a separately authoritative MRR/ARR/cash/gross-margin projection is designed |
| `aiUsage` | Explicit `UNAVAILABLE` fact until a separately authoritative HQ usage/cost projection is designed |
| `durableHqWork` | Explicit `NO_RECORDED_WORK` until persisted HQ executive workspaces are implemented |

The contract intentionally contains **no** tenant IDs, school or customer names, people, email, financial figures, invoice/payment data, provider/model IDs, credential state, prompt/output, tool/authority, approval payload, work-item evidence, or raw cost/credit amounts.

## Authorization and database boundary

`hon.read_hq_platform_overview(text)` is the sole projection function. It is a fixed, `STABLE`, `SECURITY DEFINER` function with `search_path=pg_catalog, hon` and a trusted migration owner. It independently resolves the verified application subject through `hon.resolve_hq_operator_scope(subject, 'hq.dashboard.view')`, then accepts only `HON_HQ_OWNER` or `HON_HQ_OPERATOR`.

No caller GUC, role, school, organization, principal, or request parameter can establish HQ scope. `HON_HQ_SUPPORT`, school users, parent/family users, AI/service identities, revoked users, and forged tenant context fail closed. The runtime role receives `EXECUTE` on only this function; it receives no direct access to the private HQ/directory sources used by the projection.

The API executes the one fixed function in a `REPEATABLE READ READ ONLY` transaction. The browser client performs one same-origin `GET` with `no-store`; it has no execution, provider, payment, Action Engine, or mutation client.

## Honest UI behavior

The `/hq` screen contains the approved fixed executive catalog — **HON, Chase, Mia, Ethan, Olivia, Ryan, and Sophia** — and the three shared presentation modes: Big-Button, Modern HON, and Classic CRM. The selected mode changes presentation only; it does not change data, access, tier, authority, or domain behavior.

No executive card says or implies it is working without a persisted work item. Where no persisted workspace exists, the UI displays **No recorded HQ work**. Missing financial, AI-usage, and durable-work sources render unavailable wording, never sample metrics. The view remains usable as a conventional read surface if AI or voice is unavailable.

## Explicit non-goals

HQ-1 does **not** create an executive agent, provider invocation, durable work item, Action Engine request, approval, audit/outbox record, billing/payment operation, customer communication, school support session, impersonation, voice capture, transcript, integration credential, credit debit, model routing decision, or production deployment.

It does not create a second AI system. Future HQ delegation must use the existing HON-owned Action Engine, provider controls, durable work model, audit, usage ledger, and approval binding.

## Validation

The guarded local fixture is localhost-only and refuses provider, execution, payment, messaging, and live credential namespaces before setup. It creates generated temporary credentials only in a private `0600` job file.

```bash
HON_HQ_OVERVIEW_VALIDATION_TARGET=postgresql://localhost:5432/hon_hq_overview_validation \
HON_HQ_OVERVIEW_ENV_FILE=/private/job/hq-overview-validation.env \
pnpm db:setup-hq-overview

# source only the generated local fixture env, with provider/payment/execution credentials absent
pnpm db:test-hq-overview
```

The proof covers owner/operator access, support/school/family/AI/delegated/revoked denial, forged-GUC denial, direct private-source ACL denial, existing tenant-read isolation without context, exact function ACL/metadata, closed response shape, no-write table snapshots, and no audit/outbox/action/provider/financial/communication effect. Runtime-wide posture remains covered by `pnpm db:verify-rls`.

Related implementation: migration `0127_hq_platform_overview.sql`, `HqOverviewService`, `HqController`, `HqOverview` web component, and the fixed public route manifest entry for `/hq`.
