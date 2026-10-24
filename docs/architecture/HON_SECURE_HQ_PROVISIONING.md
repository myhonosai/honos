# Secure HQ school provisioning (D9)

**Status:** this is migration `0185`. It is not deployed and has not been applied to any persistent database.

- **Owner decision D9 (2026-10-23):**
  - HQ provisioning no longer gives a new school free access.
  - Free access is possible only as an explicit, time-limited HQ-owner exception.
- **Paid access and AI credits stay INACTIVE.** Test mode only, with no Stripe call.
- **Reserved numbers:** `0179` (E1b-2) and `0180` (E1c) stay reserved.

## Behavior before D9

There was exactly one runtime path that creates a school from HQ: `POST /v1/hq/organizations`. The chain was:
- `HqOnboardingController`;
- `HqOnboardingService.provisionInitialSchool`;
- `hon.provision_school_from_hq` (`0019`, replaced in `0022`).

| | Before D9 |
|---|---|
| **Who** | Any HQ principal holding `HON_HQ_OWNER`, or `hq.onboarding.manage`. The API also checks `hq.onboarding.manage` scope. |
| **Idempotency** | `hq_onboarding_requests`, keyed per actor and key, with a request fingerprint. |
| **What it creates** | The organization, the school, a system `OWNER` role with every permission, and an `OWNER` grant to the provisioning HQ principal. |
| **Entitlement** | `organization_entitlements (tier = requested, status = 'ACTIVE')`. This is free, immediate, unlimited access at Essential, Core or Complete, with no payment, expiry or reason. |
| **Evidence** | `audit_events` `hq.organization.provision` and outbox `organization.provisioned`. |

Other paths, checked and unchanged:
- **D7 public sign-up initializer (`0183`).** Private, and creates a SUSPENDED entitlement.
- **HQ tier change (`0146`).** CORE ↔ COMPLETE on an entitlement that is already ACTIVE. It never activates one.
- **B6A place-awaiting (`0172`).** Suspends the entitlement.
- **Payment activation (`0172`/`0183`).**

So the only free-ACTIVE source was provisioning.

## What changes

### 1. Provisioning creates no access

`hon.provision_school_from_hq` has the same signature, route, contract, idempotency and authorization. The one change is the entitlement row, which is inserted **`SUSPENDED`**:
- The requested tier is kept only as a placeholder.
- The response and audit record `entitlementStatus: SUSPENDED` and `access: NONE`.
- No access state row is created, so the school reads `state = PROVISIONED`, `source = NONE`, with no capabilities.
- No subscription and no AI-credit allowance exist.
- The provisioned school's staff scope resolvers refuse it (the status gate).

How such a school gets access:
- **Paid.**
  1. While paid access is ACTIVE, the HQ owner places it awaiting its first payment (B6A, `POST /v1/hq/saas/organizations/:id/access/await-first-payment`).
  2. It buys HON OS through the D7 path.
  3. The verified payment activates it.

  This is the same as any school that is not new.
- **Free.** An HQ-owner exception (below).

While paid access is INACTIVE (today), a provisioned school simply has no access. That is the D7 "inactive onboarding state".

### 2. HQ-owner access exceptions

The table `hon.saas_access_exceptions` is private, deny-all and forced RLS. Each row records:
- the organization **and the school** (a composite foreign key, so the school must belong to that organization);
- the **purpose**: `INTERNAL_TESTING`, `PRODUCT_DEMONSTRATION` or `APPROVED_PILOT`;
- the **reason** (10–500 characters);
- the **scope**: `CORE` or `COMPLETE` capabilities, and never AI credits;
- the **start** and a **mandatory expiry**;
- the policy version and maximum it was granted under;
- the prior and granted entitlement;
- the grantor;
- how it **ended**.

| Route (all under `/v1`) | Who | What |
|---|---|---|
| `GET hq/saas/organizations/:organizationId/access-exceptions` | HQ owner or billing operator | Current access and the last 50 exceptions, with a derived lifecycle. |
| `POST hq/saas/organizations/:organizationId/access-exceptions` | **HQ owner only** | Grants one exception. Human command `saas-access-exception-grant` with an idempotency key. |
| `POST hq/saas/access-exceptions/:exceptionId/revoke` | **HQ owner only** | Revokes with a reason. Command `saas-access-exception-revoke`. |
| `POST hq/saas/access-exceptions/close-expired` | HQ owner or billing operator | Closes lapsed or superseded exceptions (at most 200). It removes only access that already ended. Command `saas-access-exception-close`. |

**Grant input:** exactly `schoolId`, `purpose`, `reason`, `scopeTier`, `startsAt`, `expiresAt` and `expectedEntitlementVersion`. Nothing the client sends names the grantor.

**The grant refuses** (all are 422 unless noted):
- **The window:**
  - a window longer than the policy's `exception_max_days`, which is 90 in terms v1 (`SAAS_EXCEPTION_TOO_LONG`);
  - a start more than 5 minutes in the past or more than 30 days ahead, or an expiry not after the start and now (`SAAS_EXCEPTION_WINDOW_INVALID`).
- **The organization's existing access:**
  - an organization whose entitlement is already in effect, which covers every existing customer and pre-D9 pilot school (`SAAS_ENTITLEMENT_IN_EFFECT`);
  - one with an access state, either awaiting or paid (`SAAS_ACCESS_STATE_EXISTS`);
  - one with any live subscription (`SAAS_SUBSCRIPTION_EXISTS`);
  - one with a created, open or held checkout (`SAAS_CHECKOUT_OPEN`);
  - one with another live exception (`SAAS_ACCESS_EXCEPTION_ACTIVE`).
- **Staleness:** a stale entitlement version (409).
- **Wrong target:** a school of another organization (404).

**What a grant does.** It sets the entitlement to the scope tier, `ACTIVE`, with `effective_from = startsAt` and `effective_until = expiresAt`, and `version + 1`.
- A previous exception that already lapsed is closed first.
- `saas_audit` / `saas_outbox` record `saas.access.exception_grant` (internal only).

**Lifecycle.** The read derives it:

| Lifecycle | When |
|---|---|
| `SCHEDULED` | Before the start. |
| `IN_EFFECT` | |
| `EXPIRED` | At the expiry, with **no job needed**. Every status-gated function also checks the entitlement window, and the coverage proof now checks this for every runtime function. |
| `SUPERSEDED` | Anything else changed the entitlement, for example B6A placed the school awaiting payment. |
| `REVOKED` | |

**Ending an exception.** Revoking, or closing a lapsed one, suspends the entitlement **only if it is still the one the exception granted** (same version, still ACTIVE). A later payment or HQ change is never undone.

## Security boundary

**Who can grant.**
- **HQ owner only**, through `require_saas_hq_actor(subject, true)`. Operators, support, onboarding operators, school owners and staff, strangers and an HQ owner whose grant has expired are refused (`SAAS_FORBIDDEN`).
- An AI action or delegated context is refused by `saas_refuse_context`, even with an HQ owner's subject.

**A grantor cannot be forged.** The insert trigger `saas_exception_authority` re-checks, in the database, that:
- `granted_by` is a current sole human principal with a live `HON_HQ_OWNER` grant and no family access;
- the row matches the latest policy terms' authority and maximum;
- the row matches the entitlement row exactly (tier, ACTIVE, window, version).

A row written around the command, even by the migration owner, is refused (`SAAS_EXCEPTION_FORBIDDEN`).

**Immutable records.** Exception rows are immutable, apart from their one ending, which may set only the ending columns. Deletes and truncation are refused (`IMMUTABLE_SAAS_RECORD`).

**Never a purchase basis.**
- While an exception is live, HON OS checkout is refused (`SAAS_ACCESS_EXCEPTION_ACTIVE`), and the offers read shows `NOT_ELIGIBLE_ENTITLEMENT`. Otherwise a paid subscription could sit on an entitlement that expires.
- Legacy checkout stays closed (D8).

**Scope cannot be widened.** The HQ tier transition (`0146`) refuses an organization with a live exception. It returns 404 `HQ_ENTITLEMENT_UNAVAILABLE`, its existing refusal.

**Concurrency.** The organization advisory lock, the entitlement row lock, the version check and a unique open-exception index together allow one exception per organization under concurrent requests. Idempotency uses `saas_claim_request`.

**Grants.** The table and helpers are private. Only the four HQ functions are runtime-executable. `infra/postgres/010` and `saas-billing-security.mjs` (including the authority trigger) are updated.

## Compatibility

Nothing in `0185` updates an existing entitlement, subscription, renewal, lifetime right or payment record:
- **Pre-D9 provisioned schools** keep their ACTIVE entitlements.
- **D7** registration, checkout and activation are unchanged. The proof runs a provisioned school through the D7 first purchase.
- **D8:** a provisioned school sees no legacy offer and is refused legacy checkout.
- **Proofs whose fixtures are built through HQ provisioning** and then use school features stand in for a school provisioned before D9. They activate that fixture's entitlement in their disposable database through `scripts/pre-d9-provisioning-simulation.mjs`:
  - the B5 payments proof;
  - the B5.1 school billing proof;
  - the Owner Launch regression;
  - the D8 proof (its school `N`).

  The D9 proof covers the post-D9 provisioned school instead.

## For Codex (frontend)

**HQ onboarding.** The response shape is unchanged. Explain that a new school has no access until it pays or an HQ owner grants an exception.

**HQ exceptions screen.** Use the four routes above.
- Show the lifecycle, scope, purpose, start, expiry and the "no AI credits" line.
- **Never** offer grant or revoke to anyone but an HQ owner. The server refuses them anyway.

**Purchase screens.** `SAAS_ACCESS_EXCEPTION_ACTIVE` (422) can appear on HON OS checkout.

## Evidence

**New proof:** `packages/database/scripts/test-saas-secure-hq-provisioning.mjs`, on a disposable database with simulated Stripe. Paid access ACTIVE is simulated only for the D7 and superseded cases. It covers:
- provisioning without access, idempotency, key reuse, a five-way race and unauthorized provisioners;
- D7 and D8 for a provisioned school;
- every unauthorized grantor, AI and delegated contexts, and forged fields;
- input, window, cross-tenant and existing-customer refusals;
- grant evidence, replay and no credits;
- a live exception refused as a purchase basis, and a tier change refused;
- a five-way grant race;
- direct runtime writes and forged rows written around the command;
- revoke, expiry, scheduled, superseded, closing, renewal and auto-close;
- every other organization untouched.

**Coverage proof:** `test-entitlement-enforcement-coverage.mjs` now also checks an expired-window and a future-window organization against every runtime function.

## Owner decisions and release risks

1. **Exception policy terms.** `saas_access_policy_terms` v1 is still PROPOSED. Exceptions use its `exception_max_days = 90` and `exception_authority = HQ_OWNER` as the cap. Confirm both, or approve new terms, before exceptions are used for real schools.
2. **Review requirement.** An exception must expire; it cannot be open-ended with a review date instead. Renewing means a new grant, with its own reason and evidence.
3. **Converting a pilot to paid.** A live exception blocks purchase. HQ revokes it (or lets it end), places the school awaiting payment (needs paid access ACTIVE) and the school buys HON OS. Access lapses briefly between the revocation and the payment, by design.
4. **Exceptions and awaiting schools.** An exception cannot be granted to a school already awaiting its first payment: the B6A access contract never shows access in effect while awaiting. If HQ wants a free trial window for such schools, that is a separate decision.
5. **Expiry needs no job.** Closing exceptions only tidies the row; access already ended at the expiry. One static nuance: the Champions contest ranking reads `status = 'ACTIVE'` without the window, so a lapsed, unclosed exception school could still count in a contest ranking (not an operating privilege). Closing removes it.
6. **The provisioner's OWNER grant.** It is unchanged from 0019. Every staff scope resolver excludes HQ principals, so it gives HQ no school-staff access.
7. **Deploy order.** Applying `0185` changes only future provisioning. Existing schools keep their entitlements. Paid access stays INACTIVE, so provisioned schools have no purchase path until the activation migration.
