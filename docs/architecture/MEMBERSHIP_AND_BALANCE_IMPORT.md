# Membership and opening-balance import (0334)

Onboarding piece B7 for schools switching from other software. Staff upload one CSV of current memberships (and what each
family still owes), review every row, then confirm. The flow and its safety rules match the 0226 student import and the
0333 class and attendance import: stage, decide IMPORT or SKIP per row, finalize exactly the chosen rows.

Owner decision D1 (2026-11-13, "Record, plus staff can charge"): imported memberships and balances are recorded, and staff
may start charging a family's saved card right away with the imported terms through the existing school-pay paths. Live
payments stay off until the owner separately approves turning them on.

## API

`/v1/organizations/:organizationId/schools/:schoolId/billing-imports`

| Call | Browser command | Body |
| --- | --- | --- |
| `GET /` | `billing.import.read` | none: recent batches and the field list |
| `GET /:batchId` | `billing.import.read` | none: one batch with its rows |
| `POST /` | `billing.import.stage` | `{csv, mapping}` |
| `POST /:batchId/decisions` | `billing.import.decide` | `{expectedVersion, decisions:[{index, choice}]}` |
| `POST /:batchId/finalize` | `billing.import.finalize` | `{expectedVersion, selectedIndices}` |

Every command needs an `Idempotency-Key`; reads refuse one. The staff member needs all three of `students.import`,
`billing.membership.activate` and `billing.invoice.issue` at the school, live, plus an active subscription.

## Columns

Required: `studentGivenName`, `studentFamilyName`, `planName`, `amount`, `frequency` (weekly, monthly or annual),
`startedOn`, `nextChargeOn`. Optional: `birthDate`, `payerGivenName`, `payerFamilyName`, `currency`, `endsOn`,
`balanceOwed`, `balanceDueOn`. Any column can be mapped to `ignore`. Dates are `YYYY-MM-DD`.

Stated defaults shown on review: currency is the payer's existing account currency, else USD; the balance is due today;
amounts accept `149`, `149.00`, `$1,250.50` (whole units only for JPY and KRW).

## Matching (never a guess)

* Student: exact given and family name at this school (any case), narrowed by birth date when given. Not found, more than
  one match, a repeat in the file, or a student who already has a membership that has not ended: the row cannot import.
* Payer: the guardian of the student's family named in the payer columns; else the only guardian; else the only
  billing-contact guardian; with no guardian, the student, unless a known minor. Otherwise the row asks staff to name one.
* Plan: a catalog plan whose code or current name matches keeps its code; otherwise a code is made from the name. The
  amount and frequency always come from the file.

## What finalize writes per IMPORT row

1. The payer's one `CANONICAL` billing account (0159), reused or created in the row's currency.
2. One membership created as DRAFT and confirmed ACTIVE in the same transaction with its 0177 evidence: an activation
   decision (basis `STAFF_ACTIVATION_PRE_POLICY`, source `GENERIC_LEGACY`, reason `LEGACY_MEMBERSHIP`, the importing staff
   member as actor) and the INITIAL effective period from the imported start and end dates. Date revisions (0178), pause
   and cancel (0224) and every membership reader then treat it like any other confirmed membership.
3. One ACTIVE payment schedule with the imported amount, frequency and next charge date. This is exactly what the 0322
   autopay cycle bills once staff enroll the payer's saved method in autopay.
4. When the balance is above zero, one ISSUED invoice for it on that account, due at the end of the due day in the school's
   time zone. The 0240 receivables and payment records work on it as on any other invoice.

Each match is re-checked at finalize under a per-school lock; anything that changed since staging (a new membership, a
different payer, another account) stops the whole finalize as `BILLING_IMPORT_STALE` with nothing written.

## Not done here

No card is charged, no processor is contacted, no autopay plan is created, and no message, receipt or AI call happens. Audit
and outbox carry identifiers only, under `billing.import.*`; the `billing.membership.activated` and invoice events are
deliberately not emitted, so no welcome or reminder automation treats an imported record as new business. The runtime role
has EXECUTE on the five entry points and no privilege on any import table.

Proof: `packages/database/scripts/test-billing-import-integrity.mjs` (6 groups) and `apps/api/test/billing-import.test.cjs`.
