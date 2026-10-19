# HON Subscription Billing — Milestone B5: Checkout and Payment-Provider Integration (TEST MODE)

**Status:** PR open for owner review; **not merged**. Migration `0158_hon_payment_provider_test_mode.sql`, contracts `@hon/contracts` `saas-payments.ts`, API `apps/api/src/payments/`.

**What is proven, and how:** everything below is proven against a **deterministic Stripe simulator**, labelled `STRIPE_SIMULATED` in every record. The simulator is injected as the real adapter's transport and signs webhooks with Stripe's own scheme, so the production request-building, signature-verification and normalization code is exercised.

**Not yet proven against a real Stripe test account:** this environment cannot reach `api.stripe.com`, and no test credentials are configured. §9 lists what is needed.

**Hard limits:**
- **Test mode only.** The program can only be `DISABLED` or `TEST_MODE`. Live keys and live events are refused in the adapter, the API and the database.
- **No card data** ever reaches HON; checkout is hosted by the provider.
- **HON never charges or refunds.** The provider charges what the school agreed to on its hosted page. Refunds and disputes happen at the provider and are only *reconciled* here.
- **Access is unchanged.** `organization_entitlements` stays the sole access authority and is never written by B5.

## 1. The paying-school journey

```
HQ registers the school (existing provisioning: organization, school, OWNER role, entitlement tier)
 → school owner opens the HON plan page   GET  /v1/schools/:schoolId/hon-plan
 → selects an offer for its plan           POST /v1/schools/:schoolId/hon-plan/checkout   {offerId}
 → HON records the checkout (and holds a founder slot), the adapter creates the hosted session,
   HON stores the session id and returns the hosted URL
 → the owner pays on the provider's page
 → provider webhook                        POST /v1/payments/webhooks/stripe   (signature verified)
 → one transaction: B1 subscription recorded and started (founder slot allocated),
   B2 invoice issued (gapless HON number), PROVIDER_VERIFIED payment evidence
 → B3 allowance opens at the full plan amount (Core 5,000 / Complete 12,000)
 → HQ sees the subscription PAID, PROVIDER_VERIFIED   GET /v1/hq/saas/payments, B1/B2 reads
```

**Who can buy:**
- New permission `billing.hon.purchase`. Existing and newly provisioned OWNER roles receive it.
- It must be held at the exact school.
- It is refused for anyone with HQ, family or support identities, matching the B3 school-actor rules.

**What can be bought:** only offers for the plan that matches the school's active entitlement.
- Core shows Core regular ($149), founder monthly ($79) and founder lifetime ($1,896).
- Complete shows $249, $149 and $3,576.
- Essential is legacy-only and can't buy anything.
- Annual billing and plan changes are `UNAVAILABLE`, because those policies are undecided.

## 2. Provider adapter

`PaymentProviderAdapter` (`payment-provider.ts`) defines four operations:
- create a hosted checkout session
- expire a session
- verify a webhook
- list recent events (for recovery)

There are two implementations:

| Implementation | Selected when | Notes |
|---|---|---|
| `StripeTestModeAdapter`, provider `STRIPE` | Both `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_WEBHOOK_SECRET` are set | Refuses any key not starting `sk_test_` or `rk_test_`. Fixed host `api.stripe.com`, no redirects, 15 s timeout, bounded responses, pinned `Stripe-Version: 2024-06-20`. Idempotency key `hon-checkout-<checkoutId>`. No automatic retry once a request is sent; an unclear result is `UNKNOWN`. |
| `UnconfiguredPaymentProvider` | Otherwise | Every call is refused before sending. |

The same Stripe adapter with an injected fake transport (`StripeSimulator`) is provider `STRIPE_SIMULATED`. The fake is never selected by environment.

**Checkout request:**
- Monthly offers use `mode=subscription` with a recurring monthly price. Lifetime uses `mode=payment`.
- The request carries `client_reference_id` and metadata `honCheckoutId`.
- No automatic tax is requested.
- Success and cancel URLs come back to `HON_PUBLIC_ORIGIN`.
- The session expires within 24 hours, or sooner if the founder hold is shorter.

## 3. Webhooks: verified, idempotent, order-tolerant

**Transport** (`payment-webhook-transport.ts`, mounted before the JSON parser):
- Accepts only `POST /v1/payments/webhooks/stripe` with JSON, no query string, and no cookie or authorization header.
- Caps the body at 256 KiB and keeps the **raw bytes** for verification.

**Signature:**
- Stripe scheme: `t=…,v1=…` is an HMAC-SHA256 over `${t}.${rawBody}`.
- The timestamp must be within 300 seconds; any of several `v1` values may match, to allow secret rotation.
- Comparison is constant-time.
- A failed check returns 400 and never reaches the database.

**Normalization:**
- Only the fields HON applies are kept, in closed shapes the database re-validates.
- No customer contact details or payment-method data are kept.
- Unused event types are stored as `IGNORED`.

**Exactly once** (`ingest_saas_provider_event`):
- The idempotency key is derived from the provider event id, and the digest is computed over the canonical normalized event.
- A redelivery replays the stored response.
- The same id with different content is refused (409).
- A webhook delivery and an API-fetched copy of the same event share a digest, so recovery never conflicts.

**Ordering:**
- When an event's dependency hasn't arrived, it is refused as `SAAS_PROVIDER_EVENT_NOT_READY`. The API returns 503 and the provider redelivers. An example is a renewal for a subscription whose checkout completion hasn't been applied yet.
- The first subscription invoice may arrive before or after the checkout completion; either order links its payment references.

**Trust:** the API is the signature verifier. The database additionally requires all of the following:
- test mode is on
- the event comes from the configured provider
- `livemode` is false
- the checkout exists
- the provider session matches the checkout
- the amount and currency match

Events act as a fixed `INTEGRATION` principal that has no user, role or HQ grant.

## 4. Applying events

| Event | Effect |
|---|---|
| `checkout.session.completed` / `async_payment_succeeded`, paid | Record the B1 subscription, start service anchored at the payment time, allocate the founder slot, issue the B2 invoice (tax `NO_TAX_APPLICABLE` with the owner's recorded test-mode tax reference) and record PROVIDER_VERIFIED `PAYMENT_RECEIVED` evidence. |
| `checkout.session.completed`, unpaid | `AWAITING_ASYNC_PAYMENT`; nothing is activated. |
| `checkout.session.expired` / `async_payment_failed` | Checkout `EXPIRED` / `FAILED`; founder hold returned. |
| `invoice.paid`, `subscription_create` | Covered by the checkout; payment references linked. |
| `invoice.paid`, `subscription_cycle` | The provider period must line up within a day of HON's anchored period. The period is advanced, the period invoice issued and evidence recorded. A duplicate provider invoice is `ALREADY_APPLIED`. |
| `invoice.payment_failed` | Recorded. Payment status becomes `PAST_DUE`; HON never suspends, cancels or retries. |
| `charge.refunded` | `REFUND` evidence for the **increase** in the cumulative refunded amount, so partial refunds work and replays are safe. B4 refund requests can then be marked evidenced at PROVIDER_VERIFIED strength. |
| `charge.dispute.created` | `CHARGEBACK` evidence. For a school referred through the Champions Club, the B4 alert is raised automatically. |

**Never activated; held for HQ review instead:**
- `PAID_AFTER_CLOSE`: a payment for an expired, cancelled or failed checkout. It is never automatically refunded.
- `AMOUNT_MISMATCH`
- `ENTITLEMENT_CHANGED`
- `SUBSCRIPTION_EXISTS`
- `FOUNDER_UNAVAILABLE`
- `UNKNOWN_CHECKOUT`, including a session presented for another school's checkout
- `PERIOD_MISMATCH`
- `FREE_PERIOD_CHARGED`: a Champions free month the provider still charged
- unmatched refunds and renewals: money events for our account are **never** ignored

## 5. Subscription payment status (derived, one source of truth)

The B1 subscription view reports `paymentStatus`, `paidThroughAt` and `paymentVerification`. They are derived only from B2 invoices and evidence plus provider failure events:

| `paymentStatus` | Meaning |
|---|---|
| `NOT_BILLED` | No issued invoice yet |
| `PAID` | Monthly: paid through a future instant. Lifetime: paid. |
| `DUE` | Unpaid |
| `PAST_DUE` | The latest money event is a failed renewal |
| `REFUNDED` | A refund reduced the latest invoice below its total |
| `DISPUTED` | The latest invoice has a chargeback |

**Verification strength:**
- `paymentVerification` is `PROVIDER_VERIFIED` or `HQ_ATTESTED`.
- B2 payment standing reports `providerVerification: TEST_MODE` while the program is in test mode.
- Champions remains `NOT_CONNECTED` (§8).

## 6. Founder inventory

- A founder checkout holds a slot under the B1 inventory lock (50 total, 30 monthly, 20 lifetime, from the owner draft). One founder offer per organization.
- The hold lasts until the checkout expires, which is at most the hold policy of one day.
- Expiry, cancellation, an async failure, a failed provider call or the HQ sweep return the slot.
- A verified payment allocates it.
- Proven under 3-way contention for the last two slots, using a disposable 3/1/2 fixture catalog.

## 7. Failure handling and reconciliation

- **Provider refuses** (`PRE_SEND` / `FAILED`): the checkout becomes `FAILED`, the hold is returned and the API responds 502.
- **Unknown outcome:** nothing is recorded and the API responds 409 `SAAS_OUTCOME_UNKNOWN`. Retrying with the same idempotency key re-reads the checkout and reuses the provider's deduplicated session.
- **Cancellation** by the school purchaser or HQ: `CANCELLED`, the hold is returned, and the hosted session is expired best-effort. A later payment goes to review.
- **Abandoned:** `POST /v1/hq/saas/payments/checkouts/sweep` expires checkouts past their expiry.
- **Missed webhooks:** `POST /v1/hq/saas/payments/recover {sinceHours ≤ 72}` re-fetches events over the authenticated provider API and applies them once. Already-applied events replay.
- **`GET /v1/hq/saas/payments`** shows the program, recent checkouts and events, and reconciliation counts: open past expiry, created without a provider session, paid needing review, events needing review, and awaiting async payment.

## 8. Champions Club and refunds (test-mode integration)

- **Provider-verified first-paid date:** B2 `saas_payment_standing().verified` now fills from PROVIDER_VERIFIED evidence.
- **Champions qualification:** Champions qualification itself still reads `HQ_OWNER_ATTESTATION`. Its `HON_BILLING` source stays fail-closed until the owner decides that Champions may consume test-mode or (later) live provider verification.
- **Refunds:** the provider refund is reconciled as PROVIDER_VERIFIED `REFUND` evidence, and the B4 refund request is then marked evidenced at that strength. Refund **execution** from HON remains unavailable.
- **Disputes and refunds of referred schools** raise the B4 referral alert, which blocks unresolved rewards. Nothing is reversed.
- **Free months and account credit:** these are not yet pushed to the provider (for example as subscription pauses or customer balance). A provider charge for a Champions free month is held as `FREE_PERIOD_CHARGED` for review. Reward fulfillment stays disabled.

## 9. To run against a real Stripe test account

1. **Owner approval** of Stripe as the provider. Policy `PAYMENT_PROVIDER` is recorded as `PROPOSED`.
2. **A Stripe account in test mode.** Create a webhook endpoint pointing at `https://<api-host>/v1/payments/webhooks/stripe` with **API version 2024-06-20**, subscribed to these events:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `charge.refunded`
   - `charge.dispute.created`
3. **Secret manager:** store `STRIPE_TEST_SECRET_KEY` (a restricted `rk_test_` key with Checkout Sessions write and Events read) and `STRIPE_TEST_WEBHOOK_SECRET` (`whsec_`). Never put them in the repository, logs or chat.
4. **Network:** the API host (and this development environment, to test) must be allowed to reach `api.stripe.com`.
5. **Program switch:** the HQ owner enables `TEST_MODE` with provider `STRIPE` and a recorded test-mode tax reference.

## 10. API (HQ: owner or operator unless noted)

| Method and path | Purpose |
|---|---|
| `GET /v1/schools/:schoolId/hon-plan` (school purchaser) | Plan options, current subscription and payment status, latest checkout |
| `POST /v1/schools/:schoolId/hon-plan/checkout` (`saas-checkout-start`) | Start a hosted checkout |
| `POST /v1/schools/:schoolId/hon-plan/checkout/:id/cancel` (`saas-checkout-cancel`) | Cancel an open checkout |
| `GET /v1/hq/saas/payments` | Program, checkouts, events, reconciliation |
| `POST /v1/hq/saas/payments/program` (`saas-payment-program`, owner) | Enable test mode or disable |
| `POST /v1/hq/saas/payments/checkouts` (`saas-checkout-start`) | HQ-initiated checkout for an organization |
| `POST /v1/hq/saas/payments/checkouts/:id/cancel` | HQ cancellation |
| `POST /v1/hq/saas/payments/checkouts/sweep` (`saas-checkout-sweep`) | Expire abandoned checkouts |
| `POST /v1/hq/saas/payments/recover` (`saas-payment-recover`) | Missed-webhook recovery |
| `POST /v1/payments/webhooks/stripe` (provider, signature only) | Provider events |

There is no charge, refund-execution, live-mode or card route.

## 11. Launch blockers (exact)

1. **Real Stripe test account:** credentials, the webhook endpoint, network egress and owner approval of the provider (§9). Everything so far is simulated.
2. **Self-serve school registration.** Today HQ provisions the school and its entitlement tier, and the owner then pays. A public sign-up linked to checkout does not exist.
3. **Paid-gated access.** Entitlements are set by HQ provisioning, not by payment. An unpaid or past-due school keeps access until HQ acts. This needs an owner policy on grace periods, suspension (`SUSPENDED_ALLOWANCE`) and cancellation timing.
4. **Taxes** (`TAXES` undecided). Live invoices need a real tax treatment or Stripe Tax.
5. **Live mode:** a separate reviewed milestone and owner approval. Currently impossible by constraint.
6. **Refund execution from HON**, cancellation, proration and clawback stay undecided.
7. **Provider-side application of Champions free months and account credit.**
8. **Customer-facing receipts and notifications:** none are sent today. Stripe's own receipts would be the first channel.
9. **Codex HQ and school screens** for these contracts.
