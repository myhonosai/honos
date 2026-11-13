# Tuition collection with Stripe and Square (B-TUI-2)

Status: spec and plan. Piece 1 is source only, not deployed. Test/sandbox mode only: no live money, no live keys.

Owner decision (David, 2026-11-11): start with Stripe and Square integrations, and be ready for HON's own payment
provider later. This builds on the owner-approved October design
(`/mnt/project-files/enrollment-architecture/ENROLLMENT_PAYMENTS_ARCHITECTURE_v2.md`, v3, v3.1) and on 0240 (tuition
payments recorded outside HON, `docs/architecture/TUITION_PAYMENTS.md`).

## 1. What families and schools get

| Need | Behaviour |
| --- | --- |
| Autopay | A family saves a card (or US bank account where the processor supports it) once; HON charges it on each due date. |
| Failed payment retries | A failed charge is retried on a school-chosen schedule; staff see a "failed payments" list; the family gets a notice. |
| Card-expiry notices | Saved cards that expire this month or next are listed for staff, and the family is asked to update the card. |
| One payer, several students | One billing account (the payer) pays for every student on it in one combined charge per cycle. |
| Sibling discounts | A school-set rule takes a percent or fixed amount off the 2nd, 3rd and later students on one payer. Unset = no discount. |
| Paid event / slot booking | A one-time hosted payment can be attached to a booking (belt test, event). Free sale-day booking is built separately and does not wait for payments. |

## 2. Fixed rules (from the approved design; not reopened)

1. **School money is the school's.** Stripe uses Connect *direct charges* on the school's own connected account; Square
   uses the school's own seller account via OAuth. The school is merchant of record. Tuition never passes through HON's
   balance and never touches HON's SaaS tables, keys, webhook routes or entitlements (v2 §5.3).
2. **Separate Stripe platform account** for Connect, distinct from HON's SaaS Stripe account (D26). The SaaS sandbox key
   this environment holds is never used for tuition.
3. **Test/sandbox only.** Every connection has `mode = 'TEST'`; a database CHECK refuses `LIVE`. Going live is a separate,
   owner-approved migration.
4. **HON never sees card numbers.** Cards are entered in Stripe/Square hosted or tokenized forms (SAQ-A).
5. **Recurring = HON-managed schedule (Option A, D24/D25 recommended).** HON's own payment schedule is the single source
   of truth for what is owed across Stripe, Square and manual payments; HON charges the saved method off-session on the
   due date. Stripe Billing / Square Subscriptions are not used.
6. **Numbers are school settings.** Sibling discount, retry schedule and expiry-notice timing are set by the school
   owner; unset means the feature is off (v3 correction 4).
7. **No platform fee** (owner, 2026-11-11): HON takes no fee on any payment a school collects. Charge requests never
   carry an application fee. The long-term goal is a HON-owned payment processor for these payments (section 3).
8. **HQ sees connection health and counts only**, never tuition amounts or family data (D33).

## 3. Provider seam (ready for HON's own provider)

- **Database:** `hon.school_pay_providers` is a registry of payment providers (`STRIPE_CONNECT`, `SQUARE`). Every
  provider-specific row (connections, later customers, saved methods, charges) references a provider code, never a
  hard-coded provider. Adding HON's own provider later is one row in a new migration plus one adapter; no table changes.
- **API:** `SchoolPaymentAdapter` (apps/api/src/school-payments) is the only place provider calls live. It is separate
  from the SaaS `PAYMENT_PROVIDER_ADAPTER`. Each adapter declares a static capability manifest (one-time card, stored
  card, bank debit, off-session recurring, refunds); the provider's own status narrows it per connection. Errors use the
  B5 model: `PRE_SEND` (nothing sent), `FAILED` (provider refused), `UNKNOWN` (sent, outcome unknown → reconcile, never
  assume success or failure).
- **Adapters:** `STRIPE_CONNECT` (test mode) and `SQUARE` (sandbox). Piece 1 ships deterministic simulators only; the real
  sandbox HTTP adapters need credentials the owner has to create (section 6).

## 4. Pieces (small PRs, each with tests)

| # | Piece | Migration | Contents |
| --- | --- | --- | --- |
| P1 | Processor connections + provider seam | 0258 | Provider registry, school connections (TEST only), status history, owner permission, connect / finish / refresh / set default / disconnect, adapter interface + simulators, API routes, DB proof. |
| P1-web | Payments settings page | — | Staff "Payment processors" page over the P1 routes. |
| P2 | Real sandbox adapters + credential vault | ask | Stripe Connect test (Account Links, account retrieval) and Square sandbox OAuth; encrypted per-school token storage (D27). Needs section 6 credentials. |
| P3 | Payers and saved methods | ask | Provider customer per payer; hosted card/bank setup (Stripe SetupIntent, Square card on file with consent); saved method list with brand/last4/expiry; card-expiry list. |
| P4 | Autopay plans + sibling discounts | ask | Per-payer autopay plan covering all of the payer's active memberships; school sibling-discount rule; scheduled charges that become invoices. |
| P5 | Charging, webhooks, retries | ask | Charge runner (fixed integration principal), off-session charge with idempotency key, signed webhook inbox per provider, UNKNOWN reconciliation, school retry schedule, failed-payments list; paid charges write 0240-style payment records with provider-verified evidence. |
| P6 | Family notices | ask | Card-expiry and failed-payment notices through the existing message delivery path (consent and quiet-hours rules apply). |
| P7 | Paid booking fee | ask | One-time hosted payment linked to a booking, after the free booking feature exists. |
| P8 | Web screens for P3-P6 | — | Family autopay setup, failed payments, expiring cards. |
| P9 | Customizable checkout pages (owner, 2026-11-11) | ask | Per-school checkout page for enrollment and tuition. Branding (logo, color, cover image, footer) is one shared school setting owned by the booking thread (0268, `read_public_school_branding`); the checkout only reads it. The checkout owns its content: plans shown and their order, add-ons (uniform, registration fee), promo codes, sibling discount shown clearly, custom fields, waiver/agreement checkbox, receipt and thank-you text, link/QR/embed snippet, EN/KO/ES. Card entry stays in the provider's hosted fields. |

Order: P1 → P1-web → P2 → P3 → P4 → P9 (checkout) → P5 → P6 → P7/P8. P2 can wait on credentials without blocking P3/P4 design, which
run on the simulators.

## 5. Piece 1 design (0258)

### Tables (forced RLS, no runtime privilege, definer functions only)

- `school_pay_providers(code, display_name, test_supported, live_allowed)`; `live_allowed` is CHECKed false. Seeded
  `STRIPE_CONNECT` ("Stripe"), `SQUARE` ("Square"). Immutable from the runtime.
- `school_pay_connections`: one row per school connection. `provider_code`, `mode` (CHECK `TEST`), `state`
  (`PENDING_ONBOARDING`, `CONNECTED_RESTRICTED`, `CONNECTED_ACTIVE`, `REAUTHORIZATION_REQUIRED`, `DISCONNECTED`,
  `ABANDONED`), `provider_account_ref` (set once, never changed), `onboarding_state_hash` (SHA-256 of a one-time nonce),
  charges/payouts flags, capability manifest, `is_default`, `version`, who/when started and disconnected.
  - At most one open (not DISCONNECTED/ABANDONED) connection per school and provider.
  - At most one default per school, and only a CONNECTED_ACTIVE connection can be default.
  - One provider account can be linked only inside one organization (v3 correction 2 allows sharing across that
    organization's schools, never across organizations).
- `school_pay_connection_events`: append-only history of every state change and provider observation.

### State rules

```
PENDING_ONBOARDING --finish (nonce)--> CONNECTED_RESTRICTED | CONNECTED_ACTIVE
CONNECTED_* --refresh--> CONNECTED_RESTRICTED | CONNECTED_ACTIVE | REAUTHORIZATION_REQUIRED
REAUTHORIZATION_REQUIRED --refresh--> CONNECTED_*
any open state --disconnect--> DISCONNECTED (had an account) | ABANDONED (never finished)
```

The state is derived in the database from the provider observation (charges enabled and no requirements due → ACTIVE;
account known otherwise → RESTRICTED; reauthorization needed → REAUTHORIZATION_REQUIRED), never taken from the browser
or the return URL.

### Permissions

`school_pay.connection.manage` (connect, finish, refresh, set default, disconnect) and `school_pay.read`; both sensitive,
staff-assignable, granted to system OWNER roles at migration time. HQ operators, family and parent principals are refused.

### API (under `organizations/:organizationId/schools/:schoolId/payments`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `processors` | providers + this school's connections + `canManage` |
| POST | `processors/connections` | start: `{providerCode}` → connection + hosted onboarding URL (simulated in P1) |
| POST | `processors/connections/:id/finish` | `{expectedVersion, state, authorizationCode?}`: nonce must match; adapter retrieves status |
| POST | `processors/connections/:id/refresh` | `{expectedVersion}`: adapter retrieves status |
| POST | `processors/connections/:id/default` | `{expectedVersion}` |
| POST | `processors/connections/:id/disconnect` | `{expectedVersion, reason}` |

Every command: direct human only, Idempotency-Key, human-command header, live permission re-checks before and after the
write, audit event and an inert outbox event. No charge, refund, customer, message or automation is reachable.

### Tests

- DB/HTTP proof over the CRM-close fixture: start/finish/refresh/default/disconnect, nonce mismatch, LIVE refused,
  duplicate open connection refused, cross-organization account refused, account ref immutable, stale version, replay and
  key reuse, permission/school/entitlement loss, HQ and family principals refused, runtime ACL, history append-only.
- API unit tests: adapter registry, simulators, refusal mapping, unconfigured provider → 503.

## 6. Owner items

1. Platform fee: settled 2026-11-11, none on any school payment.
2. **Sandbox accounts for P2** (outside-service setup, no money): a separate Stripe account in test mode with Connect
   enabled (not HON's SaaS account), and a Square Developer application with sandbox credentials. Until then everything
   runs on simulators.
3. Before any live use: Connect platform agreement, Square app review, PCI SAQ-A, and a security review (Manus final
   review list).

## 7. Piece 1 as built (0258)

Status: source only, not deployed. Test mode only; the API uses in-process simulators only when
`HON_SCHOOL_PAY_SIMULATORS=1` and never when `NODE_ENV=production`; otherwise every provider answers
`SCHOOL_PAY_PROVIDER_NOT_CONFIGURED` (503).

- **Database:** `school_pay_providers`, `school_pay_connections`, `school_pay_connection_events` (private, forced RLS, no
  runtime privilege). Six runtime entry points: `read_school_payment_processors`, `start_school_payment_connection`,
  `set_school_payment_onboarding_link`, `record_school_payment_status` (FINISH / REFRESH), `set_default_school_payment_connection`,
  `disconnect_school_payment_connection`. The settings-free `guard_school_pay_connection` trigger keeps scope, provider,
  mode, start facts and a set account fixed, freezes ended connections and requires a one-step version bump.
- **Onboarding state:** the API makes 32 random bytes per link, puts them only in the provider return URL, and sends the
  database their SHA-256. Finishing needs the raw state; the hash is then cleared. The raw state is stored nowhere (the
  status command fingerprints its hash). A link replay returns the stored receipt without a URL: ask for a new link.
- **Finish after success:** a retry of a finish that already succeeded returns `SCHOOL_PAY_CONNECTION_STATE` (the
  connection is no longer pending); the page reloads and shows it connected.
- **Disconnect:** HON ends the connection first, then asks the provider to revoke access; `meta.providerRevoked` reports
  the outcome and is never assumed.
- **API:** `apps/api/src/school-payments/` (adapter seam, simulators, service, controller, per-command human-UI guards).
- **Evidence:** `pnpm --filter @hon/database db:test-school-payment-connections` (CI: `run-db-proofs.sh`, CRM-close
  fixture), 139 checks over signed HTTP; `apps/api/test/school-payments.test.cjs` (contracts, simulators, wiring).

### Piece 2 must

- Store Square tokens (encrypted, D27) only after the database accepts the finish, and verify the state before any code
  exchange it persists.
- Replace the simulators with real Stripe Connect test-mode and Square sandbox clients behind the same interface, using
  credentials separate from HON's SaaS Stripe account.

## 8. Piece 1-web as built

Status: source only, not deployed. Staff page `/staff/billing/payment-processors` (Memberships & Billing menu) over the
seven piece 1 routes.

- One card per provider: connect, continue setup, check status, make default, disconnect (with a reason). Only staff with
  `school_pay.connection.manage` see the actions; `school_pay.read` sees status only. The account id is shown by its last
  four characters only.
- **Provider return:** the page reads `connection`, `state` and `code` once, removes the whole query from the address bar
  at once (`history.replaceState`), keeps the values in memory only, and sends them only when the owner chooses
  *Finish connecting*. The page sets `referrer: no-referrer` and every request uses `referrerPolicy: 'no-referrer'`.
  A session end or a school change drops the kept return; a blur or hidden tab only hides the page.
- **Leaving HON:** the browser is sent only to an https onboarding URL without credentials (or a loopback URL for the
  local simulators). A replayed link answer (no URL) asks for a new link.
- Unknown outcomes keep the exact request and key for *Try again*; a finish retry that answers
  `SCHOOL_PAY_CONNECTION_STATE` re-reads and shows the connection as connected. Disconnect reports whether the provider
  confirmed the revoke.
- Evidence: `apps/web/test/payment-processors-ui.test.tsx` (8 tests).

## 9. Piece 9a as built (0269): checkout page settings

Status: source only, not deployed. Nothing is public yet; the family-facing checkout page and its public read come in a
later piece, together with promo codes and the sibling-discount display (P4).

- **Database:** `school_checkout_pages` (one row per school and kind, `ENROLLMENT` or `TUITION`, `DRAFT` or `PUBLISHED`) and
  the append-only `school_checkout_page_versions`; private, forced RLS, no runtime privilege. Two runtime entry points:
  `read_school_checkout_pages` and `save_school_checkout_page` (create with `expectedVersion` 0, then optimistic version).
- **Content (closed shape, CHECKed in the table):** plans shown in order (up to 20 of this school's catalog plans that are
  AVAILABLE when saved), add-ons (up to 10, positive minor amounts, required or optional), custom questions (up to 10;
  text, choice with 2-10 options, or checkbox), an optional waiver, receipt note and thank-you text. Every text is English
  with optional Korean and Spanish, trimmed, no angle brackets or control characters. A published enrollment page needs
  at least one plan. Branding is not stored here: it is read from the shared school branding (0268).
- **Permission:** `school_checkout.manage` (sensitive, staff-assignable, granted to system OWNER roles). HQ, family and
  parent principals are refused.
- **API:** `GET` and `POST organizations/:organizationId/schools/:schoolId/payments/checkout-pages` (save needs
  Idempotency-Key and the `school_checkout.page.save` human-command header).
- **Evidence:** `pnpm --filter @hon/database db:test-school-checkout-pages` (CI: `run-db-proofs.sh`), 94 checks over signed
  HTTP; `apps/api/test/school-checkout.test.cjs`.

## 10. Piece 9b as built: checkout settings page for staff

Status: source only, not deployed. Web only, over the 0269 routes; no migration and no API change.

- **Page:** `/staff/billing/checkout-pages` (Billing menu, "Checkout pages"; EN/KO/ES menu label), protected, dynamic,
  noindex, no-referrer. Tabs for the enrollment checkout and the tuition payment page.
- **Editing:** plans from the school catalog (add, remove, move up or down; unavailable plans cannot be added and are
  flagged if already shown), add-ons (name, amount typed in the currency's own units, such as 25.00 USD or 50000 KRW, required or optional), questions (short
  answer, pick one with 2-10 choices, checkbox; required or optional), waiver on or off, receipt note, thank-you message.
  One language switch (English, Korean, Spanish) changes which text every field edits; English is required, and an empty
  Korean or Spanish text is left out so families see English.
- **Saving:** Save as draft or Save and publish. Problems are listed in plain words and block the save; the contract
  validator is the final check before the request. The request carries the version from the last verified read; a
  version conflict keeps the staff edits and re-reads, so staff choose Save again or Discard changes. An unknown result
  keeps the exact request and key for Try again. Every answer is followed by a fresh read.
- **Privacy:** blur or a hidden tab hides the page but keeps unsaved edits in memory; a school change or session end drops
  them. Nothing is kept in browser storage.
- **Evidence:** `apps/web/test/school-checkout-ui.test.tsx` (9 tests).

## 11. Piece 2 design (0320): real sandbox adapters and the credential vault

Status: spec and plan. Test/sandbox mode only. Owner decisions (David, 2026-11-13): each school is the merchant of
record (direct charges, HON takes no cut); Stripe Connect accounts with the full Stripe Dashboard ("Standard"-type
controller: the school pays Stripe's fees, Stripe carries losses, Stripe collects requirements); Stripe-hosted
onboarding. Embedded components may come later (separate decision doc).

### Configuration (names only; values live in the environment, never in the repo or chat)

| Variable | Use | Refused when |
| --- | --- | --- |
| `HON_TUITION_STRIPE_TEST_SECRET_KEY` | Secret key of the **separate** Stripe Connect test platform (not HON's SaaS account) | not `sk_test_`/`rk_test_` |
| `HON_TUITION_SQUARE_SANDBOX_APP_ID` | Square Developer application id (sandbox) | not `sandbox-sq0idb-` |
| `HON_TUITION_SQUARE_SANDBOX_APP_SECRET` | Square sandbox application secret | not `sandbox-sq0csb-` |
| `HON_SCHOOL_PAY_VAULT_KEY` / `HON_SCHOOL_PAY_VAULT_KEY_ID` | 32-byte AES-256-GCM key (base64) and its id for sealing per-school tokens | key not exactly 32 bytes, id not `^[a-z0-9-]{1,40}$` |

Selection per provider: `HON_SCHOOL_PAY_SIMULATORS=1` (never in production) keeps the piece 1 simulators; otherwise a
provider whose variables are all present and valid gets its real sandbox adapter; otherwise it stays NOT_CONFIGURED
(503). A live-looking key (`sk_live_`, `rk_live_`, a non-sandbox Square id) is refused and the provider stays
NOT_CONFIGURED. Square also needs the vault key. Hosts are fixed in code: `api.stripe.com` and
`connect.squareupsandbox.com` only; Square's production host is never used.

### Stripe Connect (test mode)

- `beginOnboarding`: with no account yet, `POST /v1/accounts` with `controller[stripe_dashboard][type]=full`,
  `controller[fees][payer]=account`, `controller[losses][payments]=stripe`, `controller[requirement_collection]=stripe`,
  `metadata[hon_connection_id]`, and the Stripe `Idempotency-Key` `hon-school-pay-account-<connectionId>` (a retry within
  24 h returns the same account). No school name, email or other personal data is sent. Then
  `POST /v1/account_links` (`type=account_onboarding`, `return_url` = HON return with `state`, `refresh_url` = the HON
  page with `connection` only, so an expired link asks for a new one).
- `completeOnboarding`: no code; the account is the one stored on the connection.
- `retrieveStatus`: `GET /v1/accounts/<id>`: `charges_enabled`, `payouts_enabled`, requirements due = any
  `currently_due` or `past_due` entry or a `disabled_reason`; capabilities from `card_payments` /
  `us_bank_account_ach_payments` being `active`; a 403 or `account_invalid` answer means
  reauthorization required (a 401 means HON's own platform key is wrong and is reported as a provider refusal).
- `disconnect`: a Standard account belongs to the school and the platform cannot revoke it with the secret key alone, so
  the adapter does not call Stripe and the API reports `providerRevoked: false` (the school removes HON in its own
  Stripe Dashboard). No account is ever deleted.
- No call carries `application_fee_amount` or any fee field.

### Square (sandbox)

- `beginOnboarding`: `https://connect.squareupsandbox.com/oauth2/authorize?client_id&scope&session=false&state` with the
  fixed scope list `MERCHANT_PROFILE_READ PAYMENTS_READ PAYMENTS_WRITE CUSTOMERS_READ CUSTOMERS_WRITE` (what pieces 3
  and 5 need; no ORDERS, BANK_ACCOUNTS, EMPLOYEES or payouts). The redirect URL is the one set in the Square app.
- **Before** the code exchange the API checks the one-time state against the stored hash
  (`check_school_payment_onboarding_state`, read-only), so a wrong or replayed state never spends the code.
- `completeOnboarding`: `POST /oauth2/token` (`authorization_code`) → `merchant_id`, access token, refresh token,
  expiry. The tokens go to the vault, never to logs, responses or the database in clear.
- `retrieveStatus`: `GET /v2/merchants/<id>` (status `ACTIVE`) and `GET /v2/locations` (any active location with
  `CREDIT_CARD_PROCESSING`); a 401 means reauthorization required. An access token that expires within 7 days is renewed
  first with `POST /oauth2/token` (`refresh_token`); the renewed token is stored with the same status record.
- `disconnect`: `POST /oauth2/revoke` (`Authorization: Client <secret>`, `merchant_id`), reported, never assumed.

### Credential vault (0320)

- **Table** `hon.school_pay_credentials` (private, forced RLS, no runtime privilege): one row per connection; provider,
  key id, `sealed` (AES-256-GCM `v1.<iv>.<ciphertext>.<tag>`, base64url), access-token expiry, credential version,
  stored/rotated/destroyed times. A settings-free guard trigger: no delete or truncate, scope never changes, the
  version bumps by one, a destroyed row never changes again and holds no sealed value.
- **Registry** `hon.school_pay_provider_credentials(provider_code, credential_kind)`: which providers keep per-school
  credentials (`SQUARE` → `OAUTH_TOKENS`); Stripe keeps none. HON's own processor later is one row.
- **Sealing happens in the API**; the database sees only the sealed text. The additional data binds the blob to
  `connectionId`, provider and account, so a blob copied to another connection does not open.
- **Entry points** (direct human, `school_pay.connection.manage`, live re-checks):
  - `check_school_payment_onboarding_state(subject, connection, {expectedVersion, onboardingState})`: read-only state check.
  - `store_school_payment_credential(subject, connection, {keyId, sealed, accessExpiresAt, expectedCredentialVersion})`:
    accepted only when the same transaction has just recorded that connection's FINISH or REFRESH (the connection row
    was written by the current transaction) and the connection is connected. So tokens are stored only if the database
    accepts the finish, in the same commit.
  - `read_school_payment_credential(subject, connection)`: the sealed record of an open, connected connection.
  - `destroy_school_payment_credential(subject, connection)`: accepted only in the transaction that ended the
    connection; clears the sealed value.
  Each write adds an audit event (no secret in it). Replays of the finish/refresh command store nothing.
- If the finish write is refused after a Square code exchange, the new tokens are dropped from memory and **not**
  revoked: Square revokes per merchant, so a revoke could cut off another connection on the same account. The owner
  starts again.

### Plan (TDD, one PR)

1. Contracts: credential record verifier; observation unchanged.
2. Vault module (seal/open, key checks) with unit tests.
3. Real adapters over an injected HTTPS transport, unit-tested against recorded-shape fakes (no network in tests):
   Stripe account + link + status, Square authorize URL + token + status + renew + revoke; live keys refused.
4. Migration 0320 + DB/HTTP proof (simulated Square returns synthetic tokens): stored only with a finish, sealed only,
   wrong-transaction store refused, read needs manage, destroyed with disconnect, runtime ACL, history.
5. Service wiring: state check before exchange, store in the finish/refresh transaction, renew, destroy on disconnect.
6. Sandbox smoke check (manual, owner-visible): Square sandbox token endpoint reachable with the app credentials;
   Stripe calls only once the environment stops replacing the key on `api.stripe.com` (owner choice).

## 12. Piece 2 as built (0320)

Status: source only, not deployed. Test/sandbox only.

- **API:** `school-payment-sandbox-adapters.ts` (`StripeConnectTestAdapter`, `SquareSandboxAdapter`, fixed hosts, an
  injectable transport with a 15 s limit and no redirects), `school-payment-vault.ts` (AES-256-GCM seal/open bound to
  connection, provider and account), adapter selection in `schoolPaymentAdaptersFromEnvironment`, and the service wiring:
  state check before the Square exchange, sealed credential stored with the FINISH/REFRESH record, renewal within 7 days
  of expiry (a grant the seller revoked, Square 401 or `invalid_grant`, is recorded as `REAUTHORIZATION_REQUIRED` with
  no rotation; timeouts, 429 and 5xx stay `UNKNOWN`), and disconnect skipping the provider revoke while another open connection uses the same account (school B in
  the same organization may share it; this also changes the piece 1 behaviour, which revoked unconditionally).
- **Simulators:** the simulated Square now hands back synthetic tokens, so the vault path runs end to end without a
  network. With simulators on (never in production) and no vault key, the API uses a random per-process key.
- **Database:** `school_pay_provider_credentials`, `school_pay_credentials` (private, forced RLS, no runtime privilege),
  the destroy-on-end trigger, the deferred credential check, and four runtime entry points
  (`check_school_payment_onboarding_state`, `record_school_payment_status_with_credential`,
  `read_school_payment_credential`, `read_school_payment_account_use`); grants in 010, exact section in 011.
- **Evidence:** `apps/api/test/school-payments-sandbox.test.cjs` (8 tests: vault, environment selection, Stripe and
  Square request shapes and answer mapping over a recording transport); `pnpm --filter @hon/database
  db:test-school-payment-credential-vault` (89 checks over signed HTTP); the 0258 proof now runs with the vault (141).
- **Real sandbox check (2026-11-13, from the build container):** Square sandbox answered with the configured app: a made-up
  code is refused (`FAILED`), a made-up token reads as reauthorization required. Stripe was **not** called: this
  container's network proxy replaces the `Authorization` header on `api.stripe.com` with HON's SaaS sandbox key, which
  must never be used for tuition. A full connect needs a browser sign-in to a Square sandbox seller and the Square app's
  redirect URL set to `<web origin>/staff/billing/payment-processors`.
- **Real Stripe check (2026-11-13, separate test environment without the key injection, head 3f5f77c):** with the tuition
  `sk_test_` key, the adapter created a Standard connected account, created an Account Link (a repeated request returned
  the same account) and read its status (not ready, requirements due). No code changed.
- **Assumption:** in the code flow Square's refresh token stays reusable and comes back in every renewal answer; the
  token from the answer is stored. An answer without one is treated as `UNKNOWN` and nothing is rotated.
- **Still needed before any real use:** `HON_SCHOOL_PAY_VAULT_KEY`/`_KEY_ID` in each environment (a secret, owner
  adds), Square redirect URL, Stripe calls from an environment without the SaaS key injection, key rotation (old key ids
  are not yet kept, so rotating the single vault key strands stored credentials until reconnect), two disconnects of
  connections sharing one Square merchant that race can both skip the provider revoke (no lock across connections yet),
  and the Manus final review (live-money/credential item).

## 13. Piece 3 as built (0321): a payer's saved cards and bank accounts

Status: source only, not deployed, test mode only, on the in-process simulators (no real Stripe or Square call yet; piece
2 adds the sandbox adapters with test keys the owner enters). No charge, autopay or message; HON takes no fee.

- **Permission:** `school_pay.method.manage` (sensitive, staff-assignable, granted to OWNER) saves, chooses the default
  for, or removes a method; `school_pay.read` or the manage permission reads. Live direct-human authority at the route
  school is re-checked before and after every command, as in 0258.
- **Data (private, forced RLS, no runtime table privilege):** `school_pay_customers` (one provider customer per payer and
  connection, set once), `school_pay_method_setups` (hosted setup: one-time state kept only as SHA-256, one hour, newer
  replaces older, recently completed listed for one hour so a retried finish replays), `school_pay_methods` (provider
  reference, kind CARD or US_BANK_ACCOUNT, brand, last four, card expiry, consent text version, ACTIVE or REMOVED, one
  default per payer), `school_pay_method_events` (append-only history). No card number, bank number, CVC or token
  secret exists anywhere in HON.
- **Flow:** staff pick a connection and method kinds and show the payer the consent text (its version is recorded). The
  API creates the payer's provider customer once, then a hosted setup page (Stripe SetupIntent or Checkout setup mode;
  Square Web Payments SDK card on file) that returns to `/staff/billing/saved-payment-methods?payer=..&setup=..&state=..`.
  On return the API retrieves the saved method from the provider with its own credentials (never from the browser),
  then records it; the payer's first method becomes the default. Square takes cards only.
- **Routes** (`/v1/organizations/:org/schools/:school/payments/...`, human-UI guards, no-store): `GET
  payers/:billingAccountId/methods`, `GET saved-methods/expiring` (expired or expiring this or next school month),
  `POST payers/:id/method-setups`, `POST payers/:id/method-setups/:setupId/finish`, `POST payers/:id/methods/:methodId/default`,
  `POST payers/:id/methods/:methodId/remove` (reason required; the provider detach is reported as `providerDetached`).
  Provider account, customer and method references stay in the API and never reach the browser.
- **Known limits:** a disconnected connection's saved methods stay ACTIVE in HON but cannot be used (autopay, piece 4,
  checks the connection); card expiry updates from the provider come with webhooks (pieces 5 and 6).
- **Bank accounts verified by microdeposits:** when Stripe cannot verify a US bank account instantly, the SetupIntent
  stays unfinished until the payer confirms the microdeposits, so finishing the setup returns `SETUP_INCOMPLETE` (409)
  and nothing is saved. The payer finishes later on a new setup; recording the account once the deposits clear needs
  the webhooks in piece 5b.
- **Real sandboxes (after piece 2, 0320):** the Stripe Connect test adapter saves methods for real: the customer and a
  Checkout session in setup mode are created on the school's own account (`Stripe-Account`), each with an idempotency key
  (so a retry never leaves an orphan customer or setup), and the saved card or bank account is read back with the platform
  key. Square's sandbox adapter refuses saved-method calls before sending anything (`SCHOOL_PAY_PROVIDER_NOT_CONFIGURED`):
  saving a Square card needs the Web Payments SDK on a HON page plus the seller's vaulted token, a later piece.
- **Evidence:** `packages/database/scripts/test-school-pay-methods-integrity.mjs` (188 checks over signed HTTP);
  `apps/api/test/school-payments.test.cjs` (0321 contract, simulator and route tests).

## 14. Piece 3-web as built: saved payment methods page for staff

- **Page:** `/staff/billing/saved-payment-methods` (Billing menu, "Saved payment methods"), dynamic, noindex,
  `no-referrer`, behind the verified web session. The page holds no school or payer id of its own; it uses the shell's
  verified school, and the API decides every permission (`school_pay.method.manage` to change, the read permission to see).
- **Payer picker:** payers come from the existing membership list read (one option per billing account, named from its
  participants); a `?payer=` link opens one directly, and the expiring list links to each payer.
- **Adding:** staff choose the processor connection and card or US bank account (bank only where the connection can
  debit), and the payer ticks the consent text, which names the school (`card-on-file-v1` or `ach-mandate-v1`). The page
  then opens the processor's hosted page. A replayed start answers with no link, and the page says to start again.
- **Return:** the query (`payer`, `setup`, `state`) is read once and removed from the address bar at once; the one-time
  state is kept only in memory, never in storage, and is sent only when staff choose Finish saving. A session end, a
  school change or picking another payer drops it; blur or a hidden tab hides the page but keeps it.
- **Commands:** each sends its own `X-HON-Human-Command` and `Idempotency-Key`; an unknown or rate-limited outcome keeps
  the exact request and key in memory for Try again. Every answer is followed by a fresh read. Remove needs a reason and
  says plainly when the processor did not confirm the detach.
- **Evidence:** `apps/web/test/saved-methods-ui.test.tsx` (http shape and verification, refusal mapping, query cleaning,
  body building, view states, page and menu wiring).

## 15. Piece 4 as built (0322): autopay plans and sibling discounts

Test mode only. A payer's autopay plan points at one of their saved methods (0321), and preparing a cycle turns that
payer's due membership schedules into invoices with the school's sibling discount. **Nothing is charged here**: piece 5
sends the cycle to the processor. No message is sent and HON takes no fee.

- **Permissions:** `school_pay.autopay.manage` enrolls, changes the method, pauses, resumes, cancels and prepares cycles;
  `school_pay.discount.manage` sets the sibling discount. Both are sensitive, staff-assignable and granted to OWNER.
  Reads accept either one or `school_pay.read`. Live direct-human authority at the route school is re-checked before
  and after every command, as in 0258 and 0321.
- **Data (private, forced RLS, no runtime table privilege):** `school_pay_discount_rules` (append-only versions per
  school: NONE, PERCENT 0 to 100, or FIXED minor units in one currency, with one value for the 2nd student and one for
  the 3rd and later), `school_pay_autopay_plans` (one open plan per payer; ACTIVE, PAUSED or CANCELLED with a reason;
  the saved method, the consent text version and an expected version on every change), `school_pay_autopay_cycles`
  and `school_pay_autopay_cycle_lines` (immutable; one line per billed schedule period, unique per schedule and
  period, each with its own invoice), and `school_pay_autopay_events` (append-only history). Each command writes one
  history row, one audit row and one inert outbox event; each cycle invoice also gets an audit row.
- **Method rule:** the plan's method must be ACTIVE, belong to the same payer, and sit on a connection that is
  CONNECTED_ACTIVE and allows off-session recurring charges. Otherwise the command is refused with
  `SCHOOL_PAY_AUTOPAY_METHOD_UNUSABLE`.
- **Cycle rule:** a cycle can be prepared for an ACTIVE plan for today or up to seven days ahead (school time zone).
  Due lines are the payer's ACTIVE memberships whose ACTIVE WEEKLY, MONTHLY or ANNUAL schedule is in the payer's
  currency, has its next charge on or before the cycle date, and has not been billed for that period. Students are
  ranked by their largest due line; the 1st pays full price, the 2nd and later get the rule's discount (a percentage
  rounds down; a fixed amount never exceeds the line and applies only in its currency). Each line becomes one ISSUED
  invoice due at the end of the cycle day, and its schedule moves to the next period (or ends at the term end). One
  schedule period is billed per cycle, so a schedule that is several periods behind catches up over several cycles.
  Months and years count from the schedule's first autopay period, so a short month clamps only that one period
  (Jan 31, Feb 28, Mar 31; a Feb 29 annual schedule bills Feb 28 in other years and Feb 29 again in leap years). A
  schedule staff move off that series starts a new one. Local time of day is kept across daylight-saving changes.
- **Routes** (`/v1/organizations/:org/schools/:school/payments/...`, human-UI guards, no-store): `GET
  payers/:billingAccountId/autopay`, `GET sibling-discount`, `POST sibling-discount`, `POST payers/:billingAccountId/autopay`,
  `POST autopay/:planId/method`, `POST autopay/:planId/state` (ACTIVE or PAUSED), `POST autopay/:planId/cancel` (reason
  required), `POST autopay/:planId/cycles`. Every command takes an Idempotency-Key; a replay returns the stored receipt.
- **Defaults to confirm with the owner:** ranking students by their largest due line; one period per cycle; schedules
  advance when the cycle is prepared (not when it is paid); a seven-day preparation window. Screens for staff come in a
  later web piece.
- **Review P3s carried forward:** the consent text version is free text today; before 5a charges anything it must be
  one of the recurring-charge consent texts and match the method kind, re-checked when the method changes. A 100%
  discount makes a zero invoice that cannot become PAID. Sibling rank counts only lines due in the same cycle. Manual
  invoices can overlap autopay periods, and a backdated cycle issues invoices that are already overdue.
- **Evidence:** `packages/database/scripts/test-school-pay-autopay-integrity.mjs` (231 checks over signed HTTP, including month-end,
  leap-year and daylight-saving periods);
  `apps/api/test/school-payments.test.cjs` (0322 contract, discount and route tests).
