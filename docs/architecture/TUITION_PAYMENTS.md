# Tuition payments received outside HON (B-TUI-1, migration 0240)

Status: source only. Not deployed. HON moves no money: nothing here charges a card, refunds, contacts a payment
provider, sends a message, or runs an automation.

## Owner-approved rules (decision card, 2026-11-09 07:56Z)

| Rule | Behavior |
| --- | --- |
| T1 | Staff record a payment the school already received (cash, check, card terminal, bank transfer, other) against one **ISSUED** invoice of the current school. New sensitive, staff-assignable permission `billing.invoice.payment.record`, granted at migration time to system `OWNER` roles only. |
| T2 | Partial payments are allowed. The invoice becomes **PAID** when unvoided records reach its total. A record above the remaining balance is refused (no overpayment, no credit). |
| T3 | A payment recorded by mistake is **voided with a reason**, never deleted. A void that leaves a PAID invoice uncovered returns it to **ISSUED**. A void is not a refund. |
| T4 | Staff holding the record, `billing.invoice.issue` or `billing.invoice.create` permission see the school's unpaid balances: issued invoices with paid, remaining and overdue. |

## Database (0240)

- `hon.invoice_payment_records`: private, forced RLS, no runtime privilege. The `guard_invoice_payment_record` trigger
  keeps a record immutable except one void (the three void columns, set once). No delete, no truncate.
- `guard_invoice_payment_status` (BEFORE UPDATE on `hon.invoices`, settings-free, whoever writes): a change into PAID
  needs status ISSUED and unvoided records ≥ total; a change out of PAID must go to ISSUED and needs records < total; an
  invoice with records cannot change amount, currency, payer, account or membership; an invoice with paid records cannot
  move to VOID or UNCOLLECTIBLE. Legacy invoices marked PAID before 0240 have no records; they read as balance 0.
- Runtime entry points (EXECUTE only): `record_invoice_payment`, `void_invoice_payment`, `read_invoice_payments`,
  `read_school_receivables`. Each re-proves the direct human subject (HUMAN_USER, HUMAN_UI, no action request, no
  delegation, one active principal, staff-eligible, no family/HQ/parent-type role), the live school-scoped permission
  and an active entitlement, before and after the write, using the 0224 identity rules.
- Commands: exact-request idempotency (24 h), IAM SHARE locks, then `hon.invoices` ROW EXCLUSIVE and the invoice row
  `FOR UPDATE`, so every record and void of one invoice is serialized; an expected invoice version is required. One audit
  event and one inert outbox event (`billing.invoice.payment_recorded` / `payment_voided`) per command.
- The received date may not be after the school-local today (school time zone).
- Reads: receivables are 50 per page by invoice id with per-currency totals over every match; one invoice's payments are
  newest first, at most 100.

## API

Under `organizations/:organizationId/schools/:schoolId/billing` (route ids are not authority; the scope is resolved from
the verified session and re-checked by the database):

| Method | Path | Guard / command header |
| --- | --- | --- |
| GET | `receivables?filter=OPEN\|OVERDUE&after=<invoiceId>` | `TuitionReadHumanUiGuard` |
| GET | `invoices?status=ALL\|DRAFT\|ISSUED\|PAID\|VOID\|UNCOLLECTIBLE&after=<invoiceId>` (0280) | `TuitionReadHumanUiGuard` |
| GET | `invoices/:invoiceId/payments` | `TuitionReadHumanUiGuard` |
| POST | `invoices/:invoiceId/payments` | `billing.invoice.payment.record` + Idempotency-Key |
| POST | `invoice-payments/:paymentId/void` | `billing.invoice.payment.void` + Idempotency-Key |

Responses are `private, no-store`. Every database answer is verified by the `@hon/contracts` verifiers before it reaches a
client; unknown failures are `TUITION_PAYMENTS_UNAVAILABLE`, never success.

## School invoice list (B-TUI-1b, migration 0280)

`hon.read_school_invoices(subject, {status, after?})` lists the current school's invoices of every status (or one), newest
first by creation time then id, 50 per page. It has the same readers as receivables (`billing.invoice.payment.record`,
`.issue` or `.create`, re-proved after the read) and says whether the reader may also issue (`canIssue`) or record
(`canRecord`). A cursor must be an invoice of this school; another school's id is refused, never disclosed. Each row is the
0240 balance row plus `createdAt`; a DRAFT has no payments and is never overdue. Read-only: no DML. It exists so a DRAFT that
was not issued at once can be found and issued later (full-build weak spot 5).

## Web

`/staff/billing/receivables` ("Tuition balances", Billing menu): unpaid balances with an All unpaid / Overdue filter and
totals, one invoice with its payments, a record form (amount in the invoice currency, received date capped at the
school-local today, method, optional reference and note) and a void form with a reason. An unknown outcome keeps the exact
request and key in memory for Try again; blur, school change and session end conceal the page and drop kept commands.
Page text is English only for now (the menu label has English, Korean and Spanish).

## Evidence

`pnpm --filter @hon/database db:test-tuition-payments` (CI: `run-db-proofs.sh`, CRM-close fixture): 155 checks over signed
HTTP, including partial then full payment, overpayment, currency, future date, stale version, replay and key reuse, one
winner of two concurrent records, void back to ISSUED, live grant/expiry/school/entitlement loss, browser transport,
settings-free triggers, runtime ACL, the 011 section, and no change to other invoices, payment attempts or refund records.
With 0280 the same proof (190 checks) also covers the invoice list: only the current school, newest first, the status
filter, a two-page cursor over 58 invoices, another school's cursor refused, readers and `canIssue`/`canRecord`, no DML,
runtime EXECUTE only and its 011 section.

## Residual risks and follow-ups

- The runtime's pre-existing INSERT privilege on `hon.invoices` (0049) could still insert a row already marked PAID; the
  invoice service only inserts DRAFT. Closing that needs a separate change to the invoice create path.
- No receipt document, family-facing view or reminder: reminders and family billing remain separate, owner-gated work.
- Page copy is not yet translated.
