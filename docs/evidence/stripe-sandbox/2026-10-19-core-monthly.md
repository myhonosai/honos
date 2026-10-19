# Stripe sandbox evidence: first real Core monthly checkout (2026-10-19)

**Real Stripe sandbox, test mode only.** This is separate from the simulator results. It was authorized by the owner for exactly one Core regular monthly checkout. Webhooks were not used: events were reconciled through the Stripe Events API (B5 missed-webhook recovery).

| Item | Value |
|---|---|
| Harness | `packages/database/scripts/stripe-sandbox-core-checkout.mjs` (`preflight`, `start`, `verify`) |
| Code under test | `main` @ d168224 plus the harness only; B5 services and `StripeTestModeAdapter` unchanged |
| Database | disposable local PostgreSQL (`hon_champions_validation`, marked fixture roles) |
| Credential | restricted sandbox key held only by the environment's egress Network Secret for `api.stripe.com`; the HON process held a non-secret placeholder |
| Request API version | `2024-06-20` (`Stripe-Version` header) |
| Event API version received | `2026-09-30.endive` (sandbox account default), accepted by the normalizer |

## IDs

| Object | ID |
|---|---|
| Checkout Session | `cs_test_a1lp9w2xWMUwEGbZTo70s7qDl2HADaRDVX3lU6UXUapZdAwJySM90tk8PX` |
| `checkout.session.completed` | `evt_1USNeJ4RRTaqPcXmkH99GYaO` → APPLIED / SUBSCRIPTION_ACTIVATED |
| `invoice.paid` | `evt_1USNeJ4RRTaqPcXm8OWEW7tD` → ALREADY_APPLIED / FIRST_INVOICE_COVERED_BY_CHECKOUT |
| Stripe subscription | `sub_1USNeG4RRTaqPcXmTywU8aMv` |
| Stripe invoice | `in_1USNeG4RRTaqPcXmeokYDezQ` |
| HON checkout (disposable) | `7c24ac8b-3b79-47cb-b8f1-ef59a8188200` |
| HON organization (disposable) | `6856f43f-d1be-4736-8ba8-6680df9c3e30` |
| HON subscription (disposable) | `ad470750-a1b9-44d9-94f3-6a03019577cb` |
| HON invoice | `HON-2026-000001` |

## Checks (all passed)

- Preflight: authenticated `GET /v1/events` succeeded, and every object had `livemode: false`.
- At creation, Stripe reported the session as `open`, mode `subscription`, `amount_total` 14900, `usd`, `client_reference_id` = the HON checkout, and `metadata.honOrganizationId` = the test organization.
- After the owner paid with test card 4242, Stripe reported the session as `complete` / `paid`, 14900 `usd`.
- Recovery fetched 66 sandbox events. The checkout completion was APPLIED, `invoice.paid` was ALREADY_APPLIED (covered by the checkout), and the other 64 events, all types HON does not use, were IGNORED (`EVENT_TYPE_NOT_USED`).
- Subscription `IN_SERVICE`, CORE, REGULAR_MONTHLY, `PAID`, period 0. School view `paymentVerification` = `PROVIDER_VERIFIED`.
- Checkout `COMPLETED`, 14900 USD, provider `STRIPE`, mode `TEST`, linked to the subscription and invoice.
- Invoice 14900, `PAID_VERIFIED`, exactly one evidence row: `PROVIDER_VERIFIED`, provider `STRIPE`, mode `TEST`, 14900 USD, citing `evt_1USNeJ4RRTaqPcXmkH99GYaO`.
- Core allowance (B3; the credit program and pricing are disposable fixtures): CORE, REGULAR, 5,000 credits, period 0, starting at the subscription period start. The school sees 5,000 available.
- Duplicates: `verify` ran recovery repeatedly, plus repeated allowance commands. Counts stayed at 1 subscription, 1 invoice, 1 evidence row, 1 allowance and 1 recorded event for the school. Credits stayed at 5,000.
- No B6 effect: the `organization_entitlements` row is byte-identical to before the checkout, and `saas_access_program` is `INACTIVE` with `mutations_enabled = false`.

## Notes

- **Restricted key permissions** (Checkout Sessions Write, Events Read) were sufficient for: create the session, retrieve the session, list events and retrieve an event. No permission error occurred.
- The `invoice.paid` row is recorded with no organization id. Its outcome is correct (covered by the checkout). This was observed, not changed.
- The run was interrupted twice by harness bugs: wrong column names in the harness's own SQL, and a missing fixture provider row. Neither touched product code. Because recovery is idempotent, the re-runs add duplicate-recovery evidence.
