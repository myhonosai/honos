# School front-desk Point of Sale (migration 0506)

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

## HON v1 (this PR, 0506)

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

1. Migration 0506 + DB proof script (`test-pos-integrity.mjs`): permissions, cross-school refusal, totals and tax
   math, total-changed refusal, out-of-stock refusal, stock moves, refund limits and restock, idempotent replay and key
   reuse, report sums, authority loss.
2. Contracts (`packages/contracts/src/pos.ts`) with validators + API service/controller (`apps/api/src/pos/`),
   runtime-database fixed calls, API unit test.
3. Web: `/staff/billing/pos` with Register / History / Inventory tabs, menu entry "Point of Sale" next to Checkout
   pages, UI test.
4. Run focused tests, `pnpm check`, build; independent review; PR.
