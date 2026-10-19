# HON OS: Stripe sandbox setup, readiness and validation plan

**Status (2026-10-19):** the owner approved Stripe as HON's initial payment provider, **TEST MODE ONLY**. B5 (#26) has been proven end to end against a deterministic Stripe **simulator**. **No real Stripe sandbox test has been run yet.** Every result below that is not under §7's "real sandbox evidence" heading is simulated.

**Not authorized:**
- live mode
- live keys
- real charges or refunds
- reward fulfillment
- production deployment

Companion documents:
- B5 design: [HON_PAYMENTS_TEST_MODE_B5.md](HON_PAYMENTS_TEST_MODE_B5.md)
- Next milestone proposal: [HON_PAID_ACCESS_B6_PROPOSAL.md](HON_PAID_ACCESS_B6_PROPOSAL.md)

## 1. What the documentation research established

Research was run on 2026-10-19. Stripe's documentation pages could not be opened from this environment: `docs.stripe.com` does not resolve, and `api.stripe.com` is blocked. The facts below therefore come from search-indexed `docs.stripe.com` pages and from `stripe-node`'s published sources. Items marked **VERIFY** must be confirmed in the sandbox itself; the harness preflight (§6) checks them automatically.

| Topic | Finding | HON consequence |
|---|---|---|
| Current API version | **`2026-09-30.endive`** (stripe-node `apiVersion.ts`). Majors since HON's pin: acacia 2024-09-30, basil 2025-03-31, clover 2025-09-30, dahlia 2026-03-25, endive 2026-09-30 | HON pins **`2024-06-20`** on every request (`Stripe-Version` header). Per-request pinning is documented. No end-of-support date for old versions was found |
| Webhook endpoint version | `POST /v1/webhook_endpoints` accepts `api_version`, which is **fixed at creation**. Without it, events use the account default. A new sandbox's default is the newest version | **The endpoint must be created with `api_version=2024-06-20`** (§3 step 5). **VERIFY** that 2024-06-20 is still accepted |
| basil (2025-03-31) breaking changes | Removed `invoice.subscription` (now `invoice.parent.subscription_details.subscription`), `invoice.payment_intent`, `invoice.charge` and `charge.invoice`. Added an InvoicePayment object and an `invoice_payment.paid` event | HON's normalizer already reads both subscription shapes. Linking a **renewal refund or dispute** to its invoice relies on `invoice.payment_intent`, which basil-shaped events do not carry, so such a refund would land in `NEEDS_REVIEW` instead of applying. **This is why the 2024-06-20 endpoint pin matters** (see §5, R1) |
| endive (2026-09-30) | `payment_method_types` removed from Checkout Session create | HON never sends `payment_method_types`. Payment methods come from the sandbox Dashboard settings |
| Events | All eight HON events still exist: `checkout.session.completed`, `.expired`, `.async_payment_succeeded`, `.async_payment_failed`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded` and `charge.dispute.created`. `invoice.paid` (not `invoice.payment_succeeded`) is the recommended paid signal | No change needed |
| Signatures | `Stripe-Signature: t=…,v1=…[,v1=…]`; HMAC-SHA256 over `${t}.${raw body}`; 300-second default tolerance; one `v1` per active secret during rotation | Exactly what `verifyStripeSignature` does |
| Snapshot vs thin events | Classic snapshot webhooks are still supported. Thin events are for v2 resources | Use a **classic (snapshot) webhook endpoint** |
| Sandboxes | Sandboxes are the default testing environment: isolated accounts with `sk_test_` / `rk_test_` keys. Only test cards and test bank numbers work; Stripe's terms forbid real payment details | HON refuses any key that is not `sk_test_`/`rk_test_` and any `livemode: true` object (adapter + API + database CHECK). **VERIFY** that sandbox events carry `livemode: false` (preflight) |
| Checkout expiry | `expires_at` must be 30 minutes to 24 hours ahead. `POST /v1/checkout/sessions/:id/expire` works on `open` sessions only and emits `checkout.session.expired` | HON uses 23 h 59 min. Cancellation expires the session best-effort |
| Test clocks | `POST /v1/test_helpers/test_clocks`, customer `test_clock=…`, `…/advance`. A clock advances at most two intervals past its shortest subscription | Used only by the validation harness for renewals. **VERIFY** that Checkout accepts a test-clock customer |

## 2. Can test mode move real money?

**No.**
- Sandbox keys can only process Stripe test instruments, and real card numbers are rejected.
- HON adds its own independent locks:
  1. The adapter refuses any key that is not `sk_test_`/`rk_test_`, and startup aborts on `sk_live_`.
  2. Every provider response or event with `livemode: true` is refused.
  3. Database CHECKs make `live_mode` false and `livemode` false, and the program can only be `DISABLED` or `TEST_MODE`.
  4. HON has no charge, refund-execution or card route at all. Card entry happens only on Stripe-hosted Checkout.
- Enabling live mode would need a new migration, a new adapter, a review and owner approval.

## 3. Stripe sandbox setup checklist (owner, in the Stripe Dashboard)

Do not paste keys or secrets into chat, GitHub, screenshots or logs. Each value goes straight from Stripe into the secret manager.

1. **Create a sandbox** named `HON OS – test` (Dashboard → account menu → Sandboxes → Create). Do not use the live account.
2. **Branding:** the business name (`HON OS`) and support email show on hosted Checkout and test receipts. Receipts go only to the test email entered at checkout.
3. **Payment methods** (Settings → Payment methods, sandbox): enable **Cards**. Optionally enable **ACH Direct Debit (US bank account)**, needed only to test `async_payment_failed`. Disable everything else.
4. **Restricted API key for the HON API** (Developers → API keys → Create restricted key), named `hon-api-test`:

   | Resource | Permission | Used for |
   |---|---|---|
   | Checkout Sessions | **Write** | create a hosted session; expire it on cancel |
   | Events | **Read** | missed-webhook recovery (`GET /v1/events`) |
   | Everything else | **None** | |

   HON creates prices inline (`price_data`) and lets Checkout create the customer. **VERIFY** in the sandbox that no Products/Prices/Customers permission is needed. The harness preflight creates one session and reports any permission Stripe names as missing.
5. **Webhook endpoint (classic snapshot), API version 2024-06-20.**
   - The Workbench UI may only offer recent versions. If so, create the endpoint through the API from your own computer with a temporary sandbox secret key:
     ```sh
     curl https://api.stripe.com/v1/webhook_endpoints -u "$STRIPE_SANDBOX_SECRET_KEY:" \
       -d url="https://<HON API host>/v1/payments/webhooks/stripe" -d api_version=2024-06-20 \
       -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=checkout.session.expired" \
       -d "enabled_events[]=checkout.session.async_payment_succeeded" -d "enabled_events[]=checkout.session.async_payment_failed" \
       -d "enabled_events[]=invoice.paid" -d "enabled_events[]=invoice.payment_failed" \
       -d "enabled_events[]=charge.refunded" -d "enabled_events[]=charge.dispute.created"
     ```
   - Confirm that the endpoint shows API version `2024-06-20` and exactly these 8 events.
   - Copy its signing secret (`whsec_…`) directly into the secret manager.
6. **Secret storage** (server side only):

   | Variable | Value |
   |---|---|
   | `STRIPE_TEST_SECRET_KEY` | the `rk_test_…` key from step 4 |
   | `STRIPE_TEST_WEBHOOK_SECRET` | the endpoint's `whsec_…`, or for local runs the one printed by `stripe listen` |
   | `HON_PUBLIC_ORIGIN` | the `https://` origin that Checkout returns schools to (success/cancel pages are informational only) |

   - For this Claude Code cloud environment, use the environment's secret settings, never the repository.
   - `.env.example` lists the names only.
7. **Network egress:**
   - The API host must reach `https://api.stripe.com` (outbound HTTPS 443). It never needs `checkout.stripe.com`, which only the customer's browser loads.
   - Inbound, the webhook URL must be reachable from Stripe's webhook IPs (https://docs.stripe.com/ips).
   - For this cloud development environment, add `api.stripe.com` to the environment's allowed domains. Add `checkout.stripe.com`, `js.stripe.com`, `*.stripe.network` and `r.stripe.com` too if the harness should complete Checkout in a headless browser instead of the owner completing it by hand.
8. **Turn HON test mode on** (HQ owner): `POST /v1/hq/saas/payments/program` with `ENABLE_TEST_MODE`, provider `STRIPE`, an authorization reference and the test-mode tax reference (`TAXES` stays undecided). The API process must be started with the two Stripe variables loaded. Without them, the adapter is unconfigured: checkout start fails with no session, and webhooks return 503.

### The webhook URL (staging)

**No HON staging deployment exists in this repository today**, so there is no staging webhook URL yet. Two options, in recommended order:

- **A. First real test without any deployment (recommended):**
  - Run the harness (§6) locally.
  - Run `stripe listen --forward-to http://localhost:<port>/v1/payments/webhooks/stripe --events <the 8 events>`; the Stripe CLI prints its own `whsec_` for the session.
  - Missed-webhook recovery (`GET /v1/events`) is exercised as well, so even with no inbound path every payment is provider-verified over the authenticated API.
  - Needs: egress to `api.stripe.com` and the Stripe CLI's connection to Stripe.
- **B. Staging:** once the owner approves a staging host, register `https://<staging-api-host>/v1/payments/webhooks/stripe` as in step 5. Staging must use a disposable or staging database, never production, and its own `whsec_`.

## 4. Readiness report

| Area | State | Evidence or gap |
|---|---|---|
| Adapter: hosted Checkout, expiry, event listing, signature verification | **Built; simulated only** | `apps/api/src/payments/stripe-test-mode-adapter.ts`; B5 proof applies 33 signed events |
| Live-mode impossibility | **Verified (simulated + constraints)** | key-prefix refusal, `livemode` refusal, database CHECKs, 10/10 mutation checks |
| Idempotency / duplicate / out-of-order / missed events | **Verified (simulated)** | B5 proof §§4–13 |
| Founder inventory under contention | **Verified (simulated)** | 3 schools racing for 2 slots: exactly 2 win |
| Tenant isolation | **Verified (simulated)** | cross-school purchaser and cross-tenant session reuse refused |
| Real Stripe sandbox account | **Blocked: owner setup (§3)** | no sandbox, key or webhook secret is configured; `api.stripe.com` is blocked by this environment's network policy |
| 2024-06-20 webhook endpoint accepted | **Unverified** | §3 step 5; harness preflight |
| Restricted-key minimum permissions | **Unverified** | §3 step 4; harness preflight |
| Staging webhook URL | **Absent** | no staging deployment; option A needs none |
| Paid-gated access | **Absent by design** | payment never changes `organization_entitlements`; see the B6 proposal |
| Self-serve school registration | **Absent** | HQ provisions schools (`HqOnboardingService`) |
| School-facing checkout UI | **Codex, on hold until B5 merges** (#29) | |

## 5. Known risks before the first real run

- **R1 – event shape drift.** Events fetched through `GET /v1/events` (recovery) may be rendered at the account's default API version rather than the endpoint's 2024-06-20. On a basil-or-later shape, HON keeps safe outcomes (an unmatched refund goes to `NEEDS_REVIEW`) but loses automatic renewal-refund matching.
  - **Implemented in this change:** the normalizer reads only the pinned `2024-06-20` payloads or basil-or-later payloads (`2025-03-31` and later, where it reads `invoice.parent` and treats the removed payment links as absent). It **refuses every other `api_version`** (`UNSUPPORTED_API_VERSION`): a webhook gets 400 and Stripe redelivers, and a recovery batch fails loudly. A shape mismatch is therefore never silently misread.
  - Still to decide: keep 2024-06-20, or upgrade HON to `2026-09-30.endive` (InvoicePayment-based matching via `invoice_payment.paid`). **Recommendation:** run the first sandbox tests on 2024-06-20 exactly as built, then upgrade in a dedicated reviewed change before live mode.
- **R2 – test-clock timing.** On test clocks, the invoice periods follow the clock while event `created` stays at real time. Renewal evidence will show a real-time paid date for a clock-time period. This is a sandbox artifact and is recorded as such in the evidence.
- **R3 – manual checkout.** Completing hosted Checkout needs a browser. The owner can complete it on any device with test card `4242 4242 4242 4242`. Headless completion needs the extra egress in §3 step 7.

## 6. End-to-end validation plan (real sandbox)

The plan uses a disposable local database only. It runs the real HON services with provider `STRIPE` (not `STRIPE_SIMULATED`). Every run records only Stripe object ids (`cs_test_…`, `evt_…`, `in_…`), never keys or secrets.

**Preflight** (aborts the run if any check fails):
- the key prefix is a test prefix;
- `GET /v1/events?limit=1` succeeds and returns `livemode: false`;
- a Checkout Session create succeeds (this proves the restricted-key permissions) and is immediately expired;
- the webhook secret's prefix is `whsec_`.

| # | Scenario | Stripe input | Expected HON result |
|---|---|---|---|
| 1 | Core regular monthly | card `4242…4242` | subscription `IN_SERVICE`, invoice `HON-YYYY-NNNNNN` $149.00 `PAID_VERIFIED`, `PROVIDER_VERIFIED` evidence with provider `STRIPE`, allowance 5,000, `paymentStatus` `PAID` |
| 2 | Complete regular monthly | `4242` | the same, at $249.00 and 12,000 |
| 3 | Core founder monthly | `4242` | $79.00; founder slot allocated (remaining count drops by exactly 1) |
| 4 | Complete founder paid lifetime | `4242` (mode `payment`) | $3,576.00 one-time; lifetime; allowance 12,000; no renewals |
| 5 | Renewal | scenario 1 customer on a test clock, advanced one month | `RENEWAL_RECORDED`, period index 1, second invoice and evidence, allowance period 2 |
| 6 | Failed renewal | default payment method switched to `pm_card_chargeCustomerFail`, clock advanced | `invoice.payment_failed` → `paymentStatus` `PAST_DUE`; access unchanged (B6 decides) |
| 7 | Declined first payment | `4000 0000 0000 0002` | no activation; session stays open; cancel or sweep returns any founder slot |
| 8 | Abandoned checkout | open, then HON cancel → Stripe expire | `checkout.session.expired` → `EXPIRED`; founder slot returned |
| 9 | Duplicate delivery | the same `evt_` via webhook and recovery, and redelivered from the Dashboard | applied once; replays `ALREADY_APPLIED` |
| 10 | Delayed / out-of-order | webhook path paused; recovery ingests events oldest first and then in reverse | dependency-first application; `503` retry on a missing dependency; final state identical |
| 11 | Async payment failure (optional) | ACH test account `000222222227` | `async_payment_failed` → checkout `FAILED`, no activation |
| 12 | Provider refund reconciliation | Dashboard refund on scenario 2 (sandbox only) | `charge.refunded` → B2 `REFUNDED` evidence; B4 request can be marked provider-evidenced; HON executes nothing |
| 13 | Dispute | card `4000 0000 0000 0259` | `charge.dispute.created` → CHARGEBACK evidence, `DISPUTED` |
| 14 | Agreement check | — | for each school, the subscription, invoice total, evidence (provider, mode `TEST`, `evt_` id), allowance amount, HQ status and Stripe's own objects all agree; `organization_entitlements`, school-to-family billing and Champions rewards are unchanged |

**Evidence record:** `docs/evidence/stripe-sandbox/<date>.md`, kept separate from simulator results. It records:
- the commit;
- the sandbox account id (an `acct_` id is not a secret);
- the API version on each received event;
- each scenario's ids and outcome;
- any `NEEDS_REVIEW` outcome with its detail.

Recording the owner's Stripe approval as a `PAYMENT_PROVIDER` policy record (DECIDED, Stripe, test mode only) goes into the next billing migration. It is held back so as not to add a third claim on a migration number while #26 and #27 are being sequenced. Until then, HQ shows `PROPOSED`.

The harness that automates this plan is the next engineering task once the credentials exist. It reuses the B5 proof's fixture setup; the owner or a browser completes each hosted Checkout.

## 7. Real sandbox evidence

_None yet._ This section is filled only from a real sandbox run.

## 8. Owner actions and decisions for real testing

1. Create the sandbox and complete §3 steps 1–6, storing secrets only in the secret manager.
2. Allow egress to `api.stripe.com` for this development environment (and for the staging host later).
3. Choose the webhook path: **A (CLI forwarding, no deployment)** or **B (approved staging host)**.
4. Confirm whether Claude may complete hosted Checkout headlessly (needs extra egress) or whether the owner completes each test checkout by hand.
5. Authorize the sandbox-only Dashboard refund and dispute tests (scenarios 12–13). They move no real money.
6. Decide the API version: keep `2024-06-20` for the first run (recommended), then upgrade to the current major before live mode.
