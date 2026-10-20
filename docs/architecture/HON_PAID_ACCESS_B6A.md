# HON paid access B6A: first-payment activation (inactive)

**Status:** implemented on `claude/hon-b6a-paid-access` (migration `0172`), pending owner approval. The paid-access program is **INACTIVE** and stays INACTIVE: `saas_access_program.status` is pinned by `CHECK (status = 'INACTIVE')`, and every B6A command is refused while it is. Nothing in this milestone changes a real customer's access, suspends, cancels, refunds, messages anyone or spends with a provider.

It builds on B1–B5.1 and adds no second entitlement, plan or credit system: `organization_entitlements` stays the only access authority, `saas_plan_capabilities` the only feature map, and the B3 allowance ledger the only credit grant.

## 1. Central access authority

`hon.saas_organization_access(org)` (internal) answers, from canonical records only:

| Field | Meaning |
|---|---|
| `state` | `PROVISIONED` (HQ-provisioned, today's schools), `AWAITING_FIRST_PAYMENT`, `PAYMENT_ACTIVE`, or `NONE` (no entitlement) |
| `source` | How the access **in effect** was obtained: `PROVISIONED`, `PAYMENT_ACTIVATED`, or `NONE` when nothing is in effect |
| `entitlement` | The canonical entitlement (tier, status, window, version, `inEffect`) |
| `capabilities` | The plan's functional capabilities when the entitlement is in effect, otherwise none. Complete adds `marketing.campaigns_ai_managed`, `attribution.ai_insight`, `ai.workforce`, `ai.delegated_jobs` and `ai.orchestration` to Core |
| `paidAccessProgram` | `INACTIVE` (shipped) or `ACTIVE` |

`hon.saas_capability_allowed(org, capability)` reads it. Existing provisioned schools have no access-state row, so they read `PROVISIONED` and nothing about them changes.

## 2. Canonical payment-to-entitlement transition contract

| # | Transition | Who / what | Preconditions (all re-checked on the server) | Effects, in one transaction |
|---|---|---|---|---|
| T1 | `PROVISIONED → AWAITING_FIRST_PAYMENT` | HQ owner only (`place_saas_organization_awaiting_payment`) | Program ACTIVE; `expectedEntitlementVersion` matches; no access state, live subscription or open checkout | Entitlement held `SUSPENDED` (version + 1), so every status-gated function refuses it; access state row; `APPLIED` transition; audit and outbox |
| T2 | `AWAITING_FIRST_PAYMENT → PAYMENT_ACTIVE` | The signature-verified provider event only (`checkout.session.completed` / `async_payment_succeeded`), inside B5's activation | Program ACTIVE; organization still awaiting; checkout found by provider session, not by anything the browser sent; amount and currency equal the checkout's server-frozen price; checkout open; founder reservation valid; subscription, invoice and `PROVIDER_VERIFIED` evidence recorded; the invoice's provider-verified net covers its total; plan is Core or Complete | Entitlement → the **purchased** tier, `ACTIVE`, `effective_from` = service start, version-checked; access state `PAYMENT_ACTIVE` (checkout and subscription linked); the period's full allowance (5,000 Core / 12,000 Complete, lifetime included) opened through B3 when the credit program is active; `APPLIED` transition with prior and next entitlement, evidence, allowance and provider event |
| T2r | Held for HQ review | Same event | Any T2 precondition fails | Never a partial grant. If the check fails **before** the subscription is recorded, the checkout becomes `PAID_NEEDS_REVIEW` (`ACCESS_PROGRAM_INACTIVE`, `AMOUNT_MISMATCH`, `PAID_AFTER_CLOSE`, `FOUNDER_UNAVAILABLE`, `SUBSCRIPTION_EXISTS`). If it fails **after** (the activation step itself), the payment stays recorded, the activation step rolls back to a savepoint and records `NEEDS_REVIEW` with the reason. Either way the organization stays awaiting and the webhook reports `NEEDS_REVIEW` or `ACCESS_ACTIVATION_NEEDS_REVIEW`, never `ACCESS_ACTIVATED` |
| T3 | Retry a held activation | HQ owner only (`retry_saas_first_payment_activation`) | Program ACTIVE; `expectedCheckoutVersion`; organization still awaiting; the stored verified paid event exists; **no refund or dispute** reported for that payment | A checkout held only because the program was inactive completes through B5 (subscription, invoice, evidence) and then T2. A completed checkout whose activation failed re-runs T2 with every check. Anything else: `SAAS_ACCESS_NOT_RETRYABLE` |

Invariants enforced in the schema:
- One `APPLIED` activation per organization and per checkout (unique partial indexes), and one allowance per subscription period (B3).
- The access state can only move `AWAITING_FIRST_PAYMENT → PAYMENT_ACTIVE`, one version at a time; it cannot be deleted. Transitions are append-only.
- Checkout `PAID_NEEDS_REVIEW` may move to `COMPLETED` only when its reason is `ACCESS_PROGRAM_INACTIVE`.

**Never authority:** browser-submitted price, plan, school or organization id, a payment-success URL (there is no success-URL handler), an entitlement claim, or the selected school. The checkout freezes plan, offer, catalog version, amount, founder reservation, purchaser and school at creation; T2 reads only those and the provider-verified event.

## 3. Safeguards

| Risk | Mechanism | Proven by |
|---|---|---|
| Duplicate activation, replayed webhook | B5 event-id idempotency; one-activation indexes; T2 requires `AWAITING` | 6 concurrent deliveries → 1 activation; sequential redelivery is a replay |
| Out-of-order events | The first invoice before completion is covered by the checkout; nothing activates without the completion event | `invoice.paid` first, then completion |
| Wrong-school attribution | Checkout resolved by provider session; T2/T3 act only on the checkout's own organization; school owners cannot purchase for another school | Other owner refused; an unrelated awaiting organization never activated; HQ retry on a non-awaiting organization refused |
| Incorrect founder pricing, tier mismatch | Server-frozen offer and amount; signed amount must match; tier = checkout plan, verified against the subscription | Tampered amount → review; Core founder lifetime → Core only, Complete founder monthly → Complete |
| Expired or refunded payment | Late payment → `PAID_AFTER_CLOSE` review; retry refuses reported refunds and disputes; T2 re-checks provider-verified net | Expired then paid → review, not retryable; refunded before retry → `SAAS_ACCESS_PAYMENT_REVERSED`; refund matched by payment intent → `SAAS_ACCESS_PAYMENT_UNVERIFIED` review |
| Simultaneous purchases | Founder and organization advisory locks; one open checkout per organization | Two plans at once → one checkout; two organizations paying together activate independently |
| Duplicate monthly allowance | B3 unique allowance per period; T2 and retries open it through the same function | Replays and retries leave exactly one 12,000 / 5,000 allowance |
| Partial payment/entitlement states | T2 is atomic; failures roll back to a savepoint and are recorded | Forced failure → payment recorded, entitlement still suspended, no allowance, review recorded; HQ retry activates |

## 4. API (contracts in `@hon/contracts`, file `saas-paid-access.ts`)

| Method and route | Who | Request | Response `data` |
|---|---|---|---|
| `GET /v1/hq/saas/organizations/:organizationId/access` | HQ owner, or HQ operator with `hq.billing.manage` | — | `SaasOrganizationAccessView` (access + last 50 transitions) |
| `POST /v1/hq/saas/organizations/:organizationId/access/await-first-payment` | HQ owner | `{ expectedEntitlementVersion }`, header `x-hon-human-command: saas-access-await`, `Idempotency-Key` | `SaasAccessAwaitReceipt` |
| `POST /v1/hq/saas/payments/checkouts/:checkoutId/access-retry` | HQ owner | `{ expectedCheckoutVersion }`, header `x-hon-human-command: saas-access-retry`, `Idempotency-Key` | `SaasAccessRetryReceipt` |

Changed contracts (backwards compatible for provisioned schools):
- `GET /v1/schools/:schoolId/hon-billing`: `access` gains `state`. `paymentActivated` is true, and `source` is `PAYMENT_ACTIVATED`, only after T2. `paidAccessProgram` is `INACTIVE` or `ACTIVE`.
- `GET /v1/schools/:schoolId/hon-plan`: while awaiting, `entitlementTier` is `null` and both Core and Complete offers are listed.
- Checkout `statusReason` gains `ACCESS_PROGRAM_INACTIVE`. Webhook details gain `ACCESS_ACTIVATED` and `ACCESS_ACTIVATION_NEEDS_REVIEW`.

Refusals (422): `SAAS_ACCESS_NOT_ACTIVE`, `SAAS_ACCESS_STATE_EXISTS`, `SAAS_ACCESS_STATE_CHANGED`, `SAAS_ACCESS_PAYMENT_UNVERIFIED`, `SAAS_ACCESS_PAYMENT_REVERSED`, `SAAS_ACCESS_NOT_RETRYABLE`, plus B5's `SAAS_SUBSCRIPTION_EXISTS` and `SAAS_CHECKOUT_OPEN`. 409 `SAAS_VERSION_CONFLICT` / `IDEMPOTENCY_KEY_REUSED`; 403 `SAAS_FORBIDDEN`.

## 5. Entitlement enforcement

- **Static inventory** (`HON_ENTITLEMENT_ENFORCEMENT_INVENTORY.md`, regenerated): 266 runtime-callable functions; 138 check `status = 'ACTIVE'`.
- **Behavioural sweep** (`test-entitlement-enforcement-coverage.mjs`): every runtime-callable function is called by an all-permission owner for an ACTIVE and a SUSPENDED organization.
  - 25 refuse the suspended school.
  - 12 stay open by reviewed design: billing account, plan options, language settings, public form and kiosk intake, and boolean predicates.
  - **0 recorded gaps.** The 6 staff scope resolvers that ignored entitlement status (achievements, staff reporting, follow-ups, human work, teaching studio, testing registration review) are gated in 0172. Each now also requires the organization's entitlement to be ACTIVE and in effect, the same test `resolve_renewal_scope` applies. The check runs after each resolver's existing ambiguity rule, so an organization in effect resolves exactly as before, and a suspended scope can never be dropped to turn an ambiguous subject into a resolved one. They are on the proof's must-enforce list.
  - 229 refuse generic input before any entitlement decision; the static inventory covers them.
  - No function lets one school's owner reach another organization.

## 6. Evidence

- `test-saas-paid-access-integrity.mjs` (CI): the program is INACTIVE as shipped and every command refused. ACTIVE is then simulated **only in the disposable database** (drop the CHECK, flip, restore) and the journey runs through the real API services, the real Stripe test-mode adapter and the simulator, covering every row of §3. The proof restores and re-asserts the shipped INACTIVE state.
- Mutation testing: 19 of 20 mutations of 0172 are caught. The survivor removes a redundant price re-check that the checkout step already guarantees.
- Existing B1–B5.1 proofs pass unchanged.
- Since 0173 (PR #40) an initial invoice delivered before its checkout completes is refused for redelivery (503 `SAAS_PROVIDER_EVENT_RETRY`) with no event, receipt, audit or outbox row. The B6A proof asserts that, then that the redelivered invoice is attributed to the activated organization, checkout and subscription, and never activates access by itself. 0172 replaces `saas_activate_checkout`; 0173 replaces only `ingest_saas_provider_event` and still calls it, so they apply in order without overwriting each other.

## 7. Path to activation (not done here)

1. Owner approves D1, D2 and D12 ([plan §4](HON_B6_IMPLEMENTATION_PLAN.md#4-owner-decisions-still-open)).
2. ~~Gate the 6 scope resolvers in §5.~~ Done in 0172.
3. Self-serve registration (with Manus) calls the T1 equivalent for new schools, instead of an HQ command.
4. Run in the real Stripe sandbox.
5. A reviewed migration flips `saas_access_program` to ACTIVE.

B6B (grace, restriction, suspension, reactivation, cancellation, refund and dispute effects) is not started.
