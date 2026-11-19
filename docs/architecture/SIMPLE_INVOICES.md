# Simple invoices (SI1, migration 0558)

Owner feedback (David, 2026-11-19): the Billing > Invoices screen is too technical ("server-owned", a DRAFT
confirmation checkbox, membership-only). He wants a simple invoice form: payer info, pay-to info, items with prices,
a total, the way to pay, and print, email and text.

Follow-up direction (David, 2026-11-19): learn from GoHighLevel's invoicing features (builder with a live preview,
send by email or text, payment options) but do not copy it; make HON's version easier and fit martial arts schools.
So the form drops what a school rarely needs on day one (tax, discounts, product library, recurring schedules) and adds
one-tap common school items (Monthly tuition, Registration fee, Uniform, Belt test fee, ...).

Scope: the staff invoice page only. Live money stays off. No new provider, charge, fee or automation.

## What staff see (`/staff/billing/invoices`)

1. **Invoices** list (newest first, status filter) with a **New invoice** button. Clicking a row opens the invoice.
2. **New invoice** form, one page:
   - **Bill to**: search a person at the school (name). Shows their name, email and phone.
   - **From (pay to)**: the school's name and address from settings (read-only), plus optional phone and email
     typed on the invoice.
   - **Items**: rows of description, quantity, price; line totals and the **Total** update as you type. Add/remove
     rows (1 to 30).
   - **Due date** (school calendar day; due at the end of that day in school time).
   - **How to pay**: "Pay online in the HON parent app" is listed automatically when the school can take card payments
     in the app (test mode today). **Other ways to pay** is free text (for example "Cash or check at the front desk").
   - **Note** (optional).
   - Buttons: **Create invoice** (saves and issues, so the family can see and pay it) and **Save draft**.
   - A **live preview** of the invoice sits beside the form and updates as staff type (stacks below on a phone).
   - **Quick add** chips fill an item description with a common school item; staff type the price.
3. **Invoice view** (after create, or from the list): a clean printable invoice (number, dates, bill to, from, items,
   total, paid, balance due, how to pay, note) with **Print**, **Email** and **Text** buttons, and **Issue** for a
   draft.
   - Print uses the browser print dialog with a print stylesheet (only the invoice prints).
   - Email / Text create one message to the payer through the existing message commands (0047 create DRAFT, then
     queue). The server checks the school permission and the payer's consent for that channel; without consent the
     page says so and nothing is sent. HON's delivery worker sends only where delivery is switched on. Staff see the
     message text before sending.

Older invoices (no items) show one line "Invoice amount" with their total.

## Backend

### Migration 0558

- `hon.invoice_line_items` (id, org, school, invoice_id, position 1-30, description 1-200, quantity 1-1000,
  unit_amount_minor 0-100,000,000, amount_minor = quantity x unit). Forced RLS, no runtime table privilege.
- `hon.invoice_details` (invoice_id PK, org, school, pay_to_phone, pay_to_email, other_ways_to_pay, note).
  Forced RLS, no runtime table privilege.
- Both are written only by the definer function below, only while the invoice is a DRAFT, and are append-only
  (one guard; demo data removal may delete demo rows, the 0459 line).
- `hon.create_simple_invoice(subject,p,key,request,correlation)`: direct human `billing.invoice.create` at the current
  school (plus `billing.invoice.issue` when `issue` is true), the 0240 idempotency shape (exact replay, key reuse
  refused), the billing account must be in this school, currency is the account currency, total = sum of lines,
  1 to 2,147,483,647 minor units. Inserts the DRAFT invoice, its lines and details; with `issue` it then issues it
  (version 2). Audit + outbox exactly like the existing commands (`billing.invoice.create` /
  `billing.invoice.created`, then `billing.invoice.issue` / `billing.invoice.issued`), identifiers and amounts only.
  Authority is decided again after the last write.
- `hon.read_school_invoice_detail(subject,invoice_id)`: the 0280 readers. Returns the invoice balance JSON, number
  (first 8 of the id, upper case), created and due, items, note, bill-to (person id, name, email, phone), from
  (school name, address), pay-to phone/email, how to pay (in app available, other ways), timezone, canIssue.
  Another school's invoice is NOT_FOUND.

Input `p`: `{ billingAccountId, dueDate: 'YYYY-MM-DD', items: [{ description, quantity, unitAmountMinor }],
issue: boolean, payToPhone?, payToEmail?, otherWaysToPay?, note? }`. Due date from school today minus 365 days to
plus 366 days.

### API (Nest)

- `POST /v1/organizations/:org/schools/:school/billing/invoices/simple` (header
  `X-HON-Human-Command: billing.invoice.simple.create`, Idempotency-Key) -> 201 new / 200 replay.
- `GET  .../billing/invoices/:invoiceId/detail` -> 200.
- Payer: the page first calls the existing `POST .../billing/accounts` (`{ responsiblePersonId }`), which reuses the
  person's current account or makes one, then sends its id. A failed invoice after that leaves only a reusable
  account.
- Contracts in `@hon/contracts`: input validator and strict response verifiers.

## Out of scope (later)

Editing or voiding an issued invoice, discounts and tax, PDF attachment in email, line items in the parent app view,
linking a membership from the simple form (the existing membership invoices keep working).

## Tests

- DB proof `test-simple-invoice-integrity.mjs`: create draft / create-and-issue, totals, validation refusals, replay
  and key reuse, other school refused and not disclosed, missing issue permission refused, lines immutable, detail
  read for new and older invoices, runtime has no table privilege, 010/011 sections.
- API unit test for the controller/service error mapping and contract verifiers.
- Web unit tests for the form math (line totals, total, money parsing), message text builder and view.

## Plan

1. Contracts (types, validator, verifiers) with tests.
2. Migration 0558 + DB proof + 010/011 + pins.
3. API service/controller + tests.
4. Web: new page (list, form, view, print, email/text) + tests + screenshots.
5. Self-review, PR, independent review, merge on GO + green CI.
