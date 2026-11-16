# HON Shopify Connected (migration 0405, piece SH1)

Status: spec + plan, 2026-11-16. Owner vision: David's Oct 13–18 2026 Shopify recap (shared 2026-11-16), the master
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
| **SH1 (0405, this)** | Connect one store per school via the HON app (OAuth, expiring offline token sealed by the API), Sync now (products, variants, SKU, price, stock, unit cost; last 60 days of orders), Finance › Shopify page with catalog, margins and sales summary, disconnect. Fake Shopify only. | No |
| SH1b | Signed webhooks: products, inventory levels, orders, `app/uninstalled`, and the three mandatory privacy topics; scheduled background sync that also keeps the refresh token alive. | No |
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
  ends within an hour. Uninstall handling (`app/uninstalled`) comes with SH1b webhooks.
- If Shopify accepts a refresh but HON fails to record the rotated pair, the old pair is already spent: the next sync
  ends as Needs reconnect and the owner reconnects. Nothing is lost from the mirror.
- A store is bound to the first school that connects it, forever (one row per shop). Moving a store between schools is
  an HQ action for a later piece.
- Sync runs inside the request (Sync now and after connecting); background and scheduled sync are SH1b. Very large
  stores (over 2,000 products or 1,000 orders in 60 days) finish as FAILED with the reason shown, never as partial success.
- No product search yet on the page.

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
