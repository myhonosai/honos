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
| `POST hq/saas/access-exceptions/close-expired` | HQ owner or billing operator | Closes lapsed or superseded exceptions, at most 200 per call. Only records that are no longer live are selected before the limit, so live exceptions never fill a batch and repeated calls work through every closable record. It removes only access that already ended. Command `saas-access-exception-close`. |

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
| `SUPERSEDED` | Something outside these commands changed the entitlement while the exception was open. Every command path refuses to change a live exception's entitlement, so this is a defensive state. |
| `REVOKED` | |

**Ending an exception.** Revoking, or closing a lapsed one, suspends the entitlement **only if it is still the one the exception granted** (same version, still ACTIVE). A later payment or HQ change is never undone.

### 3. Converting a pilot to paid (revoke-first)

Owner policy, confirmed 2026-10-24: an approved pilot or demonstration exception must be revoked by an HQ owner, or reach its expiry, before the school enters awaiting-first-payment.
- `hon.place_saas_organization_awaiting_payment` (B6A, replaced in `0185`) refuses while an exception is **active or scheduled** with 422 `SAAS_ACCESS_EXCEPTION_ACTIVE`. Nothing changes.
- After a revocation, or once the exception has expired, the transition works. An expired exception that nobody closed is closed in the same transaction, so its record ends as `EXPIRED`. The school then buys HON OS through the D7 path.
- A database trigger on `saas_access_states` (`saas_exception_await`) refuses any access state, on any path, while an open exception has not expired.
- Subscriptions, entitlements, legacy and lifetime rights are not changed. A seamless verified-payment conversion would be a separate approved milestone.

### 4. Champions contests use the entitlement window

`hon.champions_contest_counts` (0152, replaced in `0185`) feeds both the live standings and the frozen results that winner proposals read. Eligibility now requires the referrer's entitlement to be **in effect at the evaluation time** (now for live standings, the END time for the freeze), not only ACTIVE at an eligible tier.
- A scheduled (future-start) or lapsed window, such as an expired exception nobody closed yet, is `TIER_NOT_ELIGIBLE`. The existing reason code is reused, because the results table's reasons are fixed.
- Paid and legacy customers (ACTIVE, no expiry) stay eligible.
- Results frozen earlier are evidence and are not recalculated.

### 5. Direct-human gate and expected-principal binding (provisional 0208)

`POST /v1/hq/organizations` is now a direct-human command (for the HQ "create school" screen, Codex #112):

- **Request gate** (`HqSchoolProvisioningHumanGuard`, runs before identity resolution): `POST` only, no query string, `Origin` equal to the configured HON public origin, `Sec-Fetch-Site`/`Sec-Fetch-Mode` `same-origin`, `Sec-Fetch-Dest` `empty`, no `Sec-Fetch-User`, no `Authorization`, JSON body, `X-HON-Human-Command: hq-school-provisioning`, a UUID `Idempotency-Key`, and `X-HON-Expected-Principal: <uuid>` (the HQ principal the screen read from `GET /v1/hq/session`). Any other `X-HON-*` header, and delegated, action, agent or tenant/family request context, is refused (`403 HUMAN_UI_REQUIRED`). An unset public origin fails closed (`503`).
- **Atomic binding** (`hon.provision_school_from_hq_human`, the only runtime entry point): the database resolves the actor from the verified session subject and refuses before any write unless it is exactly the expected principal (`409 HQ_EXPECTED_PRINCIPAL_MISMATCH`). This covers a browser whose session changed between the screen's check and the POST, and a replay under another principal.
- **Authority order**: the authority rule from 0185 (active human principal, the user's only active principal, HQ owner or an HQ grant carrying `hq.onboarding.manage`) is judged on `clock_timestamp()` with the identity rows share-locked, and checked again after the last durable write and before a replay is returned. A grant that ends or is removed meanwhile rolls back the organization, entitlement, school, role, grant, audit, outbox and request claim (`403 HQ_PROVISIONING_FORBIDDEN`).
- **Receipt**: `{ data: { organizationId, schoolId, ownerRoleId, replayed, actorPrincipalId, entitlementStatus }, meta: { replayed } }`, `201` new / `200` replayed. `actorPrincipalId` always equals the expected principal; `entitlementStatus` is read when the response is produced (`SUSPENDED` for a new school: no operating access). The API checks this shape closed and returns `503` on drift.
- **Errors** carry codes only: `403 HQ_PROVISIONING_FORBIDDEN`, `409 HQ_EXPECTED_PRINCIPAL_MISMATCH`, `409 HQ_PROVISIONING_CONFLICT` (key reused for a different request, or slug taken), `409 HQ_PROVISIONING_IN_PROGRESS`, `400 HQ_PROVISIONING_INPUT_INVALID`, `400 HQ_EXPECTED_PRINCIPAL_REQUIRED`, `409 IDEMPOTENCY_KEY_REQUIRED`, `503 HQ_PROVISIONING_UNAVAILABLE`. Before this change, database refusals surfaced as `500`.
- Runtime can no longer execute the 11-argument `hon.provision_school_from_hq` or `hon.hq_provisioning_actor`; disposable fixtures still call the 11-argument function as the migration owner.

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

**Authority holds through the mutation.** Grant, revoke and close check the HQ actor, then share-lock `users`, `principals`, `hq_operator_grants` and `family_access_grants`, then check again. They check once more after the organization and row lock waits and again just before returning.
- While a command runs, no grant, principal or family change can commit. A change that arrives later waits for the command.
- An authority that runs out by the clock during a wait is refused. The whole transaction rolls back: no entitlement change, exception ending, audit, outbox or idempotency claim.
- The lock order matches the existing SaaS and Champions commands (identity tables, then the request claim, then the organization), so it adds no deadlock.

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
- revoke, expiry, scheduled, closing, renewal and auto-close;
- revoke-first conversion: awaiting-first-payment refused while active or scheduled (command and trigger), and working after revocation or expiry, followed by the D7 purchase;
- every other organization untouched.

**Hardening proof:** `packages/database/scripts/test-saas-access-exception-hardening.mjs` covers the review corrections:
- a revocation and a grant that wait while the owner's grant is ended, or runs out by the clock, commit nothing;
- an authority change that arrives later waits for the command, with no deadlock;
- an authorized retry under the same key is fresh, then replays;
- closing works through 450 open exceptions, 215 of them live and sorted first, in batches of 200 and 35, never closing a live one;
- Champions contest eligibility and the freeze with an in-effect, a scheduled and an expired exception and a legacy customer, winner proposals, and earlier frozen results.

Mutation checks on the disposable database: restoring the earlier revoke, close, contest counts or awaiting-payment body (or dropping the rechecks, or the grant authority trigger together with the grant recheck) makes the matching proof fail.

**Coverage proof:** `test-entitlement-enforcement-coverage.mjs` now also checks an expired-window and a future-window organization against every runtime function.

## Owner decisions and release risks

Source-design approvals (owner, 2026-10-24). These are not authorization to use the functionality with real schools:
- only an authorized human HQ owner grants or revokes;
- at most 90 days from the access start, scheduled at most 30 days ahead;
- no open-ended exceptions;
- no grants to schools already awaiting their first payment;
- revoke-first pilot conversion.

1. **Exception policy terms.** `saas_access_policy_terms` v1 still reads PROPOSED in the database. Its `exception_max_days = 90` and `exception_authority = HQ_OWNER` match the approved design. Recording the terms as approved is a separate step before exceptions are used for real schools.
2. **Review requirement.** An exception must expire; it cannot be open-ended with a review date instead. Renewing means a new grant, with its own reason and evidence.
3. **Converting a pilot to paid.** Revoke-first (section 3). Access lapses between the revocation (or expiry) and the payment, by design.
4. **Exceptions and awaiting schools.** No exception for a school already awaiting its first payment, and no awaiting state while an exception is open.
5. **Expiry needs no job.** Closing exceptions only tidies the row; access, purchase eligibility and Champions contest eligibility already end at the expiry.
6. **The provisioner's OWNER grant.** It is unchanged from 0019. Every staff scope resolver excludes HQ principals, so it gives HQ no school-staff access.
7. **Deploy order.** Applying `0185` changes only future provisioning. Existing schools keep their entitlements. Paid access stays INACTIVE, so provisioned schools have no purchase path until the activation migration.
