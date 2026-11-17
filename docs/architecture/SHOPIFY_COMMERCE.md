# HON Shopify Connected (migrations 0405 SH1, 0442 SH1b)

Status: SH1 merged (0405); SH1b built (0442), 2026-11-16. Owner vision: David's Oct 13–18 2026 Shopify recap (shared 2026-11-16), the master
directive (ECOMMERCE: "Shopify may remain the source of truth for those commerce records"; "Shopify integration should
be first-class where enabled"; "Shopify outage: commerce sync degraded") and the menu decision "Finance: checkout pages,
POS, Shopify, invoices".

## The vision (owner-approved, not yet built)

HON OS is the intelligent operating layer on top of Shopify. Shopify stays the commerce engine and the inventory source
of truth: products, variants, SKUs, inventory, checkout, orders and fulfillment. HON connects with OAuth, the Admin API
and webhooks through **one HON Shopify app** (schools never create developer apps or paste keys). No iframe embedding of
Shopify admin. Products sell across HON (POS, Parent App, HON websites) with Shopify Checkout, and orders return to HON.
Print-on-demand (Printful, Ninja POD, Tapstitch). A HON Commerce Workspace with catalog, artwork and mockups, pricing and
promotions, sales, inventory and **profitability as a first-class feature**. AI by plan: Essential = connection, sync,
catalog, uploads, publishing, sales reports; Core = + AI analysis, design/mockup help, descriptions, pricing and promotion
ideas; Complete = + a Commerce/Inventory/Creative AI agent that carries out owner-approved workflows. Ideal Martial Arts'
store is the test store.

## Pieces

| Piece | What | Needs David |
|---|---|---|
| **SH1 (0405, merged)** | Connect one store per school via the HON app (OAuth, expiring offline token sealed by the API), Sync now (products, variants, SKU, price, stock, unit cost; last 60 days of orders), Finance › Shopify page with catalog, margins and sales summary, disconnect. Fake Shopify only. | No |
| **SH1b (0442, this)** | Signed webhooks: products, inventory levels, orders, `app/uninstalled`, and the three mandatory privacy topics; scheduled background sync that also keeps the refresh token alive. | No |
| SH2 | POS sells Shopify variants when connected (database reprices from the mirror) and each sale is pushed to Shopify (order + inventory) through a queued job. Coordinated with the POS thread (0403). | No |
| SH3 | Parent App and HON website buy through Shopify Checkout (Storefront cart → Shopify-hosted checkout); orders link back to the HON contact. | No |
| SH4 | Commerce Workspace writes: create/edit products and prices, artwork upload, mockups, publish; AI descriptions/pricing/promotions by plan (fake AI until approved). | Paid AI |
| SH5 | Print-on-demand providers. | Provider accounts |
| SH6 | Complete-plan commerce agent through the AI Action Engine (proposals, owner approval). | Paid AI |
| Live | Create the HON Shopify Partner app, set its secrets on Render, connect the Ideal Martial Arts store. | **Yes** |

## SH1 behavior

### Who

- `commerce.shopify.read` (staff-assignable): see the Shopify page (status, products, orders, sales summary).
- `commerce.shopify.manage` (staff-assignable, sensitive): connect, sync now, disconnect. Includes read.
- Granted to the system OWNER role only. Same identity rules as POS 0403 (one active human principal, active school and
  organization, active HON entitlement, live grant at that exact school). Authority is decided again after the last write.
- Every plan (Essential, Core, Complete) gets SH1; AI pieces are gated by plan later.

### Connect (one HON app, OAuth authorization code grant)

1. Owner types the store name (`ideal-martial-arts` or `ideal-martial-arts.myshopify.com`). The API normalises it to
   `<name>.myshopify.com` (lowercase, `^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$`).
2. `start`: the API makes a 32-byte random state; the database stores only its SHA-256 in a single-use intent bound to
   the person, school and shop, valid 10 minutes, at most 10 per school per hour. The API returns
   `https://<shop>/admin/oauth/authorize?client_id=…&scope=read_products,read_inventory,read_orders&redirect_uri=<origin>/staff/billing/shopify/return&state=…`.
   The browser navigates top-level (no iframe).
3. Shopify sends the browser back with `code, hmac, host, shop, state, timestamp`. The return page posts the whole query to
   `complete`. The API verifies the HMAC (hex HMAC-SHA256 of the sorted `k=v&…` query without `hmac`, app secret,
   timing-safe), a fresh timestamp (±10 minutes), and the shop format. The database claims the intent (same person, same
   school, same shop, unused, unexpired) and returns the connection id to bind the credential to (the school's existing
   connection for that shop, or a new id).
4. The API exchanges the code (`POST https://<shop>/admin/oauth/access_token` with `expiring=1`), requires every
   requested scope (a `write_x` grant satisfies `read_x`), reads the shop name and currency, seals
   `{accessToken, refreshToken, accessExpiresAt, refreshExpiresAt}` with AES-256-GCM (key `HON_SHOPIFY_VAULT_KEY`, bound to
   connection id + shop) and records the connection with its sealed credential in one transaction.
5. One store belongs to one school, ever (a claim from another school is refused `SHOPIFY_SHOP_TAKEN`). One connected
   store per school; connecting a different store needs a disconnect first.

Expiring offline tokens: Shopify requires them for new public apps (1-hour access token, 90-day refresh token). Before
every sync the API refreshes when the access token has less than 5 minutes left and stores the rotated pair
(version-checked). A refused refresh or a 401/403 token answer marks the connection `NEEDS_RECONNECT` and destroys the
credential; the owner reconnects.

### Sync now

`begin` (one running sync per connection; a sync older than 15 minutes counts as abandoned) returns the sealed
credential to the API only. The API reads `shop`, then products (50 per page, variants 100 per product, at most 2,000
products) and orders created in the last 60 days (50 per page, at most 1,000, 50 lines each), and records each page.
`finish SUCCEEDED` archives products and variants not seen in this run; `FAILED` keeps what was there. Results show
counts and the time. Shopify is never written to in SH1.

Mirrored, per school: products (Shopify id, title, status, vendor, type, handle, image URL, archived), variants (id,
title, SKU, barcode, price, compare-at price, unit cost, tracked, inventory quantity), orders (id, name like `#1001`,
created, cancelled, financial and fulfillment status, source channel, currency, subtotal, discounts, tax, total) and order
lines (title, SKU, variant id, quantity, unit price). **No customer names, emails, phones or addresses are stored**; SH3
links orders to HON contacts.

### The Shopify page (Finance › Shopify, `/staff/billing/shopify`)

- Not connected: what Shopify Connected does, the store-name field and **Connect Shopify**. When the HON app is not
  configured on this server: "Shopify connection isn't turned on yet" (no button).
- Connected: store name and domain, last sync, **Sync now**, **Disconnect**; tabs **Products and stock** (each product
  with variants: SKU, price, cost, margin, stock, low-stock badge at ≤ 3 when tracked) and **Orders** (newest first) with a
  30-day summary: orders, sales, average order, items sold, top products, and **estimated gross profit** (lines whose
  variant has a unit cost, using today's cost; the share of sales with a known cost is shown, so the number is honest).
- Needs reconnect: a banner and **Reconnect**.

### Safety

- Real Shopify is called only when `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` (≥ 32 chars), a valid
  `HON_SHOPIFY_VAULT_KEY`/`_KEY_ID` and `HON_SHOPIFY_CONNECT_APPROVED=true` are set. The fake (`HON_SHOPIFY_FAKE=1`) runs
  only outside production and staging. Nothing writes to Shopify, sends a message, charges or spends.
- Tables are forced-RLS with no client privileges; the runtime executes fixed SECURITY DEFINER entry points only.
- Tokens are sealed by the API; the database never sees plaintext and never decrypts. Read answers never include the
  sealed credential. Audit/outbox carry ids, domain and counts only.
- Shopify text (titles, SKUs) is stored as bounded plain text and rendered as text, never HTML.

### Known limits in SH1 (each named for a later piece)

- Disconnect destroys HON's stored token pair but does not call Shopify to revoke it; without the refresh token, access
  ends within an hour. Uninstalling HON from Shopify (`app/uninstalled`) is handled by SH1b.
- If Shopify accepts a refresh but HON fails to record the rotated pair, the old pair is already spent: the next sync
  ends as Needs reconnect and the owner reconnects. Nothing is lost from the mirror.
- A store is bound to the first school that connects it, forever (one row per shop). Moving a store between schools is
  an HQ action for a later piece.
- In SH1, sync runs inside the request (Sync now and after connecting); SH1b adds background sync. Very large
  stores (over 2,000 products or 1,000 orders in 60 days) finish as FAILED with the reason shown, never as partial success.
- No product search yet on the page.

## SH1b behavior (0442)

### Webhooks (`POST /v1/commerce/webhooks/shopify`)

- Declared once for the HON Shopify app in `shopify.app.toml` (no per-store registration, nothing to set up at the
  school):

  ```toml
  [webhooks]
  api_version = "2026-10"

  [[webhooks.subscriptions]]
  topics = ["products/create", "products/update", "products/delete", "inventory_levels/update",
            "orders/create", "orders/updated", "orders/cancelled", "orders/delete", "app/uninstalled"]
  uri = "https://<HON API host>/v1/commerce/webhooks/shopify"

  [[webhooks.subscriptions]]
  compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
  uri = "https://<HON API host>/v1/commerce/webhooks/shopify"
  ```

- Transport: mounted before the JSON parser so the exact bytes are kept; POST to that one path only, JSON, no query
  string, cookies, credentials or compression, at most 4 MiB.
- Verification first: base64 HMAC-SHA256 of the raw body with the app's client secret (`X-Shopify-Hmac-SHA256`),
  compared in constant time. Then `X-Shopify-Webhook-Id`, `X-Shopify-Shop-Domain` (myshopify.com only) and
  `X-Shopify-Topic`. A bad signature is 401 and reaches nothing. An unknown topic is 200 and ignored.
- Only the delivery id, topic, shop domain and trigger time reach the database. The payload is never read or stored:
  HON re-reads Shopify for the change.
- Recorded once per delivery id (`hon.shopify_webhook_receipts`, never changed). A repeat is answered with its first
  outcome. HON answers 200 once recorded, and 503 when it cannot record, so Shopify delivers it again.
- Effects:
  - Catalog, inventory and order topics mark a CONNECTED store as needing a sync (`hon.shopify_sync_requests`).
  - `app/uninstalled` disconnects the store at once. The sealed token pair is destroyed in the same transaction, and a
    running sync ends as FAILED `UNINSTALLED`.
  - `shop/redact` (Shopify sends it 48 hours after an uninstall) erases the store's products, variants, orders and
    order lines and its shop name, once the store is no longer connected. The store record stays, so the shop still
    belongs to that school, and reconnecting starts a fresh mirror.
  - `customers/redact` and `customers/data_request` are recorded as `NO_CUSTOMER_DATA`. HON's Shopify mirror holds
    no customer names, emails, phones or addresses, so there is nothing to send or erase.
  - Uninstall and erase write audit and outbox evidence (ids, shop domain and counts only) as the code-owned
    `SYSTEM_SERVICE` principal `00000000-0000-4000-8000-000000000408`, with source `INTEGRATION`.

### Background sync

- Runs in the API process when the worker login (`HON_COMMUNICATION_WORKER_DATABASE_URL`, the existing
  `hon_communication_worker`, never the runtime) and `HON_SHOPIFY_SYNC_POLL_SECONDS` (30–3600) are both set, and
  the Shopify app is configured. It is off otherwise. The Shopify page says "HON syncs on its own" only when it is on.
- Each run claims up to 5 stores, one at a time. A store is due when all of these hold:
  - it is CONNECTED;
  - its school, organization and HON entitlement are active;
  - no sync started in the last two minutes and none is running;
  - either Shopify reported a change after its latest sync started, or it has not finished a sync in six hours.
    The six-hour run also refreshes the token pair, which keeps the 90-day refresh token alive.
- A store another worker holds, or whose school is in the middle of a person's command, is skipped and tried next run.
- The sync is the same code as Sync now (`runShopifySync`): refresh-and-rotate under version, pages of 50 through the
  same page rules, the same outcomes. The run is started by the code-owned principal with a lease token (`source`
  WEBHOOK or SCHEDULED). Only that lease can rotate, write pages to or finish it. A person's sync commands cannot write
  to it, and Sync now answers "A sync is already running".
- Locks follow the person's order (school lock, then the run, then the store) so a background run and a person's
  disconnect cannot deadlock.

### Known limits in SH1b

- Webhooks are not replayed into partial updates. Any change report triggers a full re-read, which keeps one code path
  and Shopify as the source of truth, at the cost of a full sync per burst of changes (at most one per store every two
  minutes).
- Webhook receipts are kept forever (ids, topics and times only, no payload). Shopify retries a delivery for up to
  48 hours, so a later retention rule may remove receipts older than 30 days without weakening replay protection; it
  comes with the HQ data-retention work and needs a new migration (receipts cannot be deleted today).
- If Shopify issues a refreshed token pair and HON then refuses to store it (version conflict, lease lost), the new
  pair is lost and the store needs reconnecting on its next run (same as Sync now since SH1). Rare; a later piece can
  hold the pair for one retry.
- The background proof runs the five worker functions over the fixture owner connection. Their grant to the real
  `hon_communication_worker` login (013) was checked by hand on the communication fixture; a fixture that runs the
  proof as that login is a follow-up.
- The `shopify.app.toml` and the Partner app itself are created only with David's approval, together with the real keys.

## Plan (TDD)

1. Migration 0405 + DB proof `test-shopify-commerce-integrity.mjs` over signed HTTP with the fake adapter: ACL/RLS,
   permissions and scope refusals, connect (state single use, expiry, wrong person/school/shop, shop taken), sealed
   credential never read back, sync begin/page/finish incl. archive and failure, refresh rotation, needs-reconnect,
   disconnect, report math, authority loss after the last write.
2. Contracts `packages/contracts/src/shopify.ts` (validators, money math) with unit tests.
3. API `apps/api/src/commerce/shopify/`: HMAC verifier, vault, adapter interface + fake + GraphQL adapter (version
   `2026-10`), service, controller; unit tests for HMAC, shop normalisation, vault, adapter parsing.
4. Web: `/staff/billing/shopify` page + return page, component tests. Menu: listed in today's Billing › Payments group
   (next to Checkout pages); it moves to the Finance area with the menu rework (PR #407) when that lands.
5. Runtime grants (010/011), verify-rls, staging pins, run-db-proofs; focused tests, `pnpm check`, build; independent
   review; PR.

## SH1b plan (done)

1. Migration 0442 + DB proof `test-shopify-background-integrity.mjs` (signed HTTP deliveries, worker functions over
   the owner connection exactly as `ShopifyWorkerDatabase` maps them).
2. API: `shopify-webhook.ts` (transport, verifier), `shopify-webhook.controller.ts`, `shopify-sync-engine.ts` (the one
   sync used by both paths), `shopify-worker.ts` (worker store, background sync, scheduler); unit tests in
   `apps/api/test/shopify-background.test.cjs`.
3. Contract `autoSync` on the overview; the page line in en/ko/es.
4. Grants: 010 (nothing for the runtime), 011 exact verification, 013 worker grants; verify-rls, staging pins,
   run-db-proofs.
