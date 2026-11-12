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
