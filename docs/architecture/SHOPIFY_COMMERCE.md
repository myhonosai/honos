# HON Shopify Connected (migrations 0405 SH1, 0449 SH1b, 0470 SH1c, 0496 SH4a)

Status: SH1 merged (0405); SH1b built (0449), 2026-11-16. Owner vision: David's Oct 13–18 2026 Shopify recap (shared 2026-11-16), the master
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
| **SH1b (0449, merged)** | Signed webhooks: products, inventory levels, orders, `app/uninstalled`, and the three mandatory privacy topics; scheduled background sync that also keeps the refresh token alive. | No |
| **SH1c (0470, merged)** | Order retention: a mirrored order and its lines are deleted 60 days after the order was placed, on every successful sync and by the background worker for every store (connected or not). | No |
| **WS1 (this, no migration)** | Commerce Workspace layout over the read-only mirror: Overview (30-day sales, needs attention, recent orders), Products (search, status/type filters, variants, margins), Orders (filters, lines, totals), Inventory (low stock, units, stock value at cost), Store settings (connection, what HON can do). Each record links to the same record in Shopify admin. | No |
| SH2 | POS sells Shopify variants when connected (database reprices from the mirror) and each sale is pushed to Shopify (order + inventory) through a queued job. Coordinated with the POS thread (0403). | No |
| SH3 | Parent App and HON website buy through Shopify Checkout (Storefront cart → Shopify-hosted checkout); orders link back to the HON contact. | No |
| SH4 | Commerce Workspace writes: create/edit products and prices, artwork upload, mockups, publish; AI descriptions/pricing/promotions by plan (fake AI until approved). | Paid AI |
| **PD1 (0611)** | Print on demand, first piece: the sync reads who fulfils each variant (the school's own location or a third-party fulfilment service such as a print provider's Shopify app) and Commerce shows it. HON connects to no provider. | No |
| SH5 | Print-on-demand providers: direct connections, where a provider's API is verified. | Provider accounts |
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

## SH1b behavior (0449)

### Webhooks (`POST /v1/commerce/webhooks/shopify`)

- Declared once for the HON Shopify app in `shopify.app.toml` (no per-store registration, nothing to set up at the
  school):

  ```toml
  [webhooks]
  api_version = "2026-10"

  [[webhooks.subscriptions]]
  topics = ["products/create", "products/update", "products/delete", "inventory_levels/update",
            "orders/create", "orders/updated", "orders/cancelled", "orders/delete", "app/uninstalled"]
  uri = "https://app.myhonos.com/api/v1/commerce/webhooks/shopify"

  [[webhooks.subscriptions]]
  compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
  uri = "https://app.myhonos.com/api/v1/commerce/webhooks/shopify"
  ```

  The real file is `shopify-app/shopify.app.toml`. The API is a private service with no public URL, so the address is
  the web app's `/api/v1/*` rewrite, which forwards the request to the API's `/v1/*` unchanged.

  **Live state (2026-11-21):** the released app versions up to `hon-os-3` declare only `api_version`, with no
  subscriptions, so no webhook reaches HON yet: an uninstall does not disconnect the store, changes wait for Sync now
  or the six-hour background run, and the compliance topics do not arrive. The subscriptions take effect when the app
  owner releases a version that includes them (see `shopify-app/README.md`).
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

## SH1c behavior (0470): order retention

HON reads only the last 60 days of a store's orders, so it keeps a mirrored order only that long. This is the answer
behind "Yes" on Shopify's data-retention question for the protected-customer-data review.

- Every successful sync (a person's Sync now or a background run) deletes that store's orders placed more than 60 days
  ago, and their lines, in the same transaction that records the sync as SUCCEEDED (trigger
  `shopify_syncs_order_retention`). A failed or abandoned run deletes nothing.
- The background worker calls `hon.purge_expired_shopify_orders()` before claiming any store: up to 2,000 expired
  orders per call across all stores, including stores that are disconnected or waiting to reconnect and so never sync,
  at most five calls per run. It never waits for a lock; an order a running sync holds is left for the next call.
- Order rows hold no customer details (0405). Products and variants stay while the store is connected and are erased
  by `shop/redact` after it leaves (SH1b).
- The purge is executable only by `hon_communication_worker` (013); the trigger function by nobody. 010 revokes both,
  011 pins both bodies and the trigger.

## WS1: Commerce Workspace (owner vision 2026-11-18, `/mnt/project-files/shopify/COMMERCE_VISION_2026-11-18.md`)

David's Commerce vision replaces the single Shopify page with a Commerce Workspace. WS1 is its frame, built only on the
existing read endpoints (overview, catalog, orders); no migration and no new permission.

- Sections: Overview, Products, Orders, Inventory, Store settings. The open section is kept in the address (`#products`)
  and only known names are accepted. Later sections (Collections, Fulfillment, Theme Builder, Creative Studio,
  Promotions, Automations, Analytics) are added when they work, never as empty screens.
- Overview: the 30-day summary, a "Needs attention" list counted from the mirror (orders to fulfill = not cancelled and
  not FULFILLED/RESTOCKED; low stock; variants without a cost; draft products) and the five most recent orders. A list
  that is loading or failed says so; nothing is shown as zero.
- Products and orders are read together once a store is linked. Search and filters run in the browser over the verified
  answer. Shopify status words are translated when known and shown as plain words otherwise.
- "Open in Shopify" links are built only from the verified myshopify name and numeric ids
  (`https://admin.shopify.com/store/<name>/products/<id>`), open in a new tab with `noopener noreferrer`.
- Product images load lazily from Shopify's CDN (the verified URL pattern) with no referrer.
- Order of later pieces (owner-approved 2026-11-18): product editing with owner approval; Creative Studio product drafts
  (paid image provider needs approval); Theme Builder on a safe copy of an existing theme (needs Shopify's theme-file
  exemption, request drafted at `/mnt/project-files/shopify/THEME_EDIT_EXEMPTION_REQUEST_DRAFT.md`); Parent App shop and
  website link; POS and print-on-demand; Commerce Agent and automations.

## SH4a: product editing with approval (0496)

Every product edit made in HON is saved first and sent to Shopify only when a person with `commerce.shopify.manage` at
the school approves it. Shopify stays the source of truth: HON checks the product in Shopify right before writing, so it
never overwrites a change made there.

### Who and what
- Propose, cancel, approve: `commerce.shopify.manage` at the school (re-checked after the last write). Read the list:
  `commerce.shopify.read`. A revoked grant stops proposing and approving at once.
- An **edit** (`UPDATE`) may change title, type, vendor, status (ACTIVE, DRAFT, ARCHIVED; never UNLISTED) and, per
  variant, price, compare-at price and cost per item. Only the fields that changed are sent. One open edit per product.
- A **new product** (`CREATE_DRAFT`) has a title, optional description, type, vendor, SKU, a price and optional
  compare-at price and cost. It is always created in Shopify as a DRAFT under a handle HON chooses
  (`<slug>-<10 hex of the change id>`), so a repeat finds the earlier product instead of creating a second one.
  At most 20 new products wait at once; at most 200 proposals per school per day.
- Every proposal stores a **base**: the mirror's values for the touched fields when it was made.

### Approval (`POST /v1/school/shopify/changes/approve`)
1. The database leases the change for 3 minutes to the approver (`APPLYING`), with a fresh lease token, and hands the
   API the sealed credential. It refuses when the store has not granted `write_products` (or `write_inventory` for a
   cost), when the mirror no longer matches the base (`SHOPIFY_CHANGE_STALE`), or after 5 attempts.
2. The API reads the product live from Shopify. If it differs from the base the change is `FAILED`
   (`CHANGED_IN_SHOPIFY`) without writing, and the mirror is refreshed from what Shopify said.
3. It writes (`productUpdate`, `productVariantsBulkUpdate`, or `productCreate` as DRAFT), reads the product back and
   records `APPLIED` only when the product shows every proposed value. The mirror row is updated in the same step.
4. Any write answer that is lost, or an access error on a write, is `UNKNOWN`: it is never assumed to have saved
   nothing. Approving an `UNKNOWN` change again only reads Shopify (CHECK mode) and records APPLIED or
   `FAILED NOT_APPLIED`. A lease that runs out reads as UNKNOWN (`LEASE_EXPIRED`); a late result after that is refused.
5. A second write refused after the first was saved is `FAILED PARTLY_APPLIED` with the product.
6. A manager can close an `UNKNOWN` change (never while a lease is live) after checking Shopify themselves: it becomes
   `FAILED CLOSED_UNRESOLVED` with evidence, freeing the product (and the draft cap) for a new edit. This is the way out
   after 5 attempts.

Statuses: PENDING → APPLYING | CANCELLED; APPLYING → APPLIED | FAILED | UNKNOWN; UNKNOWN → APPLYING | APPLIED | FAILED (incl. closed unresolved).
The table's guard keeps identity, kind, handle, changes, base, source and proposer fixed, bumps the version on every
update and refuses delete and truncate. Audit and outbox evidence name the fields, never the values.

### Allow editing
Plain connect still asks only for read scopes. **Allow editing** reconnects the same store asking Shopify for
`write_products` and `write_inventory` as well. The Shopify app version must list those scopes first (one-time step in
the Dev Dashboard, owner action).

**Live state (2026-11-21):** the app uses Shopify managed installation and lists the two write scopes as *required*
(since `hon-os-2`), so Shopify asks every store for them at install. HON still treats a store as read-only until its
owner presses Allow editing and the returned token carries the scopes.

**Allow finance** needs `read_shopify_payments_accounts`, and **Allow orders** needs `write_orders`. Both are *optional*
scopes in `shopify-app/shopify.app.toml`, released in app version `hon-os-4` (2026-11-21).

Seen on the test store on 2026-11-22 (refusal log): with `read_shopify_payments_accounts` alone Shopify answers the
balance but refuses `shopifyPaymentsAccount.payouts` (ACCESS_DENIED), which failed the whole finance read. Payouts need
`read_shopify_payments_payouts`. So Allow finance now asks for both scopes (the second is in the app file for the next
app file since app version `hon-os-5`, released 2026-11-22), and the adapter steps the finance read down when Shopify
refuses it: without payouts and each transaction's payout, then (the test store refused `balanceTransactions` too once
payouts were left out) the balance alone. `financeAllowed` still means
the accounts scope. The Finance screen cannot tell "no payouts" from "payouts not allowed", so an empty payouts list
shows an **Allow payouts** button that runs Allow finance again.
The same log shows why the catalog read with stock locations is refused: it needs `read_locations`, which the app does
not ask for; the catalog keeps using the plain read (no fulfilment source) without it.

The first live front desk sale on the test store (2026-11-22) showed the same refusal on the stock send
(`HonVariantStock`, `needs read_locations`): a stock change must name the store's own location, so without the scope no
front desk sale can change Shopify's count (the task stays waiting; nothing is lost). The owner approved adding it
(2026-11-22): `read_locations` is an optional scope in the app file (next app version, `hon-os-6`), granted by **Allow
stock updates** in Settings and together with Allow orders. HON keeps no flag for it, so the button stays offered;
pressing it again changes nothing. After it is granted a manager sends the waiting stock changes again from the Register.

Settled on the test store on 2026-11-22: with managed installation, `/admin/oauth/authorize` with the scope in `scope=`
does **not** grant an optional scope (the owner comes back connected, without it). Shopify's request address does
(`https://admin.shopify.com/store/{store}/oauth/install?client_id=...&optional_scopes=...`); it returns the owner to the
app's address (the Commerce page), not to HON's return page, and one more pass through HON's usual approval then records
the scope on the connection.

So the two buttons take two hops, in the web app only (`school-shopify/grant.ts`): the request address first, with a
note in session storage (action, school, shop domain, ten minutes, used once); back on the Commerce page the usual
approval starts by itself and ends on HON's return page. The request address is built from the client id in the
approval address the API returned. In development (the fake) and when the browser cannot keep the note there is no
first hop. An owner who declines on Shopify's page still finishes connected, without the permission.

### Screens
- Products: managers get **Edit** on each product and **New product**; a product with an open edit points to Changes.
- Changes: each edit shows Now and After approval, its status (Waiting for approval, Sending to Shopify, Saved in
  Shopify, Not saved, Not sure it was saved, Cancelled), plain reasons, and Approve / Cancel / Check Shopify again.
  When the store has not allowed editing, an Allow editing banner is shown. Overview counts edits waiting.
- Store settings lists the editing permissions the store granted.

### Known limits in SH4a
- No inventory quantity changes, images, collections, variants added or removed, or publishing a draft (each a later
  piece). AI-proposed edits (Commerce Agent) are a later piece and will use the same approval path.
- The orders list still shows at most the 200 newest kept orders, without a "more" marker.

## CS-M1: Merch Studio, starter ideas to Shopify drafts (step 3, part 1; no migration)

Commerce step 3 ("Creative Studio product drafts", vision section 7) in three parts:

1. **CS-M1 (this piece, frontend only).** A Merch Studio section in the Commerce Workspace. The person picks a product
   (8 kinds) and up to three looks (5 styles), optionally types colors, and HON writes one starter idea per look from
   templates in en/ko/es: title, description, product type, vendor (the school name), SKU stem and, in a USD store only,
   a suggested price (no conversion in other currencies: the price stays empty and must be typed). Ideas are always
   labelled as templates, never as AI. "Use this idea" opens the SH4a draft form prefilled; saving goes through the
   unchanged SH4a propose path, so nothing reaches Shopify until a manager approves it, and the product is created as a
   DRAFT. The school's saved logo and brand color (0285 branding read, refused or missing = not shown) are displayed.
   Each idea carries a print checklist (artwork attached, transparent PNG, 300 DPI, print area, provider colors,
   variants in Shopify), every item shown as "Not checked": HON never labels a design ready to print until the print
   provider (step 6) checks it. Sizes and colors are listed but the draft has one price; the person adds variants in
   Shopify for now (SH4a creates single-variant drafts).
2. **CS-M2.** AI-written ideas through HON's governed text path (S4 spend decision, school cost ceiling, plan, ledger,
   human approval), with these templates as the fallback when AI is off or over budget.
3. **CS-M3.** Artwork and mockups from Creative Studio image generations attached as product media, once creative media
   storage (C3, PR #365) is merged; until then no generated image can become Shopify media.

## CS-M2: Marcus merch ideas (step 3, part 2; migration 0596)

Marcus writes up to three merch ideas from the owner's brief, on the shared AI text proposals (0550, kind `MERCH_IDEAS`).
An idea is text only: using one opens the CS-M1 draft form, and Shopify changes only through an approved SH4a change.

- **Kind row.** `MERCH_IDEAS`: agent `marcus`, task `DRAFT_MARKETING`, 6,000 input and 3,000 output tokens, at most
  80,000 micro-USD per call, at most 12,288 result bytes, caller `HUMAN_UI`, subject `SHOPIFY_STORE` (the connection id).
- **Who may ask.** Shopify management at the session school, `marketing.assistant.use`, `ai.invocation.plan` and an
  active Complete plan, re-proved in the database on every step. A Shopify reader can read the list only.
- **What Marcus sees.** The closed brief (one product kind, one to three looks, up to ten colors, up to 500 characters of
  notes), the school name, the store currency, the saved brand color and up to 30 existing product titles. No customer,
  order, family or student data.
- **Flow.** begin (store must be CONNECTED) -> planning reference -> plan (marcus, DRAFT_MARKETING) -> prepare (budget lock
  first; blocks `GATE_CLOSED` if the store disconnected since the start) -> one provider call -> fail, or record usage and
  the validated answer in its own transaction. The S4 spend decision, HQ pause, per-school ceiling and UNKNOWN queue are
  the shared 0550 ones; S4 itself is unchanged.
- **Answer checks.** `hon.shopify_merch_ideas_ok` and `validateMerchAiProposal` take only `{summary, ideas[1..3]}`, each
  idea `{style, title, description, productType, price, printNotes}`. `merchAiProblems` rejects a look that was not asked
  for, a repeated look, a count that does not match the looks, and any price in a store that is not in US dollars (HON
  never converts). A rejected answer keeps its usage and shows its problems, and can only be dismissed.
- **Closing.** The requester marks ideas used (`APPLIED`) after sending one for approval, or dismisses them.
- **Screen.** Merch Studio shows "Ask Marcus for ideas" only when the server has the paid text route configured and the
  person can manage the store. Any refusal, failure, rejected answer or switched-off route falls back to the CS-M1
  template ideas, labelled as templates. A lost answer keeps its key, so only the identical brief is sent again.
- **Evidence.** `packages/database/scripts/test-shopify-merch-ai-ideas.mjs` (8 groups, fake provider, 0 network calls),
  `apps/api/test/merch-ai.test.cjs`, `apps/web/test/school-shopify-merch-ai.test.tsx`, and the 011 section
  "Shopify merch AI ideas exact verification (0596)".

## TB2: storefront blocks through a theme app extension (step 4; migration 0609, retires TB1 0600)

TB1 (0600, merged 2026-11-20, never deployed) copied the live theme and wrote ready-made changes to the copy, which needs
`write_themes`. Shopify declined that scope for HON on 2026-11-20 and pointed to
[theme app extensions](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions). TB2 replaces TB1 with that
route; 0609 drops every 0600 table, trigger, helper and entry point (0600 itself is unchanged).

- **The extension.** `shopify-app/extensions/hon-storefront/`: app embed `school-colors` (head; the theme's button and
  link color variables), app block `size-guide` (product template), app block `pickup-note` (cart) and app embed
  `pickup-note-banner` (cart, for themes whose cart takes no app blocks). Each reads only the app-data metafield
  `hon_storefront.settings` (JSON) on HON's app installation, escapes every value and re-checks colors as `#RRGGBB` in
  Liquid. The extension makes no network requests. Releasing it (`shopify app deploy`) is an owner step in
  `shopify-app/README.md`.
- **Who.** Read, save and publish need `commerce.shopify.manage` at the session school, re-proved after each write.
- **Settings.** `{primaryColor, accentColor|null, sizeGuideTitle|null, sizeGuideText|null, pickupNote|null}`: upper-case
  `#RRGGBB`, title at most 60 characters (needs text), guide at most 2,000, note at most 500. Saved in
  `hon.shopify_storefronts` (one row per CONNECTED store, versioned; `expectedVersion` null only for the first save).
  Saving never reaches Shopify.
- **Publish** (`POST /v1/school/shopify/storefront/publish {schoolId, settingsVersion}`). The version must be the saved
  one. The database leases the store's publish for three minutes (one at a time, at most 100 a UTC day) and hands over
  the settings and the sealed credential. The API sets the metafield with `metafieldsSet` on
  `currentAppInstallation` (no access scope needed) and finishes under the lease: PUBLISHED (the leased version is live),
  FAILED (refused, nothing written) or UNKNOWN (answer lost; publishing again settles it because the write is
  idempotent). A lease that ends without a result reads and settles as UNKNOWN `LEASE_EXPIRED`.
- **Placing blocks.** The read answers theme editor deep links (client id + block handle) that open the live theme in the
  editor with the block added or the embed on; the owner previews and presses Save in Shopify, and removes a block there
  to undo it. HON never reads or writes theme files.
- **Not in TB2.** Changing the theme's own color settings, blocks in sections that take no app blocks, file diffs.
  Connecting asks for no theme scope; the TB1 "Allow theme editing" switch is gone.
- **Evidence.** `packages/database/scripts/test-shopify-storefront-integrity.mjs` (8 groups, fake Shopify, 0 network
  calls), `apps/api/test/shopify-storefront.test.cjs`, `apps/web/test/school-shopify-storefront.test.tsx`, and the 011
  section "Shopify storefront blocks exact verification (0609, TB2)".

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

1. Migration 0449 + DB proof `test-shopify-background-integrity.mjs` (signed HTTP deliveries, worker functions over
   the owner connection exactly as `ShopifyWorkerDatabase` maps them).
2. API: `shopify-webhook.ts` (transport, verifier), `shopify-webhook.controller.ts`, `shopify-sync-engine.ts` (the one
   sync used by both paths), `shopify-worker.ts` (worker store, background sync, scheduler); unit tests in
   `apps/api/test/shopify-background.test.cjs`.
3. Contract `autoSync` on the overview; the page line in en/ko/es.
4. Grants: 010 (nothing for the runtime), 011 exact verification, 013 worker grants; verify-rls, staging pins,
   run-db-proofs.

## PD1: who fulfils each product (0611)

Commerce step 6, first print-on-demand piece. A school that sells made-to-order items installs the provider's own Shopify
app (Printful and similar). Shopify then stocks those variants at that provider's **fulfilment service location**, and the
provider makes and ships each order. HON reads that fact; it connects to no provider, sends no order and promises nothing
about a provider's catalog, prices or delivery.

- **Read.** The catalog sync asks for each variant's first two stock locations
  (`inventoryItem.inventoryLevels(first: 2) { nodes { location { fulfillmentService { serviceName type } } } }`), which the
  `read_inventory` scope HON already holds covers. The page size went from 100 to 50 variants to stay well inside Shopify's
  single-query cost limit. The first service of type `THIRD_PARTY` gives the name (trimmed, at most 64 characters);
  otherwise the variant is the school's. Known limits: a provider ranked third or later among a variant's locations is
  missed, and a name HON cannot keep (empty after cleaning) leaves the variant shown as school stock. A single-product read-back and a product webhook do not ask, and leave the key out.
  **Fallback (2026-11-21).** On the live test store the first sync with this read failed with `SHOPIFY_INVALID_RESPONSE` and
  0 products in a quarter of a second, while the read without the stock locations had succeeded two days before. HON does
  not keep Shopify's error text, so the exact refusal is not known. When a catalog page is refused that way, the adapter
  now reads that page and the rest of the sync without the stock locations; those variants leave `fulfilledBy` out and the
  mirror keeps what it had. A plain read that is refused too fails the sync as before.
  **Refusal log.** A GraphQL answer Shopify refuses (not throttling) now leaves one log line:
  `shopify_graphql_refused operation=<HON's operation name> errors=<n> [<CODE> at <field path> needs <scope names>; ...]`.
  It never holds the shop, Shopify's message text, ids or values. A skipped finance read logs
  `shopify_finance_skipped stage=read|record` with a one-word reason.
- **Store.** `hon.shopify_variants.fulfilled_by` (text, NULL = the school). `fulfilledBy` is an optional variant key in
  `hon.shopify_apply_page`, `hon.shopify_product_item_ok` and `hon.shopify_mirror_product`; a variant sent without the key
  keeps its value. `hon.shopify_fulfilled_by_ok(jsonb)` is the closed name check (no runtime grant).
- **Show.** `read_shopify_catalog` returns `fulfilledBy` per variant; `read_shopify` counts gain `provider`. A provider's
  variant is never low stock (the school cannot restock it), in the flag and in the count; the contract refuses an answer
  that says otherwise. Commerce shows "Made to order by <name>" in Products and Inventory, an Inventory list of those
  items, and a count on the Overview when there is at least one.
- **Not here.** Provider accounts or APIs, order routing, tracking events, product creation at a provider, and the other
  fulfilment modes in the vision (bulk preorder, hybrid) are later pieces. No new scope, entry point, grant or table.

Evidence: `apps/api/test/shopify.test.cjs` (PD1), `apps/web/test/school-shopify-ui.test.tsx` (PD1),
`packages/database/scripts/test-shopify-commerce-integrity.mjs` (group 4), and the 011 section "Shopify fulfilment source
exact verification (0611, PD1)".

## SH2: the front desk sells Shopify products (step 6; migration 0613)

Full behaviour in [SCHOOL_POINT_OF_SALE.md](SCHOOL_POINT_OF_SALE.md#shopify-products-at-the-register-sh2-migration-0613).
In short: the POS register lists the connected store's own-stock ACTIVE products; a sale is priced by the database from
the mirror and queues one idempotent `inventoryAdjustQuantities` per counted line (refund restock raises it again).
Uses the existing `write_inventory` scope; **no new scope and no Shopify order** (owner decision 2026-11-21, "stock
now, orders later"; orders need `write_orders`). New adapter call `adjustInventory`; new entry points
`begin_pos_shopify_stock`, `rotate_pos_shopify_credential`, `finish_pos_shopify_stock`.

## SH2b: made-to-order items sold at the front desk create a Shopify order (step 6; migration 0614)

Full behaviour in [SCHOOL_POINT_OF_SALE.md](SCHOOL_POINT_OF_SALE.md#made-to-order-items-at-the-register-sh2b-migration-0614).
In short: provider-made variants are sold at the register only when the store grants **`write_orders`** (new optional
scope, asked for by the Allow orders button; `ShopifyConnection.ordersAllowed`). Each such sale creates one PAID order
through `orderCreate`, tagged with the HON order row id so a lost answer is found again instead of made twice, shipped
to the school or to an address staff type. New adapter call `createPosOrder`; new entry points
`begin_pos_shopify_order`, `finish_pos_shopify_order`. Reconnecting the same store keeps `write_orders` once granted.
The app's next version must list `write_orders` under `optional_scopes` (shopify-app/shopify.app.toml) and the owner
releases it; until then Shopify will not offer the permission.

## CA1: the commerce review (step 7, part 1; migration 0615)

The owner asks Marcus how the store is doing. Marcus answers with a short summary, up to five findings and up to five
recommendations, on the shared AI text proposals (0550, kind `COMMERCE_REVIEW`). A review is text only: it changes
nothing in HON or Shopify, and the only actions on it are "mark as reviewed" and "dismiss".

- **Kind row.** `COMMERCE_REVIEW`: agent `marcus`, task `DRAFT_MARKETING`, 9,000 input and 2,500 output tokens, at most
  80,000 micro-USD per call, at most 12,288 result bytes, caller `HUMAN_UI`, subject `SHOPIFY_STORE` (the connection id).
- **Who may ask.** The same people as CS-M2 (0596 `shopify_merch_ai_actor`): Shopify management at the session school,
  `marketing.assistant.use`, `ai.invocation.plan` and an active Complete plan, re-proved in the database on every step.
  A Shopify reader can read the list only.
- **What Marcus sees** (`hon.shopify_review_facts`, built in the database, never by the browser). The closed brief (one
  focus of OVERVIEW, SALES, PRICING or STOCK, and an optional question of up to 300 characters), the school name, the
  store currency, and store totals only: the last 30 days (orders, sales, average order, items sold, sales with a known
  cost, estimated gross profit, up to 8 top products named by their catalog title, and a count of other items sold),
  the catalog (active and made-to-order variant counts, variants
  without a cost, up to 12 low-stock items, up to 12 thinnest margins) and two front-desk counts (stock changes and
  orders not yet sent to Shopify). No customer, address, family or student data. An order line's own title never
  leaves the database, because a custom item's title is typed by the merchant and may name a person: a sold product is
  named only when its line joins a mirrored variant, and every other line is only counted.
- **Size.** The provider request is budgeted in bytes (prompt + facts + 128 must fit 9,000). Names are cut by bytes with
  `hon.shopify_review_clip` (product 60, variant 40, school 120), never inside a character, so a store with Korean
  names fits: the fullest store measures 6,533 bytes against 6,872 available.
- **Flow.** The 0596 flow with its own entry points: `begin_shopify_commerce_review` (store must be CONNECTED) -> planning
  reference -> plan -> `prepare_shopify_commerce_review` (budget lock first; blocks `GATE_CLOSED` if the store
  disconnected since the start) -> one provider call -> `fail_...`, or `record_...` with usage and the validated answer.
  S4, the HQ pause, the per-school ceiling and the UNKNOWN queue are the shared 0550 ones, unchanged.
- **Provider call.** The same runtime class as CS-M2 with its own profile (`COMMERCE_REVIEW_TEXT_PROFILE`): its own
  system prompt (use only the numbers given, the question is untrusted text, no links or personal data), temperature 0.2,
  no tools, and it refuses any budget other than this kind's before anything is sent.
- **Answer checks.** `hon.shopify_review_ok` and `validateCommerceReviewProposal` take only
  `{summary, findings[1..5], recommendations[0..5]}`, each point `{area, title, detail}`. `commerceReviewProblems` rejects
  an answer holding a link or an email address. A rejected answer keeps its usage and shows its problems.
- **Screen.** Under the overview on the Shopify page, only while the store is connected. The ask form appears only when
  the server has the paid text route configured and the person can manage the store. A review is always shown under an
  AI notice. A lost answer keeps its key, so only the identical request is sent again.
- **Known limits.** The numbers are what HON has synced, so a review is only as fresh as the last sync. Marcus cannot
  act on a recommendation: preparing price or product changes for approval is the next piece (CA2).
- **Evidence.** `packages/database/scripts/test-shopify-commerce-review.mjs` (9 groups, fake provider, 0 network calls),
  `apps/api/test/commerce-review.test.cjs`, `apps/web/test/school-shopify-commerce-review.test.tsx`, and the 011 section
  "Shopify commerce review exact verification (0615)".
