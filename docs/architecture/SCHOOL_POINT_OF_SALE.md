# School front-desk Point of Sale (migration 0612)

Status: spec + plan, 2026-11-16. Owner ask (David, 2026-11-16): "I didn't see POS. Make all simple, keep the
organization style of my current CRM." Reference: David's Manus CRM, Finance > Point of Sale (read-only look, no
customer data copied).

## What the Manus POS does (reference, organization we keep)

One page, three tabs:

- **Register**: product tiles grouped by category chips (All, Tests & Ranks, Equipment, Events, Apparel...) with a search
  box, a "Quick Amount Sale" button, and an invoice panel on the right: staff, member (pick a contact or "Checkout as
  Guest"), cart lines, discount code, subtotal, sales tax % (POS default, changeable for the sale), total, notes, Pay.
- **History**: all transactions (who, when, method, first item), today's total and count; click one to see the receipt
  (school, receipt number, customer, staff, payment, lines, subtotal, tax, total, Print, Email).
- **Inventory**: low stock alert at the top, then the catalog list: name, SKU, category, price, stock bar with - / +,
  edit, delete. "Add POS Item" asks name, price, SKU, category, track stock, starting stock, low stock alert at.

Payment methods seen there: Cash, Check, External Terminal (card swiped on the school's own machine), Credit Card
online.

## HON v1 (this PR, 0612)

Same three tabs, same words where they are clear. Everything money-related is decided by the database, never the
browser.

1. **Catalog** (Inventory tab). Item: name, price, optional SKU, category (Testing & ranks, Uniforms, Equipment,
   Apparel, Events, Other), taxable yes/no, track stock yes/no, stock, low-stock level, active. Edit with a version
   check. "Delete" archives (sold items keep their history). Stock - / + and "set count" write an append-only stock
   movement with a reason.
2. **Register**. Tap tiles to build the cart (or a quick amount line with a description). Pick a contact from People
   or leave as walk-in (optional name). Optional staff discount (amount or %) with a required reason. Sales tax uses the
   school's POS tax rate on taxable lines only; the rate is a school setting (default 0%). Pay with **Cash**, **Check**,
   **Card on our terminal** (recorded, HON moves no money, like 0240 CARD_TERMINAL) or **Other**. The server
   recomputes every line from the current catalog, refuses if the total differs from the one the screen showed
   (`POS_TOTAL_CHANGED`), refuses if a tracked item lacks stock (`POS_OUT_OF_STOCK`), then writes the sale, lines and
   stock movements atomically. Cash shows change due (screen only).
3. **Receipt**. Number `POS-YYYYMMDD-NNNN` (school-local date, per-school sequence). Print from the browser. Email is
   not in v1 (it would send a message; it can use the communications service later).
4. **Refunds** (History tab, manage permission). Per the owner's manual-refunds policy (2026-11-08): no automatic
   refund; an authorized staff member records a refund with a reason, an amount up to what is left, the method it was
   paid back with, and optionally which items go back on the shelf (restocks them). A sale can have several refunds
   until fully refunded. HON moves no money.
5. **Sales report** (History tab header + a Report view): for a school-local date range, sales count, gross,
   discounts, tax, refunds, net, totals per payment method, and top items. Today's total shows on the History tab.

### Permissions

- `pos.sell` (staff-assignable): see the register and catalog, ring up sales, see history and receipts.
- `pos.manage` (staff-assignable, sensitive): catalog, stock, tax rate, refunds, report.
- Both granted to the system OWNER role only at migration; owners give them to front-desk roles in Staff roles.
- Same identity rules as 0390/0217 (one active human principal, active school and organization, paid access), plus
  the permission at that exact school. Authority is re-checked after the last write.

### Data

All tables forced RLS with no client privileges; the runtime role only executes fixed SECURITY DEFINER functions.
`pos_settings`, `pos_items`, `pos_stock_moves` (append-only), `pos_sales` + `pos_sale_lines` (immutable except refund
counters), `pos_refunds` (append-only), `pos_requests` (exact-request idempotency, like 0390). Audit + outbox carry ids
and amounts only (`pos.sale.recorded`, `pos.sale.refunded`, `pos.item.saved`, `pos.stock.adjusted`).

### Not in v1 (seams left)

- **Card online (sandbox)**: the tuition thread builds one shared one-off payment on the school's own Stripe/Square
  account (test mode only). POS will add a "Card" method that creates a pending sale and completes on the provider
  event. Live payments stay off without David's approval.
- **Discount codes**: one shared library built as checkout CP4; POS will call its apply function. No POS code table.
- **Charge to account**: create an ISSUED invoice on the payer's billing account so it shows in Receivables. Next PR.
- Email receipt, barcode scanner input, item photos, variants (sizes) as separate items for now.

## Plan

1. Migration 0612 + DB proof script (`test-pos-integrity.mjs`): permissions, cross-school refusal, totals and tax
   math, total-changed refusal, out-of-stock refusal, stock moves, refund limits and restock, idempotent replay and key
   reuse, report sums, authority loss.
2. Contracts (`packages/contracts/src/pos.ts`) with validators + API service/controller (`apps/api/src/pos/`),
   runtime-database fixed calls, API unit test.
3. Web: `/staff/billing/pos` with Register / History / Inventory tabs, menu entry "Point of Sale" next to Checkout
   pages, UI test.
4. Run focused tests, `pnpm check`, build; independent review; PR.

## Shopify products at the register (SH2, migration 0613)

Owner decision (David, 2026-11-21): "Stock now, orders later." A front-desk sale of a Shopify product lowers the count
in Shopify right away. HON does **not** create a Shopify order: that needs a permission the app does not have
(`write_orders`), so it waits for the owner's approval. Until then Shopify's own sales reports do not include
front-desk sales; HON's History and report do.

### What staff see

- **Register**: under the school's own tiles, "From your Shopify store: <name>" lists the store's products. They show
  only when the school's store is connected, allows editing (`write_inventory`), and uses the register's currency. If
  not, one plain line says why (read-only connection, or a different currency) and nothing from Shopify is sold.
- Listed: ACTIVE products the school stocks itself. Never drafts, archived or removed variants, or items a print
  provider makes (PD1 `fulfilled_by`): a provider ships those to the buyer, the desk has nothing to hand over.
- The tile shows Shopify's count ("3 in Shopify"). A Shopify line is **never refused for stock**: the mirror can be
  behind the shelf, and the member is standing at the desk.
- Shopify lines are taxed at the register rate (the mirror has no per-product tax flag; known limit).
- **Receipt / History**: the line reads like any other. Under the receipt (not printed): whether Shopify's count was
  updated, is still being sent, or was not updated.
- **Shopify stock is behind**: when any change has not reached Shopify, the Register says how many. A manager
  (`pos.manage`) gets **Send again**. Sales are never held up by Shopify.
- **Refund**: "Put back on the shelf" for a Shopify line raises Shopify's count again.

### How it works

1. `record_pos_sale` accepts a third line shape `{shopifyVariantId, quantity}`. Name, SKU and price come from the mirror
   of the school's CONNECTED store, inside the same transaction that prices the sale; the total-changed check covers a
   Shopify price change. A variant that is not sellable answers `POS_ITEM_UNAVAILABLE` and nothing is written.
2. Each counted Shopify line queues one row in `hon.pos_shopify_stock_tasks` (change = minus the quantity; a refund
   restock queues plus the quantity). Rows are evidence: guarded, forced RLS, no client privilege.
3. After the sale answers, the API sends the waiting changes with the seller's own authority
   (`begin_pos_shopify_stock` hands the sealed credential and at most 20 changes; `finish_pos_shopify_stock` records
   each outcome; `rotate_pos_shopify_credential` stores a refreshed token under the handed version). One Shopify call
   per change: `inventoryAdjustQuantities` with `@idempotent(key: <task id>)`, so a change whose answer was lost is sent
   again and Shopify applies it once.
4. Where: the variant's one own, active location (not a fulfilment service). None or more than one is refused
   (`NO_LOCATION`, `MULTIPLE_LOCATIONS`) rather than guessed.
5. Outcomes: DONE (the mirror count moves with it); FAILED when Shopify refuses the change or the token; anything
   uncertain stays waiting and is tried again with the next sale, up to 5 attempts, then FAILED. FAILED changes move
   only when a manager presses Send again (`POST /v1/school/pos/shopify-stock`).
6. The register's Shopify count is the mirror count plus the changes still waiting, so two sales in a row do not show
   stale stock.
7. A store disconnected while changes wait: the sale stays recorded; the changes are settled as FAILED.

### Known limits (0613)

- No Shopify order for items the school stocks itself, so Shopify analytics miss those front-desk sales. Made-to-order items do create one (0614, below).
- A store with several own locations cannot be adjusted (the change fails with a clear reason). Location choice is a
  later setting.
- No background worker: waiting changes move on the next sale or a manager's Send again.
- A rejected token fails the change but does not yet flip the connection to "Needs reconnect".
- Shopify lines are always taxed at the register rate.

Proofs: `test-pos-shopify-integrity.mjs` (9 groups, signed HTTP against the scripted Shopify), `test-pos-integrity.mjs`
(unchanged behaviour of 0612), API `school-pos.test.cjs`, web `school-pos-ui.test.tsx`.

## Made-to-order items at the register (SH2b, migration 0614)

Owner (David, 2026-11-21): many of the store's products are print-on-demand, so a front-desk sale of one must create a
Shopify order or nothing gets made. Decision on shipping: **ask at each sale**, school pickup as the default.

Items the school stocks itself keep the 0613 behaviour (stock is lowered, no order). This section is only about
variants a print provider makes (PD1 `fulfilled_by`).

### What staff see

- **Shopify page, Settings**: a new button **Allow orders**. It reconnects the same store asking Shopify for
  `write_orders` as well (and editing, which the register needs). Until a manager approves it, made-to-order items are
  not listed at the register and one line says how to turn it on.
- **Register**: made-to-order tiles show "Made to order by <provider>". They have no count and are never out of stock.
- With one in the cart the sale panel asks **Made-to-order items ship to**: "The school (pickup)" or "The customer's
  address". The school is the default and uses the address saved in Settings; if that address is not complete the
  option is off and the customer's address is asked for. Payment waits until the address is complete.
- **Receipt / History** (not printed): "Shopify order #1042 was created ... If you refund this sale, cancel that order
  in Shopify too", or that it is still being sent, or that it was not created.
- **Shopify is behind**: orders that did not reach Shopify are counted with the stock changes; a manager's **Send
  again** sends both.

### How it works

1. `record_pos_sale` takes an optional `shipTo`: `{kind:'SCHOOL'}` or `{kind:'CUSTOMER', name, address1, address2,
   city, province, zip, country}`. It is required exactly when the sale has a made-to-order line
   (`POS_SHIP_TO_REQUIRED`), refused when it has none (`POS_INVALID`), and `SCHOOL` needs a complete
   `hon.school_locations` address (`POS_SCHOOL_ADDRESS_MISSING`). The school address is copied at sale time.
2. The sale writes one row in `hon.pos_shopify_orders` (one per sale, however many made-to-order lines). Made-to-order
   lines never queue a stock change.
3. After the sale answers, the API creates the order with the seller's own authority: `begin_pos_shopify_order` hands
   the sealed credential and at most 5 waiting orders; `finish_pos_shopify_order` records each outcome.
4. Shopify call: `orderCreate` with only the made-to-order lines at the price HON charged, `financialStatus: PAID`,
   the shipping address, a note with the HON receipt number, tags `hon-pos` and `hon-pos-<order row id>`, and options
   `inventoryBehaviour: BYPASS`, `sendReceipt: false`, `sendFulfillmentReceipt: false`. No customer record and no
   email are sent.
5. Not made twice: before creating, HON asks Shopify for an order with that row's tag and uses it if found. Because
   Shopify's search can lag a few seconds, an order tried less than 60 seconds ago is left alone by the next sale. A
   manager's Send again is not held back by the 60 seconds.
6. Outcomes: DONE keeps Shopify's order id and name and **clears the address**. Shopify refusing the order or the
   token is FAILED. Anything uncertain waits, up to 5 attempts, then FAILED. FAILED moves only on a manager's Send
   again. Audit and outbox rows carry ids only, never the address.
7. If the store takes the order permission back, nothing is sent, waiting orders keep waiting, and made-to-order items
   leave the register.
8. A refund in HON never cancels or refunds the Shopify order; the receipt note tells staff to cancel it in Shopify.

### Known limits (0614)

- The Shopify order holds only the made-to-order lines at HON's line prices. HON's sales tax, sale discount and any
  shipping charge are not on it, so its total can differ from the HON receipt. HON's receipt is the record of what
  was paid.
- No shipping fee is added to the front-desk sale.
- The customer gets no Shopify email; tracking is in the Shopify order.
- Country is typed as two letters (for example US). No address lookup.
- Refund does not cancel the Shopify order.
- Open until tried on the test store: whether a managed-install store can grant `write_orders` through HON's
  reconnect, and the exact behaviour of each print provider when an order is created through the API.
- 0613, also true here: if a full catalog sync runs in the short window where a stock change's answer was lost, the
  register can show that change twice until it settles.

Proofs: `test-pos-shopify-orders-integrity.mjs` (9 groups, signed HTTP against the scripted Shopify), the two older POS
proofs, API `school-pos.test.cjs`, web `school-pos-ui.test.tsx` and `school-shopify-finance.test.tsx`.
- Open before a real store uses it: the app's protected customer data approval is Level 1; an order with a shipping
  name and address may need the name and address fields approved as well (see shopify-app/README.md).
